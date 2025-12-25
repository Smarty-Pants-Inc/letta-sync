/**
 * cleanup-duplicates command - identify and optionally delete duplicate managed blocks
 *
 * This is mainly to clean up accidental duplicates created during earlier sync
 * implementations. It only considers blocks that are:
 * - label == desired label
 * - metadata.managed_by == 'smarty-admin'
 * - metadata.source == <manifest.metadata.name>
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
import { createClient, type LettaClient } from '../api/client.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

interface BlockManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
  };
  spec: {
    managed: boolean;
    layer: string;
    label: string;
    value: string;
    limit?: number;
  };
}

type AnyPage<T> = any;
function pageItems<T>(page: AnyPage<T>): T[] {
  if (Array.isArray(page)) return page as T[];
  return (page?.items ?? page?.body ?? []) as T[];
}

function findPackagesExamplesDir(startDir: string): string {
  let current = startDir;
  const root = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, 'packages', 'examples');
    if (fs.existsSync(candidate)) return candidate;

    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.join(startDir, 'packages', 'examples');
}

function findBlockManifests(packagesDir: string): string[] {
  const manifests: string[] = [];
  const dirs = fs.readdirSync(packagesDir);

  for (const dir of dirs) {
    const blocksPath = path.join(packagesDir, dir, 'blocks.yaml');
    if (fs.existsSync(blocksPath)) {
      manifests.push(blocksPath);
    }
  }

  return manifests;
}

function loadBlockManifests(filePath: string): BlockManifest[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const docs = yaml.parseAllDocuments(content);

  const blocks: BlockManifest[] = [];
  for (const doc of docs) {
    const obj = doc.toJSON() as any;
    if (obj?.kind === 'Block') {
      blocks.push(obj as BlockManifest);
    }
  }

  return blocks;
}

function timestampMs(b: any): number {
  const t = b?.updated_at ?? b?.created_at;
  const ms = typeof t === 'string' ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : 0;
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

export interface CleanupDuplicatesOptions {
  labels?: string[];
  prefix?: string;
  keep?: string; // commander gives strings
  apply?: boolean;
  forceAttached?: boolean;
  agentLimit?: string;
}

export async function cleanupDuplicatesCommand(
  ctx: CommandContext,
  options: CleanupDuplicatesOptions
): Promise<CommandResult<{ deleted: string[] }>> {
  const { options: globalOpts, outputFormat } = ctx;

  if (outputFormat === 'human') {
    header('Cleanup Duplicates');
    if (!options.apply) {
      dryRunNotice();
    }
    info('This command only targets blocks managed by smarty-admin (metadata.managed_by + metadata.source).');
  }

  let client: LettaClient;
  try {
    client = createClient({ project: globalOpts.project, debug: globalOpts.verbose });
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : 'Failed to create API client' };
  }

  const keepN = Math.max(1, parseInt(options.keep ?? '1', 10) || 1);
  const agentLimit = Math.max(1, parseInt(options.agentLimit ?? '200', 10) || 200);

  // Load desired blocks from manifests and merge by label (base -> org -> project).
  const packagesDir = findPackagesExamplesDir(process.cwd());
  const manifestFiles = findBlockManifests(packagesDir);

  const desiredByLabel = new Map<string, BlockManifest>();
  for (const file of manifestFiles) {
    const blocks = loadBlockManifests(file);
    for (const b of blocks) {
      desiredByLabel.set(b.spec.label, b);
    }
  }

  const desiredBlocks = Array.from(desiredByLabel.values());

  // Optional label filter
  const labelAllow = options.labels && options.labels.length > 0 ? new Set(options.labels) : null;

  // Protect blocks attached to agents unless forced.
  const usedBlockIds = new Set<string>();
  const repoRoot = findRepoRoot(process.cwd());
  const pinnedAgentId = readPinnedAgentId(repoRoot);

  if (pinnedAgentId) {
    try {
      const pinnedAgent = await client.agents.retrieve(pinnedAgentId);
      const ids = ((pinnedAgent as any).block_ids ?? []) as string[];
      for (const id of ids) usedBlockIds.add(id);
      verbose(`Pinned agent ${pinnedAgentId} has ${ids.length} block(s)`, globalOpts.verbose);
    } catch (err) {
      warn(`Could not inspect pinned agent ${pinnedAgentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (options.apply && !options.forceAttached) {
    // Best effort: scan a slice of agents for block usage.
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

  const deleted: string[] = [];
  let dupLabelCount = 0;

  for (const manifest of desiredBlocks) {
    const baseLabel = manifest.spec.label;
    const label = options.prefix ? `${options.prefix}${baseLabel}` : baseLabel;

    if (labelAllow && !labelAllow.has(baseLabel) && !labelAllow.has(label)) continue;

    // Find blocks for label; filter to those that match this manifest's source.
    const sourceKey = manifest.metadata.name;
    const page = await client.blocks.list({ label, limit: 500 } as any);
    const blocks = pageItems<any>(page as any);

    const ours = blocks.filter(
      (b) => b?.metadata?.managed_by === 'smarty-admin' && b?.metadata?.source === sourceKey
    );

    if (ours.length <= keepN) continue;

    dupLabelCount++;

    // Prefer keeping blocks used by any agent.
    const used = ours.filter((b) => usedBlockIds.has(b.id));
    const unused = ours.filter((b) => !usedBlockIds.has(b.id));

    // Sort unused by last-updated so we keep the newest.
    unused.sort((a, b) => timestampMs(b) - timestampMs(a));

    // Determine keep set
    const keep: any[] = [];
    for (const b of used) keep.push(b);
    for (const b of unused) {
      if (keep.length >= keepN) break;
      keep.push(b);
    }

    const keepIds = new Set(keep.map((b) => b.id));
    const toDelete = ours.filter((b) => !keepIds.has(b.id));

    if (outputFormat === 'human') {
      warn(`Duplicate managed blocks for label=${label} source=${sourceKey}: ${ours.length} (keep ${keepN})`);
      info(`Keeping: ${Array.from(keepIds).join(', ')}`);
      if (toDelete.length > 0) {
        info(`Would delete: ${toDelete.map((b) => b.id).join(', ')}`);
      }
    }

    if (options.apply) {
      for (const b of toDelete) {
        if (!options.forceAttached && usedBlockIds.has(b.id)) {
          warn(`Skip delete (attached to an agent): ${b.id}`);
          continue;
        }
        try {
          await client.blocks.delete(b.id);
          deleted.push(b.id);
          if (outputFormat === 'human') {
            success(`Deleted: ${b.id}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (outputFormat === 'human') {
            printError(`Failed to delete ${b.id}: ${msg}`);
          }
        }
      }
    }
  }

  if (outputFormat === 'human') {
    if (dupLabelCount === 0) {
      success('No duplicate managed blocks found.');
    } else {
      info(`Duplicate labels found: ${dupLabelCount}`);
      if (!options.apply) {
        info('Nothing deleted (use --apply to delete).');
      } else {
        success(`Deleted ${deleted.length} block(s).`);
      }
    }
  }

  return {
    success: true,
    message: options.apply ? `Deleted ${deleted.length} block(s)` : 'Dry run complete',
    data: { deleted },
  };
}
