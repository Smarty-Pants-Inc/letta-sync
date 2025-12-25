/**
 * Folder reconciliation apply/upsert logic
 *
 * This module implements the core reconciliation logic for folders:
 * 1. Create missing folders with proper metadata
 * 2. Update existing folders (description, instructions, metadata)
 * 3. Handle agent attachments based on attachment rules
 * 4. Never delete unmanaged folders
 * 5. Deletions require explicit --allow-delete flag
 *
 * Supports dry-run mode to preview changes without applying them.
 */

import type { Folder, CreateFolderRequest } from '../../api/types.js';
import type { LettaClient } from '../../api/client.js';
import type {
  FolderManifestEntry,
  ManagedFolderMetadata,
  FolderLayer,
  ApplyOptions,
  ApplyResult,
  ApplyActionResult,
  ReconcilePlan,
  PlanAction,
  FolderClassification,
} from './types.js';
import { FolderOwnership } from './types.js';
import {
  parseFolderManagement,
  isFolderManaged,
} from './diff.js';

/**
 * Options for creating a folder
 */
export interface CreateFolderOptions {
  /** Package version (git SHA) to stamp on the folder */
  packageVersion?: string;
}

/**
 * Options for updating a folder
 */
export interface UpdateFolderOptions {
  /** Package version (git SHA) to stamp on the folder */
  packageVersion?: string;
}

/**
 * Folder update fields
 */
export interface FolderUpdateFields {
  name?: string;
  description?: string;
  instructions?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Folder diff result (for comparing manifest with actual)
 */
export interface FolderDiff {
  hasChanges: boolean;
  changes: Array<{
    field: string;
    oldValue?: unknown;
    newValue?: unknown;
  }>;
}

/**
 * Build managed metadata for a folder
 */
export function buildManagedMetadata(
  entry: FolderManifestEntry,
  options: CreateFolderOptions = {}
): ManagedFolderMetadata {
  const metadata: ManagedFolderMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: new Date().toISOString(),
  };

  if (entry.org) {
    metadata.org = entry.org;
  }

  if (entry.project) {
    metadata.project = entry.project;
  }

  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  if (entry.description) {
    metadata.description = entry.description;
  }

  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }

  return metadata;
}

/**
 * Build updated metadata for an existing folder
 */
export function buildUpdatedMetadata(
  existingMetadata: ManagedFolderMetadata | undefined,
  entry: FolderManifestEntry,
  options: UpdateFolderOptions = {}
): ManagedFolderMetadata {
  const metadata: ManagedFolderMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: new Date().toISOString(),
  };

  if (entry.org) {
    metadata.org = entry.org;
  }

  if (entry.project) {
    metadata.project = entry.project;
  }

  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  if (entry.description) {
    metadata.description = entry.description;
  }

  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }

  // Preserve adoption timestamp if it exists
  if (existingMetadata?.adopted_at) {
    metadata.adopted_at = existingMetadata.adopted_at;
  }

  if (existingMetadata?.original_name) {
    metadata.original_name = existingMetadata.original_name;
  }

  return metadata;
}

/**
 * Create a managed folder
 */
export async function createManagedFolder(
  client: LettaClient,
  entry: FolderManifestEntry,
  options: CreateFolderOptions = {}
): Promise<Folder> {
  const metadata = buildManagedMetadata(entry, options);

  // Build the create request
  const request: CreateFolderRequest = {
    name: entry.name,
    description: entry.description,
    instructions: entry.instructions,
    embedding: entry.embeddingConfig.model,
    embeddingChunkSize: entry.embeddingConfig.chunkSize,
    metadata: {
      ...entry.lettaMetadata,
      ...metadata,
    },
  };

  // Use the folders client to create
  return client.folders.create(request);
}

/**
 * Compare a folder with its manifest entry to detect changes
 */
