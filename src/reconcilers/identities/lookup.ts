/**
 * Identity lookup operations
 * 
 * Provides functions for searching and looking up identities by identifier_key.
 * Based on the Identity Naming and Org Scoping Specification.
 */

import type {
  LettaIdentity,
  IdentityType,
  IdentifierKeyComponents,
  LookupResult,
} from './types.js';
import {
  IDENTIFIER_KEY_REGEX,
  ORG_SLUG_REGEX,
  HANDLE_REGEX,
  IdentityValidationError,
} from './types.js';

/**
 * Letta client interface for identity operations
 * This matches the @letta-ai/letta-client SDK interface
 */
export interface LettaIdentityClient {
  identities: {
    list(params: {
      identifier_key?: string;
      name?: string;
      identity_type?: IdentityType;
      limit?: number;
    }): Promise<LettaIdentity[]>;
  };
}

/**
 * Construct an identifier_key from its components
 * 
 * Format: org:<org_slug>:<type>:<handle>
 * Example: org:smarty-pants:user:paulbettner
 */
export function buildIdentifierKey(components: IdentifierKeyComponents): string {
  validateIdentifierKeyComponents(components);
  return `org:${components.org}:${components.type}:${components.handle}`;
}

/**
 * Parse an identifier_key into its components
 * 
 * @throws IdentityValidationError if the key format is invalid
 */
export function parseIdentifierKey(identifier_key: string): IdentifierKeyComponents {
  if (!IDENTIFIER_KEY_REGEX.test(identifier_key)) {
    throw new IdentityValidationError(
      `Invalid identifier_key format: ${identifier_key}. ` +
      `Expected format: org:<org_slug>:<type>:<handle>`,
      'identifier_key',
      identifier_key
    );
  }

  const parts = identifier_key.split(':');
  // Format: org:<org>:<type>:<handle>
  // parts = ['org', org_slug, type, handle]
  
  return {
    org: parts[1],
    type: parts[2] as IdentityType,
    handle: parts[3],
  };
}

/**
 * Validate identifier_key components
 * 
 * @throws IdentityValidationError if any component is invalid
 */
export function validateIdentifierKeyComponents(components: IdentifierKeyComponents): void {
  // Validate org slug
  if (!ORG_SLUG_REGEX.test(components.org)) {
    throw new IdentityValidationError(
      `Invalid org slug: "${components.org}". ` +
      `Must be 2-32 lowercase alphanumeric characters with hyphens, starting with a letter.`,
      'org',
      components.org
    );
  }

  // Validate type
  const validTypes: IdentityType[] = ['user', 'service', 'team'];
  if (!validTypes.includes(components.type)) {
    throw new IdentityValidationError(
      `Invalid identity type: "${components.type}". ` +
      `Must be one of: ${validTypes.join(', ')}`,
      'type',
      components.type
    );
  }

  // Validate handle
  if (!HANDLE_REGEX.test(components.handle)) {
    throw new IdentityValidationError(
      `Invalid handle: "${components.handle}". ` +
      `Must be 2-64 lowercase alphanumeric characters with hyphens/underscores, starting with alphanumeric.`,
      'handle',
      components.handle
    );
  }
}

/**
 * Validate that an identifier_key follows the correct format
 * 
 * @returns true if valid, false otherwise
 */
export function isValidIdentifierKey(identifier_key: string): boolean {
  return IDENTIFIER_KEY_REGEX.test(identifier_key);
}

/**
 * Normalize a raw handle to a valid format
 * 
 * Handles various input formats:
 * - Email: paul@example.com -> paul
 * - Provider prefix: github:PaulBettner -> paulbettner
 * - Mixed case: PaulBettner -> paulbettner
 * - Dots/spaces: paul.bettner, paul bettner -> paul_bettner
 */
