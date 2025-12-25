/**
 * Unit Tests: Blocks Diff Algorithm
 *
 * Tests the diff algorithm that compares desired block state (from manifest)
 * with actual block state (from Letta API) and generates reconciliation plans.
 *
 * @see tools/smarty-admin/src/reconcilers/blocks/diff.ts
 */

import { describe, it, expect } from 'vitest';
import {
  diffBlocks,
  computeDrifts,
  isBlockManaged,
  isManagedLabel,
  parseBlockManagement,
  classifyBlockOwnership,
  parseLayerFromLabel,
  extractManagedMetadata,
  type BlockDiffOptions,
  type DriftType,
} from '../../src/reconcilers/blocks/diff.js';
import {
  BlockOwnership,
  CANONICAL_LABELS,
  LAYER_PREFIXES,
  type BlockManifestEntry,
  type ManagedBlockMetadata,
} from '../../src/reconcilers/blocks/types.js';
import type { BlockResponse } from '../../src/api/client.js';

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

// =============================================================================
// isBlockManaged Tests
// =============================================================================

describe('isBlockManaged', () => {
  it('should return true for blocks with smarty-admin metadata', () => {
    const block = createMockBlock({
      metadata: { managed_by: 'smarty-admin', layer: 'project' },
    });

    expect(isBlockManaged(block)).toBe(true);
  });

  it('should return false for blocks without managed_by field', () => {
    const block = createMockBlock({ metadata: {} });

    expect(isBlockManaged(block)).toBe(false);
  });

  it('should return false for blocks managed by other systems', () => {
    const block = createMockBlock({
      metadata: { managed_by: 'other-system' },
    });

    expect(isBlockManaged(block)).toBe(false);
  });

  it('should return false for blocks with undefined metadata', () => {
    const block = createMockBlock({ metadata: undefined });

    expect(isBlockManaged(block)).toBe(false);
  });
});

// =============================================================================
// isManagedLabel Tests
// =============================================================================

describe('isManagedLabel', () => {
  describe('canonical labels', () => {
    it.each(Array.from(CANONICAL_LABELS))('should recognize canonical label "%s"', (label) => {
      expect(isManagedLabel(label)).toBe(true);
    });
  });

  describe('layer-prefixed labels', () => {
    it.each(Object.entries(LAYER_PREFIXES))(
      'should recognize %s layer prefix "%s"',
      (layer, prefix) => {
        expect(isManagedLabel(`${prefix}custom_block`)).toBe(true);
      }
    );
  });

  it('should return false for unrecognized labels', () => {
    expect(isManagedLabel('random_label')).toBe(false);
    expect(isManagedLabel('my_custom_block')).toBe(false);
    expect(isManagedLabel('')).toBe(false);
  });
});

// =============================================================================
// parseLayerFromLabel Tests
// =============================================================================

describe('parseLayerFromLabel', () => {
  describe('canonical labels', () => {
    it('should return "project" for project-related canonical labels', () => {
      expect(parseLayerFromLabel('project')).toBe('project');
      expect(parseLayerFromLabel('decisions')).toBe('project');
      expect(parseLayerFromLabel('conventions')).toBe('project');
      expect(parseLayerFromLabel('glossary')).toBe('project');
    });

    it('should return "lane" for lane-scoped canonical labels', () => {
      expect(parseLayerFromLabel('human')).toBe('lane');
      expect(parseLayerFromLabel('persona')).toBe('lane');
      expect(parseLayerFromLabel('managed_state')).toBe('lane');
    });
  });

  describe('prefixed labels', () => {
    it.each([
      ['base_config', 'base'],
      ['org_acme_settings', 'org'],
      ['project_myproj_data', 'project'],
      ['user_prefs', 'user'],
      ['lane_dev_state', 'lane'],
    ] as const)('should parse "%s" as %s layer', (label, expectedLayer) => {
      expect(parseLayerFromLabel(label)).toBe(expectedLayer);
    });
  });

  it('should return null for unrecognized labels', () => {
    expect(parseLayerFromLabel('random_label')).toBeNull();
    expect(parseLayerFromLabel('')).toBeNull();
  });
});

