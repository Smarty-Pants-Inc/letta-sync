/**
 * Unit Tests: Blocks Apply Operations
 *
 * Tests the apply/upsert logic for block reconciliation including:
 * - Building reconciliation plans
 * - Executing create/update/delete/adopt actions
 * - Dry-run mode
 * - Error handling
 *
 * @see tools/smarty-admin/src/reconcilers/blocks/apply.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyBlock,
  buildReconcilePlan,
  applyBlockReconciliation,
  type ApplyOptions,
} from '../../src/reconcilers/blocks/apply.js';
import {
  BlockOwnership,
  type BlockManifestEntry,
  type ReconcilePlan,
  type ApplyResult,
} from '../../src/reconcilers/blocks/types.js';
import type { LettaClient, BlockResponse, CreateBlockRequest, UpdateBlockRequest } from '../../src/api/client.js';

// =============================================================================
// Mock Client Factory
// =============================================================================

interface MockBlocksClient {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface MockClientOverrides {
  blocks?: Partial<MockBlocksClient>;
}

function createMockClient(overrides: MockClientOverrides = {}): LettaClient {
  return {
    blocks: {
      list: overrides.blocks?.list ?? vi.fn().mockResolvedValue([]),
      create: overrides.blocks?.create ?? vi.fn().mockImplementation(async (req: CreateBlockRequest) => ({
        id: `new-${Date.now()}`,
        label: req.label,
        value: req.value,
        description: req.description,
        limit: req.limit,
        metadata: req.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      update: overrides.blocks?.update ?? vi.fn().mockImplementation(async (id: string, req: UpdateBlockRequest) => ({
        id,
        label: 'updated',
        value: req.value ?? 'existing',
        description: req.description,
        limit: req.limit,
        metadata: req.metadata,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      delete: overrides.blocks?.delete ?? vi.fn().mockResolvedValue(undefined),
    },
    // Add other client methods as needed
    agents: {} as any,
    tools: {} as any,
    sources: {} as any,
    folders: {} as any,
    identities: {} as any,
  } as unknown as LettaClient;
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockBlock(overrides: Partial<BlockResponse> = {}): BlockResponse {
  return {
    id: `block-${Math.random().toString(36).substring(2, 10)}`,
    label: 'test_block',
    value: 'Test block content',
    description: 'A test block',
    limit: 5000,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createManagedBlock(
  label: string,
  value: string,
  layer: 'base' | 'org' | 'project' | 'user' | 'lane' = 'project',
  overrides: Partial<BlockResponse> = {}
): BlockResponse {
  return createMockBlock({
    label,
    value,
    metadata: {
      managed_by: 'smarty-admin',
      layer,
      last_synced: new Date().toISOString(),
    },
    ...overrides,
  });
}

function createManifestEntry(overrides: Partial<BlockManifestEntry> = {}): BlockManifestEntry {
  return {
    label: 'test_block',
    value: 'Test block content',
    layer: 'project',
    description: 'A test block',
    ...overrides,
  };
}

function createDefaultApplyOptions(overrides: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    dryRun: false,
    allowDelete: false,
    verbose: false,
    ...overrides,
  };
}

// =============================================================================
// classifyBlock Tests
// =============================================================================

describe('classifyBlock', () => {
  const manifestLabels = new Set(['block_a', 'block_b', 'project']);

  it('should classify managed block in manifest as MANAGED', () => {
    const block = createManagedBlock('block_a', 'content');

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.ownership).toBe(BlockOwnership.MANAGED);
    expect(classification.info?.isManaged).toBe(true);
    expect(classification.reason).toContain('managed metadata');
    expect(classification.reason).toContain('Git manifest');
  });

  it('should classify managed block not in manifest as ORPHANED', () => {
    const block = createManagedBlock('orphan_block', 'content');

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.ownership).toBe(BlockOwnership.ORPHANED);
    expect(classification.reason).toContain('not in Git manifest');
  });

  it('should classify unmanaged block with managed label pattern as ADOPTED', () => {
    const block = createMockBlock({
      label: 'project', // canonical label in manifest
      metadata: {},
    });

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.ownership).toBe(BlockOwnership.ADOPTED);
    expect(classification.reason).toContain('needs metadata');
  });

  it('should classify unmanaged block with managed pattern not in manifest as UNMANAGED', () => {
    const block = createMockBlock({
      label: 'base_something', // managed pattern but not in manifest
      metadata: {},
    });

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.ownership).toBe(BlockOwnership.UNMANAGED);
    expect(classification.reason).toContain('not in manifest');
  });

  it('should classify unmanaged block without managed pattern as UNMANAGED', () => {
    const block = createMockBlock({
      label: 'random_user_block',
      metadata: {},
    });

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.ownership).toBe(BlockOwnership.UNMANAGED);
    expect(classification.reason).toContain("doesn't match pattern");
  });

  it('should include management info for managed blocks', () => {
    const block = createMockBlock({
      label: 'block_a',
      metadata: {
        managed_by: 'smarty-admin',
        layer: 'project',
        org: 'acme',
        package_version: 'abc123',
      },
    });

    const classification = classifyBlock(block, manifestLabels);

    expect(classification.info).toBeDefined();
    expect(classification.info?.layer).toBe('project');
    expect(classification.info?.org).toBe('acme');
    expect(classification.info?.packageVersion).toBe('abc123');
  });
});

// =============================================================================
// buildReconcilePlan Tests
// =============================================================================

describe('buildReconcilePlan', () => {
  describe('create actions', () => {
    it('should plan to create missing blocks', async () => {
      const client = createMockClient();
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new_block', value: 'Content' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.creates).toHaveLength(1);
      expect(plan.creates[0].label).toBe('base_new_block');
      expect(plan.creates[0].type).toBe('create');
      expect(plan.summary.toCreate).toBe(1);
    });

    it('should include value and layer in create action changes', async () => {
      const client = createMockClient();
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({
          label: 'base_new_block',
          value: 'Some content',
          layer: 'base',
          description: 'A description',
        }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      const changes = plan.creates[0].changes ?? [];
      expect(changes.some(c => c.field === 'value')).toBe(true);
      expect(changes.some(c => c.field === 'layer')).toBe(true);
      expect(changes.some(c => c.field === 'description')).toBe(true);
    });
  });

  describe('update actions', () => {
    it('should plan to update blocks with changed content', async () => {
      const existingBlock = createManagedBlock('base_block', 'old content', 'base');
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({
          label: 'base_block',
          value: 'new content',
          layer: 'base',
        }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].label).toBe('base_block');
      expect(plan.updates[0].type).toBe('update');
      expect(plan.updates[0].blockId).toBe(existingBlock.id);
      expect(plan.summary.toUpdate).toBe(1);
    });

    it('should plan to update when package version differs', async () => {
      const existingBlock = createManagedBlock('base_block', 'content', 'base');
      (existingBlock.metadata as any).package_version = 'old-sha';

      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_block', value: 'content', layer: 'base' }),
      ];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ packageVersion: 'new-sha' })
      );

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].reason).toContain('Package version');
    });
  });

  describe('adopt actions', () => {
    it('should plan to adopt blocks with matching label but no metadata', async () => {
      const existingBlock = createMockBlock({
        label: 'project', // canonical label
        value: 'existing content',
        metadata: {},
      });
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'project', value: 'new content', layer: 'project' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].type).toBe('adopt');
      expect(plan.updates[0].changes?.some(c => c.field === 'metadata')).toBe(true);
    });
  });

  describe('skip actions', () => {
    it('should skip blocks that are in sync', async () => {
      const value = 'same content';
      const existingBlock = createManagedBlock('base_block', value, 'base');
      (existingBlock.metadata as any).package_version = 'same-sha';

      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_block', value, layer: 'base' }),
      ];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ packageVersion: 'same-sha' })
      );

      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toContain('in sync');
      expect(plan.summary.unchanged).toBe(1);
    });

    it('should skip unmanaged blocks to avoid overwriting user data', async () => {
      const existingBlock = createMockBlock({
        label: 'random_block', // Not a managed label pattern
        value: 'user data',
        metadata: {},
      });
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'random_block', value: 'new content' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toContain('not managed');
    });
  });

  describe('delete actions', () => {
    it('should plan to delete orphaned blocks when allowDelete is true', async () => {
      const orphanBlock = createManagedBlock('base_orphan', 'orphaned', 'base');
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([orphanBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(plan.deletes).toHaveLength(1);
      expect(plan.deletes[0].label).toBe('base_orphan');
      expect(plan.summary.toDelete).toBe(1);
    });

    it('should skip orphaned blocks when allowDelete is false', async () => {
      const orphanBlock = createManagedBlock('base_orphan', 'orphaned', 'base');
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([orphanBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: false })
      );

      expect(plan.deletes).toHaveLength(0);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toContain('--allow-delete');
    });

    it('should not delete unmanaged blocks', async () => {
      const unmanagedBlock = createMockBlock({
        label: 'user_block',
        metadata: {},
      });
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([unmanagedBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(plan.deletes).toHaveLength(0);
    });
  });

  describe('summary', () => {
    it('should compute correct summary for mixed operations', async () => {
      const existingBlocks = [
        createManagedBlock('base_update', 'old', 'base'),
        createManagedBlock('base_synced', 'same', 'base'),
        createManagedBlock('base_orphan', 'orphaned', 'base'),
      ];
      // Ensure synced block has matching package version
      (existingBlocks[1].metadata as any).package_version = 'test-sha';

      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue(existingBlocks),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_create', value: 'new', layer: 'base' }),
        createManifestEntry({ label: 'base_update', value: 'new', layer: 'base' }),
        createManifestEntry({ label: 'base_synced', value: 'same', layer: 'base' }),
      ];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true, packageVersion: 'test-sha' })
      );

      expect(plan.summary.toCreate).toBe(1);
      expect(plan.summary.toUpdate).toBe(1);
      expect(plan.summary.toDelete).toBe(1);
      expect(plan.summary.unchanged).toBe(1);
      expect(plan.summary.total).toBe(3);
    });
  });
});

// =============================================================================
// applyBlockReconciliation Tests
// =============================================================================

describe('applyBlockReconciliation', () => {
  describe('dry run mode', () => {
    it('should not call API in dry run mode', async () => {
      const createFn = vi.fn();
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ dryRun: true })
      );

      expect(result.success).toBe(true);
      expect(createFn).not.toHaveBeenCalled();
      expect(result.summary.created).toBe(1); // Reports planned creates
    });

    it('should return plan as result in dry run mode', async () => {
      const client = createMockClient();
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ dryRun: true })
      );

      expect(result.results.some(r => r.action.type === 'create')).toBe(true);
    });
  });

  describe('create execution', () => {
    it('should execute create actions', async () => {
      const createFn = vi.fn().mockResolvedValue({
        id: 'new-block-123',
        label: 'base_new',
        value: 'content',
        metadata: { managed_by: 'smarty-admin', layer: 'base' },
      });
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', value: 'content', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(true);
      expect(createFn).toHaveBeenCalled();
      expect(result.summary.created).toBe(1);
    });

    it('should handle create errors gracefully', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('API error'));
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('API error');
    });
  });

  describe('update execution', () => {
    it('should execute update actions', async () => {
      const existingBlock = createManagedBlock('base_block', 'old', 'base');
      const updateFn = vi.fn().mockResolvedValue({
        ...existingBlock,
        value: 'new',
      });
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
          update: updateFn,
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_block', value: 'new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(true);
      expect(updateFn).toHaveBeenCalled();
      expect(result.summary.updated).toBe(1);
    });
  });

  describe('adopt execution', () => {
    it('should execute adopt actions', async () => {
      const existingBlock = createMockBlock({
        label: 'project',
        value: 'content',
        metadata: {},
      });
      const updateFn = vi.fn().mockResolvedValue({
        ...existingBlock,
        metadata: { managed_by: 'smarty-admin', layer: 'project' },
      });
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
          update: updateFn,
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'project', value: 'content', layer: 'project' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(true);
      expect(updateFn).toHaveBeenCalled();
      expect(result.summary.updated).toBe(1); // Adoptions count as updates
    });
  });

  describe('delete execution', () => {
    it('should execute delete actions when allowed', async () => {
      const orphanBlock = createManagedBlock('base_orphan', 'orphaned', 'base');
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([orphanBlock]),
          delete: deleteFn,
        },
      });
      const manifest: BlockManifestEntry[] = [];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(result.success).toBe(true);
      expect(deleteFn).toHaveBeenCalledWith(orphanBlock.id);
      expect(result.summary.deleted).toBe(1);
    });

    it('should handle delete errors gracefully', async () => {
      const orphanBlock = createManagedBlock('base_orphan', 'orphaned', 'base');
      const deleteFn = vi.fn().mockRejectedValue(new Error('Delete failed'));
      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([orphanBlock]),
          delete: deleteFn,
        },
      });
      const manifest: BlockManifestEntry[] = [];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(result.success).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.errors[0]).toContain('Delete failed');
    });
  });

  describe('error handling', () => {
    it('should continue applying other actions after one fails', async () => {
      const createFn = vi.fn()
        .mockRejectedValueOnce(new Error('First fails'))
        .mockResolvedValueOnce({
          id: 'second-block',
          label: 'base_second',
          value: 'content',
          metadata: { managed_by: 'smarty-admin', layer: 'base' },
        });
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_first', layer: 'base' }),
        createManifestEntry({ label: 'base_second', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.summary.created).toBe(1);
      expect(result.summary.failed).toBe(1);
      expect(createFn).toHaveBeenCalledTimes(2);
    });

    it('should aggregate all errors', async () => {
      const createFn = vi.fn()
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'));
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_first', layer: 'base' }),
        createManifestEntry({ label: 'base_second', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('Error 1');
      expect(result.errors[1]).toContain('Error 2');
    });
  });

  describe('result summary', () => {
    it('should report overall success when all actions succeed', async () => {
      const client = createMockClient();
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should report failure when any action fails', async () => {
      const createFn = vi.fn().mockRejectedValue(new Error('Failed'));
      const client = createMockClient({
        blocks: { create: createFn },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(false);
    });

    it('should include all action results', async () => {
      const existingBlock = createManagedBlock('base_existing', 'same', 'base');
      (existingBlock.metadata as any).package_version = 'test-sha';

      const client = createMockClient({
        blocks: {
          list: vi.fn().mockResolvedValue([existingBlock]),
        },
      });
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
        createManifestEntry({ label: 'base_existing', value: 'same', layer: 'base' }),
      ];

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ packageVersion: 'test-sha' })
      );

      // Should have results for both create and skip actions
      expect(result.results.length).toBeGreaterThanOrEqual(2);
    });
  });
});
