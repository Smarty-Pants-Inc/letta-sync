/**
 * Version and hash tracking for agents via tags
 *
 * Implements the tag-based version tracking system for agents.
 * Tags provide quick queryable access to applied versions without
 * needing to read the managed_state block.
 *
 * Tag format: `applied:<layer>@<sha>` where sha is 7-40 hex characters
 *
 * @see docs/specs/naming-conventions.md §2.2, §4.1.A
 */

import type { PackageLayer } from './state.js';

/**
 * Tag namespaces reserved for reconciler use
 */
export const RESERVED_TAG_NAMESPACES = [
  'managed',
  'layer',
  'org',
  'project',
  'role',
  'channel',
  'applied',
] as const;

export type ReservedTagNamespace = (typeof RESERVED_TAG_NAMESPACES)[number];

/**
 * Valid layers for agent tags
 */
export const VALID_LAYERS = ['base', 'org', 'project', 'user', 'lane'] as const;

/**
 * Valid roles for agent tags
 */
export const VALID_ROLES = [
  'lane-dev',
  'repo-curator',
  'org-curator',
  'supervisor',
] as const;

/**
 * Valid channels for agent tags
 */
export const VALID_CHANNELS = ['stable', 'beta', 'pinned'] as const;

/**
 * Tag validation regex per spec
 * ^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*(@[a-f0-9]{7,40})?$
 */
export const TAG_VALIDATION_REGEX = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*(@[a-f0-9]{7,40})?$/;

/**
 * Regex for applied version tags specifically
 */
export const APPLIED_TAG_REGEX = /^applied:(base|org|project)@([a-f0-9]{7,40})$/;

/**
 * SHA validation regex (7-40 hex characters)
 */
export const SHA_REGEX = /^[a-f0-9]{7,40}$/;

/**
 * Parsed applied version tag
 */
export interface AppliedVersionTag {
  layer: PackageLayer;
  sha: string;
}

/**
 * Agent tags parsed into structured form
 */
export interface ParsedAgentTags {
  /** Whether this agent is managed by smarty-admin */
  isManaged: boolean;
  /** The layer this agent belongs to */
  layer?: string;
  /** Organization slug */
  org?: string;
  /** Project slug */
  project?: string;
  /** Agent role */
  role?: string;
  /** Update channel */
  channel?: string;
  /** Applied versions by layer */
  appliedVersions: Partial<Record<PackageLayer, string>>;
  /** All other tags not in reserved namespaces */
  customTags: string[];
}

/**
 * Validate a tag format
 */
export function isValidTag(tag: string): boolean {
  return TAG_VALIDATION_REGEX.test(tag);
}

/**
 * Validate a SHA format
 */
export function isValidSha(sha: string): boolean {
  return SHA_REGEX.test(sha);
}

/**
 * Check if a tag uses a reserved namespace
 */
export function isReservedTag(tag: string): boolean {
  const [namespace] = tag.split(':');
  return RESERVED_TAG_NAMESPACES.includes(namespace as ReservedTagNamespace);
}

/**
 * Parse an applied version tag
 * Returns null if the tag is not a valid applied version tag
 */
export function parseAppliedTag(tag: string): AppliedVersionTag | null {
  const match = tag.match(APPLIED_TAG_REGEX);
  if (!match) return null;

  return {
    layer: match[1] as PackageLayer,
    sha: match[2],
  };
}

/**
 * Create an applied version tag
 */
export function createAppliedTag(layer: PackageLayer, sha: string): string {
  // Normalize to short SHA if longer
  const shortSha = sha.slice(0, 7);
  if (!isValidSha(shortSha)) {
    throw new Error(`Invalid SHA format: ${sha}`);
  }
  return `applied:${layer}@${shortSha}`;
}

/**
 * Parse all tags from an agent into structured form
 */
export function parseAgentTags(tags: string[]): ParsedAgentTags {
  const result: ParsedAgentTags = {
    isManaged: false,
    appliedVersions: {},
    customTags: [],
  };

  for (const tag of tags) {
    // Check for managed tag
    if (tag === 'managed:smarty-admin') {
      result.isManaged = true;
      continue;
    }

    // Parse namespace:value format
    const colonIndex = tag.indexOf(':');
    if (colonIndex === -1) {
      result.customTags.push(tag);
      continue;
    }

    const namespace = tag.slice(0, colonIndex);
    const value = tag.slice(colonIndex + 1);

    switch (namespace) {
      case 'layer':
        result.layer = value;
        break;
      case 'org':
        result.org = value;
        break;
      case 'project':
        result.project = value;
        break;
      case 'role':
        result.role = value;
        break;
      case 'channel':
        result.channel = value;
        break;
      case 'applied': {
        const parsed = parseAppliedTag(tag);
        if (parsed) {
          result.appliedVersions[parsed.layer] = parsed.sha;
        }
        break;
      }
      default:
        // Not a reserved namespace
        result.customTags.push(tag);
    }
  }

  return result;
}

