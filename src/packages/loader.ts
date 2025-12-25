/**
 * Package manifest loading utilities
 * 
 * Handles loading and validating package manifest files that define
 * Letta resources (blocks, tools, templates, etc.)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, isAbsolute, basename, dirname } from 'node:path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import type { Layer } from '../registry/types.js';
import type {
  Package,
  Resource,
  ResourceKind,
  BlockResource,
  ToolResource,
  MCPServerResource,
  TemplateResource,
  FolderResource,
  IdentityResource,
  AgentPolicyResource,
  MANIFEST_API_VERSION,
} from './types.js';
import { PackageError } from './types.js';

/** Supported file extensions for manifest files */
const MANIFEST_EXTENSIONS = ['.yaml', '.yml', '.json'];

/** Supported API version */
const SUPPORTED_API_VERSION = 'letta.ai/v1';

/**
 * Options for package loading
 */
export interface PackageLoadOptions {
  /** Validate resources after loading */
  validate?: boolean;
  /** Base directory for resolving relative paths */
  basePath?: string;
  /** Layer to assign to resources (if not specified in manifest) */
  defaultLayer?: Layer;
}

/**
 * Load a package from a directory or file path
 * 
 * If path is a directory, loads all manifest files within it.
 * If path is a file, loads that single manifest.
 * 
 * @param packagePath - Path to package directory or file
 * @param options - Loading options
 * @returns Loaded package
 */
export async function loadPackage(
  packagePath: string,
  options: PackageLoadOptions = {}
): Promise<Package> {
  const { validate = true, basePath, defaultLayer } = options;
  const absolutePath = isAbsolute(packagePath)
    ? packagePath
    : resolve(basePath ?? process.cwd(), packagePath);

  // Check path exists
  if (!existsSync(absolutePath)) {
    throw new PackageError(
      `Package path not found: ${absolutePath}`,
      'PACKAGE_NOT_FOUND',
      { path: absolutePath }
    );
  }

  // Determine if directory or file
  const pathStat = await stat(absolutePath);
  
  let resources: Resource[];
  let packageName: string;

  if (pathStat.isDirectory()) {
    packageName = basename(absolutePath);
    resources = await loadPackageDirectory(absolutePath);
  } else {
    packageName = basename(absolutePath, extname(absolutePath));
    resources = await loadManifestFile(absolutePath);
  }

  // Build package structure
  const pkg = buildPackageFromResources(packageName, resources, defaultLayer);

  // Validate if requested
  if (validate) {
    validatePackage(pkg, absolutePath);
  }

  return pkg;
}

/**
 * Load all manifest files from a directory
 */
async function loadPackageDirectory(dirPath: string): Promise<Resource[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const resources: Resource[] = [];

  for (const entry of entries) {
    if (entry.isFile() && MANIFEST_EXTENSIONS.includes(extname(entry.name).toLowerCase())) {
      const filePath = resolve(dirPath, entry.name);
      const fileResources = await loadManifestFile(filePath);
      resources.push(...fileResources);
    } else if (entry.isDirectory()) {
      // Recursively load subdirectories
      const subPath = resolve(dirPath, entry.name);
      const subResources = await loadPackageDirectory(subPath);
      resources.push(...subResources);
    }
  }

  return resources;
}

/**
 * Load resources from a single manifest file
 * 
 * Supports multi-document YAML files (using ---) and JSON files
 */
async function loadManifestFile(filePath: string): Promise<Resource[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new PackageError(
      `Failed to read manifest file: ${err instanceof Error ? err.message : String(err)}`,
      'PACKAGE_NOT_FOUND',
      { path: filePath, originalError: err }
    );
  }

  const ext = extname(filePath).toLowerCase();
  const resources: Resource[] = [];

  try {
    if (ext === '.json') {
      // JSON file - single document
      const data = JSON.parse(content);
      if (isResource(data)) {
        resources.push(data);
      }
    } else {
      // YAML file - may contain multiple documents
      const documents = parseAllDocuments(content);
      for (const doc of documents) {
        if (doc.errors.length > 0) {
          throw new Error(doc.errors.map(e => e.message).join('\n'));
        }
        const data = doc.toJSON();
        if (data && isResource(data)) {
          resources.push(data);
        }
      }
    }
  } catch (err) {
    throw new PackageError(
      `Failed to parse manifest file: ${err instanceof Error ? err.message : String(err)}`,
      'PACKAGE_PARSE_ERROR',
      { path: filePath, originalError: err }
    );
  }

  return resources;
}

/**
 * Check if an object is a resource
 */
function isResource(obj: unknown): obj is Resource {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const record = obj as Record<string, unknown>;
  return (
    typeof record.apiVersion === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.metadata === 'object' &&
    record.metadata !== null
  );
}

