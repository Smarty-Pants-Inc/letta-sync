/**
 * Folder diff algorithm
 *
 * Compares desired folder state (from manifest/config) with actual folder state
 * (from Letta API) and generates a reconciliation plan.
 *
 * Based on: docs/specs/folder-manifest.md
 */

import type { Folder } from '../../api/types.js';
import type {
  FolderManifestEntry,
  ManagedFolderMetadata,
  ManagedFolderInfo,
  FolderLayer,
  ReconcilePlan,
  PlanAction,
  PlanActionType,
} from './types.js';

import { FolderOwnership } from './types.js';

/**
 * Options for the diff operation
 */
export interface FolderDiffOptions {
  /** Include orphaned folders in the diff */
  includeOrphans?: boolean;
  /** Include unmanaged folders in the diff (for reporting) */
  includeUnmanaged?: boolean;
  /** Only show folders with changes */
  changesOnly?: boolean;
  /** Filter by layer */
  layer?: FolderLayer;
  /** Filter by specific names */
  names?: string[];
  /** Package version (git SHA) for change detection */
  packageVersion?: string;
}

/**
 * Types of drift that can occur between desired and actual state
 */
export type DriftType =
  | 'description'     // Folder description differs
  | 'instructions'    // Folder instructions differ
  | 'embedding_config' // Embedding configuration differs
  | 'metadata';       // Management metadata differs

/**
 * Represents a single drift (difference) in a folder field
 */
