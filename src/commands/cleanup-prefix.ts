/**
 * cleanup-prefix command - delete blocks created with a label prefix (e.g. demo_)
 *
 * Intended use:
 * - After running `sync --prefix demo_` during demos.
 *
 * Safety:
 * - Only deletes blocks with metadata.managed_by == 'smarty-admin'.
 * - Skips blocks that appear attached to agents unless --force-attached.
 */

import type { CommandContext, CommandResult } from '../types.js';
import {
  header,
  info,
  success,
  warn,
  error as printError,
  dryRunNotice,
  verbose,
} from '../utils/output.js';
import Letta from '@letta-ai/letta-client';
import { resolveLettaApiKey } from '../config/letta-auth.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

type AnyPage<T> = any;
function pageItems<T>(page: AnyPage<T>): T[] {
  if (Array.isArray(page)) return page as T[];
  return (page?.items ?? page?.body ?? []) as T[];
}

function findRepoRoot(startDir: string): string {
  let current = startDir;
  const root = path.parse(current).root;
  while (true) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.letta'))) {
      return current;
    }
    if (current === root) return startDir;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function readPinnedAgentId(repoRoot: string): string | null {
  const p = path.join(repoRoot, '.letta', 'settings.local.json');
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as { lastAgent?: string };
    return obj.lastAgent ?? null;
  } catch {
    return null;
  }
}

export interface CleanupPrefixOptions {
  prefix?: string;
  apply?: boolean;
  forceAttached?: boolean;
  agentLimit?: string;
}

export async function cleanupPrefixCommand(
  ctx: CommandContext,
  options: CleanupPrefixOptions
): Promise<CommandResult<{ deleted: string[] }>> {
  const { options: globalOpts, outputFormat } = ctx;

  const prefix = options.prefix;
  if (!prefix || prefix.trim().length === 0) {
    return { success: false, message: '--prefix is required' };
  }

  if (outputFormat === 'human') {
    header('Cleanup Prefix');
    if (!options.apply) {
      dryRunNotice();
    }
    info(`Prefix: ${prefix}`);
  }

  const apiKey = resolveLettaApiKey();
  if (!apiKey) {
    return { success: false, message: 'LETTA_API_KEY is required (set env var or run `letta setup`)' };
  }

  const agentLimit = Math.max(1, parseInt(options.agentLimit ?? '200', 10) || 200);
  const client = new Letta({ apiKey, project: globalOpts.project });

  // Find candidate blocks by label_search
  const page = await client.blocks.list({ label_search: prefix, limit: 500 } as any);
  const all = pageItems<any>(page as any);
  const candidates = all.filter((b) => typeof b?.label === 'string' && b.label.startsWith(prefix));

  // Only delete blocks created by smarty-admin.
  const managed = candidates.filter((b) => b?.metadata?.managed_by === 'smarty-admin');

  // Build set of attached blocks (best effort)
  const usedBlockIds = new Set<string>();
  const repoRoot = findRepoRoot(process.cwd());
  const pinnedAgentId = readPinnedAgentId(repoRoot);

  if (pinnedAgentId) {
    try {
      const pinned = await client.agents.retrieve(pinnedAgentId);
      const ids = ((pinned as any).block_ids ?? []) as string[];
      for (const id of ids) usedBlockIds.add(id);
      verbose(`Pinned agent ${pinnedAgentId} has ${ids.length} block(s)`, globalOpts.verbose);
    } catch (err) {
      warn(`Could not inspect pinned agent ${pinnedAgentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (options.apply && !options.forceAttached) {
    try {
      const agentsPage = await client.agents.list({ limit: agentLimit } as any);
      const agents = pageItems<any>(agentsPage as any);
      verbose(`Scanning up to ${agents.length} agent(s) for block usage...`, globalOpts.verbose);

      for (const a of agents) {
        const id = a?.id;
        if (!id) continue;
        const full = await client.agents.retrieve(id);
        const ids = ((full as any).block_ids ?? []) as string[];
        for (const bid of ids) usedBlockIds.add(bid);
      }
    } catch (err) {
      warn(`Agent usage scan failed; deletions will be conservative: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (outputFormat === 'human') {
    info(`Blocks matching prefix (any): ${candidates.length}`);
    info(`Blocks matching prefix (managed_by=smarty-admin): ${managed.length}`);
  }

  const deleted: string[] = [];
  for (const b of managed) {
    if (!options.forceAttached && usedBlockIds.has(b.id)) {
      if (outputFormat === 'human') {
        warn(`Skip (attached to an agent): ${b.label} ${b.id}`);
      }
      continue;
    }

    if (outputFormat === 'human' && !options.apply) {
      info(`Would delete: ${b.label} ${b.id}`);
      continue;
    }

    if (options.apply) {
      try {
        await client.blocks.delete(b.id);
        deleted.push(b.id);
        if (outputFormat === 'human') {
          success(`Deleted: ${b.label} ${b.id}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (outputFormat === 'human') {
          printError(`Failed to delete ${b.label} ${b.id}: ${msg}`);
        }
      }
    }
  }

  return {
    success: true,
    message: options.apply ? `Deleted ${deleted.length} block(s)` : 'Dry run complete',
    data: { deleted },
  };
}
