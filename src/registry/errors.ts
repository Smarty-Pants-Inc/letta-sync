/**
 * Registry validation error types
 * 
 * Provides structured error types for registry validation with clear messages
 * and actionable suggestions.
 */

import type { Layer } from './types.js';

// =============================================================================
// Error Codes
// =============================================================================

/**
 * Validation error codes for registry validation
 */
export type ValidationErrorCode =
  | 'DUPLICATE_ORG_SLUG'
  | 'DUPLICATE_PROJECT_SLUG'
  | 'DUPLICATE_PACKAGE_PATH'
  | 'PACKAGE_NOT_LOADABLE'
  | 'PACKAGE_INCLUDE_CYCLE'
  | 'INVALID_PACKAGE_REFERENCE'
  | 'MISSING_REQUIRED_FIELD';

// =============================================================================
// Validation Issue Types
// =============================================================================

/**
 * Severity level for validation issues
 */
export type ValidationSeverity = 'error' | 'warning';

/**
 * A single validation issue
 */
export interface ValidationIssue {
  /** Error code for programmatic handling */
  code: ValidationErrorCode;
  /** Severity level */
  severity: ValidationSeverity;
  /** Human-readable error message */
  message: string;
  /** Path to the problematic field (e.g., "orgs.acme.projects.foo") */
  path: string;
  /** Additional context about the error */
  context?: Record<string, unknown>;
  /** Suggestions for fixing the issue */
  suggestions?: string[];
}

/**
 * Result of registry validation
 */
export interface ValidationResult {
  /** Whether validation passed (no errors) */
  valid: boolean;
  /** List of validation issues found */
  issues: ValidationIssue[];
  /** Error-level issues only */
  errors: ValidationIssue[];
  /** Warning-level issues only */
  warnings: ValidationIssue[];
}

// =============================================================================
// Validation Error Class
// =============================================================================

/**
 * Error thrown when registry validation fails
 */
export class RegistryValidationError extends Error {
  constructor(
    message: string,
    public readonly result: ValidationResult
  ) {
    super(message);
    this.name = 'RegistryValidationError';
  }

