/**
 * Template reconciler exports
 *
 * Provides types and functions for managing template state between
 * desired (manifest/config) and actual (Letta API) states.
 *
 * Templates are internal resources for creating agents, blocks, and groups
 * with predefined configurations. They support:
 * - Deployment-based grouping of related entities
 * - Environment promotion (dev -> staging -> production)
 * - Version tracking and package versioning
 *
 * @module reconcilers/templates
 */

// =============================================================================
// Types
// =============================================================================

export type {
  // Entity types
  TemplateEntityType,
  TemplateEnvironment,

  // Metadata types
  ManagedTemplateMetadata,
  ManagedTemplateInfo,
  TemplateClassification,

  // Block template types
  BlockTemplateManifestEntry,
  BlockTemplateResponse,

  // Agent template types
  AgentTemplateManifestEntry,
  AgentTemplateResponse,

  // Group template types
  GroupTemplateManifestEntry,
  GroupTemplateResponse,

  // Deployment types
  DeploymentEntity,
  ListDeploymentEntitiesResponse,
  DeleteDeploymentResponse,

  // Plan types
  TemplatePlanActionType,
  TemplatePlanAction,
  TemplateReconcilePlan,
  TemplateApplyOptions,
  TemplateApplyActionResult,
  TemplateApplyResult,

  // Manifest types
  TemplateManifest,

  // Promotion types
  TemplatePromotionRequest,
  TemplatePromotionResult,
} from './types.js';

export { TemplateOwnership } from './types.js';

// =============================================================================
// Diff Types and Functions
// =============================================================================

export type {
  TemplateDiffOptions,
  TemplateDriftType,
  TemplateDrift,
  TemplateDiffResult,
} from './diff.js';

// Template management detection
export {
  isTemplateManaged,
  extractTemplateMetadata,
  parseTemplateManagement,
  classifyTemplateOwnership,
} from './diff.js';

// Drift computation
export { computeBlockTemplateDrifts } from './diff.js';

// Diffing functions
export { diffBlockTemplates } from './diff.js';

// Formatting functions
export {
  formatTemplateDiffSummary,
  formatTemplateDiffDetails,
  formatTemplateDiffAsJson,
} from './diff.js';

// =============================================================================
// Sync Functions
// =============================================================================

// Metadata building
export {
  buildBlockTemplateMetadata,
  buildAgentTemplateMetadata,
  buildGroupTemplateMetadata,
} from './sync.js';

// Block template operations
export {
  createBlockTemplate,
  updateBlockTemplate,
  deleteBlockTemplate,
} from './sync.js';

// Deployment operations
export { listDeploymentEntities, deleteDeployment } from './sync.js';

// Reconciliation
export {
  buildTemplateReconcilePlan,
  applyTemplateReconciliation,
  getTemplateReconcilePlan,
} from './sync.js';

// Version promotion
export { promoteTemplates } from './sync.js';

// Utility functions
export { parseTemplateManifest, validateTemplateManifest } from './sync.js';
