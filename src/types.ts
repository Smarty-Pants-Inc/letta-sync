/**
 * Shared types and interfaces for letta-sync CLI
 */

// ============================================================================
// Project Configuration Types
// ============================================================================

/**
 * Project configuration stored in .letta/project.json
 */
export interface ProjectConfig {
  /** Project slug (human-readable identifier) */
  slug?: string;
  /** Project ID (API identifier) */
  id?: string;
  /** Project display name */
  name?: string;
  /** Optional organization slug/id this project belongs to */
  org?: string;
}

/**
 * Resolved project information after resolution chain
 */
export interface ResolvedProject {
  /** Project slug */
  slug?: string;
  /** Project ID */
  id?: string;
  /** Project display name */
  name?: string;
}

/**
 * Project registry mapping repos to projects
 */
export interface ProjectRegistry {
  /** Version of the registry format */
  version: '1.0';
  /** Default project when no mapping found */
  defaultProject?: ResolvedProject;
  /** Mapping of repo identifiers to project info */
  mappings: Record<string, ProjectMapping>;
}

/**
 * Single repo-to-project mapping entry
 */
export interface ProjectMapping {
  /** Target project ID */
  projectId?: string;
  /** Target project slug */
  projectSlug?: string;
  /** Project display name */
  projectName?: string;
  /** Optional branch-specific overrides */
  branchOverrides?: Record<string, Partial<ProjectMapping>>;
}

/**
 * Source of project resolution
 */
export type ProjectResolutionSource = 
  | 'cli'
  | 'env'
  | 'local_config'
  | 'registry'
  | 'default';

// ============================================================================
// Global Options and Context
// ============================================================================

/**
 * Global options available to all commands
 */
export interface GlobalOptions {
  /** Target Letta project slug or ID */
  project?: string;
  /** Target organization slug */
  org?: string;
  /** Target specific agent ID */
  agent?: string;
  /** Don't apply changes, just show what would happen */
  dryRun: boolean;
  /** Output JSON for CI/automation */
  json: boolean;
  /** Release channel: stable, beta, or pinned */
  channel: Channel;
  /** Enable verbose logging */
  verbose: boolean;
}

/**
 * Release channels for agent configurations
 */
export type Channel = 'stable' | 'beta' | 'pinned';

/**
 * Result of a command execution
 */
export interface CommandResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: string[];
}

/**
 * Represents a difference between local and remote configuration
 */
export interface ConfigDiff {
  path: string;
  type: 'added' | 'removed' | 'modified';
  localValue?: unknown;
  remoteValue?: unknown;
}

/**
 * Represents a version difference for applied packages
 */
export interface VersionDiff {
  /** Package layer (base, org, project) */
  layer: string;
  /** Current applied SHA (null if not applied) */
  currentSha: string | null;
  /** Desired/target SHA */
  desiredSha: string;
  /** Type of change */
  type: 'upgrade' | 'downgrade' | 'initial';
}

/**
 * Applied package version summary for display
 */
export interface AppliedVersionSummary {
  /** Package layer (base, org, project) */
  layer: string;
  /** Short SHA of applied version */
  sha: string;
  /** ISO 8601 timestamp when applied */
  appliedAt?: string;
  /** Path to package in Git */
  packagePath?: string;
}

/**
 * Applied state summary for an agent
 */
export interface AppliedStateSummary {
  /** Whether this agent is managed by smarty-admin */
  isManaged: boolean;
  /** Applied versions by layer */
  appliedVersions: AppliedVersionSummary[];
  /** Last upgrade timestamp */
  lastUpgradeAt?: string;
  /** Last upgrade type */
  lastUpgradeType?: string;
  /** Reconciler version that last modified state */
  reconcilerVersion?: string;
  /** Whether managed_state block exists */
  hasManagedStateBlock: boolean;
}

/**
 * Agent configuration status
 */
export interface AgentStatus {
  agentId: string;
  agentName: string;
  project: string;
  org: string;
  channel: Channel;
  lastSync?: string;
  hasLocalChanges: boolean;
  configVersion: string;
  /** Applied state information */
  appliedState?: AppliedStateSummary;
}

/**
 * A single sync action (what smarty-admin actually did or would do)
 */
export interface SyncChange {
  resource: 'block' | 'tool' | 'folder' | 'identity' | 'agent';
  name: string;
  action: 'create' | 'update' | 'none';
  reason?: string;
}

/**
 * Sync operation result
 */
export interface SyncResult {
  applied: SyncChange[];
  skipped: SyncChange[];
  errors: string[];
}

/**
 * Bootstrap configuration for new agents
 */