/**
 * Build a Package from a list of resources
 */
function buildPackageFromResources(
  name: string,
  resources: Resource[],
  defaultLayer?: Layer
): Package {
  const pkg: Package = {
    name,
    layer: defaultLayer ?? 'org',
    resources: {
      blocks: [],
      tools: [],
      mcpServers: [],
      templates: [],
      folders: [],
      identities: [],
      policies: [],
    },
  };

  // Determine package layer from resources
  const layers = new Set<Layer>();
  
  for (const resource of resources) {
    layers.add(resource.spec.layer);
    
    switch (resource.kind) {
      case 'Block':
        pkg.resources.blocks!.push(resource as BlockResource);
        break;
      case 'Tool':
        pkg.resources.tools!.push(resource as ToolResource);
        break;
      case 'MCPServer':
        pkg.resources.mcpServers!.push(resource as MCPServerResource);
        break;
      case 'Template':
        pkg.resources.templates!.push(resource as TemplateResource);
        break;
      case 'Folder':
        pkg.resources.folders!.push(resource as FolderResource);
        break;
      case 'Identity':
        pkg.resources.identities!.push(resource as IdentityResource);
        break;
      case 'AgentPolicy':
        pkg.resources.policies!.push(resource as AgentPolicyResource);
        break;
    }
  }

  // Set package layer based on resources (prefer most specific)
  if (layers.has('project')) {
    pkg.layer = 'project';
  } else if (layers.has('org')) {
    pkg.layer = 'org';
  } else if (layers.has('base')) {
    pkg.layer = 'base';
  }

  return pkg;
}

/**
 * Validate a loaded package
 */
export function validatePackage(pkg: Package, sourcePath?: string): void {
  const errors: string[] = [];

  // Validate each resource type
  const allResources = [
    ...(pkg.resources.blocks ?? []),
    ...(pkg.resources.tools ?? []),
    ...(pkg.resources.mcpServers ?? []),
    ...(pkg.resources.templates ?? []),
    ...(pkg.resources.folders ?? []),
    ...(pkg.resources.identities ?? []),
    ...(pkg.resources.policies ?? []),
  ];

  for (const resource of allResources) {
    const resourceErrors = validateResource(resource);
    errors.push(...resourceErrors);
  }

  // Check for duplicate names within same kind
  const namesByKind = new Map<ResourceKind, Set<string>>();
  for (const resource of allResources) {
    const names = namesByKind.get(resource.kind) ?? new Set();
    if (names.has(resource.metadata.name)) {
      errors.push(`Duplicate ${resource.kind} name: ${resource.metadata.name}`);
    }
    names.add(resource.metadata.name);
    namesByKind.set(resource.kind, names);
  }

  if (errors.length > 0) {
    throw new PackageError(
      `Package validation failed:\n  - ${errors.join('\n  - ')}`,
      'PACKAGE_VALIDATION_ERROR',
      { errors, path: sourcePath }
    );
  }
}

/**
 * Validate a single resource
 */
function validateResource(resource: Resource): string[] {
  const errors: string[] = [];
  const prefix = `${resource.kind}.${resource.metadata.name}`;

  // Check API version
  if (resource.apiVersion !== SUPPORTED_API_VERSION) {
    errors.push(`${prefix}: Unsupported apiVersion: ${resource.apiVersion}`);
  }

  // Check required metadata
  if (!resource.metadata.name) {
    errors.push(`${prefix}: Missing required field: metadata.name`);
  }

  // Check required spec fields
  if (!resource.spec.layer) {
    errors.push(`${prefix}: Missing required field: spec.layer`);
  } else if (!['base', 'org', 'project'].includes(resource.spec.layer)) {
    errors.push(`${prefix}: Invalid layer: ${resource.spec.layer}`);
  }

  // Resource-specific validation
  switch (resource.kind) {
    case 'Block':
      errors.push(...validateBlockResource(resource));
      break;
    case 'Tool':
      errors.push(...validateToolResource(resource));
      break;
    case 'MCPServer':
      errors.push(...validateMCPServerResource(resource));
      break;
    case 'Template':
      errors.push(...validateTemplateResource(resource));
      break;
    case 'Folder':
      errors.push(...validateFolderResource(resource));
      break;
  }

  return errors;
}

/**
 * Validate Block resource
 */
function validateBlockResource(resource: BlockResource): string[] {
  const errors: string[] = [];
  const prefix = `Block.${resource.metadata.name}`;

  if (!resource.spec.label) {
    errors.push(`${prefix}: Missing required field: spec.label`);
  }
  if (resource.spec.value === undefined) {
    errors.push(`${prefix}: Missing required field: spec.value`);
  }
  if (resource.spec.isTemplate && !resource.spec.templateName) {
    errors.push(`${prefix}: spec.templateName required when isTemplate=true`);
  }

  return errors;
}

