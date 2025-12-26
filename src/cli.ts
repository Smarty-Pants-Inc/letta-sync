#!/usr/bin/env node
/**
 * letta-sync CLI - Manage Letta agent configurations
 * 
 * This tool provides commands for managing agent configurations:
 * - diff: Show what would change between local and remote
 * - sync: Apply local changes to remote Letta agent
 * - status: Show current agent configuration state
 * - bootstrap: Initialize a new agent configuration
 * - upgrade: Upgrade an existing agent configuration
 */

import { Command, Option } from 'commander';
import type { GlobalOptions, CommandContext, OutputFormat, Channel } from './types.js';
import { 
  diffCommand, 
  syncCommand, 
  statusCommand, 
  bootstrapCommand, 
  upgradeCommand, 
  cleanupDuplicatesCommand,
  cleanupPrefixCommand,
  scopeSyncCommand,
  projectsListCommand,
  projectsCreateCommand
} from './commands/index.js';
import { printResult, error, verbose as verboseLog } from './utils/output.js';
import { resolveProject, formatProject } from './config/index.js';

const VERSION = '0.1.0';

/**
 * Create the command context from parsed options
 * Resolves project targeting from CLI, env, or config
 */
function createContext(options: GlobalOptions): CommandContext {
  // Resolve project from multiple sources
  const projectResult = resolveProject({
    cliProject: options.project,
    verbose: options.verbose,
  });

  // Many commands still read `options.project` directly. If project resolution
  // succeeded via registry/local config and no explicit --project was provided,
  // persist the resolved project back onto the options object as an id/slug.
  if (!options.project && projectResult.project) {
    options.project = projectResult.project.id ?? projectResult.project.slug;
  }

  // Log project resolution in verbose mode
  if (options.verbose) {
    verboseLog(`Project resolution attempted: ${projectResult.attempted.join(' -> ')}`, true);
    if (projectResult.project) {
      verboseLog(`Resolved project: ${formatProject(projectResult.project)} (via ${projectResult.source})`, true);
    } else {
      verboseLog(`No project resolved: ${projectResult.error}`, true);
    }
  }

  return {
    options,
    outputFormat: options.json ? 'json' : 'human',
    project: projectResult.project ?? undefined,
    projectSource: projectResult.source ?? undefined,
  };
}

/**
 * Main CLI program
 */
const program = new Command()
  .name('letta-sync')
  .description('CLI tool for managing Letta agent configurations')
  .version(VERSION)
  // Global options available to all commands
  // Note: Commander only supports one .env() per option, so we handle aliases in project.ts
  .addOption(
    new Option('--project <slug>', 'Target Letta project')
      .env('LETTA_SYNC_PROJECT')
  )
  .addOption(
    new Option('--org <slug>', 'Target organization')
      .env('LETTA_SYNC_ORG')
  )
  .addOption(
    new Option('--agent <id>', 'Target specific agent ID')
      .env('LETTA_SYNC_AGENT')
  )
  .addOption(
    new Option('--dry-run', 'Show what would happen without making changes')
      .default(false)
  )
  .addOption(
    new Option('--json', 'Output JSON for CI/automation')
      .default(false)
  )
  .addOption(
    new Option('--channel <name>', 'Release channel')
      .choices(['stable', 'beta', 'pinned'])
      .default('stable')
  )
  .addOption(
    new Option('-v, --verbose', 'Enable verbose logging')
      .default(false)
  );

/**
 * projects command - Manage Letta Cloud projects
 */
const projects = program
  .command('projects')
  .description('Manage Letta Cloud projects');

