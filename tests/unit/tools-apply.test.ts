/**
 * Unit Tests: Tools Apply Operations
 *
 * Tests the apply/upsert logic for tool reconciliation including:
 * - Building reconciliation plans
 * - Executing create/update/delete/adopt actions
 * - Dry-run mode
 * - Error handling
 *
 * @see tools/smarty-admin/src/reconcilers/tools/apply.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyTool,
  buildReconcilePlan,
  applyToolReconciliation,
  createManagedTool,
  updateManagedTool,
  adoptTool,
  buildManagedTags,
  buildUpdatedTags,
  compareToolWithManifest,
  type ApplyOptions,
} from '../../src/reconcilers/tools/apply.js';
import {
  ToolOwnership,
  type ToolManifestEntry,
  type ReconcilePlan,
  type ApplyResult,
} from '../../src/reconcilers/tools/types.js';
import type { LettaClient } from '../../src/api/client.js';
import type { Tool, CreateToolRequest } from '../../src/api/types.js';

// =============================================================================
// Mock Client Factory
// =============================================================================

interface MockToolsClient {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface MockClientOverrides {
  tools?: Partial<MockToolsClient>;
}

function createMockClient(overrides: MockClientOverrides = {}): LettaClient {
  return {
    tools: {
      list: overrides.tools?.list ?? vi.fn().mockResolvedValue([]),
      create: overrides.tools?.create ?? vi.fn().mockImplementation(async (req: CreateToolRequest) => ({
        id: `new-${Date.now()}`,
        name: req.name,
        sourceType: req.sourceType,
        sourceCode: req.sourceCode,
        description: req.description,
        jsonSchema: req.jsonSchema,
        tags: req.tags,
        toolType: req.toolType,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      update: overrides.tools?.update ?? vi.fn().mockImplementation(async (id: string, req: any) => ({
        id,
        name: 'updated',
        sourceType: 'python',
        sourceCode: req.sourceCode ?? 'existing',
        description: req.description,
        jsonSchema: req.jsonSchema ?? {},
        tags: req.tags ?? [],
        toolType: req.toolType ?? 'custom',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      delete: overrides.tools?.delete ?? vi.fn().mockResolvedValue(undefined),
    },
    // Add other client methods as needed
    agents: {} as any,
    blocks: {} as any,
    sources: {} as any,
    folders: {} as any,
    identities: {} as any,
  } as unknown as LettaClient;
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: `tool-${Math.random().toString(36).substring(2, 10)}`,
    name: 'test_tool',
    description: 'A test tool',
    sourceType: 'python',
    sourceCode: 'def test_tool(): pass',
    jsonSchema: {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    tags: [],
    toolType: 'custom',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createManagedTool(
  name: string,
  sourceCode: string,
  layer: 'base' | 'org' | 'project' | 'user' | 'lane' = 'project',
  overrides: Partial<Tool> = {}
): Tool {
  return createMockTool({
    name,
    sourceCode,
    tags: [
      'managed_by:smarty-admin',
      `layer:${layer}`,
      `last_synced:${new Date().toISOString()}`,
    ],
    ...overrides,
  });
}

function createManifestEntry(overrides: Partial<ToolManifestEntry> = {}): ToolManifestEntry {
  return {
    name: 'test_tool',
    sourceType: 'python',
    sourceCode: 'def test_tool(): pass',
    jsonSchema: {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    layer: 'project',
    description: 'A test tool',
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
// buildManagedTags Tests
// =============================================================================

describe('buildManagedTags', () => {
  it('should build tags with required management fields', () => {
    const entry = createManifestEntry({ name: 'my_tool', layer: 'project' });
    
    const tags = buildManagedTags(entry);
    
    expect(tags).toContain('managed_by:smarty-admin');
    expect(tags.some(t => t.startsWith('layer:project'))).toBe(true);
    expect(tags.some(t => t.startsWith('last_synced:'))).toBe(true);
  });

  it('should include org and project when provided', () => {
    const entry = createManifestEntry({
      name: 'my_tool',
      layer: 'project',
      org: 'acme',
      project: 'myproj',
    });
    
    const tags = buildManagedTags(entry);
    
    expect(tags).toContain('org:acme');
    expect(tags).toContain('project:myproj');
  });

  it('should include package version when provided', () => {
    const entry = createManifestEntry({ name: 'my_tool' });
    
    const tags = buildManagedTags(entry, { packageVersion: 'abc123' });
    
    expect(tags).toContain('package_version:abc123');
  });

  it('should merge user-defined tags excluding management tags', () => {
    const entry = createManifestEntry({
      name: 'my_tool',
      tags: ['category:ai', 'priority:high', 'managed_by:other'],
    });
    
    const tags = buildManagedTags(entry);
    
    expect(tags).toContain('category:ai');
    expect(tags).toContain('priority:high');
    // Should not duplicate or include user's managed_by tag
    expect(tags.filter(t => t.startsWith('managed_by:')).length).toBe(1);
  });
});

// =============================================================================
// buildUpdatedTags Tests
// =============================================================================

describe('buildUpdatedTags', () => {
  it('should preserve non-management tags from existing tool', () => {
    const existingTags = ['custom:tag', 'user:data'];
    const entry = createManifestEntry({ layer: 'project' });
    
    const tags = buildUpdatedTags(existingTags, entry);
    
    expect(tags).toContain('custom:tag');
    expect(tags).toContain('user:data');
  });

  it('should update management tags', () => {
    const existingTags = [
      'managed_by:smarty-admin',
      'layer:org',
      'last_synced:2024-01-01',
      'custom:tag',
    ];
    const entry = createManifestEntry({ layer: 'project' });
    
    const tags = buildUpdatedTags(existingTags, entry);
    
    expect(tags).toContain('managed_by:smarty-admin');
    expect(tags.some(t => t === 'layer:project')).toBe(true);
    expect(tags.some(t => t.startsWith('last_synced:') && t !== 'last_synced:2024-01-01')).toBe(true);
  });

  it('should include package version when provided', () => {
    const existingTags: string[] = [];
    const entry = createManifestEntry();
    
    const tags = buildUpdatedTags(existingTags, entry, { packageVersion: 'new-sha' });
    
    expect(tags).toContain('package_version:new-sha');
  });

  it('should deduplicate tags', () => {
    const existingTags = ['custom:tag'];
    const entry = createManifestEntry({ tags: ['custom:tag'] });
    
    const tags = buildUpdatedTags(existingTags, entry);
    
    const customTagCount = tags.filter(t => t === 'custom:tag').length;
    expect(customTagCount).toBe(1);
  });
});

// =============================================================================
// compareToolWithManifest Tests
// =============================================================================

describe('compareToolWithManifest', () => {
  it('should detect source code changes', () => {
    const entry = createManifestEntry({ sourceCode: 'def new(): pass' });
    const tool = createMockTool({ sourceCode: 'def old(): pass' });
    
    const diff = compareToolWithManifest(entry, tool);
    
    expect(diff.hasChanges).toBe(true);
    expect(diff.changes.some(c => c.field === 'sourceCode')).toBe(true);
  });

  it('should detect description changes', () => {
    const entry = createManifestEntry({ description: 'new desc' });
    const tool = createMockTool({ description: 'old desc' });
    
    const diff = compareToolWithManifest(entry, tool);
    
    expect(diff.hasChanges).toBe(true);
    expect(diff.changes.some(c => c.field === 'description')).toBe(true);
  });

  it('should detect JSON schema changes', () => {
    const entry = createManifestEntry({
      jsonSchema: {
        type: 'function',
        function: {
          name: 'test',
          parameters: { type: 'object', properties: { x: { type: 'string' } } },
        },
      },
    });
    const tool = createMockTool({
      jsonSchema: {
        type: 'function',
        function: {
          name: 'test',
          parameters: { type: 'object', properties: { y: { type: 'number' } } },
        },
      },
    });
    
    const diff = compareToolWithManifest(entry, tool);
    
    expect(diff.hasChanges).toBe(true);
    expect(diff.changes.some(c => c.field === 'jsonSchema')).toBe(true);
  });

  it('should report no changes when matching', () => {
    const sourceCode = 'def tool(): pass';
    const description = 'same';
    const jsonSchema = {
      type: 'function',
      function: {
        name: 'test_tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
      },
    };
    const entry = createManifestEntry({ sourceCode, description, jsonSchema });
    const tool = createMockTool({ sourceCode, description, jsonSchema });
    
    const diff = compareToolWithManifest(entry, tool);
    
    expect(diff.hasChanges).toBe(false);
    expect(diff.changes).toHaveLength(0);
  });
});

// =============================================================================
// classifyTool Tests
// =============================================================================

describe('classifyTool', () => {
  const manifestNames = new Set(['tool_a', 'tool_b', 'my_tool']);

  it('should classify managed tool in manifest as MANAGED', () => {
    const tool = createManagedTool('tool_a', 'code');

    const classification = classifyTool(tool, manifestNames);

    expect(classification.ownership).toBe(ToolOwnership.MANAGED);
    expect(classification.info?.isManaged).toBe(true);
    expect(classification.reason).toContain('managed metadata');
    expect(classification.reason).toContain('Git manifest');
  });

  it('should classify managed tool not in manifest as ORPHANED', () => {
    const tool = createManagedTool('orphan_tool', 'code');

    const classification = classifyTool(tool, manifestNames);

    expect(classification.ownership).toBe(ToolOwnership.ORPHANED);
    expect(classification.reason).toContain('not in Git manifest');
  });

  it('should classify unmanaged tool in manifest as ADOPTED', () => {
    const tool = createMockTool({
      name: 'tool_a',
      tags: [],
    });

    const classification = classifyTool(tool, manifestNames);

    expect(classification.ownership).toBe(ToolOwnership.ADOPTED);
    expect(classification.reason).toContain('needs adoption');
  });

  it('should classify unmanaged tool not in manifest as UNMANAGED', () => {
    const tool = createMockTool({
      name: 'random_tool',
      tags: [],
    });

    const classification = classifyTool(tool, manifestNames);

    expect(classification.ownership).toBe(ToolOwnership.UNMANAGED);
    expect(classification.reason).toContain('not in manifest');
  });

  it('should include management info for managed tools', () => {
    const tool = createMockTool({
      name: 'tool_a',
      tags: [
        'managed_by:smarty-admin',
        'layer:project',
        'org:acme',
        'package_version:abc123',
      ],
    });

    const classification = classifyTool(tool, manifestNames);

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
    it('should plan to create missing tools', async () => {
      const client = createMockClient();
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool', sourceCode: 'code' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.creates).toHaveLength(1);
      expect(plan.creates[0].name).toBe('new_tool');
      expect(plan.creates[0].type).toBe('create');
      expect(plan.summary.toCreate).toBe(1);
    });

    it('should include source and layer in create action changes', async () => {
      const client = createMockClient();
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({
          name: 'new_tool',
          sourceCode: 'def tool(): pass',
          layer: 'base',
          description: 'A description',
        }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      const changes = plan.creates[0].changes ?? [];
      expect(changes.some(c => c.field === 'sourceCode')).toBe(true);
      expect(changes.some(c => c.field === 'layer')).toBe(true);
    });
  });

  describe('update actions', () => {
    it('should plan to update tools with changed content', async () => {
      const existingTool = createManagedTool('my_tool', 'old code', 'project');
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({
          name: 'my_tool',
          sourceCode: 'new code',
          layer: 'project',
        }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].name).toBe('my_tool');
      expect(plan.updates[0].type).toBe('update');
      expect(plan.updates[0].toolId).toBe(existingTool.id);
      expect(plan.summary.toUpdate).toBe(1);
    });

    it('should plan to update when package version differs', async () => {
      const existingTool = createManagedTool('my_tool', 'code', 'project');
      existingTool.tags = [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:old-sha',
      ];

      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'code', layer: 'project' }),
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
    it('should plan to adopt tools with matching name but no metadata', async () => {
      const existingTool = createMockTool({
        name: 'my_tool',
        sourceCode: 'existing code',
        tags: [],
      });
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'new code', layer: 'project' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].type).toBe('adopt');
      expect(plan.updates[0].changes?.some(c => c.field === 'tags')).toBe(true);
    });
  });

  describe('skip actions', () => {
    it('should skip tools that are in sync', async () => {
      const sourceCode = 'def same(): pass';
      const existingTool = createManagedTool('my_tool', sourceCode, 'project');
      existingTool.tags = [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:same-sha',
      ];

      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode, layer: 'project' }),
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

    it('should adopt unmanaged tools that exist in manifest', async () => {
      // Note: Unlike blocks, tools reconciler adopts unmanaged tools that match manifest names
      // instead of skipping them
      const existingTool = createMockTool({
        name: 'unmanaged_tool',
        sourceCode: 'user data',
        tags: [],
      });
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'unmanaged_tool', sourceCode: 'new content' }),
      ];

      const plan = await buildReconcilePlan(client, manifest, createDefaultApplyOptions());

      // Tool should be adopted (classified as ADOPTED when unmanaged but in manifest)
      expect(plan.updates).toHaveLength(1);
      expect(plan.updates[0].type).toBe('adopt');
    });
  });

  describe('delete actions', () => {
    it('should plan to delete orphaned tools when allowDelete is true', async () => {
      const orphanTool = createManagedTool('orphan_tool', 'orphaned', 'project');
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([orphanTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(plan.deletes).toHaveLength(1);
      expect(plan.deletes[0].name).toBe('orphan_tool');
      expect(plan.summary.toDelete).toBe(1);
    });

    it('should skip orphaned tools when allowDelete is false', async () => {
      const orphanTool = createManagedTool('orphan_tool', 'orphaned', 'project');
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([orphanTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [];

      const plan = await buildReconcilePlan(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: false })
      );

      expect(plan.deletes).toHaveLength(0);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toContain('--allow-delete');
    });

    it('should not delete unmanaged tools', async () => {
      const unmanagedTool = createMockTool({
        name: 'user_tool',
        tags: [],
      });
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([unmanagedTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [];

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
      const existingTools = [
        createManagedTool('update_me', 'old', 'project'),
        createManagedTool('synced', 'same', 'project'),
        createManagedTool('orphan', 'orphaned', 'project'),
      ];
      // Ensure synced tool has matching package version
      existingTools[1].tags = [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:test-sha',
      ];

      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue(existingTools),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'create_me', sourceCode: 'new', layer: 'project' }),
        createManifestEntry({ name: 'update_me', sourceCode: 'new', layer: 'project' }),
        createManifestEntry({ name: 'synced', sourceCode: 'same', layer: 'project' }),
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
// applyToolReconciliation Tests
// =============================================================================

describe('applyToolReconciliation', () => {
  describe('dry run mode', () => {
    it('should not call API in dry run mode', async () => {
      const createFn = vi.fn();
      const client = createMockClient({
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
      ];

      const result = await applyToolReconciliation(
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
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
      ];

      const result = await applyToolReconciliation(
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
        id: 'new-tool-123',
        name: 'new_tool',
        sourceType: 'python',
        sourceCode: 'code',
        tags: ['managed_by:smarty-admin', 'layer:project'],
      });
      const client = createMockClient({
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool', sourceCode: 'code', layer: 'project' }),
      ];

      const result = await applyToolReconciliation(
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
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
      ];

      const result = await applyToolReconciliation(
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
      const existingTool = createManagedTool('my_tool', 'old', 'project');
      const updateFn = vi.fn().mockResolvedValue({
        ...existingTool,
        sourceCode: 'new',
      });
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
          update: updateFn,
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'new', layer: 'project' }),
      ];

      const result = await applyToolReconciliation(
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
      const existingTool = createMockTool({
        name: 'my_tool',
        sourceCode: 'code',
        tags: [],
      });
      const updateFn = vi.fn().mockResolvedValue({
        ...existingTool,
        tags: ['managed_by:smarty-admin', 'layer:project'],
      });
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
          update: updateFn,
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'code', layer: 'project' }),
      ];

      const result = await applyToolReconciliation(
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
      const orphanTool = createManagedTool('orphan_tool', 'orphaned', 'project');
      const deleteFn = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([orphanTool]),
          delete: deleteFn,
        },
      });
      const manifest: ToolManifestEntry[] = [];

      const result = await applyToolReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ allowDelete: true })
      );

      expect(result.success).toBe(true);
      expect(deleteFn).toHaveBeenCalledWith(orphanTool.id);
      expect(result.summary.deleted).toBe(1);
    });

    it('should handle delete errors gracefully', async () => {
      const orphanTool = createManagedTool('orphan_tool', 'orphaned', 'project');
      const deleteFn = vi.fn().mockRejectedValue(new Error('Delete failed'));
      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([orphanTool]),
          delete: deleteFn,
        },
      });
      const manifest: ToolManifestEntry[] = [];

      const result = await applyToolReconciliation(
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
          id: 'second-tool',
          name: 'second_tool',
          sourceType: 'python',
          sourceCode: 'code',
          tags: ['managed_by:smarty-admin', 'layer:project'],
        });
      const client = createMockClient({
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'first_tool' }),
        createManifestEntry({ name: 'second_tool' }),
      ];

      const result = await applyToolReconciliation(
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
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'first_tool' }),
        createManifestEntry({ name: 'second_tool' }),
      ];

      const result = await applyToolReconciliation(
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
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
      ];

      const result = await applyToolReconciliation(
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
        tools: { create: createFn },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
      ];

      const result = await applyToolReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      expect(result.success).toBe(false);
    });

    it('should include all action results', async () => {
      const existingTool = createManagedTool('existing', 'same', 'project');
      existingTool.tags = [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:test-sha',
      ];

      const client = createMockClient({
        tools: {
          list: vi.fn().mockResolvedValue([existingTool]),
        },
      });
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool' }),
        createManifestEntry({ name: 'existing', sourceCode: 'same', layer: 'project' }),
      ];

      const result = await applyToolReconciliation(
        client,
        manifest,
        createDefaultApplyOptions({ packageVersion: 'test-sha' })
      );

      // Should have results for both create and skip actions
      expect(result.results.length).toBeGreaterThanOrEqual(2);
    });
  });
});
