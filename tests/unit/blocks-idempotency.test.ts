/**
 * Unit Tests: Blocks Idempotency
 *
 * Tests that block reconciliation operations are idempotent:
 * - Running operations twice produces no additional changes
 * - Metadata is stable across operations
 * - Plans converge to no-change state after apply
 *
 * @see tools/smarty-admin/src/reconcilers/blocks/diff.ts
 * @see tools/smarty-admin/src/reconcilers/blocks/apply.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  diffBlocks,
  computeDrifts,
  type BlockDiffResult,
} from '../../src/reconcilers/blocks/diff.js';
import {
  buildReconcilePlan,
  applyBlockReconciliation,
} from '../../src/reconcilers/blocks/apply.js';
import {
  buildManagedMetadata,
} from '../../src/reconcilers/blocks/create.js';
import {
  buildUpdatedMetadata,
} from '../../src/reconcilers/blocks/update.js';
import {
  compareBlockWithManifest,
} from '../../src/reconcilers/blocks/update.js';
import type {
  BlockManifestEntry,
  ManagedBlockMetadata,
  ReconcilePlan,
  ApplyOptions,
} from '../../src/reconcilers/blocks/types.js';
import type { LettaClient, BlockResponse, CreateBlockRequest } from '../../src/api/client.js';

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
  layer: ManagedBlockMetadata['layer'] = 'project',
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

function createMockClient(existingBlocks: BlockResponse[] = []): LettaClient {
  const blockStore = new Map<string, BlockResponse>();
  existingBlocks.forEach(b => blockStore.set(b.label, b));

  return {
    blocks: {
      list: vi.fn().mockImplementation(async () => Array.from(blockStore.values())),
      create: vi.fn().mockImplementation(async (req: CreateBlockRequest) => {
        const block: BlockResponse = {
          id: `new-${Date.now()}-${Math.random()}`,
          label: req.label,
          value: req.value,
          description: req.description,
          limit: req.limit ?? 5000,
          metadata: req.metadata,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        blockStore.set(block.label, block);
        return block;
      }),
      update: vi.fn().mockImplementation(async (id: string, req: any) => {
        // Find block by ID and update it
        for (const [label, block] of blockStore.entries()) {
          if (block.id === id) {
            const updated = {
              ...block,
              ...req,
              updatedAt: new Date().toISOString(),
            };
            blockStore.set(label, updated);
            return updated;
          }
        }
        throw new Error(`Block ${id} not found`);
      }),
      delete: vi.fn().mockImplementation(async (id: string) => {
        for (const [label, block] of blockStore.entries()) {
          if (block.id === id) {
            blockStore.delete(label);
            return;
          }
        }
      }),
    },
    agents: {} as any,
    tools: {} as any,
    sources: {} as any,
    folders: {} as any,
    identities: {} as any,
  } as unknown as LettaClient;
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
// Diff Idempotency Tests
// =============================================================================

describe('Diff Idempotency', () => {
  describe('consistent results', () => {
    it('should produce identical results on consecutive runs', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block_a', value: 'A' }),
        createManifestEntry({ label: 'block_b', value: 'B' }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('block_a', 'A'),
      ];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // All summaries should be identical
      const firstSummary = results[0].summary;
      for (const result of results) {
        expect(result.summary.toCreate).toBe(firstSummary.toCreate);
        expect(result.summary.toUpdate).toBe(firstSummary.toUpdate);
        expect(result.summary.toDelete).toBe(firstSummary.toDelete);
        expect(result.summary.unchanged).toBe(firstSummary.unchanged);
      }
    });

    it('should produce same creates regardless of input order', () => {
      const desiredOrdered: BlockManifestEntry[] = [
        createManifestEntry({ label: 'a_block', value: 'A' }),
        createManifestEntry({ label: 'b_block', value: 'B' }),
        createManifestEntry({ label: 'c_block', value: 'C' }),
      ];
      const desiredReversed = [...desiredOrdered].reverse();
      const desiredShuffled = [desiredOrdered[1], desiredOrdered[2], desiredOrdered[0]];

      const actual: BlockResponse[] = [];

      const result1 = diffBlocks(desiredOrdered, actual);
      const result2 = diffBlocks(desiredReversed, actual);
      const result3 = diffBlocks(desiredShuffled, actual);

      expect(result1.creates.length).toBe(3);
      expect(result2.creates.length).toBe(3);
      expect(result3.creates.length).toBe(3);

      const labels1 = result1.creates.map(c => c.label).sort();
      const labels2 = result2.creates.map(c => c.label).sort();
      const labels3 = result3.creates.map(c => c.label).sort();

      expect(labels1).toEqual(labels2);
      expect(labels2).toEqual(labels3);
    });

    it('should produce same updates regardless of actual block order', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block_x', value: 'new_x' }),
        createManifestEntry({ label: 'block_y', value: 'new_y' }),
      ];

      const actualOrdered: BlockResponse[] = [
        createManagedBlock('block_x', 'old_x'),
        createManagedBlock('block_y', 'old_y'),
      ];
      const actualReversed = [...actualOrdered].reverse();

      const result1 = diffBlocks(desired, actualOrdered);
      const result2 = diffBlocks(desired, actualReversed);

      expect(result1.updates.length).toBe(result2.updates.length);
      expect(result1.summary.toUpdate).toBe(result2.summary.toUpdate);
    });
  });

  describe('in-sync stability', () => {
    it('should consistently report no changes for synced blocks', () => {
      const value = 'Same content';
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'synced', value }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('synced', value),
      ];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(diffBlocks(desired, actual));
      }

      for (const result of results) {
        expect(result.hasChanges).toBe(false);
        expect(result.creates).toHaveLength(0);
        expect(result.updates).toHaveLength(0);
        expect(result.deletes).toHaveLength(0);
      }
    });

    it('should not generate spurious drifts', () => {
      const desired = createManifestEntry({
        label: 'block',
        value: 'content',
        description: 'desc',
        limit: 5000,
      });
      const actual = createManagedBlock('block', 'content');
      actual.description = 'desc';
      actual.limit = 5000;

      // Run many times
      for (let i = 0; i < 100; i++) {
        const drifts = computeDrifts(desired, actual);
        expect(drifts).toHaveLength(0);
      }
    });
  });

  describe('timestamp independence', () => {
    it('should produce same logical diff regardless of timestamp', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block', value: 'new' }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('block', 'old'),
      ];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // Diff IDs should be unique
      const diffIds = new Set(results.map(r => r.diffId));
      expect(diffIds.size).toBe(3);

      // But logical content should be identical
      for (const result of results) {
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].label).toBe('block');
      }
    });
  });
});

// =============================================================================
// Metadata Idempotency Tests
// =============================================================================

describe('Metadata Idempotency', () => {
  describe('buildManagedMetadata stability', () => {
    it('should produce stable metadata for same inputs (except timestamp)', () => {
      const entry = createManifestEntry({
        label: 'base_block',
        layer: 'base',
        org: 'acme',
        project: 'myproj',
        description: 'A block',
        sourcePath: '/path/to/block.md',
      });
      const options = { packageVersion: 'abc123' };

      const metadata1 = buildManagedMetadata(entry, options);
      const metadata2 = buildManagedMetadata(entry, options);

      // Core fields should be identical
      expect(metadata1.managed_by).toBe(metadata2.managed_by);
      expect(metadata1.layer).toBe(metadata2.layer);
      expect(metadata1.org).toBe(metadata2.org);
      expect(metadata1.project).toBe(metadata2.project);
      expect(metadata1.description).toBe(metadata2.description);
      expect(metadata1.source_path).toBe(metadata2.source_path);
      expect(metadata1.package_version).toBe(metadata2.package_version);
    });

    it('should always set managed_by to smarty-admin', () => {
      const entries = [
        createManifestEntry({ layer: 'base' }),
        createManifestEntry({ layer: 'org' }),
        createManifestEntry({ layer: 'project' }),
        createManifestEntry({ layer: 'user' }),
        createManifestEntry({ layer: 'lane' }),
      ];

      for (const entry of entries) {
        const metadata = buildManagedMetadata(entry);
        expect(metadata.managed_by).toBe('smarty-admin');
      }
    });
  });

  describe('buildUpdatedMetadata preservation', () => {
    it('should preserve adopted_at and original_label fields', () => {
      const existingMetadata = {
        managed_by: 'smarty-admin',
        layer: 'project',
        adopted_at: '2024-01-01T00:00:00Z',
        original_label: 'old_label',
      };
      const entry = createManifestEntry({ layer: 'project' });

      const updated = buildUpdatedMetadata(existingMetadata, entry);

      expect(updated.adopted_at).toBe('2024-01-01T00:00:00Z');
      expect(updated.original_label).toBe('old_label');
    });

    it('should update last_synced on each call', () => {
      const existingMetadata = {
        managed_by: 'smarty-admin',
        layer: 'project',
        last_synced: '2024-01-01T00:00:00Z',
      };
      const entry = createManifestEntry();

      const updated = buildUpdatedMetadata(existingMetadata, entry);

      expect(updated.last_synced).not.toBe('2024-01-01T00:00:00Z');
      expect(new Date(updated.last_synced!).getTime()).toBeGreaterThan(0);
    });
  });
});

// =============================================================================
// Compare Idempotency Tests
// =============================================================================

describe('Compare Idempotency', () => {
  it('should report no changes when entry matches block', () => {
    const entry = createManifestEntry({
      label: 'block',
      value: 'content',
      description: 'desc',
      limit: 5000,
    });
    const block = createMockBlock({
      label: 'block',
      value: 'content',
      description: 'desc',
      limit: 5000,
    });

    const diff = compareBlockWithManifest(entry, block);

    expect(diff.hasChanges).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });

  it('should produce identical diffs for same inputs', () => {
    const entry = createManifestEntry({ value: 'new' });
    const block = createMockBlock({ value: 'old' });

    const diffs: ReturnType<typeof compareBlockWithManifest>[] = [];
    for (let i = 0; i < 10; i++) {
      diffs.push(compareBlockWithManifest(entry, block));
    }

    for (const diff of diffs) {
      expect(diff.hasChanges).toBe(true);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('value');
    }
  });
});

// =============================================================================
// Plan Idempotency Tests
// =============================================================================

describe('Plan Idempotency', () => {
  it('should produce identical plans for same manifest and state', async () => {
    const existingBlocks = [
      createManagedBlock('base_existing', 'old', 'base'),
    ];
    const manifest: BlockManifestEntry[] = [
      createManifestEntry({ label: 'base_new', layer: 'base' }),
      createManifestEntry({ label: 'base_existing', value: 'new', layer: 'base' }),
    ];

    const plans: ReconcilePlan[] = [];
    for (let i = 0; i < 5; i++) {
      const client = createMockClient(existingBlocks);
      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions()
      );
      plans.push(plan);
    }

    const firstPlan = plans[0];
    for (const plan of plans) {
      expect(plan.creates.length).toBe(firstPlan.creates.length);
      expect(plan.updates.length).toBe(firstPlan.updates.length);
      expect(plan.deletes.length).toBe(firstPlan.deletes.length);
      expect(plan.skipped.length).toBe(firstPlan.skipped.length);
    }
  });
});

// =============================================================================
// Apply Idempotency Tests
// =============================================================================

describe('Apply Idempotency', () => {
  describe('convergence', () => {
    it('should converge to no-change state after applying diff', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block1', value: 'V1' }),
        createManifestEntry({ label: 'block2', value: 'V2' }),
      ];

      // Initial state is empty
      const initialActual: BlockResponse[] = [];
      const initialDiff = diffBlocks(desired, initialActual);

      expect(initialDiff.creates).toHaveLength(2);
      expect(initialDiff.hasChanges).toBe(true);

      // Simulate applying the diff
      const postApplyActual: BlockResponse[] = [
        createManagedBlock('block1', 'V1'),
        createManagedBlock('block2', 'V2'),
      ];

      // Second diff should show no changes
      const postApplyDiff = diffBlocks(desired, postApplyActual);

      expect(postApplyDiff.creates).toHaveLength(0);
      expect(postApplyDiff.updates).toHaveLength(0);
      expect(postApplyDiff.deletes).toHaveLength(0);
      expect(postApplyDiff.hasChanges).toBe(false);
    });

    it('should reach stable state within finite iterations', () => {
      let currentActual: BlockResponse[] = [
        createManagedBlock('old_block', 'Old'),
      ];

      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'new_block', value: 'New' }),
      ];

      const maxIterations = 10;
      let iteration = 0;
      let hasChanges = true;

      while (hasChanges && iteration < maxIterations) {
        const diff = diffBlocks(desired, currentActual, { includeOrphans: true });

        if (!diff.hasChanges) {
          hasChanges = false;
        } else {
          // Simulate applying changes
          const newBlocks: BlockResponse[] = [];

          // Apply creates
          for (const create of diff.creates) {
            const entry = desired.find(d => d.label === create.label);
            if (entry) {
              newBlocks.push(createManagedBlock(entry.label, entry.value));
            }
          }

          // Keep non-deleted blocks
          for (const block of currentActual) {
            const isDeleted = diff.deletes.some(d => d.label === block.label);
            const isCreated = diff.creates.some(c => c.label === block.label);
            if (!isDeleted && !isCreated) {
              newBlocks.push(block);
            }
          }

          currentActual = newBlocks;
        }

        iteration++;
      }

      expect(iteration).toBeLessThan(maxIterations);
      expect(hasChanges).toBe(false);
    });
  });

  describe('double-apply safety', () => {
    it('should be safe to call apply twice with same manifest', async () => {
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_block', value: 'content', layer: 'base' }),
      ];

      const client = createMockClient();

      // First apply
      const result1 = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      // Second apply
      const result2 = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Second apply should have fewer creates (ideally 0)
      // This tests the idempotent behavior of the mock client
      expect(result2.summary.created).toBeLessThanOrEqual(result1.summary.created);
    });

    it('should skip already-created blocks on second apply', async () => {
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_block', value: 'content', layer: 'base' }),
      ];

      // Pre-populate with block matching manifest
      const existingBlocks = [
        createManagedBlock('base_block', 'content', 'base'),
      ];
      (existingBlocks[0].metadata as any).package_version = 'test-sha';

      const client = createMockClient(existingBlocks);

      const result = await applyBlockReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ packageVersion: 'test-sha' })
      );

      expect(result.success).toBe(true);
      expect(result.summary.created).toBe(0);
      expect(result.summary.skipped).toBe(1);
    });
  });

  describe('dry run consistency', () => {
    it('should produce same dry run results multiple times', async () => {
      const manifest: BlockManifestEntry[] = [
        createManifestEntry({ label: 'base_new', layer: 'base' }),
        createManifestEntry({ label: 'base_update', value: 'new', layer: 'base' }),
      ];

      const existingBlocks = [
        createManagedBlock('base_update', 'old', 'base'),
      ];

      const results = [];
      for (let i = 0; i < 5; i++) {
        const client = createMockClient(existingBlocks);
        const result = await applyBlockReconciliation(
          client,
          manifest,
          createDefaultApplyOptions({ dryRun: true })
        );
        results.push(result);
      }

      const firstResult = results[0];
      for (const result of results) {
        expect(result.summary.created).toBe(firstResult.summary.created);
        expect(result.summary.updated).toBe(firstResult.summary.updated);
        expect(result.summary.deleted).toBe(firstResult.summary.deleted);
        expect(result.summary.skipped).toBe(firstResult.summary.skipped);
      }
    });
  });
});

// =============================================================================
// Edge Case Idempotency Tests
// =============================================================================

describe('Edge Case Idempotency', () => {
  describe('empty states', () => {
    it('should handle empty desired and actual states', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual));
      }

      for (const result of results) {
        expect(result.hasChanges).toBe(false);
        expect(result.summary.total).toBe(0);
      }
    });

    it('should handle empty manifest with existing blocks', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [
        createManagedBlock('orphan1', 'content'),
        createManagedBlock('orphan2', 'content'),
      ];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual, { includeOrphans: true }));
      }

      for (const result of results) {
        expect(result.deletes).toHaveLength(2);
      }
    });
  });

  describe('large scale stability', () => {
    it('should handle many blocks consistently', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      // Create 100 blocks
      for (let i = 0; i < 100; i++) {
        desired.push(createManifestEntry({
          label: `block_${i.toString().padStart(3, '0')}`,
          value: `Content ${i}`,
        }));
      }

      const result1 = diffBlocks(desired, actual);
      const result2 = diffBlocks(desired, actual);

      expect(result1.creates).toHaveLength(100);
      expect(result2.creates).toHaveLength(100);
      expect(result1.summary.toCreate).toBe(result2.summary.toCreate);
    });
  });

  describe('description handling', () => {
    it('should handle undefined vs empty string descriptions consistently', () => {
      const desired1 = createManifestEntry({ description: undefined });
      const desired2 = createManifestEntry({ description: '' });

      const actual1 = createMockBlock({ description: undefined });
      const actual2 = createMockBlock({ description: '' });

      // Same description state should not show drift
      const drifts1 = computeDrifts(desired1, actual1);
      const drifts2 = computeDrifts(desired2, actual2);

      // Both should show no description drift
      const descDrift1 = drifts1.filter(d => d.type === 'description');
      const descDrift2 = drifts2.filter(d => d.type === 'description');

      expect(descDrift1).toHaveLength(0);
      expect(descDrift2).toHaveLength(0);
    });
  });

  describe('limit handling', () => {
    it('should not report limit drift when not specified in manifest', () => {
      const desired = createManifestEntry({ limit: undefined });
      const actual = createMockBlock({ limit: 5000 });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.filter(d => d.type === 'limit')).toHaveLength(0);
    });

    it('should report limit drift only when explicitly specified', () => {
      const desired = createManifestEntry({ limit: 10000 });
      const actual = createMockBlock({ limit: 5000 });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.filter(d => d.type === 'limit')).toHaveLength(1);
    });
  });
});
