/**
 * Tag reconciler exports
 *
 * Provides types and functions for managing tags on agents and tools.
 * Tags follow a namespaced format: `namespace:value[@sha]`
 *
 * See docs/specs/naming-conventions.md for the tag taxonomy.
 */

// Types from types.ts
export type {
  ReservedNamespace,
  ParsedTag,
  TagValidationResult,
  TagDiffAction,
  TagDiff,
  TagDiffResult,
  TagDiffOptions,
  TagApplyOptions,
  TagApplyResult,
} from './types.js';

export {
  RESERVED_NAMESPACES,
  TAG_PATTERN,
  ALLOWED_VALUES,
  MANAGEMENT_TAG,
  parseTag,
  validateTag,
  validateTags,
  isManagementTag,
  isManagedMarker,
  buildManagementTags,
  extractManagementInfo,
} from './types.js';

// Diff functions from diff.ts
export {
  diffTags,
  diffAgentTags,
  diffToolTags,
  isAgentManaged,
  isToolManaged,
  getManagementTags,
  getUserTags,
  mergeTags,
  updateAppliedTags,
  formatTagDiffSummary,
  formatTagDiffAsJson,
} from './diff.js';

// Apply functions from apply.ts
export {
  applyAgentTags,
  applyToolTags,
  ensureAgentManaged,
  ensureToolManaged,
  batchApplyAgentTags,
  batchApplyToolTags,
  formatApplyResult,
  formatBatchApplyResults,
} from './apply.js';
