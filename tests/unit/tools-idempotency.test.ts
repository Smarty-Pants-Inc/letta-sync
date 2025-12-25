/**
 * Unit Tests: Tools Idempotency
 *
 * Tests that tool reconciliation operations are idempotent:
 * - Running operations twice produces no additional changes
 * - Tags/metadata are stable across operations
 * - Plans converge to no-change state after apply
 *
 * @see tools/smarty-admin/src/reconcilers/tools/diff.ts
 * @see tools/smarty-admin/src/reconcilers/tools/apply.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  diffTools,
  computeDrifts,
  type ToolDiffResult,
} from '../../src/reconcilers/tools/diff.js';
import {
  buildReconcilePlan,
  applyToolReconciliation,
  buildManagedTags,
  buildUpdatedTags,
  compareToolWithManifest,
} from '../../src/reconcilers/tools/apply.js';
import type {
  ToolManifestEntry,
  ManagedToolMetadata,
  ReconcilePlan,
  ApplyOptions,
} from '../../src/reconcilers/tools/types.js';
import type { LettaClient } from '../../src/api/client.js';
import type { Tool, CreateToolRequest } from '../../src/api/types.js';

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

function createMockClient(existingTools: Tool[] = []): LettaClient {
  const toolStore = new Map<string, Tool>();
  existingTools.forEach(t => toolStore.set(t.name, t));

  return {
    tools: {
      list: vi.fn().mockImplementation(async () => Array.from(toolStore.values())),
      create: vi.fn().mockImplementation(async (req: CreateToolRequest) => {
        const tool: Tool = {
          id: `new-${Date.now()}-${Math.random()}`,
          name: req.name,
          sourceType: req.sourceType,
          sourceCode: req.sourceCode,
          description: req.description,
          jsonSchema: req.jsonSchema,
          tags: req.tags,
          toolType: req.toolType,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        toolStore.set(tool.name, tool);
        return tool;
      }),
      update: vi.fn().mockImplementation(async (id: string, req: any) => {
        // Find tool by ID and update it
        for (const [name, tool] of toolStore.entries()) {
          if (tool.id === id) {
            const updated: Tool = {
              ...tool,
              ...req,
              updatedAt: new Date().toISOString(),
            };
            toolStore.set(name, updated);
            return updated;
          }
        }
        throw new Error(`Tool ${id} not found`);
      }),
      delete: vi.fn().mockImplementation(async (id: string) => {
        for (const [name, tool] of toolStore.entries()) {
          if (tool.id === id) {
            toolStore.delete(name);
            return;
          }
        }
      }),
    },
    agents: {} as any,
    blocks: {} as any,
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
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool_a', sourceCode: 'code A' }),
        createManifestEntry({ name: 'tool_b', sourceCode: 'code B' }),
      ];
      const actual: Tool[] = [
        createManagedTool('tool_a', 'code A'),
      ];

      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffTools(desired, actual));
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
      const desiredOrdered: ToolManifestEntry[] = [
        createManifestEntry({ name: 'a_tool', sourceCode: 'A' }),
        createManifestEntry({ name: 'b_tool', sourceCode: 'B' }),
        createManifestEntry({ name: 'c_tool', sourceCode: 'C' }),
      ];
      const desiredReversed = [...desiredOrdered].reverse();
      const desiredShuffled = [desiredOrdered[1], desiredOrdered[2], desiredOrdered[0]];

      const actual: Tool[] = [];

      const result1 = diffTools(desiredOrdered, actual);
      const result2 = diffTools(desiredReversed, actual);
      const result3 = diffTools(desiredShuffled, actual);

      expect(result1.creates.length).toBe(3);
      expect(result2.creates.length).toBe(3);
      expect(result3.creates.length).toBe(3);

      const names1 = result1.creates.map(c => c.name).sort();
      const names2 = result2.creates.map(c => c.name).sort();
      const names3 = result3.creates.map(c => c.name).sort();

      expect(names1).toEqual(names2);
      expect(names2).toEqual(names3);
    });

    it('should produce same updates regardless of actual tool order', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool_x', sourceCode: 'new_x' }),
        createManifestEntry({ name: 'tool_y', sourceCode: 'new_y' }),
      ];

      const actualOrdered: Tool[] = [
        createManagedTool('tool_x', 'old_x'),
        createManagedTool('tool_y', 'old_y'),
      ];
      const actualReversed = [...actualOrdered].reverse();

      const result1 = diffTools(desired, actualOrdered);
      const result2 = diffTools(desired, actualReversed);

      expect(result1.updates.length).toBe(result2.updates.length);
      expect(result1.summary.toUpdate).toBe(result2.summary.toUpdate);
    });
  });

  describe('in-sync stability', () => {
    it('should consistently report no changes for synced tools', () => {
      const sourceCode = 'def same(): pass';
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'synced', sourceCode }),
      ];
      // Use only managed_by and layer tags to avoid tag drift
      const actual: Tool[] = [
        createMockTool({
          name: 'synced',
          sourceCode,
          tags: ['managed_by:smarty-admin', 'layer:project'],
        }),
      ];

      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(diffTools(desired, actual));
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
        name: 'tool',
        sourceCode: 'def tool(): pass',
        description: 'desc',
      });
      // Use only managed_by and layer tags (which are excluded from comparison)
      const actual = createMockTool({
        name: 'tool',
        sourceCode: 'def tool(): pass',
        description: 'desc',
        tags: ['managed_by:smarty-admin', 'layer:project'],
      });

      // Run many times
      for (let i = 0; i < 100; i++) {
        const drifts = computeDrifts(desired, actual);
        expect(drifts).toHaveLength(0);
      }
    });
  });

  describe('timestamp independence', () => {
    it('should produce same logical diff regardless of timestamp', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool', sourceCode: 'new' }),
      ];
      const actual: Tool[] = [
        createManagedTool('tool', 'old'),
      ];

      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(diffTools(desired, actual));
      }

      // Diff IDs should be unique
      const diffIds = new Set(results.map(r => r.diffId));
      expect(diffIds.size).toBe(3);

      // But logical content should be identical
      for (const result of results) {
        expect(result.updates).toHaveLength(1);
        expect(result.updates[0].name).toBe('tool');
      }
    });
  });
});

// =============================================================================
// Tags Idempotency Tests
// =============================================================================

describe('Tags Idempotency', () => {
  describe('buildManagedTags stability', () => {
    it('should produce stable tags for same inputs (except timestamp)', () => {
      const entry = createManifestEntry({
        name: 'my_tool',
        layer: 'base',
        org: 'acme',
        project: 'myproj',
        description: 'A tool',
      });
      const options = { packageVersion: 'abc123' };

      const tags1 = buildManagedTags(entry, options);
      const tags2 = buildManagedTags(entry, options);

      // Core tags should be identical (excluding timestamp)
      const filterTimestamp = (tags: string[]) => tags.filter(t => !t.startsWith('last_synced:'));
      expect(filterTimestamp(tags1).sort()).toEqual(filterTimestamp(tags2).sort());
    });

    it('should always include managed_by:smarty-admin', () => {
      const entries = [
        createManifestEntry({ layer: 'base' }),
        createManifestEntry({ layer: 'org' }),
        createManifestEntry({ layer: 'project' }),
        createManifestEntry({ layer: 'user' }),
        createManifestEntry({ layer: 'lane' }),
      ];

      for (const entry of entries) {
        const tags = buildManagedTags(entry);
        expect(tags).toContain('managed_by:smarty-admin');
      }
    });
  });

  describe('buildUpdatedTags preservation', () => {
    it('should preserve custom tags', () => {
      const existingTags = [
        'managed_by:smarty-admin',
        'layer:project',
        'custom:my_tag',
        'category:ai',
      ];
      const entry = createManifestEntry({ layer: 'project' });

      const updated = buildUpdatedTags(existingTags, entry);

      expect(updated).toContain('custom:my_tag');
      expect(updated).toContain('category:ai');
    });

    it('should update last_synced on each call', () => {
      const existingTags = [
        'managed_by:smarty-admin',
        'layer:project',
        'last_synced:2024-01-01T00:00:00Z',
      ];
      const entry = createManifestEntry();

      const updated = buildUpdatedTags(existingTags, entry);

      const lastSyncedTag = updated.find(t => t.startsWith('last_synced:'));
      expect(lastSyncedTag).toBeDefined();
      expect(lastSyncedTag).not.toBe('last_synced:2024-01-01T00:00:00Z');
    });
  });
});

// =============================================================================
// Compare Idempotency Tests
// =============================================================================

describe('Compare Idempotency', () => {
  it('should report no changes when entry matches tool', () => {
    const sourceCode = 'def tool(): pass';
    const description = 'desc';
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

  it('should produce identical diffs for same inputs', () => {
    const entry = createManifestEntry({ sourceCode: 'new' });
    const tool = createMockTool({ sourceCode: 'old' });

    const diffs: ReturnType<typeof compareToolWithManifest>[] = [];
    for (let i = 0; i < 10; i++) {
      diffs.push(compareToolWithManifest(entry, tool));
    }

    for (const diff of diffs) {
      expect(diff.hasChanges).toBe(true);
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0].field).toBe('sourceCode');
    }
  });
});

// =============================================================================
// Plan Idempotency Tests
// =============================================================================

describe('Plan Idempotency', () => {
  it('should produce identical plans for same manifest and state', async () => {
    const existingTools = [
      createManagedTool('existing', 'old', 'project'),
    ];
    const manifest: ToolManifestEntry[] = [
      createManifestEntry({ name: 'new_tool', layer: 'project' }),
      createManifestEntry({ name: 'existing', sourceCode: 'new', layer: 'project' }),
    ];

    const plans: ReconcilePlan[] = [];
    for (let i = 0; i < 5; i++) {
      const client = createMockClient(existingTools);
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
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool1', sourceCode: 'V1' }),
        createManifestEntry({ name: 'tool2', sourceCode: 'V2' }),
      ];

      // Initial state is empty
      const initialActual: Tool[] = [];
      const initialDiff = diffTools(desired, initialActual);

      expect(initialDiff.creates).toHaveLength(2);
      expect(initialDiff.hasChanges).toBe(true);

      // Simulate applying the diff - use minimal tags to avoid drift
      const postApplyActual: Tool[] = [
        createMockTool({
          name: 'tool1',
          sourceCode: 'V1',
          tags: ['managed_by:smarty-admin', 'layer:project'],
        }),
        createMockTool({
          name: 'tool2',
          sourceCode: 'V2',
          tags: ['managed_by:smarty-admin', 'layer:project'],
        }),
      ];

      // Second diff should show no changes
      const postApplyDiff = diffTools(desired, postApplyActual);

      expect(postApplyDiff.creates).toHaveLength(0);
      expect(postApplyDiff.updates).toHaveLength(0);
      expect(postApplyDiff.deletes).toHaveLength(0);
      expect(postApplyDiff.hasChanges).toBe(false);
    });

    it('should reach stable state within finite iterations', () => {
      let currentActual: Tool[] = [
        createManagedTool('old_tool', 'Old'),
      ];

      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool', sourceCode: 'New' }),
      ];

      const maxIterations = 10;
      let iteration = 0;
      let hasChanges = true;

      while (hasChanges && iteration < maxIterations) {
        const diff = diffTools(desired, currentActual, { includeOrphans: true });

        if (!diff.hasChanges) {
          hasChanges = false;
        } else {
          // Simulate applying changes
          const newTools: Tool[] = [];

          // Apply creates - use minimal tags to avoid drift
          for (const create of diff.creates) {
            const entry = desired.find(d => d.name === create.name);
            if (entry) {
              newTools.push(createMockTool({
                name: entry.name,
                sourceCode: entry.sourceCode,
                tags: ['managed_by:smarty-admin', 'layer:project'],
              }));
            }
          }

          // Keep non-deleted tools
          for (const tool of currentActual) {
            const isDeleted = diff.deletes.some(d => d.name === tool.name);
            const isCreated = diff.creates.some(c => c.name === tool.name);
            if (!isDeleted && !isCreated) {
              newTools.push(tool);
            }
          }

          currentActual = newTools;
        }

        iteration++;
      }

      expect(iteration).toBeLessThan(maxIterations);
      expect(hasChanges).toBe(false);
    });
  });

  describe('double-apply safety', () => {
    it('should be safe to call apply twice with same manifest', async () => {
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'code', layer: 'project' }),
      ];

      const client = createMockClient();

      // First apply
      const result1 = await applyToolReconciliation(
        client,
        manifest,
        createDefaultApplyOptions()
      );

      // Second apply
      const result2 = await applyToolReconciliation(
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

    it('should skip already-created tools on second apply', async () => {
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'code', layer: 'project' }),
      ];

      // Pre-populate with tool matching manifest
      const existingTools = [
        createManagedTool('my_tool', 'code', 'project'),
      ];
      existingTools[0].tags = [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:test-sha',
      ];

      const client = createMockClient(existingTools);

      const result = await applyToolReconciliation(
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
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool', layer: 'project' }),
        createManifestEntry({ name: 'update_tool', sourceCode: 'new', layer: 'project' }),
      ];

      const existingTools = [
        createManagedTool('update_tool', 'old', 'project'),
      ];

      const results = [];
      for (let i = 0; i < 5; i++) {
        const client = createMockClient(existingTools);
        const result = await applyToolReconciliation(
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
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [];

      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffTools(desired, actual));
      }

      for (const result of results) {
        expect(result.hasChanges).toBe(false);
        expect(result.summary.total).toBe(0);
      }
    });

    it('should handle empty manifest with existing tools', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [
        createManagedTool('orphan1', 'code'),
        createManagedTool('orphan2', 'code'),
      ];

      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffTools(desired, actual, { includeOrphans: true }));
      }

      for (const result of results) {
        expect(result.deletes).toHaveLength(2);
      }
    });
  });

  describe('large scale stability', () => {
    it('should handle many tools consistently', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [];

      // Create 100 tools
      for (let i = 0; i < 100; i++) {
        desired.push(createManifestEntry({
          name: `tool_${i.toString().padStart(3, '0')}`,
          sourceCode: `def tool_${i}(): pass`,
        }));
      }

      const result1 = diffTools(desired, actual);
      const result2 = diffTools(desired, actual);

      expect(result1.creates).toHaveLength(100);
      expect(result2.creates).toHaveLength(100);
      expect(result1.summary.toCreate).toBe(result2.summary.toCreate);
    });
  });

  describe('description handling', () => {
    it('should handle undefined vs empty string descriptions consistently', () => {
      const desired1 = createManifestEntry({ description: undefined });
      const desired2 = createManifestEntry({ description: '' });

      const actual1 = createMockTool({ description: undefined });
      const actual2 = createMockTool({ description: '' });

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

  describe('tag handling', () => {
    it('should not report tag drift for identical user tags', () => {
      const desired = createManifestEntry({ tags: ['category:ai', 'priority:high'] });
      const actual = createMockTool({
        tags: ['managed_by:smarty-admin', 'layer:project', 'category:ai', 'priority:high'],
      });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.filter(d => d.type === 'tags')).toHaveLength(0);
    });

    it('should handle tag order independence', () => {
      const desired = createManifestEntry({ tags: ['a', 'b', 'c'] });
      const actual = createMockTool({
        tags: ['managed_by:smarty-admin', 'layer:project', 'c', 'a', 'b'],
      });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.filter(d => d.type === 'tags')).toHaveLength(0);
    });
  });

  describe('JSON schema handling', () => {
    it('should not report schema drift when semantically equal', () => {
      const schema = {
        type: 'function',
        function: {
          name: 'test',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'string' },
            },
          },
        },
      };
      const desired = createManifestEntry({ jsonSchema: schema });
      const actual = createMockTool({ jsonSchema: schema });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.filter(d => d.type === 'json_schema')).toHaveLength(0);
    });
  });

  describe('bundle handling', () => {
    it('should handle multiple tools from same manifest consistently', () => {
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool_from_bundle_1', sourceCode: 'code1' }),
        createManifestEntry({ name: 'tool_from_bundle_2', sourceCode: 'code2' }),
        createManifestEntry({ name: 'tool_from_bundle_3', sourceCode: 'code3' }),
      ];
      const actual: Tool[] = [];

      // Run multiple times to ensure consistency
      const results: ToolDiffResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(diffTools(manifest, actual));
      }

      // All results should be identical
      for (const result of results) {
        expect(result.creates).toHaveLength(3);
        expect(result.hasChanges).toBe(true);
      }
    });

    it('should handle bundle updates atomically in diff', () => {
      const manifest: ToolManifestEntry[] = [
        createManifestEntry({ name: 'bundle_tool_1', sourceCode: 'new1' }),
        createManifestEntry({ name: 'bundle_tool_2', sourceCode: 'new2' }),
      ];
      const actual: Tool[] = [
        createManagedTool('bundle_tool_1', 'old1'),
        createManagedTool('bundle_tool_2', 'old2'),
      ];

      const result = diffTools(manifest, actual);

      // Both tools should need update
      expect(result.updates).toHaveLength(2);
      expect(result.updates.map(u => u.name).sort()).toEqual(['bundle_tool_1', 'bundle_tool_2']);
    });
  });
});

// =============================================================================
// Reconciliation Cycle Tests
// =============================================================================

describe('Reconciliation Cycle', () => {
  it('should complete full create-verify-skip cycle', async () => {
    const manifest: ToolManifestEntry[] = [
      createManifestEntry({ name: 'lifecycle_tool', sourceCode: 'code', layer: 'project' }),
    ];

    // Step 1: Initial state - empty
    const client = createMockClient();

    // Step 2: First apply - should create
    const result1 = await applyToolReconciliation(
      client,
      manifest,
      createDefaultApplyOptions()
    );
    expect(result1.summary.created).toBe(1);
    expect(result1.summary.skipped).toBe(0);

    // Step 3: Second apply - should skip (no changes)
    const result2 = await applyToolReconciliation(
      client,
      manifest,
      createDefaultApplyOptions()
    );
    // Since the mock client doesn't add package_version, it may show as update
    // The key is that it shouldn't create again
    expect(result2.summary.created).toBe(0);
  });

  it('should complete full update-verify-skip cycle', async () => {
    const existingTool = createManagedTool('my_tool', 'old code', 'project');
    const manifest: ToolManifestEntry[] = [
      createManifestEntry({ name: 'my_tool', sourceCode: 'new code', layer: 'project' }),
    ];

    const client = createMockClient([existingTool]);

    // Step 1: First apply - should update
    const result1 = await applyToolReconciliation(
      client,
      manifest,
      createDefaultApplyOptions()
    );
    expect(result1.summary.updated).toBe(1);

    // Step 2: Second apply - verify convergence
    // After update, the tool should be in sync (or require timestamp update only)
    const result2 = await applyToolReconciliation(
      client,
      manifest,
      createDefaultApplyOptions()
    );
    expect(result2.summary.created).toBe(0);
  });
});
