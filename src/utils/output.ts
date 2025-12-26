/**
 * Output formatting utilities for consistent CLI output
 */

import chalk from 'chalk';
import type { CommandResult, OutputFormat, ConfigDiff, AppliedStateSummary, VersionDiff } from '../types.js';

/**
 * Format and print command result based on output format
 */
export function printResult<T>(
  result: CommandResult<T>,
  format: OutputFormat
): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable format
  if (result.success) {
    console.log(chalk.green('✓'), result.message);
  } else {
    console.log(chalk.red('✗'), result.message);
  }

  if (result.errors && result.errors.length > 0) {
    console.log(chalk.red('\nErrors:'));
    result.errors.forEach((err) => {
      console.log(chalk.red('  •'), err);
    });
  }
}

/**
 * Print a diff in a human-readable format
 */
export function printDiff(diffs: ConfigDiff[], format: OutputFormat): void {
  if (format === 'json') {
    console.log(JSON.stringify(diffs, null, 2));
    return;
  }

  if (diffs.length === 0) {
    console.log(chalk.gray('No changes detected'));
    return;
  }

  console.log(chalk.bold(`\n${diffs.length} change(s) detected:\n`));

  for (const diff of diffs) {
    const icon = getDiffIcon(diff.type);
    const color = getDiffColor(diff.type);
    console.log(color(`${icon} ${diff.path}`));
    
    if (diff.type === 'modified') {
      console.log(chalk.red(`  - ${formatValue(diff.remoteValue)}`));
      console.log(chalk.green(`  + ${formatValue(diff.localValue)}`));
    } else if (diff.type === 'added') {
      console.log(chalk.green(`  + ${formatValue(diff.localValue)}`));
    } else if (diff.type === 'removed') {
      console.log(chalk.red(`  - ${formatValue(diff.remoteValue)}`));
    }
  }
}

/**
 * Print a status table
 */
