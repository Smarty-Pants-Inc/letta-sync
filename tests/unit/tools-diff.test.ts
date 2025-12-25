/**
 * Unit Tests: Tools Diff Algorithm
 *
 * Tests the diff algorithm that compares desired tool state (from manifest)
 * with actual tool state (from Letta API) and generates reconciliation plans.
 *
 * @see tools/smarty-admin/src/reconcilers/tools/diff.ts
 */

import { describe, it, expect } from 'vitest';
import {
  diffTools,
  computeDrifts,
  isToolManaged,
  extractManagedMetadata,
  classifyToolOwnership,
  parseToolManagement,
  formatDiffSummary,
  formatDiffDetails,
  formatDiffAsJson,
  type ToolDiffOptions,
  type DriftType,
} from '../../src/reconcilers/tools/diff.js';
import {
  ToolOwnership,
  type ToolManifestEntry,
  type ManagedToolMetadata,
} from '../../src/reconcilers/tools/types.js';
import type { Tool } from '../../src/api/types.js';

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

// =============================================================================
// isToolManaged Tests
// =============================================================================

describe('isToolManaged', () => {
  it('should return true for tools with smarty-admin tag', () => {
    const tool = createMockTool({
      tags: ['managed_by:smarty-admin', 'layer:project'],
    });

    expect(isToolManaged(tool)).toBe(true);
  });

  it('should return false for tools without managed_by tag', () => {
    const tool = createMockTool({ tags: [] });

    expect(isToolManaged(tool)).toBe(false);
  });

  it('should return false for tools managed by other systems', () => {
    const tool = createMockTool({
      tags: ['managed_by:other-system'],
    });

    expect(isToolManaged(tool)).toBe(false);
  });

  it('should return false for tools with undefined tags', () => {
    const tool = createMockTool({ tags: undefined });

    expect(isToolManaged(tool)).toBe(false);
  });

  it('should return false for tools with null-like tags', () => {
    const tool = createMockTool({ tags: [] });

    expect(isToolManaged(tool)).toBe(false);
  });
});

// =============================================================================
// extractManagedMetadata Tests
// =============================================================================

describe('extractManagedMetadata', () => {
  it('should extract metadata from managed tool tags', () => {
    const tool = createMockTool({
      tags: [
        'managed_by:smarty-admin',
        'layer:project',
        'org:acme',
        'project:myproj',
        'package_version:abc123',
        'last_synced:2024-01-01T00:00:00Z',
      ],
    });

    const metadata = extractManagedMetadata(tool);

    expect(metadata).not.toBeNull();
    expect(metadata?.managed_by).toBe('smarty-admin');
    expect(metadata?.layer).toBe('project');
    expect(metadata?.org).toBe('acme');
    expect(metadata?.project).toBe('myproj');
    expect(metadata?.package_version).toBe('abc123');
    expect(metadata?.last_synced).toBe('2024-01-01T00:00:00Z');
  });

  it('should return null for unmanaged tools', () => {
    const tool = createMockTool({ tags: [] });

    expect(extractManagedMetadata(tool)).toBeNull();
  });

  it('should return default layer when not specified', () => {
    const tool = createMockTool({
      tags: ['managed_by:smarty-admin'],
    });

    const metadata = extractManagedMetadata(tool);

    expect(metadata).not.toBeNull();
    expect(metadata?.layer).toBe('org'); // Default layer
  });

  it('should handle partial metadata', () => {
    const tool = createMockTool({
      tags: [
        'managed_by:smarty-admin',
        'layer:base',
      ],
    });

    const metadata = extractManagedMetadata(tool);

    expect(metadata).not.toBeNull();
    expect(metadata?.layer).toBe('base');
    expect(metadata?.org).toBeUndefined();
    expect(metadata?.project).toBeUndefined();
  });
});

// =============================================================================
// parseToolManagement Tests
// =============================================================================

