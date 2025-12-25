/**
 * Identity types for the Smarty Admin reconciler
 * 
 * Based on the Identity Naming and Org Scoping Specification (smarty-dev-oxt.6.1)
 * 
 * Identifier Format: org:<org_slug>:<type>:<handle>
 * Example: org:smarty-pants:user:paulbettner
 */

/**
 * Identity type classifications
 * - user: Individual human developer or operator
 * - service: Automated system, CI pipeline, or bot
 * - team: Shared team persona for multiple humans
 */
export type IdentityType = 'user' | 'service' | 'team';

/**
 * Identity property key-value pair
 */
export interface IdentityProperty {
  key: string;
  value: string;
}

/**
 * Letta Identity as returned from the API
 */
export interface LettaIdentity {
  /** Server-generated unique ID */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Unique identifier key in format: org:<org>:<type>:<handle> */
  identifier_key: string;
  /** Identity type classification */
  identity_type: IdentityType;
  /** Key-value properties */
  properties: IdentityProperty[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Creation timestamp */
  created_at?: string;
  /** Last update timestamp */
  updated_at?: string;
}

/**
 * Input for creating an identity
 */
export interface IdentityCreateInput {
  /** Human-readable display name */
  name: string;
  /** Unique identifier key (will be constructed if components provided) */
  identifier_key: string;
  /** Identity type */
  identity_type: IdentityType;
  /** Optional properties */
  properties?: IdentityProperty[];
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Components for constructing an identifier_key
 */
export interface IdentifierKeyComponents {
  /** Organization slug (lowercase alphanumeric + hyphens, 2-32 chars) */
  org: string;
  /** Identity type */
  type: IdentityType;
  /** Handle within the type (lowercase alphanumeric + hyphens/underscores, 2-64 chars) */
  handle: string;
}

/**
 * Result of an identity lookup operation
 */
export interface LookupResult {
  /** Whether an identity was found */
  found: boolean;
  /** The identity if found */
  identity?: LettaIdentity;
  /** The identifier_key that was searched */
  identifier_key: string;
}

/**
 * Result of an ensure operation
 */
export interface EnsureResult {
  /** The identity (either found or created) */
  identity: LettaIdentity;
  /** Whether the identity was newly created */
  created: boolean;
  /** The identifier_key */
  identifier_key: string;
}

/**
 * Options for ensure operations
 */
export interface EnsureOptions {
  /** Allow auto-creation if not found (default: true for users, false for others) */
  autoCreate?: boolean;
  /** Default display name if creating (defaults to handle) */
  defaultName?: string;
  /** Properties to set if creating */
  properties?: IdentityProperty[];
  /** Metadata to set if creating */
  metadata?: Record<string, unknown>;
  /** Source of the creation request (for audit) */
  createdBy?: string;
}

/**
 * Policy for identity auto-creation by type
 */
export const AUTO_CREATE_POLICY: Record<IdentityType, boolean> = {
  user: true,     // Auto-create on first use
  service: false, // Explicit creation only
  team: false,    // Explicit creation only
};

/**
 * Creation source types for audit trails
 */
export type CreationSource = 
  | 'git-commit'
  | 'agent-bootstrap'
  | 'manifest-sync'
  | 'api-direct'
  | 'cli-create';

/**
 * Validation regex for identifier_key
 * Format: org:<org_slug>:<type>:<handle>
 */
export const IDENTIFIER_KEY_REGEX = /^org:[a-z][a-z0-9-]{1,31}:(user|service|team):[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Validation regex for org slug component
 */
export const ORG_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Validation regex for handle component
 */
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * Error thrown when identity validation fails
 */
export class IdentityValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
    public readonly value?: string
  ) {
    super(message);
    this.name = 'IdentityValidationError';
  }
}

/**
 * Error thrown when identity is not found and auto-create is disabled
 */
export class IdentityNotFoundError extends Error {
  constructor(
    public readonly identifier_key: string,
    public readonly identity_type: IdentityType
  ) {
    super(`Identity not found: ${identifier_key}`);
    this.name = 'IdentityNotFoundError';
  }
}

/**
 * Error thrown when auto-creation is not allowed for an identity type
 */
export class AutoCreateNotAllowedError extends Error {
  constructor(
    public readonly identifier_key: string,
    public readonly identity_type: IdentityType
  ) {
    super(
      `Auto-creation not allowed for ${identity_type} identities. ` +
      `Identity must be explicitly created: ${identifier_key}`
    );
    this.name = 'AutoCreateNotAllowedError';
  }
}