// =============================================================================
// parseBlockManagement Tests
// =============================================================================

describe('parseBlockManagement', () => {
  it('should extract full management info from managed block', () => {
    const block = createMockBlock({
      metadata: {
        managed_by: 'smarty-admin',
        layer: 'project',
        org: 'acme',
        project: 'myproj',
        package_version: 'abc123',
        last_synced: '2024-01-01T00:00:00Z',
      },
    });

    const info = parseBlockManagement(block);

    expect(info.isManaged).toBe(true);
    expect(info.layer).toBe('project');
    expect(info.org).toBe('acme');
    expect(info.project).toBe('myproj');
    expect(info.packageVersion).toBe('abc123');
    expect(info.lastSynced).toBe('2024-01-01T00:00:00Z');
  });

  it('should return isManaged: false for unmanaged blocks', () => {
    const block = createMockBlock({ metadata: {} });

    const info = parseBlockManagement(block);

    expect(info.isManaged).toBe(false);
    expect(info.layer).toBeUndefined();
  });

  it('should handle user layer metadata', () => {
    const block = createMockBlock({
      metadata: {
        managed_by: 'smarty-admin',
        layer: 'user',
        org: 'acme',
        user_identity_id: 'user-123',
      },
    });

    const info = parseBlockManagement(block);

    expect(info.isManaged).toBe(true);
    expect(info.layer).toBe('user');
    expect(info.userIdentityId).toBe('user-123');
  });
});

// =============================================================================
// extractManagedMetadata Tests
// =============================================================================

describe('extractManagedMetadata', () => {
  it('should extract metadata from managed block', () => {
    const metadata: ManagedBlockMetadata = {
      managed_by: 'smarty-admin',
      layer: 'project',
      org: 'acme',
    };
    const block = createMockBlock({ metadata });

    const extracted = extractManagedMetadata(block);

    expect(extracted).toEqual(metadata);
  });

  it('should return null for unmanaged blocks', () => {
    const block = createMockBlock({ metadata: {} });

    expect(extractManagedMetadata(block)).toBeNull();
  });
});

// =============================================================================
// classifyBlockOwnership Tests
// =============================================================================

describe('classifyBlockOwnership', () => {
  const desiredLabels = new Set(['block_a', 'block_b', 'project']);

  it('should classify managed block in desired set as MANAGED', () => {
    const block = createManagedBlock('block_a', 'content');

    expect(classifyBlockOwnership(block, desiredLabels)).toBe(BlockOwnership.MANAGED);
  });

  it('should classify managed block not in desired set as ORPHANED', () => {
    const block = createManagedBlock('orphan_block', 'content');

    expect(classifyBlockOwnership(block, desiredLabels)).toBe(BlockOwnership.ORPHANED);
  });

  it('should classify unmanaged block with managed label pattern as ADOPTED candidate', () => {
    const block = createMockBlock({
      label: 'project', // canonical label
      metadata: {},
    });

    expect(classifyBlockOwnership(block, desiredLabels)).toBe(BlockOwnership.ADOPTED);
  });

  it('should classify unmanaged block with unrecognized label as UNMANAGED', () => {
    const block = createMockBlock({
      label: 'random_label',
      metadata: {},
    });

    expect(classifyBlockOwnership(block, desiredLabels)).toBe(BlockOwnership.UNMANAGED);
  });

  it('should classify unmanaged block with managed pattern not in desired as UNMANAGED', () => {
    const block = createMockBlock({
      label: 'base_something', // Managed pattern but not in desired set
      metadata: {},
    });
    const emptyDesired = new Set<string>();

    expect(classifyBlockOwnership(block, emptyDesired)).toBe(BlockOwnership.UNMANAGED);
  });
});

// =============================================================================
// computeDrifts Tests
// =============================================================================

