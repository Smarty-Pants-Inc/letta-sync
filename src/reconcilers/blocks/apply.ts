/**
 * Block reconciliation apply/upsert logic
 * 
 * This module implements the core reconciliation logic for blocks:
 * 1. Create missing blocks with proper metadata/tags
 * 2. Update existing blocks (value, description, read_only)
 * 3. Never delete unmanaged blocks
 * 4. Deletions require explicit --allow-delete flag
 * 
 * Supports dry-run mode to preview changes without applying them.
 */

import type { LettaClient, BlockResponse } from '../../api/client.js';
import type {
  BlockManifestEntry,
  ManagedBlockMetadata,
  ApplyOptions,
  ApplyResult,
  ApplyActionResult,
  ReconcilePlan,
  PlanAction,
  BlockClassification,
} from './types.js';
import { BlockOwnership, CANONICAL_LABELS, LAYER_PREFIXES } from './types.js';
import { createManagedBlock, isManagedLabel } from './create.js';
import {
  parseBlockManagement,
  compareBlockWithManifest,
  updateManagedBlock,
  adoptBlock,
} from './update.js';

/**
 * Classify a block's ownership status
 * 
 * @param block - Block from Letta API
 * @param manifestLabels - Set of labels defined in Git manifests
 * @returns Classification with ownership status and reason
 */
export function classifyBlock(
  block: BlockResponse,
  manifestLabels: Set<string>
): BlockClassification {
  const info = parseBlockManagement(block);

  // Has managed metadata
  if (info.isManaged) {
    // Check if still defined in manifests
    if (manifestLabels.has(block.label)) {
      return {
        ownership: BlockOwnership.MANAGED,
        info,
        reason: 'Block has managed metadata and exists in Git manifest',
      };
    } else {
      return {
        ownership: BlockOwnership.ORPHANED,
        info,
        reason: 'Block has managed metadata but not in Git manifest',
      };
    }
  }

  // No managed metadata
  else {
    // Check if label matches managed pattern
    if (isManagedLabel(block.label)) {
      if (manifestLabels.has(block.label)) {
        return {
          ownership: BlockOwnership.ADOPTED,
          info: undefined,
          reason: 'Label matches managed pattern and exists in manifest - needs metadata',
        };
      } else {
        return {
          ownership: BlockOwnership.UNMANAGED,
          info: undefined,
          reason: "Label matches managed pattern but not in manifest",
        };
      }
    } else {
      return {
        ownership: BlockOwnership.UNMANAGED,
        info: undefined,
        reason: "No managed metadata and label doesn't match pattern",
      };
    }
  }
}

/**
 * List all blocks that might be managed, using label-based pre-filtering
 * 
 * @param client - Letta API client
 * @returns Array of blocks that might be managed
 */
async function listManagedCandidates(
  client: LettaClient
): Promise<BlockResponse[]> {
  const allBlocks: BlockResponse[] = [];
  const seenIds = new Set<string>();

  // Search by each layer prefix
  const prefixes = Object.values(LAYER_PREFIXES);

  for (const prefix of prefixes) {
    const blocks = await client.blocks.list({
      label_search: prefix,
      limit: 100,
    });

    for (const block of blocks) {
      if (!seenIds.has(block.id)) {
        seenIds.add(block.id);
        allBlocks.push(block);
      }
    }
  }

  // Also search for canonical labels
  for (const label of Array.from(CANONICAL_LABELS)) {
    const blocks = await client.blocks.list({
      label,
      limit: 10,
    });

    for (const block of blocks) {
      if (!seenIds.has(block.id)) {
        seenIds.add(block.id);
        allBlocks.push(block);
      }
    }
  }

  return allBlocks;
}

/**
 * Build a reconciliation plan comparing manifest with remote state
 * 
 * This determines what actions need to be taken to bring the remote
 * blocks in sync with the local manifest.
 * 
 * @param client - Letta API client
 * @param manifest - Array of block manifest entries (desired state)
 * @param options - Apply options
 * @returns Reconciliation plan
 */
