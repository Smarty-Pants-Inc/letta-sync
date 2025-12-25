/**
 * Tag diff algorithm
 *
 * Compares desired tags with actual tags and generates a diff result
 * showing what needs to be added, removed, or is unchanged.
 */

import type {
  TagDiff,
  TagDiffResult,
  TagDiffOptions,
  ParsedTag,
} from './types.js';

import {
  parseTag,
  validateTag,
  isManagementTag,
  RESERVED_NAMESPACES,
} from './types.js';

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `tag-diff-${timestamp}-${random}`;
}

/**
 * Filter tags based on diff options
 */
function filterTags(tags: string[], options: TagDiffOptions): string[] {
  return tags.filter((tag) => {
    const parsed = parseTag(tag);
    if (!parsed) return !options.strictValidation;

    // Filter by managed-only
    if (options.managedOnly && !parsed.isReserved) {
      return false;
    }

    // Filter by included namespaces
    if (options.includeNamespaces && options.includeNamespaces.length > 0) {
      if (!options.includeNamespaces.includes(parsed.namespace)) {
        return false;
      }
    }

    // Filter by excluded namespaces
    if (options.excludeNamespaces && options.excludeNamespaces.length > 0) {
      if (options.excludeNamespaces.includes(parsed.namespace)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Diff two sets of tags
 *
 * @param desired - Tags that should exist
 * @param actual - Tags that currently exist
 * @param options - Diff options
 * @returns Tag diff result
 */
export function diffTags(
  desired: string[],
  actual: string[],
  options: TagDiffOptions = {}
): { toAdd: string[]; toRemove: string[]; unchanged: string[]; diffs: TagDiff[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate tags if strict validation is enabled
  if (options.strictValidation) {
    for (const tag of desired) {
      const result = validateTag(tag);
      if (!result.valid && result.error) {
        errors.push(`Desired tag invalid: ${result.error}`);
      }
    }
    for (const tag of actual) {
      const result = validateTag(tag);
      if (!result.valid && result.error) {
        warnings.push(`Actual tag invalid (will be preserved): ${result.error}`);
      }
    }
  }

  // Apply filters
  const filteredDesired = filterTags(desired, options);
  const filteredActual = filterTags(actual, options);

  // Convert to sets for efficient comparison
  const desiredSet = new Set(filteredDesired);
  const actualSet = new Set(filteredActual);

  // Find tags to add (in desired but not in actual)
  const toAdd = filteredDesired.filter((tag) => !actualSet.has(tag));

  // Find tags to remove (in actual but not in desired)
  const toRemove = filteredActual.filter((tag) => !desiredSet.has(tag));

  // Find unchanged tags (in both)
  const unchanged = filteredDesired.filter((tag) => actualSet.has(tag));

  // Build detailed diff list
  const diffs: TagDiff[] = [];

  for (const tag of toAdd) {
    diffs.push({
      tag,
      action: 'add',
      parsed: parseTag(tag) ?? undefined,
    });
  }

  for (const tag of toRemove) {
    diffs.push({
      tag,
      action: 'remove',
      parsed: parseTag(tag) ?? undefined,
    });
  }

  for (const tag of unchanged) {
    diffs.push({
      tag,
      action: 'unchanged',
      parsed: parseTag(tag) ?? undefined,
    });
  }

  return { toAdd, toRemove, unchanged, diffs };
}

/**
 * Diff tags for an agent
 *
 * @param agentId - Agent identifier
 * @param desiredTags - Tags that should exist on the agent
 * @param actualTags - Tags currently on the agent
 * @param options - Diff options
 * @returns Tag diff result for the agent
 */
export function diffAgentTags(
  agentId: string,
  desiredTags: string[],
  actualTags: string[],
  options: TagDiffOptions = {}
): TagDiffResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate desired tags
  if (options.strictValidation) {
    for (const tag of desiredTags) {
      const result = validateTag(tag);
      if (!result.valid && result.error) {
        errors.push(result.error);
      }
    }
  }

  const { toAdd, toRemove, unchanged, diffs } = diffTags(
    desiredTags,
    actualTags,
    options
  );

  return {
    resourceId: agentId,
    resourceType: 'agent',
    toAdd,
    toRemove,
    unchanged,
    hasChanges: toAdd.length > 0 || toRemove.length > 0,
    diffs,
    errors,
    warnings,
  };
}

/**
 * Diff tags for a tool
 *
 * @param toolId - Tool identifier
 * @param desiredTags - Tags that should exist on the tool
 * @param actualTags - Tags currently on the tool
 * @param options - Diff options
 * @returns Tag diff result for the tool
 */
export function diffToolTags(
  toolId: string,
  desiredTags: string[],
  actualTags: string[],
  options: TagDiffOptions = {}
): TagDiffResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate desired tags
  if (options.strictValidation) {
    for (const tag of desiredTags) {
      const result = validateTag(tag);
      if (!result.valid && result.error) {
        errors.push(result.error);
      }
    }
  }

  const { toAdd, toRemove, unchanged, diffs } = diffTags(
    desiredTags,
    actualTags,
    options
  );

  return {
    resourceId: toolId,
    resourceType: 'tool',
    toAdd,
    toRemove,
    unchanged,
    hasChanges: toAdd.length > 0 || toRemove.length > 0,
    diffs,
    errors,
  warnings,
  };
}

/**
 * Check if an agent is managed based on its tags
 */
export function isAgentManaged(tags: string[]): boolean {
  return tags.some((tag) => tag === 'managed:smarty-admin');
}

/**
 * Check if a tool is managed based on its tags
 */
export function isToolManaged(tags: string[]): boolean {
  return tags.some((tag) => tag === 'managed:smarty-admin' || tag === 'managed_by:smarty-admin');
}

/**
 * Get all management tags from a tag list
 */
export function getManagementTags(tags: string[]): string[] {
  return tags.filter(isManagementTag);
}

/**
 * Get all user (non-management) tags from a tag list
 */
export function getUserTags(tags: string[]): string[] {
  return tags.filter((tag) => !isManagementTag(tag));
}

/**
 * Merge management tags with user tags
 * Management tags from desired take precedence, user tags preserved
 */
export function mergeTags(
  desiredManagementTags: string[],
  existingTags: string[],
  options: { preserveUserTags?: boolean } = {}
): string[] {
  const { preserveUserTags = true } = options;

  // Get existing user tags
  const existingUserTags = preserveUserTags ? getUserTags(existingTags) : [];

  // Combine: desired management tags + existing user tags
  const merged = new Set([...desiredManagementTags, ...existingUserTags]);

  return Array.from(merged).sort();
}

/**
 * Update applied version tags
 * Removes old applied tags for the same layer and adds new ones
 */
export function updateAppliedTags(
  existingTags: string[],
  layer: string,
  newSha: string
): string[] {
  // Remove old applied tag for this layer
  const filtered = existingTags.filter((tag) => {
    const parsed = parseTag(tag);
    if (!parsed || parsed.namespace !== 'applied') return true;
    return parsed.value !== layer;
  });

  // Add new applied tag
  return [...filtered, `applied:${layer}@${newSha}`];
}

/**
 * Format tag diff result as human-readable summary
 */
export function formatTagDiffSummary(result: TagDiffResult): string {
  const lines: string[] = [];

  lines.push(`Tag Diff for ${result.resourceType}: ${result.resourceId}`);
  lines.push('='.repeat(50));
  lines.push('');

  if (!result.hasChanges) {
    lines.push('Status: NO CHANGES');
    lines.push(`Tags in sync: ${result.unchanged.length}`);
    return lines.join('\n');
  }

  lines.push('Status: CHANGES NEEDED');
  lines.push('');

  if (result.toAdd.length > 0) {
    lines.push('Tags to ADD:');
    for (const tag of result.toAdd) {
      lines.push(`  + ${tag}`);
    }
    lines.push('');
  }

  if (result.toRemove.length > 0) {
    lines.push('Tags to REMOVE:');
    for (const tag of result.toRemove) {
      lines.push(`  - ${tag}`);
    }
    lines.push('');
  }

  if (result.unchanged.length > 0) {
    lines.push(`Unchanged: ${result.unchanged.length} tags`);
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('Errors:');
    for (const error of result.errors) {
      lines.push(`  ! ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  ? ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format tag diff result as JSON
 */
export function formatTagDiffAsJson(result: TagDiffResult): string {
  return JSON.stringify(
    {
      resourceId: result.resourceId,
      resourceType: result.resourceType,
      hasChanges: result.hasChanges,
      toAdd: result.toAdd,
      toRemove: result.toRemove,
      unchanged: result.unchanged,
      errors: result.errors,
      warnings: result.warnings,
    },
    null,
    2
  );
}
