/**
 * Batch Upgrade Execution
 *
 * Runs upgrades for multiple agents with:
 * - Parallel or sequential execution
 * - Failure isolation (continue on error)
 * - Progress tracking
 * - Aggregated result reporting
 *
 * This module provides the implementation behind the `--all` flag
 * in the upgrade command.
 *
 * @module reconcilers/project/batch-upgrade
 */

import type { LettaClient } from '../../api/client.js';
import type { AgentState } from '../../api/types.js';
import type {
  BatchOperationResult,
  BatchAgentResult as TypesBatchAgentResult,
  BatchUpgradeOptions as TypesBatchUpgradeOptions,
  BatchProgressCallback,
  BatchProgress,
} from '../../types.js';
import type {
  UpgradePlan,
  ComputePlanOptions,
  AgentRole,
} from '../agents/upgrade-plan.js';
import type {
  ApplyUpgradeResult,
  ApplyUpgradeOptions,
  LettaAgentClient,
} from '../agents/upgrade-apply.js';
import type { UpgradeChannel, PackageLayer } from '../agents/state.js';
import type { SelectedAgent, AgentSelectionCriteria } from './select-agents.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended batch agent result with upgrade-specific details
 */
export interface UpgradeAgentResult<T = unknown> extends TypesBatchAgentResult<T> {
  /** The computed plan (may be present even on failure) */
  plan?: UpgradePlan;
  /** The apply result (if upgrade was attempted) */
  applyResult?: ApplyUpgradeResult;
  /** Reason for skipping (if applicable) */
  skipReason?: string;
}

/**
 * Aggregated statistics for batch upgrade
 */
export interface BatchUpgradeStats {
  /** Total agents in batch */
  total: number;
  /** Agents successfully upgraded */
  succeeded: number;
  /** Agents that failed upgrade */
  failed: number;
  /** Agents skipped (already up to date, etc.) */
  skipped: number;
  /** Agents up to date (subset of skipped) */
  upToDate: number;
  /** Total changes applied across all agents */
  totalChangesApplied: number;
  /** Total breaking changes encountered */
  totalBreakingChanges: number;
  /** Total safe changes applied */
  totalSafeChanges: number;
  /** Total time taken (ms) */
  totalDurationMs: number;
}

/**
 * Complete batch upgrade result with extended statistics
 */
export interface BatchUpgradeResult<T = unknown> extends BatchOperationResult<T> {
  /** Unique batch ID */
  batchId: string;
  /** Timestamp when batch started */
  startedAt: string;
  /** Timestamp when batch completed */
  completedAt: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Extended statistics */
  stats: BatchUpgradeStats;
}

/**
 * Extended options for batch upgrade execution
 */
export interface ExecuteBatchUpgradeOptions extends TypesBatchUpgradeOptions {
  /** Don't actually apply changes, just show what would happen */
  dryRun?: boolean;
  /** Continue on failure (don't abort batch) - default: true */
  continueOnFailure?: boolean;
  /** Progress callback for UI updates */
  onProgress?: BatchProgressCallback;
  /** Agent result callback for streaming results */
  onAgentComplete?: (result: UpgradeAgentResult) => void;
  /** Package version (git SHA) to stamp on synced state */
  packageVersion?: string;
  /** Package paths by layer */
  packagePaths?: Partial<Record<PackageLayer, string>>;
  /** Target package versions */
  targetVersions?: Partial<Record<PackageLayer, string>>;
}

/**
 * Interface for plan computation (to be injected)
 */
export interface PlanComputer {
  computePlan(agent: AgentState, options: ComputePlanOptions): Promise<UpgradePlan>;
}

// =============================================================================
// Batch Execution
// =============================================================================

/**
 * Generate a unique batch ID
 */
function generateBatchId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `batch-${timestamp}-${random}`;
}

/**
 * Execute batch upgrade for multiple agents
 *
 * Processes agents sequentially (or with limited concurrency),
 * continuing on failure by default. Returns aggregated results
 * for all agents.
 *
 * @param client - Letta API client (with agent operations)
 * @param agents - List of agents to upgrade (as SelectedAgent or AgentState)
 * @param planComputer - Plan computation interface
 * @param planOptions - Options for computing upgrade plans
 * @param options - Batch execution options
 * @returns Aggregated batch upgrade result
 */
