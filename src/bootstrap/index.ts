/**
 * Bootstrap module exports
 * Provides project resolution, git utilities, and agent creation
 */

// Error types
export {
  ProjectResolutionError,
  NotInGitRepoError,
  GitNotAvailableError,
  RepoNotRegisteredError,
  AmbiguousProjectError,
  RegistryReadError,
  GitCommandError,
  isProjectResolutionError,
  formatError,
} from './errors.js';

// Git utilities
export {
  type GitRepoInfo,
  isGitAvailable,
  findGitRoot,
  getMainRepoPath,
  isWorktree,
  getRemoteUrl,
  getCurrentBranch,
  normalizeRemoteUrl,
  getGitRepoInfo,
} from './git.js';

// Project resolver
export {
  type RegistryEntry,
  type ProjectRegistry,
  type ResolvedProject,
  type ResolveOptions,
  getDefaultRegistryPath,
  loadRegistry,
  resolveProject,
  tryResolveProject,
  createRegistryEntry,
} from './project-resolver.js';

// Agent creation from templates
export {
  // Types
  type TemplateInfo,
  type CreateAgentOptions,
  type CreateAgentResult,
  type AgentCreationClient,
  type AgentState,
  type CreateAgentParams,
  type UpdateAgentParams,
  type LettaIdentity,
  type TemplateResolutionResult,
  // Tag utilities
  TAG_PREFIXES,
  buildAgentTags,
  parseAgentTags,
  // Template resolution
  resolveTemplate,
  // Agent operations
  findExistingAgent,
  generateDeploymentId,
  generateEntityId,
  createAgentFromTemplate,
  previewAgentCreation,
} from './create-agent.js';

// Auto-upgrade
export {
  type AutoUpgradeCheckResult,
  type AutoUpgradeResult,
  type AutoUpgradeOptions,
  isInteractiveTTY,
  checkForUpgrade,
  runAutoUpgrade,
  formatAutoUpgradeResult,
} from './auto-upgrade.js';

// Exec Letta
export {
  LettaNotFoundError,
  MissingApiKeyError,
  type ExecLettaOptions,
  type LettaPathResult,
  findLettaExecutable,
  buildLettaEnvironment,
  validateExecConfig,
  buildLettaArgs,
  execLetta,
  execLettaSync,
  checkLettaAvailability,
} from './exec-letta.js';

// Project settings (letta-code compatible)
export {
  type ProjectSettings,
  getLettaDir,
  getProjectSettingsPath,
  ensureLettaDir,
  loadProjectSettings,
  saveProjectSettings,
  updateProjectSettings,
  projectSettingsExist,
  deleteProjectSettings,
} from './settings.js';

// Agent pinning
export {
  type PinResult,
  type PinOptions,
  pinAgent,
  unpinAgent,
  getPinnedAgent,
  getPinState,
  isPinned,
} from './pinning.js';

// Gitignore utilities
export {
  type GitignoreResult,
  type GitignoreOptions,
  checkGitignore,
  ensureGitignore,
  isSettingsFileSafe,
} from './gitignore.js';

// Scope sync
export {
  type ScopeSyncOptions,
  type ScopeSyncResult,
  runScopeSync,
  runScopeSyncBestEffort,
} from './scope-sync.js';