export interface BootstrapConfig {
  agentName: string;
  template?: string;
  systemPrompt?: string;
  tools?: string[];
  memoryBlocks?: Record<string, string>;
  /** Identity handles or identifier_keys to attach */
  identities?: string[];
  /** Resolved identity IDs after bootstrap */
  identityIds?: string[];
  /** Tags applied to the agent */
  tags?: string[];
  /** Template information (when using template-based creation) */
  templateInfo?: {
    id: string;
    baseTemplateId: string;
    templateId: string;
    name: string;
  };
  /** Scope sync result (if scope sync was run) */
  scopeSync?: {
    matchedScopes?: string[];
    focusScope?: string | null;
  };
}

/**
 * Upgrade information
 */
export interface UpgradeInfo {
  currentVersion: string;
  targetVersion: string;
  changes: string[];
  breakingChanges: string[];
  migrationSteps: string[];
  /** Identity validation status */
  identityValidation?: IdentityValidationInfo;
}

/**
 * Identity validation information for upgrades
 */
export interface IdentityValidationInfo {
  valid: boolean;
  currentIdentities: string[];
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Output format type
 */
export type OutputFormat = 'human' | 'json';

// ============================================================================
// Project-Level Batch Operation Types
// ============================================================================

/**
 * Valid agent roles for filtering and selection
 */
export type AgentRole = 'lane-dev' | 'repo-curator' | 'org-curator' | 'supervisor';

/**
 * Selection criteria for batch agent operations
 */
export interface BatchSelectionCriteria {
  /** Only select managed agents (default: true) */
  managedOnly?: boolean;
  /** Filter by agent roles */
  roles?: AgentRole[];
  /** Filter by update channels */
  channels?: Channel[];
  /** Filter by project slug */
  project?: string;
  /** Filter by organization slug */
  org?: string;
  /** Filter by agent name pattern (glob-style) */
  namePattern?: string;
}

/**
 * Result of a batch operation on multiple agents
 */
export interface BatchOperationResult<T = unknown> {
  /** Whether the overall operation succeeded */
  success: boolean;
  /** Summary message */
  message: string;
  /** Total agents processed */
  totalAgents: number;
  /** Number of successful operations */
  successCount: number;
  /** Number of failed operations */
  failureCount: number;
  /** Number of skipped operations */
  skippedCount: number;
  /** Individual results per agent */
  results: BatchAgentResult<T>[];
  /** Global errors */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

/**
 * Result for a single agent in a batch operation
 */
export interface BatchAgentResult<T = unknown> {
  /** Agent ID */
  agentId: string;
  /** Agent name */
  agentName: string;
  /** Whether this agent's operation succeeded */
  success: boolean;
  /** Status of this operation */
  status: 'applied' | 'skipped' | 'failed' | 'up-to-date';
  /** Operation-specific result data */
  data?: T;
  /** Error message if failed */
  error?: string;
  /** Duration of this operation in ms */
  durationMs?: number;
}

/**
 * Options for batch upgrade operations
 */
export interface BatchUpgradeOptions {
  /** Target version to upgrade to (default: latest) */
  targetVersion?: string;
  /** Force breaking changes without confirmation */
  force?: boolean;
  /** Skip confirmation prompts */
  yes?: boolean;
  /** Maximum concurrent upgrades */
  concurrency?: number;
  /** Stop on first failure */
  failFast?: boolean;
  /** Validate identities during upgrade */
  validateIdentities?: boolean;
}

/**
 * Progress callback for batch operations
 */
export type BatchProgressCallback = (progress: BatchProgress) => void;

/**
 * Progress information for batch operations
 */
export interface BatchProgress {
  /** Current agent being processed */
  currentAgent: string;
  /** Index of current agent (1-based) */
  current: number;
  /** Total number of agents */
  total: number;
  /** Percentage complete (0-100) */
  percentage: number;
  /** Elapsed time in ms */
  elapsedMs: number;
  /** Estimated remaining time in ms */
  estimatedRemainingMs?: number;
}

/**
 * Command context passed to command handlers
 */
export interface CommandContext {
  /** Parsed global CLI options */
  options: GlobalOptions;
  /** Output format for results */
  outputFormat: OutputFormat;
  /** Resolved project (if available) */
  project?: ResolvedProject;
  /** How the project was resolved */
  projectSource?: ProjectResolutionSource;
}

// ============================================================================
// API Request Types
// ============================================================================

/**
 * Headers for Letta API requests including project targeting
 */
export interface LettaRequestHeaders {
  /** Authorization header */
  Authorization?: string;
  /** Project targeting header */
  'X-Project'?: string;
  /** Organization targeting header */
  'X-Organization'?: string;
  /** Content type */
  'Content-Type'?: string;
}
