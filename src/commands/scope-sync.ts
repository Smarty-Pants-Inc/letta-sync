/**
 * scope-sync command - attach scope-based memory blocks to a pinned agent
 *
 * This is a thin CLI wrapper around bootstrap/scope-sync.ts so the demo can be
 * run without needing an interactive Letta Code session.
 */

import type { CommandContext, CommandResult } from '../types.js';
import { header, info, success, warn, dryRunNotice, verbose } from '../utils/output.js';
import { getPinnedAgent } from '../bootstrap/pinning.js';
import { runScopeSyncBestEffort } from '../bootstrap/scope-sync.js';

export interface ScopeSyncCommandOptions {
  cwd?: string;
  touched?: string[];
}

export async function scopeSyncCommand(
  ctx: CommandContext,
  options: ScopeSyncCommandOptions = {}
): Promise<CommandResult<{ matchedScopes: string[]; focusScope: string | null }>> {
  const { options: globalOpts, outputFormat } = ctx;

  const agentId = globalOpts.agent ?? getPinnedAgent({ cwd: process.cwd() });
  if (!agentId) {
    return {
      success: false,
      message: 'No agent specified. Use --agent <id> or ensure .letta/settings.local.json has lastAgent',
    };
  }

  if (outputFormat === 'human') {
    header('Scope Sync');
    if (globalOpts.dryRun) {
      dryRunNotice();
    }
    info(`Agent: ${agentId}`);
    info(`CWD: ${options.cwd ?? process.cwd()}`);
  }

  const result = await runScopeSyncBestEffort(
    {
      agentId,
      cwd: options.cwd,
      touchedPaths: options.touched ?? [],
      dryRun: globalOpts.dryRun,
      verbose: globalOpts.verbose ? (msg: string) => verbose(msg, globalOpts.verbose) : undefined,
    },
    undefined
  );

  if (outputFormat === 'human') {
    if (result.success) {
      success(result.message);
      info(`Matched scopes: ${(result.matchedScopes ?? []).join(', ') || '(none)'}`);
      info(`Focus scope: ${result.focusScope ?? '(none)'}`);
      if (result.warnings && result.warnings.length > 0) {
        for (const w of result.warnings) warn(w);
      }
    } else {
      warn(result.message);
      if (result.error) warn(result.error);
    }
  }

  return {
    success: result.success,
    message: result.message,
    data: {
      matchedScopes: result.matchedScopes ?? [],
      focusScope: result.focusScope ?? null,
    },
    errors: result.error ? [result.error] : undefined,
  };
}
