/**
 * Identity Validation Utilities
 *
 * Convenience utilities for identity validation and formatting.
 * These are thin wrappers around the reconciler functions for CLI usage.
 *
 * @see ../reconcilers/agents/identity.ts for agent-specific operations
 * @see ../reconcilers/identities/ for core identity operations
 */

import {
  isValidIdentifierKey,
  parseIdentifierKey,
  normalizeHandle,
  buildIdentifierKey,
} from '../reconcilers/identities/lookup.js';

import {
  resolveIdentifierKey,
  validateIdentityInput,
  type IdentityInputValidation,
} from '../reconcilers/agents/identity.js';

import type {
  IdentityType,
  IdentifierKeyComponents,
} from '../reconcilers/identities/types.js';

/**
 * Format an identity validation result for human-readable output
 */
export function formatValidationResult(result: IdentityInputValidation): string {
  if (result.valid) {
    return `Valid: ${result.identifierKey}`;
  }
  return `Invalid: ${result.errors.join('; ')}`;
}

/**
 * Validate multiple identity specifications
 */
export function validateIdentities(
  specs: string[],
  org: string
): {
  valid: boolean;
  results: Array<{
    input: string;
    resolved: string;
    validation: IdentityInputValidation;
  }>;
  errors: string[];
} {
  const results: Array<{
    input: string;
    resolved: string;
    validation: IdentityInputValidation;
  }> = [];
  const errors: string[] = [];

  for (const spec of specs) {
    const validation = validateIdentityInput(spec, org);

    results.push({
      input: spec,
      resolved: validation.identifierKey,
      validation,
    });

    if (!validation.valid) {
      errors.push(`"${spec}": ${validation.errors.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    results,
    errors,
  };
}

/**
 * Format identity for display (shorter format)
 */
export function formatIdentityShort(identifierKey: string): string {
  const parsed = parseIdentifierKey(identifierKey);
  if (!parsed) {
    return identifierKey;
  }
  return `${parsed.handle} (${parsed.type})`;
}

/**
 * Format identity with full details
 */
export function formatIdentityFull(identifierKey: string): string {
  const parsed = parseIdentifierKey(identifierKey);
  if (!parsed) {
    return identifierKey;
  }
  return `${identifierKey}\n  Handle: ${parsed.handle}\n  Type: ${parsed.type}\n  Org: ${parsed.org}`;
}

/**
 * Get help text for identity specification
 */
export function getIdentityHelpText(): string {
  return `
Identity Specification:

Identities can be specified as:
1. Full identifier_key: org:smarty-pants:user:paulbettner
2. Handle only (uses current org): paulbettner
3. Email (extracts local part): paul@example.com
4. With provider prefix: github:paulbettner

Identity Types:
- user: Individual human developer (auto-create enabled)
- service: Automated system/bot (requires explicit creation)
- team: Shared team persona (requires explicit creation)

Format: org:<org_slug>:<type>:<handle>
  - org_slug: 2-32 chars, lowercase alphanumeric + hyphens
  - type: user, service, or team
  - handle: 2-64 chars, lowercase alphanumeric + hyphens/underscores

Examples:
  --identity paulbettner
  --identity org:smarty-pants:user:paulbettner
  --identities paulbettner org:smarty-pants:team:platform-eng
`.trim();
}

// Re-export commonly used functions
export {
  isValidIdentifierKey,
  parseIdentifierKey,
  normalizeHandle,
  buildIdentifierKey,
  resolveIdentifierKey,
  validateIdentityInput,
};

export type {
  IdentityType,
  IdentifierKeyComponents,
  IdentityInputValidation,
};
