/**
 * Agent Selection for Project-level Batch Operations
 *
 * Provides functionality to list and filter managed agents within a project
 * for batch operations like upgrades.
 *
 * Agent selection supports:
 * - Filtering to managed agents (has managed:smarty-admin tag)
 * - Filtering by role (lane-dev, repo-curator, etc.)
 * - Filtering by channel (stable, beta, pinned)
 * - Pagination for large projects
 *
 * @see docs/specs/naming-conventions.md §2.2 for tag conventions
 */

import type { AgentState } from '../../api/types.js';
import type { LettaClient, ListAgentsOptions } from '../../api/client.js';
import {
  parseAgentTags,
  isManagedAgent,
  type ParsedAgentTags,
  VALID_ROLES,
  VALID_CHANNELS,
} from '../agents/tracking.js';
import type { Channel } from '../../types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Valid agent roles for filtering
 */
export type AgentRole = (typeof VALID_ROLES)[number];

/**
 * Selection criteria for filtering agents
 */
export interface AgentSelectionCriteria {
  /** Only select managed agents (default: true) */
  managedOnly?: boolean;
  /** Filter by agent roles */
  roles?: AgentRole[];
  /** Filter by update channels */
  channels?: Channel[];
  /** Filter by project slug (from tag) */
  project?: string;
  /** Filter by organization slug (from tag) */
  org?: string;
  /** Filter by agent name pattern (glob-style) */
  namePattern?: string;
  /** Include agents with specific tags */
  includeTags?: string[];
  /** Exclude agents with specific tags */
  excludeTags?: string[];
}

/**
 * Selected agent with parsed metadata
 */
export interface SelectedAgent {
  /** Agent ID */
  id: string;
  /** Agent name */
  name: string;
  /** Agent description */
  description?: string;
  /** Raw tags from agent */
  tags: string[];
  /** Parsed tag information */
  parsedTags: ParsedAgentTags;
  /** Whether this is a managed agent */
  isManaged: boolean;
  /** Agent role (if tagged) */
  role?: AgentRole;
  /** Agent channel (if tagged) */
  channel?: Channel;
  /** Creation timestamp */
  createdAt?: string;
  /** Last update timestamp */
  updatedAt?: string;
}

/**
 * Result of agent selection operation
 */
export interface AgentSelectionResult {
  /** Selected agents */
  agents: SelectedAgent[];
  /** Total count of agents matching criteria */
  totalCount: number;
  /** Number of agents that were filtered out */
  filteredCount: number;
  /** Selection criteria used */
  criteria: AgentSelectionCriteria;
  /** Whether more agents are available (pagination) */
  hasMore: boolean;
  /** Cursor for next page (if paginating) */
  nextCursor?: string;
  /** Errors encountered during selection */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
}

/**
 * Options for agent selection
 */
export interface SelectAgentsOptions {
  /** Selection criteria */
  criteria?: AgentSelectionCriteria;
  /** Maximum number of agents to return */
  limit?: number;
  /** Cursor for pagination */
  cursor?: string;
  /** Sort order */
  order?: 'asc' | 'desc';
  /** Sort field */
  orderBy?: 'created_at' | 'name';
}

/**
 * Summary statistics for selected agents
 */
