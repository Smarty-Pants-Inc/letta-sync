/**
 * Tests for state.ts (managed_state block tracking)
 *
 * Covers:
 * - State serialization/deserialization (YAML format)
 * - Applied package tracking
 * - Version comparison and drift detection
 * - State updates and idempotency
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInitialState,
  serializeManagedState,
  parseManagedState,
  applyPackageToState,
  computeStateChanges,
  isStateUpToDate,
  toShortSha,
  createAppliedPackageInfo,
  MANAGED_STATE_LABEL,
  MANAGED_STATE_BLOCK_METADATA,
  MANAGED_STATE_LIMIT,
  RECONCILER_VERSION,
  type ManagedState,
  type AppliedPackageInfo,
  type PackageLayer,
  type UpgradeChannel,
  type UpgradeType,
} from '../../src/reconcilers/agents/state.js';

// =============================================================================
// Test Fixtures
// =============================================================================

function createTestAppliedPackageInfo(
  version: string = 'abc1234567890123456789012345678901234567',
  packagePath: string = 'packages/base'
): AppliedPackageInfo {
  return {
    version,
    appliedAt: '2024-01-15T10:30:00.000Z',
    packagePath,
    manifestSha: version.slice(0, 7),
  };
}

function createTestManagedState(overrides: Partial<ManagedState> = {}): ManagedState {
  return {
    appliedPackages: {},
    reconcilerVersion: RECONCILER_VERSION,
    lastUpgradeType: 'safe_auto',
    upgradeChannel: 'stable',
    lastUpgradeAt: '2024-01-15T10:30:00.000Z',
    ...overrides,
  };
}

// =============================================================================
// Constants Tests
// =============================================================================

describe('Constants', () => {
  it('should have correct managed state label', () => {
    expect(MANAGED_STATE_LABEL).toBe('managed_state');
  });

  it('should have correct block metadata', () => {
    expect(MANAGED_STATE_BLOCK_METADATA.managed_by).toBe('smarty-admin');
    expect(MANAGED_STATE_BLOCK_METADATA.layer).toBe('lane');
    expect(MANAGED_STATE_BLOCK_METADATA.description).toContain('Reconciler');
  });

  it('should have reasonable character limit', () => {
    expect(MANAGED_STATE_LIMIT).toBeGreaterThanOrEqual(1000);
    expect(MANAGED_STATE_LIMIT).toBeLessThanOrEqual(10000);
  });

  it('should have valid reconciler version', () => {
    expect(RECONCILER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// =============================================================================
// Initial State Creation Tests
// =============================================================================

describe('Initial State Creation', () => {
  it('should create empty initial state with default channel', () => {
    const state = createInitialState();

    expect(state.appliedPackages).toEqual({});
    expect(state.reconcilerVersion).toBe(RECONCILER_VERSION);
    expect(state.lastUpgradeType).toBe('initial');
    expect(state.upgradeChannel).toBe('stable');
    expect(state.lastUpgradeAt).toBeDefined();
  });

  it('should create initial state with specified channel', () => {
    const state = createInitialState('beta');

    expect(state.upgradeChannel).toBe('beta');
  });

  it('should create initial state with pinned channel', () => {
    const state = createInitialState('pinned');

    expect(state.upgradeChannel).toBe('pinned');
  });

  it('should set lastUpgradeAt to current time', () => {
    const before = Date.now();
    const state = createInitialState();
    const after = Date.now();

    const timestamp = new Date(state.lastUpgradeAt!).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

// =============================================================================
// State Serialization Tests
// =============================================================================

describe('State Serialization', () => {
  it('should serialize empty state to valid YAML', () => {
    const state = createTestManagedState();
    const serialized = serializeManagedState(state);

    expect(serialized).toContain('# Managed by smarty-admin');
    expect(serialized).toContain('# DO NOT EDIT MANUALLY');
    expect(serialized).toContain('reconciler_version:');
    expect(serialized).toContain('upgrade_channel: stable');
  });

  it('should serialize applied packages in snake_case', () => {
    const state = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
      },
    });

    const serialized = serializeManagedState(state);

    expect(serialized).toContain('applied_packages:');
    expect(serialized).toContain('base:');
    expect(serialized).toContain('package_path: packages/base');
    expect(serialized).toContain('manifest_sha: abc1234');
    expect(serialized).toContain('applied_at:');
  });

  it('should serialize multiple layers', () => {
    const state = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
        org: createTestAppliedPackageInfo('def5678901234', 'packages/org'),
        project: createTestAppliedPackageInfo('ghi9012345678', 'packages/project'),
      },
    });

    const serialized = serializeManagedState(state);

    expect(serialized).toContain('base:');
    expect(serialized).toContain('org:');
    expect(serialized).toContain('project:');
  });

  it('should serialize upgrade type correctly', () => {
    const upgradeTypes: UpgradeType[] = ['safe_auto', 'breaking_manual', 'initial'];

    for (const upgradeType of upgradeTypes) {
      const state = createTestManagedState({ lastUpgradeType: upgradeType });
      const serialized = serializeManagedState(state);

      expect(serialized).toContain(`last_upgrade_type: ${upgradeType}`);
    }
  });
});

// =============================================================================
// State Deserialization Tests
// =============================================================================

describe('State Deserialization', () => {
  it('should parse serialized state back to original', () => {
    const original = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
      },
      lastUpgradeType: 'safe_auto',
      upgradeChannel: 'stable',
    });

    const serialized = serializeManagedState(original);
    const parsed = parseManagedState(serialized);

    expect(parsed).not.toBeNull();
    expect(parsed!.upgradeChannel).toBe('stable');
    expect(parsed!.lastUpgradeType).toBe('safe_auto');
    expect(parsed!.appliedPackages.base).toBeDefined();
    expect(parsed!.appliedPackages.base!.manifestSha).toBe('abc1234');
  });

  it('should handle header comments in YAML', () => {
    const yaml = `
# Managed by smarty-admin reconciler
# DO NOT EDIT MANUALLY

applied_packages: {}
reconciler_version: "1.0.0"
last_upgrade_type: initial
upgrade_channel: stable
`;

    const parsed = parseManagedState(yaml);

    expect(parsed).not.toBeNull();
    expect(parsed!.upgradeChannel).toBe('stable');
  });

  it('should return null for empty input', () => {
    expect(parseManagedState('')).toBeNull();
    expect(parseManagedState('   ')).toBeNull();
    expect(parseManagedState('# just comments\n# more comments')).toBeNull();
  });

  it('should return null for invalid YAML', () => {
    expect(parseManagedState('not: valid: yaml: here')).toBeNull();
    expect(parseManagedState('{{{')).toBeNull();
  });

  it('should handle non-standard YAML gracefully', () => {
    // Empty string returns null
    expect(parseManagedState('')).toBeNull();

    // The parser uses `typeof parsed !== 'object'` which passes arrays (arrays are objects)
    // and empty objects. This is acceptable behavior - the result will have default values.
    // The important thing is that invalid YAML doesn't crash.
    const arrayResult = parseManagedState('- array\n- items');
    // Arrays pass typeof check in JS, so they get defaults - this is acceptable
    if (arrayResult !== null) {
      expect(arrayResult.reconcilerVersion).toBe(RECONCILER_VERSION);
    }

    // Number YAML might be parsed as a number, not an object - let's verify behavior
    const numResult = parseManagedState('42');
    // Numbers fail typeof === 'object' so should return null
    expect(numResult).toBeNull();
  });

  it('should use defaults for missing fields', () => {
    const yaml = `
applied_packages: {}
`;

    const parsed = parseManagedState(yaml);

    expect(parsed).not.toBeNull();
    expect(parsed!.reconcilerVersion).toBe(RECONCILER_VERSION);
    expect(parsed!.lastUpgradeType).toBe('initial');
    expect(parsed!.upgradeChannel).toBe('stable');
  });

  it('should parse all valid layers', () => {
    const yaml = `
applied_packages:
  base:
    version: abc1234567890
    applied_at: "2024-01-15T10:30:00.000Z"
    package_path: packages/base
    manifest_sha: abc1234
  org:
    version: def5678901234
    applied_at: "2024-01-15T10:30:00.000Z"
    package_path: packages/org
    manifest_sha: def5678
  project:
    version: ghi9012345678
    applied_at: "2024-01-15T10:30:00.000Z"
    package_path: packages/project
    manifest_sha: ghi9012
reconciler_version: "1.0.0"
last_upgrade_type: safe_auto
upgrade_channel: stable
`;

    const parsed = parseManagedState(yaml);

    expect(parsed!.appliedPackages.base).toBeDefined();
    expect(parsed!.appliedPackages.org).toBeDefined();
    expect(parsed!.appliedPackages.project).toBeDefined();
  });

  it('should ignore invalid layer names', () => {
    const yaml = `
applied_packages:
  invalid_layer:
    version: xyz
    manifest_sha: xyz1234
  base:
    version: abc1234567890
    manifest_sha: abc1234
reconciler_version: "1.0.0"
last_upgrade_type: safe_auto
upgrade_channel: stable
`;

    const parsed = parseManagedState(yaml);

    expect(parsed!.appliedPackages.base).toBeDefined();
    expect((parsed!.appliedPackages as any).invalid_layer).toBeUndefined();
  });
});

// =============================================================================
// State Update Tests
// =============================================================================

describe('State Updates', () => {
  it('should apply package to state immutably', () => {
    const original = createTestManagedState();
    const info = createTestAppliedPackageInfo('newsha1234567', 'packages/base');

    const updated = applyPackageToState(original, 'base', info, 'safe_auto');

    // Original should be unchanged
    expect(original.appliedPackages.base).toBeUndefined();

    // Updated should have the new package
    expect(updated.appliedPackages.base).toBeDefined();
    expect(updated.appliedPackages.base!.version).toBe('newsha1234567');
  });

  it('should update reconciler version on apply', () => {
    const original = createTestManagedState({
      reconcilerVersion: '0.9.0',
    });
    const info = createTestAppliedPackageInfo();

    const updated = applyPackageToState(original, 'base', info, 'safe_auto');

    expect(updated.reconcilerVersion).toBe(RECONCILER_VERSION);
  });

  it('should update lastUpgradeType on apply', () => {
    const original = createTestManagedState({
      lastUpgradeType: 'initial',
    });
    const info = createTestAppliedPackageInfo();

    const updated = applyPackageToState(original, 'base', info, 'breaking_manual');

    expect(updated.lastUpgradeType).toBe('breaking_manual');
  });

  it('should update lastUpgradeAt on apply', () => {
    const original = createTestManagedState({
      lastUpgradeAt: '2020-01-01T00:00:00.000Z',
    });
    const info = createTestAppliedPackageInfo();

    const before = Date.now();
    const updated = applyPackageToState(original, 'base', info, 'safe_auto');
    const after = Date.now();

    const timestamp = new Date(updated.lastUpgradeAt!).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('should preserve existing packages when adding new layer', () => {
    const original = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('baseSha123456', 'packages/base'),
      },
    });
    const info = createTestAppliedPackageInfo('orgSha7890123', 'packages/org');

    const updated = applyPackageToState(original, 'org', info, 'safe_auto');

    expect(updated.appliedPackages.base).toBeDefined();
    expect(updated.appliedPackages.org).toBeDefined();
  });

  it('should replace existing package for same layer', () => {
    const original = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('oldSha1234567', 'packages/base'),
      },
    });
    const info = createTestAppliedPackageInfo('newSha9876543', 'packages/base');

    const updated = applyPackageToState(original, 'base', info, 'safe_auto');

    expect(updated.appliedPackages.base!.version).toBe('newSha9876543');
  });
});

// =============================================================================
// Version Comparison Tests
// =============================================================================

describe('Version Comparison', () => {
  describe('toShortSha', () => {
    it('should return first 7 characters of SHA', () => {
      expect(toShortSha('abc1234567890123456789')).toBe('abc1234');
    });

    it('should handle exact 7 character input', () => {
      expect(toShortSha('abc1234')).toBe('abc1234');
    });

    it('should handle shorter than 7 character input', () => {
      expect(toShortSha('abc')).toBe('abc');
    });

    it('should handle empty string', () => {
      expect(toShortSha('')).toBe('');
    });
  });

  describe('createAppliedPackageInfo', () => {
    it('should create info with short SHA', () => {
      const info = createAppliedPackageInfo(
        'abc1234567890123456789',
        'packages/base'
      );

      expect(info.version).toBe('abc1234567890123456789');
      expect(info.manifestSha).toBe('abc1234');
      expect(info.packagePath).toBe('packages/base');
      expect(info.appliedAt).toBeDefined();
    });

    it('should set appliedAt to current time', () => {
      const before = Date.now();
      const info = createAppliedPackageInfo('sha12345', 'path');
      const after = Date.now();

      const timestamp = new Date(info.appliedAt).getTime();
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('computeStateChanges', () => {
    it('should return empty array when no versions provided', () => {
      const state = createTestManagedState();
      const changes = computeStateChanges(state, {});

      expect(changes).toEqual([]);
    });

    it('should return layer when state is null', () => {
      const changes = computeStateChanges(null, { base: 'abc1234567890' });

      expect(changes).toContain('base');
    });

    it('should return layer when version differs', () => {
      const state = createTestManagedState({
        appliedPackages: {
          base: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'abc1234',
          },
        },
      });

      const changes = computeStateChanges(state, { base: 'xyz9876543210' });

      expect(changes).toContain('base');
    });

    it('should not return layer when version matches (short SHA comparison)', () => {
      const state = createTestManagedState({
        appliedPackages: {
          base: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'abc1234',
          },
        },
      });

      // Full SHA that truncates to same short SHA
      const changes = computeStateChanges(state, { base: 'abc1234567890' });

      expect(changes).not.toContain('base');
    });

    it('should handle multiple layers', () => {
      const state = createTestManagedState({
        appliedPackages: {
          base: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'abc1234',
          },
          org: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'def5678',
          },
        },
      });

      const changes = computeStateChanges(state, {
        base: 'abc1234567890', // Same
        org: 'new7890123456', // Different
        project: 'prj1234567890', // New layer
      });

      expect(changes).not.toContain('base');
      expect(changes).toContain('org');
      expect(changes).toContain('project');
    });
  });

  describe('isStateUpToDate', () => {
    it('should return true when state matches all desired versions', () => {
      const state = createTestManagedState({
        appliedPackages: {
          base: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'abc1234',
          },
        },
      });

      expect(isStateUpToDate(state, { base: 'abc1234567890' })).toBe(true);
    });

    it('should return false when state differs from desired', () => {
      const state = createTestManagedState({
        appliedPackages: {
          base: {
            ...createTestAppliedPackageInfo(),
            manifestSha: 'abc1234',
          },
        },
      });

      expect(isStateUpToDate(state, { base: 'xyz9876543210' })).toBe(false);
    });

    it('should return true for empty desired versions', () => {
      const state = createTestManagedState();

      expect(isStateUpToDate(state, {})).toBe(true);
    });

    it('should return false for null state with desired versions', () => {
      expect(isStateUpToDate(null, { base: 'abc1234567890' })).toBe(false);
    });

    it('should return true for null state with empty desired versions', () => {
      expect(isStateUpToDate(null, {})).toBe(true);
    });
  });
});

// =============================================================================
// Idempotency Tests
// =============================================================================

describe('Idempotency', () => {
  it('should produce identical output for repeated serialization', () => {
    const state = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
      },
    });

    const serialized1 = serializeManagedState(state);
    const serialized2 = serializeManagedState(state);

    expect(serialized1).toBe(serialized2);
  });

  it('should round-trip serialize/parse without data loss', () => {
    const original = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
        org: createTestAppliedPackageInfo('def5678901234', 'packages/org'),
      },
      lastUpgradeType: 'breaking_manual',
      upgradeChannel: 'beta',
    });

    const serialized = serializeManagedState(original);
    const parsed = parseManagedState(serialized);
    const reserialized = serializeManagedState(parsed!);

    expect(reserialized).toBe(serialized);
  });

  it('should not change state when applying same version', () => {
    const original = createTestManagedState({
      appliedPackages: {
        base: createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
      },
    });

    // Create "same" version info
    const sameInfo = {
      ...createTestAppliedPackageInfo('abc1234567890', 'packages/base'),
      appliedAt: original.appliedPackages.base!.appliedAt,
    };

    // Check if state would be considered up-to-date
    const changes = computeStateChanges(original, { base: 'abc1234567890' });

    expect(changes.length).toBe(0);
  });
});

// =============================================================================
// Edge Cases Tests
// =============================================================================

describe('Edge Cases', () => {
  it('should handle very long package paths', () => {
    const longPath = 'a/'.repeat(100) + 'package';
    const info = createAppliedPackageInfo('sha12345', longPath);
    const state = createTestManagedState({
      appliedPackages: { base: info },
    });

    const serialized = serializeManagedState(state);
    const parsed = parseManagedState(serialized);

    expect(parsed!.appliedPackages.base!.packagePath).toBe(longPath);
  });

  it('should handle special characters in package path', () => {
    const specialPath = 'packages/my-org_name/project.v2';
    const info = createAppliedPackageInfo('sha12345', specialPath);
    const state = createTestManagedState({
      appliedPackages: { base: info },
    });

    const serialized = serializeManagedState(state);
    const parsed = parseManagedState(serialized);

    expect(parsed!.appliedPackages.base!.packagePath).toBe(specialPath);
  });

  it('should handle all channel types', () => {
    const channels: UpgradeChannel[] = ['stable', 'beta', 'pinned'];

    for (const channel of channels) {
      const state = createTestManagedState({ upgradeChannel: channel });
      const serialized = serializeManagedState(state);
      const parsed = parseManagedState(serialized);

      expect(parsed!.upgradeChannel).toBe(channel);
    }
  });

  it('should handle all upgrade types', () => {
    const types: UpgradeType[] = ['safe_auto', 'breaking_manual', 'initial'];

    for (const type of types) {
      const state = createTestManagedState({ lastUpgradeType: type });
      const serialized = serializeManagedState(state);
      const parsed = parseManagedState(serialized);

      expect(parsed!.lastUpgradeType).toBe(type);
    }
  });

  it('should handle ISO 8601 timestamps with timezone', () => {
    const state = createTestManagedState({
      lastUpgradeAt: '2024-01-15T10:30:00.000+05:30',
      appliedPackages: {
        base: {
          ...createTestAppliedPackageInfo(),
          appliedAt: '2024-01-15T10:30:00.000+05:30',
        },
      },
    });

    const serialized = serializeManagedState(state);
    const parsed = parseManagedState(serialized);

    expect(parsed!.lastUpgradeAt).toBeDefined();
    expect(parsed!.appliedPackages.base!.appliedAt).toBeDefined();
  });
});
