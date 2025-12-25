/**
 * Block update logic for the reconciler
 * 
 * Handles updating existing blocks with new values, descriptions,
 * and metadata while preserving management tracking.
 */

import type { LettaClient, BlockResponse, UpdateBlockRequest } from '../../api/client.js';
import type {
  BlockManifestEntry,
  ManagedBlockMetadata,
  ManagedBlockInfo,
} from './types.js';

/**
 * Options for updating a managed block
 */
export interface UpdateBlockOptions {
  /** Package version (git SHA) to stamp on the block */
  packageVersion?: string;
  /** Whether to force update even if values match */
  force?: boolean;
}

/**
 * Fields that can be updated on a block
 */
export interface BlockUpdateFields {
  value?: string;
  description?: string;
  limit?: number;
}

/**
 * Result of comparing block fields
 */
export interface BlockDiff {
  hasChanges: boolean;
  changes: {
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
}

/**
 * Check if a block is managed by smarty-admin
 * 
 * @param block - Block response from Letta API
 * @returns Parsed management info
 */
export function parseBlockManagement(block: BlockResponse): ManagedBlockInfo {
  const rawMetadata = block.metadata as Record<string, unknown> | undefined;

  if (!rawMetadata || rawMetadata.managed_by !== 'smarty-admin') {
    return { isManaged: false };
  }

  // Safe type assertion after checking managed_by
  const metadata = rawMetadata as unknown as ManagedBlockMetadata;

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
 * Compare a manifest entry with an existing block to find differences
 * 
 * @param entry - Block manifest entry (desired state)
 * @param block - Existing block (current state)
 * @returns Diff result with list of changes
 */
export function compareBlockWithManifest(
  entry: BlockManifestEntry,
  block: BlockResponse
): BlockDiff {
  const changes: BlockDiff['changes'] = [];

  // Compare value
  if (entry.value !== block.value) {
    changes.push({
      field: 'value',
      oldValue: truncateForDisplay(block.value),
      newValue: truncateForDisplay(entry.value),
    });
  }

  // Compare description
  const entryDescription = entry.description ?? undefined;
  const blockDescription = block.description ?? undefined;
  if (entryDescription !== blockDescription) {
    changes.push({
      field: 'description',
      oldValue: blockDescription,
      newValue: entryDescription,
    });
  }

  // Compare limit (if specified in manifest)
  if (entry.limit !== undefined && entry.limit !== block.limit) {
    changes.push({
      field: 'limit',
      oldValue: block.limit,
      newValue: entry.limit,
    });
  }

  return {
    hasChanges: changes.length > 0,
    changes,
  };
}

/**
 * Build updated metadata preserving existing fields
 * 
 * @param existingMetadata - Current block metadata
 * @param entry - Manifest entry
 * @param options - Update options
 * @returns Updated metadata object
 */
export function buildUpdatedMetadata(
  existingMetadata: Record<string, unknown> | undefined,
  entry: BlockManifestEntry,
  options: UpdateBlockOptions = {}
): ManagedBlockMetadata {
  const now = new Date().toISOString();
  const existing = (existingMetadata ?? {}) as Partial<ManagedBlockMetadata>;

  const metadata: ManagedBlockMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: now,
    // Preserve existing fields that shouldn't change
    ...(existing.adopted_at && { adopted_at: existing.adopted_at }),
    ...(existing.original_label && { original_label: existing.original_label }),
  };

  // Update conditional fields
  if (entry.org) {
    metadata.org = entry.org;
  }
  if (entry.project) {
    metadata.project = entry.project;
  }
  if (entry.description) {
    metadata.description = entry.description;
  }
  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }
  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  return metadata;
}

/**
 * Update an existing managed block
 * 
 * @param client - Letta API client
 * @param blockId - ID of the block to update
 * @param entry - Manifest entry with desired state
 * @param existingBlock - Current block state
 * @param options - Update options
 * @returns Updated block response
 * @throws Error if block is not managed by smarty-admin
 */
export async function updateManagedBlock(
  client: LettaClient,
  blockId: string,
  entry: BlockManifestEntry,
  existingBlock: BlockResponse,
  options: UpdateBlockOptions = {}
): Promise<BlockResponse> {
  // Verify the block is managed
  const info = parseBlockManagement(existingBlock);
  if (!info.isManaged) {
    throw new Error(
      `Block ${blockId} (${existingBlock.label}) is not managed by smarty-admin. ` +
      `Use adopt flow to bring it under management.`
    );
  }

  // Build updated metadata
  const metadata = buildUpdatedMetadata(
    existingBlock.metadata,
    entry,
    options
  );

  // Build update request
  const request: UpdateBlockRequest = {
    metadata: metadata as unknown as Record<string, unknown>,
  };

  // Only include fields that changed
  if (entry.value !== existingBlock.value) {
    request.value = entry.value;
  }

  const entryDescription = entry.description ?? undefined;
  if (entryDescription !== existingBlock.description) {
    request.description = entryDescription;
  }

  if (entry.limit !== undefined && entry.limit !== existingBlock.limit) {
    request.limit = entry.limit;
  }

  // Apply update
  const updatedBlock = await client.blocks.update(blockId, request);

  return updatedBlock;
}

/**
 * Adopt an existing unmanaged block into reconciler management
 * 
 * This adds management metadata without changing the block's content.
 * 
 * @param client - Letta API client
 * @param blockId - ID of the block to adopt
 * @param entry - Manifest entry defining the management scope
 * @param existingBlock - Current block state
 * @param options - Update options
 * @returns Adopted block response
 */
export async function adoptBlock(
  client: LettaClient,
  blockId: string,
  entry: BlockManifestEntry,
  existingBlock: BlockResponse,
  options: UpdateBlockOptions = {}
): Promise<BlockResponse> {
  const now = new Date().toISOString();

  // Build adoption metadata
  const metadata: ManagedBlockMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: now,
    adopted_at: now,
    original_label: existingBlock.label,
  };

  // Add conditional fields
  if (entry.org) {
    metadata.org = entry.org;
  }
  if (entry.project) {
    metadata.project = entry.project;
  }
  if (entry.description) {
    metadata.description = entry.description;
  }
  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }
  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  // Merge with any existing metadata (preserve user fields)
  const mergedMetadata = {
    ...(existingBlock.metadata ?? {}),
    ...metadata,
  };

  // Update block with adoption metadata
  const request: UpdateBlockRequest = {
    metadata: mergedMetadata,
  };

  // If the manifest has a different value, update it
  if (entry.value !== existingBlock.value) {
    request.value = entry.value;
  }

  const adoptedBlock = await client.blocks.update(blockId, request);

  return adoptedBlock;
}

/**
 * Truncate a string for display in diffs
 * 
 * @param value - String to truncate
 * @param maxLength - Maximum length (default 100)
 * @returns Truncated string with ellipsis if needed
 */
function truncateForDisplay(value: string, maxLength: number = 100): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength) + '...';
}
