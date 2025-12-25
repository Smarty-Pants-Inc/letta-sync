/**
 * Manifest discovery utilities
 * 
 * Provides generic manifest location discovery that:
 * 1. Finds repo root by walking up until .letta/ or .git/ exists
 * 2. Prefers <repoRoot>/.letta/manifests if it exists
 * 3. Falls back to legacy <repoRoot>/packages/examples with deprecation warning
 * 4. Returns clear error if neither exists
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { loadPackage, type PackageLoadOptions } from './packages/loader.js';
import { mergePackages, type MergeOptions } from './packages/merge.js';
import type { Package, DesiredState } from './packages/types.js';

// =============================================================================
// Types
// =============================================================================

export interface RepoRoot {
  /** Absolute path to the repo root */
  path: string;
  /** How the repo root was detected */
  detectedBy: '.letta' | '.git';
}

export interface ManifestLocation {
  /** Absolute path to the manifest directory */
  path: string;
  /** Whether this is the new .letta/manifests location or legacy packages/examples */
  type: 'letta-manifests' | 'legacy-packages-examples';
  /** Repo root information */
  repoRoot: RepoRoot;
}

export interface DiscoverResult {
  /** The discovered manifest location */
  location: ManifestLocation;
  /** Deprecation warning (if using legacy path) */
  deprecationWarning?: string;
}

export interface LoadedManifests {
  /** Packages loaded from each layer */
  packages: {
    base?: Package;
    org?: Package;
    project?: Package;
  };
  /** Merged desired state */
  desiredState: DesiredState;
  /** Warnings from loading/merging */
  warnings: string[];
  /** Discovery result */
  discovery: DiscoverResult;
}

// =============================================================================
// Constants
// =============================================================================

/** New preferred manifest location relative to repo root */
const LETTA_MANIFESTS_DIR = '.letta/manifests';

/** Legacy manifest location relative to repo root */
const LEGACY_PACKAGES_DIR = 'packages/examples';

/** Default layer subdirectories */
const DEFAULT_LAYER_DIRS = {
  base: 'base',
  org: 'org',
  project: 'project',
};

/** Legacy layer subdirectories (packages/examples naming) */
const LEGACY_LAYER_DIRS = {
  base: 'base',
  org: 'org-smarty-pants',
  project: 'project-smarty-dev',
};

// =============================================================================
// Repo Root Discovery
// =============================================================================

/**
 * Find the repository root by walking up from startDir
 * 
 * Looks for directories containing .letta/ or .git/
 * Prefers .letta/ if both exist at the same level
 * 
 * @param startDir - Directory to start searching from
 * @returns RepoRoot if found, null otherwise
 */