export interface AgentSelectionSummary {
  /** Total agents selected */
  total: number;
  /** Count by role */
  byRole: Partial<Record<AgentRole, number>>;
  /** Count by channel */
  byChannel: Partial<Record<Channel, number>>;
  /** Count of agents needing upgrades */
  needsUpgrade?: number;
  /** Count of agents up to date */
  upToDate?: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Default pagination limit */
const DEFAULT_LIMIT = 100;

/** Maximum pagination limit */
const MAX_LIMIT = 1000;

/** Managed agent tag */
const MANAGED_TAG = 'managed:smarty-admin';

// =============================================================================
// Main Selection Function
// =============================================================================

/**
 * Select agents from a project based on criteria
 *
 * This is the primary entry point for agent selection. It fetches agents
 * from the Letta API and filters them according to the provided criteria.
 *
 * @param client - Letta API client
 * @param options - Selection options
 * @returns Selection result with filtered agents
 *
 * @example
 * ```typescript
 * // Select all managed agents
 * const result = await selectAgents(client, {
 *   criteria: { managedOnly: true }
 * });
 *
 * // Select lane-dev agents on stable channel
 * const result = await selectAgents(client, {
 *   criteria: {
 *     managedOnly: true,
 *     roles: ['lane-dev'],
 *     channels: ['stable']
 *   }
 * });
 * ```
 */
export async function selectAgents(
  client: LettaClient,
  options: SelectAgentsOptions = {}
): Promise<AgentSelectionResult> {
  const {
    criteria = {},
    limit = DEFAULT_LIMIT,
    cursor,
    order = 'desc',
    orderBy = 'created_at',
  } = options;

  // Apply default: managed only unless explicitly set to false
  const effectiveCriteria: AgentSelectionCriteria = {
    managedOnly: true,
    ...criteria,
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate criteria
  const validationErrors = validateSelectionCriteria(effectiveCriteria);
  if (validationErrors.length > 0) {
    return {
      agents: [],
      totalCount: 0,
      filteredCount: 0,
      criteria: effectiveCriteria,
      hasMore: false,
      errors: validationErrors,
      warnings: [],
    };
  }

  // Build API query options
  const queryOptions: ListAgentsOptions = {
    limit: Math.min(limit, MAX_LIMIT),
    order,
    orderBy,
  };

  // If filtering for managed agents, use tag filter
  if (effectiveCriteria.managedOnly) {
    queryOptions.tags = [MANAGED_TAG];
  }

  // Add pagination cursor if provided
  if (cursor) {
    queryOptions.after = cursor;
  }

  // Fetch agents from API
  let allAgents: AgentState[];
  try {
    allAgents = await client.agents.list(queryOptions);
  } catch (err) {
    errors.push(
      `Failed to fetch agents: ${err instanceof Error ? err.message : String(err)}`
    );
    return {
      agents: [],
      totalCount: 0,
      filteredCount: 0,
      criteria: effectiveCriteria,
      hasMore: false,
      errors,
      warnings,
    };
  }

  // Parse and filter agents
  const selectedAgents: SelectedAgent[] = [];
  let filteredCount = 0;

  for (const agent of allAgents) {
    const tags = agent.tags ?? [];
    const parsedTags = parseAgentTags(tags);

    // Create selected agent object
    const selectedAgent: SelectedAgent = {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      tags,
      parsedTags,
      isManaged: parsedTags.isManaged,
      role: parsedTags.role as AgentRole | undefined,
      channel: parsedTags.channel as Channel | undefined,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };

    // Apply filters
    if (matchesCriteria(selectedAgent, effectiveCriteria)) {
      selectedAgents.push(selectedAgent);
    } else {
      filteredCount++;
    }
  }

  // Determine if there are more results
  const hasMore = allAgents.length >= limit;
  const nextCursor =
    hasMore && allAgents.length > 0
      ? allAgents[allAgents.length - 1].id
      : undefined;

  // Add warnings for empty results with specific filters
  if (selectedAgents.length === 0 && allAgents.length > 0) {
    warnings.push(
      'No agents matched the selection criteria. ' +
        'Check role/channel filters or use --all to select all managed agents.'
    );
  }

  return {
    agents: selectedAgents,
    totalCount: selectedAgents.length,
    filteredCount,
    criteria: effectiveCriteria,
    hasMore,
    nextCursor,
    errors,
    warnings,
  };
}

/**
 * Select all managed agents in a project (convenience wrapper)
 *
 * Fetches all pages of managed agents. Use with caution for large projects.
 *
 * @param client - Letta API client
 * @param criteria - Optional additional filtering criteria
 * @returns All matching agents
 */
export async function selectAllManagedAgents(
  client: LettaClient,
  criteria: AgentSelectionCriteria = {}
): Promise<AgentSelectionResult> {
  const allAgents: SelectedAgent[] = [];
  const allErrors: string[] = [];
  const allWarnings: string[] = [];
  let cursor: string | undefined;
  let totalFiltered = 0;

  const effectiveCriteria: AgentSelectionCriteria = {
    managedOnly: true,
    ...criteria,
  };

  // Paginate through all results
  do {
    const result = await selectAgents(client, {
      criteria: effectiveCriteria,
      limit: MAX_LIMIT,
      cursor,
    });

    allAgents.push(...result.agents);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
    totalFiltered += result.filteredCount;

    cursor = result.nextCursor;

    // Safety limit to prevent infinite loops
    if (allAgents.length > 10000) {
      allWarnings.push(
        'Reached maximum agent limit (10000). Some agents may not be included.'
      );
      break;
    }
  } while (cursor);

  return {
    agents: allAgents,
    totalCount: allAgents.length,
    filteredCount: totalFiltered,
    criteria: effectiveCriteria,
    hasMore: false,
    errors: allErrors,
    warnings: allWarnings,
  };
}

// =============================================================================
// Filtering Functions
// =============================================================================

/**
 * Check if an agent matches the selection criteria
 */
function matchesCriteria(
  agent: SelectedAgent,
  criteria: AgentSelectionCriteria
): boolean {
  // Managed filter
  if (criteria.managedOnly && !agent.isManaged) {
    return false;
  }

  // Role filter
  if (criteria.roles && criteria.roles.length > 0) {
    if (!agent.role || !criteria.roles.includes(agent.role)) {
      return false;
    }
  }

  // Channel filter
  if (criteria.channels && criteria.channels.length > 0) {
    if (!agent.channel || !criteria.channels.includes(agent.channel)) {
      return false;
    }
  }

  // Project filter
  if (criteria.project) {
    if (agent.parsedTags.project !== criteria.project) {
      return false;
    }
  }

  // Org filter
  if (criteria.org) {
    if (agent.parsedTags.org !== criteria.org) {
      return false;
    }
  }

  // Name pattern filter
  if (criteria.namePattern) {
    if (!matchesGlobPattern(agent.name, criteria.namePattern)) {
      return false;
    }
  }

  // Include tags filter
  if (criteria.includeTags && criteria.includeTags.length > 0) {
    const hasAllTags = criteria.includeTags.every((tag) =>
      agent.tags.includes(tag)
    );
    if (!hasAllTags) {
      return false;
    }
  }

  // Exclude tags filter
  if (criteria.excludeTags && criteria.excludeTags.length > 0) {
    const hasAnyExcluded = criteria.excludeTags.some((tag) =>
      agent.tags.includes(tag)
    );
    if (hasAnyExcluded) {
      return false;
    }
  }

  return true;
}

/**
 * Simple glob pattern matching for agent names
 * Supports * (any chars) and ? (single char)
 */
function matchesGlobPattern(name: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
    .replace(/\*/g, '.*') // * -> .*
    .replace(/\?/g, '.'); // ? -> .

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(name);
}

/**
 * Validate selection criteria
 */
function validateSelectionCriteria(
  criteria: AgentSelectionCriteria
): string[] {
  const errors: string[] = [];

  // Validate roles
  if (criteria.roles) {
    for (const role of criteria.roles) {
      if (!VALID_ROLES.includes(role)) {
        errors.push(
          `Invalid role: "${role}". Valid roles are: ${VALID_ROLES.join(', ')}`
        );
      }
    }
  }

  // Validate channels
  if (criteria.channels) {
    for (const channel of criteria.channels) {
      if (!VALID_CHANNELS.includes(channel)) {
        errors.push(
          `Invalid channel: "${channel}". Valid channels are: ${VALID_CHANNELS.join(', ')}`
        );
      }
    }
  }

  return errors;
}

// =============================================================================
// Summary Functions
// =============================================================================

/**
 * Generate summary statistics for selected agents
 */
export function summarizeSelection(
  agents: SelectedAgent[]
): AgentSelectionSummary {
  const summary: AgentSelectionSummary = {
    total: agents.length,
    byRole: {},
    byChannel: {},
  };

  for (const agent of agents) {
    // Count by role
    if (agent.role) {
      summary.byRole[agent.role] = (summary.byRole[agent.role] ?? 0) + 1;
    }

    // Count by channel
    if (agent.channel) {
      summary.byChannel[agent.channel] =
        (summary.byChannel[agent.channel] ?? 0) + 1;
    }
  }

  return summary;
}

/**
 * Format selection summary for display
 */
export function formatSelectionSummary(summary: AgentSelectionSummary): string {
  const lines: string[] = [];

  lines.push(`Total agents: ${summary.total}`);

  if (Object.keys(summary.byRole).length > 0) {
    lines.push('\nBy Role:');
    for (const [role, count] of Object.entries(summary.byRole)) {
      lines.push(`  ${role}: ${count}`);
    }
  }

  if (Object.keys(summary.byChannel).length > 0) {
    lines.push('\nBy Channel:');
    for (const [channel, count] of Object.entries(summary.byChannel)) {
      lines.push(`  ${channel}: ${count}`);
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Batch Operation Helpers
// =============================================================================

/**
 * Partition agents into batches for parallel processing
 */
export function partitionAgents(
  agents: SelectedAgent[],
  batchSize: number = 10
): SelectedAgent[][] {
  const batches: SelectedAgent[][] = [];

  for (let i = 0; i < agents.length; i += batchSize) {
    batches.push(agents.slice(i, i + batchSize));
  }

  return batches;
}

/**
 * Get agent IDs for API operations
 */
export function getAgentIds(agents: SelectedAgent[]): string[] {
  return agents.map((a) => a.id);
}

/**
 * Group agents by channel for staged rollouts
 */
export function groupByChannel(
  agents: SelectedAgent[]
): Map<Channel | 'unknown', SelectedAgent[]> {
  const groups = new Map<Channel | 'unknown', SelectedAgent[]>();

  for (const agent of agents) {
    const channel = agent.channel ?? 'unknown';
    const existing = groups.get(channel) ?? [];
    existing.push(agent);
    groups.set(channel, existing);
  }

  return groups;
}

/**
 * Group agents by role
 */
export function groupByRole(
  agents: SelectedAgent[]
): Map<AgentRole | 'unknown', SelectedAgent[]> {
  const groups = new Map<AgentRole | 'unknown', SelectedAgent[]>();

  for (const agent of agents) {
    const role = agent.role ?? 'unknown';
    const existing = groups.get(role) ?? [];
    existing.push(agent);
    groups.set(role, existing);
  }

  return groups;
}
