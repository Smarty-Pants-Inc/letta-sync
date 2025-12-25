/**
 * Identity ensure operations (idempotent create-if-not-exists)
 * 
 * Provides idempotent operations for ensuring identities exist.
 * Based on the Identity Naming and Org Scoping Specification.
 * 
 * Key behaviors:
 * - Lookup by identifier_key first
 * - Create only if not found (and policy allows)
 * - Return existing identity if found (idempotent)
 * - Auto-create allowed for 'user' type only by default
 */

import type {
  LettaIdentity,
  IdentityType,
  IdentifierKeyComponents,
  IdentityProperty,
  EnsureResult,
  EnsureOptions,
} from './types.js';
import {
  AUTO_CREATE_POLICY,
  IdentityNotFoundError,
  AutoCreateNotAllowedError,
} from './types.js';
import type { LettaIdentityClient } from './lookup.js';
import {
  buildIdentifierKey,
  parseIdentifierKey,
  normalizeHandle,
  isValidIdentifierKey,
  lookupByIdentifierKey,
  lookupByComponents,
} from './lookup.js';

/**
 * Extended Letta client interface for identity creation
 */
export interface LettaIdentityClientWithCreate extends LettaIdentityClient {
  identities: LettaIdentityClient['identities'] & {
    create(params: {
      name: string;
      identifier_key: string;
      identity_type?: IdentityType;
      properties?: IdentityProperty[];
      metadata?: Record<string, unknown>;
    }): Promise<LettaIdentity>;
    
    upsert(params: {
      name: string;
      identifier_key: string;
      identity_type?: IdentityType;
      properties?: IdentityProperty[];
      metadata?: Record<string, unknown>;
    }): Promise<LettaIdentity>;
  };
}

/**
 * Build metadata for auto-created identities
 * 
 * @param source - The source of the creation (e.g., 'git-commit', 'agent-bootstrap')
 * @param additionalMetadata - Additional metadata to merge
 */
function buildAutoCreateMetadata(
  source: string,
  additionalMetadata?: Record<string, unknown>
): Record<string, unknown> {
  return {
    managed_by: 'smarty-admin',
    auto_created: true,
    created_at: new Date().toISOString(),
    created_by: source,
    ...additionalMetadata,
  };
}

/**
 * Derive a display name from a handle
 * 
 * Converts handle format to a human-readable name:
 * - paulbettner -> paulbettner (keep as-is for simple handles)
 * - paul_bettner -> Paul Bettner
 * - github-actions -> GitHub Actions
 */
