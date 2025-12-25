/**
 * Registry validation logic
 * 
 * Implements validation rules for the registry schema:
 * 1. Unique slugs - No duplicate org/project slugs
 * 2. Unique package paths - Each package path maps to exactly one project
 * 3. Package references exist - All referenced packages are loadable
 * 4. No cycles - No circular dependencies in package includes
 * 
 * @example Valid Registry
 * ```yaml
 * apiVersion: smarty.dev/v1
 * base:
 *   package:
 *     path: ./packages/base
 * orgs:
 *   acme:
 *     slug: acme
 *     package:
 *       path: ./packages/acme
 *     projects:
 *       project-a:
 *         slug: project-a
 *         package:
 *           path: ./packages/acme/project-a
 * ```
 * 
 * @example Invalid Registry - Duplicate Slug
 * ```yaml
 * orgs:
 *   acme:
 *     slug: acme   # First definition
 *     package: { path: ./packages/acme }
 *   acme-duplicate:
 *     slug: acme   # ERROR: Duplicate slug "acme"
 *     package: { path: ./packages/acme2 }
 * ```
 * 
 * @example Invalid Registry - Duplicate Package Path
 * ```yaml
 * orgs:
 *   acme:
 *     projects:
 *       project-a:
 *         package: { path: ./packages/shared }  # Used here
 *       project-b:
 *         package: { path: ./packages/shared }  # ERROR: Same path
 * ```
 */

import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type {
  Registry,
  PackageReference,
} from './types.js';
import {
  type ValidationResult,
  type ValidationIssue,
  RegistryValidationError,
  duplicateOrgSlug,
  duplicateProjectSlug,
  duplicatePackagePath,
  packageNotLoadable,
  packageIncludeCycle,
  invalidPackageReference,
  missingRequiredField,
  validationSuccess,
  validationFailure,
  mergeValidationResults,
} from './errors.js';

// =============================================================================
// Validation Options
// =============================================================================

/**
 * Options for registry validation
 */
