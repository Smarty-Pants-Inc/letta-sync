/**
 * Registry YAML loading utilities
 * 
 * Handles loading and validating the registry.yaml file that maps
 * organizations and projects to their package paths.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  Registry,
  OrgConfig,
  ProjectConfig,
  RegistryResolution,
  RegistryLoadOptions,
  ResolvedPackagePaths,
} from './types.js';
import { RegistryError } from './types.js';
import { validateRegistryRules, type RegistryValidationOptions } from './validator.js';
import { RegistryValidationError } from './errors.js';

/** Current supported API version for registry files */
const SUPPORTED_API_VERSION = 'smarty.dev/v1';

/**
 * Load and parse a registry.yaml file
 * 
 * @param registryPath - Path to the registry.yaml file
 * @param options - Loading options
 * @returns Parsed registry configuration
 * @throws RegistryError if loading or parsing fails
 */
export async function loadRegistry(
  registryPath: string,
  options: RegistryLoadOptions = {}
): Promise<Registry> {
  const { validate = true, basePath } = options;
  const absolutePath = isAbsolute(registryPath) 
    ? registryPath 
    : resolve(basePath ?? process.cwd(), registryPath);

  // Check file exists
  if (!existsSync(absolutePath)) {
    throw new RegistryError(
      `Registry file not found: ${absolutePath}`,
      'REGISTRY_NOT_FOUND',
      { path: absolutePath }
    );
  }

  // Read and parse YAML
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch (err) {
    throw new RegistryError(
      `Failed to read registry file: ${err instanceof Error ? err.message : String(err)}`,
      'REGISTRY_NOT_FOUND',
      { path: absolutePath, originalError: err }
    );
  }

  let registry: Registry;
  try {
    registry = parseYaml(content) as Registry;
  } catch (err) {
    throw new RegistryError(
      `Failed to parse registry YAML: ${err instanceof Error ? err.message : String(err)}`,
      'REGISTRY_PARSE_ERROR',
      { path: absolutePath, originalError: err }
    );
  }

  // Validate if requested
  if (validate) {
    validateRegistry(registry, absolutePath, {
      checkPackagesExist: options.checkPackagesExist ?? true,
      checkCycles: options.checkCycles ?? true,
    });
  }

  return registry;
}

/**
 * Validate a parsed registry structure
 * 
 * Performs two levels of validation:
 * 1. Basic structural validation (required fields, API version)
 * 2. Semantic validation (unique slugs, valid package paths, no cycles)
 * 
 * @param registry - The registry to validate
 * @param sourcePath - Path for error messages
 * @param options - Additional validation options
 * @throws RegistryError if structural validation fails
 * @throws RegistryValidationError if semantic validation fails
 */
export function validateRegistry(
  registry: Registry,
  sourcePath?: string,
  options: {
    checkPackagesExist?: boolean;
    checkCycles?: boolean;
  } = {}
): void {
  const errors: string[] = [];

  // Check API version
  if (!registry.apiVersion) {
    errors.push('Missing required field: apiVersion');
  } else if (registry.apiVersion !== SUPPORTED_API_VERSION) {
    throw new RegistryError(
      `Unsupported API version: ${registry.apiVersion}. Expected: ${SUPPORTED_API_VERSION}`,
      'INVALID_API_VERSION',
      { 
        found: registry.apiVersion, 
        expected: SUPPORTED_API_VERSION,
        path: sourcePath 
      }
    );
  }

  // Check base layer
  if (!registry.base) {
    errors.push('Missing required field: base');
  } else if (!registry.base.package?.path) {
    errors.push('Missing required field: base.package.path');
  }

  // Check orgs structure
  if (!registry.orgs || typeof registry.orgs !== 'object') {
    errors.push('Missing or invalid field: orgs (must be an object)');
  } else {
    for (const [orgSlug, orgConfig] of Object.entries(registry.orgs)) {
      validateOrgConfig(orgSlug, orgConfig, errors);
    }
  }

  if (errors.length > 0) {
    throw new RegistryError(
      `Registry validation failed:\n  - ${errors.join('\n  - ')}`,
      'REGISTRY_VALIDATION_ERROR',
      { errors, path: sourcePath }
    );
  }

  // Run semantic validation rules (unique slugs, valid paths, no cycles)
  const basePath = sourcePath ? dirname(sourcePath) : process.cwd();
  const validationOptions: RegistryValidationOptions = {
    basePath,
    checkPackagesExist: options.checkPackagesExist ?? true,
    checkCycles: options.checkCycles ?? true,
    throwOnError: true,
  };

  validateRegistryRules(registry, validationOptions);
}

/**
 * Validate an organization configuration
 */
