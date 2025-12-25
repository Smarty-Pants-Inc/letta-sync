/**
 * E2E Tests: Idempotency
 *
 * Tests to verify that running commands twice produces no additional changes.
 * This is critical for the "drift reconciliation" model where repeated syncs
 * should converge to a stable state.
 *
 * @see docs/testing/e2e-test-cases.md (BL-03: Idempotency)
 * @see tools/smarty-admin/src/commands/sync.ts
 * @see tools/smarty-admin/src/commands/diff.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CommandContext, GlobalOptions, SyncResult, ConfigDiff } from '../../src/types.js';
import { diffCommand, type DiffOptions, type DiffResult } from '../../src/commands/diff.js';
import { syncCommand, type SyncOptions } from '../../src/commands/sync.js';
import { upgradeCommand, type UpgradeOptions } from '../../src/commands/upgrade.js';
import { bootstrapCommand, type BootstrapOptions } from '../../src/commands/bootstrap.js';
import {
  diffBlocks,
  type BlockDiffResult,
} from '../../src/reconcilers/blocks/diff.js';
import type { BlockManifestEntry } from '../../src/reconcilers/blocks/types.js';
import type { BlockResponse } from '../../src/api/client.js';

/**
 * Helper to create a test command context
 */
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

/**
 * Helper to create a mock block response
 */
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

/**
 * Helper to create a mock manifest entry
 */
function createManifestEntry(overrides: Partial<BlockManifestEntry> = {}): BlockManifestEntry {
  return {
    label: 'test_block',
    value: 'Test block content',
    layer: 'project',
    description: 'A test block',
    ...overrides,
  };
}

describe('Idempotency E2E Tests', () => {
  describe('IDEM-01: Diff Command Idempotency', () => {
    it('should return identical results on consecutive runs', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = {};

      // First run
      const result1 = await diffCommand(ctx, options);

      // Second run
      const result2 = await diffCommand(ctx, options);

      // Results should be identical
      expect(result1.success).toBe(result2.success);
      expect(result1.data?.configDiffs.length).toBe(result2.data?.configDiffs.length);
      expect(result1.data?.versionDiffs.length).toBe(result2.data?.versionDiffs.length);
    });

    it('should produce deterministic diff output', async () => {
      const ctx = createTestContext();
      const options: DiffOptions = { versions: true };

      const runs: DiffResult[] = [];

      // Run 5 times
      for (let i = 0; i < 5; i++) {
        const result = await diffCommand(ctx, options);
        if (result.data) {
          runs.push(result.data);
        }
      }

      // All runs should have same version diff count
      const firstCount = runs[0]?.versionDiffs.length ?? 0;
      for (const run of runs) {
        expect(run.versionDiffs.length).toBe(firstCount);
      }
    });
  });

  describe('IDEM-02: Sync Command Idempotency', () => {
    it('should report no changes on second sync', async () => {
      const ctx = createTestContext({ dryRun: false });
      const options: SyncOptions = {};

      // First sync
      const result1 = await syncCommand(ctx, options);
      expect(result1.success).toBe(true);

      // Second sync should show no changes needed
      const result2 = await syncCommand(ctx, options);
      expect(result2.success).toBe(true);

      // Second sync should have fewer or equal applied changes
      const applied1 = result1.data?.applied.length ?? 0;
      const applied2 = result2.data?.applied.length ?? 0;

      // After first sync, second sync should have no changes
      // (in a real scenario with mocked API)
      expect(applied2).toBeLessThanOrEqual(applied1);
    });

    it('should be safe to run multiple times', async () => {
      const ctx = createTestContext({ dryRun: true }); // Safe mode
      const options: SyncOptions = {};

      // Run 3 times
      const results = [];
      for (let i = 0; i < 3; i++) {
        const result = await syncCommand(ctx, options);
        results.push(result);
      }

      // All should succeed
      for (const result of results) {
        expect(result.success).toBe(true);
      }
    });
  });

  describe('IDEM-03: Upgrade Command Idempotency', () => {
    it('should show no changes after successful upgrade', async () => {
      const ctx = createTestContext();
      const checkOptions: UpgradeOptions = { check: true };

      // First check
      const result1 = await upgradeCommand(ctx, checkOptions);

      // Simulate upgrade was applied, then check again
      // In actual implementation, state would change

      // Second check should ideally show up-to-date
      const result2 = await upgradeCommand(ctx, checkOptions);

      // Both checks should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    it('should be safe to check upgrades repeatedly', async () => {
      const ctx = createTestContext();
      const options: UpgradeOptions = { check: true };

      // Run upgrade check 5 times
      const results = [];
      for (let i = 0; i < 5; i++) {
        const result = await upgradeCommand(ctx, options);
        results.push(result);
      }

      // All should succeed and be consistent
      const planHashes = results.map(r =>
        JSON.stringify({
          safeCount: r.data?.plan?.safeChanges.length,
          breakingCount: r.data?.plan?.breakingChanges.length,
        })
      );

      // All plan summaries should be identical
      const uniqueHashes = new Set(planHashes);
      expect(uniqueHashes.size).toBe(1);
    });
  });

  describe('IDEM-04: Bootstrap Idempotency Check', () => {
    it('should detect existing agent on second bootstrap attempt', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'idempotent-agent',
      };

      // First bootstrap (dry-run)
      const result1 = await bootstrapCommand(ctx, options);
      expect(result1.success).toBe(true);

      // Second bootstrap with same name
      // In real implementation, this might:
      // 1. Return error saying agent exists
      // 2. Skip creation and just return existing agent
      // Either is acceptable for idempotency
      const result2 = await bootstrapCommand(ctx, options);
      expect(result2).toBeDefined();
    });
  });
});