projects
  .command('list')
  .description('List projects available to the current API key')
  .action(async () => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);

    try {
      const result = await projectsListCommand(ctx, {});
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Projects list failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

projects
  .command('create')
  .description('Create a project if it does not already exist')
  .requiredOption('--slug <slug>', 'Project slug (unique)')
  .option('--name <name>', 'Project display name (defaults to slug)')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);

    try {
      const result = await projectsCreateCommand(ctx, { slug: cmdOpts.slug, name: cmdOpts.name });
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Projects create failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * diff command - Show what would change
 */
program
  .command('diff')
  .description('Show differences between local and remote configuration')
  .option('--full', 'Show all fields, not just changed ones')
  .option('--versions', 'Show only package version differences')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);
    
    try {
      const result = await diffCommand(ctx, {
        full: cmdOpts.full,
        versions: cmdOpts.versions,
      });
      
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Diff failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * sync command - Apply changes
 */
program
  .command('sync')
  .description('Apply local configuration changes to remote Letta agent')
  .option('--force', 'Force sync even if there are conflicts')
  .option('--only <sections...>', 'Only sync specific sections')
  .option('--prefix <prefix>', 'Prefix to add to all block labels (for demo/testing)')
  .option('--prune-duplicates', 'Delete duplicate managed blocks (same label+source) created by letta-sync', false)
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);
    
    try {
      const result = await syncCommand(ctx, {
        force: cmdOpts.force,
        only: cmdOpts.only,
        prefix: cmdOpts.prefix,
        pruneDuplicates: cmdOpts.pruneDuplicates,
      });
      
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * status command - Show current state
 */
program
  .command('status')
  .description('Show current agent configuration state')
  .option('--extended', 'Show extended status information')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);
    
    try {
      const result = await statusCommand(ctx, {
        extended: cmdOpts.extended,
      });
      
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * scope-sync command - Attach scope-based memory blocks to the agent
 */
program
  .command('scope-sync')
  .description('Attach scope-based memory blocks based on cwd and .letta/scope_registry.yaml')
  .option('--cwd <path>', 'Working directory to evaluate for scope matching (defaults to current dir)')
  .option('--touched <paths...>', 'Additional file paths to consider when matching scopes')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);

    try {
      const result = await scopeSyncCommand(ctx, {
        cwd: cmdOpts.cwd,
        touched: cmdOpts.touched,
      });

      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }

      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Scope sync failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * bootstrap command - Initialize new agent
 */
program
  .command('bootstrap')
  .description('Initialize a new agent configuration')
  .requiredOption('--name <name>', 'Name for the new agent')
  .option('--template <template>', 'Template to use for initial configuration')
  .option('--minimal', 'Initialize with minimal configuration')
  .option('--identity <handle>', 'Primary user identity (handle or identifier_key)')
  .option('--identities <handles...>', 'Additional identities (handles or identifier_keys)')
  .option('--auto-create-identity', 'Auto-create user identity if not found', true)
  .option('--tag <tags...>', 'Additional tags to apply (repeatable)')
  .option('--exec', 'Launch Letta Code with the new agent after bootstrap')
  .option('--letta-path <path>', 'Custom path to letta executable')
  .option('--letta-args <args...>', 'Additional arguments to pass to letta')
  .option('--skip-upgrade', 'Skip auto-upgrade after bootstrap')
  .option('--yes-upgrade', 'Auto-accept upgrade without prompting')
  .option('--skip-scope-sync', 'Skip scope sync after bootstrap')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);
    
    try {
      const result = await bootstrapCommand(ctx, {
        name: cmdOpts.name,
        template: cmdOpts.template,
        minimal: cmdOpts.minimal,
        identity: cmdOpts.identity,
        identities: cmdOpts.identities,
        autoCreateIdentity: cmdOpts.autoCreateIdentity,
        additionalTags: cmdOpts.tag,
        exec: cmdOpts.exec,
        lettaPath: cmdOpts.lettaPath,
        lettaArgs: cmdOpts.lettaArgs,
        skipUpgrade: cmdOpts.skipUpgrade,
        yesUpgrade: cmdOpts.yesUpgrade,
        skipScopeSync: cmdOpts.skipScopeSync,
      });
      
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });


/**
 * cleanup-duplicates command - report/delete duplicate managed blocks
 */
