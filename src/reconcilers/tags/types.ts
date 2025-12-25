/**
 * Types for tag reconciliation
 *
 * Tags are simple string labels that follow a namespaced format.
 * See docs/specs/naming-conventions.md for details.
 */

/**
 * Reserved tag namespaces for reconciler use
 */
export const RESERVED_NAMESPACES = [
  'managed',
  'layer',
  'org',
  'project',
  'role',
  'channel',
  'applied',
] as const;

export type ReservedNamespace = (typeof RESERVED_NAMESPACES)[number];

/**
 * Tag validation regex pattern
 * Format: namespace:value[@sha]
 * - Namespace: lowercase letters, digits, hyphens; starts with letter
 * - Value: lowercase letters, digits, hyphens; starts with letter or digit
 * - Optional version suffix: @ followed by Git SHA (7-40 hex chars)
 */
export const TAG_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*(@[a-f0-9]{7,40})?$/;

/**
 * Allowed values for reserved namespaces
 */
export const ALLOWED_VALUES: Partial<Record<ReservedNamespace, string[] | 'any'>> = {
  managed: ['smarty-admin'],
  layer: ['base', 'org', 'project', 'user', 'lane'],
  channel: ['stable', 'beta', 'pinned'],
  // org, project, role use 'any' - validated against registry if needed
  org: 'any',
  project: 'any',
  role: 'any',
  applied: 'any', // validated as <layer>@<sha>
};

/**
 * Well-known management tags
 */
export const MANAGEMENT_TAG = 'managed:smarty-admin';

/**
 * Parsed tag structure
 */
export interface ParsedTag {
  /** Original tag string */
  raw: string;
  /** Namespace portion (before the colon) */
  namespace: string;
  /** Value portion (after the colon, before optional @sha) */
  value: string;
  /** Optional version suffix (after @) */
  version?: string;
  /** Whether this is a reserved namespace */
  isReserved: boolean;
  /** Whether this is a management tag */
  isManagementTag: boolean;
}

/**
 * Tag validation result
 */
export interface TagValidationResult {
  /** Whether the tag is valid */
  valid: boolean;
  /** Tag string that was validated */
  tag: string;
  /** Error message if invalid */
  error?: string;
  /** Parsed tag if valid */
  parsed?: ParsedTag;
}

/**
 * Tag diff action types
 */
export type TagDiffAction = 'add' | 'remove' | 'unchanged';

/**
 * A single tag difference
 */
export interface TagDiff {
  /** The tag string */
  tag: string;
  /** Action to take */
  action: TagDiffAction;
  /** Parsed tag info */
  parsed?: ParsedTag;
}

/**
 * Tag diff result for an agent or resource
 */
export interface TagDiffResult {
  /** Resource identifier (e.g., agent ID) */
  resourceId: string;
  /** Resource type */
  resourceType: 'agent' | 'tool';
  /** Tags to add */
  toAdd: string[];
  /** Tags to remove */
  toRemove: string[];
  /** Tags that are unchanged */
  unchanged: string[];
  /** Whether any changes are needed */
  hasChanges: boolean;
  /** All diffs with details */
  diffs: TagDiff[];
  /** Errors encountered */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
}

/**
 * Options for tag diff operations
 */
export interface TagDiffOptions {
  /** Only compare management/reserved tags (ignore user tags) */
  managedOnly?: boolean;
  /** Validate tag format strictly */
  strictValidation?: boolean;
  /** Namespaces to include (default: all) */
  includeNamespaces?: string[];
  /** Namespaces to exclude */
  excludeNamespaces?: string[];
}

/**
 * Options for tag apply operations
 */
export interface TagApplyOptions {
  /** If true, only return what would change without applying */
  dryRun?: boolean;
  /** Validate tags before applying */
  validate?: boolean;
  /** Allow removing management tags */
  allowRemoveManaged?: boolean;
}

/**
 * Result of applying tag changes
 */