export interface RegistryValidationOptions {
  /** Base path for resolving relative package paths */
  basePath?: string;
  /** Whether to check if packages are loadable (default: true) */
  checkPackagesExist?: boolean;
  /** Whether to check for package include cycles (default: true) */
  checkCycles?: boolean;
  /** Throw on validation failure (default: false - returns result) */
  throwOnError?: boolean;
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate a registry against all validation rules
 * 
 * @param registry - The registry to validate
 * @param options - Validation options
 * @returns Validation result with any issues found
 * @throws RegistryValidationError if throwOnError is true and validation fails
 * 
 * @example
 * ```typescript
 * const result = validateRegistryRules(registry, { basePath: '/path/to/registry' });
 * if (!result.valid) {
 *   console.error('Validation failed:', result.errors);
 * }
 * ```
 */
export function validateRegistryRules(
  registry: Registry,
  options: RegistryValidationOptions = {}
): ValidationResult {
  const {
    basePath = process.cwd(),
    checkPackagesExist = true,
    checkCycles = true,
    throwOnError = false,
  } = options;

  // Run all validation rules
  const results: ValidationResult[] = [];

  // 1. Check for unique org slugs
  results.push(validateUniqueOrgSlugs(registry));

  // 2. Check for unique project slugs within each org
  results.push(validateUniqueProjectSlugs(registry));

  // 3. Check for unique package paths (each path maps to one project)
  results.push(validateUniquePackagePaths(registry));

  // 4. Check that package references are valid
  results.push(validatePackageReferences(registry, basePath, checkPackagesExist));

  // 5. Check for package include cycles
  if (checkCycles) {
    results.push(validateNoPackageCycles(registry, basePath));
  }

  // Merge all results
  const finalResult = mergeValidationResults(...results);

  // Throw if requested and there are errors
  if (throwOnError && !finalResult.valid) {
    const errorCount = finalResult.errors.length;
    throw new RegistryValidationError(
      `Registry validation failed with ${errorCount} error${errorCount > 1 ? 's' : ''}`,
      finalResult
    );
  }

  return finalResult;
}

// =============================================================================
// Rule: Unique Org Slugs
// =============================================================================

/**
 * Validate that all organization slugs are unique
 * 
 * Checks both the key in the orgs map and the explicit slug field.
 */
export function validateUniqueOrgSlugs(registry: Registry): ValidationResult {
  const issues: ValidationIssue[] = [];
  const slugToPath = new Map<string, string>();

  for (const [orgKey, orgConfig] of Object.entries(registry.orgs ?? {})) {
    // Use explicit slug if provided, otherwise use the key
    const slug = orgConfig.slug ?? orgKey;
    const currentPath = `orgs.${orgKey}`;

    const existingPath = slugToPath.get(slug);
    if (existingPath) {
      issues.push(duplicateOrgSlug(slug, existingPath, currentPath));
    } else {
      slugToPath.set(slug, currentPath);
    }
  }

  return issues.length > 0 ? validationFailure(issues) : validationSuccess();
}

// =============================================================================
// Rule: Unique Project Slugs
// =============================================================================

/**
 * Validate that project slugs are unique within each organization
 */
export function validateUniqueProjectSlugs(registry: Registry): ValidationResult {
  const issues: ValidationIssue[] = [];

  for (const [orgKey, orgConfig] of Object.entries(registry.orgs ?? {})) {
    const orgSlug = orgConfig.slug ?? orgKey;
    const slugToPath = new Map<string, string>();

    for (const [projectKey, projectConfig] of Object.entries(orgConfig.projects ?? {})) {
      // Use explicit slug if provided, otherwise use the key
      const slug = projectConfig.slug ?? projectKey;
      const currentPath = `orgs.${orgKey}.projects.${projectKey}`;

      const existingPath = slugToPath.get(slug);
      if (existingPath) {
        issues.push(duplicateProjectSlug(orgSlug, slug, existingPath, currentPath));
      } else {
        slugToPath.set(slug, currentPath);
      }
    }
  }

  return issues.length > 0 ? validationFailure(issues) : validationSuccess();
}

// =============================================================================
// Rule: Unique Package Paths
// =============================================================================

/**
 * Validate that each package path is referenced by at most one project
 * 
 * This ensures a 1:1 mapping between package paths and Letta projects.
 * Org-level packages can be shared, but project-level packages must be unique.
 */
export function validateUniquePackagePaths(registry: Registry): ValidationResult {
  const issues: ValidationIssue[] = [];
  
  // Track project-level package paths (these must be unique)
  const projectPathToRef = new Map<string, string>();

  for (const [orgKey, orgConfig] of Object.entries(registry.orgs ?? {})) {
    for (const [projectKey, projectConfig] of Object.entries(orgConfig.projects ?? {})) {
      const packagePath = projectConfig.package?.path;
      if (!packagePath) continue;

      const currentRef = `orgs.${orgKey}.projects.${projectKey}`;
      const existingRef = projectPathToRef.get(packagePath);

      if (existingRef) {
        issues.push(duplicatePackagePath(packagePath, 'project', existingRef, currentRef));
      } else {
        projectPathToRef.set(packagePath, currentRef);
      }
    }
  }

  return issues.length > 0 ? validationFailure(issues) : validationSuccess();
}

// =============================================================================
// Rule: Valid Package References
// =============================================================================

/**
 * Validate that all package references are valid and loadable
 */
export function validatePackageReferences(
  registry: Registry,
  basePath: string,
  checkExists: boolean
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Validate base package
  if (registry.base?.package) {
    const baseIssues = validatePackageReference(
      registry.base.package,
      'base.package',
      basePath,
      checkExists
    );
    issues.push(...baseIssues);
  }

  // Validate org packages
  for (const [orgKey, orgConfig] of Object.entries(registry.orgs ?? {})) {
    const orgPath = `orgs.${orgKey}`;
    
    if (orgConfig.package) {
      const orgIssues = validatePackageReference(
        orgConfig.package,
        `${orgPath}.package`,
        basePath,
        checkExists
      );
      issues.push(...orgIssues);
    }

    // Validate project packages
    for (const [projectKey, projectConfig] of Object.entries(orgConfig.projects ?? {})) {
      const projectPath = `${orgPath}.projects.${projectKey}`;
      
      if (projectConfig.package) {
        const projectIssues = validatePackageReference(
          projectConfig.package,
          `${projectPath}.package`,
          basePath,
          checkExists
        );
        issues.push(...projectIssues);
      }
    }
  }

  return issues.length > 0 ? validationFailure(issues) : validationSuccess();
}

/**
 * Validate a single package reference
 */
function validatePackageReference(
  ref: PackageReference,
  path: string,
  basePath: string,
  checkExists: boolean
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check required path field
  if (!ref.path) {
    issues.push(missingRequiredField(path, 'path'));
    return issues;
  }

  if (typeof ref.path !== 'string') {
    issues.push(invalidPackageReference(path, 'path', 'path must be a string'));
    return issues;
  }

  // Check if package exists (if enabled)
  if (checkExists) {
    const absolutePath = isAbsolute(ref.path) ? ref.path : resolve(basePath, ref.path);
    if (!existsSync(absolutePath)) {
      issues.push(packageNotLoadable(
        ref.path,
        path,
        `Path does not exist: ${absolutePath}`
      ));
    }
  }

  return issues;
}

// =============================================================================
// Rule: No Package Include Cycles
// =============================================================================

/**
 * Package dependency graph for cycle detection
 */
interface PackageNode {
  path: string;
  includes: string[];
}

/**
 * Validate that there are no cycles in package includes
 * 
 * Uses depth-first search to detect cycles in the package dependency graph.
 */
export function validateNoPackageCycles(
  registry: Registry,
  basePath: string
): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Build the dependency graph from registry
  const graph = buildPackageDependencyGraph(registry, basePath);

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  for (const path of Array.from(graph.keys())) {
    const cycle = detectCycleDFS(path, graph, visited, recursionStack, []);
    if (cycle) {
      issues.push(packageIncludeCycle(cycle, path));
      break; // Report first cycle found
    }
  }