export function compareFolderWithManifest(
  entry: FolderManifestEntry,
  existing: Folder
): FolderDiff {
  const changes: FolderDiff['changes'] = [];

  // Check description
  const existingDesc = existing.description ?? '';
  const entryDesc = entry.description ?? '';
  if (existingDesc !== entryDesc) {
    changes.push({
      field: 'description',
      oldValue: existing.description,
      newValue: entry.description,
    });
  }

  // Check instructions
  const existingInstructions = existing.instructions ?? '';
  const entryInstructions = entry.instructions ?? '';
  if (existingInstructions !== entryInstructions) {
    changes.push({
      field: 'instructions',
      oldValue: existing.instructions,
      newValue: entry.instructions,
    });
  }

  return {
    hasChanges: changes.length > 0,
    changes,
  };
}

/**
 * Update a managed folder
 */
export async function updateManagedFolder(
  client: LettaClient,
  folderId: string,
  entry: FolderManifestEntry,
  existing: Folder,
  options: UpdateFolderOptions = {}
): Promise<Folder> {
  const existingMetadata = existing.metadata as unknown as ManagedFolderMetadata | undefined;
  const metadata = buildUpdatedMetadata(existingMetadata, entry, options);

  // Build the update request
  const updateFields: FolderUpdateFields = {
    description: entry.description,
    instructions: entry.instructions,
    metadata: {
      ...entry.lettaMetadata,
      ...metadata,
    },
  };

  return client.folders.update(folderId, updateFields);
}

/**
 * Adopt a folder (add management metadata to existing user folder)
 */
export async function adoptFolder(
  client: LettaClient,
  folderId: string,
  entry: FolderManifestEntry,
  existing: Folder,
  options: UpdateFolderOptions = {}
): Promise<Folder> {
  // Build adoption metadata
  const metadata: ManagedFolderMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: new Date().toISOString(),
    adopted_at: new Date().toISOString(),
    original_name: existing.name,
  };

  if (entry.org) {
    metadata.org = entry.org;
  }

  if (entry.project) {
    metadata.project = entry.project;
  }

  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  if (entry.description) {
    metadata.description = entry.description;
  }

  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }

  // Build the update request
  const updateFields: FolderUpdateFields = {
    description: entry.description,
    instructions: entry.instructions,
    metadata: {
      ...entry.lettaMetadata,
      ...metadata,
    },
  };

  return client.folders.update(folderId, updateFields);
}

/**
 * Classify a folder's ownership status
 *
 * @param folder - Folder from Letta API
 * @param manifestNames - Set of names defined in Git manifests
 * @returns Classification with ownership status and reason
 */
export function classifyFolder(
  folder: Folder,
  manifestNames: Set<string>
): FolderClassification {
  const info = parseFolderManagement(folder);

  // Has managed metadata
  if (info.isManaged) {
    // Check if still defined in manifests
    if (manifestNames.has(folder.name)) {
      return {
        ownership: FolderOwnership.MANAGED,
        info,
        reason: 'Folder has managed metadata and exists in Git manifest',
      };
    } else {
      return {
        ownership: FolderOwnership.ORPHANED,
        info,
        reason: 'Folder has managed metadata but not in Git manifest',
      };
    }
  }

  // No managed metadata
  else {
    // Check if name exists in manifest - candidate for adoption
    if (manifestNames.has(folder.name)) {
      return {
        ownership: FolderOwnership.ADOPTED,
        info: undefined,
        reason: 'Folder exists in manifest but lacks management metadata - needs adoption',
      };
    } else {
      return {
        ownership: FolderOwnership.UNMANAGED,
        info: undefined,
        reason: "No managed metadata and not in manifest",
      };
    }
  }
}

/**
 * List all folders from the API
 */
async function listAllFolders(
  client: LettaClient
): Promise<Folder[]> {
  // Fetch all folders (may need pagination for large deployments)
  return client.folders.list({ limit: 100 });
}

