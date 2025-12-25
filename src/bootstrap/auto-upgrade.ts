/**
 * Auto-upgrade logic for bootstrap flow
 * Runs upgrade-agent after agent existence is confirmed
 */

import { createInterface } from 'node:readline';
import type { CommandContext, CommandResult, UpgradeInfo, Channel } from '../types.js';
import {
  info,
  success,
  warn,
  verbose,
} from '../utils/output.js';
import chalk from 'chalk';

/**
 * Result of auto-upgrade check
 */
export interface AutoUpgradeCheckResult {
  /** Whether upgrade is needed */
  needsUpgrade: boolean;
  /** Current version if available */
  currentVersion?: string;
  /** Target version if upgrade needed */
  targetVersion?: string;
  /** Reason if already up-to-date or skipped */
  reason?: string;
  /** List of changes if upgrade available */
  changes?: string[];
}

/**
 * Result of auto-upgrade operation
 */
export interface AutoUpgradeResult {
  /** Whether upgrade was performed or skipped successfully */
  success: boolean;
  /** Whether upgrade was actually applied (vs skipped) */
  upgraded: boolean;
  /** Informational message */
  message: string;
  /** Details about what was upgraded */
  upgradeInfo?: UpgradeInfo;
  /** Errors if upgrade failed */
  errors?: string[];
}

/**
 * Options for auto-upgrade
 */
export interface AutoUpgradeOptions {
  /** Channel to use for upgrade (default: stable) */
  channel?: Channel;
  /** Skip upgrade entirely */
  skip?: boolean;
  /** Run in dry-run mode (don't apply changes) */
  dryRun?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Allow interactive prompts (TTY check) */
  interactive?: boolean;
  /** Auto-accept upgrade without prompting */
  yes?: boolean;
}

/**
 * Check if running in an interactive TTY environment
 */
export function isInteractiveTTY(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !process.env.CI &&
    !process.env.CONTINUOUS_INTEGRATION
  );
}

/**
 * Prompt user for confirmation
 * Returns true if user confirms, false otherwise
 */
async function promptConfirmation(message: string, defaultValue: boolean = true): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const defaultHint = defaultValue ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    rl.question(`${message} ${defaultHint} `, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      
      if (trimmed === '') {
        resolve(defaultValue);
      } else if (trimmed === 'y' || trimmed === 'yes') {
        resolve(true);
      } else if (trimmed === 'n' || trimmed === 'no') {
        resolve(false);
      } else {
        // Invalid input, use default
        resolve(defaultValue);
      }
    });
  });
}

/**
 * Prompt user for dry-run vs apply choice
 * Returns true if user wants dry-run, false for apply
 */
async function promptDryRunChoice(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.bold('\nUpgrade options:'));
  console.log('  1. ' + chalk.cyan('Dry-run') + ' - Preview changes without applying');
  console.log('  2. ' + chalk.green('Apply') + '   - Apply the upgrade now');
  console.log('  3. ' + chalk.gray('Skip') + '    - Skip upgrade for now');

  return new Promise((resolve) => {
    rl.question('\nChoose option [1/2/3]: ', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      
      if (trimmed === '1' || trimmed === 'd' || trimmed === 'dry-run') {
        resolve(true); // dry-run
      } else if (trimmed === '2' || trimmed === 'a' || trimmed === 'apply') {
        resolve(false); // apply (not dry-run)
      } else {
        // Default to dry-run for safety, or skip
        resolve(true);
      }
    });
  });
}

/**
 * Check if an upgrade is available for the agent
 * This is a placeholder that should be replaced with actual API call
 */
export async function checkForUpgrade(
  agentId: string,
  channel: Channel,
  verboseMode: boolean
): Promise<AutoUpgradeCheckResult> {
  verbose(`Checking for upgrades on channel: ${channel}`, verboseMode);
  verbose(`Agent ID: ${agentId}`, verboseMode);

  // TODO: Replace with actual Letta API call to check version
  // This would:
  // 1. Fetch the agent's current managed_state block
  // 2. Compare applied package versions against registry
  // 3. Determine if upgrade is needed based on channel

  // Placeholder: simulate upgrade check
  // In real implementation, this would compare versions from managed_state
  // against the latest available packages for the channel
  const currentVersion: string = '1.0.0';
  const targetVersion: string = '1.1.0';
  
  // Compare versions - in production this would be real version comparison
  const needsUpgrade = currentVersion !== targetVersion;

  if (!needsUpgrade) {
    return {
      needsUpgrade: false,
      currentVersion,
      reason: 'Already at the latest version for the stable channel',
    };
  }

  return {
    needsUpgrade: true,
    currentVersion,
    targetVersion,
    changes: [
      'Updated system prompt format',
      'Added new memory blocks',
      'Improved tool configurations',
    ],
  };
}

/**
 * Apply upgrade to the agent
 * This is a placeholder that should be replaced with actual upgrade logic
 */
