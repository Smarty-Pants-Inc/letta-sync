/**
 * sync command - Apply local configuration changes to remote Letta agent
 * 
 * Now with REAL Letta API integration!
 * 
 * Manifest discovery:
 * - Preferred: <repoRoot>/.letta/manifests
 * - Legacy (deprecated): <repoRoot>/packages/examples
 */

import type { CommandContext, CommandResult, SyncResult, ConfigDiff } from '../types.js';
import { 
  info, 
  success, 
  error as printError, 
  warn,
  verbose, 
  header, 
  dryRunNotice,
} from '../utils/output.js';
import Letta from '@letta-ai/letta-client';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { resolveLettaApiKey } from '../config/letta-auth.js';
import { loadManifests, type LoadedManifests } from '../discover.js';
import type { BlockResource } from '../packages/types.js';


type AnyPage<T> = any;

function pageItems<T>(page: AnyPage<T>): T[] {
  if (Array.isArray(page)) return page as T[];
  // Letta SDK uses ArrayPage<T> with public `items`; `body` may be protected.
  return (page?.items ?? page?.body ?? []) as T[];
}

/**
 * Safety check: ensure the requested `--project` actually changes the scope.
 *
 * Some API keys are hard-scoped to a single project. In that case, passing
 * `project: "demo"` is ignored by the server and writes would hit the scoped
 * project anyway.
 */
async function assertProjectSelectionWorks(apiKey: string, project?: string): Promise<void> {
  if (!project) return;

  const defaultClient = new Letta({ apiKey });
  // Prefer projectID, but pass through string (slug or id). Letta accepts either.
  const projectClient = new Letta({ apiKey, projectID: project });

  // Prefer blocks, fallback to agents if empty.
  const defaultBlocks = pageItems<any>((await defaultClient.blocks.list({ limit: 1 } as any)) as any);
  const projectBlocks = pageItems<any>((await projectClient.blocks.list({ limit: 1 } as any)) as any);

  const defaultProjectId = defaultBlocks[0]?.project_id;
  const projectProjectId = projectBlocks[0]?.project_id;

  // If the API key is hard-scoped to a single project, passing `--project` won't
  // change scope. In "single project" mode this is acceptable and is the common
  // case on Letta Cloud. We keep this check as a warning-only signal.
  if (defaultProjectId && projectProjectId && defaultProjectId === projectProjectId) {
    return;
  }

  // If blocks were empty, try agents.
  if (!defaultProjectId || !projectProjectId) {
    const defaultAgents = pageItems<any>((await defaultClient.agents.list({ limit: 1 } as any)) as any);
    const projectAgents = pageItems<any>((await projectClient.agents.list({ limit: 1 } as any)) as any);
    const d = defaultAgents[0]?.project_id;
    const p = projectAgents[0]?.project_id;
    if (d && p && d === p) {
      return;
    }
  }
}

export interface SyncOptions {
  /** Force sync even if there are conflicts */
  force?: boolean;
  /** Only sync specific sections */
  only?: string[];
  /** Prefix to add to all block labels (for demo/testing) */
  prefix?: string;
  /**
   * When multiple managed blocks exist for the same label+source (usually from
   * earlier demos/bugs), delete duplicates and keep only the most recent.
   */
  pruneDuplicates?: boolean;
}

/**
 * Block manifest interface for sync operations
 * 
 * This is a simplified view of BlockResource for sync purposes.
 * The actual loading now uses the packages loader infrastructure.
 */
interface BlockManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    description?: string;
    labels?: Record<string, string>;
  };
  spec: {
    managed?: boolean;
    layer: string;
    label: string;
    value: string;
    limit?: number;
  };
}

/**
 * Convert BlockResource to BlockManifest format for sync compatibility
 */
function blockResourceToManifest(resource: BlockResource): BlockManifest {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.metadata.name,
      description: resource.metadata.description,
      labels: resource.metadata.labels,
    },
    spec: {
      managed: resource.spec.managed,
      layer: resource.spec.layer,
      label: resource.spec.label,
      value: resource.spec.value,
      limit: resource.spec.limit,
    },
  };
}

/**
 * Execute the sync command
 * Applies local configuration changes to the remote Letta agent
 */