/**
 * Update agent tags with new applied versions
 *
 * This removes existing applied tags for the specified layers
 * and adds new ones with the updated versions.
 */
export function updateAppliedTags(
  currentTags: string[],
  updates: Partial<Record<PackageLayer, string>>
): string[] {
  // Determine which layers we're updating
  const layersToUpdate = new Set(Object.keys(updates) as PackageLayer[]);

  // Filter out existing applied tags for layers we're updating
  const filteredTags = currentTags.filter((tag) => {
    const parsed = parseAppliedTag(tag);
    return !parsed || !layersToUpdate.has(parsed.layer);
  });

  // Add new applied tags
  for (const [layer, sha] of Object.entries(updates)) {
    if (sha) {
      filteredTags.push(createAppliedTag(layer as PackageLayer, sha));
    }
  }

  return filteredTags;
}

/**
 * Remove applied tags for specified layers
 */
export function removeAppliedTags(
  currentTags: string[],
  layers: PackageLayer[]
): string[] {
  const layersToRemove = new Set(layers);

  return currentTags.filter((tag) => {
    const parsed = parseAppliedTag(tag);
    return !parsed || !layersToRemove.has(parsed.layer);
  });
}

/**
 * Ensure required managed tags are present
 *
 * Adds managed:smarty-admin and other required tags if missing.
 */
export function ensureManagedTags(
  tags: string[],
  options: {
    layer?: string;
    org?: string;
    project?: string;
    channel?: string;
    role?: string;
  }
): string[] {
  const result = [...tags];

  // Ensure managed tag
  if (!result.includes('managed:smarty-admin')) {
    result.push('managed:smarty-admin');
  }

  // Add optional tags if provided and not already present
  const tagMap = new Map<string, string>();
  for (const tag of result) {
    const [ns, val] = tag.split(':');
    if (ns && val) {
      tagMap.set(ns, val);
    }
  }

  if (options.layer && !tagMap.has('layer')) {
    result.push(`layer:${options.layer}`);
  }
  if (options.org && !tagMap.has('org')) {
    result.push(`org:${options.org}`);
  }
  if (options.project && !tagMap.has('project')) {
    result.push(`project:${options.project}`);
  }
  if (options.channel && !tagMap.has('channel')) {
    result.push(`channel:${options.channel}`);
  }
  if (options.role && !tagMap.has('role')) {
    result.push(`role:${options.role}`);
  }

  return result;
}

/**
 * Compare applied versions between two sets of tags
 *
 * Returns layers where versions differ
 */
export function diffAppliedVersions(
  currentTags: string[],
  desiredVersions: Partial<Record<PackageLayer, string>>
): {
  layer: PackageLayer;
  current: string | null;
  desired: string;
}[] {
  const current = parseAgentTags(currentTags);
  const diffs: {
    layer: PackageLayer;
    current: string | null;
    desired: string;
  }[] = [];

  for (const [layer, desiredSha] of Object.entries(desiredVersions)) {
    if (!desiredSha) continue;

    const currentSha = current.appliedVersions[layer as PackageLayer];
    const desiredShort = desiredSha.slice(0, 7);

    if (!currentSha || currentSha !== desiredShort) {
      diffs.push({
        layer: layer as PackageLayer,
        current: currentSha ?? null,
        desired: desiredShort,
      });
    }
  }

  return diffs;
}

/**
 * Get all applied version tags from a tag list
 */
export function getAppliedVersionTags(tags: string[]): Map<PackageLayer, string> {
  const versions = new Map<PackageLayer, string>();

  for (const tag of tags) {
    const parsed = parseAppliedTag(tag);
    if (parsed) {
      versions.set(parsed.layer, parsed.sha);
    }
  }

  return versions;
}

/**
 * Check if agent tags indicate it's managed by smarty-admin
 */
export function isManagedAgent(tags: string[]): boolean {
  return tags.includes('managed:smarty-admin');
}

/**
 * Validate all tags in a list and return validation errors
 */
export function validateTags(tags: string[]): string[] {
  const errors: string[] = [];

  for (const tag of tags) {
    if (!isValidTag(tag)) {
      errors.push(`Invalid tag format: "${tag}"`);
    }
  }

  return errors;
}

/**
 * Filter tags to only include managed/reserved tags
 */
export function getManagedTags(tags: string[]): string[] {
  return tags.filter((tag) => {
    const [namespace] = tag.split(':');
    return RESERVED_TAG_NAMESPACES.includes(namespace as ReservedTagNamespace);
  });
}

/**
 * Filter tags to only include custom (non-reserved) tags
 */
export function getCustomTags(tags: string[]): string[] {
  return tags.filter((tag) => {
    const [namespace] = tag.split(':');
    return !RESERVED_TAG_NAMESPACES.includes(namespace as ReservedTagNamespace);
  });
}
