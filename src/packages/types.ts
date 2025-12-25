/**
 * Package type definitions for smarty-admin
 * 
 * Based on docs/specs/manifest-formats.md specification.
 * These types represent the structure of package manifests that define
 * Letta resources (blocks, tools, templates, etc.)
 */

import type { Layer } from '../registry/types.js';

// =============================================================================
// Common Types
// =============================================================================

/**
 * API version for manifest files
 */
export const MANIFEST_API_VERSION = 'letta.ai/v1';

/**
 * Supported resource kinds
 */
export type ResourceKind =
  | 'Block'
  | 'Tool'
  | 'MCPServer'
  | 'Template'
  | 'Folder'
  | 'Identity'
  | 'AgentPolicy';

/**
 * Common metadata for all resources
 */
export interface ResourceMetadata {
  /** Resource name (required, unique per scope) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Key-value labels for filtering */
  labels?: Record<string, string>;
  /** Non-identifying metadata */
  annotations?: Record<string, unknown>;
}

/**
 * Common status fields (read-only, populated by reconciler)
 */
export interface ResourceStatus {
  /** Letta resource ID */
  id?: string;
  /** Organization ID */
  organizationId?: string;
  /** Project ID (if project-scoped) */
  projectId?: string;
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
  /** Last reconciliation timestamp */
  reconciledAt?: string;
}

/**
 * Base interface for all resource specs
 */
export interface BaseResourceSpec {
  /** Whether reconciler manages this resource (default: true) */
  managed?: boolean;
  /** Resource scope: base, org, or project */
  layer: Layer;
}

/**
 * Base interface for all resources
 */
export interface BaseResource<TSpec extends BaseResourceSpec = BaseResourceSpec> {
  /** API version (required) */
  apiVersion: string;
  /** Resource type (required) */
  kind: ResourceKind;
  /** Resource metadata */
  metadata: ResourceMetadata;
  /** Resource specification */
  spec: TSpec;
  /** Resource status (read-only) */
  status?: ResourceStatus;
}

// =============================================================================
// Merge Control Types
// =============================================================================

/**
 * Merge strategies for array fields
 */
export type MergeStrategy = 'append' | 'replace' | 'merge-by-key';

/**
 * Merge metadata that can be attached to resources
 */
export interface MergeMetadata {
  /** Field-level merge strategies */
  _merge?: Record<string, MergeStrategy>;
  /** Deletion marker */
  _delete?: boolean;
}

// =============================================================================
// Block Resource
// =============================================================================

/**
 * Block resource spec
 */
export interface BlockSpec extends BaseResourceSpec {
  /** Block type (e.g., "human", "persona") */
  label: string;
  /** Block content */
  value: string;
  /** Character limit (default: 2000) */
  limit?: number;
  /** Whether this is a template block */
  isTemplate?: boolean;
  /** Template name (required if isTemplate=true) */
  templateName?: string;
  /** Reference to identity */
  identityId?: string;
  /** Additional Letta metadata */
  lettaMetadata?: Record<string, unknown>;
}

/**
 * Block resource
 */
export interface BlockResource extends BaseResource<BlockSpec> {
  kind: 'Block';
}

// =============================================================================
// Tool Resource
// =============================================================================

/**
 * Pip requirement for Python tools
 */
export interface PipRequirement {
  /** Package name */
  package: string;
  /** Version specifier */
  version?: string;
}

/**
 * Tool type classification
 */
export type ToolType = 'custom' | 'letta_core' | 'letta_mcp' | 'letta_builtin';

/**
 * Tool resource spec
 */
export interface ToolSpec extends BaseResourceSpec {
  /** Source language: "python" or "typescript" */
  sourceType: 'python' | 'typescript';
  /** Tool implementation code */
  sourceCode: string;
  /** OpenAPI function schema */
  jsonSchema: {
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
      };
    };
  };
  /** Tool classification */
  toolType?: ToolType;
  /** Tags for categorization */
  tags?: string[];
  /** Python dependencies */
  pipRequirements?: PipRequirement[];
  /** Whether tool requires approval (application-level) */
  requiresApproval?: boolean;
}

/**
 * Tool resource
 */
