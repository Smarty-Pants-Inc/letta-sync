/**
 * Block diff algorithm
 * 
 * Compares desired block state (from manifest/config) with actual block state
 * (from Letta API) and generates a reconciliation plan.
 * 
 * Based on: docs/specs/blocks-metadata-strategy.md
 */

import type { BlockResponse } from '../../api/client.js';
import type {
  BlockManifestEntry,
  ManagedBlockMetadata,
  ManagedBlockInfo,
  BlockLayer,
  ReconcilePlan,
  PlanAction,
  PlanActionType,
} from './types.js';

import { CANONICAL_LABELS, LAYER_PREFIXES, BlockOwnership } from './types.js';

/**
 * Options for the diff operation
 */
export interface BlockDiffOptions {
  /** Include orphaned blocks in the diff */
  includeOrphans?: boolean;
  /** Include unmanaged blocks in the diff (for reporting) */
  includeUnmanaged?: boolean;
  /** Only show blocks with changes */
  changesOnly?: boolean;
  /** Filter by layer */
  layer?: BlockLayer;
  /** Filter by specific labels */
  labels?: string[];
  /** Package version (git SHA) for change detection */
  packageVersion?: string;
}

/**
 * Types of drift that can occur between desired and actual state
 */
export type DriftType = 
  | 'value'       // Block value content differs
  | 'description' // Block description differs
  | 'read_only'   // Read-only flag differs
  | 'limit'       // Character limit differs
  | 'metadata';   // Management metadata differs

/**
 * Represents a single drift (difference) in a block field
 */
export interface BlockDrift {
  /** Type of drift detected */
  type: DriftType;
  /** Field name */
  field: string;
  /** Current value in Letta */
  actual: unknown;
  /** Expected value from manifest */
  desired: unknown;
}

/**
 * Extended diff result with detailed tracking
 */
export interface BlockDiffResult extends ReconcilePlan {
  /** Timestamp when diff was computed */
  timestamp: string;
  /** Unique identifier for this diff operation */
  diffId: string;
  /** Project context */
  project?: string;
  /** Organization context */
  org?: string;
  /** Whether any changes are needed */
  hasChanges: boolean;
  /** Errors encountered during diff */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
  /** Detailed drift information per block */
  driftDetails: Map<string, BlockDrift[]>;
}

/**
 * Check if a block is managed by smarty-admin based on its metadata
 */
export function isBlockManaged(block: BlockResponse): boolean {
  const metadata = block.metadata as ManagedBlockMetadata | undefined;
  return metadata?.managed_by === 'smarty-admin';
}

/**
 * Extract management metadata from a block
 */
export function extractManagedMetadata(
  block: BlockResponse
): ManagedBlockMetadata | null {
  if (!isBlockManaged(block)) {
    return null;
  }
  return block.metadata as unknown as ManagedBlockMetadata;
}

/**
 * Parse management info from a block
 */
export function parseBlockManagement(block: BlockResponse): ManagedBlockInfo {
  const metadata = block.metadata as ManagedBlockMetadata | undefined;

  if (!metadata || metadata.managed_by !== 'smarty-admin') {
    return { isManaged: false };
  }

  return {
    isManaged: true,
    layer: metadata.layer,
    org: metadata.org,
    project: metadata.project,
    userIdentityId: metadata.user_identity_id,
    packageVersion: metadata.package_version,
    lastSynced: metadata.last_synced,
  };
}

/**
 * Check if a label follows managed block naming conventions
 * This is a SECONDARY signal - always confirm with metadata
 */
export function isManagedLabel(label: string): boolean {
  // Check canonical labels first
  if (CANONICAL_LABELS.has(label)) {
    return true;
  }
  
  // Check layer prefixes
  return Object.values(LAYER_PREFIXES).some(prefix => 
    label.startsWith(prefix)
  );
}

/**
 * Parse layer from a label based on naming convention
 */
export function parseLayerFromLabel(label: string): BlockLayer | null {
  if (CANONICAL_LABELS.has(label)) {
    // Canonical labels have specific layer mappings
    if (label === 'project' || label === 'decisions' || 
        label === 'conventions' || label === 'glossary') {
      return 'project';
    }
    if (label === 'human' || label === 'persona') {
      return 'lane'; // These are typically lane-scoped
    }
    if (label === 'managed_state') {
      return 'lane';
    }
  }
  
  // Check layer prefixes
  for (const [layer, prefix] of Object.entries(LAYER_PREFIXES)) {
    if (label.startsWith(prefix)) {
      return layer as BlockLayer;
    }
  }
  
  return null;
}