describe('parseToolManagement', () => {
  it('should extract full management info from managed tool', () => {
    const tool = createMockTool({
      tags: [
        'managed_by:smarty-admin',
        'layer:project',
        'org:acme',
        'project:myproj',
        'package_version:abc123',
        'last_synced:2024-01-01T00:00:00Z',
      ],
    });

    const info = parseToolManagement(tool);

    expect(info.isManaged).toBe(true);
    expect(info.layer).toBe('project');
    expect(info.org).toBe('acme');
    expect(info.project).toBe('myproj');
    expect(info.packageVersion).toBe('abc123');
    expect(info.lastSynced).toBe('2024-01-01T00:00:00Z');
  });

  it('should return isManaged: false for unmanaged tools', () => {
    const tool = createMockTool({ tags: [] });

    const info = parseToolManagement(tool);

    expect(info.isManaged).toBe(false);
    expect(info.layer).toBeUndefined();
  });
});

// =============================================================================
// classifyToolOwnership Tests
// =============================================================================

describe('classifyToolOwnership', () => {
  const desiredNames = new Set(['tool_a', 'tool_b', 'my_tool']);

  it('should classify managed tool in desired set as MANAGED', () => {
    const tool = createManagedTool('tool_a', 'code');

    expect(classifyToolOwnership(tool, desiredNames)).toBe(ToolOwnership.MANAGED);
  });

  it('should classify managed tool not in desired set as ORPHANED', () => {
    const tool = createManagedTool('orphan_tool', 'code');

    expect(classifyToolOwnership(tool, desiredNames)).toBe(ToolOwnership.ORPHANED);
  });

  it('should classify unmanaged tool in desired set as ADOPTED candidate', () => {
    const tool = createMockTool({
      name: 'tool_a',
      tags: [],
    });

    expect(classifyToolOwnership(tool, desiredNames)).toBe(ToolOwnership.ADOPTED);
  });

  it('should classify unmanaged tool not in desired set as UNMANAGED', () => {
    const tool = createMockTool({
      name: 'random_tool',
      tags: [],
    });

    expect(classifyToolOwnership(tool, desiredNames)).toBe(ToolOwnership.UNMANAGED);
  });
});

// =============================================================================
// computeDrifts Tests
// =============================================================================

describe('computeDrifts', () => {
  it('should detect source code drift', () => {
    const desired = createManifestEntry({ sourceCode: 'def new(): pass' });
    const actual = createMockTool({ sourceCode: 'def old(): pass' });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].type).toBe('source_code');
    expect(drifts[0].field).toBe('sourceCode');
  });

  it('should detect description drift', () => {
    const desired = createManifestEntry({ description: 'new description' });
    const actual = createMockTool({ description: 'old description' });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'description')).toBe(true);
  });

  it('should detect JSON schema drift', () => {
    const desired = createManifestEntry({
      jsonSchema: {
        type: 'function',
        function: {
          name: 'test',
          description: 'test',
          parameters: {
            type: 'object',
            properties: { x: { type: 'string' } },
          },
        },
      },
    });
    const actual = createMockTool({
      jsonSchema: {
        type: 'function',
        function: {
          name: 'test',
          description: 'test',
          parameters: {
            type: 'object',
            properties: { y: { type: 'number' } },
          },
        },
      },
    });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'json_schema')).toBe(true);
  });

  it('should detect tags drift (excluding management tags)', () => {
    const desired = createManifestEntry({ tags: ['category:ai', 'priority:high'] });
    const actual = createMockTool({ tags: ['managed_by:smarty-admin', 'layer:project', 'category:old'] });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'tags')).toBe(true);
  });

  it('should detect tool type drift', () => {
    const desired = createManifestEntry({ toolType: 'external' });
    const actual = createMockTool({ toolType: 'custom' });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'tool_type')).toBe(true);
  });

  it('should detect metadata drift when package version differs', () => {
    const desired = createManifestEntry();
    const actual = createMockTool({
      tags: [
        'managed_by:smarty-admin',
        'layer:project',
        'package_version:old-sha',
      ],
    });
    const options: ToolDiffOptions = { packageVersion: 'new-sha' };

    const drifts = computeDrifts(desired, actual, options);

    expect(drifts.some(d => d.type === 'metadata')).toBe(true);
    const metadataDrift = drifts.find(d => d.type === 'metadata');
    expect(metadataDrift?.actual).toBe('old-sha');
    expect(metadataDrift?.desired).toBe('new-sha');
  });

  it('should return empty array when no drifts exist', () => {
    const sourceCode = 'def test(): pass';
    const description = 'same description';
    const desired = createManifestEntry({ sourceCode, description });
    const actual = createMockTool({ sourceCode, description });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(0);
  });

  it('should detect multiple drifts simultaneously', () => {
    const desired = createManifestEntry({
      sourceCode: 'def new(): pass',
      description: 'new desc',
      toolType: 'external',
    });
    const actual = createMockTool({
      sourceCode: 'def old(): pass',
      description: 'old desc',
      toolType: 'custom',
    });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.length).toBeGreaterThanOrEqual(3);
    const driftTypes = drifts.map(d => d.type);
    expect(driftTypes).toContain('source_code');
    expect(driftTypes).toContain('description');
    expect(driftTypes).toContain('tool_type');
  });

  it('should handle null/undefined description comparisons', () => {
    const desired = createManifestEntry({ description: 'new desc' });
    const actual = createMockTool({ description: undefined });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'description')).toBe(true);
  });
});

