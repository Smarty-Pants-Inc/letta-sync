/**
 * Applied state management for agents
 *
 * Manages the `managed_state` block that tracks what package versions
 * have been applied to an agent. This provides an auditable record of
 * reconciler operations and enables idempotent upgrades.
 *
 * @see docs/specs/naming-conventions.md §4 Applied-Version Tracking
 * @see docs/specs/blocks-metadata-strategy.md
 */

import * as yaml from 'yaml';

/**
 * Layers that can have applied packages
 */
export type PackageLayer = 'base' | 'org' | 'project';

/**
 * Upgrade type indicating how the upgrade was applied
 */
export type UpgradeType = 'safe_auto' | 'breaking_manual' | 'initial';

/**
 * Upgrade channel for the agent
 */
export type UpgradeChannel = 'stable' | 'beta' | 'pinned';

/**
 * Applied package version information for a single layer
 */
export interface AppliedPackageInfo {
  /** Full Git SHA of the applied package */
  version: string;
  /** ISO 8601 timestamp when this version was applied */
  appliedAt: string;
  /** Path to the package in the Git repository */
  packagePath: string;
  /** Short SHA (7 chars) for tag format */
  manifestSha: string;
}

/**
 * Full managed state stored in the managed_state block
 */
export interface ManagedState {
  /** Applied package versions by layer */
  appliedPackages: Partial<Record<PackageLayer, AppliedPackageInfo>>;
  /** Version of the reconciler that last modified this state */
  reconcilerVersion: string;
  /** Type of the last upgrade operation */
  lastUpgradeType: UpgradeType;
  /** Channel the agent is subscribed to */
  upgradeChannel: UpgradeChannel;
  /** ISO 8601 timestamp of last upgrade */
  lastUpgradeAt?: string;
}

/**
 * Block metadata for managed_state block per spec
 */
export const MANAGED_STATE_BLOCK_METADATA = {
  managed_by: 'smarty-admin',
  layer: 'lane',
  description: 'Reconciler applied-version state',
} as const;

/**
 * Label for the managed state block
 */
export const MANAGED_STATE_LABEL = 'managed_state';

/**
 * Current reconciler version
 */
export const RECONCILER_VERSION = '1.0.0';

/**
 * Default character limit for managed_state block
 */
export const MANAGED_STATE_LIMIT = 3000;

/**
 * Create a new empty managed state
 */
export function createInitialState(channel: UpgradeChannel = 'stable'): ManagedState {
  return {
    appliedPackages: {},
    reconcilerVersion: RECONCILER_VERSION,
    lastUpgradeType: 'initial',
    upgradeChannel: channel,
    lastUpgradeAt: new Date().toISOString(),
  };
}

/**
 * Serialize managed state to YAML for storage in block value
 *
 * Format follows the spec from naming-conventions.md §4.1.B
 */
export function serializeManagedState(state: ManagedState): string {
  const header = `# Managed by smarty-admin reconciler
# DO NOT EDIT MANUALLY

`;

  const yamlContent: Record<string, unknown> = {
    applied_packages: {},
    reconciler_version: state.reconcilerVersion,
    last_upgrade_type: state.lastUpgradeType,
    upgrade_channel: state.upgradeChannel,
  };

  if (state.lastUpgradeAt) {
    yamlContent.last_upgrade_at = state.lastUpgradeAt;
  }

  // Convert applied packages to snake_case for YAML
  for (const [layer, info] of Object.entries(state.appliedPackages)) {
    if (info) {
      (yamlContent.applied_packages as Record<string, unknown>)[layer] = {
        version: info.version,
        applied_at: info.appliedAt,
        package_path: info.packagePath,
        manifest_sha: info.manifestSha,
      };
    }
  }

  return header + yaml.stringify(yamlContent, { indent: 2 });
}

/**
 * Parse managed state from YAML block value
 */
export function parseManagedState(blockValue: string): ManagedState | null {
  try {
    // Strip header comments
    const yamlContent = blockValue
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
      .trim();

    if (!yamlContent) {
      return null;
    }

    const parsed = yaml.parse(yamlContent);

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const state: ManagedState = {
      appliedPackages: {},
      reconcilerVersion: parsed.reconciler_version ?? RECONCILER_VERSION,
      lastUpgradeType: parsed.last_upgrade_type ?? 'initial',
      upgradeChannel: parsed.upgrade_channel ?? 'stable',
      lastUpgradeAt: parsed.last_upgrade_at,
    };

    // Parse applied packages
    if (parsed.applied_packages && typeof parsed.applied_packages === 'object') {
      for (const [layer, info] of Object.entries(parsed.applied_packages)) {
        if (isValidLayer(layer) && info && typeof info === 'object') {
          const pkgInfo = info as Record<string, unknown>;
          state.appliedPackages[layer] = {
            version: String(pkgInfo.version ?? ''),
            appliedAt: String(pkgInfo.applied_at ?? ''),
            packagePath: String(pkgInfo.package_path ?? ''),
            manifestSha: String(pkgInfo.manifest_sha ?? ''),
          };
        }
      }
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Update managed state with a new applied package
 */
export function applyPackageToState(
  state: ManagedState,
  layer: PackageLayer,
  info: AppliedPackageInfo,
  upgradeType: UpgradeType = 'safe_auto'
): ManagedState {
  return {
    ...state,
    appliedPackages: {
      ...state.appliedPackages,
      [layer]: info,
    },
    reconcilerVersion: RECONCILER_VERSION,
    lastUpgradeType: upgradeType,
    lastUpgradeAt: new Date().toISOString(),
  };
}

/**
 * Check if a layer is valid
 */
function isValidLayer(layer: string): layer is PackageLayer {
  return ['base', 'org', 'project'].includes(layer);
}

/**
 * Get the short SHA (7 characters) from a full SHA
 */
export function toShortSha(fullSha: string): string {
  return fullSha.slice(0, 7);
}

/**
 * Create AppliedPackageInfo from package metadata
 */
export function createAppliedPackageInfo(
  fullSha: string,
  packagePath: string
): AppliedPackageInfo {
  return {
    version: fullSha,
    appliedAt: new Date().toISOString(),
    packagePath,
    manifestSha: toShortSha(fullSha),
  };
}

/**
 * Compare two managed states and determine what packages need updates
 */
export function computeStateChanges(
  currentState: ManagedState | null,
  desiredVersions: Partial<Record<PackageLayer, string>>
): PackageLayer[] {
  const changes: PackageLayer[] = [];

  for (const layer of ['base', 'org', 'project'] as PackageLayer[]) {
    const desiredSha = desiredVersions[layer];
    if (!desiredSha) continue;

    const currentSha = currentState?.appliedPackages[layer]?.manifestSha;

    // Need update if no current version or different version
    if (!currentSha || currentSha !== toShortSha(desiredSha)) {
      changes.push(layer);
    }
  }

  return changes;
}

/**
 * Check if an agent is up to date with desired versions
 */
export function isStateUpToDate(
  state: ManagedState | null,
  desiredVersions: Partial<Record<PackageLayer, string>>
): boolean {
  return computeStateChanges(state, desiredVersions).length === 0;
}
