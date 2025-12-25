/**
 * Folder reconciler exports
 *
 * Provides types and functions for managing folder state between
 * desired (manifest/config) and actual (Letta API) states.
 *
 * Folders (formerly Sources) are containers for uploaded files that get
 * processed into searchable passages for retrieval-augmented generation (RAG).
 */

// Types from types.ts
export type {
  FolderLayer,
  ManagedFolderMetadata,
  ManagedFolderInfo,
  FolderClassification,
  EmbeddingConfig,
  AttachmentSelector,
  AttachmentRules,
  FolderManifestEntry,
  PlanActionType,
  PlanAction,
  ReconcilePlan,
  ApplyOptions,
  ApplyActionResult,
  ApplyResult,
  AttachFolderOptions,
  AttachFolderResult,
  AgentAttachmentChange,
  FolderPlanAction,
} from './types.js';

export { FolderOwnership } from './types.js';

// Types from diff.ts
export type {
  FolderDiffOptions,
  DriftType,
  FolderDrift,
  FolderDiffResult,
} from './diff.js';

// Diff functions
export {
  diffFolders,
  isFolderManaged,
  extractManagedMetadata,
  parseFolderManagement,
  classifyFolderOwnership,
  computeDrifts,
  formatDiffSummary,
  formatDiffDetails,
  formatDiffAsJson,
} from './diff.js';

// Types from apply.ts
export type {
  CreateFolderOptions,
  UpdateFolderOptions,
  FolderUpdateFields,
  FolderDiff,
} from './apply.js';

// Apply/create/update functions
export {
  createManagedFolder,
  updateManagedFolder,
  adoptFolder,
  compareFolderWithManifest,
  buildManagedMetadata,
  buildUpdatedMetadata,
} from './apply.js';

// Apply/reconcile functions
export {
  applyFolderReconciliation,
  getReconcilePlan,
  buildReconcilePlan,
  classifyFolder,
} from './apply.js';
