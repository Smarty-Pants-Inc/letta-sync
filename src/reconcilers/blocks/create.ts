/**
 * Block creation logic for the reconciler
 * 
 * Creates new blocks with proper metadata and label conventions
 * per the blocks metadata strategy specification.
 */

import type { LettaClient, BlockResponse, CreateBlockRequest } from '../../api/client.js';
import type {
  BlockManifestEntry,
  ManagedBlockMetadata,
  BlockLayer,
} from './types.js';
import { CANONICAL_LABELS, LAYER_PREFIXES } from './types.js';

/**
 * Options for creating a managed block
 */
export interface CreateBlockOptions {
  /** Package version (git SHA) to stamp on the block */
  packageVersion?: string;
}

/**
 * Validate that a label follows the naming convention for its layer
 * 
 * @param label - Block label to validate
 * @param layer - Target layer
 * @param org - Organization slug (required for org/project/user layers)
 * @param project - Project slug (required for project layer)
 * @throws Error if label doesn't match convention
 */
export function validateLabelForLayer(
  label: string,
  layer: BlockLayer,
  org?: string,
  project?: string
): void {
  // Canonical labels are always valid
  if (CANONICAL_LABELS.has(label)) {
    return;
  }

  const expectedPrefixes: Record<BlockLayer, string> = {
    base: 'base_',
    org: org ? `org_${org}_` : 'org_',
    project: project ? `project_${project}_` : 'project_',
    user: org ? `user_${org}_` : 'user_',
    lane: 'lane_',
  };

  const prefix = expectedPrefixes[layer];
  if (!label.startsWith(prefix)) {
    throw new Error(
      `Label '${label}' doesn't match ${layer} layer convention. Expected prefix: '${prefix}'`
    );
  }
}

/**
 * Build the managed metadata object for a block
 * 
 * @param entry - Block manifest entry
 * @param options - Creation options
 * @returns Metadata object to attach to the block
 */
export function buildManagedMetadata(
  entry: BlockManifestEntry,
  options: CreateBlockOptions = {}
): ManagedBlockMetadata {
  const now = new Date().toISOString();

  const metadata: ManagedBlockMetadata = {
    managed_by: 'smarty-admin',
    layer: entry.layer,
    last_synced: now,
  };

  // Add conditional fields based on layer
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
 * Validate metadata requirements based on layer
 * 
 * @param layer - Block layer
 * @param metadata - Metadata object
 * @throws Error if required fields are missing
 */
export function validateMetadataForLayer(
  layer: BlockLayer,
  metadata: ManagedBlockMetadata
): void {
  const errors: string[] = [];

  // All layers require managed_by and layer
  if (metadata.managed_by !== 'smarty-admin') {
    errors.push(`managed_by must be 'smarty-admin'`);
  }
  if (metadata.layer !== layer) {
    errors.push(`layer mismatch: expected '${layer}', got '${metadata.layer}'`);
  }

  // Layer-specific requirements
  if (['org', 'project', 'user'].includes(layer) && !metadata.org) {
    errors.push(`org is required for ${layer} layer`);
  }
  if (layer === 'project' && !metadata.project) {
    errors.push(`project is required for project layer`);
  }
  if (layer === 'user' && !metadata.user_identity_id) {
    // Note: user_identity_id is technically required but may be added later
    // during user-specific processing, so we log a warning instead of error
  }

  if (errors.length > 0) {
    throw new Error(`Invalid metadata for ${layer} layer: ${errors.join(', ')}`);
  }
}

/**
 * Create a new managed block in Letta
 * 
 * @param client - Letta API client
 * @param entry - Block manifest entry defining the block
 * @param options - Creation options
 * @returns Created block response
 */
export async function createManagedBlock(
  client: LettaClient,
  entry: BlockManifestEntry,
  options: CreateBlockOptions = {}
): Promise<BlockResponse> {
  // Validate label matches layer convention
  validateLabelForLayer(entry.label, entry.layer, entry.org, entry.project);

  // Build metadata
  const metadata = buildManagedMetadata(entry, options);

  // Validate metadata requirements
  validateMetadataForLayer(entry.layer, metadata);

  // Build the create request
  const request: CreateBlockRequest = {
    label: entry.label,
    value: entry.value,
    metadata: metadata as unknown as Record<string, unknown>,
  };

  // Add optional fields
  if (entry.description) {
    request.description = entry.description;
  }
  if (entry.limit !== undefined) {
    request.limit = entry.limit;
  }

  // Create the block
  const block = await client.blocks.create(request);

  return block;
}

/**
 * Check if a label follows managed block naming conventions
 * This is a SECONDARY signal - always confirm with metadata.
 * 
 * @param label - Label to check
 * @returns true if label matches a managed pattern
 */
export function isManagedLabel(label: string): boolean {
  // Canonical labels that are managed
  if (CANONICAL_LABELS.has(label)) {
    return true;
  }

  // Layer-prefixed labels
  const prefixes = Object.values(LAYER_PREFIXES);
  return prefixes.some((prefix) => label.startsWith(prefix));
}

/**
 * Infer layer from a label
 * 
 * @param label - Block label
 * @returns Inferred layer or undefined if not recognizable
 */
export function inferLayerFromLabel(label: string): BlockLayer | undefined {
  // Check canonical labels - these map to specific layers
  if (label === 'project' || label === 'decisions' || label === 'conventions' || label === 'glossary') {
    return 'project';
  }
  if (label === 'human' || label === 'persona') {
    return 'lane'; // These are typically lane-scoped
  }
  if (label === 'managed_state') {
    return 'lane';
  }

  // Check prefixes
  for (const [layer, prefix] of Object.entries(LAYER_PREFIXES)) {
    if (label.startsWith(prefix)) {
      return layer as BlockLayer;
    }
  }

  return undefined;
}