export function normalizeHandle(raw: string): string {
  let handle = raw.toLowerCase();

  // Extract email local part
  if (handle.includes('@')) {
    handle = handle.split('@')[0];
  }

  // Remove provider prefix (e.g., github:)
  if (handle.includes(':')) {
    handle = handle.split(':').pop() || handle;
  }

  // Replace dots and spaces with underscores
  handle = handle.replace(/[.\s]+/g, '_');

  // Remove invalid characters (keep only alphanumeric, underscore, hyphen)
  handle = handle.replace(/[^a-z0-9_-]/g, '');

  // Ensure it starts with alphanumeric
  if (handle.length > 0 && !/^[a-z0-9]/.test(handle)) {
    handle = 'u_' + handle;
  }

  // Ensure minimum length
  if (handle.length < 2) {
    handle = 'user_' + handle;
  }

  // Truncate to max length
  return handle.slice(0, 64);
}

/**
 * Look up an identity by its exact identifier_key
 * 
 * @param client - Letta client instance
 * @param identifier_key - The full identifier_key to search for
 * @returns LookupResult with found status and identity if found
 */
export async function lookupByIdentifierKey(
  client: LettaIdentityClient,
  identifier_key: string
): Promise<LookupResult> {
  // Validate the identifier_key format
  if (!isValidIdentifierKey(identifier_key)) {
    throw new IdentityValidationError(
      `Invalid identifier_key format: ${identifier_key}`,
      'identifier_key',
      identifier_key
    );
  }

  const identities = await client.identities.list({
    identifier_key,
    limit: 1,
  });

  if (identities.length > 0) {
    return {
      found: true,
      identity: identities[0],
      identifier_key,
    };
  }

  return {
    found: false,
    identifier_key,
  };
}

/**
 * Look up an identity by its components
 * 
 * @param client - Letta client instance
 * @param components - The identifier_key components (org, type, handle)
 * @returns LookupResult with found status and identity if found
 */
export async function lookupByComponents(
  client: LettaIdentityClient,
  components: IdentifierKeyComponents
): Promise<LookupResult> {
  const identifier_key = buildIdentifierKey(components);
  return lookupByIdentifierKey(client, identifier_key);
}

/**
 * Resolve a raw handle to an identifier_key and look it up
 * 
 * This handles fallback resolution for backwards compatibility:
 * - If input matches identifier_key format, use directly
 * - If input is email, extract local part
 * - If input has provider prefix, extract handle
 * - Otherwise, treat as simple handle
 * 
 * @param client - Letta client instance
 * @param rawHandle - Raw input (handle, email, or full identifier_key)
 * @param defaultOrg - Default org to use if not in identifier_key format
 * @param defaultType - Default type to use (defaults to 'user')
 */
export async function resolveAndLookup(
  client: LettaIdentityClient,
  rawHandle: string,
  defaultOrg: string,
  defaultType: IdentityType = 'user'
): Promise<LookupResult> {
  // If it already matches the full identifier_key format, use directly
  if (isValidIdentifierKey(rawHandle)) {
    return lookupByIdentifierKey(client, rawHandle);
  }

  // Normalize the handle and construct identifier_key
  const normalizedHandle = normalizeHandle(rawHandle);
  
  return lookupByComponents(client, {
    org: defaultOrg,
    type: defaultType,
    handle: normalizedHandle,
  });
}

/**
 * List identities matching the given criteria
 * 
 * @param client - Letta client instance
 * @param options - Filter options
 * @returns Array of matching identities
 */
export async function listIdentities(
  client: LettaIdentityClient,
  options: {
    org?: string;
    type?: IdentityType;
    name?: string;
    limit?: number;
  } = {}
): Promise<LettaIdentity[]> {
  // Note: The API filters by identifier_key pattern, but we can use name/type filters
  const identities = await client.identities.list({
    name: options.name,
    identity_type: options.type,
    limit: options.limit ?? 50,
  });

  // If org filter is specified, filter results client-side
  // (since the API may not support org-only filtering)
  if (options.org) {
    const orgPrefix = `org:${options.org}:`;
    return identities.filter((id) => id.identifier_key?.startsWith(orgPrefix));
  }

  return identities;
}
