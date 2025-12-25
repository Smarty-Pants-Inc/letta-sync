/**
 * Project resolver - Resolves the current Letta project from working directory
 *
 * Resolution priority:
 * 1. Explicit --project flag
 * 2. SMARTY_PROJECT environment variable (handled by CLI)
 * 3. Auto-detect from git repository via registry lookup
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RepoNotRegisteredError,
  AmbiguousProjectError,
  RegistryReadError,
  formatError,
} from './errors.js';
import {
  getGitRepoInfo,
  normalizeRemoteUrl,
  type GitRepoInfo,
} from './git.js';

/**
 * Registry entry mapping a repository to a Letta project
 */
export interface RegistryEntry {
  /** Letta project slug */
  projectSlug: string;
  /** Organization slug */
  orgSlug?: string;
  /** Absolute path to the repository (primary identifier) */
  repoPath?: string;
  /** Normalized remote URL (secondary identifier) */
  remoteUrl?: string;
  /** Optional description */
  description?: string;
  /** When this entry was last updated */
  updatedAt?: string;
}

/**
 * Project registry schema
 */
export interface ProjectRegistry {
  version: string;
  entries: RegistryEntry[];
}

/**
 * Resolved project information
 */
export interface ResolvedProject {
  /** Letta project slug */
  projectSlug: string;
  /** Organization slug if set */
  orgSlug?: string;
  /** Git repository information */
  gitInfo: GitRepoInfo;
  /** How the project was resolved */
  source: 'explicit' | 'registry-path' | 'registry-remote';
}

/**
 * Options for project resolution
 */
export interface ResolveOptions {
  /** Explicit project slug (from --project flag) */
  explicitProject?: string;
  /** Explicit org slug (from --org flag) */
  explicitOrg?: string;
  /** Custom registry path (defaults to ~/.config/smarty-admin/registry.json) */
  registryPath?: string;
  /** Working directory to resolve from (defaults to cwd) */
  cwd?: string;
  /** Verbose logging callback */
  verbose?: (msg: string) => void;
}

/**
 * Get the default registry path
 */
export function getDefaultRegistryPath(): string {
  const configDir =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configDir, 'smarty-admin', 'registry.json');
}

/**
 * Load the project registry from disk
 *
 * @param registryPath - Path to the registry file
 * @returns Parsed registry or empty registry if file doesn't exist
 * @throws RegistryReadError if file exists but cannot be parsed
 */