export interface FolderDrift {
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
export interface FolderDiffResult extends ReconcilePlan {
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
  /** Detailed drift information per folder */
  driftDetails: Map<string, FolderDrift[]>;
}

/**
 * Check if a folder is managed by smarty-admin based on its metadata
 */
export function isFolderManaged(folder: Folder): boolean {
  const metadata = folder.metadata as unknown as ManagedFolderMetadata | undefined;
  return metadata?.managed_by === 'smarty-admin';
}

/**
 * Extract management metadata from a folder
 */
export function extractManagedMetadata(
  folder: Folder
): ManagedFolderMetadata | null {
  if (!isFolderManaged(folder)) {
    return null;
  }
  return folder.metadata as unknown as ManagedFolderMetadata;
}

/**
 * Parse management info from a folder
 */
export function parseFolderManagement(folder: Folder): ManagedFolderInfo {
  const metadata = folder.metadata as unknown as ManagedFolderMetadata | undefined;

  if (!metadata || metadata.managed_by !== 'smarty-admin') {
    return { isManaged: false };
  }

  return {
    isManaged: true,
    layer: metadata.layer,
    org: metadata.org,
    project: metadata.project,
    packageVersion: metadata.package_version,
    lastSynced: metadata.last_synced,
  };
}

/**
 * Classify a folder's ownership status
 */
export function classifyFolderOwnership(
  folder: Folder,
  desiredNames: Set<string>
): FolderOwnership {
  const isManaged = isFolderManaged(folder);
  const inDesired = desiredNames.has(folder.name);

  if (isManaged) {
    // Has managed metadata
    if (inDesired) {
      return FolderOwnership.MANAGED;
    }
    return FolderOwnership.ORPHANED;
  }

  // No managed metadata
  if (inDesired) {
    return FolderOwnership.ADOPTED; // Candidate for adoption
  }

  return FolderOwnership.UNMANAGED;
}

/**
 * Compare embedding configs for equality
 */
function embeddingConfigEquals(
  desired: FolderManifestEntry['embeddingConfig'],
  actual: Folder['embeddingConfig']
): boolean {
  if (!actual) return false;
  
  // Compare the key fields that matter
  const actualConfig = actual as Record<string, unknown>;
  
  // Model comparison
  if (desired.model !== actualConfig.model && 
      desired.model !== actualConfig.embedding_model) {
    return false;
  }
  
  // Chunk size comparison (if specified)
  if (desired.chunkSize !== undefined) {
    const actualChunkSize = actualConfig.chunk_size ?? actualConfig.chunkSize;
    if (desired.chunkSize !== actualChunkSize) {
      return false;
    }
  }
  
  return true;
}

/**
 * Compute drifts between desired and actual folder state
 */
export function computeDrifts(
  desired: FolderManifestEntry,
  actual: Folder,
  options: FolderDiffOptions = {}
): FolderDrift[] {
  const drifts: FolderDrift[] = [];

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

  // Instructions drift
  const desiredInstructions = desired.instructions ?? '';
  const actualInstructions = actual.instructions ?? '';
  if (desiredInstructions !== actualInstructions) {
    drifts.push({
      type: 'instructions',
      field: 'instructions',
      actual: actual.instructions,
      desired: desired.instructions,
    });
  }

  // Embedding config drift (only check if actual has it)
  if (!embeddingConfigEquals(desired.embeddingConfig, actual.embeddingConfig)) {
    drifts.push({
      type: 'embedding_config',
      field: 'embeddingConfig',
      actual: actual.embeddingConfig,
      desired: desired.embeddingConfig,
    });
  }

  // Metadata drift (check if package_version needs updating)
  if (options.packageVersion) {
    const metadata = extractManagedMetadata(actual);
    if (metadata && options.packageVersion !== metadata.package_version) {
      drifts.push({
        type: 'metadata',
        field: 'package_version',
        actual: metadata.package_version,
        desired: options.packageVersion,
      });
    }
  }

  return drifts;
}

/**
 * Convert drifts to plan action changes format
 */
function driftsToChanges(drifts: FolderDrift[]): PlanAction['changes'] {
  return drifts.map(drift => ({
    field: drift.field,
    oldValue: drift.actual,
    newValue: drift.desired,
  }));
}

/**
 * Create a plan action for a missing folder (needs creation)
 */
function createMissingFolderAction(
  desired: FolderManifestEntry
): PlanAction {
  return {
    type: 'create',
    name: desired.name,
    reason: 'Folder does not exist in Letta but is defined in manifest',
    changes: [
      { field: 'layer', newValue: desired.layer },
      { field: 'embeddingConfig.model', newValue: desired.embeddingConfig.model },
      ...(desired.description ? [{ field: 'description', newValue: desired.description }] : []),
      ...(desired.instructions ? [{ field: 'instructions', newValue: truncate(desired.instructions, 100) }] : []),
    ],
  };
}

/**
 * Create a plan action for an existing folder with drift
 */
function createDriftFolderAction(
  desired: FolderManifestEntry,
  actual: Folder,
  drifts: FolderDrift[],
  ownership: FolderOwnership
): PlanAction {
  const actionType: PlanActionType = ownership === FolderOwnership.ADOPTED ? 'adopt' : 'update';

  const driftTypes = drifts.map(d => d.field).join(', ');
  const reason = ownership === FolderOwnership.ADOPTED
    ? `Folder exists but lacks management metadata; needs adoption. Changes: ${driftTypes}`
    : `Folder has ${drifts.length} drift(s): ${driftTypes}`;

  return {
    type: actionType,
    name: desired.name,
    folderId: actual.id,
    reason,
    changes: driftsToChanges(drifts),
  };
}

/**
 * Create a plan action for a folder in sync (skip)
 */
function createInSyncAction(
  desired: FolderManifestEntry,
  actual: Folder
): PlanAction {
  return {
    type: 'skip',
    name: desired.name,
    folderId: actual.id,
    reason: 'Folder is in sync with manifest',
  };
}

/**
 * Create a plan action for an orphaned folder
 */
function createOrphanedFolderAction(
  actual: Folder
): PlanAction {
  return {
    type: 'delete',
    name: actual.name,
    folderId: actual.id,
    reason: 'Folder has management metadata but is not in manifest (orphaned)',
  };
}

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `folder-diff-${timestamp}-${random}`;
}

/**
 * Main diff function - compares desired state with actual state
 * and generates a reconciliation plan
 */
