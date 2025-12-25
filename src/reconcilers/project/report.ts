/**
 * Batch Upgrade Report Generation
 *
 * Provides formatting and output utilities for batch upgrade results:
 * - Human-readable console output with colors
 * - JSON format for CI/automation
 * - Summary statistics and detailed agent reports
 *
 * @module reconcilers/project/report
 */

import chalk from 'chalk';
import type {
  BatchOperationResult,
  BatchAgentResult,
} from '../../types.js';
import type {
  BatchUpgradeResult,
  BatchUpgradeStats,
  UpgradeAgentResult,
} from './batch-upgrade.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Report output format
 */
export type ReportFormat = 'human' | 'json' | 'compact';

/**
 * Report options
 */
export interface ReportOptions {
  /** Output format */
  format: ReportFormat;
  /** Show detailed per-agent results */
  detailed?: boolean;
  /** Show only failures */
  failuresOnly?: boolean;
  /** Include timing information */
  includeTiming?: boolean;
}

/**
 * Formatted report output
 */
export interface FormattedReport {
  /** The formatted string output */
  output: string;
  /** Summary line for quick display */
  summary: string;
  /** Exit code suggestion based on results */
  suggestedExitCode: number;
}

// =============================================================================
// Formatting Utilities
// =============================================================================

/**
 * Format duration in human-readable form
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Format count with appropriate pluralization
 */
function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Get status icon for agent result
 */
function getStatusIcon<T>(result: BatchAgentResult<T>): string {
  switch (result.status) {
    case 'applied':
      return chalk.green('✓');
    case 'up-to-date':
      return chalk.cyan('=');
    case 'skipped':
      return chalk.yellow('⚠');
    case 'failed':
      return chalk.red('✗');
    default:
      return chalk.gray('?');
  }
}

/**
 * Get status label for agent result
 */
function getStatusLabel<T>(result: BatchAgentResult<T>): string {
  switch (result.status) {
    case 'applied':
      return chalk.green('OK');
    case 'up-to-date':
      return chalk.cyan('SYNC');
    case 'skipped':
      return chalk.yellow('SKIP');
    case 'failed':
      return chalk.red('FAIL');
    default:
      return chalk.gray('????');
  }
}

// =============================================================================
// Human-Readable Report
// =============================================================================

/**
 * Generate human-readable batch report
 */
export function formatHumanReport<T>(
  result: BatchOperationResult<T> | BatchUpgradeResult<T>,
  options: Omit<ReportOptions, 'format'> = {}
): string {
  const lines: string[] = [];
  const { detailed = false, failuresOnly = false, includeTiming = true } = options;

  // Check if this is an extended BatchUpgradeResult
  const hasExtendedStats = 'stats' in result && result.stats;
  const stats = hasExtendedStats ? (result as BatchUpgradeResult<T>).stats : null;
  const dryRun = 'dryRun' in result ? (result as BatchUpgradeResult<T>).dryRun : false;
  const batchId = 'batchId' in result ? (result as BatchUpgradeResult<T>).batchId : undefined;

  // Header
  lines.push('');
  lines.push(chalk.bold('='.repeat(60)));
  lines.push(chalk.bold.cyan('  Batch Upgrade Report'));
  lines.push(chalk.bold('='.repeat(60)));
  lines.push('');

  // Batch info
  if (batchId) {
    lines.push(chalk.gray(`Batch ID: ${batchId}`));
  }
  if (dryRun) {
    lines.push(chalk.yellow.bold('[DRY RUN] No changes were applied'));
  }
  lines.push('');

  // Summary stats
  lines.push(formatStatsSummary(result, stats, dryRun));
  lines.push('');

  // Overall status
  if (result.success) {
    lines.push(chalk.green.bold('Status: SUCCESS'));
  } else {
    lines.push(chalk.red.bold('Status: FAILED'));
  }
  lines.push('');

  // Timing
  if (includeTiming && stats) {
    lines.push(chalk.gray(`Duration: ${formatDuration(stats.totalDurationMs)}`));
    if ('startedAt' in result) {
      lines.push(chalk.gray(`Started: ${(result as BatchUpgradeResult<T>).startedAt}`));
    }
    if ('completedAt' in result) {
      lines.push(chalk.gray(`Completed: ${(result as BatchUpgradeResult<T>).completedAt}`));
    }
    lines.push('');
  }

  // Agent results
  if (detailed || failuresOnly) {
    lines.push(chalk.bold('-'.repeat(60)));
    lines.push(chalk.bold(failuresOnly ? '  Failed Agents' : '  Agent Results'));
    lines.push(chalk.bold('-'.repeat(60)));
    lines.push('');

    const agentsToShow = failuresOnly
      ? result.results.filter((r) => r.status === 'failed')
      : result.results;

    if (agentsToShow.length === 0) {
      if (failuresOnly) {
        lines.push(chalk.green('  No failures!'));
      } else {
        lines.push(chalk.gray('  No agents processed'));
      }
    } else {
      for (const agentResult of agentsToShow) {
        lines.push(formatAgentResult(agentResult, includeTiming));
      }
    }
    lines.push('');
  }

  // Warnings
  if (result.warnings.length > 0) {
    lines.push(chalk.yellow.bold('Warnings:'));
    for (const warning of result.warnings) {
      lines.push(chalk.yellow(`  ! ${warning}`));
    }
    lines.push('');
  }

  // Errors
  if (result.errors.length > 0) {
    lines.push(chalk.red.bold('Errors:'));
    for (const err of result.errors) {
      lines.push(chalk.red(`  x ${err}`));
    }
    lines.push('');
  }

  // Footer
  lines.push(chalk.bold('='.repeat(60)));
  lines.push('');

  return lines.join('\n');
}