/**
 * Classify a block's ownership status
 */
export function classifyBlockOwnership(
  block: BlockResponse,
  desiredLabels: Set<string>
): BlockOwnership {
  const isManaged = isBlockManaged(block);
  const hasMatchingLabel = isManagedLabel(block.label);
  const inDesired = desiredLabels.has(block.label);
  
  if (isManaged) {
    // Has managed metadata
    if (inDesired) {
      return BlockOwnership.MANAGED;
    }
    return BlockOwnership.ORPHANED;
  }
  
  // No managed metadata
  if (hasMatchingLabel && inDesired) {
    return BlockOwnership.ADOPTED; // Candidate for adoption
  }
  
  return BlockOwnership.UNMANAGED;
}

/**
 * Compute drifts between desired and actual block state
 */
export function computeDrifts(
  desired: BlockManifestEntry,
  actual: BlockResponse,
  options: BlockDiffOptions = {}
): BlockDrift[] {
  const drifts: BlockDrift[] = [];
  
  // Value drift
  if (desired.value !== actual.value) {
    drifts.push({
      type: 'value',
      field: 'value',
      actual: actual.value,
      desired: desired.value,
    });
  }
  
  // Description drift
  const desiredDesc = desired.description ?? '';
  const actualDesc = actual.description ?? '';
  if (desiredDesc !== actualDesc) {
    drifts.push({
      type: 'description',
      field: 'description',
      actual: actual.description,
      desired: desired.description,
    });
  }
  
  // Limit drift (only if desired specifies a limit)
  if (desired.limit !== undefined && desired.limit !== actual.limit) {
    drifts.push({
      type: 'limit',
      field: 'limit',
      actual: actual.limit,
      desired: desired.limit,
    });
  }
  
  // Metadata drift (check if management metadata needs updating)
  const actualMetadata = actual.metadata as ManagedBlockMetadata | undefined;
  if (actualMetadata?.managed_by === 'smarty-admin' && options.packageVersion) {
    // Check for package_version drift
    if (options.packageVersion !== actualMetadata.package_version) {
      drifts.push({
        type: 'metadata',
        field: 'package_version',
        actual: actualMetadata.package_version,
        desired: options.packageVersion,
      });
    }
  }
  
  return drifts;
}

/**
 * Convert drifts to plan action changes format
 */
function driftsToChanges(drifts: BlockDrift[]): PlanAction['changes'] {
  return drifts.map(drift => ({
    field: drift.field,
    oldValue: drift.actual,
    newValue: drift.desired,
  }));
}

/**
 * Create a plan action for a missing block (needs creation)
 */
function createMissingBlockAction(
  desired: BlockManifestEntry
): PlanAction {
  return {
    type: 'create',
    label: desired.label,
    reason: 'Block does not exist in Letta but is defined in manifest',
    changes: [
      { field: 'value', newValue: truncate(desired.value, 100) },
      { field: 'layer', newValue: desired.layer },
      ...(desired.description ? [{ field: 'description', newValue: desired.description }] : []),
    ],
  };
}

/**
 * Create a plan action for an existing block with drift
 */
function createDriftBlockAction(
  desired: BlockManifestEntry,
  actual: BlockResponse,
  drifts: BlockDrift[],
  ownership: BlockOwnership
): PlanAction {
  const actionType: PlanActionType = ownership === BlockOwnership.ADOPTED ? 'adopt' : 'update';
  
  const driftTypes = drifts.map(d => d.field).join(', ');
  const reason = ownership === BlockOwnership.ADOPTED
    ? `Block exists but lacks management metadata; needs adoption. Changes: ${driftTypes}`
    : `Block has ${drifts.length} drift(s): ${driftTypes}`;
  
  return {
    type: actionType,
    label: desired.label,
    blockId: actual.id,
    reason,
    changes: driftsToChanges(drifts),
  };
}

/**
 * Create a plan action for a block in sync (skip)
 */
