/**
 * Tests for upgrade-apply.ts
 *
 * Covers:
 * - Applying upgrade plans with mocked API client
 * - Safe vs breaking change policy enforcement
 * - Idempotent apply behavior
 * - Dry run mode
 * - Error handling and rollback scenarios
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyUpgradePlan,
  previewUpgrade,
  canProceedWithUpgrade,
  requiresForce,
  formatUpgradeResult,
  UpgradeError,
  type ApplyUpgradeOptions,
  type LettaAgentClient,
  type ApplyUpgradeResult,
} from '../../src/reconcilers/agents/upgrade-apply.js';
import type {
  UpgradePlan,
  UpgradeAction,
  UpgradePlanSummary,
} from '../../src/reconcilers/agents/upgrade-plan.js';

// =============================================================================
// Mock Client Factory
// =============================================================================

interface MockClientOverrides {
  blocks?: {
    list?: ReturnType<typeof vi.fn>;
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  };
  agents?: {
    get?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
    attachBlock?: ReturnType<typeof vi.fn>;
    detachBlock?: ReturnType<typeof vi.fn>;
    attachTool?: ReturnType<typeof vi.fn>;
    detachTool?: ReturnType<typeof vi.fn>;
    attachFolder?: ReturnType<typeof vi.fn>;
    attachSource?: ReturnType<typeof vi.fn>;
  };
}

function createMockClient(overrides: MockClientOverrides = {}): LettaAgentClient {
  return {
    blocks: {
      list: overrides.blocks?.list ?? vi.fn().mockResolvedValue([{ id: 'block-123', label: 'test' }]),
      create: overrides.blocks?.create ?? vi.fn().mockResolvedValue({ id: 'new-block-123' }),
      update: overrides.blocks?.update ?? vi.fn().mockResolvedValue({}),
    },
    agents: {
      get: overrides.agents?.get ?? vi.fn().mockResolvedValue({
        id: 'agent-123',
        name: 'Test Agent',
        tags: ['managed:smarty-admin'],
      }),
      update: overrides.agents?.update ?? vi.fn().mockResolvedValue({}),
      attachBlock: overrides.agents?.attachBlock ?? vi.fn().mockResolvedValue(undefined),
      detachBlock: overrides.agents?.detachBlock ?? vi.fn().mockResolvedValue(undefined),
      attachTool: overrides.agents?.attachTool ?? vi.fn().mockResolvedValue(undefined),
      detachTool: overrides.agents?.detachTool ?? vi.fn().mockResolvedValue(undefined),
      attachFolder: overrides.agents?.attachFolder ?? vi.fn().mockResolvedValue(undefined),
      attachSource: overrides.agents?.attachSource ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as LettaAgentClient;
}

// =============================================================================
// Test Fixtures
// =============================================================================

function createEmptyPlanSummary(): UpgradePlanSummary {
  return {
    blocksToAttach: 0,
    blocksToUpdate: 0,
    blocksToDetach: 0,
    toolsToAttach: 0,
    toolsToUpdate: 0,
    toolsToDetach: 0,
    foldersToAttach: 0,
    foldersToDetach: 0,
    identitiesToAttach: 0,
    identitiesToDetach: 0,
    sourcesToAttach: 0,
    safeChanges: 0,
    breakingChanges: 0,
    unchanged: 0,
    totalChanges: 0,
  };
}

function createBasePlan(overrides: Partial<UpgradePlan> = {}): UpgradePlan {
  return {
    planId: 'plan-test-123',
    timestamp: new Date().toISOString(),
    agentId: 'agent-123',
    agentName: 'Test Agent',
    role: 'lane-dev',
    channel: 'stable',
    targetVersions: {},
    actions: [],
    summary: createEmptyPlanSummary(),
    hasChanges: false,
    requiresConfirmation: false,
    errors: [],
    warnings: [],
    isUpToDate: true,
    hasBreakingChanges: false,
    changes: [],
    safeChanges: [],
    breakingChanges: [],
    ...overrides,
  };
}

function createSafeBlockAttachAction(): UpgradeAction {
  return {
    type: 'attach_block',
    resourceKind: 'block',
    resourceName: 'new_block',
    classification: 'safe',
    reason: 'Block is defined in package but not attached',
    sourceLayer: 'base',
  };
}

function createBreakingBlockDetachAction(): UpgradeAction {
  return {
    type: 'detach_block',
    resourceKind: 'block',
    resourceName: 'old_block',
    resourceId: 'block-old-123',
    classification: 'breaking',
    reason: 'Block is no longer in package',
    sourceLayer: 'base',
  };
}

function createDefaultApplyOptions(overrides: Partial<ApplyUpgradeOptions> = {}): ApplyUpgradeOptions {
  return {
    dryRun: false,
    force: false,
    verbose: false,
    ...overrides,
  };
}

// =============================================================================
// Policy Enforcement Tests
// =============================================================================

describe('Policy Enforcement', () => {
  describe('canProceedWithUpgrade', () => {
    it('should allow upgrade when no breaking changes on stable channel', () => {
      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      const result = canProceedWithUpgrade(plan, createDefaultApplyOptions());

      expect(result.canProceed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should block upgrade with breaking changes without force flag', () => {
      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), breakingChanges: 1 },
        actions: [createBreakingBlockDetachAction()],
      });

      const result = canProceedWithUpgrade(plan, createDefaultApplyOptions());

      expect(result.canProceed).toBe(false);
      expect(result.reason).toContain('breaking change');
      expect(result.reason).toContain('--force');
    });

    it('should allow breaking changes with force flag', () => {
      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), breakingChanges: 1 },
        actions: [createBreakingBlockDetachAction()],
      });

      const result = canProceedWithUpgrade(plan, createDefaultApplyOptions({ force: true }));

      expect(result.canProceed).toBe(true);
    });

    it('should block pinned channel upgrades without force flag', () => {
      const plan = createBasePlan({
        channel: 'pinned',
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      const result = canProceedWithUpgrade(plan, createDefaultApplyOptions());

      expect(result.canProceed).toBe(false);
      expect(result.reason).toContain('pinned channel');
    });

    it('should allow pinned channel upgrades with force flag', () => {
      const plan = createBasePlan({
        channel: 'pinned',
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      const result = canProceedWithUpgrade(plan, createDefaultApplyOptions({ force: true }));

      expect(result.canProceed).toBe(true);
    });
  });

  describe('requiresForce', () => {
    it('should return true for plans with breaking changes', () => {
      const plan = createBasePlan({
        summary: { ...createEmptyPlanSummary(), breakingChanges: 1 },
      });

      expect(requiresForce(plan)).toBe(true);
    });

    it('should return true for pinned channel', () => {
      const plan = createBasePlan({ channel: 'pinned' });

      expect(requiresForce(plan)).toBe(true);
    });

    it('should return false for safe changes on stable/beta', () => {
      const plan = createBasePlan({
        channel: 'stable',
        summary: { ...createEmptyPlanSummary(), safeChanges: 1 },
      });

      expect(requiresForce(plan)).toBe(false);
    });
  });
});

// =============================================================================
// Apply Upgrade Tests
// =============================================================================

describe('Apply Upgrade', () => {
  describe('Successful Apply', () => {
    it('should apply safe block attachment action', async () => {
      const attachBlock = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        agents: { attachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.success).toBe(true);
      expect(result.summary.applied).toBe(1);
      expect(attachBlock).toHaveBeenCalled();
    });

    it('should apply multiple actions in sequence', async () => {
      const attachBlock = vi.fn().mockResolvedValue(undefined);
      const attachTool = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        agents: { attachBlock, attachTool },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 2, blocksToAttach: 1, toolsToAttach: 1 },
        actions: [
          createSafeBlockAttachAction(),
          {
            type: 'attach_tool',
            resourceKind: 'tool',
            resourceName: 'new_tool',
            classification: 'safe',
            reason: 'Tool is defined in package',
            sourceLayer: 'base',
          },
        ],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.success).toBe(true);
      expect(result.summary.applied).toBe(2);
      expect(attachBlock).toHaveBeenCalled();
      expect(attachTool).toHaveBeenCalled();
    });

    it('should update agent tags after successful apply', async () => {
      const updateAgent = vi.fn().mockResolvedValue({});
      const client = createMockClient({
        agents: { update: updateAgent },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
        actions: [createSafeBlockAttachAction()],
        targetVersions: { base: 'abc1234567890' },
      });

      await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(updateAgent).toHaveBeenCalled();
      const updateCall = updateAgent.mock.calls[0];
      expect(updateCall[0]).toBe('agent-123');
    });
  });

  describe('No Changes', () => {
    it('should return early when no changes needed', async () => {
      const client = createMockClient();
      const plan = createBasePlan({ hasChanges: false });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.success).toBe(true);
      expect(result.summary.applied).toBe(0);
    });
  });

  describe('Breaking Changes Without Force', () => {
    it('should skip breaking changes and apply safe changes', async () => {
      const attachBlock = vi.fn().mockResolvedValue(undefined);
      const detachBlock = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        agents: { attachBlock, detachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1, breakingChanges: 1 },
        actions: [
          createSafeBlockAttachAction(),
          createBreakingBlockDetachAction(),
        ],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.success).toBe(false); // Overall fails because breaking was skipped
      expect(result.summary.applied).toBe(1); // Safe change was applied
      expect(result.summary.skipped).toBe(1); // Breaking change was skipped
      expect(result.skippedActions.length).toBe(1);
      expect(attachBlock).toHaveBeenCalled();
      expect(detachBlock).not.toHaveBeenCalled();
    });

    it('should apply breaking changes when force flag is set', async () => {
      const detachBlock = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        agents: { detachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), breakingChanges: 1, blocksToDetach: 1 },
        actions: [createBreakingBlockDetachAction()],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions({ force: true }));

      expect(result.success).toBe(true);
      expect(result.summary.applied).toBe(1);
      expect(detachBlock).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should record failures in action results', async () => {
      const attachBlock = vi.fn().mockRejectedValue(new Error('API error'));
      const client = createMockClient({
        blocks: { list: vi.fn().mockResolvedValue([{ id: 'block-123', label: 'new_block' }]) },
        agents: { attachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.success).toBe(false);
      expect(result.summary.failed).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should continue applying other actions after one fails', async () => {
      const attachBlock = vi.fn()
        .mockRejectedValueOnce(new Error('First fails'))
        .mockResolvedValueOnce(undefined);
      const blocksList = vi.fn().mockResolvedValue([{ id: 'block-123', label: 'test' }]);
      const client = createMockClient({
        blocks: { list: blocksList },
        agents: { attachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 2, blocksToAttach: 2 },
        actions: [
          createSafeBlockAttachAction(),
          { ...createSafeBlockAttachAction(), resourceName: 'second_block' },
        ],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result.summary.applied).toBe(1);
      expect(result.summary.failed).toBe(1);
    });
  });

  describe('Idempotent Apply', () => {
    it('should handle already-attached block gracefully', async () => {
      // Block lookup returns the block, attachment succeeds (idempotent API)
      const blocksList = vi.fn().mockResolvedValue([{ id: 'block-123', label: 'new_block' }]);
      const attachBlock = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        blocks: { list: blocksList },
        agents: { attachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
        actions: [createSafeBlockAttachAction()],
      });

      // Apply twice
      const result1 = await applyUpgradePlan(client, plan, createDefaultApplyOptions());
      const result2 = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });

    it('should handle block not found during detachment gracefully', async () => {
      // Block lookup returns empty (already detached)
      const blocksList = vi.fn().mockResolvedValue([]);
      const detachBlock = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({
        blocks: { list: blocksList },
        agents: { detachBlock },
      });

      const plan = createBasePlan({
        hasChanges: true,
        summary: { ...createEmptyPlanSummary(), breakingChanges: 1, blocksToDetach: 1 },
        actions: [createBreakingBlockDetachAction()],
      });

      const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions({ force: true }));

      // Should succeed because block not existing is idempotent
      expect(result.success).toBe(true);
    });
  });
});

// =============================================================================
// Dry Run Tests
// =============================================================================

describe('Dry Run Mode', () => {
  it('should not call API in dry run mode', async () => {
    const attachBlock = vi.fn();
    const client = createMockClient({
      agents: { attachBlock },
    });

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
      actions: [createSafeBlockAttachAction()],
    });

    const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(attachBlock).not.toHaveBeenCalled();
  });

  it('should preview upgrade with previewUpgrade helper', async () => {
    const attachBlock = vi.fn();
    const client = createMockClient({
      agents: { attachBlock },
    });

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
      actions: [createSafeBlockAttachAction()],
    });

    const result = await previewUpgrade(client, plan, { force: false });

    expect(result.dryRun).toBe(true);
    expect(attachBlock).not.toHaveBeenCalled();
  });

  it('should compute what state would be after dry run', async () => {
    const client = createMockClient();

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
      actions: [createSafeBlockAttachAction()],
      targetVersions: { base: 'abc1234567890' },
    });

    const result = await applyUpgradePlan(client, plan, {
      ...createDefaultApplyOptions({ dryRun: true }),
      packagePaths: { base: 'packages/base' },
    });

    expect(result.appliedState).toBeDefined();
    expect(result.appliedState?.appliedPackages.base).toBeDefined();
  });
});

// =============================================================================
// Result Formatting Tests
// =============================================================================

describe('Result Formatting', () => {
  it('should format successful result', () => {
    const result: ApplyUpgradeResult = {
      planId: 'plan-123',
      agentId: 'agent-123',
      success: true,
      actionResults: [],
      summary: { applied: 2, skipped: 0, failed: 0 },
      dryRun: false,
      skippedActions: [],
      errors: [],
    };

    const formatted = formatUpgradeResult(result);

    expect(formatted).toContain('Applied: 2');
    expect(formatted).toContain('Failed: 0');
  });

  it('should format dry run result', () => {
    const result: ApplyUpgradeResult = {
      planId: 'plan-123',
      agentId: 'agent-123',
      success: true,
      actionResults: [],
      summary: { applied: 1, skipped: 0, failed: 0 },
      dryRun: true,
      skippedActions: [],
      errors: [],
    };

    const formatted = formatUpgradeResult(result);

    expect(formatted).toContain('[DRY RUN]');
  });

  it('should format result with skipped breaking changes', () => {
    const result: ApplyUpgradeResult = {
      planId: 'plan-123',
      agentId: 'agent-123',
      success: false,
      actionResults: [],
      summary: { applied: 1, skipped: 1, failed: 0 },
      dryRun: false,
      skippedActions: [createBreakingBlockDetachAction()],
      errors: [],
    };

    const formatted = formatUpgradeResult(result);

    expect(formatted).toContain('Skipped: 1');
    expect(formatted).toContain('breaking changes');
    expect(formatted).toContain('--force');
  });

  it('should format result with errors', () => {
    const result: ApplyUpgradeResult = {
      planId: 'plan-123',
      agentId: 'agent-123',
      success: false,
      actionResults: [],
      summary: { applied: 0, skipped: 0, failed: 1 },
      dryRun: false,
      skippedActions: [],
      errors: ['Failed to attach block: API error'],
    };

    const formatted = formatUpgradeResult(result);

    expect(formatted).toContain('Failed: 1');
    expect(formatted).toContain('Errors:');
    expect(formatted).toContain('API error');
  });
});

// =============================================================================
// Upgrade Type Selection Tests
// =============================================================================

describe('Upgrade Type Selection', () => {
  it('should use safe_auto type for non-forced upgrades', async () => {
    const updateBlock = vi.fn().mockResolvedValue({});
    const client = createMockClient({
      blocks: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ id: 'new-block' }),
        update: updateBlock,
      },
    });

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, blocksToAttach: 1 },
      actions: [createSafeBlockAttachAction()],
      targetVersions: { base: 'abc1234567890' },
    });

    const result = await applyUpgradePlan(client, plan, {
      ...createDefaultApplyOptions(),
      packagePaths: { base: 'packages/base' },
    });

    // The upgrade type is recorded in appliedState
    expect(result.appliedState?.lastUpgradeType).toBe('safe_auto');
  });

  it('should use breaking_manual type for forced upgrades', async () => {
    const client = createMockClient();

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), breakingChanges: 1, blocksToDetach: 1 },
      actions: [createBreakingBlockDetachAction()],
      targetVersions: { base: 'abc1234567890' },
    });

    const result = await applyUpgradePlan(client, plan, {
      ...createDefaultApplyOptions({ force: true }),
      packagePaths: { base: 'packages/base' },
    });

    expect(result.appliedState?.lastUpgradeType).toBe('breaking_manual');
  });
});

// =============================================================================
// Action Type Coverage Tests
// =============================================================================

describe('Action Type Coverage', () => {
  it('should handle attach_tool action', async () => {
    const attachTool = vi.fn().mockResolvedValue(undefined);
    const client = createMockClient({
      agents: { attachTool },
    });

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, toolsToAttach: 1 },
      actions: [{
        type: 'attach_tool',
        resourceKind: 'tool',
        resourceName: 'new_tool',
        resourceId: 'tool-123',
        classification: 'safe',
        reason: 'New tool',
        sourceLayer: 'base',
      }],
    });

    const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

    expect(result.success).toBe(true);
    expect(attachTool).toHaveBeenCalledWith('agent-123', 'tool-123');
  });

  it('should handle attach_folder action', async () => {
    const attachFolder = vi.fn().mockResolvedValue(undefined);
    const client = createMockClient({
      agents: { attachFolder },
    });

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1, foldersToAttach: 1 },
      actions: [{
        type: 'attach_folder',
        resourceKind: 'folder',
        resourceName: 'new_folder',
        resourceId: 'folder-123',
        classification: 'safe',
        reason: 'New folder',
        sourceLayer: 'base',
      }],
    });

    const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

    expect(result.success).toBe(true);
    expect(attachFolder).toHaveBeenCalledWith('agent-123', 'folder-123');
  });

  it('should handle skip action (no-op)', async () => {
    const client = createMockClient();

    const plan = createBasePlan({
      hasChanges: false,
      summary: { ...createEmptyPlanSummary(), unchanged: 1 },
      actions: [{
        type: 'skip',
        resourceKind: 'block',
        resourceName: 'unchanged_block',
        classification: 'safe',
        reason: 'Block is in sync',
      }],
    });

    const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

    expect(result.success).toBe(true);
  });

  it('should handle unsupported action type gracefully', async () => {
    const client = createMockClient();

    const plan = createBasePlan({
      hasChanges: true,
      summary: { ...createEmptyPlanSummary(), safeChanges: 1 },
      actions: [{
        type: 'update_config' as any, // Unsupported type
        resourceKind: 'agent',
        resourceName: 'agent',
        classification: 'safe',
        reason: 'Config update',
      }],
    });

    const result = await applyUpgradePlan(client, plan, createDefaultApplyOptions());

    expect(result.summary.failed).toBe(1);
    expect(result.errors.some(e => e.includes('Unsupported'))).toBe(true);
  });
});
