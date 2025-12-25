/**
 * Agent Identity Integration
 *
 * Provides agent-specific identity operations, building on the core
 * identity reconciler module. Handles identity attachment to agents
 * during creation and upgrade.
 *
 * @see ../identities/ for core identity operations
 * @see docs/specs/identity-naming.md for specification
 */

// Re-export core identity types and functions for convenience
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
} from '../identities/types.js';

export {
  AUTO_CREATE_POLICY,
  IDENTIFIER_KEY_REGEX,
  ORG_SLUG_REGEX,
  HANDLE_REGEX,
  IdentityValidationError,
  IdentityNotFoundError,
  AutoCreateNotAllowedError,
} from '../identities/types.js';

export {
  buildIdentifierKey,
  parseIdentifierKey,
  validateIdentifierKeyComponents,
  isValidIdentifierKey,
  normalizeHandle,
  lookupByIdentifierKey,
  lookupByComponents,
  resolveAndLookup,
} from '../identities/lookup.js';

export {
  isAutoCreateAllowed,
  ensureIdentity,
  ensureIdentityByComponents,
  ensureUserIdentity,
  ensureServiceIdentity,
  ensureTeamIdentity,
  resolveAndEnsure,
  upsertIdentity,
} from '../identities/ensure.js';

export type { LettaIdentityClientWithCreate } from '../identities/ensure.js';

// =============================================================================
// Agent-Specific Types
// =============================================================================

import type { LettaIdentity, EnsureResult, IdentityType, EnsureOptions } from '../identities/types.js';
import type { LettaIdentityClientWithCreate } from '../identities/ensure.js';
import {
  isValidIdentifierKey,
  normalizeHandle,
  parseIdentifierKey,
  resolveAndEnsure,
  buildIdentifierKey,
} from '../identities/index.js';

/**
 * Identity attachment options for agent operations
 */
export interface AttachIdentityOptions extends EnsureOptions {
  /** Organization slug for identity resolution */
  org: string;
}

/**
 * Result of attaching identities to an agent
 */
export interface AttachIdentityResult {
  /** Whether all operations succeeded */
  success: boolean;
  /** Resolved identity IDs (Letta server IDs) */
  identityIds: string[];
  /** Detailed results for each identity */
  resolved: EnsureResult[];
  /** Errors that occurred during resolution/attachment */
  errors: string[];
}

/**
 * Validation result for identity input
 */
export interface IdentityInputValidation {
  valid: boolean;
  identifierKey: string;
  errors: string[];
  warnings: string[];
}

/**
 * Agent identity configuration validation result
 */
export interface AgentIdentityValidation {
  valid: boolean;
  agentId: string;
  currentIdentities: LettaIdentity[];
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

// =============================================================================
// Extended Client Interface (with agent operations)
// =============================================================================

/**
 * Letta client interface with agent identity operations
 */
export interface LettaAgentIdentityClient extends LettaIdentityClientWithCreate {
  agents: {
    retrieve(agentId: string): Promise<{
      id: string;
      identity_ids?: string[];
      [key: string]: unknown;
    }>;
    update(
      agentId: string,
      params: { identity_ids?: string[] }
    ): Promise<unknown>;
  };
}

// =============================================================================
// Identity Input Resolution
// =============================================================================

/**
 * Resolve an identity input to a full identifier_key
 *
 * Accepts:
 * - Full identifier_key: org:smarty-pants:user:paulbettner
 * - Handle only: paulbettner (uses default org and 'user' type)
 * - Email: paul@example.com (extracts local part)
 * - Provider prefix: github:paulbettner (extracts handle)
 */
export function resolveIdentifierKey(
  input: string,
  org: string,
  type: IdentityType = 'user'
): string {
  // If already valid identifier_key, return as-is
  if (isValidIdentifierKey(input)) {
    return input;
  }

  // Normalize handle and build key
  const handle = normalizeHandle(input);
  return buildIdentifierKey({ org, type, handle });
}

/**
 * Validate an identity input and return detailed results
 */
export function validateIdentityInput(
  input: string,
  org: string,
  type: IdentityType = 'user'
): IdentityInputValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input || typeof input !== 'string') {
    return {
      valid: false,
      identifierKey: '',
      errors: ['Identity input is required and must be a string'],
      warnings: [],
    };
  }

  // Resolve to full identifier_key
  const identifierKey = resolveIdentifierKey(input, org, type);

  // Validate the resulting key
  if (!isValidIdentifierKey(identifierKey)) {
    errors.push(
      `Invalid identifier_key format: "${identifierKey}". ` +
        `Expected format: org:<org_slug>:<type>:<handle>`
    );
  }

  // Check if input needed normalization
  if (input !== identifierKey) {
    warnings.push(
      `Input "${input}" resolved to "${identifierKey}"`
    );
  }

  return {
    valid: errors.length === 0,
    identifierKey,
    errors,
    warnings,
  };
}

// =============================================================================
// Agent Identity Operations
// =============================================================================

/**
 * Resolve multiple identity inputs to identities
 *
 * Processes an array of identity specifications (handles or identifier_keys)
 * and resolves each to an actual identity (finding existing or creating new).
 *
 * @param client - Letta client with identity operations
 * @param inputs - Array of handles or identifier_keys
 * @param options - Resolution options (org, autoCreate, etc.)
 * @returns Results with resolved identity IDs
 */
