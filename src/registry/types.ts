/**
 * Registry type definitions for smarty-admin
 * 
 * The registry maps organizations and projects to their package paths,
 * enabling the package loader to resolve the base → org → project layer hierarchy.
 */

/**
 * Layer types for the package hierarchy
 */
export type Layer = 'base' | 'org' | 'project';

/**
 * Package reference within the registry
 */
export interface PackageReference {
  /** Path to the package manifest (relative to registry or absolute) */
  path: string;
  /** Optional version constraint for the package */
  version?: string;
  /** Whether this package is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Project configuration within an organization
 */
export interface ProjectConfig {
  /** Project slug identifier */
  slug: string;
  /** Human-readable project name */
  name?: string;
  /** Project description */
  description?: string;
  /** Project-layer package reference */
  package: PackageReference;
  /** Additional project metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Organization configuration within the registry
 */
export interface OrgConfig {
  /** Organization slug identifier */
  slug: string;
  /** Human-readable organization name */
  name?: string;
  /** Organization description */
  description?: string;
  /** Org-layer package reference */
  package: PackageReference;
  /** Projects within this organization */
  projects: Record<string, ProjectConfig>;
  /** Additional organization metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Base layer configuration
 */
export interface BaseConfig {
  /** Base-layer package reference */
  package: PackageReference;
  /** Base layer description */
  description?: string;
}

/**
 * Registry configuration - the root structure loaded from registry.yaml
 */
export interface Registry {
  /** API version for the registry format */
  apiVersion: string;
  /** Base layer configuration (shared across all orgs) */
  base: BaseConfig;
  /** Organizations mapped by slug */
  orgs: Record<string, OrgConfig>;
  /** Registry-level metadata */
  metadata?: {
    /** Registry name */
    name?: string;
    /** Registry description */
    description?: string;
    /** Registry version */
    version?: string;
    /** Last updated timestamp */
    lastUpdated?: string;
  };
}

/**
 * Resolved package paths for a specific org/project combination
 */
export interface ResolvedPackagePaths {
  /** Path to base layer package */
  base: string;
  /** Path to org layer package (if applicable) */
  org?: string;
  /** Path to project layer package (if applicable) */
  project?: string;
}

/**
 * Result of resolving an org/project to package paths
 */
export interface RegistryResolution {
  /** Organization slug */
  orgSlug: string;
  /** Project slug (if specified) */
  projectSlug?: string;
  /** Resolved package paths */
  paths: ResolvedPackagePaths;
  /** Whether all layers are enabled */
  enabled: {
    base: boolean;
    org: boolean;
    project: boolean;
  };
}

/**
 * Errors that can occur during registry operations
 */
export class RegistryError extends Error {
  constructor(
    message: string,
    public readonly code: RegistryErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Registry error codes
 */
export type RegistryErrorCode =
  | 'REGISTRY_NOT_FOUND'
  | 'REGISTRY_PARSE_ERROR'
  | 'REGISTRY_VALIDATION_ERROR'
  | 'ORG_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PACKAGE_PATH_NOT_FOUND'
  | 'INVALID_API_VERSION';

/**
 * Options for registry loading
 */
export interface RegistryLoadOptions {
  /** Validate the registry against schema after loading (default: true) */
  validate?: boolean;
  /** Base directory for resolving relative package paths */
  basePath?: string;
  /** Whether to check if referenced packages exist on disk (default: true) */
  checkPackagesExist?: boolean;
  /** Whether to check for package include cycles (default: true) */
  checkCycles?: boolean;
}