program
  .command('cleanup-duplicates')
  .description('Report (and optionally delete) duplicate managed blocks for manifest labels')
  .option('--labels <labels...>', 'Only check specific labels (base label or prefixed label)')
  .option('--prefix <prefix>', 'Prefix used when blocks were created (e.g. demo_)')
  .option('--keep <n>', 'How many duplicates to keep per label+source (default: 1)', '1')
  .option('--apply', 'Actually delete duplicates (default: report only)')
  .option('--force-attached', 'Allow deleting blocks that appear attached to agents')
  .option('--agent-limit <n>', 'Max agents to scan for block usage (default: 200)', '200')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);

    try {
      const result = await cleanupDuplicatesCommand(ctx, {
        labels: cmdOpts.labels,
        prefix: cmdOpts.prefix,
        keep: cmdOpts.keep,
        apply: cmdOpts.apply,
        forceAttached: cmdOpts.forceAttached,
        agentLimit: cmdOpts.agentLimit,
      });

      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }

      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Cleanup duplicates failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * cleanup-prefix command - delete demo-prefixed blocks
 */
program
  .command('cleanup-prefix')
  .description('Report (and optionally delete) blocks whose labels start with a prefix (e.g. demo_)')
  .requiredOption('--prefix <prefix>', 'Label prefix to target (e.g. demo_)')
  .option('--apply', 'Actually delete blocks (default: report only)')
  .option('--force-attached', 'Allow deleting blocks that appear attached to agents')
  .option('--agent-limit <n>', 'Max agents to scan for block usage (default: 200)', '200')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);

    try {
      const result = await cleanupPrefixCommand(ctx, {
        prefix: cmdOpts.prefix,
        apply: cmdOpts.apply,
        forceAttached: cmdOpts.forceAttached,
        agentLimit: cmdOpts.agentLimit,
      });

      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }

      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Cleanup prefix failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * upgrade command - Upgrade existing agent
 *
 * Supports safe upgrade policy per role-channel-matrix.md:
 * - Safe changes: auto-applied without confirmation
 * - Breaking changes: require --force flag
 *
 * Batch mode (--all): Upgrades all managed agents in the project
 */
program
  .command('upgrade')
  .description('Upgrade an existing agent configuration')
  .option('--target <version>', 'Target version to upgrade to')
  .option('--yes', 'Skip confirmation prompts')
  .option('--check', 'Show what would be upgraded without applying (dry-run)')
  .option('--apply', 'Actually apply the upgrade (opposite of --check)')
  .option('--force', 'Force breaking changes without confirmation')
  .option('--validate-identities', 'Validate identity configuration during upgrade', true)
  .option('--add-identity <handle>', 'Add identity to agent (handle or identifier_key)')
  .option('--remove-identity <handle>', 'Remove identity from agent (handle or identifier_key)')
  .option('--all', 'Upgrade all managed agents in the project')
  .option('--role <roles...>', 'Filter agents by role (lane-dev, repo-curator, org-curator, supervisor)')
  .option('--filter-channel <channels...>', 'Filter agents by channel (stable, beta, pinned)')
  .option('--concurrency <n>', 'Maximum concurrent upgrades (default: 5)', '5')
  .option('--fail-fast', 'Stop on first failure')
  .action(async (cmdOpts) => {
    const globalOpts = program.opts() as GlobalOptions;
    const ctx = createContext(globalOpts);
    
    try {
      const result = await upgradeCommand(ctx, {
        target: cmdOpts.target,
        yes: cmdOpts.yes,
        check: cmdOpts.check,
        apply: cmdOpts.apply,
        force: cmdOpts.force,
        validateIdentities: cmdOpts.validateIdentities,
        addIdentity: cmdOpts.addIdentity,
        removeIdentity: cmdOpts.removeIdentity,
        all: cmdOpts.all,
        roles: cmdOpts.role,
        filterChannels: cmdOpts.filterChannel,
        concurrency: parseInt(cmdOpts.concurrency, 10),
        failFast: cmdOpts.failFast,
      });
      
      if (ctx.outputFormat === 'json') {
        printResult(result, ctx.outputFormat);
      }
      
      process.exit(result.success ? 0 : 1);
    } catch (err) {
      error(`Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// Parse and execute
program.parse();