export function findRepoRoot(startDir: string): RepoRoot | null {
  let current = startDir;
  const root = parse(current).root;

  while (true) {
    // Check for .letta directory (preferred)
    const lettaDir = join(current, '.letta');
    if (existsSync(lettaDir)) {
      return { path: current, detectedBy: '.letta' };
    }

    // Check for .git directory (fallback)
    const gitDir = join(current, '.git');
    if (existsSync(gitDir)) {
      return { path: current, detectedBy: '.git' };
    }

    // Stop at filesystem root
    if (current === root) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

// =============================================================================
// Manifest Discovery
// =============================================================================

/**
 * Discover manifest location based on repo structure
 * 
 * Priority:
 * 1. <repoRoot>/.letta/manifests - preferred, new location
 * 2. <repoRoot>/packages/examples - legacy, deprecated with warning
 * 3. Error if neither exists
 * 
 * @param startDir - Directory to start searching from (defaults to cwd)
 * @returns DiscoverResult with manifest location and any warnings
 * @throws Error if no manifest location can be found
 */
export function discoverManifests(startDir: string = process.cwd()): DiscoverResult {
  // Find repo root
  const repoRoot = findRepoRoot(startDir);
  
  if (!repoRoot) {
    throw new Error(
      'Could not find repository root. ' +
      'Make sure you are inside a git repository or a directory with .letta/ folder.'
    );
  }

  // Check for new .letta/manifests location
  const lettaManifestsPath = join(repoRoot.path, LETTA_MANIFESTS_DIR);
  if (existsSync(lettaManifestsPath)) {
    return {
      location: {
        path: lettaManifestsPath,
        type: 'letta-manifests',
        repoRoot,
      },
    };
  }

  // Check for legacy packages/examples location
  const legacyPackagesPath = join(repoRoot.path, LEGACY_PACKAGES_DIR);
  if (existsSync(legacyPackagesPath)) {
    return {
      location: {
        path: legacyPackagesPath,
        type: 'legacy-packages-examples',
        repoRoot,
      },
      deprecationWarning:
        `Using deprecated manifest location: ${LEGACY_PACKAGES_DIR}. ` +
        `Please migrate your manifests to ${LETTA_MANIFESTS_DIR} for future compatibility.`,
    };
  }

  // No manifest location found
  throw new Error(
    `No manifest directory found. Please create one of:\n` +
    `  - ${join(repoRoot.path, LETTA_MANIFESTS_DIR)} (preferred)\n` +
    `  - ${join(repoRoot.path, LEGACY_PACKAGES_DIR)} (legacy)\n\n` +
    `To set up manifests, create ${LETTA_MANIFESTS_DIR}/ with subdirectories:\n` +
    `  - base/    - Base layer manifests (safety policies, coding standards)\n` +
    `  - org/     - Organization layer manifests\n` +
    `  - project/ - Project-specific manifests`
  );
}

// =============================================================================
// Manifest Loading
// =============================================================================

/**
 * Resolve layer directory paths based on manifest location type
 */
function resolveLayerPaths(location: ManifestLocation): {
  base?: string;
  org?: string;
  project?: string;
} {
  const layerDirs = location.type === 'letta-manifests'
    ? DEFAULT_LAYER_DIRS
    : LEGACY_LAYER_DIRS;

  const result: { base?: string; org?: string; project?: string } = {};

  // Check each layer directory
  const basePath = join(location.path, layerDirs.base);
  if (existsSync(basePath)) {
    result.base = basePath;
  }

  const orgPath = join(location.path, layerDirs.org);
  if (existsSync(orgPath)) {
    result.org = orgPath;
  }

  const projectPath = join(location.path, layerDirs.project);
  if (existsSync(projectPath)) {
    result.project = projectPath;
  }

  return result;
}

/**
 * Load and merge manifests from discovered location
 * 
 * Uses the existing loadPackage() and mergePackages() infrastructure
 * to load all YAML/JSON manifests and merge them by layer precedence.
 * 
 * @param startDir - Directory to start discovery from (defaults to cwd)
 * @param options - Optional loading and merge options
 * @returns LoadedManifests with packages, desired state, and warnings
 */
export async function loadManifests(
  startDir: string = process.cwd(),
  options: {
    loadOptions?: PackageLoadOptions;
    mergeOptions?: MergeOptions;
  } = {}
): Promise<LoadedManifests> {
  const { loadOptions = { validate: true }, mergeOptions = {} } = options;
  const warnings: string[] = [];

  // Discover manifest location
  const discovery = discoverManifests(startDir);
  
  if (discovery.deprecationWarning) {
    warnings.push(discovery.deprecationWarning);
  }

  // Resolve layer paths
  const layerPaths = resolveLayerPaths(discovery.location);

  // Load packages from each layer
  const packages: { base?: Package; org?: Package; project?: Package } = {};

  if (layerPaths.base) {
    try {
      packages.base = await loadPackage(layerPaths.base, {
        ...loadOptions,
        defaultLayer: 'base',
      });
    } catch (err) {
      // Non-fatal: base layer is optional
      warnings.push(`Could not load base layer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (layerPaths.org) {
    try {
      packages.org = await loadPackage(layerPaths.org, {
        ...loadOptions,
        defaultLayer: 'org',
      });
    } catch (err) {
      warnings.push(`Could not load org layer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (layerPaths.project) {
    try {
      packages.project = await loadPackage(layerPaths.project, {
        ...loadOptions,
        defaultLayer: 'project',
      });
    } catch (err) {
      warnings.push(`Could not load project layer: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Merge packages to get desired state
  const mergeResult = mergePackages(packages, mergeOptions);
  warnings.push(...mergeResult.warnings);

  return {
    packages,
    desiredState: mergeResult.desiredState,
    warnings,
    discovery,
  };
}

// =============================================================================
// Exports
// =============================================================================

export { DEFAULT_LAYER_DIRS, LEGACY_LAYER_DIRS, LETTA_MANIFESTS_DIR, LEGACY_PACKAGES_DIR };