/**
 * Build a reconciliation plan comparing manifest with remote state
 *
 * This determines what actions need to be taken to bring the remote
 * folders in sync with the local manifest.
 *
 * @param client - Letta API client
 * @param manifest - Array of folder manifest entries (desired state)
 * @param options - Apply options
 * @returns Reconciliation plan
 */
export async function buildReconcilePlan(
  client: LettaClient,
  manifest: FolderManifestEntry[],
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

  // Index manifest by name
  const manifestByName = new Map<string, FolderManifestEntry>();
  const manifestNames = new Set<string>();
  for (const entry of manifest) {
    manifestByName.set(entry.name, entry);
    manifestNames.add(entry.name);
  }

  // Fetch existing folders
  const existingFolders = await listAllFolders(client);

  // Index existing folders by name
  const existingByName = new Map<string, Folder>();
  for (const folder of existingFolders) {
    existingByName.set(folder.name, folder);
  }

  // Process each manifest entry
  for (const entry of manifest) {
    const existing = existingByName.get(entry.name);

    if (!existing) {
      // Folder doesn't exist - needs to be created
      plan.creates.push({
        type: 'create',
        name: entry.name,
        reason: 'Folder does not exist in Letta',
        changes: [
          { field: 'layer', newValue: entry.layer },
          { field: 'embeddingConfig.model', newValue: entry.embeddingConfig.model },
          ...(entry.description ? [{ field: 'description', newValue: entry.description }] : []),
        ],
      });
      plan.summary.toCreate++;
    } else {
      // Folder exists - check if it needs updating
      const classification = classifyFolder(existing, manifestNames);

      if (classification.ownership === FolderOwnership.UNMANAGED) {
        // Folder exists but is not managed and not adoptable - skip
        plan.skipped.push({
          type: 'skip',
          name: entry.name,
          folderId: existing.id,
          reason: 'Folder exists but is not managed - skipping to avoid overwriting user data',
        });
        plan.summary.unchanged++;
      } else if (classification.ownership === FolderOwnership.ADOPTED) {
        // Folder exists with matching name but no metadata - needs adoption
        const diff = compareFolderWithManifest(entry, existing);
        plan.updates.push({
          type: 'adopt',
          name: entry.name,
          folderId: existing.id,
          reason: 'Folder matches manifest name but lacks management metadata - will adopt',
          changes: [
            { field: 'metadata', oldValue: '(none)', newValue: 'managed_by: smarty-admin' },
            ...diff.changes,
          ],
        });
        plan.summary.toUpdate++;
      } else {
        // Folder is managed - check for changes
        const diff = compareFolderWithManifest(entry, existing);

        if (diff.hasChanges || options.packageVersion !== classification.info?.packageVersion) {
          plan.updates.push({
            type: 'update',
            name: entry.name,
            folderId: existing.id,
            reason: diff.hasChanges
              ? 'Folder content has changed'
              : 'Package version needs update',
            changes: diff.changes,
          });
          plan.summary.toUpdate++;
        } else {
          // No changes needed
          plan.skipped.push({
            type: 'skip',
            name: entry.name,
            folderId: existing.id,
            reason: 'Folder is already in sync',
          });
          plan.summary.unchanged++;
        }
      }
    }
  }

  // Find orphaned folders (managed folders not in manifest)
  for (const folder of existingFolders) {
    if (!manifestNames.has(folder.name)) {
      const classification = classifyFolder(folder, manifestNames);

      if (classification.ownership === FolderOwnership.ORPHANED) {
        if (options.allowDelete) {
          plan.deletes.push({
            type: 'delete',
            name: folder.name,
            folderId: folder.id,
            reason: 'Folder was managed but is no longer in manifest',
          });
          plan.summary.toDelete++;
        } else {
          plan.skipped.push({
            type: 'skip',
            name: folder.name,
            folderId: folder.id,
            reason: 'Orphaned folder - use --allow-delete to remove',
          });
        }
      }
      // Unmanaged folders are completely ignored
    }
  }

  return plan;
}

