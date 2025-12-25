/**
 * Types for block reconciliation
 * 
 * Based on the blocks metadata strategy specification.
 * See docs/specs/blocks-metadata-strategy.md for details.
 */

/**
 * Layer types for block scoping
 */
export type BlockLayer = 'base' | 'org' | 'project' | 'user' | 'lane';

/**
 * Managed block metadata schema
 * All reconciler-managed blocks MUST have this metadata structure.
 */
export interface ManagedBlockMetadata {
  /** Literal string identifying the reconciler */
  managed_by: 'smarty-admin';

  /** Scoping layer for this block */
  layer: BlockLayer;

  /** Organization slug (required for org/project/user layers) */
  org?: string;

  /** Project slug (required for project layer) */
  project?: string;

  /** User identity ID (required for user layer) */
  user_identity_id?: string;

  /** Git SHA of the source package */
  package_version?: string;

  /** ISO 8601 timestamp of last sync */
  last_synced?: string;

  /** Human-readable description */
  description?: string;

  /** Path in Git repo */
  source_path?: string;

  /** ISO 8601 timestamp when adopted (for user-created blocks brought under management) */
  adopted_at?: string;

  /** Original label before adoption */
  original_label?: string;
}

/**
 * Block ownership classification
 */
export enum BlockOwnership {
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
 * Parsed management info from a block
 */
export interface ManagedBlockInfo {
  isManaged: boolean;
  layer?: BlockLayer;
  org?: string;
  project?: string;
  userIdentityId?: string;
  packageVersion?: string;
  lastSynced?: string;
}

/**
 * Block classification result
 */
export interface BlockClassification {
  ownership: BlockOwnership;
  info?: ManagedBlockInfo;
  reason: string;
}

/**
 * A block definition from Git manifest (local configuration)
 */
export interface BlockManifestEntry {
  /** Block label (unique identifier) */
  label: string;

  /** Block content value */
  value: string;

  /** Scoping layer */
  layer: BlockLayer;

  /** Organization slug */
  org?: string;

  /** Project slug */
  project?: string;

  /** Human-readable description */
  description?: string;

  /** Character limit for the block */
  limit?: number;

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
  label: string;
  blockId?: string;
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
  /** Actions to create new blocks */
  creates: PlanAction[];
  /** Actions to update existing blocks */
  updates: PlanAction[];
  /** Actions to delete orphaned blocks */
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

  /** If true, allow deletion of orphaned managed blocks */
  allowDelete?: boolean;

  /** Package version (git SHA) to stamp on synced blocks */
  packageVersion?: string;

  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Result of applying a single block action
 */
export interface ApplyActionResult {
  action: PlanAction;
  success: boolean;
  error?: string;
  blockId?: string;
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
 * Canonical labels that don't follow prefix convention
 */
export const CANONICAL_LABELS = new Set([
  'project',
  'decisions',
  'conventions',
  'glossary',
  'human',
  'persona',
  'managed_state',
]);

/**
 * Layer prefix mapping
 */
export const LAYER_PREFIXES: Record<BlockLayer, string> = {
  base: 'base_',
  org: 'org_',
  project: 'project_',
  user: 'user_',
  lane: 'lane_',
};