  /**
   * Format the validation errors for display
   */
  formatErrors(): string {
    const lines: string[] = [];
    
    for (const issue of this.result.errors) {
      lines.push(`❌ [${issue.code}] ${issue.path}`);
      lines.push(`   ${issue.message}`);
      if (issue.suggestions?.length) {
        lines.push(`   Suggestions:`);
        for (const suggestion of issue.suggestions) {
          lines.push(`     • ${suggestion}`);
        }
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Format all issues (including warnings) for display
   */
  formatAll(): string {
    const lines: string[] = [];
    
    for (const issue of this.result.issues) {
      const prefix = issue.severity === 'error' ? '❌' : '⚠️';
      lines.push(`${prefix} [${issue.code}] ${issue.path}`);
      lines.push(`   ${issue.message}`);
      if (issue.suggestions?.length) {
        lines.push(`   Suggestions:`);
        for (const suggestion of issue.suggestions) {
          lines.push(`     • ${suggestion}`);
        }
      }
    }
    
    return lines.join('\n');
  }
}

// =============================================================================
// Issue Builders
// =============================================================================

/**
 * Create a duplicate org slug issue
 */
export function duplicateOrgSlug(
  slug: string,
  existingPath: string,
  newPath: string
): ValidationIssue {
  return {
    code: 'DUPLICATE_ORG_SLUG',
    severity: 'error',
    message: `Organization slug "${slug}" is already defined at "${existingPath}"`,
    path: newPath,
    context: { slug, existingPath, newPath },
    suggestions: [
      `Rename one of the organizations to use a unique slug`,
      `Remove the duplicate organization definition`,
    ],
  };
}

/**
 * Create a duplicate project slug issue
 */
export function duplicateProjectSlug(
  orgSlug: string,
  projectSlug: string,
  existingPath: string,
  newPath: string
): ValidationIssue {
  return {
    code: 'DUPLICATE_PROJECT_SLUG',
    severity: 'error',
    message: `Project slug "${projectSlug}" is already defined within org "${orgSlug}" at "${existingPath}"`,
    path: newPath,
    context: { orgSlug, projectSlug, existingPath, newPath },
    suggestions: [
      `Rename one of the projects to use a unique slug`,
      `Move one project to a different organization`,
      `Remove the duplicate project definition`,
    ],
  };
}

/**
 * Create a duplicate package path issue
 */
export function duplicatePackagePath(
  packagePath: string,
  layer: Layer,
  existingReference: string,
  newReference: string
): ValidationIssue {
  return {
    code: 'DUPLICATE_PACKAGE_PATH',
    severity: 'error',
    message: `Package path "${packagePath}" is referenced by multiple ${layer}-layer entries: "${existingReference}" and "${newReference}"`,
    path: newReference,
    context: { packagePath, layer, existingReference, newReference },
    suggestions: [
      `Each package path should be referenced by exactly one project`,
      `Create separate package directories for each project`,
      `If these should be the same project, remove the duplicate entry`,
    ],
  };
}

/**
 * Create a package not loadable issue
 */
export function packageNotLoadable(
  packagePath: string,
  referencePath: string,
  reason: string
): ValidationIssue {
  return {
    code: 'PACKAGE_NOT_LOADABLE',
    severity: 'error',
    message: `Package at "${packagePath}" cannot be loaded: ${reason}`,
    path: referencePath,
    context: { packagePath, reason },
    suggestions: [
      `Verify the package path exists and is accessible`,
      `Check that the path is correct (absolute or relative to registry)`,
      `Ensure the package directory contains valid manifest files`,
    ],
  };
}

/**
 * Create a package include cycle issue
 */
export function packageIncludeCycle(
  cycle: string[],
  startPath: string
): ValidationIssue {
  const cycleStr = cycle.join(' → ');
  return {
    code: 'PACKAGE_INCLUDE_CYCLE',
    severity: 'error',
    message: `Circular package include detected: ${cycleStr}`,
    path: startPath,
    context: { cycle },
    suggestions: [
      `Remove one of the include relationships to break the cycle`,
      `Reorganize packages to avoid circular dependencies`,
      `Extract common code into a shared package that others can include`,
    ],
  };
}

/**
 * Create an invalid package reference issue
 */
export function invalidPackageReference(
  referencePath: string,
  field: string,
  reason: string
): ValidationIssue {
  return {
    code: 'INVALID_PACKAGE_REFERENCE',
    severity: 'error',
    message: `Invalid package reference at "${field}": ${reason}`,
    path: referencePath,
    context: { field, reason },
    suggestions: [
      `Ensure the package reference includes a valid "path" field`,
      `Check that the path is a string`,
    ],
  };
}

/**
 * Create a missing required field issue
 */
export function missingRequiredField(
  path: string,
  field: string
): ValidationIssue {
  return {
    code: 'MISSING_REQUIRED_FIELD',
    severity: 'error',
    message: `Missing required field: "${field}"`,
    path,
    context: { field },
    suggestions: [
      `Add the required "${field}" field to the configuration`,
    ],
  };
}

// =============================================================================
// Result Builders
// =============================================================================

/**
 * Create a successful validation result
 */
export function validationSuccess(warnings: ValidationIssue[] = []): ValidationResult {
  return {
    valid: true,
    issues: warnings,
    errors: [],
    warnings,
  };
}

/**
 * Create a failed validation result
 */
export function validationFailure(issues: ValidationIssue[]): ValidationResult {
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}

/**
 * Merge multiple validation results
 */
export function mergeValidationResults(...results: ValidationResult[]): ValidationResult {
  const allIssues: ValidationIssue[] = [];
  for (const result of results) {
    allIssues.push(...result.issues);
  }
  return validationFailure(allIssues);
}