/**
 * Execute a single plan action
 *
 * @param client - Letta API client
 * @param action - Action to execute
 * @param manifest - Manifest entries indexed by name
 * @param existingFolders - Existing folders indexed by name
 * @param options - Apply options
 * @returns Result of the action
 */
async function executeAction(
  client: LettaClient,
  action: PlanAction,
  manifest: Map<string, FolderManifestEntry>,
  existingFolders: Map<string, Folder>,
  options: ApplyOptions
): Promise<ApplyActionResult> {
  try {
    const entry = manifest.get(action.name);
    const existing = existingFolders.get(action.name);

    switch (action.type) {
      case 'create': {
        if (!entry) {
          throw new Error(`No manifest entry for name: ${action.name}`);
        }
        const folder = await createManagedFolder(client, entry, {
          packageVersion: options.packageVersion,
        });
        return {
          action,
          success: true,
          folderId: folder.id,
        };
      }

      case 'update': {
        if (!entry || !existing || !action.folderId) {
          throw new Error(`Missing entry, existing folder, or folderId for update`);
        }
        const folder = await updateManagedFolder(
          client,
          action.folderId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          folderId: folder.id,
        };
      }

      case 'adopt': {
        if (!entry || !existing || !action.folderId) {
          throw new Error(`Missing entry, existing folder, or folderId for adopt`);
        }
        const folder = await adoptFolder(
          client,
          action.folderId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          folderId: folder.id,
        };
      }

      case 'delete': {
        if (!action.folderId) {
          throw new Error(`Missing folderId for delete`);
        }
        await client.folders.delete(action.folderId);
        return {
          action,
          success: true,
          folderId: action.folderId,
        };
      }

      case 'skip':
        return {
          action,
          success: true,
          folderId: action.folderId,
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
 * Executes all planned actions to bring remote folders in sync with manifest.
 * Supports dry-run mode where no changes are actually made.
 *
 * @param client - Letta API client
 * @param manifest - Array of folder manifest entries (desired state)
 * @param options - Apply options including dryRun flag
 * @returns Apply result with success/failure details
 */
export async function applyFolderReconciliation(
  client: LettaClient,
  manifest: FolderManifestEntry[],
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

  // Index manifest and existing folders for execution
  const manifestByName = new Map<string, FolderManifestEntry>();
  for (const entry of manifest) {
    manifestByName.set(entry.name, entry);
  }

  const existingFolders = await listAllFolders(client);
  const existingByName = new Map<string, Folder>();
  for (const folder of existingFolders) {
    existingByName.set(folder.name, folder);
  }

  // Execute all actions
  const results: ApplyActionResult[] = [];
  const errors: string[] = [];

  // Execute creates
  for (const action of plan.creates) {
    const result = await executeAction(
      client,
      action,
      manifestByName,
      existingByName,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Create ${action.name}: ${result.error}`);
    }
  }

  // Execute updates (including adoptions)
  for (const action of plan.updates) {
    const result = await executeAction(
      client,
      action,
      manifestByName,
      existingByName,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Update ${action.name}: ${result.error}`);
    }
  }

  // Execute deletes
  for (const action of plan.deletes) {
    const result = await executeAction(
      client,
      action,
      manifestByName,
      existingByName,
      options
    );
    results.push(result);
    if (!result.success && result.error) {
      errors.push(`Delete ${action.name}: ${result.error}`);
    }
  }

  // Add skipped items to results
  for (const action of plan.skipped) {
    results.push({
      action,
      success: true,
      folderId: action.folderId,
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
 * @param manifest - Array of folder manifest entries
 * @param options - Options (allowDelete affects plan)
 * @returns Reconciliation plan
 */
export async function getReconcilePlan(
  client: LettaClient,
  manifest: FolderManifestEntry[],
  options: Omit<ApplyOptions, 'dryRun'> = {}
): Promise<ReconcilePlan> {
  return buildReconcilePlan(client, manifest, { ...options, dryRun: true });
}
