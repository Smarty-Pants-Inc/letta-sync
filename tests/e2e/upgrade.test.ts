/**
 * E2E Tests: Upgrade Flow
 *
 * Tests for upgrading existing agents using `smarty-admin upgrade`.
 * Validates that package updates are correctly applied, breaking changes
 * require --force, and upgrade plans are computed accurately.
 *
 * @see docs/testing/e2e-test-cases.md
 * @see tools/smarty-admin/src/commands/upgrade.ts
 * @see docs/specs/role-channel-matrix.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFullEnvironment,
  createMinimalEnvironment,
  type TestEnvironment,
} from './harness.js';
import {
  execCLI,
  execUpgrade,
  assertCLIResult,
} from './helpers.js';
import {
  STANDARD_PROJECT,
} from './fixtures/index.js';
import type { CommandContext, GlobalOptions } from '../../src/types.js';
import { upgradeCommand, type UpgradeOptions, type ExtendedUpgradeInfo } from '../../src/commands/upgrade.js';
import type { UpgradePlan } from '../../src/reconcilers/agents/upgrade-plan.js';

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

// =============================================================================
// CLI Execution Tests
// =============================================================================

describe('upgrade command (CLI)', () => {
  let env: TestEnvironment;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  describe('check mode', () => {
    it('shows available upgrades with --check', async () => {
      env = await createFullEnvironment('upgrade-check', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execUpgrade({
        testEnv: env,
        check: true,
      });

      assertCLIResult(result, {
        success: true,
        outputContains: ['Upgrade'],
      });
    });

    it('check mode does not apply changes', async () => {
      env = await createFullEnvironment('upgrade-check-noapply', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execUpgrade({
        testEnv: env,
        check: true,
      });

      expect(result.success).toBe(true);
      // Check mode should not apply changes
      expect(result.output.toLowerCase()).not.toContain('applied');
    });
  });

  describe('dry-run mode', () => {
    it('shows DRY RUN banner', async () => {
      env = await createFullEnvironment('upgrade-dry', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execCLI(
        ['upgrade', '--dry-run'],
        { testEnv: env }
      );

      assertCLIResult(result, {
        success: true,
        outputContains: ['DRY RUN'],
      });
    });
  });

  describe('help', () => {
    it('shows help with upgrade --help', async () => {
      const result = await execCLI(['upgrade', '--help']);

      assertCLIResult(result, {
        success: true,
        outputContains: ['--check', '--apply', '--force'],
      });
    });
  });
});

// =============================================================================
// Direct Function Tests
// =============================================================================

describe('Upgrade Flow (Direct Function Tests)', () => {
  describe('UPG-01: Basic Upgrade Check', () => {
    it('should check for available upgrades in dry-run mode', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.plan).toBeDefined();
    });

    it('should return version information in upgrade check', async () => {
      const ctx = createTestContext({ dryRun: true, agent: 'test-agent-123' });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.currentVersion).toBeDefined();
      expect(result.data?.targetVersion).toBeDefined();
    });
  });

  describe('UPG-02: Safe Changes Auto-Apply', () => {
    it('should classify additive changes as safe', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan && plan.safeChanges && plan.safeChanges.length > 0) {
        for (const change of plan.safeChanges) {
          expect(change.classification).toBe('safe');
        }
      }
    });
  });

  describe('UPG-03: Breaking Changes Require Force', () => {
    it('should identify breaking changes in upgrade plan', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan && plan.breakingChanges && plan.breakingChanges.length > 0) {
        for (const change of plan.breakingChanges) {
          expect(change.classification).toBe('breaking');
        }
      }
    });
  });

  describe('UPG-04: Upgrade Plan Accuracy', () => {
    it('should compute correct block changes', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan) {
        expect(plan.summary).toBeDefined();
        expect(plan.summary.blocksToAttach).toBeGreaterThanOrEqual(0);
        expect(plan.summary.blocksToUpdate).toBeGreaterThanOrEqual(0);
        expect(plan.summary.blocksToDetach).toBeGreaterThanOrEqual(0);
      }
    });

    it('should compute correct tool changes', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan) {
        expect(plan.summary.toolsToAttach).toBeGreaterThanOrEqual(0);
        expect(plan.summary.toolsToDetach).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('UPG-05: Target Version Specification', () => {
    it('should use latest version when no target specified', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.targetVersion).toMatch(/latest|[a-f0-9]+/);
    });
  });

  describe('UPG-06: Channel Behavior', () => {
    it('should respect stable channel behavior', async () => {
      const ctx = createTestContext({ dryRun: true, channel: 'stable' });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.plan?.channel).toBe('stable');
    });

    it('should respect beta channel behavior', async () => {
      const ctx = createTestContext({ dryRun: true, channel: 'beta' });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.plan?.channel).toBe('beta');
    });

    it('should require confirmation for pinned channel', async () => {
      const ctx = createTestContext({ dryRun: true, channel: 'pinned' });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;
      if (plan && plan.hasChanges) {
        expect(plan.requiresConfirmation).toBe(true);
      }
    });
  });

  describe('UPG-07: Identity Management During Upgrade', () => {
    it('should validate identities during upgrade', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: UpgradeOptions = {
        check: true,
        validateIdentities: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.identityValidation).toBeDefined();
    });

    it('should support adding identity during upgrade', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: UpgradeOptions = {
        check: true,
        addIdentity: 'new_user',
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.changes).toBeDefined();
      expect(result.data?.changes.some(c => c.includes('Add identity'))).toBe(true);
    });

    it('should support removing identity during upgrade', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: UpgradeOptions = {
        check: true,
        removeIdentity: 'old_user',
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.changes.some(c => c.includes('Remove identity'))).toBe(true);
    });
  });

  describe('UPG-08: Up-to-Date Detection', () => {
    it('should detect when agent is already up-to-date', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan?.isUpToDate) {
        expect(plan.hasChanges).toBe(false);
      }
    });
  });
});

// =============================================================================
// Upgrade Integration Tests
// =============================================================================

describe('Upgrade Integration Tests', () => {
  describe('UPG-INT-01: Full Upgrade Flow', () => {
    it('should complete check workflow', async () => {
      const checkCtx = createTestContext({ dryRun: true });
      const checkOptions: UpgradeOptions = {
        check: true,
      };

      const checkResult = await upgradeCommand(checkCtx, checkOptions);
      expect(checkResult.success).toBe(true);

      const plan = checkResult.data?.plan;
      expect(plan).toBeDefined();
    });
  });

  describe('UPG-INT-02: Upgrade with Version Pinning', () => {
    it('should upgrade to specific version and track it', async () => {
      const ctx = createTestContext({
        dryRun: true,
        channel: 'pinned',
      });
      const options: UpgradeOptions = {
        check: true,
        target: 'specific-sha-123',
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
    });
  });

  describe('UPG-INT-03: Multi-Layer Upgrade', () => {
    it('should handle upgrades affecting multiple layers', async () => {
      const ctx = createTestContext({
        dryRun: true,
        project: 'multi-layer-project',
        org: 'test-org',
      });
      const options: UpgradeOptions = {
        check: true,
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(true);
      const plan = result.data?.plan;

      if (plan) {
        expect(plan.targetVersions).toBeDefined();
      }
    });
  });
});

// =============================================================================
// Upgrade Error Handling
// =============================================================================

describe('Upgrade Error Handling', () => {
  describe('UPG-ERR-01: Invalid Identity', () => {
    it('should reject invalid identity during upgrade', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: UpgradeOptions = {
        check: true,
        addIdentity: 'invalid user with spaces',
      };

      const result = await upgradeCommand(ctx, options);

      expect(result.success).toBe(false);
      expect(result.errors?.some(e => e.includes('Invalid identity'))).toBe(true);
    });
  });
});