export async function executeBatchUpgrade<T = unknown>(
  client: LettaAgentClient,
  agents: Array<SelectedAgent | AgentState>,
  planComputer: PlanComputer,
  planOptions: ComputePlanOptions,
  options: ExecuteBatchUpgradeOptions
): Promise<BatchUpgradeResult<T>> {
  const batchId = generateBatchId();
  const startedAt = new Date().toISOString();
  const continueOnFailure = options.continueOnFailure ?? true;
  const concurrency = options.concurrency ?? 1;
  const dryRun = options.dryRun ?? false;

  const results: UpgradeAgentResult<T>[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // Stats tracking
  const stats: BatchUpgradeStats = {
    total: agents.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    upToDate: 0,
    totalChangesApplied: 0,
    totalBreakingChanges: 0,
    totalSafeChanges: 0,
    totalDurationMs: 0,
  };

  // Import dynamically to avoid circular dependencies
  const { applyUpgradePlan, canProceedWithUpgrade } = await import('../agents/upgrade-apply.js');

  const startTime = Date.now();

  /**
   * Process a single agent upgrade
   */
  async function processAgent(
    agent: SelectedAgent | AgentState,
    index: number
  ): Promise<UpgradeAgentResult<T>> {
    const agentStartTime = Date.now();
    const agentId = agent.id;
    const agentName = agent.name;

    // Report progress
    if (options.onProgress) {
      const elapsedMs = Date.now() - startTime;
      const avgTimePerAgent = index > 0 ? elapsedMs / index : 0;
      const estimatedRemainingMs = avgTimePerAgent * (agents.length - index);
      
      options.onProgress({
        currentAgent: agentName,
        current: index + 1,
        total: agents.length,
        percentage: Math.round(((index + 1) / agents.length) * 100),
        elapsedMs,
        estimatedRemainingMs: index > 0 ? estimatedRemainingMs : undefined,
      });
    }

    try {
      // Convert to AgentState if needed
      const agentState: AgentState = {
        id: agentId,
        name: agentName,
        tags: (agent as SelectedAgent).tags ?? (agent as AgentState).tags ?? [],
        description: agent.description,
        createdAt: (agent as SelectedAgent).createdAt ?? (agent as AgentState).createdAt,
        updatedAt: (agent as SelectedAgent).updatedAt ?? (agent as AgentState).updatedAt,
      };

      // Compute upgrade plan for this agent
      const plan = await planComputer.computePlan(agentState, {
        ...planOptions,
        targetVersions: options.targetVersions,
      });

      // Check if agent needs upgrade
      if (!plan.hasChanges) {
        return {
          agentId,
          agentName,
          success: true,
          status: 'up-to-date',
          plan,
          durationMs: Date.now() - agentStartTime,
          skipReason: 'Already up to date',
        };
      }

      // Check if we can proceed with this upgrade
      const applyOpts: ApplyUpgradeOptions = {
        dryRun,
        force: options.force,
        verbose: false,
        packageVersion: options.packageVersion,
        packagePaths: options.packagePaths,
      };

      const policyCheck = canProceedWithUpgrade(plan, applyOpts);
      if (!policyCheck.canProceed && !options.force) {
        return {
          agentId,
          agentName,
          success: true, // Not a failure, just skipped
          status: 'skipped',
          plan,
          durationMs: Date.now() - agentStartTime,
          skipReason: policyCheck.reason ?? 'Breaking changes require --force',
        };
      }

      // Apply the upgrade
      const applyResult = await applyUpgradePlan(client, plan, applyOpts);

      return {
        agentId,
        agentName,
        success: applyResult.success,
        status: applyResult.success ? 'applied' : 'failed',
        error: applyResult.success ? undefined : applyResult.error ?? 'Apply failed',
        plan,
        applyResult,
        durationMs: Date.now() - agentStartTime,
      };
    } catch (err) {
      return {
        agentId,
        agentName,
        success: false,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - agentStartTime,
      };
    }
  }

  // Execute upgrades
  if (concurrency === 1) {
    // Sequential execution
    for (let i = 0; i < agents.length; i++) {
      const result = await processAgent(agents[i], i);
      results.push(result);

      // Update stats
      updateStats(stats, result);

      // Notify callback
      if (options.onAgentComplete) {
        options.onAgentComplete(result);
      }

      // Check if we should abort
      if (!result.success && result.status === 'failed' && !continueOnFailure) {
        errors.push(`Batch aborted after agent ${result.agentName} failed`);
        break;
      }
    }
  } else {
    // Concurrent execution with limited parallelism
    const chunks = chunkArray(agents, concurrency);
    let processedCount = 0;

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map((agent, i) => processAgent(agent, processedCount + i))
      );

      for (const result of chunkResults) {
        results.push(result);
        updateStats(stats, result);

        if (options.onAgentComplete) {
          options.onAgentComplete(result);
        }
      }

      processedCount += chunk.length;

      // Check if we should abort after this chunk
      const hasFailure = chunkResults.some((r) => r.status === 'failed');
      if (hasFailure && !continueOnFailure) {
        errors.push('Batch aborted due to failure');
        break;
      }
    }
  }

  const completedAt = new Date().toISOString();
  stats.totalDurationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();

  // Determine overall success
  const overallSuccess = stats.failed === 0;

  // Add warnings for skipped agents
  if (stats.skipped > 0) {
    warnings.push(
      `${stats.skipped} agent(s) skipped (breaking changes require --force)`
    );
  }

  // Add warnings for up-to-date agents
  if (stats.upToDate > 0) {
    warnings.push(`${stats.upToDate} agent(s) already up to date`);
  }

  return {
    batchId,
    startedAt,
    completedAt,
    success: overallSuccess,
    dryRun,
    message: overallSuccess
      ? `Successfully processed ${agents.length} agents`
      : `Completed with ${stats.failed} failure(s)`,
    totalAgents: agents.length,
    successCount: stats.succeeded,
    failureCount: stats.failed,
    skippedCount: stats.skipped + stats.upToDate,
    results: results as TypesBatchAgentResult<T>[],
    stats,
    errors,
    warnings,
  };
}