async function applyUpgrade(
  agentId: string,
  channel: Channel,
  dryRun: boolean,
  verboseMode: boolean
): Promise<AutoUpgradeResult> {
  verbose(`Applying upgrade for agent: ${agentId}`, verboseMode);
  verbose(`Channel: ${channel}, Dry-run: ${dryRun}`, verboseMode);

  // TODO: Replace with actual upgrade logic
  // This would:
  // 1. Load packages from registry based on channel
  // 2. Calculate diff between current and target state
  // 3. Apply changes to agent (unless dry-run)
  // 4. Update managed_state block with new versions

  const upgradeInfo: UpgradeInfo = {
    currentVersion: '1.0.0',
    targetVersion: '1.1.0',
    changes: [
      'Updated system prompt format',
      'Added new memory blocks',
    ],
    breakingChanges: [],
    migrationSteps: [
      'Backup current configuration',
      'Apply schema migration',
      'Validate new configuration',
    ],
  };

  if (dryRun) {
    return {
      success: true,
      upgraded: false,
      message: 'Dry-run complete - no changes applied',
      upgradeInfo,
    };
  }

  // Simulate successful upgrade
  return {
    success: true,
    upgraded: true,
    message: `Upgraded from ${upgradeInfo.currentVersion} to ${upgradeInfo.targetVersion}`,
    upgradeInfo,
  };
}

/**
 * Run auto-upgrade during bootstrap
 * 
 * Flow:
 * 1. Check if upgrade is available (skip if --skip-upgrade)
 * 2. If interactive TTY and not --yes, prompt for dry-run choice
 * 3. Show upgrade info
 * 4. Apply or dry-run based on user choice
 * 
 * @param ctx - Command context
 * @param agentId - ID of the agent to upgrade
 * @param options - Auto-upgrade options
 */
export async function runAutoUpgrade(
  ctx: CommandContext,
  agentId: string,
  options: AutoUpgradeOptions = {}
): Promise<AutoUpgradeResult> {
  const {
    channel = 'stable',
    skip = false,
    dryRun: forceDryRun = false,
    verbose: verboseMode = false,
    interactive = isInteractiveTTY(),
    yes = false,
  } = options;

  const { outputFormat } = ctx;

  // Skip if requested
  if (skip) {
    verbose('Auto-upgrade skipped via --skip-upgrade flag', verboseMode);
    return {
      success: true,
      upgraded: false,
      message: 'Auto-upgrade skipped',
    };
  }

  // Check for available upgrades
  if (outputFormat === 'human') {
    info('Checking for agent upgrades...');
  }

  const checkResult = await checkForUpgrade(agentId, channel, verboseMode);

  // Already up-to-date
  if (!checkResult.needsUpgrade) {
    if (outputFormat === 'human') {
      success(`Agent is up-to-date (${checkResult.currentVersion})`);
      if (checkResult.reason) {
        info(checkResult.reason);
      }
    }
    return {
      success: true,
      upgraded: false,
      message: checkResult.reason ?? 'Already up-to-date',
    };
  }

  // Show upgrade info
  if (outputFormat === 'human') {
    console.log(chalk.bold('\nUpgrade available:'));
    console.log(`  Current: ${chalk.yellow(checkResult.currentVersion)}`);
    console.log(`  Target:  ${chalk.green(checkResult.targetVersion)}`);
    console.log(`  Channel: ${chalk.cyan(channel)}`);

    if (checkResult.changes && checkResult.changes.length > 0) {
      console.log(chalk.bold('\nChanges:'));
      checkResult.changes.forEach((change) => {
        console.log(chalk.cyan('  •'), change);
      });
    }
  }

  // Determine if we should apply or dry-run
  let shouldDryRun = forceDryRun || ctx.options.dryRun;

  // Interactive mode: prompt user for choice
  if (interactive && !yes && !forceDryRun && !ctx.options.dryRun) {
    const wantsDryRun = await promptDryRunChoice();
    shouldDryRun = wantsDryRun;
    
    // User might have chosen to skip
    if (!shouldDryRun && !wantsDryRun) {
      // Check if user actually selected option 3 (skip)
      // This is simplified - actual implementation would need better handling
    }
  }

  // Apply the upgrade
  if (outputFormat === 'human') {
    if (shouldDryRun) {
      warn('Running in dry-run mode - no changes will be applied');
    } else {
      info('Applying upgrade...');
    }
  }

  const result = await applyUpgrade(agentId, channel, shouldDryRun, verboseMode);

  // Report result
  if (outputFormat === 'human') {
    if (result.success) {
      if (result.upgraded) {
        success(result.message);
      } else {
        info(result.message);
      }
    } else {
      warn(`Upgrade issue: ${result.message}`);
      if (result.errors) {
        result.errors.forEach((err) => {
          console.log(chalk.red('  •'), err);
        });
      }
    }
  }

  return result;
}

/**
 * Display auto-upgrade summary for JSON output
 */
export function formatAutoUpgradeResult(result: AutoUpgradeResult): Record<string, unknown> {
  return {
    autoUpgrade: {
      success: result.success,
      upgraded: result.upgraded,
      message: result.message,
      upgradeInfo: result.upgradeInfo,
      errors: result.errors,
    },
  };
}