export async function buildReconcilePlan(
  client: LettaClient,
  manifest: BlockManifestEntry[],
  options: ApplyOptions
): Promise<ReconcilePlan> {
  const plan: ReconcilePlan = {
    creates: [],
    updates: [],
    deletes: [],
    skipped: [],
    summary: {
      toCreate: 0,
      toUpdate: 0,
      toDelete: 0,
      unchanged: 0,
      total: manifest.length,
    },
  };

  // Index manifest by label
  const manifestByLabel = new Map<string, BlockManifestEntry>();
  const manifestLabels = new Set<string>();
  for (const entry of manifest) {
    manifestByLabel.set(entry.label, entry);
    manifestLabels.add(entry.label);
  }

  // Fetch existing blocks that might be managed
  const existingBlocks = await listManagedCandidates(client);

  // Index existing blocks by label
  const existingByLabel = new Map<string, BlockResponse>();
  for (const block of existingBlocks) {
    existingByLabel.set(block.label, block);
  }

  // Process each manifest entry
  for (const entry of manifest) {
    const existing = existingByLabel.get(entry.label);

    if (!existing) {
      // Block doesn't exist - needs to be created
      plan.creates.push({
        type: 'create',
        label: entry.label,
        reason: 'Block does not exist in Letta',
        changes: [
          { field: 'value', newValue: truncate(entry.value) },
          { field: 'layer', newValue: entry.layer },
          ...(entry.description ? [{ field: 'description', newValue: entry.description }] : []),
        ],
      });
      plan.summary.toCreate++;
    } else {
      // Block exists - check if it needs updating
      const classification = classifyBlock(existing, manifestLabels);

      if (classification.ownership === BlockOwnership.UNMANAGED) {
        // Block exists but is not managed and not adoptable - skip
        plan.skipped.push({
          type: 'skip',
          label: entry.label,
          blockId: existing.id,
          reason: 'Block exists but is not managed - skipping to avoid overwriting user data',
        });
        plan.summary.unchanged++;
      } else if (classification.ownership === BlockOwnership.ADOPTED) {
        // Block exists with matching label but no metadata - needs adoption
        const diff = compareBlockWithManifest(entry, existing);
        plan.updates.push({
          type: 'adopt',
          label: entry.label,
          blockId: existing.id,
          reason: 'Block matches manifest label but lacks management metadata - will adopt',
          changes: [
            { field: 'metadata', oldValue: '(none)', newValue: 'managed_by: smarty-admin' },
            ...diff.changes,
          ],
        });
        plan.summary.toUpdate++;
      } else {
        // Block is managed - check for changes
        const diff = compareBlockWithManifest(entry, existing);

        if (diff.hasChanges || options.packageVersion !== classification.info?.packageVersion) {
          plan.updates.push({
            type: 'update',
            label: entry.label,
            blockId: existing.id,
            reason: diff.hasChanges 
              ? 'Block content has changed'
              : 'Package version needs update',
            changes: diff.changes,
          });
          plan.summary.toUpdate++;
        } else {
          // No changes needed
          plan.skipped.push({
            type: 'skip',
            label: entry.label,
            blockId: existing.id,
            reason: 'Block is already in sync',
          });
          plan.summary.unchanged++;
        }
      }
    }
  }

  // Find orphaned blocks (managed blocks not in manifest)
  for (const block of existingBlocks) {
    if (!manifestLabels.has(block.label)) {
      const classification = classifyBlock(block, manifestLabels);

      if (classification.ownership === BlockOwnership.ORPHANED) {
        if (options.allowDelete) {
          plan.deletes.push({
            type: 'delete',
            label: block.label,
            blockId: block.id,
            reason: 'Block was managed but is no longer in manifest',
          });
          plan.summary.toDelete++;
        } else {
          plan.skipped.push({
            type: 'skip',
            label: block.label,
            blockId: block.id,
            reason: 'Orphaned block - use --allow-delete to remove',
          });
        }
      }
      // Unmanaged blocks are completely ignored
    }
  }

  return plan;
}

/**
 * Execute a single plan action
 * 
 * @param client - Letta API client
 * @param action - Action to execute
 * @param manifest - Manifest entries indexed by label
 * @param existingBlocks - Existing blocks indexed by label
 * @param options - Apply options
 * @returns Result of the action
 */
