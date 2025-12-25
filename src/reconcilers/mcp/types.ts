/**
 * Types for MCP server reconciliation
 *
 * MCP servers are OBSERVE-ONLY due to credential handling requirements.
 * This reconciler detects drift and generates manual setup instructions
 * rather than auto-applying changes.
 *
 * Based on: docs/research/tools-mcp-research.md
 */

import type {
  MCPServerSpec,
  MCPServerType,
  StdioConfig,
} from '../../packages/types.js';

// =============================================================================
// MCP Server State Types
// =============================================================================

/**
 * MCP server transport type (re-export for convenience)
 */
export type { MCPServerType };

/**
 * MCP server ownership classification
 */
export enum MCPServerOwnership {
  /** Server matches manifest definition */
  MANAGED = 'managed',
  /** Server exists but not in manifest */
  UNMANAGED = 'unmanaged',
  /** Server in manifest but not configured in Letta */
  MISSING = 'missing',
  /** Server exists but has configuration drift */
  DRIFTED = 'drifted',
}

/**
 * Credential status for an MCP server
 */
export enum CredentialStatus {
  /** No credentials required */
  NONE = 'none',
  /** Credentials present (token/headers) */
  PRESENT = 'present',
  /** Credentials reference secrets */
  SECRET_REF = 'secret_ref',
  /** OAuth authentication */
  OAUTH = 'oauth',
  /** Unknown credential state */
  UNKNOWN = 'unknown',
}

/**
 * MCP server record from Letta API
 */
export interface MCPServerRecord {
  /** Server ID */
  id: string;
  /** Server name (unique per org) */
  serverName: string;
  /** Transport type */
  serverType: MCPServerType;
  /** Server URL (for SSE/HTTP) */
  serverUrl?: string;
  /** Whether token is configured */
  hasToken?: boolean;
  /** Whether custom headers are configured */
  hasCustomHeaders?: boolean;
  /** Stdio configuration */
  stdioConfig?: StdioConfig;
  /** Organization ID */
  organizationId?: string;
  /** Created timestamp */
  createdAt?: string;
  /** Updated timestamp */
  updatedAt?: string;
}

/**
 * MCP server manifest entry (from Git configuration)
 * Based on MCPServerSpec but without credential values
 */
export interface MCPServerManifestEntry {
  /** Server name (unique identifier) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Transport type */
  serverType: MCPServerType;
  /** Server URL (for SSE/HTTP) */
  serverUrl?: string;
  /** Reference to secret for token */
  tokenSecretRef?: string;
  /** Reference to secret for headers */
  customHeadersSecretRef?: string;
  /** Stdio configuration (for stdio type) */
  stdioConfig?: StdioConfig;
  /** Whether this server is managed by reconciler */
  managed?: boolean;
  /** Source path in Git repo */
  sourcePath?: string;
  /** Tool attachment bundle reference */
  toolBundle?: string;
}

// =============================================================================
// Tool Attachment Types
// =============================================================================

/**
 * Tool attachment bundle - tools that should be attached when server is ready
 * (Legacy interface for backward compatibility)
 */
export interface ToolAttachmentBundle {
  /** Bundle name */
  name: string;
  /** MCP server this bundle is for */
  mcpServerName: string;
  /** Tool names to attach from this MCP server */
  tools: string[];
  /** Description of bundle purpose */
  description?: string;
}

/**
 * Status of a tool attachment bundle
 * (Legacy interface for backward compatibility)
 */
export interface ToolBundleStatus {
  /** Bundle name */
  bundleName: string;
  /** MCP server name */
  mcpServerName: string;
  /** Whether the MCP server is configured */
  serverConfigured: boolean;
  /** Number of tools available */
  toolsAvailable: number;
  /** Number of tools in bundle definition */
  toolsExpected: number;
  /** Tools that are missing */
  missingTools: string[];
  /** Whether bundle can be attached */
  ready: boolean;
}

// =============================================================================
// Enhanced Bundle Types (Role-Based)
// =============================================================================

/**
 * Agent role classification
 */
export type AgentRole = 'lane-dev' | 'repo-curator' | 'org-curator' | 'supervisor' | 'shared';

/**
 * Bundle category classification
 */
export type BundleCategory = 'core' | 'development' | 'curation' | 'management' | 'communication';

/**
 * Tool reference type in enhanced bundles
 */
export type ToolRefType = 'builtin' | 'custom' | 'mcp';

/**
 * Enhanced tool reference with type information
 */
export interface EnhancedToolRef {
  /** Tool name reference */
  ref: string;
  /** Tool type (builtin, custom, mcp) */
  type: ToolRefType;
  /** MCP server name (required for mcp type) */
  mcpServer?: string;
  /** Whether tool is required (default varies by type) */
  required?: boolean;
  /** Description override */
  description?: string;
}

/**
 * Role-based tool bundle manifest entry
 */
export interface RoleBundleManifestEntry {
  /** Bundle name (unique identifier) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Target agent role */
  role: AgentRole;
  /** Bundle category */
  category: BundleCategory;
  /** Parent bundles to inherit tools from */
  extends?: string[];
  /** Tool references */
  tools: EnhancedToolRef[];
  /** Bundle version */
  version?: string;
  /** Whether this is managed by reconciler */
  managed?: boolean;
}

/**
 * Enhanced bundle status with detailed tool info
 */