// =============================================================================
// diffTools Tests
// =============================================================================

describe('diffTools', () => {
  describe('create actions', () => {
    it('should identify tools to create when missing from actual', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'new_tool_1', sourceCode: 'code1' }),
        createManifestEntry({ name: 'new_tool_2', sourceCode: 'code2' }),
      ];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual);

      expect(result.creates).toHaveLength(2);
      expect(result.creates.map(c => c.name).sort()).toEqual(['new_tool_1', 'new_tool_2']);
      expect(result.summary.toCreate).toBe(2);
      expect(result.hasChanges).toBe(true);
    });

    it('should include correct changes info in create actions', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({
          name: 'new_tool',
          sourceCode: 'def tool(): pass',
          layer: 'project',
          description: 'A new tool',
        }),
      ];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual);

      expect(result.creates[0].changes).toBeDefined();
      expect(result.creates[0].changes?.some(c => c.field === 'sourceCode')).toBe(true);
      expect(result.creates[0].changes?.some(c => c.field === 'layer')).toBe(true);
    });
  });

  describe('update actions', () => {
    it('should identify tools to update when content differs', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool', sourceCode: 'def new(): pass' }),
      ];
      const actual: Tool[] = [
        createManagedTool('tool', 'def old(): pass'),
      ];

      const result = diffTools(desired, actual);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].name).toBe('tool');
      expect(result.updates[0].type).toBe('update');
      expect(result.summary.toUpdate).toBe(1);
    });

    it('should create adopt action for unmanaged tools with matching name', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'my_tool', sourceCode: 'code' }),
      ];
      const actual: Tool[] = [
        createMockTool({ name: 'my_tool', sourceCode: 'code', tags: [] }),
      ];

      const result = diffTools(desired, actual);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].type).toBe('adopt');
    });

    it('should include drift details for updated tools', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool', sourceCode: 'new' }),
      ];
      const actual: Tool[] = [
        createManagedTool('tool', 'old'),
      ];

      const result = diffTools(desired, actual);

      expect(result.driftDetails.has('tool')).toBe(true);
      expect(result.driftDetails.get('tool')!.length).toBeGreaterThan(0);
    });
  });

  describe('delete actions', () => {
    it('should identify orphaned tools when includeOrphans is true', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [
        createManagedTool('orphan_tool', 'code'),
      ];

      const result = diffTools(desired, actual, { includeOrphans: true });

      expect(result.deletes).toHaveLength(1);
      expect(result.deletes[0].name).toBe('orphan_tool');
      expect(result.summary.toDelete).toBe(1);
    });

    it('should not include orphaned tools when includeOrphans is false', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [
        createManagedTool('orphan_tool', 'code'),
      ];

      const result = diffTools(desired, actual, { includeOrphans: false });

      expect(result.deletes).toHaveLength(0);
    });

    it('should not mark unmanaged tools for deletion', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [
        createMockTool({ name: 'user_tool', tags: [] }),
      ];

      const result = diffTools(desired, actual, { includeOrphans: true });

      expect(result.deletes).toHaveLength(0);
    });
  });

  describe('skip actions', () => {
    it('should skip tools that are in sync', () => {
      const sourceCode = 'def same(): pass';
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'synced', sourceCode }),
      ];
      // Create a managed tool with only managed_by and layer tags (no last_synced, etc.)
      // to avoid tag drift comparison
      const actual: Tool[] = [
        createMockTool({
          name: 'synced',
          sourceCode,
          tags: ['managed_by:smarty-admin', 'layer:project'],
        }),
      ];

      const result = diffTools(desired, actual);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].name).toBe('synced');
      expect(result.summary.unchanged).toBe(1);
      expect(result.hasChanges).toBe(false);
    });

    it('should not include skipped tools when changesOnly is true', () => {
      const sourceCode = 'def same(): pass';
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'synced', sourceCode }),
      ];
      const actual: Tool[] = [
        createManagedTool('synced', sourceCode),
      ];

      const result = diffTools(desired, actual, { changesOnly: true });

      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('filtering', () => {
    it('should filter by layer', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'project_tool', layer: 'project' }),
        createManifestEntry({ name: 'org_tool', layer: 'org' }),
      ];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual, { layer: 'project' });

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].name).toBe('project_tool');
    });

    it('should filter by specific names', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'tool_a' }),
        createManifestEntry({ name: 'tool_b' }),
        createManifestEntry({ name: 'tool_c' }),
      ];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual, { names: ['tool_a', 'tool_c'] });

      expect(result.creates).toHaveLength(2);
      const names = result.creates.map(c => c.name).sort();
      expect(names).toEqual(['tool_a', 'tool_c']);
    });
  });

  describe('warnings and errors', () => {
    it('should warn about duplicate names in desired state', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'dup_tool' }),
        createManifestEntry({ name: 'dup_tool' }),
      ];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual);

      expect(result.warnings.some(w => w.includes('Duplicate name'))).toBe(true);
    });

    it('should warn about duplicate names in actual state', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [
        createMockTool({ id: 'id-1', name: 'dup_tool', tags: [] }),
        createMockTool({ id: 'id-2', name: 'dup_tool', tags: [] }),
      ];

      const result = diffTools(desired, actual);

      expect(result.warnings.some(w => w.includes('Duplicate name'))).toBe(true);
    });
  });

  describe('summary statistics', () => {
    it('should compute correct summary for mixed operations', () => {
      const desired: ToolManifestEntry[] = [
        createManifestEntry({ name: 'create_me', sourceCode: 'new' }),
        createManifestEntry({ name: 'update_me', sourceCode: 'updated' }),
        createManifestEntry({ name: 'keep_me', sourceCode: 'same' }),
      ];
      const actual: Tool[] = [
        createManagedTool('update_me', 'original'),
        // keep_me should have only managed_by and layer tags to avoid drift
        createMockTool({
          name: 'keep_me',
          sourceCode: 'same',
          tags: ['managed_by:smarty-admin', 'layer:project'],
        }),
        createManagedTool('delete_me', 'orphaned'),
      ];

      const result = diffTools(desired, actual, { includeOrphans: true });

      expect(result.summary.toCreate).toBe(1);
      expect(result.summary.toUpdate).toBe(1);
      expect(result.summary.toDelete).toBe(1);
      expect(result.summary.unchanged).toBe(1);
      expect(result.summary.total).toBe(4);
    });
  });

  describe('diff metadata', () => {
    it('should generate unique diff IDs', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [];

      const result1 = diffTools(desired, actual);
      const result2 = diffTools(desired, actual);

      expect(result1.diffId).toBeDefined();
      expect(result2.diffId).toBeDefined();
      expect(result1.diffId).not.toBe(result2.diffId);
    });

    it('should include timestamp', () => {
      const desired: ToolManifestEntry[] = [];
      const actual: Tool[] = [];

      const result = diffTools(desired, actual);

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });
  });
});