function createInSyncAction(
  desired: BlockManifestEntry,
  actual: BlockResponse
): PlanAction {
  return {
    type: 'skip',
    label: desired.label,
    blockId: actual.id,
    reason: 'Block is in sync with manifest',
  };
}

/**
 * Create a plan action for an orphaned block
 */
function createOrphanedBlockAction(
  actual: BlockResponse
): PlanAction {
  return {
    type: 'delete',
    label: actual.label,
    blockId: actual.id,
    reason: 'Block has management metadata but is not in manifest (orphaned)',
  };
}

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `diff-${timestamp}-${random}`;
}

/**
 * Main diff function - compares desired state with actual state
 * and generates a reconciliation plan
 */
export function diffBlocks(
  desired: BlockManifestEntry[],
  actual: BlockResponse[],
  options: BlockDiffOptions = {}
): BlockDiffResult {
  const {
    includeOrphans = true,
    includeUnmanaged = false,
    changesOnly = false,
    layer,
    labels,
    packageVersion,
  } = options;
  
  const errors: string[] = [];
  const warnings: string[] = [];
  const driftDetails = new Map<string, BlockDrift[]>();
  
  const creates: PlanAction[] = [];
  const updates: PlanAction[] = [];
  const deletes: PlanAction[] = [];
  const skipped: PlanAction[] = [];
  
  // Index desired blocks by label
  const desiredByLabel = new Map<string, BlockManifestEntry>();
  for (const block of desired) {
    if (desiredByLabel.has(block.label)) {
      warnings.push(`Duplicate label in desired state: ${block.label}`);
    }
    desiredByLabel.set(block.label, block);
  }
  
  // Index actual blocks by label
  const actualByLabel = new Map<string, BlockResponse>();
  for (const block of actual) {
    if (actualByLabel.has(block.label)) {
      warnings.push(`Duplicate label in actual state: ${block.label}`);
    }
    actualByLabel.set(block.label, block);
  }
  
  // Set of desired labels for ownership classification
  const desiredLabels = new Set(desiredByLabel.keys());
  
  // Process desired blocks - check for missing or drifted
  for (const [label, desiredBlock] of desiredByLabel) {
    // Apply filters
    if (layer && desiredBlock.layer !== layer) {
      continue;
    }
    if (labels && !labels.includes(label)) {
      continue;
    }
    
    const actualBlock = actualByLabel.get(label);
    
    if (!actualBlock) {
      // Missing block - needs creation
      creates.push(createMissingBlockAction(desiredBlock));
    } else {
      // Block exists - check for drift
      const ownership = classifyBlockOwnership(actualBlock, desiredLabels);
      const drifts = computeDrifts(desiredBlock, actualBlock, options);
      
      if (drifts.length > 0) {
        driftDetails.set(label, drifts);
      }
      
      if (drifts.length > 0 || ownership === BlockOwnership.ADOPTED) {
        const action = createDriftBlockAction(desiredBlock, actualBlock, drifts, ownership);
        if (action.type === 'adopt') {
          // Adoptions go to updates with a special flag
          updates.push(action);
        } else {
          updates.push(action);
        }
      } else if (!changesOnly) {
        skipped.push(createInSyncAction(desiredBlock, actualBlock));
      }
    }
  }
  
  // Process actual blocks - check for orphans
  for (const [label, actualBlock] of actualByLabel) {
    // Skip if already processed (exists in desired)
    if (desiredByLabel.has(label)) {
      continue;
    }
    
    // Apply label filter
    if (labels && !labels.includes(label)) {
      continue;
    }
    
    const ownership = classifyBlockOwnership(actualBlock, desiredLabels);
    
    // Apply layer filter for orphaned blocks
    if (layer && ownership === BlockOwnership.ORPHANED) {
      const metadata = extractManagedMetadata(actualBlock);
      if (metadata && metadata.layer !== layer) {
        continue;
      }
    }
    
    if (ownership === BlockOwnership.ORPHANED && includeOrphans) {
      deletes.push(createOrphanedBlockAction(actualBlock));
    }
    // Note: We don't include unmanaged blocks in the plan by default
    // They're someone else's responsibility
  }
  
  // Compute summary
  const summary = {
    toCreate: creates.length,
    toUpdate: updates.length,
    toDelete: deletes.length,
    unchanged: skipped.length,
    total: creates.length + updates.length + deletes.length + skipped.length,
  };
  
  const hasChanges = summary.toCreate > 0 || 
                     summary.toUpdate > 0 || 
                     summary.toDelete > 0;
  
  return {
    timestamp: new Date().toISOString(),
    diffId: generateDiffId(),
    creates,
    updates,
    deletes,
    skipped,
    summary,
    hasChanges,
    errors,
    warnings,
    driftDetails,
  };
}