export function diffFolders(
  desired: FolderManifestEntry[],
  actual: Folder[],
  options: FolderDiffOptions = {}
): FolderDiffResult {
  const {
    includeOrphans = true,
    changesOnly = false,
    layer,
    names,
    packageVersion,
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];
  const driftDetails = new Map<string, FolderDrift[]>();

  const creates: PlanAction[] = [];
  const updates: PlanAction[] = [];
  const deletes: PlanAction[] = [];
  const skipped: PlanAction[] = [];

  // Index desired folders by name
  const desiredByName = new Map<string, FolderManifestEntry>();
  for (const folder of desired) {
    if (desiredByName.has(folder.name)) {
      warnings.push(`Duplicate name in desired state: ${folder.name}`);
    }
    desiredByName.set(folder.name, folder);
  }

  // Index actual folders by name
  const actualByName = new Map<string, Folder>();
  for (const folder of actual) {
    if (actualByName.has(folder.name)) {
      warnings.push(`Duplicate name in actual state: ${folder.name}`);
    }
    actualByName.set(folder.name, folder);
  }

  // Set of desired names for ownership classification
  const desiredNames = new Set(desiredByName.keys());

  // Process desired folders - check for missing or drifted
  for (const [name, desiredFolder] of Array.from(desiredByName.entries())) {
    // Apply filters
    if (layer && desiredFolder.layer !== layer) {
      continue;
    }
    if (names && !names.includes(name)) {
      continue;
    }

    const actualFolder = actualByName.get(name);

    if (!actualFolder) {
      // Missing folder - needs creation
      creates.push(createMissingFolderAction(desiredFolder));
    } else {
      // Folder exists - check for drift
      const ownership = classifyFolderOwnership(actualFolder, desiredNames);
      const drifts = computeDrifts(desiredFolder, actualFolder, options);

      if (drifts.length > 0) {
        driftDetails.set(name, drifts);
      }

      if (drifts.length > 0 || ownership === FolderOwnership.ADOPTED) {
        const action = createDriftFolderAction(desiredFolder, actualFolder, drifts, ownership);
        updates.push(action);
      } else if (!changesOnly) {
        skipped.push(createInSyncAction(desiredFolder, actualFolder));
      }
    }
  }

  // Process actual folders - check for orphans
  for (const [name, actualFolder] of Array.from(actualByName.entries())) {
    // Skip if already processed (exists in desired)
    if (desiredByName.has(name)) {
      continue;
    }

    // Apply name filter
    if (names && !names.includes(name)) {
      continue;
    }

    const ownership = classifyFolderOwnership(actualFolder, desiredNames);

    // Apply layer filter for orphaned folders
    if (layer && ownership === FolderOwnership.ORPHANED) {
      const metadata = extractManagedMetadata(actualFolder);
      if (metadata && metadata.layer !== layer) {
        continue;
      }
    }

    if (ownership === FolderOwnership.ORPHANED && includeOrphans) {
      deletes.push(createOrphanedFolderAction(actualFolder));
    }
    // Note: We don't include unmanaged folders in the plan by default
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
export function formatDiffSummary(result: FolderDiffResult): string {
  const lines: string[] = [];
  const { summary } = result;

  lines.push('Folder Diff Summary');
  lines.push('===================');
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
export function formatDiffDetails(result: FolderDiffResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Detailed Changes:');
  lines.push('-----------------');

  // Format creates
  if (result.creates.length > 0) {
    lines.push('');
    lines.push('Folders to CREATE:');
    for (const action of result.creates) {
      lines.push(`  + ${action.name}`);
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
    lines.push('Folders to UPDATE:');
    for (const action of result.updates) {
      const prefix = action.type === 'adopt' ? '*' : '~';
      lines.push(`  ${prefix} ${action.name} (${action.folderId})`);
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
    lines.push('Folders to DELETE (orphaned):');
    for (const action of result.deletes) {
      lines.push(`  - ${action.name} (${action.folderId})`);
      lines.push(`    Reason: ${action.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format diff result as JSON plan (machine-readable)
 */
export function formatDiffAsJson(result: FolderDiffResult): string {
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