// =============================================================================
// Format Functions Tests
// =============================================================================

describe('formatDiffSummary', () => {
  it('should format summary with correct sections', () => {
    const desired: ToolManifestEntry[] = [
      createManifestEntry({ name: 'new_tool' }),
    ];
    const actual: Tool[] = [];
    const result = diffTools(desired, actual);

    const summary = formatDiffSummary(result);

    expect(summary).toContain('Tool Diff Summary');
    expect(summary).toContain('Create: 1');
    expect(summary).toContain('CHANGES NEEDED');
  });

  it('should show IN SYNC when no changes', () => {
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
    const result = diffTools(desired, actual);

    const summary = formatDiffSummary(result);

    expect(summary).toContain('IN SYNC');
  });

  it('should include warnings if present', () => {
    const desired: ToolManifestEntry[] = [
      createManifestEntry({ name: 'dup' }),
      createManifestEntry({ name: 'dup' }),
    ];
    const actual: Tool[] = [];
    const result = diffTools(desired, actual);

    const summary = formatDiffSummary(result);

    expect(summary).toContain('Warnings:');
  });
});

describe('formatDiffDetails', () => {
  it('should format create details', () => {
    const desired: ToolManifestEntry[] = [
      createManifestEntry({ name: 'new_tool' }),
    ];
    const actual: Tool[] = [];
    const result = diffTools(desired, actual);

    const details = formatDiffDetails(result);

    expect(details).toContain('Tools to CREATE:');
    expect(details).toContain('new_tool');
  });

  it('should format update details', () => {
    const desired: ToolManifestEntry[] = [
      createManifestEntry({ name: 'tool', sourceCode: 'new code' }),
    ];
    const actual: Tool[] = [
      createManagedTool('tool', 'old code'),
    ];
    const result = diffTools(desired, actual);

    const details = formatDiffDetails(result);

    expect(details).toContain('Tools to UPDATE:');
    expect(details).toContain('tool');
  });

  it('should format delete details', () => {
    const desired: ToolManifestEntry[] = [];
    const actual: Tool[] = [
      createManagedTool('orphan', 'code'),
    ];
    const result = diffTools(desired, actual, { includeOrphans: true });

    const details = formatDiffDetails(result);

    expect(details).toContain('Tools to DELETE');
    expect(details).toContain('orphan');
  });
});

describe('formatDiffAsJson', () => {
  it('should format as valid JSON', () => {
    const desired: ToolManifestEntry[] = [
      createManifestEntry({ name: 'tool' }),
    ];
    const actual: Tool[] = [];
    const result = diffTools(desired, actual);

    const json = formatDiffAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed.hasChanges).toBe(true);
    expect(parsed.creates).toHaveLength(1);
    expect(parsed.summary.toCreate).toBe(1);
  });

  it('should include all result fields', () => {
    const desired: ToolManifestEntry[] = [];
    const actual: Tool[] = [];
    const result = diffTools(desired, actual);

    const json = formatDiffAsJson(result);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('diffId');
    expect(parsed).toHaveProperty('hasChanges');
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('creates');
    expect(parsed).toHaveProperty('updates');
    expect(parsed).toHaveProperty('deletes');
    expect(parsed).toHaveProperty('skipped');
  });
});
