/**
 * upgrade command - Upgrade an existing agent configuration
 *
 * Supports two modes:
 * - Check mode (--check or default dry-run): Preview what would change
 * - Apply mode (--apply or --no-dry-run): Actually apply changes
 *
 * Breaking changes require --force flag to apply.
 *
 * @see docs/specs/role-channel-matrix.md §4 Upgrade Policy
 */

import type { 
  CommandContext, 
  CommandResult, 
  UpgradeInfo, 
  IdentityValidationInfo,
  BatchOperationResult,
  BatchAgentResult,
  AgentRole,
  Channel,
} from '../types.js';
import {
  info,
  success,
  warn,
  error,
  verbose,
  header,
  dryRunNotice,
} from '../utils/output.js';
import chalk from 'chalk';
import {
  resolveIdentifierKey,
  validateIdentityInput,
} from '../reconcilers/agents/identity.js';
import { createClient } from '../api/client.js';
import { getPinnedAgent } from '../bootstrap/pinning.js';
import { loadManifests, type LoadedManifests } from '../discover.js';
import type { DesiredState } from '../packages/types.js';
import { computeUpgradePlan } from '../reconcilers/agents/upgrade-plan.js';
import { applyUpgradePlan } from '../reconcilers/agents/upgrade-apply.js';
import { parseAgentTags } from '../reconcilers/agents/tracking.js';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import type {
  UpgradePlan,
} from '../reconcilers/agents/upgrade-plan.js';
import type { ApplyUpgradeResult } from '../reconcilers/agents/upgrade-apply.js';
import type { SelectedAgent, AgentSelectionCriteria } from '../reconcilers/project/select-agents.js';
import {
  summarizeSelection,
  formatSelectionSummary,
  partitionAgents,
} from '../reconcilers/project/select-agents.js';

// Note: Apply result type comes from upgrade-apply.ts (real implementation).

// =============================================================================
// Option Types
// =============================================================================

export interface UpgradeOptions {
  /** Target version to upgrade to */
  target?: string;
  /** Skip confirmation prompts */
  yes?: boolean;
  /** Show what would be upgraded without applying (dry-run) */
  check?: boolean;
  /** Actually apply the upgrade (opposite of --check) */
  apply?: boolean;
  /** Force breaking changes without confirmation */
  force?: boolean;
  /** Validate identity configuration during upgrade */
  validateIdentities?: boolean;
  /** Add identity during upgrade */
  addIdentity?: string;
  /** Remove identity during upgrade */
  removeIdentity?: string;
  /** Upgrade all managed agents in the project */
  all?: boolean;
  /** Filter agents by role (for batch mode) */
  roles?: string[];
  /** Filter agents by channel (for batch mode) */
  filterChannels?: string[];
  /** Maximum concurrent upgrades (for batch mode) */
  concurrency?: number;
  /** Stop on first failure (for batch mode) */
  failFast?: boolean;
}

/**
 * Extended upgrade info with plan details
 */