/**
 * Validate Tool resource
 */
function validateToolResource(resource: ToolResource): string[] {
  const errors: string[] = [];
  const prefix = `Tool.${resource.metadata.name}`;

  if (!resource.spec.sourceType) {
    errors.push(`${prefix}: Missing required field: spec.sourceType`);
  } else if (!['python', 'typescript'].includes(resource.spec.sourceType)) {
    errors.push(`${prefix}: Invalid sourceType: ${resource.spec.sourceType}`);
  }

  if (!resource.spec.sourceCode) {
    errors.push(`${prefix}: Missing required field: spec.sourceCode`);
  }

  if (!resource.spec.jsonSchema) {
    errors.push(`${prefix}: Missing required field: spec.jsonSchema`);
  } else {
    // Validate schema structure
    const schema = resource.spec.jsonSchema;
    if (schema.type !== 'function') {
      errors.push(`${prefix}: jsonSchema.type must be 'function'`);
    }
    if (schema.function?.name !== resource.metadata.name) {
      errors.push(`${prefix}: jsonSchema.function.name must match metadata.name`);
    }
  }

  return errors;
}

/**
 * Validate MCPServer resource
 */
function validateMCPServerResource(resource: MCPServerResource): string[] {
  const errors: string[] = [];
  const prefix = `MCPServer.${resource.metadata.name}`;

  if (!resource.spec.serverType) {
    errors.push(`${prefix}: Missing required field: spec.serverType`);
  } else if (!['sse', 'stdio', 'streamable_http'].includes(resource.spec.serverType)) {
    errors.push(`${prefix}: Invalid serverType: ${resource.spec.serverType}`);
  }

  // MCP servers must be org-level
  if (resource.spec.layer !== 'org') {
    errors.push(`${prefix}: MCPServer must have layer: org`);
  }

  // Validate based on server type
  if (resource.spec.serverType === 'stdio') {
    if (!resource.spec.stdioConfig?.command) {
      errors.push(`${prefix}: stdioConfig.command required for stdio servers`);
    }
  } else if (['sse', 'streamable_http'].includes(resource.spec.serverType ?? '')) {
    if (!resource.spec.serverUrl) {
      errors.push(`${prefix}: serverUrl required for SSE/HTTP servers`);
    }
  }

  return errors;
}

/**
 * Validate Template resource
 */
function validateTemplateResource(resource: TemplateResource): string[] {
  const errors: string[] = [];
  const prefix = `Template.${resource.metadata.name}`;

  if (!resource.spec.baseTemplateId) {
    errors.push(`${prefix}: Missing required field: spec.baseTemplateId`);
  }
  if (!resource.spec.templateId) {
    errors.push(`${prefix}: Missing required field: spec.templateId`);
  }
  if (!resource.spec.agent?.name) {
    errors.push(`${prefix}: Missing required field: spec.agent.name`);
  }
  if (!resource.spec.agent?.modelConfig?.model) {
    errors.push(`${prefix}: Missing required field: spec.agent.modelConfig.model`);
  }

  return errors;
}

/**
 * Validate Folder resource
 */
function validateFolderResource(resource: FolderResource): string[] {
  const errors: string[] = [];
  const prefix = `Folder.${resource.metadata.name}`;

  // Folders cannot be base layer
  if (resource.spec.layer === 'base') {
    errors.push(`${prefix}: Folder cannot have layer: base`);
  }

  if (!resource.spec.embeddingConfig?.model) {
    errors.push(`${prefix}: Missing required field: spec.embeddingConfig.model`);
  }

  return errors;
}

/**
 * Load packages for all layers (base, org, project)
 * 
 * @param paths - Package paths for each layer
 * @param options - Loading options
 * @returns Object containing packages for each layer
 */
export async function loadLayeredPackages(
  paths: {
    base?: string;
    org?: string;
    project?: string;
  },
  options: PackageLoadOptions = {}
): Promise<{
  base?: Package;
  org?: Package;
  project?: Package;
}> {
  const result: {
    base?: Package;
    org?: Package;
    project?: Package;
  } = {};

  if (paths.base) {
    result.base = await loadPackage(paths.base, { ...options, defaultLayer: 'base' });
  }

  if (paths.org) {
    result.org = await loadPackage(paths.org, { ...options, defaultLayer: 'org' });
  }

  if (paths.project) {
    result.project = await loadPackage(paths.project, { ...options, defaultLayer: 'project' });
  }

  return result;
}

// Re-export types
export * from './types.js';
