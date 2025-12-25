/**
 * Agent reconciler module
 *
 * Provides state management, version tracking, identity management,
 * upgrade planning, and upgrade application for managed agents.
 *
 * @module reconcilers/agents
 */

export * from './state.js';
export * from './tracking.js';
export * from './identity.js';
export * from './upgrade-plan.js';
export * from './upgrade-apply.js';

// Re-export key types for convenience
export type {
  PackageLayer,
  UpgradeType,
  UpgradeChannel,
  AppliedPackageInfo,
  ManagedState,
} from './state.js';

export type {
  AppliedVersionTag,
  ParsedAgentTags,
  ReservedTagNamespace,
} from './tracking.js';

export type {
  AttachIdentityOptions,
  AttachIdentityResult,
  IdentityInputValidation,
  AgentIdentityValidation,
  LettaAgentIdentityClient,
} from './identity.js';

