/**
 * diff command - Show what would change between local and remote configuration
 */

import type { CommandContext, CommandResult, ConfigDiff, VersionDiff } from '../types.js';
import { printDiff, printVersionDiff, info, verbose, header } from '../utils/output.js';
import { parseAgentTags, diffAppliedVersions } from '../reconcilers/agents/tracking.js';
import type { PackageLayer } from '../reconcilers/agents/state.js';
import { createClient } from '../api/client.js';
import { getPinnedAgent } from '../bootstrap/pinning.js';
import { execFileSync } from 'node:child_process';

export interface DiffOptions {
  /** Show all fields, not just changed ones */
  full?: boolean;
  /** Show version differences only */
  versions?: boolean;
}

/**
 * Result of diff command including version differences
 */
export interface DiffResult {
  configDiffs: ConfigDiff[];
  versionDiffs: VersionDiff[];
}

/**
 * Execute the diff command
 * Compares local agent configuration with remote Letta state
 */
export async function diffCommand(
  ctx: CommandContext,
  options: DiffOptions = {}
): Promise<CommandResult<DiffResult>> {
  const { options: globalOpts, outputFormat } = ctx;

  verbose(`Executing diff command`, globalOpts.verbose);
  verbose(`Project: ${globalOpts.project ?? '(default)'}`, globalOpts.verbose);
  verbose(`Agent: ${globalOpts.agent ?? '(all)'}`, globalOpts.verbose);
  verbose(`Channel: ${globalOpts.channel}`, globalOpts.verbose);

  if (outputFormat === 'human') {
    header('Configuration Diff');
    info(`Comparing local configuration with remote state...`);
  }

  const agentId = globalOpts.agent ?? getPinnedAgent({ cwd: process.cwd() });
  if (!agentId) {
    return {
      success: false,
      message: 'No agent specified. Use --agent <id> or ensure .letta/settings.local.json has lastAgent',
    };
  }

  const client = createClient({
    project: globalOpts.project,
    debug: globalOpts.verbose,
  });

  const agent = await client.agents.retrieve(agentId);
  const currentTags = (agent as any).tags ?? [];
  // Parse tags just to validate and keep future extension points.
  parseAgentTags(currentTags);

  // For now, desired versions are the current git SHA for all layers.
  // (In the future, this can be sourced from package registry/version files.)
  let sha = 'unknown';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // ignore
  }

  const desiredVersions: Partial<Record<PackageLayer, string>> = {
    base: sha,
    org: sha,
    project: sha,
  };

  // Compute version differences
  const versionDiffResults = diffAppliedVersions(currentTags, desiredVersions);
  const versionDiffs: VersionDiff[] = versionDiffResults.map((d) => ({
    layer: d.layer,
    currentSha: d.current,
    desiredSha: d.desired,
    type: d.current ? 'upgrade' : 'initial',
  }));

  // Placeholder: Return mock config diff for now
  const configDiffs: ConfigDiff[] = [
    // Example diffs for demonstration
    // {
    //   path: 'system_prompt',
    //   type: 'modified',
    //   localValue: 'You are a helpful assistant...',
    //   remoteValue: 'You are an AI assistant...',
    // },
  ];

  const result: DiffResult = {
    configDiffs,
    versionDiffs,
  };

  if (outputFormat === 'human') {
    // Print version differences first if any
    if (versionDiffs.length > 0) {
      printVersionDiff(versionDiffs, outputFormat);
    } else if (options.versions) {
      info('No changes detected');
    }

    // Print config differences
    if (!options.versions) {
      printDiff(configDiffs, outputFormat);
    }
  }

  const totalDiffs = configDiffs.length + versionDiffs.length;

  return {
    success: true,
    message: totalDiffs === 0 
      ? 'No differences found' 
      : `Found ${totalDiffs} difference(s) (${versionDiffs.length} version, ${configDiffs.length} config)`,
    data: result,
  };
}