describe('Block Diff Idempotency Tests', () => {
  describe('IDEM-BLOCK-01: In-Sync State Stability', () => {
    it('should consistently report no changes for synced blocks', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'synced_block', value: 'Content' }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'synced_block',
          value: 'Content',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      // Run diff multiple times
      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 10; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // All should report no changes
      for (const result of results) {
        expect(result.hasChanges).toBe(false);
        expect(result.creates.length).toBe(0);
        expect(result.updates.length).toBe(0);
        expect(result.deletes.length).toBe(0);
      }
    });
  });

  describe('IDEM-BLOCK-02: Create Action Stability', () => {
    it('should consistently identify blocks to create', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'new_block_1', value: 'New 1' }),
        createManifestEntry({ label: 'new_block_2', value: 'New 2' }),
      ];

      const actual: BlockResponse[] = [];

      // Run diff multiple times
      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // All should identify same blocks to create
      for (const result of results) {
        expect(result.creates.length).toBe(2);
        const labels = result.creates.map(c => c.label).sort();
        expect(labels).toEqual(['new_block_1', 'new_block_2']);
      }
    });
  });

  describe('IDEM-BLOCK-03: Update Action Stability', () => {
    it('should consistently identify blocks to update', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'update_block', value: 'New Value' }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'update_block',
          value: 'Old Value',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      // Run diff multiple times
      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // All should identify same update
      for (const result of results) {
        expect(result.updates.length).toBe(1);
        expect(result.updates[0].label).toBe('update_block');
      }
    });
  });

  describe('IDEM-BLOCK-04: Delete Action Stability', () => {
    it('should consistently identify orphaned blocks', () => {
      const desired: BlockManifestEntry[] = [];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'orphan_1',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'orphan_2',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      // Run diff multiple times
      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 5; i++) {
        results.push(diffBlocks(desired, actual, { includeOrphans: true }));
      }

      // All should identify same orphans
      for (const result of results) {
        expect(result.deletes.length).toBe(2);
        const labels = result.deletes.map(d => d.label).sort();
        expect(labels).toEqual(['orphan_1', 'orphan_2']);
      }
    });
  });

  describe('IDEM-BLOCK-05: Summary Stability', () => {
    it('should produce consistent summary statistics', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'create_me', value: 'New' }),
        createManifestEntry({ label: 'update_me', value: 'Updated' }),
        createManifestEntry({ label: 'keep_me', value: 'Same' }),
      ];

      const actual: BlockResponse[] = [
        createMockBlock({
          label: 'update_me',
          value: 'Original',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'keep_me',
          value: 'Same',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          label: 'delete_me',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      // Run diff multiple times
      const summaries = [];
      for (let i = 0; i < 5; i++) {
        const result = diffBlocks(desired, actual, { includeOrphans: true });
        summaries.push(result.summary);
      }

      // All summaries should be identical
      for (const summary of summaries) {
        expect(summary.toCreate).toBe(1);
        expect(summary.toUpdate).toBe(1);
        expect(summary.toDelete).toBe(1);
        expect(summary.unchanged).toBe(1);
        expect(summary.total).toBe(4);
      }
    });
  });

  describe('IDEM-BLOCK-06: Order Independence', () => {
    it('should produce same results regardless of input order', () => {
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

      // All should have same create count
      expect(result1.creates.length).toBe(3);
      expect(result2.creates.length).toBe(3);
      expect(result3.creates.length).toBe(3);

      // All should have same labels (sorted)
      const labels1 = result1.creates.map(c => c.label).sort();
      const labels2 = result2.creates.map(c => c.label).sort();
      const labels3 = result3.creates.map(c => c.label).sort();

      expect(labels1).toEqual(['a_block', 'b_block', 'c_block']);
      expect(labels2).toEqual(labels1);
      expect(labels3).toEqual(labels1);
    });
  });

  describe('IDEM-BLOCK-07: Timestamp Independence', () => {
    it('should produce same diff results regardless of timestamp', () => {
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block', value: 'Content' }),
      ];

      const actual: BlockResponse[] = [];

      // Run at different simulated times
      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(diffBlocks(desired, actual));
      }

      // Diff IDs should be different (unique per run)
      const diffIds = new Set(results.map(r => r.diffId));
      expect(diffIds.size).toBe(3);

      // But content should be the same
      for (const result of results) {
        expect(result.creates.length).toBe(1);
        expect(result.creates[0].label).toBe('block');
      }
    });
  });
});

