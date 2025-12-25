/**
 * Types for tool reconciliation
 *
 * Based on the blocks metadata strategy, adapted for tools.
 * Tools have different management semantics but follow similar patterns.
 */

import type { Layer } from '../../registry/types.js';
import type { ToolSpec, ToolResource, ToolType } from '../../packages/types.js';

/**
 * Managed tool metadata schema
 * All reconciler-managed tools MUST have this metadata structure.
 */
export interface ManagedToolMetadata {
  /** Literal string identifying the reconciler */
  managed_by: 'smarty-admin';

  /** Scoping layer for this tool */
  layer: Layer;

  /** Organization slug (required for org/project layers) */
  org?: string;

  /** Project slug (required for project layer) */
  project?: string;

  /** Git SHA of the source package */
  package_version?: string;

  /** ISO 8601 timestamp of last sync */
  last_synced?: string;

  /** Human-readable description */
  description?: string;

  /** Path in Git repo */
  source_path?: string;

  /** ISO 8601 timestamp when adopted (for user-created tools brought under management) */
  adopted_at?: string;

  /** Original name before adoption */
  original_name?: string;
}

/**
 * Tool ownership classification
 */
export enum ToolOwnership {
  /** Created/controlled by reconciler */
  MANAGED = 'managed',
  /** User-created, reconciler ignores */
  UNMANAGED = 'unmanaged',
  /** User-created, now under reconciler control */
  ADOPTED = 'adopted',
  /** Was managed, source deleted from Git */
  ORPHANED = 'orphaned',
}

/**
 * Parsed management info from a tool
 */
export interface ManagedToolInfo {
  isManaged: boolean;
  layer?: Layer;
  org?: string;
  project?: string;
  packageVersion?: string;
  lastSynced?: string;
}

/**
 * Tool classification result
 */
export interface ToolClassification {
  ownership: ToolOwnership;
  info?: ManagedToolInfo;
  reason: string;
}

/**
 * A tool definition from Git manifest (local configuration)
 */
export interface ToolManifestEntry {
  /** Tool name (unique identifier) */
  name: string;

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

  /** Scoping layer */
  layer: Layer;

  /** Organization slug */
  org?: string;

  /** Project slug */
  project?: string;

  /** Human-readable description */
  description?: string;

  /** Tool classification */
  toolType?: ToolType;

  /** Tags for categorization */
  tags?: string[];

  /** Path in Git repo */
  sourcePath?: string;
}

/**
 * Plan action types
 */
export type PlanActionType = 'create' | 'update' | 'delete' | 'skip' | 'adopt';

/**
 * A single action in the reconciliation plan
 */
export interface PlanAction {
  type: PlanActionType;
  name: string;
  toolId?: string;
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
export interface ReconcilePlan {
  /** Actions to create new tools */
  creates: PlanAction[];
  /** Actions to update existing tools */
  updates: PlanAction[];
  /** Actions to delete orphaned tools */
  deletes: PlanAction[];
  /** Actions skipped (no changes needed) */
  skipped: PlanAction[];
  /** Summary statistics */
  summary: {
    toCreate: number;
    toUpdate: number;
    toDelete: number;
    unchanged: number;
    total: number;
  };
}

/**
 * Apply options for the reconciler
 */
export interface ApplyOptions {
  /** If true, only return the plan without making changes */
  dryRun: boolean;

  /** If true, allow deletion of orphaned managed tools */
  allowDelete?: boolean;

  /** Package version (git SHA) to stamp on synced tools */
  packageVersion?: string;

  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Result of applying a single tool action
 */
export interface ApplyActionResult {
  action: PlanAction;
  success: boolean;
  error?: string;
  toolId?: string;
}

/**
 * Result of applying the reconciliation plan
 */
export interface ApplyResult {
  /** Results of all actions */
  results: ApplyActionResult[];
  /** Summary statistics */
  summary: {
    created: number;
    updated: number;
    deleted: number;
    failed: number;
    skipped: number;
  };
  /** List of errors encountered */
  errors: string[];
  /** Overall success status */
  success: boolean;
}

/**
 * Tool attachment to agent options
 */
export interface AttachToolOptions {
  /** Agent ID to attach tools to */
  agentId: string;
  /** Tool names to attach */
  toolNames: string[];
  /** If true, detach tools not in the list */
  detachOthers?: boolean;
}

/**
 * Tool attachment result
 */
export interface AttachToolResult {
  /** Agent ID */
  agentId: string;
  /** Tools that were attached */
  attached: string[];
  /** Tools that were detached */
  detached: string[];
  /** Tools that were already attached (no-op) */
  unchanged: string[];
  /** Errors encountered */
  errors: string[];
  /** Overall success status */
  success: boolean;
}

/**
 * Convert a ToolResource from package manifest to ToolManifestEntry
 */
export function toolResourceToManifestEntry(resource: ToolResource): ToolManifestEntry {
  return {
    name: resource.metadata.name,
    sourceType: resource.spec.sourceType,
    sourceCode: resource.spec.sourceCode,
    jsonSchema: resource.spec.jsonSchema,
    layer: resource.spec.layer,
    description: resource.metadata.description ?? resource.spec.jsonSchema.function.description,
    toolType: resource.spec.toolType,
    tags: resource.spec.tags,
    sourcePath: resource.metadata.annotations?.sourcePath as string | undefined,
  };
}