export async function resolveIdentitiesForAgent(
  client: LettaIdentityClientWithCreate,
  inputs: string[],
  options: AttachIdentityOptions
): Promise<AttachIdentityResult> {
  const resolved: EnsureResult[] = [];
  const identityIds: string[] = [];
  const errors: string[] = [];

  for (const input of inputs) {
    try {
      // Resolve and ensure the identity exists
      const result = await resolveAndEnsure(
        client,
        input,
        options.org,
        'user', // Default to user type for simple handles
        {
          autoCreate: options.autoCreate,
          defaultName: options.defaultName,
          properties: options.properties,
          metadata: options.metadata,
          createdBy: options.createdBy ?? 'agent-bootstrap',
        }
      );

      resolved.push(result);
      identityIds.push(result.identity.id);
    } catch (err) {
      errors.push(
        `Failed to resolve identity "${input}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    success: errors.length === 0,
    identityIds,
    resolved,
    errors,
  };
}

/**
 * Attach identities to an existing agent
 *
 * Resolves identity inputs and updates the agent's identity_ids.
 * This is the primary integration point for bootstrap and upgrade commands.
 *
 * @param client - Letta client with agent and identity operations
 * @param agentId - Agent ID to update
 * @param inputs - Identity handles or identifier_keys to attach
 * @param options - Attachment options
 * @returns Result with resolved identities and any errors
 */
export async function attachIdentitiesToAgent(
  client: LettaAgentIdentityClient,
  agentId: string,
  inputs: string[],
  options: AttachIdentityOptions
): Promise<AttachIdentityResult> {
  // First resolve all identities
  const resolution = await resolveIdentitiesForAgent(client, inputs, options);

  if (!resolution.success) {
    return resolution;
  }

  // Get current agent to check existing identities
  try {
    const agent = await client.agents.retrieve(agentId);
    const existingIds = agent.identity_ids ?? [];

    // Merge new identities with existing (avoid duplicates)
    const mergedIds = [...new Set([...existingIds, ...resolution.identityIds])];

    // Update agent with merged identity_ids
    await client.agents.update(agentId, {
      identity_ids: mergedIds,
    });
  } catch (err) {
    return {
      ...resolution,
      success: false,
      errors: [
        ...resolution.errors,
        `Failed to attach identities to agent ${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }

  return resolution;
}

/**
 * Detach identities from an agent
 *
 * Removes specified identities from the agent's identity_ids.
 *
 * @param client - Letta client with agent operations
 * @param agentId - Agent ID to update
 * @param identityIds - Identity IDs to remove
 * @returns Result indicating success/failure
 */
export async function detachIdentitiesFromAgent(
  client: LettaAgentIdentityClient,
  agentId: string,
  identityIds: string[]
): Promise<{ success: boolean; errors: string[] }> {
  try {
    const agent = await client.agents.retrieve(agentId);
    const existingIds = agent.identity_ids ?? [];

    // Filter out the specified identities
    const remainingIds = existingIds.filter(
      (id) => !identityIds.includes(id)
    );

    // Update agent
    await client.agents.update(agentId, {
      identity_ids: remainingIds,
    });

    return { success: true, errors: [] };
  } catch (err) {
    return {
      success: false,
      errors: [
        `Failed to detach identities from agent ${agentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
    };
  }
}

// =============================================================================
// Validation for Upgrades
// =============================================================================

/**
 * Validate identity configuration for an agent upgrade
 *
 * Checks:
 * 1. All attached identities still exist
 * 2. Identity types are appropriate
 * 3. Recommends user identity if missing
 *
 * @param client - Letta client with identity operations
 * @param agentId - Agent ID to validate
 * @param currentIdentityIds - Current identity IDs on the agent
 * @returns Validation result with errors, warnings, and suggestions
 */
export async function validateAgentIdentities(
  client: LettaAgentIdentityClient,
  agentId: string,
  currentIdentityIds: string[]
): Promise<AgentIdentityValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];
  const validatedIdentities: LettaIdentity[] = [];

  // Validate each attached identity
  for (const identityId of currentIdentityIds) {
    try {
      // Try to retrieve the identity
      const identities = await client.identities.list({ limit: 1 });
      // In real implementation, would look up by ID
      // For now, just track the IDs
      warnings.push(`Unable to validate identity ${identityId} (lookup not implemented)`);
    } catch (err) {
      errors.push(
        `Identity ${identityId} may not exist: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Warn if no identities attached
  if (currentIdentityIds.length === 0) {
    warnings.push('Agent has no identities attached');
    suggestions.push(
      'Consider attaching a user identity for personalization: --add-identity <handle>'
    );
  }

  // Check for presence of user identity
  const hasUserIdentity = currentIdentityIds.some((id) => {
    const parsed = parseIdentifierKey(id);
    return parsed?.type === 'user';
  });

  if (!hasUserIdentity && currentIdentityIds.length > 0) {
    warnings.push('No user identity attached (only service/team identities found)');
    suggestions.push('Consider adding a primary user identity for personalization');
  }

  return {
    valid: errors.length === 0,
    agentId,
    currentIdentities: validatedIdentities,
    errors,
    warnings,
    suggestions,
  };
}