export interface ToolResource extends BaseResource<ToolSpec> {
  kind: 'Tool';
}

// =============================================================================
// MCP Server Resource
// =============================================================================

/**
 * MCP server transport type
 */
export type MCPServerType = 'sse' | 'stdio' | 'streamable_http';

/**
 * Stdio configuration for MCP servers
 */
export interface StdioConfig {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * MCP Server resource spec
 */
export interface MCPServerSpec extends BaseResourceSpec {
  /** Transport type */
  serverType: MCPServerType;
  /** Server URL (for SSE/HTTP) */
  serverUrl?: string;
  /** Auth token (prefer tokenSecretRef) */
  token?: string;
  /** Reference to secret for token */
  tokenSecretRef?: string;
  /** Custom headers */
  customHeaders?: Record<string, string>;
  /** Reference to secret for headers */
  customHeadersSecretRef?: string;
  /** Stdio configuration (for stdio type) */
  stdioConfig?: StdioConfig;
}

/**
 * MCP Server resource
 */
export interface MCPServerResource extends BaseResource<MCPServerSpec> {
  kind: 'MCPServer';
}

// =============================================================================
// Template Resource
// =============================================================================

/**
 * Block reference in template
 */
export interface TemplateBlockRef {
  /** Block name reference */
  name?: string;
  /** Block label */
  label: string;
  /** Inline value (if not referencing) */
  value?: string;
  /** Character limit */
  limit?: number;
}

/**
 * Tool reference in template
 */
export interface TemplateToolRef {
  /** Tool name reference */
  name: string;
}

/**
 * Folder reference in template
 */
export interface TemplateFolderRef {
  /** Folder name reference */
  name: string;
}

/**
 * Model configuration in template
 */
export interface ModelConfig {
  /** Model name (e.g., "gpt-4") */
  model: string;
  /** Model endpoint */
  modelEndpoint?: string;
  /** Context window size */
  contextWindow?: number;
}

/**
 * Agent configuration within a template
 */
export interface TemplateAgentConfig {
  /** Agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** System instructions */
  instructions?: string;
  /** Model configuration */
  modelConfig: ModelConfig;
  /** Block references */
  blocks?: TemplateBlockRef[];
  /** Tool references */
  tools?: TemplateToolRef[];
  /** Folder references */
  folders?: TemplateFolderRef[];
  /** Enable sleeptime */
  enableSleeptime?: boolean;
  /** Tags */
  tags?: string[];
}

/**
 * Template resource spec
 */
export interface TemplateSpec extends BaseResourceSpec {
  /** Stable template family ID */
  baseTemplateId: string;
  /** Versioned template ID (format: {base}:{version}) */
  templateId: string;
  /** Agent configuration */
  agent: TemplateAgentConfig;
  /** Additional template blocks */
  blocks?: BlockSpec[];
}

/**
 * Template resource
 */
export interface TemplateResource extends BaseResource<TemplateSpec> {
  kind: 'Template';
}

// =============================================================================
// Folder Resource
// =============================================================================

/**
 * Embedding configuration
 */
export interface EmbeddingConfig {
  /** Embedding model handle */
  model: string;
  /** Chunk size (default: 512) */
  chunkSize?: number;
  /** Vector DB provider */
  provider?: string;
}

/**
 * Folder resource spec
 */
export interface FolderSpec extends BaseResourceSpec {
  /** Instructions for agents using this folder */
  instructions?: string;
  /** Embedding configuration */
  embeddingConfig: EmbeddingConfig;
  /** Additional Letta metadata */
  lettaMetadata?: Record<string, unknown>;
}

/**
 * Folder resource
 */
export interface FolderResource extends BaseResource<FolderSpec> {
  kind: 'Folder';
}

// =============================================================================
// Identity Resource
// =============================================================================

/**
 * Identity property
 */
export interface IdentityProperty {
  /** Property key */
  key: string;
  /** Property value */
  value: unknown;
}

/**
 * Identity resource spec
 */
export interface IdentitySpec extends BaseResourceSpec {
  /** Unique identifier key */
  identifierKey?: string;
  /** Identity type classification */
  identityType?: string;
  /** Identity properties */
  properties?: IdentityProperty[];
  /** Additional Letta metadata */
  lettaMetadata?: Record<string, unknown>;
}

/**
 * Identity resource
 */
export interface IdentityResource extends BaseResource<IdentitySpec> {
  kind: 'Identity';
}

// =============================================================================
// Agent Policy Resource
// =============================================================================

/**
 * Policy selector for matching agents
 */
export interface PolicySelector {
  /** Match agents by labels */
  matchLabels?: Record<string, string>;
  /** Match agents by tags */
  matchTags?: string[];
  /** Match agents from specific template */
  matchTemplate?: string;
}

/**
 * Policy attachment reference
 */
export interface PolicyAttachment {
  /** Resource name reference */
  name: string;
  /** Whether required (default: true) */
  required?: boolean;
}

/**
 * Agent Policy resource spec
 */
export interface AgentPolicySpec extends BaseResourceSpec {
  /** Policy selector */
  selector: PolicySelector;
  /** Block attachments */
  blocks?: PolicyAttachment[];
  /** Tool attachments */
  tools?: PolicyAttachment[];
  /** Folder attachments */
  folders?: PolicyAttachment[];
  /** Enforce unique policy matching */
  enforceUnique?: boolean;
  /** Policy priority for conflict resolution */
  priority?: number;
}

/**
 * Agent Policy resource
 */
export interface AgentPolicyResource extends BaseResource<AgentPolicySpec> {
  kind: 'AgentPolicy';
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any resource type
 */
export type Resource =
  | BlockResource
  | ToolResource
  | MCPServerResource
  | TemplateResource
  | FolderResource
  | IdentityResource
  | AgentPolicyResource;

/**
 * Resource with merge metadata
 */
export type ResourceWithMerge<T extends Resource = Resource> = T & MergeMetadata;

// =============================================================================
// Package Types
// =============================================================================

/**
 * Package manifest containing multiple resources
 */
export interface Package {
  /** Package identifier */
  name: string;
  /** Package description */
  description?: string;
  /** Package version */
  version?: string;
  /** Layer this package belongs to */
  layer: Layer;
  /** Resources in this package */
  resources: {
    blocks?: BlockResource[];
    tools?: ToolResource[];
    mcpServers?: MCPServerResource[];
    templates?: TemplateResource[];
    folders?: FolderResource[];
    identities?: IdentityResource[];
    policies?: AgentPolicyResource[];
  };
}

/**
 * Desired state produced by merging all layers
 */
export interface DesiredState {
  /** Resolved blocks */
  blocks: BlockResource[];
  /** Resolved tools */
  tools: ToolResource[];
  /** Resolved MCP servers */
  mcpServers: MCPServerResource[];
  /** Resolved templates */
  templates: TemplateResource[];
  /** Resolved folders */
  folders: FolderResource[];
  /** Resolved identities */
  identities: IdentityResource[];
  /** Resolved policies */
  policies: AgentPolicyResource[];
  /** Layer tags added to resources */
  layerTags: {
    base: string;
    org: string;
    project: string;
  };
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Package loading/merge error codes
 */
export type PackageErrorCode =
  | 'PACKAGE_NOT_FOUND'
  | 'PACKAGE_PARSE_ERROR'
  | 'PACKAGE_VALIDATION_ERROR'
  | 'MERGE_CONFLICT'
  | 'TYPE_CONFLICT'
  | 'RESOURCE_IDENTITY_CONFLICT'
  | 'CONSTRAINT_VIOLATION';

/**
 * Package error
 */
export class PackageError extends Error {
  constructor(
    message: string,
    public readonly code: PackageErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'PackageError';
  }
}

/**
 * Merge conflict details
 */
export interface MergeConflict {
  /** Type of conflict */
  type: 'type_conflict' | 'resource_identity_conflict' | 'constraint_violation';
  /** Path to conflicting field */
  path: string;
  /** Conflict message */
  message: string;
  /** Layer values */
  layers?: {
    base?: unknown;
    org?: unknown;
    project?: unknown;
  };
  /** Suggested fixes */
  suggestions?: string[];
}
