/**
 * bootstrap command - Initialize a new agent configuration
 */

import type { CommandContext, CommandResult, BootstrapConfig } from '../types.js';
import { 
  info, 
  success, 
  warn,
  error as errorOutput,
  verbose, 
  header, 
  dryRunNotice 
} from '../utils/output.js';
import Letta from '@letta-ai/letta-client';
import { resolveLettaApiKey } from '../config/letta-auth.js';
import {
  resolveIdentifierKey,
  isValidIdentifierKey,
  validateIdentityInput,
  type AttachIdentityOptions,
} from '../reconcilers/agents/identity.js';
import {
  tryResolveProject,
  isProjectResolutionError,
  type ResolvedProject,
  execLetta,
  checkLettaAvailability,
  LettaNotFoundError,
  MissingApiKeyError,
  runAutoUpgrade,
  isInteractiveTTY,
  formatAutoUpgradeResult,
  // Agent creation from templates
  type CreateAgentOptions,
  type AgentCreationClient,
  createAgentFromTemplate,
  previewAgentCreation,
  buildAgentTags,
  TAG_PREFIXES,
  // Pinning utilities
  pinAgent,
  getPinnedAgent,
  // Scope sync
  runScopeSyncBestEffort,
  type ScopeSyncResult,
} from '../bootstrap/index.js';

export interface BootstrapOptions {
  /** Agent name */
  name?: string;
  /** Template to use for initial configuration */
  template?: string;
  /** Agent role (e.g., 'assistant', 'moderator') - affects tagging */
  role?: string;
  /** Initialize with minimal configuration */
  minimal?: boolean;
  /** User handle or identifier_key for primary identity */
  identity?: string;
  /** Additional identity handles or identifier_keys */
  identities?: string[];
  /** Auto-create user identities if not found */
  autoCreateIdentity?: boolean;
  /** Execute letta with the agent after bootstrap completes */
  exec?: boolean;
  /** Custom letta executable path (bypasses PATH search) */
  lettaPath?: string;
  /** Extra arguments to pass to letta when exec is enabled */
  lettaArgs?: string[];
  /** Skip auto-upgrade after bootstrap */
  skipUpgrade?: boolean;
  /** Auto-accept upgrade without prompting */
  yesUpgrade?: boolean;
  /** Additional tags to apply to the agent */
  additionalTags?: string[];
  /** Skip scope sync after bootstrap (default: false) */
  skipScopeSync?: boolean;
}

/**
 * Execute the bootstrap command
 * Creates a new agent configuration from scratch or template
 */