  return issues.length > 0 ? validationFailure(issues) : validationSuccess();
}

/**
 * Build a dependency graph from registry packages
 * 
 * Note: Currently, the registry doesn't have an explicit "includes" field
 * for packages. This function is designed to support future extension
 * where packages may include/depend on other packages.
 * 
 * For now, we build a graph based on the layer hierarchy (base -> org -> project).
 */
function buildPackageDependencyGraph(
  registry: Registry,
  basePath: string
): Map<string, PackageNode> {
  const graph = new Map<string, PackageNode>();

  // Add base package
  if (registry.base?.package?.path) {
    const basePkgPath = resolvePath(registry.base.package.path, basePath);
    graph.set(basePkgPath, { path: basePkgPath, includes: [] });
  }

  // Add org and project packages
  for (const [_orgKey, orgConfig] of Object.entries(registry.orgs ?? {})) {
    const orgPkgPath = orgConfig.package?.path 
      ? resolvePath(orgConfig.package.path, basePath) 
      : undefined;
    
    if (orgPkgPath) {
      const orgIncludes: string[] = [];
      // Org packages implicitly depend on base
      if (registry.base?.package?.path) {
        orgIncludes.push(resolvePath(registry.base.package.path, basePath));
      }
      graph.set(orgPkgPath, { path: orgPkgPath, includes: orgIncludes });
    }

    for (const [_projectKey, projectConfig] of Object.entries(orgConfig.projects ?? {})) {
      const projectPkgPath = projectConfig.package?.path
        ? resolvePath(projectConfig.package.path, basePath)
        : undefined;

      if (projectPkgPath) {
        const projectIncludes: string[] = [];
        // Project packages implicitly depend on org
        if (orgPkgPath) {
          projectIncludes.push(orgPkgPath);
        }
        graph.set(projectPkgPath, { path: projectPkgPath, includes: projectIncludes });
      }
    }
  }

  return graph;
}

/**
 * Resolve a path (handle relative vs absolute)
 */
function resolvePath(pkgPath: string, basePath: string): string {
  return isAbsolute(pkgPath) ? pkgPath : resolve(basePath, pkgPath);
}

/**
 * DFS cycle detection
 * Returns the cycle path if found, null otherwise
 */
function detectCycleDFS(
  node: string,
  graph: Map<string, PackageNode>,
  visited: Set<string>,
  recursionStack: Set<string>,
  path: string[]
): string[] | null {
  visited.add(node);
  recursionStack.add(node);
  path.push(node);

  const pkgNode = graph.get(node);
  if (pkgNode) {
    for (const include of pkgNode.includes) {
      if (!visited.has(include)) {
        const cycle = detectCycleDFS(include, graph, visited, recursionStack, path);
        if (cycle) return cycle;
      } else if (recursionStack.has(include)) {
        // Cycle detected! Return the cycle path
        const cycleStart = path.indexOf(include);
        return [...path.slice(cycleStart), include];
      }
    }
  }

  path.pop();
  recursionStack.delete(node);
  return null;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Quick check if a registry has any validation errors
 * 
 * @param registry - The registry to check
 * @param options - Validation options
 * @returns true if registry is valid, false otherwise
 */
export function isRegistryValid(
  registry: Registry,
  options?: RegistryValidationOptions
): boolean {
  const result = validateRegistryRules(registry, options);
  return result.valid;
}

/**
 * Get a summary of validation issues
 */
export function getValidationSummary(result: ValidationResult): string {
  if (result.valid && result.warnings.length === 0) {
    return '✅ Registry validation passed';
  }

  const lines: string[] = [];
  
  if (!result.valid) {
    lines.push(`❌ Registry validation failed: ${result.errors.length} error(s)`);
  }
  
  if (result.warnings.length > 0) {
    lines.push(`⚠️  ${result.warnings.length} warning(s)`);
  }

  return lines.join('\n');
}