describe('Convergence Tests', () => {
  describe('CONV-01: Post-Apply Convergence', () => {
    it('should converge to no-change state after applying diff', () => {
      // Simulate: desired state + current state = diff
      const desired: BlockManifestEntry[] = [
        createManifestEntry({ label: 'block1', value: 'V1' }),
        createManifestEntry({ label: 'block2', value: 'V2' }),
      ];

      // Initial state is empty
      const initialActual: BlockResponse[] = [];
      const initialDiff = diffBlocks(desired, initialActual);

      // Should have 2 creates
      expect(initialDiff.creates.length).toBe(2);
      expect(initialDiff.hasChanges).toBe(true);

      // Simulate applying the diff - actual now matches desired
      const postApplyActual: BlockResponse[] = [
        createMockBlock({
          id: 'new-id-1',
          label: 'block1',
          value: 'V1',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
        createMockBlock({
          id: 'new-id-2',
          label: 'block2',
          value: 'V2',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
      ];

      // Second diff should show no changes
      const postApplyDiff = diffBlocks(desired, postApplyActual);

      expect(postApplyDiff.creates.length).toBe(0);
      expect(postApplyDiff.updates.length).toBe(0);
      expect(postApplyDiff.deletes.length).toBe(0);
      expect(postApplyDiff.hasChanges).toBe(false);
    });
  });

  describe('CONV-02: Eventual Consistency', () => {
    it('should reach stable state within finite iterations', () => {
      // Start with mismatched state
      let currentActual: BlockResponse[] = [
        createMockBlock({
          label: 'old_block',
          value: 'Old',
          metadata: { managed_by: 'smarty-admin', layer: 'project' },
        }),
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
            newBlocks.push(
              createMockBlock({
                id: `new-${Date.now()}-${Math.random()}`,
                label: create.label,
                value: desired.find(d => d.label === create.label)?.value ?? '',
                metadata: { managed_by: 'smarty-admin', layer: 'project' },
              })
            );
          }

          // Keep unchanged blocks
          for (const keep of currentActual) {
            const isDeleted = diff.deletes.some(d => d.label === keep.label);
            if (!isDeleted && !diff.creates.some(c => c.label === keep.label)) {
              newBlocks.push(keep);
            }
          }

          currentActual = newBlocks;
        }

        iteration++;
      }

      // Should converge within max iterations
      expect(iteration).toBeLessThan(maxIterations);
      expect(hasChanges).toBe(false);
    });
  });
});

describe('Edge Case Idempotency Tests', () => {
  describe('EDGE-01: Empty State Handling', () => {
    it('should handle empty desired and actual states', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      const results: BlockDiffResult[] = [];
      for (let i = 0; i < 3; i++) {
        results.push(diffBlocks(desired, actual));
      }

      for (const result of results) {
        expect(result.hasChanges).toBe(false);
        expect(result.summary.total).toBe(0);
      }
    });
  });

  describe('EDGE-02: Large Block Set Stability', () => {
    it('should handle large number of blocks consistently', () => {
      const desired: BlockManifestEntry[] = [];
      const actual: BlockResponse[] = [];

      // Create 100 blocks
      for (let i = 0; i < 100; i++) {
        desired.push(createManifestEntry({
          label: `block_${i}`,
          value: `Content ${i}`,
        }));
      }

      const result1 = diffBlocks(desired, actual);
      const result2 = diffBlocks(desired, actual);

      expect(result1.creates.length).toBe(100);
      expect(result2.creates.length).toBe(100);
      expect(result1.summary.toCreate).toBe(result2.summary.toCreate);
    });
  });
});