export async function bootstrapCommand(
  ctx: CommandContext,
  options: BootstrapOptions = {}
): Promise<CommandResult<BootstrapConfig>> {
  const { options: globalOpts, outputFormat } = ctx;

  verbose(`Executing bootstrap command`, globalOpts.verbose);
  verbose(`Template: ${options.template ?? 'default'}`, globalOpts.verbose);

  // Resolve project from git repo or explicit option
  const projectResult = tryResolveProject({
    explicitProject: globalOpts.project,
    explicitOrg: globalOpts.org,
    verbose: globalOpts.verbose ? (msg) => verbose(msg, true) : undefined,
  });

  if (projectResult.error !== null) {
    if (outputFormat === 'human') {
      errorOutput(projectResult.error);
    }
    return {
      success: false,
      message: 'Failed to resolve project',
      errors: [projectResult.error],
    };
  }

  // TypeScript now knows projectResult.project is not null
  const resolvedProject = projectResult.project;
  verbose(`Project: ${resolvedProject.projectSlug} (via ${resolvedProject.source})`, globalOpts.verbose);
  if (resolvedProject.orgSlug) {
    verbose(`Organization: ${resolvedProject.orgSlug}`, globalOpts.verbose);
  }

  if (outputFormat === 'human') {
    header('Bootstrap New Agent');
    info(`Project: ${resolvedProject.projectSlug}`);
    if (resolvedProject.orgSlug) {
      info(`Organization: ${resolvedProject.orgSlug}`);
    }
    if (resolvedProject.source !== 'explicit') {
      info(`Resolved from: ${resolvedProject.gitInfo.root}`);
    }
    console.log(''); // Empty line for spacing
    
    if (globalOpts.dryRun) {
      dryRunNotice();
    }
  }

  // Validate required options
  if (!options.name) {
    return {
      success: false,
      message: 'Agent name is required',
      errors: ['Please provide an agent name with --name <name>'],
    };
  }

  // Collect identity specifications
  const identitySpecs: string[] = [];
  if (options.identity) {
    identitySpecs.push(options.identity);
  }
  if (options.identities) {
    identitySpecs.push(...options.identities);
  }

  // Validate and resolve identity specifications
  const resolvedIdentities: string[] = [];
  const identityErrors: string[] = [];
  const org = globalOpts.org ?? 'default';

  for (const spec of identitySpecs) {
    const validation = validateIdentityInput(spec, org);

    if (validation.valid) {
      resolvedIdentities.push(validation.identifierKey);
      verbose(`Resolved identity: ${spec} -> ${validation.identifierKey}`, globalOpts.verbose);
      
      // Log warnings if any
      for (const warning of validation.warnings) {
        verbose(`  Warning: ${warning}`, globalOpts.verbose);
      }
    } else {
      identityErrors.push(
        `Invalid identity specification "${spec}": ${validation.errors.join(', ')}`
      );
    }
  }

  if (identityErrors.length > 0) {
    return {
      success: false,
      message: 'Identity validation failed',
      errors: identityErrors,
    };
  }

  // TODO: Implement actual bootstrap logic
  // 1. Check if agent already exists
  // 2. Load template if specified
  // 3. Create local configuration files
  // 4. Optionally create remote agent via Letta API
  // 5. Resolve and attach identities

  const config: BootstrapConfig = {
    agentName: options.name,
    template: options.template,
    systemPrompt: options.minimal 
      ? 'You are a helpful assistant.'
      : undefined,
    tools: options.minimal ? [] : undefined,
    memoryBlocks: {},
    identities: resolvedIdentities.length > 0 ? resolvedIdentities : undefined,
  };

  // Build create agent options for template-based creation
  const createOptions: CreateAgentOptions = {
    name: options.name,
    template: options.template ?? 'default',
    role: options.role,
    channel: globalOpts.channel,
    identities: resolvedIdentities,
    autoCreateIdentity: options.autoCreateIdentity ?? true,
    additionalTags: options.additionalTags,
    project: resolvedProject,
  };

  if (globalOpts.dryRun) {
    // Preview what would be created
    const preview = previewAgentCreation(createOptions);
    
    if (outputFormat === 'human') {
      info(`Would create agent: ${config.agentName}`);
      if (config.template) {
        info(`Using template: ${config.template}`);
      }
      if (config.identities && config.identities.length > 0) {
        info(`Would attach identities:`);
        for (const id of config.identities) {
          info(`  - ${id}`);
        }
        if (options.autoCreateIdentity) {
          info(`  (auto-create enabled for user identities)`);
        }
      }
      
      // Show tags that would be applied
      if (preview.appliedTags.length > 0) {
        info(`Would apply tags:`);
        for (const tag of preview.appliedTags) {
          info(`  - ${tag}`);
        }
      }

      // Show template info
      if (preview.templateUsed) {
        info(`Template: ${preview.templateUsed.name}`);
        verbose(`  Base Template ID: ${preview.templateUsed.baseTemplateId}`, globalOpts.verbose);
        verbose(`  Template ID: ${preview.templateUsed.templateId}`, globalOpts.verbose);
      }
    }
    return {
      success: true,
      message: 'Dry run complete',
      data: {
        ...config,
        tags: preview.appliedTags,
        templateInfo: preview.templateUsed,
      },
    };
  }

  // Create the agent in Letta (real API call)
  const apiKey = resolveLettaApiKey();
  if (!apiKey) {
    throw new Error('LETTA_API_KEY is required (set env var or run `letta setup`)');
  }

  // Use the official Letta SDK so we can create/update agents and identities.
  // It automatically respects LETTA_BASE_URL for self-hosted setups.
  const sdkClient = new Letta({ apiKey, project: resolvedProject.projectSlug });

  const createResult = await createAgentFromTemplate(sdkClient as any, createOptions);

  if (!createResult.success || !createResult.agentId) {
    const msg = createResult.errors.length > 0
      ? createResult.errors.join(', ')
      : 'Unknown error creating agent';

    if (outputFormat === 'human') {
      errorOutput(`Failed to create agent: ${msg}`);
    }

    return {
      success: false,
      message: 'Failed to create agent',
      errors: createResult.errors.length > 0 ? createResult.errors : [msg],
    };
  }

  const createdAgentId = createResult.agentId;
  config.identityIds = createResult.identityResult?.identityIds;
  config.tags = createResult.appliedTags;
  config.templateInfo = createResult.templateUsed;

  // Pin the real agent ID to the repo/worktree
  const pinResult = pinAgent(createdAgentId, { cwd: resolvedProject.gitInfo.root });
  verbose(`Pinned agent: ${pinResult.message}`, globalOpts.verbose);

  if (outputFormat === 'human') {
    success(`Created agent: ${config.agentName}`);

    info(`Applied tags:`);
    for (const tag of createResult.appliedTags) {
      info(`  - ${tag}`);
    }

    if (config.identities && config.identities.length > 0) {
      info(`Attached ${config.identities.length} identity/identities:`);
      for (const id of config.identities) {
        info(`  - ${id}`);
      }
    }

    if (createResult.templateUsed) {
      verbose(`Template: ${createResult.templateUsed.name}`, globalOpts.verbose);
    }
    verbose(`Project: ${resolvedProject.projectSlug}`, globalOpts.verbose);
    if (resolvedProject.orgSlug) {
      verbose(`Organization: ${resolvedProject.orgSlug}`, globalOpts.verbose);
    }
  }

  // Run auto-upgrade after agent is confirmed to exist
  const upgradeResult = await runAutoUpgrade(ctx, createdAgentId, {
    channel: globalOpts.channel,
    skip: options.skipUpgrade,
    dryRun: globalOpts.dryRun,
    verbose: globalOpts.verbose,
    interactive: isInteractiveTTY(),
    yes: options.yesUpgrade,
  });

  // If upgrade failed, log warning but continue
  if (!upgradeResult.success) {
    if (outputFormat === 'human') {
      warn(`Auto-upgrade had issues: ${upgradeResult.message}`);
    }
    // Don't fail the bootstrap, just warn
  }

  // Run scope sync (best-effort - don't fail bootstrap if it fails)
  if (!options.skipScopeSync && !globalOpts.dryRun) {
    verbose(`Running scope sync for agent ${createdAgentId}...`, globalOpts.verbose);

    const scopeSyncResult = await runScopeSyncBestEffort(
      {
        agentId: createdAgentId,
        cwd: resolvedProject.gitInfo.root,
        dryRun: false,
        verbose: globalOpts.verbose ? (msg) => verbose(msg, true) : undefined,
      },
      (result: ScopeSyncResult) => {
        if (outputFormat === 'human') {
          if (result.success) {
            success(`Scope sync: ${result.message}`);
            if (result.matchedScopes && result.matchedScopes.length > 0) {
              info(`  Matched scopes: ${result.matchedScopes.join(', ')}`);
            }
            if (result.focusScope) {
              info(`  Focus scope: ${result.focusScope}`);
            }
            if (result.attachedBlocks && result.attachedBlocks.length > 0) {
              verbose(`  Attached ${result.attachedBlocks.length} block(s)`, globalOpts.verbose);
            }
          } else {
            warn(`Scope sync failed (non-fatal): ${result.error ?? result.message}`);
          }
          if (result.warnings && result.warnings.length > 0) {
            for (const w of result.warnings) {
              warn(`  Warning: ${w}`);
            }
          }
        }
      }
    );

    // Add scope sync result to config for JSON output
    if (scopeSyncResult.success) {
      config.scopeSync = {
        matchedScopes: scopeSyncResult.matchedScopes,
        focusScope: scopeSyncResult.focusScope,
      };
    }
  } else if (options.skipScopeSync) {
    verbose(`Scope sync skipped (--skip-scope-sync)`, globalOpts.verbose);
  } else if (globalOpts.dryRun) {
    if (outputFormat === 'human') {
      info(`[DRY RUN] Would run scope sync after agent creation`);
    }
  }

  // Handle exec option - launch letta with the new agent
  // Handle exec option - launch letta with the new agent
  if (options.exec) {
    verbose(`Exec option enabled, preparing to launch letta...`, globalOpts.verbose);

    // Check if letta is available before attempting exec
    const lettaCheck = checkLettaAvailability();
    if (!lettaCheck.available) {
      if (outputFormat === 'human') {
        warn(`Letta Code not found: ${lettaCheck.error}`);
        info('Install Letta Code with `npm install -g @letta-ai/letta-code`');
        info('Skipping exec step. Run `smarty-admin sync` to push configuration to Letta');
      }
      return {
        success: true,
        message: `Agent ${config.agentName} bootstrapped successfully (letta exec skipped - not installed)`,
        data: config,
      };
    }

    if (outputFormat === 'human') {
      info(`Launching Letta Code with agent: ${createdAgentId}`);
      console.log(''); // Empty line before handoff
    }

    try {
      // Execute letta - this will take over the terminal
      const exitCode = await execLetta({
        agentId: createdAgentId,
        cwd: resolvedProject.gitInfo.root,
        lettaPath: options.lettaPath,
        extraArgs: options.lettaArgs,
        verbose: globalOpts.verbose ? (msg) => verbose(msg, true) : undefined,
      });

      return {
        success: exitCode === 0,
        message: exitCode === 0
          ? `Letta Code exited successfully`
          : `Letta Code exited with code ${exitCode}`,
        data: config,
      };
    } catch (execError) {
      const errorMessage = execError instanceof LettaNotFoundError
        ? execError.toUserMessage()
        : execError instanceof MissingApiKeyError
          ? execError.toUserMessage()
          : execError instanceof Error
            ? execError.message
            : String(execError);

      if (outputFormat === 'human') {
        errorOutput(`Failed to launch Letta Code: ${errorMessage}`);
      }

      return {
        success: false,
        message: 'Failed to launch Letta Code',
        errors: [errorMessage],
        data: config,
      };
    }
  }

  // Standard completion without exec
  if (outputFormat === 'human') {
    info('Run `smarty-admin sync` to push configuration to Letta');
  }

  return {
    success: true,
    message: `Agent ${config.agentName} bootstrapped successfully`,
    data: config,
  };
}