export interface TagApplyResult {
  /** Resource identifier */
  resourceId: string;
  /** Resource type */
  resourceType: 'agent' | 'tool';
  /** Tags that were added */
  added: string[];
  /** Tags that were removed */
  removed: string[];
  /** Tags that were unchanged */
  unchanged: string[];
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Parse a tag string into its components
 */
export function parseTag(tag: string): ParsedTag | null {
  const match = tag.match(TAG_PATTERN);
  if (!match) {
    return null;
  }

  const [fullMatch, versionGroup] = [match[0], match[1]];
  const colonIndex = tag.indexOf(':');
  const namespace = tag.slice(0, colonIndex);
  
  // Extract value (everything between : and optional @)
  let value: string;
  let version: string | undefined;
  
  if (versionGroup) {
    // Has version suffix
    const atIndex = tag.lastIndexOf('@');
    value = tag.slice(colonIndex + 1, atIndex);
    version = versionGroup.slice(1); // Remove leading @
  } else {
    value = tag.slice(colonIndex + 1);
  }

  const isReserved = RESERVED_NAMESPACES.includes(namespace as ReservedNamespace);
  const isManagementTag = tag === MANAGEMENT_TAG;

  return {
    raw: tag,
    namespace,
    value,
    version,
    isReserved,
    isManagementTag,
  };
}

/**
 * Validate a single tag
 */
export function validateTag(tag: string): TagValidationResult {
  // Check format
  if (!TAG_PATTERN.test(tag)) {
    return {
      valid: false,
      tag,
      error: `Invalid tag format: "${tag}". Must match pattern namespace:value[@sha]`,
    };
  }

  const parsed = parseTag(tag);
  if (!parsed) {
    return {
      valid: false,
      tag,
      error: `Failed to parse tag: "${tag}"`,
    };
  }

  // Validate reserved namespace values
  if (parsed.isReserved) {
    const namespace = parsed.namespace as ReservedNamespace;
    const allowedValues = ALLOWED_VALUES[namespace];

    if (allowedValues && allowedValues !== 'any') {
      // Special handling for applied: tags (format is layer@sha)
      if (namespace === 'applied') {
        // Validate format: <layer>@<sha>
        const parts = parsed.value.split('@');
        if (parts.length !== 2) {
          // Check if version is properly extracted
          const validLayers = ['base', 'org', 'project'];
          if (!validLayers.includes(parsed.value)) {
            return {
              valid: false,
              tag,
              error: `Invalid applied tag: layer must be one of ${validLayers.join(', ')}`,
            };
          }
        }
      } else if (!allowedValues.includes(parsed.value)) {
        return {
          valid: false,
          tag,
          error: `Invalid value for ${namespace}: "${parsed.value}". Must be one of: ${allowedValues.join(', ')}`,
        };
      }
    }
  }

  return {
    valid: true,
    tag,
    parsed,
  };
}

/**
 * Validate multiple tags
 */
export function validateTags(tags: string[]): TagValidationResult[] {
  return tags.map(validateTag);
}

/**
 * Check if a tag is a management tag (reserved namespace)
 */
export function isManagementTag(tag: string): boolean {
  const parsed = parseTag(tag);
  return parsed?.isReserved ?? false;
}

/**
 * Check if a tag marks a resource as managed
 */
export function isManagedMarker(tag: string): boolean {
  return tag === MANAGEMENT_TAG;
}

/**
 * Build common management tags for a resource
 */
export function buildManagementTags(options: {
  layer: 'base' | 'org' | 'project' | 'user' | 'lane';
  org?: string;
  project?: string;
  role?: string;
  channel?: 'stable' | 'beta' | 'pinned';
  appliedVersions?: Record<string, string>; // layer -> sha
}): string[] {
  const tags: string[] = [MANAGEMENT_TAG];

  tags.push(`layer:${options.layer}`);

  if (options.org) {
    tags.push(`org:${options.org}`);
  }

  if (options.project) {
    tags.push(`project:${options.project}`);
  }

  if (options.role) {
    tags.push(`role:${options.role}`);
  }

  if (options.channel) {
    tags.push(`channel:${options.channel}`);
  }

  if (options.appliedVersions) {
    for (const [layer, sha] of Object.entries(options.appliedVersions)) {
      tags.push(`applied:${layer}@${sha}`);
    }
  }

  return tags;
}

/**
 * Extract management info from tags
 */
export function extractManagementInfo(tags: string[]): {
  isManaged: boolean;
  layer?: string;
  org?: string;
  project?: string;
  role?: string;
  channel?: string;
  appliedVersions: Record<string, string>;
} {
  const result: ReturnType<typeof extractManagementInfo> = {
    isManaged: false,
    appliedVersions: {},
  };

  for (const tag of tags) {
    const parsed = parseTag(tag);
    if (!parsed) continue;

    if (parsed.isManagementTag) {
      result.isManaged = true;
    } else if (parsed.namespace === 'layer') {
      result.layer = parsed.value;
    } else if (parsed.namespace === 'org') {
      result.org = parsed.value;
    } else if (parsed.namespace === 'project') {
      result.project = parsed.value;
    } else if (parsed.namespace === 'role') {
      result.role = parsed.value;
    } else if (parsed.namespace === 'channel') {
      result.channel = parsed.value;
    } else if (parsed.namespace === 'applied' && parsed.version) {
      result.appliedVersions[parsed.value] = parsed.version;
    }
  }

  return result;
}