export interface EnhancedBundleStatus {
  /** Bundle name */
  bundleName: string;
  /** Target role */
  role: AgentRole;
  /** Total tools in bundle (including inherited) */
  totalTools: number;
  /** Available tools count */
  availableTools: number;
  /** Missing required tools count */
  missingRequiredTools: number;
  /** Missing optional tools count */
  missingOptionalTools: number;
  /** Whether bundle is ready for attachment */
  ready: boolean;
  /** Detailed tool status */
  toolDetails: {
    ref: string;
    type: ToolRefType;
    available: boolean;
    required: boolean;
    mcpServer?: string;
    unavailableReason?: string;
  }[];
  /** Warnings */
  warnings: string[];
  /** Errors */
  errors: string[];
}

// =============================================================================
// Drift Detection Types
// =============================================================================

/**
 * Types of drift that can occur between desired and actual MCP server state
 */
export type MCPDriftType =
  | 'server_type'     // Transport type differs
  | 'server_url'      // URL differs
  | 'credentials'     // Credential configuration differs
  | 'stdio_config'    // Stdio configuration differs
  | 'missing'         // Server not configured
  | 'extra';          // Server configured but not in manifest

/**
 * Represents a single drift (difference) in an MCP server field
 */
export interface MCPServerDrift {
  /** Type of drift detected */
  type: MCPDriftType;
  /** Field name */
  field: string;
  /** Current value in Letta (if available) */
  actual?: unknown;
  /** Expected value from manifest (if available) */
  desired?: unknown;
  /** Human-readable description */
  description: string;
  /** Whether this drift requires credentials */
  requiresCredentials: boolean;
}

// =============================================================================
// Diff Result Types
// =============================================================================

/**
 * Classification result for a single MCP server
 */
export interface MCPServerClassification {
  /** Server name */
  name: string;
  /** Ownership status */
  ownership: MCPServerOwnership;
  /** Credential status */
  credentialStatus: CredentialStatus;
  /** Detected drifts */
  drifts: MCPServerDrift[];
  /** Reason for classification */
  reason: string;
  /** Manifest entry (if exists) */
  manifest?: MCPServerManifestEntry;
  /** Actual server record (if exists) */
  actual?: MCPServerRecord;
}

/**
 * Summary statistics for MCP diff
 */
export interface MCPDiffSummary {
  /** Servers fully configured and matching */
  configured: number;
  /** Servers with configuration drift */
  drifted: number;
  /** Servers in manifest but not in Letta */
  missing: number;
  /** Servers in Letta but not in manifest */
  unmanaged: number;
  /** Total servers */
  total: number;
}

/**
 * Complete MCP diff result
 */
export interface MCPDiffResult {
  /** Timestamp when diff was computed */
  timestamp: string;
  /** Unique identifier for this diff operation */
  diffId: string;
  /** Organization context */
  org?: string;
  /** Whether any servers need attention */
  hasIssues: boolean;
  /** Classification results for each server */
  servers: MCPServerClassification[];
  /** Summary statistics */
  summary: MCPDiffSummary;
  /** Tool bundle status */
  toolBundles: ToolBundleStatus[];
  /** Errors encountered during diff */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
}

// =============================================================================
// Diff Options
// =============================================================================

/**
 * Options for the MCP diff operation
 */
export interface MCPDiffOptions {
  /** Include unmanaged servers in the diff */
  includeUnmanaged?: boolean;
  /** Only show servers with issues */
  issuesOnly?: boolean;
  /** Filter by server name */
  serverNames?: string[];
  /** Filter by server type */
  serverType?: MCPServerType;
  /** Include tool bundle analysis */
  includeToolBundles?: boolean;
}

// =============================================================================
// Manual Setup Types
// =============================================================================

/**
 * Setup step for manual configuration
 */
export interface SetupStep {
  /** Step number */
  step: number;
  /** Action to take */
  action: string;
  /** Detailed instructions */
  details?: string;
  /** CLI command if applicable */
  command?: string;
  /** Whether this step requires credentials */
  requiresCredentials: boolean;
}

/**
 * Manual setup instructions for an MCP server
 */
export interface MCPSetupInstructions {
  /** Server name */
  serverName: string;
  /** Server type */
  serverType: MCPServerType;
  /** Server URL (for SSE/HTTP) */
  serverUrl?: string;
  /** Setup steps */
  steps: SetupStep[];
  /** Credential requirements */
  credentialRequirements: string[];
  /** Alternative approaches */
  alternatives?: string[];
  /** Related documentation links */
  docsLinks?: string[];
}

/**
 * Complete manual setup report
 */
export interface MCPSetupReport {
  /** Timestamp when report was generated */
  timestamp: string;
  /** Organization context */
  org?: string;
  /** Number of servers needing setup */
  serversNeedingSetup: number;
  /** Setup instructions per server */
  instructions: MCPSetupInstructions[];
  /** Global notes */
  notes: string[];
  /** Whether any servers require OAuth */
  hasOAuthServers: boolean;
  /** Whether any servers have credential requirements */
  hasCredentialRequirements: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Environment variables that likely contain secrets
 * Used for filtering stdio env vars
 */
export const LIKELY_SECRET_ENV_PATTERNS = [
  'KEY',
  'SECRET',
  'TOKEN',
  'PASSWORD',
  'CREDENTIAL',
  'AUTH',
  'API_KEY',
  'APIKEY',
] as const;

/**
 * Check if an environment variable name likely contains a secret
 */
export function isLikelySecretEnv(envName: string): boolean {
  const upperName = envName.toUpperCase();
  return LIKELY_SECRET_ENV_PATTERNS.some(pattern =>
    upperName.includes(pattern)
  );
}