/**
 * Format stats summary section
 */
function formatStatsSummary<T>(
  result: BatchOperationResult<T>,
  stats: BatchUpgradeStats | null,
  dryRun: boolean
): string {
  const lines: string[] = [];

  lines.push(chalk.bold('Summary:'));
  lines.push('');

  // Agent counts
  const total = result.totalAgents;
  const processed = result.successCount + result.failureCount;

  lines.push(`  Total agents:     ${chalk.cyan(total)}`);
  lines.push(
    `  Succeeded:        ${chalk.green(result.successCount)} ${
      processed > 0 ? chalk.gray(`(${Math.round((result.successCount / total) * 100)}%)`) : ''
    }`
  );
  lines.push(
    `  Failed:           ${result.failureCount > 0 ? chalk.red(result.failureCount) : chalk.gray('0')} ${
      result.failureCount > 0 ? chalk.gray(`(${Math.round((result.failureCount / total) * 100)}%)`) : ''
    }`
  );
  lines.push(
    `  Skipped:          ${chalk.gray(result.skippedCount)} ${
      result.skippedCount > 0 ? chalk.gray(`(${Math.round((result.skippedCount / total) * 100)}%)`) : ''
    }`
  );

  if (stats) {
    lines.push('');

    // Change counts
    const changeLabel = dryRun ? 'Changes (would apply)' : 'Changes applied';
    lines.push(`  ${changeLabel}: ${chalk.cyan(stats.totalChangesApplied)}`);
    lines.push(`  Safe changes:     ${chalk.green(stats.totalSafeChanges)}`);
    if (stats.totalBreakingChanges > 0) {
      lines.push(`  Breaking changes: ${chalk.yellow(stats.totalBreakingChanges)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format single agent result
 */
function formatAgentResult<T>(result: BatchAgentResult<T>, includeTiming: boolean): string {
  const lines: string[] = [];
  const icon = getStatusIcon(result);
  const label = getStatusLabel(result);
  const name = result.agentName ?? result.agentId;

  // Main line
  let mainLine = `  ${icon} ${label.padEnd(6)} ${name}`;
  if (includeTiming && result.durationMs) {
    mainLine += chalk.gray(` (${formatDuration(result.durationMs)})`);
  }
  lines.push(mainLine);

  // Additional details for extended results
  const extendedResult = result as UpgradeAgentResult<T>;
  if (extendedResult.skipReason) {
    lines.push(chalk.gray(`           ${extendedResult.skipReason}`));
  }

  if (result.error) {
    lines.push(chalk.red(`           Error: ${result.error}`));
  }

  if (extendedResult.applyResult && result.status === 'applied') {
    const { summary } = extendedResult.applyResult;
    if (summary.applied > 0 || summary.skipped > 0 || summary.failed > 0) {
      lines.push(
        chalk.gray(
          `           Applied: ${summary.applied}, Skipped: ${summary.skipped}, Failed: ${summary.failed}`
        )
      );
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Compact Report
// =============================================================================

/**
 * Generate compact one-line summary report
 */
export function formatCompactReport<T>(result: BatchOperationResult<T>): string {
  const status = result.success ? chalk.green('SUCCESS') : chalk.red('FAILED');
  const dryRun = 'dryRun' in result && (result as BatchUpgradeResult<T>).dryRun;
  const dryRunLabel = dryRun ? chalk.yellow('[DRY RUN] ') : '';
  const stats = 'stats' in result ? (result as BatchUpgradeResult<T>).stats : null;

  const duration = stats ? ` (${formatDuration(stats.totalDurationMs)})` : '';

  return `${dryRunLabel}${status}: ${result.successCount}/${result.totalAgents} agents upgraded, ${result.failureCount} failed, ${result.skippedCount} skipped${duration}`;
}

// =============================================================================
// JSON Report
// =============================================================================

/**
 * Generate JSON report for automation
 */
export function formatJsonReport<T>(result: BatchOperationResult<T> | BatchUpgradeResult<T>): string {
  // Create a clean JSON structure
  const hasExtendedStats = 'stats' in result;

  const jsonReport: Record<string, unknown> = {
    success: result.success,
    message: result.message,
    totalAgents: result.totalAgents,
    successCount: result.successCount,
    failureCount: result.failureCount,
    skippedCount: result.skippedCount,
    results: result.results.map((r) => {
      const extendedResult = r as UpgradeAgentResult<T>;
      return {
        agentId: r.agentId,
        agentName: r.agentName,
        success: r.success,
        status: r.status,
        error: r.error,
        durationMs: r.durationMs,
        skipReason: extendedResult.skipReason,
        changes: extendedResult.applyResult?.summary,
      };
    }),
    warnings: result.warnings,
    errors: result.errors,
  };

  if (hasExtendedStats) {
    const extResult = result as BatchUpgradeResult<T>;
    jsonReport.batchId = extResult.batchId;
    jsonReport.startedAt = extResult.startedAt;
    jsonReport.completedAt = extResult.completedAt;
    jsonReport.dryRun = extResult.dryRun;
    jsonReport.stats = extResult.stats;
  }

  return JSON.stringify(jsonReport, null, 2);
}

// =============================================================================
// Main Report Generator
// =============================================================================

/**
 * Generate formatted report based on options
 *
 * @param result - Batch upgrade result
 * @param options - Report formatting options
 * @returns Formatted report with output, summary, and exit code
 */
export function generateReport<T>(
  result: BatchOperationResult<T> | BatchUpgradeResult<T>,
  options: ReportOptions
): FormattedReport {
  let output: string;
  let summary: string;

  switch (options.format) {
    case 'json':
      output = formatJsonReport(result);
      summary = formatCompactReport(result);
      break;

    case 'compact':
      output = formatCompactReport(result);
      summary = output;
      break;

    case 'human':
    default:
      output = formatHumanReport(result, options);
      summary = formatCompactReport(result);
      break;
  }

  // Determine exit code
  // 0 = success
  // 1 = some failures
  // 2 = all failed
  let suggestedExitCode = 0;
  if (!result.success) {
    if (result.successCount === 0 && result.failureCount > 0) {
      suggestedExitCode = 2;
    } else {
      suggestedExitCode = 1;
    }
  }

  return {
    output,
    summary,
    suggestedExitCode,
  };
}

// =============================================================================
// Progress Reporting
// =============================================================================

/**
 * Create a progress reporter for batch operations
 */
export interface ProgressReporter {
  /** Update progress */
  update(current: number, total: number, agentName?: string): void;
  /** Report agent completion */
  complete<T>(result: BatchAgentResult<T>): void;
  /** Finalize progress display */
  finish(): void;
}

/**
 * Create a console progress reporter
 */
export function createConsoleProgressReporter(verbose: boolean = false): ProgressReporter {
  let lastLine = '';

  return {
    update(current: number, total: number, agentName?: string): void {
      const percent = Math.round((current / total) * 100);
      const bar = createProgressBar(percent, 20);
      const name = agentName ? ` - ${agentName}` : '';
      lastLine = `\r${chalk.cyan('Upgrading')} ${bar} ${current}/${total}${name}`;
      process.stderr.write(lastLine);
    },

    complete<T>(result: BatchAgentResult<T>): void {
      if (verbose) {
        const icon = getStatusIcon(result);
        const name = result.agentName ?? result.agentId;
        // Clear the progress line and show result
        process.stderr.write('\r' + ' '.repeat(lastLine.length) + '\r');
        console.log(`${icon} ${name}`);
      }
    },

    finish(): void {
      // Clear the progress line
      process.stderr.write('\r' + ' '.repeat(lastLine.length) + '\r');
    },
  };
}

/**
 * Create a simple text progress bar
 */
function createProgressBar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return `[${chalk.green('='.repeat(filled))}${chalk.gray('-'.repeat(empty))}]`;
}

// =============================================================================
// Summary Helpers
// =============================================================================

/**
 * Get a one-line summary suitable for commit messages or notifications
 */
export function getOneLinerSummary<T>(result: BatchOperationResult<T>): string {
  const dryRun = 'dryRun' in result && (result as BatchUpgradeResult<T>).dryRun;
  const prefix = dryRun ? '[dry-run] ' : '';
  const stats = 'stats' in result ? (result as BatchUpgradeResult<T>).stats : null;

  if (result.success) {
    if (result.successCount === 0 && stats?.upToDate === result.totalAgents) {
      return `${prefix}All ${result.totalAgents} agents already up to date`;
    }
    return `${prefix}Upgraded ${result.successCount} ${pluralize(result.successCount, 'agent')} successfully`;
  } else {
    return `${prefix}Upgrade failed: ${result.successCount} succeeded, ${result.failureCount} failed`;
  }
}

/**
 * Get list of failed agent IDs
 */
export function getFailedAgentIds<T>(result: BatchOperationResult<T>): string[] {
  return result.results
    .filter((r) => r.status === 'failed')
    .map((r) => r.agentId);
}

/**
 * Get list of agents that were skipped
 */
export function getSkippedAgentIds<T>(result: BatchOperationResult<T>): string[] {
  return result.results
    .filter((r) => r.status === 'skipped')
    .map((r) => r.agentId);
}