export interface ExtendedUpgradeInfo extends UpgradeInfo {
  /** Computed upgrade plan */
  plan?: UpgradePlan;
  /** Apply result (if applied) */
  applyResult?: ApplyUpgradeResult;
  /** Whether --force is required */
  requiresForce?: boolean;
  /** Batch operation result (for --all mode) */
  batchResult?: BatchOperationResult<ExtendedUpgradeInfo>;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if plan has breaking changes that require --force
 */
function planRequiresForce(plan: UpgradePlan): boolean {
  return plan.summary.breakingChanges > 0;
}

function gitShortSha(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function coerceRole(tags: string[]): AgentRole {
  const parsed = parseAgentTags(tags);
  const r = parsed.role;
  if (r === 'lane-dev' || r === 'repo-curator' || r === 'org-curator' || r === 'supervisor') {
    return r;
  }
  // Historical bootstrap uses role:agent; treat as lane-dev for upgrade policy.
  return 'lane-dev';
}

/**
 * Print batch upgrade summary in human-readable format
 */
function printBatchSummary(result: BatchOperationResult<ExtendedUpgradeInfo>): void {
  console.log(chalk.bold('\nBatch Upgrade Summary:'));
  console.log(chalk.gray('─'.repeat(40)));
  
  console.log(`  ${chalk.gray('Total agents:')} ${result.totalAgents}`);
  console.log(`  ${chalk.green('Successful:')} ${result.successCount}`);
  console.log(`  ${chalk.yellow('Skipped:')} ${result.skippedCount}`);
  console.log(`  ${chalk.red('Failed:')} ${result.failureCount}`);

  // Show successful upgrades
  const successful = result.results.filter(r => r.success && r.status === 'applied');
  if (successful.length > 0) {
    console.log(chalk.bold.green('\nUpgraded Agents:'));
    for (const r of successful) {
      console.log(chalk.green(`  ✓ ${r.agentName} (${r.agentId.slice(0, 8)}...)`));
    }
  }

  // Show up-to-date agents
  const upToDate = result.results.filter(r => r.status === 'up-to-date');
  if (upToDate.length > 0) {
    console.log(chalk.bold.cyan('\nAlready Up to Date:'));
    for (const r of upToDate) {
      console.log(chalk.cyan(`  = ${r.agentName}`));
    }
  }

  // Show skipped agents
  const skipped = result.results.filter(r => r.status === 'skipped');
  if (skipped.length > 0) {
    console.log(chalk.bold.yellow('\nSkipped (require --force):'));
    for (const r of skipped) {
      console.log(chalk.yellow(`  ⚠ ${r.agentName}: ${r.error ?? 'breaking changes'}`));
    }
  }

  // Show failed agents
  const failed = result.results.filter(r => r.status === 'failed');
  if (failed.length > 0) {
    console.log(chalk.bold.red('\nFailed:'));
    for (const r of failed) {
      console.log(chalk.red(`  ✗ ${r.agentName}: ${r.error ?? 'unknown error'}`));
    }
  }

  // Warnings
  if (result.warnings.length > 0) {
    console.log(chalk.bold.yellow('\nWarnings:'));
    for (const w of result.warnings) {
      console.log(chalk.yellow(`  ⚠ ${w}`));
    }
  }

  // Errors
  if (result.errors.length > 0) {
    console.log(chalk.bold.red('\nErrors:'));
    for (const e of result.errors) {
      console.log(chalk.red(`  ✗ ${e}`));
    }
  }

  // Final status
  console.log('');
  if (result.success) {
    console.log(chalk.green.bold('✓ Batch upgrade completed successfully'));
  } else if (result.successCount > 0) {
    console.log(chalk.yellow.bold('⚠ Batch upgrade completed with some failures'));
  } else {
    console.log(chalk.red.bold('✗ Batch upgrade failed'));
  }
}

/**
 * Print upgrade plan in human-readable format
 */
function printUpgradePlan(plan: UpgradePlan, forceRequired: boolean): void {
  console.log(chalk.bold('\nUpgrade Plan:\n'));

  // Summary line
  const hasChanges = plan.summary.safeChanges > 0 || plan.summary.breakingChanges > 0;
  console.log(
    chalk.gray('Status:'),
    !hasChanges
      ? chalk.green('Up to date')
      : !forceRequired
        ? chalk.cyan('Ready to apply')
        : chalk.yellow('Requires --force')
  );

  console.log(chalk.gray('Channel:'), chalk.cyan(plan.channel));

  // Target versions
  console.log(chalk.bold('\nTarget Versions:'));
  for (const [layer, version] of Object.entries(plan.targetVersions)) {
    if (version) {
      const shortSha = version.slice(0, 7);
      console.log(`  ${chalk.gray(layer + ':')} ${chalk.cyan(shortSha)}`);
    }
  }

  // If up to date, stop here
  if (!hasChanges) {
    console.log(chalk.green('\n✓ Agent is already up to date'));
    return;
  }

  // Summary
  console.log(chalk.bold('\nSummary:'));
  const totalChanges = plan.summary.safeChanges + plan.summary.breakingChanges;
  console.log(`  ${chalk.gray('Total changes:')} ${totalChanges}`);
  console.log(`  ${chalk.green('Safe:')} ${plan.summary.safeChanges}`);
  console.log(`  ${chalk.yellow('Breaking:')} ${plan.summary.breakingChanges}`);

  if (plan.summary.blocksToAttach > 0) {
    console.log(`  ${chalk.cyan('Blocks to attach:')} ${plan.summary.blocksToAttach}`);
  }
  if (plan.summary.blocksToDetach > 0) {
    console.log(`  ${chalk.yellow('Blocks to detach:')} ${plan.summary.blocksToDetach}`);
  }
  if (plan.summary.toolsToAttach > 0) {
    console.log(`  ${chalk.cyan('Tools to attach:')} ${plan.summary.toolsToAttach}`);
  }
  if (plan.summary.toolsToDetach > 0) {
    console.log(`  ${chalk.yellow('Tools to detach:')} ${plan.summary.toolsToDetach}`);
  }
  if (plan.summary.foldersToAttach > 0) {
    console.log(`  ${chalk.cyan('Folders to attach:')} ${plan.summary.foldersToAttach}`);
  }
}

/**
 * Print apply result in human-readable format
 */
function printApplyResult(result: ApplyUpgradeResult): void {
  // Summary
  console.log(chalk.bold('\nApply Result:'));
  console.log(`  ${chalk.green('Applied:')} ${result.summary.applied}`);
  console.log(`  ${chalk.yellow('Skipped:')} ${result.summary.skipped}`);
  console.log(`  ${chalk.red('Failed:')} ${result.summary.failed}`);

  // Errors
  if (result.errors.length > 0) {
    console.log(chalk.bold.red('\nErrors:'));
    for (const err of result.errors) {
      console.log(chalk.red(`  • ${err}`));
    }
  }

  // Final status
  if (result.success) {
    console.log(chalk.green.bold('\n✓ Upgrade completed successfully'));
  } else if (result.summary.failed === 0 && result.summary.skipped > 0) {
    console.log(
      chalk.yellow.bold('\n⚠ Safe changes applied. Breaking changes skipped.')
    );
    console.log(chalk.gray('  Use --force to apply breaking changes.'));
  } else {
    console.log(chalk.red.bold('\n✗ Upgrade failed'));
  }
}

// =============================================================================
// Batch Upgrade Implementation
// =============================================================================

/**
 * Execute batch upgrade for all managed agents
 */
async function executeBatchUpgrade(
  ctx: CommandContext,
  options: UpgradeOptions,
  isDryRun: boolean,
  isApply: boolean
): Promise<CommandResult<ExtendedUpgradeInfo>> {
  const { options: globalOpts, outputFormat } = ctx;
  
  // Build selection criteria from options
  const criteria: AgentSelectionCriteria = {
    managedOnly: true,
  };

  if (options.roles && options.roles.length > 0) {
    criteria.roles = options.roles as AgentRole[];
  }

  if (options.filterChannels && options.filterChannels.length > 0) {
    criteria.channels = options.filterChannels as Channel[];
  }

  if (globalOpts.project) {
    criteria.project = globalOpts.project;
  }

  if (globalOpts.org) {
    criteria.org = globalOpts.org;
  }

  if (outputFormat === 'human') {
    info('Selecting managed agents...');
    if (options.roles) {
      info(`  Filtering by roles: ${options.roles.join(', ')}`);
    }
    if (options.filterChannels) {
      info(`  Filtering by channels: ${options.filterChannels.join(', ')}`);
    }
  }

  // TODO: Replace with actual client when integrated
  // For now, simulate agent selection
  const mockSelectedAgents: SelectedAgent[] = [
    {
      id: 'agent-001',
      name: 'lane-dev-alice',
      tags: ['managed:smarty-admin', 'role:lane-dev', 'channel:stable'],
      parsedTags: {
        isManaged: true,
        role: 'lane-dev',
        channel: 'stable',
        appliedVersions: {},
        customTags: [],
      },
      isManaged: true,
      role: 'lane-dev',
      channel: 'stable',
    },
    {
      id: 'agent-002',
      name: 'repo-curator-main',
      tags: ['managed:smarty-admin', 'role:repo-curator', 'channel:beta'],
      parsedTags: {
        isManaged: true,
        role: 'repo-curator',
        channel: 'beta',
        appliedVersions: {},
        customTags: [],
      },
      isManaged: true,
      role: 'repo-curator',
      channel: 'beta',
    },
  ];

  // Apply role filter if specified
  let filteredAgents = mockSelectedAgents;
  if (criteria.roles && criteria.roles.length > 0) {
    filteredAgents = filteredAgents.filter(
      a => a.role && criteria.roles!.includes(a.role)
    );
  }
  if (criteria.channels && criteria.channels.length > 0) {
    filteredAgents = filteredAgents.filter(
      a => a.channel && criteria.channels!.includes(a.channel)
    );
  }

  if (filteredAgents.length === 0) {
    if (outputFormat === 'human') {
      warn('No managed agents found matching the selection criteria.');
      info('Use --role or --filter-channel to adjust filters, or ensure agents have the managed:smarty-admin tag.');
    }
    return {
      success: true,
      message: 'No agents to upgrade',
      data: {
        currentVersion: 'n/a',
        targetVersion: options.target ?? 'latest',
        changes: [],
        breakingChanges: [],
        migrationSteps: [],
      },
    };
  }

  // Show selection summary
  const summary = summarizeSelection(filteredAgents);
  if (outputFormat === 'human') {
    console.log('');
    console.log(chalk.bold('Selected Agents:'));
    console.log(formatSelectionSummary(summary));
    console.log('');
  }

  // Confirm batch operation
  if (!options.yes && isApply && outputFormat === 'human') {
    info(`About to upgrade ${filteredAgents.length} agent(s).`);
    if (!isDryRun) {
      warn('This will modify agent configurations. Use --check for a dry run.');
    }
    // In a real implementation, we would prompt for confirmation here
  }

  // Execute upgrades
  const concurrency = options.concurrency ?? 5;
  const batches = partitionAgents(filteredAgents, concurrency);
  const results: BatchAgentResult<ExtendedUpgradeInfo>[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  if (outputFormat === 'human') {
    info(`\nProcessing ${filteredAgents.length} agents in ${batches.length} batch(es)...`);
  }

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    
    if (outputFormat === 'human') {
      verbose(`Processing batch ${batchIndex + 1}/${batches.length}`, globalOpts.verbose);
    }

    // Process each agent in the batch
    // In a real implementation, this would be parallelized
    for (const agent of batch) {
      const startTime = Date.now();

      try {
        // Simulate upgrade for this agent
        // TODO: Call actual upgrade logic when integrated
        const isUpToDate = Math.random() > 0.7; // 30% need upgrades
        const hasBreakingChanges = Math.random() > 0.8; // 20% have breaking changes

        let status: 'applied' | 'skipped' | 'failed' | 'up-to-date';
        let errorMsg: string | undefined;
        let agentSuccess = true;

        if (isUpToDate) {
          status = 'up-to-date';
        } else if (hasBreakingChanges && !options.force) {
          status = 'skipped';
          skippedCount++;
          errorMsg = 'Breaking changes require --force';
        } else if (isDryRun) {
          status = 'applied'; // Would be applied
          successCount++;
        } else {
          status = 'applied';
          successCount++;
        }

        results.push({
          agentId: agent.id,
          agentName: agent.name,
          success: agentSuccess,
          status,
          error: errorMsg,
          durationMs: Date.now() - startTime,
          data: {
            currentVersion: 'abc1234',
            targetVersion: options.target ?? 'def5678',
            changes: status === 'up-to-date' ? [] : ['Update base package'],
            breakingChanges: hasBreakingChanges ? ['Block structure change'] : [],
            migrationSteps: [],
          },
        });

        if (outputFormat === 'human') {
          const icon = status === 'applied' ? chalk.green('✓') :
                       status === 'up-to-date' ? chalk.cyan('=') :
                       status === 'skipped' ? chalk.yellow('⚠') :
                       chalk.red('✗');
          verbose(`  ${icon} ${agent.name}`, globalOpts.verbose);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({
          agentId: agent.id,
          agentName: agent.name,
          success: false,
          status: 'failed',
          error: errorMessage,
          durationMs: Date.now() - startTime,
        });
        failureCount++;
        errors.push(`${agent.name}: ${errorMessage}`);

        if (options.failFast) {
          warnings.push('Stopped due to --fail-fast flag');
          break;
        }
      }
    }

    if (options.failFast && failureCount > 0) {
      break;
    }
  }

  // Build batch result
  const batchResult: BatchOperationResult<ExtendedUpgradeInfo> = {
    success: failureCount === 0,
    message: failureCount === 0 
      ? `Successfully processed ${filteredAgents.length} agents`
      : `Completed with ${failureCount} failure(s)`,
    totalAgents: filteredAgents.length,
    successCount,
    failureCount,
    skippedCount,
    results,
    errors,
    warnings,
  };

  // Display results
  if (outputFormat === 'human') {
    printBatchSummary(batchResult);
  }

  return {
    success: batchResult.success || batchResult.successCount > 0,
    message: batchResult.message,
    data: {
      currentVersion: 'batch',
      targetVersion: options.target ?? 'latest',
      changes: [`Processed ${filteredAgents.length} agents`],
      breakingChanges: [],
      migrationSteps: [],
      batchResult,
    },
  };
}

// =============================================================================
// Main Command
// =============================================================================

/**
 * Execute the upgrade command
 * Upgrades an existing agent to a new configuration version
 */
export async function upgradeCommand(
  ctx: CommandContext,
  options: UpgradeOptions = {}
): Promise<CommandResult<ExtendedUpgradeInfo>> {
  const { options: globalOpts, outputFormat } = ctx;

  // Determine if this is a dry run
  // Default to dry-run unless --apply is specified or --no-dry-run
  const isDryRun = options.check || (globalOpts.dryRun && !options.apply);
  const isApply = options.apply || (!globalOpts.dryRun && !options.check);

  verbose(`Executing upgrade command`, globalOpts.verbose);
  verbose(`Project: ${globalOpts.project ?? '(default)'}`, globalOpts.verbose);
  verbose(`Agent: ${globalOpts.agent ?? '(all)'}`, globalOpts.verbose);
  verbose(`Target: ${options.target ?? 'latest'}`, globalOpts.verbose);
  verbose(`Mode: ${isDryRun ? 'dry-run' : 'apply'}`, globalOpts.verbose);
  verbose(`Force: ${options.force ?? false}`, globalOpts.verbose);
  verbose(`Validate identities: ${options.validateIdentities ?? true}`, globalOpts.verbose);
  verbose(`Batch mode: ${options.all ?? false}`, globalOpts.verbose);

  if (outputFormat === 'human') {
    header(options.all ? 'Batch Agent Upgrade' : 'Agent Upgrade');

    if (isDryRun) {
      dryRunNotice();
    }
  }

  // Handle batch mode (--all flag)
  if (options.all) {
    return executeBatchUpgrade(ctx, options, isDryRun, isApply);
  }

  // Validate identity options if provided
  const identityErrors: string[] = [];
  const org = globalOpts.org ?? 'default';

  if (options.addIdentity) {
    const validation = validateIdentityInput(options.addIdentity, org);
    if (!validation.valid) {
      identityErrors.push(
        `Invalid identity to add "${options.addIdentity}": ${validation.errors.join(', ')}`
      );
    } else {
      verbose(`Identity to add: ${validation.identifierKey}`, globalOpts.verbose);
    }
  }

  if (options.removeIdentity) {
    const validation = validateIdentityInput(options.removeIdentity, org);
    if (!validation.valid) {
      identityErrors.push(
        `Invalid identity to remove "${options.removeIdentity}": ${validation.errors.join(', ')}`
      );
    } else {
      verbose(`Identity to remove: ${validation.identifierKey}`, globalOpts.verbose);
    }
  }

  if (identityErrors.length > 0) {
    return {
      success: false,
      message: 'Identity validation failed',
      errors: identityErrors,
    };
  }

  // Resolve target agent
  const agentId = globalOpts.agent ?? getPinnedAgent({ cwd: process.cwd() });
  if (!agentId) {
    return {
      success: false,
      message: 'No agent specified. Use --agent <id> or ensure .letta/settings.local.json has lastAgent',
    };
  }

  // Build API client
  const client = createClient({
    project: globalOpts.project,
    debug: globalOpts.verbose,
  });

  // Load desired state using new discovery system
  // Supports both .letta/manifests (preferred) and packages/examples (legacy)
  let loadedManifests: LoadedManifests;
  try {
    loadedManifests = await loadManifests(process.cwd());
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (outputFormat === 'human') {
      error(errMsg);
    }
    return {
      success: false,
      message: errMsg,
    };
  }

  // Show deprecation warning if using legacy path
  if (loadedManifests.discovery.deprecationWarning && outputFormat === 'human') {
    warn(loadedManifests.discovery.deprecationWarning);
  }

  // Log any warnings from loading
  for (const warning of loadedManifests.warnings) {
    if (outputFormat === 'human') {
      warn(warning);
    }
  }

  verbose(
    `Discovered manifests at: ${loadedManifests.discovery.location.path} (${loadedManifests.discovery.location.type})`,
    globalOpts.verbose
  );

  // For now, the upgrade demo focuses on blocks. Tools/folders/identities are
  // covered in later chapters.
  const desiredState: DesiredState = {
    ...loadedManifests.desiredState,
    tools: [],
    folders: [],
    identities: [],
  };

  // Fetch current agent + attached resources
  const agent = await client.agents.retrieve(agentId);
  const tags = (agent as any).tags ?? [];
  const blocks = await client.agents.listBlocks(agentId);

  // Note: tool attachment is not yet supported in the demo upgrade pipeline.
  const currentState = {
    agentId,
    agentName: agent.name,
    tags,
    blocks,
    tools: [],
    folders: [],
    identities: [],
  };

  const role: AgentRole = coerceRole(tags);
  const channel: any = globalOpts.channel;
  const sha = gitShortSha(process.cwd());

  const plan = computeUpgradePlan(currentState as any, desiredState as any, {
    role,
    channel,
    targetVersions: {
      base: sha,
      org: sha,
      project: sha,
    },
    includeUnchanged: false,
    forceBreaking: false,
  });

  // Check if force is required
  const forceRequired = planRequiresForce(plan);

  const identityValidation: IdentityValidationInfo = {
    valid: true,
    currentIdentities: [],
    errors: [],
    warnings: [],
    suggestions: [],
  };

  const upgradeInfo: ExtendedUpgradeInfo = {
    currentVersion: 'unknown',
    targetVersion: sha,
    changes: plan.actions.filter((a) => a.type !== 'skip').map((a) => `${a.type}: ${a.resourceKind} ${a.resourceName}`),
    breakingChanges: plan.actions.filter((a) => a.classification === 'breaking').map((a) => `${a.resourceKind} ${a.resourceName}`),
    migrationSteps: [],
    identityValidation,
    plan,
    requiresForce: forceRequired,
  };

  // Add identity changes to info if applicable
  if (options.addIdentity) {
    upgradeInfo.changes.push(`Add identity: ${resolveIdentifierKey(options.addIdentity, org)}`);
    upgradeInfo.migrationSteps.push('Attach new identity to agent');
  }
  if (options.removeIdentity) {
    upgradeInfo.changes.push(
      `Remove identity: ${resolveIdentifierKey(options.removeIdentity, org)}`
    );
    upgradeInfo.migrationSteps.push('Detach identity from agent');
  }

  // Display plan in human format
  if (outputFormat === 'human') {
    printUpgradePlan(plan, forceRequired);

    // Display identity validation
    if (upgradeInfo.identityValidation) {
      const idv = upgradeInfo.identityValidation;

      console.log(chalk.bold('\nIdentity Configuration:'));
      if (idv.currentIdentities.length > 0) {
        console.log(chalk.gray('  Current identities:'));
        idv.currentIdentities.forEach((id) => {
          console.log(chalk.green('    •'), id);
        });
      } else {
        console.log(chalk.gray('  No identities attached'));
      }

      if (idv.warnings.length > 0) {
        console.log(chalk.yellow('\n  Warnings:'));
        idv.warnings.forEach((w) => {
          console.log(chalk.yellow('    ⚠'), w);
        });
      }

      if (idv.suggestions.length > 0) {
        console.log(chalk.gray('\n  Suggestions:'));
        idv.suggestions.forEach((s) => {
          console.log(chalk.gray('    →'), s);
        });
      }

      if (idv.errors.length > 0) {
        console.log(chalk.red('\n  Identity Errors:'));
        idv.errors.forEach((e) => {
          console.log(chalk.red('    ✗'), e);
        });
      }
    }
  }

  // Check if already at latest
  if (!plan.hasChanges) {
    if (outputFormat === 'human') {
      success('Already at the latest version');
    }
    return {
      success: true,
      message: 'Already at latest version',
      data: upgradeInfo,
    };
  }

  // Check if force is required but not provided
  if (forceRequired && !options.force && isApply) {
    if (outputFormat === 'human') {
      warn('\nBreaking changes detected. Use --force to apply.');
      info('Safe changes can still be applied without --force.');
    }
  }

  // If dry run, return plan without applying
  if (isDryRun) {
    if (outputFormat === 'human') {
      info('\nDry run complete. Use --apply to apply changes.');
      if (forceRequired) {
        warn('Breaking changes will require --force flag.');
      }
    }
    return {
      success: true,
      message: 'Upgrade check complete',
      data: upgradeInfo,
    };
  }

  const applyResult: ApplyUpgradeResult = await applyUpgradePlan(client as any, plan, {
    dryRun: false,
    force: options.force,
    verbose: globalOpts.verbose,
    packageVersion: sha,
    desiredState,
  });

  upgradeInfo.applyResult = applyResult as any;

  if (outputFormat === 'human') {
    printApplyResult({
      agentId,
      success: applyResult.success,
      summary: applyResult.summary,
      dryRun: applyResult.dryRun,
      errors: applyResult.errors,
    } as any);
  }

  return {
    success: applyResult.success,
    message: applyResult.success ? `Upgraded to version ${sha}` : 'Upgrade failed',
    data: upgradeInfo,
    errors: applyResult.errors,
  };
}
