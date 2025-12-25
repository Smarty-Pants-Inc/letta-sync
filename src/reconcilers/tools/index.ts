/**
 * Tool reconciler exports
 *
 * Provides types and functions for managing tool state between
 * desired (manifest/config) and actual (Letta API) states.
 */

// Types from types.ts
export type {
  ManagedToolMetadata,
  ManagedToolInfo,
  ToolClassification,
  ToolManifestEntry,
  PlanActionType,
  PlanAction,
  ReconcilePlan,
  ApplyOptions,
  ApplyActionResult,
  ApplyResult,
  AttachToolOptions,
  AttachToolResult,
} from './types.js';

export { ToolOwnership, toolResourceToManifestEntry } from './types.js';

// Types from diff.ts
export type {
  ToolDiffOptions,
  DriftType,
  ToolDrift,
  ToolDiffResult,
} from './diff.js';

// Diff functions
export {
  diffTools,
  isToolManaged,
  extractManagedMetadata,
  parseToolManagement,
  classifyToolOwnership,
  computeDrifts,
  formatDiffSummary,
  formatDiffDetails,
  formatDiffAsJson,
} from './diff.js';

// Apply/Create/Update functions
export {
  createManagedTool,
  updateManagedTool,
  adoptTool,
  buildManagedTags,
  buildUpdatedTags,
  compareToolWithManifest,
  classifyTool,
  applyToolReconciliation,
  getReconcilePlan,
  buildReconcilePlan,
  attachToolsToAgent,
} from './apply.js';

export type {
  CreateToolOptions,
  UpdateToolOptions,
  ToolDiff,
  LettaAgentClient,
  AgentsClientWithTools,
} from './apply.js';
