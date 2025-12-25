/**
 * Types for template reconciliation
 *
 * Templates are internal resources used for creating agents, blocks, and groups
 * with predefined configurations. They use the _internal_templates API endpoints.
 *
 * Based on: docs/research/letta-api-reference.md (Section 8: Templates)
 */

/**
 * Template entity types that can be managed
 */
export type TemplateEntityType = 'block' | 'agent' | 'group';

/**
 * Template promotion environments
 */
export type TemplateEnvironment = 'dev' | 'staging' | 'production';

/**
 * Managed template metadata schema
 * All reconciler-managed templates MUST have this metadata structure.
 */
export interface ManagedTemplateMetadata {
  /** Literal string identifying the reconciler */
  managed_by: 'smarty-admin';

  /** Type of template entity */
  entity_type: TemplateEntityType;

  /** Deployment ID for grouping related entities */
  deployment_id: string;

  /** Template entity identifier */
  entity_id?: string;

  /** Project scope */
  project_id?: string;

  /** Version identifier (semantic versioning or git SHA) */
  version?: string;

  /** Environment this template is deployed to */
  environment?: TemplateEnvironment;

  /** ISO 8601 timestamp of last sync */
  last_synced?: string;

  /** Git SHA of the source package */
  package_version?: string;

  /** Human-readable description */
  description?: string;

  /** Path in Git repo */
  source_path?: string;

  /** ISO 8601 timestamp when promoted from previous environment */
  promoted_at?: string;

  /** Previous environment it was promoted from */
  promoted_from?: TemplateEnvironment;
}

/**
 * Template ownership classification
 */
export enum TemplateOwnership {
  /** Created/controlled by reconciler */
  MANAGED = 'managed',
  /** User-created, reconciler ignores */
  UNMANAGED = 'unmanaged',
  /** Was managed, source deleted from Git */
  ORPHANED = 'orphaned',
}

/**
 * Parsed management info from a template
 */
export interface ManagedTemplateInfo {
  isManaged: boolean;
  entityType?: TemplateEntityType;
  deploymentId?: string;
  entityId?: string;
  projectId?: string;
  version?: string;
  environment?: TemplateEnvironment;
  packageVersion?: string;
  lastSynced?: string;
}

/**
 * Template classification result
 */
export interface TemplateClassification {
  ownership: TemplateOwnership;
  info?: ManagedTemplateInfo;
  reason: string;
}

// =============================================================================
// Block Template Types
// =============================================================================

/**
 * Block template manifest entry (from Git configuration)
 */
export interface BlockTemplateManifestEntry {
  /** Template name (unique identifier) */
  templateName: string;

  /** Block label when instantiated */
  label: string;

  /** Block content value */
  value: string;

  /** Character limit for the block */
  limit?: number;

  /** Human-readable description */
  description?: string;

  /** Deployment ID for grouping */
  deploymentId: string;

  /** Entity ID within the deployment */
  entityId?: string;

  /** Project scope */
  projectId?: string;

  /** Version string */
  version?: string;

  /** Target environment */
  environment?: TemplateEnvironment;

  /** Path in Git repo */
  sourcePath?: string;
}

/**
 * Block template response from Letta API
 */
export interface BlockTemplateResponse {
  id: string;
  label: string;
  value: string;
  limit?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  template_name?: string;
  is_template?: boolean;
  created_at?: string;
  updated_at?: string;
}

// =============================================================================
// Agent Template Types
// =============================================================================

/**
 * Agent template manifest entry (from Git configuration)
 */
export interface AgentTemplateManifestEntry {
  /** Agent name */
  name: string;

  /** Agent description */
  description?: string;

  /** Deployment ID for grouping */
  deploymentId: string;

  /** Entity ID within the deployment */
  entityId?: string;

  /** Project scope */
  projectId?: string;

  /** Block template names to attach */
  blockTemplates?: string[];

  /** Tool names to attach */
  tools?: string[];

  /** System prompt */
  systemPrompt?: string;

  /** Model configuration */
  model?: string;

  /** Version string */
  version?: string;

  /** Target environment */
  environment?: TemplateEnvironment;

  /** Path in Git repo */
  sourcePath?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Agent template response from Letta API
 */
export interface AgentTemplateResponse {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// =============================================================================
// Group Template Types
// =============================================================================

/**
 * Group template manifest entry (from Git configuration)
 */
export interface GroupTemplateManifestEntry {
  /** Group name */
  name: string;

  /** Group description */
  description?: string;

  /** Deployment ID for grouping */
  deploymentId: string;

