/**
 * Tests for upgrade-plan.ts
 *
 * Covers:
 * - Plan computation for different scenarios
 * - Idempotent upgrades (running twice = no changes)
 * - Channel behavior (stable vs beta vs pinned)
 * - Safe vs breaking change detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeUpgradePlan,
  getDefaultChannelForRole,
  validateRoleChannelCombination,
  formatPlanSummary,
  type AgentCurrentState,
  type ComputePlanOptions,
  type AgentRole,
  type UpgradeChannel,
} from '../../src/reconcilers/agents/upgrade-plan.js';
import type { DesiredState, BlockResource, ToolResource } from '../../src/packages/types.js';
import type { Block, Tool, Folder, Identity } from '../../src/api/types.js';
import type { ManagedState } from '../../src/reconcilers/agents/state.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createMockBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'block-123',
    label: 'test_block',
    value: 'test value',
    limit: 1000,
    description: 'Test block',
    ...overrides,
  };
}

function createMockBlockResource(overrides: Partial<BlockResource> = {}): BlockResource {
  return {
    kind: 'Block',
    apiVersion: 'v1',
    metadata: {
      name: 'test_block',
      description: 'Test block',
      ...overrides.metadata,
    },
    spec: {
      label: 'test_block',
      value: 'test value',
      limit: 1000,
      layer: 'base',
      ...overrides.spec,
    },
  } as BlockResource;
}

function createMockTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-123',
    name: 'test_tool',
    description: 'Test tool',
    sourceType: 'python',
    sourceCode: 'def test(): pass',
    jsonSchema: {},
    tags: [],
    ...overrides,
  };
}

function createMockToolResource(overrides: Partial<ToolResource> = {}): ToolResource {
  return {
    kind: 'Tool',
    apiVersion: 'v1',
    metadata: {
      name: 'test_tool',
      description: 'Test tool',
      ...overrides.metadata,
    },
    spec: {
      sourceType: 'python',
      sourceCode: 'def test(): pass',
      layer: 'base',
      ...overrides.spec,
    },
  } as ToolResource;
}

function createEmptyCurrentState(agentId: string = 'agent-123'): AgentCurrentState {
  return {
    agentId,
    agentName: 'Test Agent',
    blocks: [],
    tools: [],
    folders: [],
    identities: [],
  };
}

function createEmptyDesiredState(): DesiredState {
  return {
    blocks: [],
    tools: [],
    folders: [],
    identities: [],
    mcpServers: [],
    templates: [],
    policies: [],
    layerTags: {
      base: 'layer:base',
      org: 'layer:org',
      project: 'layer:project',
    },
  };
}

function createDefaultOptions(overrides: Partial<ComputePlanOptions> = {}): ComputePlanOptions {
  return {
    role: 'lane-dev',
    channel: 'stable',
    ...overrides,
  };
}

// =============================================================================
// Idempotent Upgrades Tests
// =============================================================================

describe('Idempotent Upgrades', () => {
  it('should return no changes when current state matches desired state', () => {
    // Important: description must match between current and desired for no changes
    const currentBlock = createMockBlock({
      label: 'persona',
      value: 'Hello world',
      description: 'Persona block',
    });
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'persona', description: 'Persona block' },
      spec: { label: 'persona', value: 'Hello world', layer: 'base' },
    });

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      blocks: [currentBlock],
    };

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan.hasChanges).toBe(false);
    expect(plan.summary.safeChanges).toBe(0);
    expect(plan.summary.breakingChanges).toBe(0);
  });

  it('should return same plan when computed twice with unchanged state', () => {
    const currentState = createEmptyCurrentState();
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'new_block', description: 'New block' },
      spec: { label: 'new_block', value: 'content', layer: 'base' },
    });

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan1 = computeUpgradePlan(currentState, desiredState, createDefaultOptions());
    const plan2 = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan1.hasChanges).toBe(plan2.hasChanges);
    expect(plan1.summary.blocksToAttach).toBe(plan2.summary.blocksToAttach);
    expect(plan1.actions.length).toBe(plan2.actions.length);
  });

  it('should show unchanged items when includeUnchanged option is true', () => {
    // Important: description must also match for the block to be truly unchanged
    const currentBlock = createMockBlock({
      label: 'synced_block',
      value: 'synced',
      description: 'Synced block',
    });
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'synced_block', description: 'Synced block' },
      spec: { label: 'synced_block', value: 'synced', layer: 'base' },
    });

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      blocks: [currentBlock],
    };

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan = computeUpgradePlan(currentState, desiredState, {
      ...createDefaultOptions(),
      includeUnchanged: true,
    });

    expect(plan.summary.unchanged).toBe(1);
    const skipAction = plan.actions.find(a => a.type === 'skip');
    expect(skipAction).toBeDefined();
    expect(skipAction?.resourceName).toBe('synced_block');
  });
});

// =============================================================================
// Channel Behavior Tests
// =============================================================================

describe('Channel Behavior', () => {
  describe('getDefaultChannelForRole', () => {
    it('should return stable for lane-dev', () => {
      expect(getDefaultChannelForRole('lane-dev')).toBe('stable');
    });

    it('should return beta for repo-curator', () => {
      expect(getDefaultChannelForRole('repo-curator')).toBe('beta');
    });

    it('should return stable for org-curator', () => {
      expect(getDefaultChannelForRole('org-curator')).toBe('stable');
    });

    it('should return stable for supervisor', () => {
      expect(getDefaultChannelForRole('supervisor')).toBe('stable');
    });
  });

  describe('validateRoleChannelCombination', () => {
    it('should warn about org-curator on beta channel', () => {
      const result = validateRoleChannelCombination('org-curator', 'beta');
      expect(result.valid).toBe(true);
      expect(result.warning).toContain('org-curator on beta channel is not recommended');
    });

    it('should accept lane-dev on any channel without warning', () => {
      const channels: UpgradeChannel[] = ['stable', 'beta', 'pinned'];
      for (const channel of channels) {
        const result = validateRoleChannelCombination('lane-dev', channel);
        expect(result.valid).toBe(true);
        expect(result.warning).toBeUndefined();
      }
    });
  });

  describe('Pinned Channel', () => {
    it('should require confirmation for pinned channel agents', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, {
        ...createDefaultOptions(),
        channel: 'pinned',
      });

      expect(plan.channel).toBe('pinned');
      expect(plan.requiresConfirmation).toBe(true);
      expect(plan.warnings.some(w => w.includes('pinned channel'))).toBe(true);
    });

    it('should not auto-apply even safe changes on pinned channel', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, {
        ...createDefaultOptions(),
        channel: 'pinned',
      });

      // Safe changes exist but require confirmation due to pinned channel
      expect(plan.summary.safeChanges).toBeGreaterThan(0);
      expect(plan.requiresConfirmation).toBe(true);
    });
  });

  describe('Stable and Beta Channels', () => {
    it('should auto-apply safe changes on stable channel', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, {
        ...createDefaultOptions(),
        channel: 'stable',
      });

      expect(plan.summary.safeChanges).toBe(1);
      expect(plan.summary.breakingChanges).toBe(0);
      expect(plan.requiresConfirmation).toBe(false);
    });

    it('should auto-apply safe changes on beta channel', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, {
        ...createDefaultOptions(),
        channel: 'beta',
      });

      expect(plan.summary.safeChanges).toBe(1);
      expect(plan.requiresConfirmation).toBe(false);
    });
  });
});

// =============================================================================
// Safe vs Breaking Change Detection
// =============================================================================

describe('Safe vs Breaking Change Detection', () => {
  describe('Block Changes', () => {
    it('should classify new block attachment as safe', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      const attachAction = plan.actions.find(a => a.type === 'attach_block');
      expect(attachAction).toBeDefined();
      expect(attachAction?.classification).toBe('safe');
    });

    it('should classify block content update as safe', () => {
      const currentBlock = createMockBlock({
        label: 'persona',
        value: 'old content',
      });
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'persona', description: 'Persona' },
        spec: { label: 'persona', value: 'new content', layer: 'base' },
      });

      const currentState: AgentCurrentState = {
        ...createEmptyCurrentState(),
        blocks: [currentBlock],
      };

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      const updateAction = plan.actions.find(a => a.type === 'update_block');
      expect(updateAction).toBeDefined();
      expect(updateAction?.classification).toBe('safe');
    });

    it('should classify managed block detachment as breaking', () => {
      const managedBlock = createMockBlock({
        label: 'old_block',
        value: 'content',
        // Detachment only applies to package-managed blocks. Package-managed blocks
        // include a metadata.source like base_* / org_* / project_*.
        metadata: { managed_by: 'smarty-admin', source: 'base_test' },
      });

      const currentState: AgentCurrentState = {
        ...createEmptyCurrentState(),
        blocks: [managedBlock],
      };

      const desiredState = createEmptyDesiredState(); // No blocks in desired state

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      const detachAction = plan.actions.find(a => a.type === 'detach_block');
      expect(detachAction).toBeDefined();
      expect(detachAction?.classification).toBe('breaking');
    });

    it('should not detach unmanaged blocks (they are ignored)', () => {
      const unmanagedBlock = createMockBlock({
        label: 'user_block',
        value: 'user content',
        // No managed_by metadata
      });

      const currentState: AgentCurrentState = {
        ...createEmptyCurrentState(),
        blocks: [unmanagedBlock],
      };

      const desiredState = createEmptyDesiredState();

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      // Unmanaged blocks should not trigger detach
      const detachAction = plan.actions.find(a => a.type === 'detach_block');
      expect(detachAction).toBeUndefined();
    });
  });

  describe('Tool Changes', () => {
    it('should classify new tool attachment as safe', () => {
      const currentState = createEmptyCurrentState();
      const desiredTool = createMockToolResource({
        metadata: { name: 'new_tool', description: 'New tool' },
        spec: { sourceType: 'python', sourceCode: 'def test(): pass', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        tools: [desiredTool],
      };

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      const attachAction = plan.actions.find(a => a.type === 'attach_tool');
      expect(attachAction).toBeDefined();
      expect(attachAction?.classification).toBe('safe');
    });

    it('should classify managed tool detachment as breaking', () => {
      const managedTool = createMockTool({
        name: 'old_tool',
        tags: ['managed:smarty-admin'],
      });

      const currentState: AgentCurrentState = {
        ...createEmptyCurrentState(),
        tools: [managedTool],
      };

      const desiredState = createEmptyDesiredState();

      const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

      const detachAction = plan.actions.find(a => a.type === 'detach_tool');
      expect(detachAction).toBeDefined();
      expect(detachAction?.classification).toBe('breaking');
    });
  });

  describe('Force Breaking Option', () => {
    it('should classify all changes as breaking when forceBreaking is true', () => {
      const currentState = createEmptyCurrentState();
      const desiredBlock = createMockBlockResource({
        metadata: { name: 'new_block', description: 'New' },
        spec: { label: 'new_block', value: 'content', layer: 'base' },
      });

      const desiredState: DesiredState = {
        ...createEmptyDesiredState(),
        blocks: [desiredBlock],
      };

      const plan = computeUpgradePlan(currentState, desiredState, {
        ...createDefaultOptions(),
        forceBreaking: true,
      });

      expect(plan.summary.breakingChanges).toBe(1);
      expect(plan.summary.safeChanges).toBe(0);
      expect(plan.requiresConfirmation).toBe(true);
    });
  });
});

// =============================================================================
// Plan Computation Edge Cases
// =============================================================================

describe('Plan Computation Edge Cases', () => {
  it('should handle empty current and desired states', () => {
    const currentState = createEmptyCurrentState();
    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan.hasChanges).toBe(false);
    expect(plan.actions.length).toBe(0);
    expect(plan.errors.length).toBe(0);
  });

  it('should detect block value drift', () => {
    const currentBlock = createMockBlock({
      label: 'drifted',
      value: 'original value',
    });
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'drifted', description: 'Test' },
      spec: { label: 'drifted', value: 'updated value', layer: 'base' },
    });

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      blocks: [currentBlock],
    };

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan.hasChanges).toBe(true);
    const updateAction = plan.actions.find(a => a.type === 'update_block');
    expect(updateAction).toBeDefined();
    expect(updateAction?.changes?.some(c => c.field === 'value')).toBe(true);
  });

  it('should detect block description drift', () => {
    const currentBlock = createMockBlock({
      label: 'described',
      value: 'content',
      description: 'Old description',
    });
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'described', description: 'New description' },
      spec: { label: 'described', value: 'content', layer: 'base' },
    });

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      blocks: [currentBlock],
    };

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan.hasChanges).toBe(true);
    const updateAction = plan.actions.find(a => a.type === 'update_block');
    expect(updateAction?.changes?.some(c => c.field === 'description')).toBe(true);
  });

  it('should generate unique plan IDs', () => {
    const currentState = createEmptyCurrentState();
    const desiredState = createEmptyDesiredState();

    const plan1 = computeUpgradePlan(currentState, desiredState, createDefaultOptions());
    const plan2 = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan1.planId).not.toBe(plan2.planId);
    expect(plan1.planId).toMatch(/^plan-/);
  });

  it('should include timestamp in plan', () => {
    const currentState = createEmptyCurrentState();
    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());

    expect(plan.timestamp).toBeDefined();
    expect(() => new Date(plan.timestamp)).not.toThrow();
  });

  it('should record target versions in plan', () => {
    const currentState = createEmptyCurrentState();
    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, {
      ...createDefaultOptions(),
      targetVersions: {
        base: 'abc1234567890',
        org: 'def1234567890',
      },
    });

    expect(plan.targetVersions.base).toBe('abc1234567890');
    expect(plan.targetVersions.org).toBe('def1234567890');
  });
});

// =============================================================================
// Plan Summary Formatting
// =============================================================================

describe('Plan Summary Formatting', () => {
  it('should format plan summary as readable text', () => {
    const currentState = createEmptyCurrentState();
    const desiredBlock = createMockBlockResource({
      metadata: { name: 'new_block', description: 'New' },
      spec: { label: 'new_block', value: 'content', layer: 'base' },
    });

    const desiredState: DesiredState = {
      ...createEmptyDesiredState(),
      blocks: [desiredBlock],
    };

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());
    const summary = formatPlanSummary(plan);

    expect(summary).toContain('Upgrade Plan Summary');
    expect(summary).toContain('Agent:');
    expect(summary).toContain('Role: lane-dev');
    expect(summary).toContain('Channel: stable');
    expect(summary).toContain('Blocks to attach: 1');
  });

  it('should show up to date status when no changes', () => {
    const currentState = createEmptyCurrentState();
    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());
    const summary = formatPlanSummary(plan);

    expect(summary).toContain('UP TO DATE');
  });

  it('should show confirmation required for breaking changes', () => {
    const managedBlock = createMockBlock({
      label: 'old_block',
      metadata: { managed_by: 'smarty-admin', source: 'base_test' },
    });

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      blocks: [managedBlock],
    };

    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, createDefaultOptions());
    const summary = formatPlanSummary(plan);

    expect(summary).toContain('CONFIRMATION REQUIRED');
    expect(summary).toContain('--confirm-breaking');
  });
});

// =============================================================================
// Version Drift Warning
// =============================================================================

describe('Version Drift Warning', () => {
  it('should warn about package version drift', () => {
    const managedState: ManagedState = {
      appliedPackages: {
        base: {
          version: 'abc1234567890',
          appliedAt: new Date().toISOString(),
          packagePath: 'packages/base',
          manifestSha: 'abc1234',
        },
      },
      reconcilerVersion: '1.0.0',
      lastUpgradeType: 'safe_auto',
      upgradeChannel: 'stable',
    };

    const currentState: AgentCurrentState = {
      ...createEmptyCurrentState(),
      managedState,
    };

    const desiredState = createEmptyDesiredState();

    const plan = computeUpgradePlan(currentState, desiredState, {
      ...createDefaultOptions(),
      targetVersions: {
        base: 'def9876543210', // Different version
      },
    });

    expect(plan.warnings.some(w => w.includes('version drift'))).toBe(true);
  });
});