export function printStatus(
  status: Record<string, unknown>,
  format: OutputFormat
): void {
  if (format === 'json') {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(chalk.bold('\nAgent Status:\n'));
  for (const [key, value] of Object.entries(status)) {
    const label = formatLabel(key);
    console.log(`  ${chalk.gray(label + ':')} ${formatValue(value)}`);
  }
}

/**
 * Print informational message
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

/**
 * Print warning message
 */
export function warn(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

/**
 * Print error message
 */
export function error(message: string): void {
  console.log(chalk.red('✗'), message);
}

/**
 * Print success message
 */
export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

/**
 * Print verbose/debug message (only if verbose mode is enabled)
 */
export function verbose(message: string, isVerbose: boolean): void {
  if (isVerbose) {
    // Keep JSON output clean: verbose/debug output should never go to stdout.
    console.error(chalk.gray('[verbose]'), message);
  }
}

/**
 * Print a section header
 */
export function header(title: string): void {
  console.log(chalk.bold.underline(`\n${title}\n`));
}

/**
 * Print dry-run notice
 */
export function dryRunNotice(): void {
  console.log(chalk.yellow.bold('\n[DRY RUN] No changes will be applied\n'));
}

// Helper functions

function getDiffIcon(type: ConfigDiff['type']): string {
  switch (type) {
    case 'added':
      return '+';
    case 'removed':
      return '-';
    case 'modified':
      return '~';
  }
}

function getDiffColor(type: ConfigDiff['type']): typeof chalk.green {
  switch (type) {
    case 'added':
      return chalk.green;
    case 'removed':
      return chalk.red;
    case 'modified':
      return chalk.yellow;
  }
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return chalk.gray('(none)');
  }
  if (typeof value === 'string') {
    return value.length > 50 ? value.slice(0, 50) + '...' : value;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatLabel(key: string): string {
  // Convert camelCase to Title Case with spaces
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

/**
 * Print applied state information
 */
export function printAppliedState(
  state: AppliedStateSummary,
  format: OutputFormat
): void {
  if (format === 'json') {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  console.log(chalk.bold('\nApplied Package Versions:\n'));

  if (state.appliedVersions.length === 0) {
    console.log(chalk.gray('  No packages applied yet'));
    return;
  }

  // Print each applied version
  for (const version of state.appliedVersions) {
    const layerIcon = getLayerIcon(version.layer);
    const layerColor = getLayerColor(version.layer);

    console.log(
      layerColor(`  ${layerIcon} ${version.layer}`),
      chalk.cyan(`@${version.sha}`)
    );

    if (version.appliedAt) {
      console.log(chalk.gray(`      Applied: ${formatTimestamp(version.appliedAt)}`));
    }
    if (version.packagePath) {
      console.log(chalk.gray(`      Path: ${version.packagePath}`));
    }
  }

  // Print metadata
  console.log(chalk.bold('\nReconciler State:\n'));
  console.log(`  ${chalk.gray('Reconciler Version:')} ${state.reconcilerVersion ?? 'unknown'}`);
  console.log(`  ${chalk.gray('Last Upgrade Type:')} ${state.lastUpgradeType ?? 'unknown'}`);
  if (state.lastUpgradeAt) {
    console.log(`  ${chalk.gray('Last Upgrade:')} ${formatTimestamp(state.lastUpgradeAt)}`);
  }
  console.log(`  ${chalk.gray('Managed State Block:')} ${state.hasManagedStateBlock ? chalk.green('✓') : chalk.yellow('missing')}`);
}

/**
 * Print version differences
 */
export function printVersionDiff(
  diffs: VersionDiff[],
  format: OutputFormat
): void {
  if (format === 'json') {
    console.log(JSON.stringify(diffs, null, 2));
    return;
  }

  if (diffs.length === 0) {
    console.log(chalk.gray('\nNo version differences'));
    return;
  }

  console.log(chalk.bold(`\n${diffs.length} Version Change(s):\n`));

  for (const diff of diffs) {
    const layerIcon = getLayerIcon(diff.layer);
    const layerColor = getLayerColor(diff.layer);
    const typeIcon = getVersionDiffIcon(diff.type);
    const typeColor = getVersionDiffColor(diff.type);

    // Print layer and change type
    console.log(
      layerColor(`  ${layerIcon} ${diff.layer}`),
      typeColor(typeIcon)
    );

    // Print version change
    if (diff.currentSha) {
      console.log(chalk.red(`      - ${diff.currentSha}`));
    } else {
      console.log(chalk.gray(`      - (none)`));
    }
    console.log(chalk.green(`      + ${diff.desiredSha}`));
  }
}

/**
 * Get icon for a package layer
 */
function getLayerIcon(layer: string): string {
  switch (layer) {
    case 'base':
      return '◆';
    case 'org':
      return '◇';
    case 'project':
      return '○';
    default:
      return '•';
  }
}

/**
 * Get color function for a package layer
 */
function getLayerColor(layer: string): typeof chalk.blue {
  switch (layer) {
    case 'base':
      return chalk.blue;
    case 'org':
      return chalk.magenta;
    case 'project':
      return chalk.cyan;
    default:
      return chalk.white;
  }
}

/**
 * Get icon for version diff type
 */
function getVersionDiffIcon(type: VersionDiff['type']): string {
  switch (type) {
    case 'upgrade':
      return '↑';
    case 'downgrade':
      return '↓';
    case 'initial':
      return '+';
    default:
      return '~';
  }
}

/**
 * Get color for version diff type
 */
function getVersionDiffColor(type: VersionDiff['type']): typeof chalk.green {
  switch (type) {
    case 'upgrade':
      return chalk.green;
    case 'downgrade':
      return chalk.yellow;
    case 'initial':
      return chalk.cyan;
    default:
      return chalk.white;
  }
}

/**
 * Format ISO timestamp for display
 */
function formatTimestamp(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleString();
  } catch {
    return isoTimestamp;
  }
}
