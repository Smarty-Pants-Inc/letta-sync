/**
 * Project targeting and resolution for Letta API calls
 * 
 * Supports resolving projects from:
 * - CLI flag (--project)
 * - Environment variable (LETTA_SYNC_PROJECT, LETTA_PROJECT, or SMARTY_PROJECT for backwards compat)
 * - Project registry (repo → project mapping)
 * - Local configuration (.letta/project.json)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { 
  ProjectConfig, 
  ResolvedProject, 
  ProjectRegistry,
  ProjectResolutionSource 
} from '../types.js';

/** Default registry file location (primary) */
const DEFAULT_REGISTRY_PATH = '.letta/registry.json';

/** Legacy registry file location (backwards compat) */
const LEGACY_REGISTRY_PATH = '.smarty/registry.json';

/** Local project config file (primary) */
const LOCAL_PROJECT_CONFIG = '.letta/project.json';

/** Legacy local project config file (backwards compat) */
const LEGACY_LOCAL_PROJECT_CONFIG = '.smarty/project.json';

/** Environment variable names (in priority order) */
const ENV_LETTA_SYNC_PROJECT = 'LETTA_SYNC_PROJECT';
const ENV_LETTA_PROJECT = 'LETTA_PROJECT';
/** Legacy env var for backwards compatibility */
const ENV_SMARTY_PROJECT = 'SMARTY_PROJECT';

/**
 * Resolution priority order (highest to lowest):
 * 1. CLI flag (--project)
 * 2. Environment variable (LETTA_SYNC_PROJECT, LETTA_PROJECT, or SMARTY_PROJECT for backwards compat)
 * 3. Local config file (.letta/project.json, fallback to .smarty/project.json for backwards compat)
 * 4. Registry lookup by repo/workspace (.letta/registry.json, fallback to .smarty/registry.json)
 * 5. Default project (if configured)
 */
export type ResolutionPriority = 
  | 'cli'
  | 'env'
  | 'local_config'
  | 'registry'
  | 'default';

/**
 * Result of project resolution
 */
export interface ProjectResolutionResult {
  /** The resolved project configuration */
  project: ResolvedProject | null;
  /** How the project was resolved */
  source: ProjectResolutionSource | null;
  /** Resolution chain attempted (for debugging) */
  attempted: ResolutionPriority[];
  /** Error if resolution failed */
  error?: string;
}

/**
 * Options for project resolution
 */
export interface ProjectResolveOptions {
  /** CLI-provided project slug or ID */
  cliProject?: string;
  /** Working directory for local config lookup */
  cwd?: string;
  /** Custom registry path */
  registryPath?: string;
  /** Repo identifier for registry lookup */
  repoIdentifier?: string;
  /** Enable verbose resolution logging */
  verbose?: boolean;
}

/**
 * Resolve project targeting from multiple sources
 * 
 * @param options Resolution options
 * @returns Resolution result with project and source info
 */
export function resolveProject(options: ProjectResolveOptions = {}): ProjectResolutionResult {
  const attempted: ResolutionPriority[] = [];
  const cwd = options.cwd ?? process.cwd();

  // 1. CLI flag takes highest priority
  attempted.push('cli');
  if (options.cliProject) {
    const project = parseProjectIdentifier(options.cliProject);
    return {
      project,
      source: 'cli',
      attempted,
    };
  }

  // 2. Environment variables (in priority order: LETTA_SYNC_PROJECT > LETTA_PROJECT > SMARTY_PROJECT)
  attempted.push('env');
  const envProject = process.env[ENV_LETTA_SYNC_PROJECT] 
    ?? process.env[ENV_LETTA_PROJECT] 
    ?? process.env[ENV_SMARTY_PROJECT];
  if (envProject) {
    const project = parseProjectIdentifier(envProject);
    return {
      project,
      source: 'env',
      attempted,
    };
  }

  // 3. Local project config
  attempted.push('local_config');
  const localConfig = loadLocalProjectConfig(cwd);
  if (localConfig) {
    return {
      project: {
        id: localConfig.id,
        slug: localConfig.slug,
        name: localConfig.name,
      },
      source: 'local_config',
      attempted,
    };
  }

  // 4. Registry lookup
  attempted.push('registry');
  const registryPath = options.registryPath ?? findRegistryPath(cwd);
  if (registryPath) {
    const registry = loadRegistry(registryPath);
    if (registry) {
      const repoId = options.repoIdentifier ?? detectRepoIdentifier(cwd);
      const mapping = registry.mappings[repoId];
      if (mapping) {
        return {
          project: {
            id: mapping.projectId,
            slug: mapping.projectSlug,
            name: mapping.projectName,
          },
          source: 'registry',
          attempted,
        };
      }
    }
  }

  // 5. Default project (from registry)
  attempted.push('default');
  if (registryPath) {
    const registry = loadRegistry(registryPath);
    if (registry?.defaultProject) {
      return {
        project: {
          id: registry.defaultProject.id,
          slug: registry.defaultProject.slug,
          name: registry.defaultProject.name,
        },
        source: 'default',
        attempted,
      };
    }
  }

  // No project could be resolved
  return {
    project: null,
    source: null,
    attempted,
    error: 'No project configured. Use --project flag, set LETTA_SYNC_PROJECT env var, or create .letta/project.json',
  };
}