/**
 * Update stats from a single agent result
 */
function updateStats<T>(stats: BatchUpgradeStats, result: UpgradeAgentResult<T>): void {
  switch (result.status) {
    case 'applied':
      stats.succeeded++;
      if (result.applyResult) {
        stats.totalChangesApplied += result.applyResult.summary.applied;
      }
      if (result.plan?.summary) {
        stats.totalSafeChanges += result.plan.summary.safeChanges;
      }
      break;
    case 'skipped':
      stats.skipped++;
      break;
    case 'up-to-date':
      stats.upToDate++;
      break;
    case 'failed':
      stats.failed++;
      break;
  }

  // Count breaking changes from plan (even if not applied)
  if (result.plan?.summary?.breakingChanges) {
    stats.totalBreakingChanges += result.plan.summary.breakingChanges;
  }
}

/**
 * Split array into chunks of specified size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get failed agent IDs from batch result
 */
export function getFailedAgentIds<T>(result: BatchUpgradeResult<T>): string[] {
  return result.results
    .filter((r) => r.status === 'failed')
    .map((r) => r.agentId);
}

/**
 * Get agents that were skipped due to breaking changes
 */
export function getSkippedAgentIds<T>(result: BatchUpgradeResult<T>): string[] {
  return result.results
    .filter((r) => r.status === 'skipped')
    .map((r) => r.agentId);
}

/**
 * Get agents that were already up to date
 */
export function getUpToDateAgentIds<T>(result: BatchUpgradeResult<T>): string[] {
  return result.results
    .filter((r) => r.status === 'up-to-date')
    .map((r) => r.agentId);
}

/**
 * Check if any agents need --force to complete upgrade
 */
export function hasAgentsNeedingForce<T>(result: BatchUpgradeResult<T>): boolean {
  return result.results.some((r) => r.status === 'skipped');
}

/**
 * Get a one-line summary suitable for commit messages or notifications
 */
export function getOneLinerSummary<T>(result: BatchUpgradeResult<T>): string {
  const { stats, dryRun } = result;
  const prefix = dryRun ? '[dry-run] ' : '';

  if (result.success) {
    if (stats.succeeded === 0 && stats.upToDate === stats.total) {
      return `${prefix}All ${stats.total} agents already up to date`;
    }
    return `${prefix}Upgraded ${stats.succeeded} agent(s) successfully`;
  } else {
    return `${prefix}Upgrade failed: ${stats.succeeded} succeeded, ${stats.failed} failed`;
  }
}