function validateOrgConfig(
  slug: string,
  config: OrgConfig,
  errors: string[]
): void {
  const prefix = `orgs.${slug}`;

  if (!config.slug) {
    // Auto-set slug from key if missing
    config.slug = slug;
  }

  if (!config.package?.path) {
    errors.push(`${prefix}: Missing required field: package.path`);
  }

  if (config.projects && typeof config.projects === 'object') {
    for (const [projectSlug, projectConfig] of Object.entries(config.projects)) {
      validateProjectConfig(prefix, projectSlug, projectConfig, errors);
    }
  }
}

/**
 * Validate a project configuration
 */
function validateProjectConfig(
  orgPrefix: string,
  slug: string,
  config: ProjectConfig,
  errors: string[]
): void {
  const prefix = `${orgPrefix}.projects.${slug}`;

  if (!config.slug) {
    // Auto-set slug from key if missing
    config.slug = slug;
  }

  if (!config.package?.path) {
    errors.push(`${prefix}: Missing required field: package.path`);
  }
}

/**
 * Resolve package paths for a specific org/project combination
 * 
 * @param registry - The loaded registry
 * @param orgSlug - Organization slug
 * @param projectSlug - Optional project slug
 * @param registryBasePath - Base path for resolving relative paths
 * @returns Resolved package paths for all applicable layers
 * @throws RegistryError if org or project not found
 */
export function resolvePackagePaths(
  registry: Registry,
  orgSlug: string,
  projectSlug?: string,
  registryBasePath?: string
): RegistryResolution {
  const basePath = registryBasePath ?? process.cwd();

  // Resolve base path
  const basePackagePath = resolvePackagePath(
    registry.base.package.path,
    basePath
  );

  // Find and validate org
  const org = registry.orgs[orgSlug];
  if (!org) {
    throw new RegistryError(
      `Organization not found: ${orgSlug}`,
      'ORG_NOT_FOUND',
      { 
        orgSlug, 
        availableOrgs: Object.keys(registry.orgs) 
      }
    );
  }

  // Resolve org path
  const orgPackagePath = resolvePackagePath(org.package.path, basePath);

  // Build resolution result
  const result: RegistryResolution = {
    orgSlug,
    paths: {
      base: basePackagePath,
      org: orgPackagePath,
    },
    enabled: {
      base: registry.base.package.enabled !== false,
      org: org.package.enabled !== false,
      project: false,
    },
  };

  // If project specified, resolve it too
  if (projectSlug) {
    const project = org.projects?.[projectSlug];
    if (!project) {
      throw new RegistryError(
        `Project not found: ${projectSlug} in org ${orgSlug}`,
        'PROJECT_NOT_FOUND',
        {
          orgSlug,
          projectSlug,
          availableProjects: Object.keys(org.projects ?? {}),
        }
      );
    }

    result.projectSlug = projectSlug;
    result.paths.project = resolvePackagePath(project.package.path, basePath);
    result.enabled.project = project.package.enabled !== false;
  }

  return result;
}

/**
 * Resolve a package path (handle relative vs absolute)
 */
function resolvePackagePath(packagePath: string, basePath: string): string {
  if (isAbsolute(packagePath)) {
    return packagePath;
  }
  return resolve(basePath, packagePath);
}

/**
 * List all organizations in the registry
 * 
 * @param registry - The loaded registry
 * @returns Array of org slugs and names
 */
export function listOrganizations(
  registry: Registry
): Array<{ slug: string; name?: string }> {
  return Object.entries(registry.orgs).map(([slug, config]) => ({
    slug,
    name: config.name,
  }));
}

/**
 * List all projects for an organization
 * 
 * @param registry - The loaded registry
 * @param orgSlug - Organization slug
 * @returns Array of project slugs and names
 * @throws RegistryError if org not found
 */
export function listProjects(
  registry: Registry,
  orgSlug: string
): Array<{ slug: string; name?: string }> {
  const org = registry.orgs[orgSlug];
  if (!org) {
    throw new RegistryError(
      `Organization not found: ${orgSlug}`,
      'ORG_NOT_FOUND',
      { orgSlug, availableOrgs: Object.keys(registry.orgs) }
    );
  }

  return Object.entries(org.projects ?? {}).map(([slug, config]) => ({
    slug,
    name: config.name,
  }));
}

/**
 * Get the effective package paths for all layers
 * Returns only enabled packages
 * 
 * @param resolution - Registry resolution result
 * @returns Object with enabled package paths
 */
export function getEnabledPackagePaths(
  resolution: RegistryResolution
): Partial<ResolvedPackagePaths> {
  const paths: Partial<ResolvedPackagePaths> = {};

  if (resolution.enabled.base) {
    paths.base = resolution.paths.base;
  }
  if (resolution.enabled.org && resolution.paths.org) {
    paths.org = resolution.paths.org;
  }
  if (resolution.enabled.project && resolution.paths.project) {
    paths.project = resolution.paths.project;
  }

  return paths;
}

// Re-export types for convenience
export * from './types.js';