/**
 * Parse a project identifier (slug or ID format)
 * 
 * Supports:
 * - Slug format: "my-project"
 * - ID format: "proj_abc123"
 * - Combined format: "my-project:proj_abc123"
 */
export function parseProjectIdentifier(identifier: string): ResolvedProject {
  // Check for combined format (slug:id)
  if (identifier.includes(':')) {
    const [slug, id] = identifier.split(':', 2);
    return { slug, id };
  }

  // Check if it looks like an ID.
  // Letta Cloud project IDs may be UUIDs, or prefixed IDs like `project-...`.
  if (identifier.startsWith('proj_') || identifier.startsWith('project-') || isUUID(identifier)) {
    return { id: identifier };
  }

  // Treat as slug
  return { slug: identifier };
}

/**
 * Check if a string looks like a UUID
 */
function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Generate HTTP headers for project targeting
 */
export function getProjectHeaders(project: ResolvedProject): Record<string, string> {
  const headers: Record<string, string> = {};

  // Use ID if available, otherwise slug
  if (project.id) {
    headers['X-Project'] = project.id;
  } else if (project.slug) {
    headers['X-Project'] = project.slug;
  }

  return headers;
}

/**
 * Create a validated project config for API calls
 * Throws if no project is configured and required
 */
export function requireProject(options: ProjectResolveOptions = {}): ResolvedProject {
  const result = resolveProject(options);
  
  if (!result.project) {
    throw new ProjectResolutionError(
      result.error ?? 'Project resolution failed',
      result.attempted
    );
  }

  return result.project;
}

/**
 * Load local project configuration from .letta/project.json (or .smarty/project.json for backwards compat)
 */
function loadLocalProjectConfig(cwd: string): ProjectConfig | null {
  // Try primary path first
  let configPath = resolve(cwd, LOCAL_PROJECT_CONFIG);
  
  if (!existsSync(configPath)) {
    // Try legacy path for backwards compatibility
    configPath = resolve(cwd, LEGACY_LOCAL_PROJECT_CONFIG);
    if (!existsSync(configPath)) {
      return null;
    }
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as ProjectConfig;
    
    // Validate required fields
    if (!config.slug && !config.id) {
      return null;
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Find registry file by walking up directory tree
 * Checks .letta/registry.json first, then .smarty/registry.json for backwards compat
 */
function findRegistryPath(startDir: string): string | null {
  let currentDir = startDir;
  const root = resolve('/');

  while (currentDir !== root) {
    // Check primary path first
    const registryPath = resolve(currentDir, DEFAULT_REGISTRY_PATH);
    if (existsSync(registryPath)) {
      return registryPath;
    }
    // Check legacy path for backwards compatibility
    const legacyPath = resolve(currentDir, LEGACY_REGISTRY_PATH);
    if (existsSync(legacyPath)) {
      return legacyPath;
    }
    currentDir = dirname(currentDir);
  }

  return null;
}

/**
 * Load project registry from file
 */
function loadRegistry(registryPath: string): ProjectRegistry | null {
  try {
    const content = readFileSync(registryPath, 'utf-8');
    return JSON.parse(content) as ProjectRegistry;
  } catch {
    return null;
  }
}

/**
 * Detect repository identifier from current directory
 * Uses git remote URL if available
 */
function detectRepoIdentifier(cwd: string): string {
  // Try to get git remote origin
  try {
    const { execSync } = require('node:child_process');
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    // Parse GitHub/GitLab style URLs
    // git@github.com:org/repo.git -> org/repo
    // https://github.com/org/repo.git -> org/repo
    const match = remoteUrl.match(/[:/]([^/:]+\/[^/.]+)(?:\.git)?$/);
    if (match) {
      return match[1];
    }

    return remoteUrl;
  } catch {
    // Fall back to directory name
    return resolve(cwd).split('/').pop() ?? 'unknown';
  }
}

/**
 * Custom error for project resolution failures
 */
export class ProjectResolutionError extends Error {
  constructor(
    message: string,
    public readonly attemptedSources: ResolutionPriority[]
  ) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

/**
 * Create initial project configuration file
 */
export function createProjectConfig(
  projectSlug: string,
  options: { id?: string; name?: string; cwd?: string } = {}
): string {
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolve(cwd, LOCAL_PROJECT_CONFIG);

  const config: ProjectConfig = {
    slug: projectSlug,
    ...(options.id && { id: options.id }),
    ...(options.name && { name: options.name }),
  };

  return JSON.stringify(config, null, 2);
}

/**
 * Format project for display
 */
export function formatProject(project: ResolvedProject): string {
  if (project.name) {
    return `${project.name} (${project.slug ?? project.id})`;
  }
  return project.slug ?? project.id ?? 'unknown';
}

/**
 * Validate a project exists (placeholder for API validation)
 */
export async function validateProject(
  _project: ResolvedProject,
  _apiKey?: string
): Promise<boolean> {
  // TODO: Implement actual API validation
  // Will call Letta API to verify project exists and user has access
  return true;
}