describe('computeDrifts', () => {
  it('should detect value drift', () => {
    const desired = createManifestEntry({ value: 'new content' });
    const actual = createMockBlock({ value: 'old content' });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].type).toBe('value');
    expect(drifts[0].actual).toBe('old content');
    expect(drifts[0].desired).toBe('new content');
  });

  it('should detect description drift', () => {
    const desired = createManifestEntry({ description: 'new description' });
    const actual = createMockBlock({ description: 'old description' });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].type).toBe('description');
    expect(drifts[0].field).toBe('description');
  });

  it('should detect limit drift when specified in manifest', () => {
    const desired = createManifestEntry({ limit: 10000 });
    const actual = createMockBlock({ limit: 5000 });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(1);
    expect(drifts[0].type).toBe('limit');
    expect(drifts[0].actual).toBe(5000);
    expect(drifts[0].desired).toBe(10000);
  });

  it('should not detect limit drift when not specified in manifest', () => {
    const desired = createManifestEntry({ limit: undefined });
    const actual = createMockBlock({ limit: 5000 });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.filter(d => d.type === 'limit')).toHaveLength(0);
  });

  it('should detect metadata drift when package version differs', () => {
    const desired = createManifestEntry();
    const actual = createMockBlock({
      metadata: {
        managed_by: 'smarty-admin',
        layer: 'project',
        package_version: 'old-sha',
      },
    });
    const options: BlockDiffOptions = { packageVersion: 'new-sha' };

    const drifts = computeDrifts(desired, actual, options);

    expect(drifts.some(d => d.type === 'metadata')).toBe(true);
    const metadataDrift = drifts.find(d => d.type === 'metadata');
    expect(metadataDrift?.actual).toBe('old-sha');
    expect(metadataDrift?.desired).toBe('new-sha');
  });

  it('should return empty array when no drifts exist', () => {
    const value = 'same content';
    const description = 'same description';
    const desired = createManifestEntry({ value, description });
    const actual = createMockBlock({ value, description });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(0);
  });

  it('should detect multiple drifts simultaneously', () => {
    const desired = createManifestEntry({
      value: 'new value',
      description: 'new desc',
      limit: 10000,
    });
    const actual = createMockBlock({
      value: 'old value',
      description: 'old desc',
      limit: 5000,
    });

    const drifts = computeDrifts(desired, actual);

    expect(drifts).toHaveLength(3);
    const driftTypes = drifts.map(d => d.type).sort();
    expect(driftTypes).toEqual(['description', 'limit', 'value']);
  });

  it('should handle null/undefined description comparisons', () => {
    const desired = createManifestEntry({ description: 'new desc' });
    const actual = createMockBlock({ description: undefined });

    const drifts = computeDrifts(desired, actual);

    expect(drifts.some(d => d.type === 'description')).toBe(true);
  });
});

// =============================================================================
// diffBlocks Tests
// =============================================================================

