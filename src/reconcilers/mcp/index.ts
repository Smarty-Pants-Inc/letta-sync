/**
 * MCP Server reconciler exports
 *
 * Provides observe-only reconciliation for MCP servers.
 * Due to credential handling requirements, MCP servers cannot be
 * auto-reconciled. Instead, this module:
 *
 * 1. Detects drift between manifest and Letta state
 * 2. Reports on MCP servers needing manual setup
 * 3. Generates detailed setup instructions
 * 4. Handles tool attachment bundles (role-based)
 *
 * @module reconcilers/mcp
 */

// =============================================================================
// Types from types.ts
// =============================================================================

export type {
  MCPServerType,
  MCPServerRecord,
  MCPServerManifestEntry,
  ToolAttachmentBundle,
  ToolBundleStatus,
  MCPDriftType,
  MCPServerDrift,
  MCPServerClassification,
  MCPDiffSummary,
  MCPDiffResult,
  MCPDiffOptions,
  SetupStep,
  MCPSetupInstructions,
  MCPSetupReport,
  // Enhanced bundle types
  AgentRole,
  BundleCategory,
  ToolRefType,
  EnhancedToolRef,
  RoleBundleManifestEntry,
  EnhancedBundleStatus,
} from './types.js';

export {
  MCPServerOwnership,
  CredentialStatus,
  LIKELY_SECRET_ENV_PATTERNS,
  isLikelySecretEnv,
} from './types.js';

// =============================================================================
// Diff functions from diff.ts
// =============================================================================

export {
  // Credential detection
  detectCredentialStatus,

  // Drift detection
  computeMCPDrifts,

  // Classification
  classifyMCPServer,

  // Tool bundle analysis
  analyzeToolBundle,

  // Main diff function
  diffMCPServers,

  // Formatting
  formatMCPDiffSummary,
  formatMCPDiffDetails,
  formatMCPDiffAsJson,
} from './diff.js';

// =============================================================================
// Report functions from report.ts
// =============================================================================

export {
  // Setup instructions generation
  generateServerSetupInstructions,

  // Report generation
  generateSetupReport,

  // Report formatting
  formatSetupReport,
  formatSetupReportMarkdown,
  formatSetupReportJson,
} from './report.js';

// =============================================================================
// Bundle functions from bundles.ts
// =============================================================================

// Types (excluding AgentRole and ToolRefType which are exported from types.ts)
export type {
  ToolRef,
  ConditionalToolSet,
  ToolBundleDefinition,
  ResolvedBundle,
  ToolRefStatus,
  AttachmentContext,
  BundleAttachmentResult,
} from './bundles.js';

// Constants
export {
  BUILTIN_MEMORY_TOOLS,
  BUILTIN_COMMUNICATION_TOOLS,
  BUILTIN_TOOLS,
  // Pre-defined bundles
  CORE_MEMORY_BUNDLE,
  LANE_DEVELOPER_BUNDLE,
  REPO_CURATOR_BUNDLE,
  ORG_CURATOR_BUNDLE,
  SUPERVISOR_BUNDLE,
  PREDEFINED_BUNDLES,
  ROLE_BUNDLE_MAP,
} from './bundles.js';

// MCP bundle creation
export {
  createMCPToolBundle,
  createGitHubToolsBundle,
  createSlackToolsBundle,
} from './bundles.js';

// Bundle registry and resolution
export {
  BundleRegistry,
  resolveBundle,
  evaluateCondition,
  resolveBundleWithContext,
  checkBundleStatus,
} from './bundles.js';

// Bundle attachment
export {
  getToolsForRole,
  legacyBundleToDefinition,
  definitionToLegacyBundle,
} from './bundles.js';

// Utilities
export {
  validateBundleDefinition,
  formatBundleStatus,
  formatBundleStatusJson,
} from './bundles.js';
