/**
 * Types for folder reconciliation
 *
 * Based on the folder manifest specification (docs/specs/folder-manifest.md).
 * Folders (formerly Sources) are containers for uploaded files that get
 * processed into searchable passages for RAG.
 */

import type { Layer } from '../../registry/types.js';

/**
 * Folder layer types - folders cannot be base layer
 */
export type FolderLayer = 'org' | 'project';

/**
 * Managed folder metadata schema
 * All reconciler-managed folders MUST have this metadata structure.
 */
export interface ManagedFolderMetadata {
  /** Literal string identifying the reconciler */
  managed_by: 'smarty-admin';

  /** Scoping layer for this folder */
  layer: FolderLayer;

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

  /** ISO 8601 timestamp when adopted (for user-created folders brought under management) */
  adopted_at?: string;

  /** Original name before adoption */
  original_name?: string;
}

/**
 * Folder ownership classification
 */
export enum FolderOwnership {
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
 * Parsed management info from a folder
 */
export interface ManagedFolderInfo {
  isManaged: boolean;
  layer?: FolderLayer;
  org?: string;
  project?: string;
  packageVersion?: string;
  lastSynced?: string;
}

/**
 * Folder classification result
 */
export interface FolderClassification {
  ownership: FolderOwnership;
  info?: ManagedFolderInfo;
  reason: string;
}

/**
 * Embedding configuration for a folder
 */
export interface EmbeddingConfig {
  /** Embedding model handle (required) */
  model: string;
  /** Chunk size in tokens (default: 512) */
  chunkSize?: number;
  /** Overlap between chunks (default: 0) */
  chunkOverlap?: number;
  /** Vector DB provider */
  provider?: 'native' | 'pinecone' | 'turbopuffer';
}

/**
 * Agent attachment selector
 */
export interface AttachmentSelector {
  /** Match agents by labels (AND logic) */
  matchLabels?: Record<string, string>;
  /** Match agents by tags (OR logic) */
  matchTags?: string[];
  /** Match agents by template names (OR logic) */
  matchTemplates?: string[];
}

/**
 * Agent attachment rules for a folder
 */
export interface AttachmentRules {
  /** Auto-attach to matching agents (default: false) */
  autoAttach?: boolean;
  /** Agent selector (if autoAttach: true) */
  selector?: AttachmentSelector;
  /** Attachment priority (higher = first) */
  priority?: number;
  /** Detach when folder deleted (default: true) */
  detachOnRemoval?: boolean;
}

/**
 * A folder definition from Git manifest (local configuration)
 */
export interface FolderManifestEntry {
  /** Folder name (unique identifier) */
  name: string;

  /** Scoping layer */
  layer: FolderLayer;

  /** Organization slug */
  org?: string;

  /** Project slug */
  project?: string;

  /** Human-readable description */
  description?: string;

  /** Instructions for agents using this folder */
  instructions?: string;

  /** Embedding configuration */
  embeddingConfig: EmbeddingConfig;

  /** Agent attachment rules */
  attachmentRules?: AttachmentRules;

  /** Additional Letta metadata */
  lettaMetadata?: Record<string, unknown>;

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
  folderId?: string;
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
  /** Actions to create new folders */
  creates: PlanAction[];
  /** Actions to update existing folders */
  updates: PlanAction[];
  /** Actions to delete orphaned folders */
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

  /** If true, allow deletion of orphaned managed folders */
  allowDelete?: boolean;

  /** Package version (git SHA) to stamp on synced folders */
  packageVersion?: string;

  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Result of applying a single folder action
 */
export interface ApplyActionResult {
  action: PlanAction;
  success: boolean;
  error?: string;
  folderId?: string;
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
 * Folder attachment to agent options
 */
export interface AttachFolderOptions {
  /** Agent ID to attach folders to */
  agentId: string;
  /** Folder names to attach */
  folderNames: string[];
  /** If true, detach folders not in the list */
  detachOthers?: boolean;
}

/**
 * Folder attachment result
 */
export interface AttachFolderResult {
  /** Agent ID */
  agentId: string;
  /** Folders that were attached */
  attached: string[];
  /** Folders that were detached */
  detached: string[];
  /** Folders that were already attached (no-op) */
  unchanged: string[];
  /** Errors encountered */
  errors: string[];
  /** Overall success status */
  success: boolean;
}

/**
 * Agent attachment change for a folder
 */
export interface AgentAttachmentChange {
  /** Agent ID */
  agentId: string;
  /** Agent name (for display) */
  agentName?: string;
  /** Operation type */
  operation: 'attach' | 'detach';
  /** Reason for the change */
  reason: string;
}

/**
 * Extended plan action with agent attachments
 */
export interface FolderPlanAction extends PlanAction {
  /** Agent attachment changes */
  agentAttachments?: AgentAttachmentChange[];
}