export function loadRegistry(registryPath: string): ProjectRegistry {
  if (!existsSync(registryPath)) {
    return { version: '1', entries: [] };
  }

  try {
    const content = readFileSync(registryPath, 'utf-8');
    const parsed = JSON.parse(content) as ProjectRegistry;

    // Validate basic structure
    if (!parsed.entries || !Array.isArray(parsed.entries)) {
      throw new Error('Invalid registry format: missing entries array');
    }

    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RegistryReadError(
        registryPath,
        new Error('Invalid JSON')
      );
    }
    if (error instanceof RegistryReadError) {
      throw error;
    }
    throw new RegistryReadError(
      registryPath,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Find registry entries matching a repository by path
 */
function findEntriesByPath(
  registry: ProjectRegistry,
  repoPath: string
): RegistryEntry[] {
  const normalizedPath = resolve(repoPath);
  return registry.entries.filter((entry) => {
    if (!entry.repoPath) return false;
    return resolve(entry.repoPath) === normalizedPath;
  });
}

/**
 * Find registry entries matching a repository by remote URL
 */
function findEntriesByRemote(
  registry: ProjectRegistry,
  remoteUrl: string
): RegistryEntry[] {
  const normalizedUrl = normalizeRemoteUrl(remoteUrl);
  return registry.entries.filter((entry) => {
    if (!entry.remoteUrl) return false;
    return normalizeRemoteUrl(entry.remoteUrl) === normalizedUrl;
  });
}

/**
 * Resolve the Letta project for the current working directory
 *
 * Resolution algorithm:
 * 1. If explicit project provided, use it directly
 * 2. Detect git repository from cwd
 * 3. Look up repo path in registry (exact match)
 * 4. If no path match and remote exists, look up by remote URL
 * 5. Handle multiple matches by throwing AmbiguousProjectError
 *
 * @param options - Resolution options
 * @returns ResolvedProject with project information
 * @throws NotInGitRepoError if not in a git repository (unless explicit project)
 * @throws RepoNotRegisteredError if repository not in registry
 * @throws AmbiguousProjectError if multiple projects match
 */
export function resolveProject(options: ResolveOptions = {}): ResolvedProject {
  const {
    explicitProject,
    explicitOrg,
    registryPath = getDefaultRegistryPath(),
    cwd,
    verbose = () => {},
  } = options;

  // Get git info first (we need it even for explicit projects for context)
  const gitInfo = getGitRepoInfo(cwd);
  verbose(`Git repository root: ${gitInfo.root}`);
  verbose(`Main repo path: ${gitInfo.mainRepoPath}`);
  if (gitInfo.isWorktree) {
    verbose(`Detected worktree`);
  }
  if (gitInfo.remoteUrl) {
    verbose(`Remote URL: ${gitInfo.remoteUrl}`);
  }

  // If explicit project provided, use it directly
  if (explicitProject) {
    verbose(`Using explicit project: ${explicitProject}`);
    return {
      projectSlug: explicitProject,
      orgSlug: explicitOrg,
      gitInfo,
      source: 'explicit',
    };
  }

  // Load registry
  verbose(`Loading registry from: ${registryPath}`);
  const registry = loadRegistry(registryPath);
  verbose(`Registry loaded: ${registry.entries.length} entries`);

  // Try to match by path first (most specific)
  let matches = findEntriesByPath(registry, gitInfo.mainRepoPath);
  let source: ResolvedProject['source'] = 'registry-path';

  // If no path match, try remote URL
  if (matches.length === 0 && gitInfo.remoteUrl) {
    verbose(
      `No path match, trying remote URL: ${gitInfo.remoteUrl}`
    );
    matches = findEntriesByRemote(registry, gitInfo.remoteUrl);
    source = 'registry-remote';
  }

  // No matches found
  if (matches.length === 0) {
    throw new RepoNotRegisteredError(
      gitInfo.mainRepoPath,
      gitInfo.remoteUrl
    );
  }

  // Multiple matches - ambiguous
  if (matches.length > 1) {
    const projectSlugs = matches.map((e) => e.projectSlug);
    throw new AmbiguousProjectError(gitInfo.mainRepoPath, projectSlugs);
  }

  // Single match - success!
  const entry = matches[0];
  verbose(`Resolved project: ${entry.projectSlug} via ${source}`);

  return {
    projectSlug: entry.projectSlug,
    orgSlug: entry.orgSlug ?? explicitOrg,
    gitInfo,
    source,
  };
}

/**
 * Attempt to resolve project, returning null on failure instead of throwing
 *
 * @param options - Resolution options
 * @returns ResolvedProject or null with error message
 */
export function tryResolveProject(
  options: ResolveOptions = {}
): { project: ResolvedProject; error: null } | { project: null; error: string } {
  try {
    const project = resolveProject(options);
    return { project, error: null };
  } catch (error) {
    return { project: null, error: formatError(error) };
  }
}

/**
 * Create a registry entry for a repository
 * Helper for `smarty-admin register` command
 */
export function createRegistryEntry(
  projectSlug: string,
  repoPath: string,
  options: {
    orgSlug?: string;
    remoteUrl?: string;
    description?: string;
  } = {}
): RegistryEntry {
  return {
    projectSlug,
    orgSlug: options.orgSlug,
    repoPath: resolve(repoPath),
    remoteUrl: options.remoteUrl,
    description: options.description,
    updatedAt: new Date().toISOString(),
  };
}