function deriveDisplayName(handle: string, identityType: IdentityType): string {
  // For services, use title case with proper formatting
  if (identityType === 'service') {
    return handle
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  // For users and teams, return as-is (users can update their display name later)
  return handle;
}

/**
 * Check if auto-creation is allowed for the given identity type
 */
export function isAutoCreateAllowed(
  identityType: IdentityType,
  options?: EnsureOptions
): boolean {
  // If explicitly specified in options, use that
  if (options?.autoCreate !== undefined) {
    return options.autoCreate;
  }

  // Otherwise, use the default policy
  return AUTO_CREATE_POLICY[identityType];
}

/**
 * Ensure an identity exists, creating it if not found
 * 
 * This is the main idempotent operation. Running it multiple times
 * with the same identifier_key will always return the same identity.
 * 
 * @param client - Letta client instance with create capability
 * @param identifier_key - The full identifier_key for the identity
 * @param options - Options for creation if needed
 * @returns EnsureResult with the identity and whether it was created
 * 
 * @throws IdentityNotFoundError if not found and auto-create disabled
 * @throws AutoCreateNotAllowedError if type doesn't allow auto-creation
 */
export async function ensureIdentity(
  client: LettaIdentityClientWithCreate,
  identifier_key: string,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  // First, try to look up the existing identity
  const lookupResult = await lookupByIdentifierKey(client, identifier_key);

  if (lookupResult.found && lookupResult.identity) {
    // Identity exists - return it (idempotent behavior)
    return {
      identity: lookupResult.identity,
      created: false,
      identifier_key,
    };
  }

  // Identity not found - check if we should create it
  const components = parseIdentifierKey(identifier_key);
  const { type: identityType, handle } = components;

  // Check auto-creation policy
  const canAutoCreate = isAutoCreateAllowed(identityType, options);
  
  if (!canAutoCreate) {
    // If auto-create is not explicitly allowed and type default is false
    if (options.autoCreate === false) {
      throw new IdentityNotFoundError(identifier_key, identityType);
    }
    throw new AutoCreateNotAllowedError(identifier_key, identityType);
  }

  // Create the identity
  const displayName = options.defaultName ?? deriveDisplayName(handle, identityType);
  const metadata = buildAutoCreateMetadata(
    options.createdBy ?? 'api-direct',
    options.metadata
  );

  const newIdentity = await client.identities.create({
    name: displayName,
    identifier_key,
    identity_type: identityType,
    properties: options.properties ?? [],
    metadata,
  });

  return {
    identity: newIdentity,
    created: true,
    identifier_key,
  };
}

/**
 * Ensure an identity exists using component parts
 * 
 * Convenience wrapper that builds the identifier_key from components.
 * 
 * @param client - Letta client instance
 * @param components - The identifier_key components
 * @param options - Options for creation if needed
 */
export async function ensureIdentityByComponents(
  client: LettaIdentityClientWithCreate,
  components: IdentifierKeyComponents,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  const identifier_key = buildIdentifierKey(components);
  return ensureIdentity(client, identifier_key, options);
}

/**
 * Ensure a user identity exists for the given handle
 * 
 * Simplified interface for the most common case: ensuring a user identity.
 * User identities are auto-created by default.
 * 
 * @param client - Letta client instance
 * @param org - Organization slug
 * @param handle - User handle (will be normalized)
 * @param options - Additional options
 */
export async function ensureUserIdentity(
  client: LettaIdentityClientWithCreate,
  org: string,
  handle: string,
  options: Omit<EnsureOptions, 'autoCreate'> & { autoCreate?: boolean } = {}
): Promise<EnsureResult> {
  const normalizedHandle = normalizeHandle(handle);
  
  return ensureIdentityByComponents(client, {
    org,
    type: 'user',
    handle: normalizedHandle,
  }, {
    ...options,
    autoCreate: options.autoCreate ?? true, // Users default to auto-create
  });
}

/**
 * Ensure a service identity exists
 * 
 * Service identities are NOT auto-created by default.
 * Set autoCreate: true explicitly if needed.
 * 
 * @param client - Letta client instance
 * @param org - Organization slug
 * @param serviceName - Service name/handle
 * @param options - Additional options (must set autoCreate: true to create)
 */
export async function ensureServiceIdentity(
  client: LettaIdentityClientWithCreate,
  org: string,
  serviceName: string,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  const normalizedName = normalizeHandle(serviceName);
  
  return ensureIdentityByComponents(client, {
    org,
    type: 'service',
    handle: normalizedName,
  }, options);
}

/**
 * Ensure a team identity exists
 * 
 * Team identities are NOT auto-created by default.
 * Set autoCreate: true explicitly if needed.
 * 
 * @param client - Letta client instance
 * @param org - Organization slug
 * @param teamName - Team name/handle
 * @param options - Additional options (must set autoCreate: true to create)
 */
export async function ensureTeamIdentity(
  client: LettaIdentityClientWithCreate,
  org: string,
  teamName: string,
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  const normalizedName = normalizeHandle(teamName);
  
  return ensureIdentityByComponents(client, {
    org,
    type: 'team',
    handle: normalizedName,
  }, options);
}

/**
 * Resolve a raw input and ensure the identity exists
 * 
 * This handles fallback resolution for backwards compatibility:
 * - If input matches identifier_key format, use directly
 * - If input is email, extract local part
 * - If input has provider prefix, extract handle
 * - Otherwise, treat as simple handle
 * 
 * @param client - Letta client instance
 * @param rawInput - Raw input (handle, email, or full identifier_key)
 * @param defaultOrg - Default org to use if not in identifier_key format
 * @param defaultType - Default type to use (defaults to 'user')
 * @param options - Ensure options
 */
export async function resolveAndEnsure(
  client: LettaIdentityClientWithCreate,
  rawInput: string,
  defaultOrg: string,
  defaultType: IdentityType = 'user',
  options: EnsureOptions = {}
): Promise<EnsureResult> {
  // If it already matches the full identifier_key format, use directly
  if (isValidIdentifierKey(rawInput)) {
    return ensureIdentity(client, rawInput, options);
  }

  // Normalize the handle and construct identifier_key
  const normalizedHandle = normalizeHandle(rawInput);
  
  return ensureIdentityByComponents(client, {
    org: defaultOrg,
    type: defaultType,
    handle: normalizedHandle,
  }, options);
}

/**
 * Upsert an identity (create or update)
 * 
 * Unlike ensure, upsert will update the identity if it exists.
 * Use this when you want to ensure the identity has specific properties.
 * 
 * @param client - Letta client instance
 * @param identifier_key - The full identifier_key
 * @param data - Identity data to set
 */
export async function upsertIdentity(
  client: LettaIdentityClientWithCreate,
  identifier_key: string,
  data: {
    name: string;
    identity_type?: IdentityType;
    properties?: IdentityProperty[];
    metadata?: Record<string, unknown>;
  }
): Promise<EnsureResult> {
  const components = parseIdentifierKey(identifier_key);
  
  // Check if the identity exists first for accurate `created` flag
  const lookupResult = await lookupByIdentifierKey(client, identifier_key);
  const existedBefore = lookupResult.found;

  // Use upsert API
  const identity = await client.identities.upsert({
    name: data.name,
    identifier_key,
    identity_type: data.identity_type ?? components.type,
    properties: data.properties ?? [],
    metadata: data.metadata,
  });

  return {
    identity,
    created: !existedBefore,
    identifier_key,
  };
}
