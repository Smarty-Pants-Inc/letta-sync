/**
 * status command - Show current agent configuration state
 * 
 * Now with REAL Letta API integration!
 */

import type { CommandContext, CommandResult, AgentStatus, AppliedStateSummary } from '../types.js';
import { info, verbose, header, printStatus, printAppliedState, warn, error as printError } from '../utils/output.js';
import { parseAgentTags, isManagedAgent } from '../reconcilers/agents/tracking.js';
import { createClient } from '../api/client.js';
import * as fs from 'fs';
import * as path from 'path';

export interface StatusOptions {
  /** Show extended status information */
  extended?: boolean;
}

/**
 * Load agent ID from local settings file
 */
function loadLocalAgentId(cwd: string = process.cwd()): string | undefined {
  // Walk up to find .letta/settings.local.json (tools often run from subdirs).
  let current = cwd;
  const root = path.parse(current).root;

  while (true) {
    const localSettingsPath = path.join(current, '.letta', 'settings.local.json');
    try {
      if (fs.existsSync(localSettingsPath)) {
        const content = fs.readFileSync(localSettingsPath, 'utf-8');
        const settings = JSON.parse(content);
        if (settings.lastAgent) {
          return settings.lastAgent;
        }
      }
    } catch {
      // Ignore errors
    }

    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Execute the status command
 * Displays current state of agent configuration
 */
export async function statusCommand(
  ctx: CommandContext,
  options: StatusOptions = {}
): Promise<CommandResult<AgentStatus>> {
  const { options: globalOpts, outputFormat } = ctx;

  verbose(`Executing status command`, globalOpts.verbose);
  verbose(`Project: ${globalOpts.project ?? '(default)'}`, globalOpts.verbose);
  verbose(`Agent: ${globalOpts.agent ?? '(auto-detect)'}`, globalOpts.verbose);

  if (outputFormat === 'human') {
    header('Agent Status');
    info('Fetching agent status from Letta API...');
  }

  // Resolve agent ID
  let agentId = globalOpts.agent;
  if (!agentId) {
    agentId = loadLocalAgentId();
    if (agentId) {
      verbose(`Auto-detected agent from .letta/settings.local.json: ${agentId}`, globalOpts.verbose);
    }
  }

  if (!agentId) {
    const errorMsg = 'No agent specified. Use --agent <id> or ensure .letta/settings.local.json has lastAgent';
    if (outputFormat === 'human') {
      printError(errorMsg);
    }
    return {
      success: false,
      message: errorMsg,
    };
  }

  try {
    // Create real API client
    const client = createClient({
      project: globalOpts.project,
      debug: globalOpts.verbose,
    });

    verbose(`Connecting to Letta API...`, globalOpts.verbose);
    verbose(`Config: ${JSON.stringify(client.getConfig())}`, globalOpts.verbose);

    // Fetch real agent data
    verbose(`Fetching agent: ${agentId}`, globalOpts.verbose);
    const agent = await client.agents.retrieve(agentId);

    verbose(`Agent retrieved: ${agent.name}`, globalOpts.verbose);

    // Fetch blocks attached to this agent
    // Prefer the agent subresource endpoint (more reliable than block_ids).
    verbose(`Fetching blocks...`, globalOpts.verbose);
    let agentBlocks: any[] = [];
    try {
      agentBlocks = await (client.agents as any).listBlocks(agentId);
    } catch {
      // Fallback: if server doesn't support listBlocks, try block_ids filtering.
      const allBlocks = await client.blocks.list({ limit: 200 });
      agentBlocks = allBlocks.filter((block) => (agent as any).block_ids?.includes(block.id));
    }

    verbose(`Found ${agentBlocks.length} blocks attached to agent`, globalOpts.verbose);

    // Parse agent tags if available
    const agentTags = (agent as any).tags || [];
    const parsedTags = parseAgentTags(agentTags);
    const isManaged = isManagedAgent(agentTags);

    // Build applied state from tags
    const appliedState: AppliedStateSummary = {
      isManaged,
      appliedVersions: Object.entries(parsedTags.appliedVersions)
        .filter(([_, sha]) => sha)
        .map(([layer, sha]) => ({
          layer,
          sha: sha ?? '',
          appliedAt: agent.updatedAt || new Date().toISOString(),
          packagePath: `packages/${layer}/`,
        })),
      lastUpgradeAt: agent.updatedAt,
      lastUpgradeType: parsedTags.channel === 'pinned' ? 'pinned' : 'safe_auto',
      reconcilerVersion: '1.0.0',
      hasManagedStateBlock: agentBlocks.some(b => b.label === 'managed_state'),
    };

    // Build status response
    const status: AgentStatus = {
      agentId: agent.id,
      agentName: agent.name,
      project: globalOpts.project ?? 'default',
      org: globalOpts.org ?? parsedTags.org ?? 'default',
      channel: globalOpts.channel,
      lastSync: agent.updatedAt,
      hasLocalChanges: false,
      configVersion: '1.0.0',
      appliedState,
    };

    if (outputFormat === 'human') {
      console.log(''); // Blank line
      printStatus(
        {
          'Agent ID': status.agentId,
          'Agent Name': status.agentName,
          'Project': status.project,
          'Organization': status.org,
          'Channel': status.channel,
          'Last Updated': status.lastSync ?? 'Never',
          'Managed': status.appliedState?.isManaged ? 'Yes' : 'No',
          'Attached Blocks': agentBlocks.length.toString(),
        },
        outputFormat
      );

      // Print applied state if available and extended mode
      if (status.appliedState && options.extended) {
        printAppliedState(status.appliedState, outputFormat);
        
        // Also show attached blocks in extended mode
        if (agentBlocks.length > 0) {
          console.log('\nAttached Blocks:\n');
          for (const block of agentBlocks) {
            const charCount = block.value?.length || 0;
            console.log(`  • ${block.label || '(no label)'}`);
            console.log(`      ID: ${block.id}`);
            console.log(`      Description: ${block.description || '(none)'}`);
            console.log(`      Size: ${charCount} chars`);
          }
        }
      } else if (status.appliedState) {
        // Print compact version summary
        const versions = status.appliedState.appliedVersions
          .map((v) => `${v.layer}@${v.sha}`)
          .join(', ');
        if (versions) {
          info(`Applied versions: ${versions}`);
        } else {
          info(`No applied version tags found (agent may not be managed by smarty-admin)`);
        }
        
        // Show block summary
        if (agentBlocks.length > 0) {
          const blockLabels = agentBlocks
            .map(b => b.label || '(unlabeled)')
            .slice(0, 5)
            .join(', ');
          const more = agentBlocks.length > 5 ? ` (+${agentBlocks.length - 5} more)` : '';
          info(`Blocks: ${blockLabels}${more}`);
        }
      }
    }

    return {
      success: true,
      message: 'Status retrieved successfully',
      data: status,
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (outputFormat === 'human') {
      printError(`Failed to fetch agent status: ${errorMsg}`);
    }
    return {
      success: false,
      message: `Failed to fetch agent status: ${errorMsg}`,
    };
  }
}