  /** Entity ID within the deployment */
  entityId?: string;

  /** Project scope */
  projectId?: string;

  /** Agent template names in this group */
  agentTemplates?: string[];

  /** Version string */
  version?: string;

  /** Target environment */
  environment?: TemplateEnvironment;

  /** Path in Git repo */
  sourcePath?: string;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Group template response from Letta API
 */
export interface GroupTemplateResponse {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// =============================================================================
// Deployment Types
// =============================================================================

/**
 * Deployment entity from the API
 */
export interface DeploymentEntity {
  id: string;
  type: TemplateEntityType;
  name?: string;
  description?: string;
  entity_id?: string;
  project_id?: string;
}

/**
 * List deployment entities response
 */
export interface ListDeploymentEntitiesResponse {
  entities: DeploymentEntity[];
  total_count: number;
  deployment_id: string;
  message: string;
}

/**
 * Delete deployment response
 */
export interface DeleteDeploymentResponse {
  deleted_blocks: string[];
  deleted_agents: string[];
  deleted_groups: string[];
  message: string;
}

// =============================================================================
// Plan Types
// =============================================================================

/**
 * Plan action types
 */
export type TemplatePlanActionType =
  | 'create'
  | 'update'
  | 'delete'
  | 'skip'
  | 'promote';

/**
 * A single action in the reconciliation plan
 */
export interface TemplatePlanAction {
  type: TemplatePlanActionType;
  entityType: TemplateEntityType;
  name: string;
  templateId?: string;
  deploymentId?: string;
  reason: string;
  changes?: {
    field: string;
    oldValue?: unknown;
    newValue?: unknown;
  }[];
}

/**
 * Reconciliation plan result
 */
export interface TemplateReconcilePlan {
  /** Actions to create new templates */
  creates: TemplatePlanAction[];
  /** Actions to update existing templates */
  updates: TemplatePlanAction[];
  /** Actions to delete orphaned templates */
  deletes: TemplatePlanAction[];
  /** Actions skipped (no changes needed) */
  skipped: TemplatePlanAction[];
  /** Actions to promote to next environment */
  promotes: TemplatePlanAction[];
  /** Summary statistics */
  summary: {
    toCreate: number;
    toUpdate: number;
    toDelete: number;
    toPromote: number;
    unchanged: number;
    total: number;
  };
}

/**
 * Apply options for the template reconciler
 */
export interface TemplateApplyOptions {
  /** If true, only return the plan without making changes */
  dryRun: boolean;

  /** If true, allow deletion of orphaned templates */
  allowDelete?: boolean;

  /** Package version (git SHA) to stamp on synced templates */
  packageVersion?: string;

  /** Target environment for this sync */
  environment?: TemplateEnvironment;

  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Result of applying a single template action
 */
export interface TemplateApplyActionResult {
  action: TemplatePlanAction;
  success: boolean;
  error?: string;
  templateId?: string;
}

/**
 * Result of applying the reconciliation plan
 */
export interface TemplateApplyResult {
  /** Results of all actions */
  results: TemplateApplyActionResult[];
  /** Summary statistics */
  summary: {
    created: number;
    updated: number;
    deleted: number;
    promoted: number;
    failed: number;
    skipped: number;
  };
  /** List of errors encountered */
  errors: string[];
  /** Overall success status */
  success: boolean;
}

// =============================================================================
// Combined Template Manifest
// =============================================================================

/**
 * Combined manifest containing all template types
 */
export interface TemplateManifest {
  /** Deployment identifier for all templates in this manifest */
  deploymentId: string;

  /** Target project ID */
  projectId?: string;

  /** Target environment */
  environment?: TemplateEnvironment;

  /** Version string */
  version?: string;

  /** Block templates */
  blocks: BlockTemplateManifestEntry[];

  /** Agent templates */
  agents: AgentTemplateManifestEntry[];

  /** Group templates */
  groups: GroupTemplateManifestEntry[];
}

/**
 * Version promotion request
 */
export interface TemplatePromotionRequest {
  /** Deployment ID to promote */
  deploymentId: string;

  /** Source environment */
  fromEnvironment: TemplateEnvironment;

  /** Target environment */
  toEnvironment: TemplateEnvironment;

  /** Specific entity types to promote (defaults to all) */
  entityTypes?: TemplateEntityType[];

  /** Version to assign to promoted templates */
  version?: string;
}

/**
 * Version promotion result
 */
export interface TemplatePromotionResult {
  success: boolean;
  promotedEntities: {
    type: TemplateEntityType;
    id: string;
    name: string;
  }[];
  errors: string[];
}