/**
 * Format diff result as human-readable summary
 */
export function formatDiffSummary(result: BlockDiffResult): string {
  const lines: string[] = [];
  const { summary } = result;
  
  lines.push('Block Diff Summary');
  lines.push('==================');
  lines.push('');
  lines.push(`Timestamp: ${result.timestamp}`);
  lines.push(`Diff ID: ${result.diffId}`);
  if (result.project) lines.push(`Project: ${result.project}`);
  if (result.org) lines.push(`Organization: ${result.org}`);
  lines.push('');
  
  lines.push('Actions:');
  if (summary.toCreate > 0) lines.push(`  + Create: ${summary.toCreate}`);
  if (summary.toUpdate > 0) lines.push(`  ~ Update: ${summary.toUpdate}`);
  if (summary.toDelete > 0) lines.push(`  - Delete: ${summary.toDelete}`);
  if (summary.unchanged > 0) lines.push(`  = Unchanged: ${summary.unchanged}`);
  lines.push(`  Total: ${summary.total}`);
  lines.push('');
  
  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  ! ${warning}`);
    }
    lines.push('');
  }
  
  if (result.errors.length > 0) {
    lines.push('Errors:');
    for (const error of result.errors) {
      lines.push(`  X ${error}`);
    }
    lines.push('');
  }
  
  if (result.hasChanges) {
    lines.push('Status: CHANGES NEEDED');
  } else {
    lines.push('Status: IN SYNC');
  }
  
  return lines.join('\n');
}

/**
 * Format diff items as detailed human-readable report
 */
export function formatDiffDetails(result: BlockDiffResult): string {
  const lines: string[] = [];
  
  lines.push('');
  lines.push('Detailed Changes:');
  lines.push('-----------------');
  
  // Format creates
  if (result.creates.length > 0) {
    lines.push('');
    lines.push('Blocks to CREATE:');
    for (const action of result.creates) {
      lines.push(`  + ${action.label}`);
      if (action.changes) {
        for (const change of action.changes) {
          lines.push(`    ${change.field}: ${truncate(String(change.newValue ?? ''), 50)}`);
        }
      }
    }
  }
  
  // Format updates
  if (result.updates.length > 0) {
    lines.push('');
    lines.push('Blocks to UPDATE:');
    for (const action of result.updates) {
      const prefix = action.type === 'adopt' ? '*' : '~';
      lines.push(`  ${prefix} ${action.label} (${action.blockId})`);
      lines.push(`    Reason: ${action.reason}`);
      if (action.changes) {
        for (const change of action.changes) {
          lines.push(`    [${change.field}]`);
          if (change.oldValue !== undefined) {
            lines.push(`      - ${truncate(String(change.oldValue), 50)}`);
          }
          if (change.newValue !== undefined) {
            lines.push(`      + ${truncate(String(change.newValue), 50)}`);
          }
        }
      }
    }
  }
  
  // Format deletes
  if (result.deletes.length > 0) {
    lines.push('');
    lines.push('Blocks to DELETE (orphaned):');
    for (const action of result.deletes) {
      lines.push(`  - ${action.label} (${action.blockId})`);
      lines.push(`    Reason: ${action.reason}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Format diff result as JSON plan (machine-readable)
 * Returns a plain object (not the Map-containing result)
 */
export function formatDiffAsJson(result: BlockDiffResult): string {
  // Convert to a serializable format (Maps don't serialize well)
  const jsonResult = {
    timestamp: result.timestamp,
    diffId: result.diffId,
    project: result.project,
    org: result.org,
    hasChanges: result.hasChanges,
    summary: result.summary,
    creates: result.creates,
    updates: result.updates,
    deletes: result.deletes,
    skipped: result.skipped,
    errors: result.errors,
    warnings: result.warnings,
    driftDetails: Object.fromEntries(result.driftDetails),
  };
  
  return JSON.stringify(jsonResult, null, 2);
}

/**
 * Helper: Truncate string with ellipsis
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
