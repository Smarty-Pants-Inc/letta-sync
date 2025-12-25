/**
 * Identity reconciler module
 * 
 * Provides idempotent identity lookup and creation operations.
 * Based on the Identity Naming and Org Scoping Specification.
 * 
 * @module reconcilers/identities
 */

// Types
export type {
  IdentityType,
  IdentityProperty,
  LettaIdentity,
  IdentityCreateInput,
  IdentifierKeyComponents,
  LookupResult,
  EnsureResult,
  EnsureOptions,
  CreationSource,
} from './types.js';

export {
  AUTO_CREATE_POLICY,
  IDENTIFIER_KEY_REGEX,
  ORG_SLUG_REGEX,
  HANDLE_REGEX,
  IdentityValidationError,
  IdentityNotFoundError,
  AutoCreateNotAllowedError,
} from './types.js';

// Lookup operations
export type { LettaIdentityClient } from './lookup.js';

export {
  buildIdentifierKey,
  parseIdentifierKey,
  validateIdentifierKeyComponents,
  isValidIdentifierKey,
  normalizeHandle,
  lookupByIdentifierKey,
  lookupByComponents,
  resolveAndLookup,
  listIdentities,
} from './lookup.js';

// Ensure operations
export type { LettaIdentityClientWithCreate } from './ensure.js';

export {
  isAutoCreateAllowed,
  ensureIdentity,
  ensureIdentityByComponents,
  ensureUserIdentity,
  ensureServiceIdentity,
  ensureTeamIdentity,
  resolveAndEnsure,
  upsertIdentity,
} from './ensure.js';
