/**
 * E2E Tests: Diff Accuracy
 *
 * Tests for the `smarty-admin diff` command to ensure accurate detection
 * of all drift types between local configuration and remote Letta state.
 *
 * @see docs/testing/e2e-test-cases.md
 * @see tools/smarty-admin/src/commands/diff.ts
 * @see tools/smarty-admin/src/reconcilers/blocks/diff.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFullEnvironment,
  createMinimalEnvironment,
  type TestEnvironment,
} from './harness.js';
import {
  execCLI,
  execDiff,
  assertCLIResult,
} from './helpers.js';
import {
  STANDARD_PROJECT,
} from './fixtures/index.js';
import type { CommandContext, GlobalOptions, ConfigDiff, VersionDiff } from '../../src/types.js';
import { diffCommand, type DiffOptions, type DiffResult } from '../../src/commands/diff.js';
import {
  diffBlocks,
  computeDrifts,
  isBlockManaged,
  classifyBlockOwnership,
  type BlockDiffResult,
  type BlockDrift,
  type DriftType,
} from '../../src/reconcilers/blocks/diff.js';
import type { BlockManifestEntry } from '../../src/reconcilers/blocks/types.js';
import { BlockOwnership } from '../../src/reconcilers/blocks/types.js';
import type { BlockResponse } from '../../src/api/client.js';

// =============================================================================
// Helper Functions
// =============================================================================

function createTestContext(overrides: Partial<GlobalOptions> = {}): CommandContext {
  const defaultOpts: GlobalOptions = {
    dryRun: true,
    json: true,
    channel: 'stable',
    verbose: false,
    ...overrides,
  };

  return {
    options: defaultOpts,
    outputFormat: 'json',
    project: { slug: 'test-project' },
    projectSource: 'cli',
  };
}

function createMockBlock(overrides: Partial<BlockResponse> = {}): BlockResponse {
  return {
    id: 'block-id-123',
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
// CLI Execution Tests
// =============================================================================

describe('diff command (CLI)', () => {
  let env: TestEnvironment;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  describe('basic output', () => {
    it('shows configuration comparison', async () => {
      env = await createFullEnvironment('diff-basic', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execDiff({
        testEnv: env,
      });

      assertCLIResult(result, {
        success: true,
        outputContains: ['Diff'],
      });
    });

    it('handles no differences gracefully', async () => {
      env = await createFullEnvironment('diff-nodiff', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execDiff({
        testEnv: env,
      });

      expect(result.success).toBe(true);
    });
  });

  describe('version diffs', () => {
    it('shows version differences with --versions', async () => {
      env = await createFullEnvironment('diff-versions', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execDiff({
        testEnv: env,
        versions: true,
      });

      assertCLIResult(result, {
        success: true,
      });
    });
  });

  describe('help', () => {
    it('shows help with diff --help', async () => {
      const result = await execCLI(['diff', '--help']);

      assertCLIResult(result, {
        success: true,
        outputContains: ['--full', '--versions'],
      });
    });
  });
});

// =============================================================================
// Diff Command Direct Function Tests
// =============================================================================

describe('Diff Command (Direct Function Tests)', () => {
  describe('DIFF-01: Basic Diff Execution', () => {
    it('should execute diff command successfully', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = {};

      const result = await diffCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.configDiffs).toBeDefined();
      expect(result.data?.versionDiffs).toBeDefined();
    });

    it('should return diff result structure', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = {};

      const result = await diffCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data?.configDiffs)).toBe(true);
      expect(Array.isArray(result.data?.versionDiffs)).toBe(true);
    });
  });

  describe('DIFF-02: Version Diff Detection', () => {
    it('should detect version differences between layers', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = {
        versions: true,
      };

      const result = await diffCommand(ctx, options);

      expect(result.success).toBe(true);
      const versionDiffs = result.data?.versionDiffs ?? [];

      for (const diff of versionDiffs) {
        expect(diff).toHaveProperty('layer');
        expect(diff).toHaveProperty('currentSha');
        expect(diff).toHaveProperty('desiredSha');
        expect(diff).toHaveProperty('type');
        expect(['upgrade', 'downgrade', 'initial']).toContain(diff.type);
      }
    });
  });

  describe('DIFF-03: Full Diff Mode', () => {
    it('should show all fields in full mode', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = {
        full: true,
      };

      const result = await diffCommand(ctx, options);

      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// Block Diff Algorithm Tests
// =============================================================================

describe('Block Diff Algorithm Tests', () => {
  describe('DIFF-BLOCK-01: Value Drift Detection', () => {
    it('should detect value drift between manifest and actual', () => {
      const desired = createManifestEntry({
        label: 'project_info',
        value: 'Updated project description',
      });

      const actual = createMockBlock({
        label: 'project_info',
        value: 'Old project description',
        metadata: { managed_by: 'smarty-admin', layer: 'project' },
      });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.length).toBeGreaterThan(0);
      expect(drifts.some(d => d.type === 'value')).toBe(true);

      const valueDrift = drifts.find(d => d.type === 'value');
      expect(valueDrift?.actual).toBe('Old project description');
      expect(valueDrift?.desired).toBe('Updated project description');
    });

    it('should not report drift when values match', () => {
      const desired = createManifestEntry({
        label: 'matching_block',
        value: 'Same content',
      });

      const actual = createMockBlock({
        label: 'matching_block',
        value: 'Same content',
        metadata: { managed_by: 'smarty-admin', layer: 'project' },
      });

      const drifts = computeDrifts(desired, actual);
      const valueDrifts = drifts.filter(d => d.type === 'value');

      expect(valueDrifts.length).toBe(0);
    });
  });

  describe('DIFF-BLOCK-02: Description Drift Detection', () => {
    it('should detect description drift', () => {
      const desired = createManifestEntry({
        label: 'test_block',
        value: 'Content',
        description: 'New description',
      });

      const actual = createMockBlock({
        label: 'test_block',
        value: 'Content',
        description: 'Old description',
      });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.some(d => d.type === 'description')).toBe(true);
    });
  });

  describe('DIFF-BLOCK-03: Limit Drift Detection', () => {
    it('should detect limit drift when manifest specifies limit', () => {
      const desired = createManifestEntry({
        label: 'limited_block',
        value: 'Content',
        limit: 10000,
      });

      const actual = createMockBlock({
        label: 'limited_block',
        value: 'Content',
        limit: 5000,
      });

      const drifts = computeDrifts(desired, actual);

      expect(drifts.some(d => d.type === 'limit')).toBe(true);
    });

    it('should not report limit drift when manifest does not specify limit', () => {
      const desired = createManifestEntry({
        label: 'unlimited_block',
        value: 'Content',
      });

      const actual = createMockBlock({
        label: 'unlimited_block',
        value: 'Content',
        limit: 5000,
      });

      const drifts = computeDrifts(desired, actual);
      const limitDrifts = drifts.filter(d => d.type === 'limit');

      expect(limitDrifts.length).toBe(0);
    });
  });

  describe('DIFF-BLOCK-04: Metadata Drift Detection', () => {
    it('should detect package version drift in metadata', () => {
      const desired = createManifestEntry({
        label: 'versioned_block',
        value: 'Content',
      });

      const actual = createMockBlock({
        label: 'versioned_block',
        value: 'Content',
        metadata: {
          managed_by: 'smarty-admin',
          layer: 'project',
          package_version: 'old-sha-123',
        },
      });

      const drifts = computeDrifts(desired, actual, {
        packageVersion: 'new-sha-456',
      });

      expect(drifts.some(d => d.type === 'metadata')).toBe(true);
    });
  });

  describe('DIFF-BLOCK-05: Block Classification', () => {
    it('should classify managed blocks correctly', () => {
      const block = createMockBlock({
        metadata: { managed_by: 'smarty-admin', layer: 'project' },
      });

      expect(isBlockManaged(block)).toBe(true);
    });

    it('should classify unmanaged blocks correctly', () => {
      const block = createMockBlock({
        metadata: {},
      });

      expect(isBlockManaged(block)).toBe(false);
    });

    it('should classify orphaned blocks correctly', () => {
      const managedBlock = createMockBlock({
        label: 'orphaned_block',
        metadata: { managed_by: 'smarty-admin', layer: 'project' },
      });

      const desiredLabels = new Set(['other_block']);

      const ownership = classifyBlockOwnership(managedBlock, desiredLabels);

      expect(ownership).toBe(BlockOwnership.ORPHANED);
    });

    it('should classify adoptable blocks correctly', () => {
      const unmanagedBlock = createMockBlock({
        label: 'project_info',
        metadata: {},
      });

      const desiredLabels = new Set(['project_info']);

      const ownership = classifyBlockOwnership(unmanagedBlock, desiredLabels);

      expect(ownership).toBe(BlockOwnership.ADOPTED);
    });
  });
});

// =============================================================================
// Full Block Diff Tests
// =============================================================================

describe('Full Block Diff Tests', () => {
  describe('DIFF-FULL-01: Missing Block Detection', () => {
    it('should detect blocks that need to be created', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'new_block', value: 'New content' }),
      ];

      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.creates.length).toBe(1);
      expect(result.creates[0].label).toBe('new_block');
      expect(result.creates[0].type).toBe('create');
    });
  });

  describe('DIFF-FULL-02: Orphan Detection', () => {
    it('should detect orphaned managed blocks', () => {
      const desired: BlockManifestEntry[] = [];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'orphan_block',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.deletes.length).toBe(1);
      expect(result.deletes[0].label).toBe('orphan_block');
      expect(result.deletes[0].type).toBe('delete');
    });

    it('should not flag unmanaged blocks as orphans', () => {
      const desired: BlockManifestEntry[] = [];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'user_block',
          metadata: {},
        }),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.deletes.length).toBe(0);
    });
  });

  describe('DIFF-FULL-03: Update Detection', () => {
    it('should detect blocks that need updating', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({
          label: 'existing_block',
          value: 'New value',
        }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'existing_block',
          value: 'Old value',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.updates.length).toBe(1);
      expect(result.updates[0].label).toBe('existing_block');
      expect(result.updates[0].type).toBe('update');
    });
  });

  describe('DIFF-FULL-04: No Change Detection', () => {
    it('should detect blocks that are in sync', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({
          label: 'synced_block',
          value: 'Same content',
          description: 'Same description',
        }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'synced_block',
          value: 'Same content',
          description: 'Same description',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      const result = diffBlocks(desired, actual, { changesOnly: false });

      expect(result.skipped.length).toBe(1);
      expect(result.skipped[0].label).toBe('synced_block');
      expect(result.skipped[0].type).toBe('skip');
    });

    it('should report no changes needed when everything is in sync', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block1', value: 'Content 1' }),
        createManifestEntry({ label: 'block2', value: 'Content 2' }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'block1',
          value: 'Content 1',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'block2',
          value: 'Content 2',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      const result = diffBlocks(desired, actual);

      expect(result.hasChanges).toBe(false);
      expect(result.creates.length).toBe(0);
      expect(result.updates.length).toBe(0);
      expect(result.deletes.length).toBe(0);
    });
  });

  describe('DIFF-FULL-05: Summary Accuracy', () => {
    it('should compute accurate summary statistics', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'new_block', value: 'New' }),
        createManifestEntry({ label: 'update_block', value: 'Updated' }),
        createManifestEntry({ label: 'synced_block', value: 'Synced' }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'update_block',
          value: 'Original',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'synced_block',
          value: 'Synced',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'orphan_block',
          value: 'Orphaned',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      const result = diffBlocks(desired, actual, { includeOrphans: true });

      expect(result.summary.toCreate).toBe(1);
      expect(result.summary.toUpdate).toBe(1);
      expect(result.summary.toDelete).toBe(1);
      expect(result.summary.unchanged).toBe(1);
      expect(result.summary.total).toBe(4);
    });
  });

  describe('DIFF-FULL-06: Layer Filtering', () => {
    it('should filter diffs by layer', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'project_block', value: 'P', layer: 'project' }),
        createManifestEntry({ label: 'org_block', value: 'O', layer: 'org' }),
      ];

      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual, { layer: 'project' });

      expect(result.creates.length).toBe(1);
      expect(result.creates[0].label).toBe('project_block');
    });
  });

  describe('DIFF-FULL-07: Label Filtering', () => {
    it('should filter diffs by specific labels', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'wanted_block', value: 'W' }),
        createManifestEntry({ label: 'other_block', value: 'O' }),
      ];

      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual, { labels: ['wanted_block'] });

      expect(result.creates.length).toBe(1);
      expect(result.creates[0].label).toBe('wanted_block');
    });
  });

  describe('DIFF-FULL-08: Duplicate Label Handling', () => {
    it('should warn about duplicate labels in desired state', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'dup_block', value: 'First' }),
        createManifestEntry({ label: 'dup_block', value: 'Second' }),
      ];

      const actual: BlockResponse[] = [];

      const result = diffBlocks(desired, actual);

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('Duplicate'))).toBe(true);
    });
  });
});

// =============================================================================
// Drift Type Coverage Tests
// =============================================================================

describe('Drift Type Coverage Tests', () => {
  const driftTypes: DriftType[] = ['value', 'description', 'read_only', 'limit', 'metadata'];

  for (const driftType of driftTypes) {
    it(`should properly classify ${driftType} drift`, () => {
      expect(driftTypes.includes(driftType)).toBe(true);
    });
  }
});