export async function syncCommand(
  ctx: CommandContext,
  options: SyncOptions = {}
): Promise<CommandResult<SyncResult>> {
  const { options: globalOpts, outputFormat } = ctx;

  verbose(`Executing sync command`, globalOpts.verbose);
  verbose(`Project: ${globalOpts.project ?? '(default)'}`, globalOpts.verbose);
  verbose(`Dry run: ${globalOpts.dryRun}`, globalOpts.verbose);

  if (outputFormat === 'human') {
    header('Configuration Sync');
    
    if (globalOpts.dryRun) {
      dryRunNotice();
    }
  }

  const result: SyncResult = {
    applied: [],
    skipped: [],
    errors: [],
  };

  try {
    // Resolve API key (env, or ~/.letta/settings.json)
    const apiKey = resolveLettaApiKey();
    if (!apiKey) {
      throw new Error('LETTA_API_KEY is required (set env var or run `letta setup`)');
    }

    // Safety latch: validate that --project actually takes effect for this API key.
    await assertProjectSelectionWorks(apiKey, globalOpts.project);

    // Create API client using official Letta SDK
    // Prefer projectID, but pass through string (slug or id). Letta accepts either.
    const client = new Letta({ apiKey, projectID: globalOpts.project });

    verbose(`Connecting to Letta API...`, globalOpts.verbose);
    verbose(`Target project: ${globalOpts.project || '(default)'}`, globalOpts.verbose);

    // Load manifests using new discovery system
    let loadedManifests: LoadedManifests;
    try {
      loadedManifests = await loadManifests(process.cwd());
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (outputFormat === 'human') {
        printError(errMsg);
      }
      return {
        success: false,
        message: errMsg,
        data: result,
      };
    }

    // Show deprecation warning if using legacy path
    if (loadedManifests.discovery.deprecationWarning && outputFormat === 'human') {
      warn(loadedManifests.discovery.deprecationWarning);
    }

    // Log any warnings from loading
    for (const warning of loadedManifests.warnings) {
      if (outputFormat === 'human') {
        warn(warning);
      }
    }

    verbose(
      `Discovered manifests at: ${loadedManifests.discovery.location.path} (${loadedManifests.discovery.location.type})`,
      globalOpts.verbose
    );

    // Convert BlockResources to BlockManifests for sync compatibility
    // The merge already handles layer precedence (project > org > base)
    const desiredByLabel = new Map<string, BlockManifest>();
    for (const blockResource of loadedManifests.desiredState.blocks) {
      const manifest = blockResourceToManifest(blockResource);
      desiredByLabel.set(manifest.spec.label, manifest);
    }

    const desiredBlocks = Array.from(desiredByLabel.values());
    
    if (desiredBlocks.length === 0) {
      if (outputFormat === 'human') {
        warn(`No block manifests found in ${loadedManifests.discovery.location.path}`);
      }
      return {
        success: true,
        message: 'No manifests found',
        data: result,
      };
    }

    verbose(`Found ${desiredBlocks.length} merged block definitions`, globalOpts.verbose);

    if (outputFormat === 'human') {
      info(`Found ${desiredBlocks.length} merged block definitions in manifests`);
      if (options.prefix) {
        info(`Using prefix: "${options.prefix}" (blocks will be created as ${options.prefix}safety_policy, etc.)`);
      }
    }

    // Fetch existing blocks by label.
    //
    // NOTE: Avoid listing with a small fixed limit because projects can have
    // lots of blocks, and we'd miss ours and accidentally create duplicates.
    verbose(`Fetching existing blocks from Letta (by label)...`, globalOpts.verbose);

    function timestampMs(b: any): number {
      const t = b?.updated_at ?? b?.created_at;
      const ms = typeof t === 'string' ? Date.parse(t) : NaN;
      return Number.isFinite(ms) ? ms : 0;
    }

    function pickLatest(blocks: any[]): any {
      return blocks.slice().sort((a, b) => timestampMs(b) - timestampMs(a))[0];
    }

    const existingByLabel = new Map<string, any>();
    let totalFetched = 0;
    let dupLabels = 0;
    for (const manifest of desiredBlocks) {
      const baseLabel = manifest.spec.label;
      const label = options.prefix ? `${options.prefix}${baseLabel}` : baseLabel;
      if (existingByLabel.has(label)) continue;

      // Use a high limit because projects can have many blocks with the same
      // label (e.g. different agents/templates). We rely on metadata.source to
      // select the managed one.
      const page = await client.blocks.list({ label, limit: 200 } as any);
      const blocks = pageItems<any>(page as any);
      totalFetched += blocks.length;

      // Prefer blocks that were previously created by smarty-admin for this
      // manifest (metadata.source matches manifest.metadata.name).
      const sourceKey = manifest.metadata.name;
      const matchingManaged = blocks.filter(
        (b) => b?.metadata?.managed_by === 'smarty-admin' && b?.metadata?.source === sourceKey
      );

      // If blocks exist for the label but none are ours (by managed_by+source),
      // treat as "not found" so we create a managed copy instead of clobbering
      // unrelated blocks belonging to other agents/templates.
      if (blocks.length > 0 && matchingManaged.length === 0) {
        if (outputFormat === 'human') {
          warn(
            `Blocks already exist with label=${label} (${blocks.length}) but none match metadata.source=${sourceKey}; ` +
              `will create a managed block for this manifest to avoid clobbering unrelated blocks`
          );
        }
        continue;
      }

      const chosen = matchingManaged.length > 0 ? pickLatest(matchingManaged) : null;

      if (blocks.length > 1 && outputFormat === 'human') {
        if (matchingManaged.length > 1) {
          dupLabels++;
          warn(
            `Multiple managed blocks found with label=${label} and metadata.source=${sourceKey} (${matchingManaged.length}); ` +
              `using the most recently updated one`
          );

          // Optional hygiene: prune duplicates that we created.
          if (options.pruneDuplicates) {
            const toDelete = matchingManaged.filter((b) => b?.id && b.id !== chosen?.id);
            if (globalOpts.dryRun) {
              info(`Would delete duplicates: ${toDelete.map((b) => b.id).join(', ')}`);
            } else {
              for (const b of toDelete) {
                try {
                  await (client.blocks as any).delete(b.id);
                  success(`Deleted duplicate: ${label} ${b.id}`);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  warn(`Failed to delete duplicate ${label} ${b.id}: ${msg}`);
                }
              }
            }
          }
        }
      }

      if (chosen) {
        existingByLabel.set(label, chosen);
      }
    }

    verbose(
      `Fetched existing blocks for ${existingByLabel.size} label(s) (${totalFetched} rows, ${dupLabels} duplicate label(s))`,
      globalOpts.verbose
    );

    // Compare and sync
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const manifest of desiredBlocks) {
      const baseLabel = manifest.spec.label;
      const label = options.prefix ? `${options.prefix}${baseLabel}` : baseLabel;
      const existing = existingByLabel.get(label);

      if (existing) {
        // Block exists - check if update needed
        const valueMatch = existing.value === manifest.spec.value;
        const descMatch = existing.description === manifest.metadata.description;

        if (valueMatch && descMatch) {
          verbose(`Skip (unchanged): ${label}`, globalOpts.verbose);
          skipped++;
          result.skipped.push({
            resource: 'block',
            name: label,
            action: 'none',
            reason: 'unchanged',
          });
        } else {
          // Need to update
          if (globalOpts.dryRun) {
            if (outputFormat === 'human') {
              info(`Would update: ${label}`);
            }
            result.applied.push({
              resource: 'block',
              name: label,
              action: 'update',
              reason: 'drift detected',
            });
            updated++;
          } else {
            try {
              await client.blocks.update(existing.id, {
                value: manifest.spec.value,
                description: manifest.metadata.description,
              });
              if (outputFormat === 'human') {
                success(`Updated: ${label}`);
              }
              result.applied.push({
                resource: 'block',
                name: label,
                action: 'update',
              });
              updated++;
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              result.errors.push(`Failed to update ${label}: ${errMsg}`);
              if (outputFormat === 'human') {
                printError(`Failed to update ${label}: ${errMsg}`);
              }
            }
          }
        }
      } else {
        // Block doesn't exist - create it
        if (globalOpts.dryRun) {
          if (outputFormat === 'human') {
            info(`Would create: ${label}`);
          }
          result.applied.push({
            resource: 'block',
            name: label,
            action: 'create',
          });
          created++;
        } else {
          try {
            const createReq = {
              label: label,
              value: manifest.spec.value,
              description: manifest.metadata.description,
              limit: manifest.spec.limit || 2000,
              metadata: {
                managed_by: 'smarty-admin',
                layer: manifest.spec.layer,
                source: manifest.metadata.name,
              },
            };
            
            const createdBlock = await client.blocks.create(createReq);
            // Update local cache so later manifests with the same label don't create duplicates.
            existingByLabel.set(label, createdBlock as any);
            if (outputFormat === 'human') {
              success(`Created: ${label}`);
            }
            result.applied.push({
              resource: 'block',
              name: label,
              action: 'create',
            });
            created++;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to create ${label}: ${errMsg}`);
            if (outputFormat === 'human') {
              printError(`Failed to create ${label}: ${errMsg}`);
            }
          }
        }
      }
    }

    // Summary
    if (outputFormat === 'human') {
      console.log('');
      if (globalOpts.dryRun) {
        info(`Dry run summary: ${created} to create, ${updated} to update, ${skipped} unchanged`);
      } else if (result.errors.length > 0) {
        printError(`Sync completed with errors: ${created} created, ${updated} updated, ${result.errors.length} failed`);
      } else if (created === 0 && updated === 0) {
        success('Already in sync. No changes needed.');
      } else {
        success(`Sync complete: ${created} created, ${updated} updated`);
      }
    }

    return {
      success: result.errors.length === 0,
      message: globalOpts.dryRun 
        ? `Dry run: ${created} to create, ${updated} to update`
        : `Sync complete: ${created} created, ${updated} updated`,
      data: result,
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (outputFormat === 'human') {
      printError(`Sync failed: ${errorMsg}`);
    }
    return {
      success: false,
      message: `Sync failed: ${errorMsg}`,
      data: result,
    };
  }
}