async function executeAction(
  client: LettaClient,
  action: PlanAction,
  manifest: Map<string, BlockManifestEntry>,
  existingBlocks: Map<string, BlockResponse>,
  options: ApplyOptions
): Promise<ApplyActionResult> {
  try {
    const entry = manifest.get(action.label);
    const existing = existingBlocks.get(action.label);

    switch (action.type) {
      case 'create': {
        if (!entry) {
          throw new Error(`No manifest entry for label: ${action.label}`);
        }
        const block = await createManagedBlock(client, entry, {
          packageVersion: options.packageVersion,
        });
        return {
          action,
          success: true,
          blockId: block.id,
        };
      }

      case 'update': {
        if (!entry || !existing || !action.blockId) {
          throw new Error(`Missing entry, existing block, or blockId for update`);
        }
        const block = await updateManagedBlock(
          client,
          action.blockId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          blockId: block.id,
        };
      }

      case 'adopt': {
        if (!entry || !existing || !action.blockId) {
          throw new Error(`Missing entry, existing block, or blockId for adopt`);
        }
        const block = await adoptBlock(
          client,
          action.blockId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          blockId: block.id,
        };
      }

      case 'delete': {
        if (!action.blockId) {
          throw new Error(`Missing blockId for delete`);
        }
        await client.blocks.delete(action.blockId);
        return {
          action,
          success: true,
          blockId: action.blockId,
        };
      }

      case 'skip':
        return {
          action,
          success: true,
          blockId: action.blockId,
        };

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  } catch (error) {
    return {
      action,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Apply the reconciliation plan
 * 
 * Executes all planned actions to bring remote blocks in sync with manifest.
 * Supports dry-run mode where no changes are actually made.
 * 
 * @param client - Letta API client
 * @param manifest - Array of block manifest entries (desired state)
 * @param options - Apply options including dryRun flag
 * @returns Apply result with success/failure details
 */
export async function applyBlockReconciliation(
  client: LettaClient,
  manifest: BlockManifestEntry[],
  options: ApplyOptions
): Promise<ApplyResult> {
  // Build the plan
  const plan = await buildReconcilePlan(client, manifest, options);

  // If dry-run, return the plan as a result without executing
  if (options.dryRun) {
    return {
      results: [
        ...plan.creates.map((a) => ({ action: a, success: true })),
        ...plan.updates.map((a) => ({ action: a, success: true })),
        ...plan.deletes.map((a) => ({ action: a, success: true })),
        ...plan.skipped.map((a) => ({ action: a, success: true })),
      ],
      summary: {
        created: plan.summary.toCreate,
        updated: plan.summary.toUpdate,
        deleted: plan.summary.toDelete,
        failed: 0,
        skipped: plan.summary.unchanged,
      },
      errors: [],
      success: true,
    };
  }

  // Index manifest and existing blocks for execution
  const manifestByLabel = new Map<string, BlockManifestEntry>();
  for (const entry of manifest) {
    manifestByLabel.set(entry.label, entry);
  }

  const existingBlocks = await listManagedCandidates(client);
  const existingByLabel = new Map<string, BlockResponse>();
  for (const block of existingBlocks) {
    existingByLabel.set(block.label, block);
  }

  // Execute all actions
  const results: ApplyActionResult[] = [];
  const errors: string[] = [];

  // Execute creates
  for (const action of plan.creates) {
    const result = await executeAction(
      client,
      action,
      manifestByLabel,
      existingByLabel,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Create ${action.label}: ${result.error}`);
    }
  }

  // Execute updates (including adoptions)
  for (const action of plan.updates) {
    const result = await executeAction(
      client,
      action,
      manifestByLabel,
      existingByLabel,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Update ${action.label}: ${result.error}`);
    }
  }

  // Execute deletes
  for (const action of plan.deletes) {
    const result = await executeAction(
      client,
      action,
      manifestByLabel,
      existingByLabel,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Delete ${action.label}: ${result.error}`);
    }
  }

  // Add skipped items to results
  for (const action of plan.skipped) {
    results.push({
      action,
      success: true,
      blockId: action.blockId,
    });
  }

  // Calculate summary
  const summary = {
    created: results.filter((r) => r.success && r.action.type === 'create').length,
    updated: results.filter((r) => r.success && (r.action.type === 'update' || r.action.type === 'adopt')).length,
    deleted: results.filter((r) => r.success && r.action.type === 'delete').length,
    failed: results.filter((r) => !r.success).length,
    skipped: results.filter((r) => r.success && r.action.type === 'skip').length,
  };

  return {
    results,
    summary,
    errors,
    success: errors.length === 0,
  };
}

/**
 * Get the reconciliation plan without applying changes
 * 
 * This is useful for preview/dry-run scenarios.
 * 
 * @param client - Letta API client
 * @param manifest - Array of block manifest entries
 * @param options - Options (allowDelete affects plan)
 * @returns Reconciliation plan
 */
export async function getReconcilePlan(
  client: LettaClient,
  manifest: BlockManifestEntry[],
  options: Omit<ApplyOptions, 'dryRun'> = {}
): Promise<ReconcilePlan> {
  return buildReconcilePlan(client, manifest, { ...options, dryRun: true });
}

/**
 * Helper to truncate long strings for display
 */
function truncate(value: string, maxLength: number = 50): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength) + '...';
}