describe('diffBlocks', () => {
  describe('create actions', () => {
    it('should identify blocks to create when missing from actual', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'new_block_1', value: 'Content 1' }),
        createManifestEntry({ label: 'new_block_2', value: 'Content 2' }),
      ];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.creates).toHaveLength(2);
      expect(result.creates.map(c => c.label).sort()).toEqual(['new_block_1', 'new_block_2']);
      expect(result.summary.toCreate).toBe(2);
      expect(result.hasChanges).toBe(true);
    });

    it('should include correct changes info in create actions', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({
          label: 'new_block',
          value: 'Some content here',
          layer: 'project',
          description: 'A new block',
        }),
      ];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.creates[0].changes).toBeDefined();
      expect(result.creates[0].changes?.some(c => c.field === 'value')).toBe(true);
      expect(result.creates[0].changes?.some(c => c.field === 'layer')).toBe(true);
    });
  });

  describe('update actions', () => {
    it('should identify blocks to update when content differs', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block', value: 'new content' }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('block', 'old content'),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].label).toBe('block');
      expect(result.updates[0].type).toBe('update');
      expect(result.summary.toUpdate).toBe(1);
    });

    it('should create adopt action for unmanaged blocks with matching label', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'project', value: 'content' }),
      ];
      const actual: BlockResponse[] = [
        createMockBlock({ label: 'project', value: 'content', metadata: {} }),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].type).toBe('adopt');
    });

    it('should include drift details for updated blocks', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block', value: 'new' }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('block', 'old'),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.driftDetails.has('block')).toBe(true);
      expect(result.driftDetails.get('block')).toHaveLength(1);
    });
  });

  describe('delete actions', () => {
    it('should identify orphaned blocks when includeOrphans is true', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [
        createManagedBlock('orphan_block', 'content'),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.deletes).toHaveLength(1);
      expect(result.deletes[0].label).toBe('orphan_block');
      expect(result.summary.toDelete).toBe(1);
    });

    it('should not include orphaned blocks when includeOrphans is false', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [
        createManagedBlock('orphan_block', 'content'),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: false });

      expect(result.deletes).toHaveLength(0);
    });

    it('should not mark unmanaged blocks for deletion', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [
        createMockBlock({ label: 'user_block', metadata: {} }),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.deletes).toHaveLength(0);
    });
  });

  describe('skip actions', () => {
    it('should skip blocks that are in sync', () => {
      const value = 'same content';
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'synced', value }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('synced', value),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].label).toBe('synced');
      expect(result.summary.unchanged).toBe(1);
      expect(result.hasChanges).toBe(false);
    });

    it('should not include skipped blocks when changesOnly is true', () => {
      const value = 'same content';
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'synced', value }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('synced', value),
      ];

      const result = diffBlocks(desired, actual, { changesOnly: true });

      expect(result.skipped).toHaveLength(0);
    });
  });

  describe('filtering', () => {
    it('should filter by layer', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'project_block', layer: 'project' }),
        createManifestEntry({ label: 'org_block', layer: 'org' }),
      ];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual, { layer: 'project' });

      expect(result.creates).toHaveLength(1);
      expect(result.creates[0].label).toBe('project_block');
    });

    it('should filter by specific labels', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block_a' }),
        createManifestEntry({ label: 'block_b' }),
        createManifestEntry({ label: 'block_c' }),
      ];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual, { labels: ['block_a', 'block_c'] });

      expect(result.creates).toHaveLength(2);
      const labels = result.creates.map(c => c.label).sort();
      expect(labels).toEqual(['block_a', 'block_c']);
    });
  });

  describe('warnings and errors', () => {
    it('should warn about duplicate labels in desired state', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'dup_block' }),
        createManifestEntry({ label: 'dup_block' }),
      ];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.warnings.some(w => w.includes('Duplicate label'))).toBe(true);
    });

    it('should warn about duplicate labels in actual state', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [
        createMockBlock({ id: 'id-1', label: 'dup_block', metadata: {} }),
        createMockBlock({ id: 'id-2', label: 'dup_block', metadata: {} }),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.warnings.some(w => w.includes('Duplicate label'))).toBe(true);
    });
  });

  describe('summary statistics', () => {
    it('should compute correct summary for mixed operations', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'create_me', value: 'new' }),
        createManifestEntry({ label: 'update_me', value: 'updated' }),
        createManifestEntry({ label: 'keep_me', value: 'same' }),
      ];
      const actual: BlockResponse[] = [
        createManagedBlock('update_me', 'original'),
        createManagedBlock('keep_me', 'same'),
        createManagedBlock('delete_me', 'orphaned'),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.summary.toCreate).toBe(1);
      expect(result.summary.toUpdate).toBe(1);
      expect(result.summary.toDelete).toBe(1);
      expect(result.summary.unchanged).toBe(1);
      expect(result.summary.total).toBe(4);
    });
  });

  describe('diff metadata', () => {
    it('should generate unique diff IDs', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      const result1 = diffBlocks(desired, actual);
      const result2 = diffBlocks(desired, actual);

      expect(result1.diffId).toBeDefined();
      expect(result2.diffId).toBeDefined();
      expect(result1.diffId).not.toBe(result2.diffId);
    });

    it('should include timestamp', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });
  });
});
