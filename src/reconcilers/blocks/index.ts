/**
 * Block reconciler exports
 * 
 * Provides types and functions for managing block state between
 * desired (manifest/config) and actual (Letta API) states.
 */

// Types from types.ts
export type {
  BlockLayer,
  ManagedBlockMetadata,
  ManagedBlockInfo,
  BlockClassification,
  BlockManifestEntry,
  PlanActionType,
  PlanAction,
  ReconcilePlan,
  ApplyOptions,
  ApplyActionResult,
  ApplyResult,
} from './types.js';

export { BlockOwnership, CANONICAL_LABELS, LAYER_PREFIXES } from './types.js';

// Types from diff.ts
export type {
  BlockDiffOptions,
  DriftType,
  BlockDrift,
  BlockDiffResult,
} from './diff.js';

// Diff functions
export {
  diffBlocks,
  isBlockManaged,
  extractManagedMetadata,
  parseBlockManagement,
  isManagedLabel,
  parseLayerFromLabel,
  classifyBlockOwnership,
  computeDrifts,
  formatDiffSummary,
  formatDiffDetails,
  formatDiffAsJson,
} from './diff.js';

// Create functions
export {
  createManagedBlock,
  validateLabelForLayer,
  buildManagedMetadata,
  validateMetadataForLayer,
  inferLayerFromLabel,
} from './create.js';

export type { CreateBlockOptions } from './create.js';

// Update functions
export {
  updateManagedBlock,
  adoptBlock,
  compareBlockWithManifest,
  buildUpdatedMetadata,
} from './update.js';

export type {
  UpdateBlockOptions,
  BlockUpdateFields,
  BlockDiff,
} from './update.js';

// Apply/reconcile functions
export {
  applyBlockReconciliation,
  getReconcilePlan,
  buildReconcilePlan,
  classifyBlock,
} from './apply.js';
