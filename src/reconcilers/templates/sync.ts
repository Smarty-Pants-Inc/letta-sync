/**
 * Template sync logic
 *
 * Handles creation, update, deletion, and promotion of templates via
 * the Letta internal templates API.
 *
 * Based on: docs/research/letta-api-reference.md (Section 8: Templates)
 */

import type { LettaClient } from '../../api/client.js';
import type {
  TemplateEntityType,
  TemplateEnvironment,
  ManagedTemplateMetadata,
  BlockTemplateManifestEntry,
  BlockTemplateResponse,
  AgentTemplateManifestEntry,
  GroupTemplateManifestEntry,
  DeploymentEntity,
  ListDeploymentEntitiesResponse,
  DeleteDeploymentResponse,
  TemplateManifest,
  TemplateReconcilePlan,
  TemplatePlanAction,
  TemplateApplyOptions,
  TemplateApplyResult,
  TemplateApplyActionResult,
  TemplatePromotionRequest,
  TemplatePromotionResult,
} from './types.js';
import {
  diffBlockTemplates,
  parseTemplateManagement,
  isTemplateManaged,
  type TemplateDiffOptions,
  type TemplateDiffResult,
} from './diff.js';

// =============================================================================
// Internal Templates API Client Extension
// =============================================================================

/**
 * Create block template request body for internal API
 */
interface InternalTemplateBlockCreate {
  label: string;
  value: string;
  limit?: number;
  description?: string;
  metadata?: Record<string, unknown>;
  template_name?: string;
  is_template?: boolean;
  deployment_id: string;
  entity_id?: string;
  project_id?: string;
}

/**
 * Create agent template request body for internal API
 */
interface InternalTemplateAgentCreate {
  name: string;
  description?: string;
  deployment_id: string;
  entity_id?: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
  ignore_invalid_tools?: boolean;
}

/**
 * Create group template request body for internal API
 */
interface InternalTemplateGroupCreate {
  name: string;
  description?: string;
  deployment_id: string;
  entity_id?: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Metadata Building
// =============================================================================

/**
 * Build managed template metadata for a block template
 */
export function buildBlockTemplateMetadata(
  entry: BlockTemplateManifestEntry,
  options: { packageVersion?: string } = {}
): ManagedTemplateMetadata {
  const now = new Date().toISOString();

  const metadata: ManagedTemplateMetadata = {
    managed_by: 'smarty-admin',
    entity_type: 'block',
    deployment_id: entry.deploymentId,
    last_synced: now,
  };

  if (entry.entityId) {
    metadata.entity_id = entry.entityId;
  }
  if (entry.projectId) {
    metadata.project_id = entry.projectId;
  }
  if (entry.version) {
    metadata.version = entry.version;
  }
  if (entry.environment) {
    metadata.environment = entry.environment;
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
 * Build managed template metadata for an agent template
 */
export function buildAgentTemplateMetadata(
  entry: AgentTemplateManifestEntry,
  options: { packageVersion?: string } = {}
): ManagedTemplateMetadata {
  const now = new Date().toISOString();

  const metadata: ManagedTemplateMetadata = {
    managed_by: 'smarty-admin',
    entity_type: 'agent',
    deployment_id: entry.deploymentId,
    last_synced: now,
  };

  if (entry.entityId) {
    metadata.entity_id = entry.entityId;
  }
  if (entry.projectId) {
    metadata.project_id = entry.projectId;
  }
  if (entry.version) {
    metadata.version = entry.version;
  }
  if (entry.environment) {
    metadata.environment = entry.environment;
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
 * Build managed template metadata for a group template
 */
export function buildGroupTemplateMetadata(
  entry: GroupTemplateManifestEntry,
  options: { packageVersion?: string } = {}
): ManagedTemplateMetadata {
  const now = new Date().toISOString();

  const metadata: ManagedTemplateMetadata = {
    managed_by: 'smarty-admin',
    entity_type: 'group',
    deployment_id: entry.deploymentId,
    last_synced: now,
  };

  if (entry.entityId) {
    metadata.entity_id = entry.entityId;
  }
  if (entry.projectId) {
    metadata.project_id = entry.projectId;
  }
  if (entry.version) {
    metadata.version = entry.version;
  }
  if (entry.environment) {
    metadata.environment = entry.environment;
  }
  if (entry.sourcePath) {
    metadata.source_path = entry.sourcePath;
  }
  if (options.packageVersion) {
    metadata.package_version = options.packageVersion;
  }

  return metadata;
}

// =============================================================================
// Block Template Operations
// =============================================================================

/**
 * Create a new block template via internal API
 */
export async function createBlockTemplate(
  client: LettaClient,
  entry: BlockTemplateManifestEntry,
  options: { packageVersion?: string } = {}
): Promise<BlockTemplateResponse> {
  const metadata = buildBlockTemplateMetadata(entry, options);

  // Use the standard blocks API with is_template flag
  // The internal API (_internal_templates/blocks) adds deployment_id support
  const response = await client.blocks.create({
    label: entry.label,
    value: entry.value,
    limit: entry.limit,
    description: entry.description,
    templateName: entry.templateName,
    isTemplate: true,
    metadata: {
      ...metadata,
      deployment_id: entry.deploymentId,
      entity_id: entry.entityId,
      project_id: entry.projectId,
    } as Record<string, unknown>,
  });

  return response as BlockTemplateResponse;
}

/**
 * Update an existing block template
 */
export async function updateBlockTemplate(
  client: LettaClient,
  templateId: string,
  entry: BlockTemplateManifestEntry,
  existingTemplate: BlockTemplateResponse,
  options: { packageVersion?: string } = {}
): Promise<BlockTemplateResponse> {
  // Verify the template is managed
  const info = parseTemplateManagement(existingTemplate);
  if (!info.isManaged) {
    throw new Error(
      `Block template ${templateId} (${entry.templateName}) is not managed by smarty-admin.`
    );
  }

  const metadata = buildBlockTemplateMetadata(entry, options);

  // Preserve existing metadata fields that shouldn't change
  const existingMetadata =
    (existingTemplate.metadata as unknown as ManagedTemplateMetadata) ?? {};
  const mergedMetadata: Record<string, unknown> = {
    ...existingMetadata,
    ...metadata,
  };

  const response = await client.blocks.update(templateId, {
    value: entry.value,
    description: entry.description,
    limit: entry.limit,
    metadata: mergedMetadata,
  });

  return response as BlockTemplateResponse;
}

/**
 * Delete a block template
 */
export async function deleteBlockTemplate(
  client: LettaClient,
  templateId: string
): Promise<void> {
  await client.blocks.delete(templateId);
}

// =============================================================================
// Deployment Operations
// =============================================================================

/**
 * List all entities in a deployment
 *
 * Note: This uses the internal templates API endpoint
 * GET /v1/_internal_templates/deployment/{deployment_id}
 */
export async function listDeploymentEntities(
  client: LettaClient,
  deploymentId: string,
  entityTypes?: TemplateEntityType[]
): Promise<ListDeploymentEntitiesResponse> {
  // Since the internal API isn't exposed via the standard client,
  // we need to use a custom request or fall back to filtering blocks
  // For now, we'll use the blocks API with templates_only filter
  // and filter by deployment_id in metadata

  const blocks = await client.blocks.list({
    templatesOnly: true,
    limit: 100,
  });

  const entities: DeploymentEntity[] = [];

  for (const block of blocks) {
    const metadata = block.metadata as ManagedTemplateMetadata | undefined;
    if (metadata?.deployment_id === deploymentId) {
      if (!entityTypes || entityTypes.includes('block')) {
        entities.push({
          id: block.id,
          type: 'block',
          name: block.templateName ?? block.label,
          description: block.description,
          entity_id: metadata.entity_id,
          project_id: metadata.project_id,
        });
      }
    }
  }

  return {
    entities,
    total_count: entities.length,
    deployment_id: deploymentId,
    message: `Found ${entities.length} entities in deployment ${deploymentId}`,
  };
}

/**
 * Delete all entities in a deployment
 *
 * Note: This uses the internal templates API endpoint
 * DELETE /v1/_internal_templates/deployment/{deployment_id}
 */
export async function deleteDeployment(
  client: LettaClient,
  deploymentId: string
): Promise<DeleteDeploymentResponse> {
  // List all entities in the deployment
  const { entities } = await listDeploymentEntities(client, deploymentId);

  const deletedBlocks: string[] = [];
  const deletedAgents: string[] = [];
  const deletedGroups: string[] = [];

  // Delete in order: blocks -> agents -> groups (for referential integrity)
  // First: blocks
  for (const entity of entities.filter((e) => e.type === 'block')) {
    try {
      await deleteBlockTemplate(client, entity.id);
      deletedBlocks.push(entity.id);
    } catch (error) {
      // Log error but continue deletion
      console.error(`Failed to delete block ${entity.id}:`, error);
    }
  }

  // Future: Delete agents and groups when those operations are implemented

  return {
    deleted_blocks: deletedBlocks,
    deleted_agents: deletedAgents,
    deleted_groups: deletedGroups,
    message: `Deleted ${deletedBlocks.length} blocks, ${deletedAgents.length} agents, ${deletedGroups.length} groups from deployment ${deploymentId}`,
  };
}

// =============================================================================
// Reconciliation Logic
// =============================================================================

/**
 * List all template blocks that might be managed
 */
async function listManagedTemplateBlocks(
  client: LettaClient,
  deploymentId?: string
): Promise<BlockTemplateResponse[]> {
  const blocks = await client.blocks.list({
    templatesOnly: true,
    limit: 100,
  });

  // Filter by deployment ID if specified
  if (deploymentId) {
    return blocks.filter((block) => {
      const metadata = block.metadata as ManagedTemplateMetadata | undefined;
      return metadata?.deployment_id === deploymentId;
    }) as BlockTemplateResponse[];
  }

  return blocks as BlockTemplateResponse[];
}

/**
 * Build a reconciliation plan for templates
 */
export async function buildTemplateReconcilePlan(
  client: LettaClient,
  manifest: TemplateManifest,
  options: TemplateApplyOptions
): Promise<TemplateReconcilePlan> {
  const plan: TemplateReconcilePlan = {
    creates: [],
    updates: [],
    deletes: [],
    skipped: [],
    promotes: [],
    summary: {
      toCreate: 0,
      toUpdate: 0,
      toDelete: 0,
      toPromote: 0,
      unchanged: 0,
      total: 0,
    },
  };

  // Get existing template blocks
  const existingBlocks = await listManagedTemplateBlocks(
    client,
    manifest.deploymentId
  );

  // Diff block templates
  const blockDiff = diffBlockTemplates(manifest.blocks, existingBlocks, {
    includeOrphans: options.allowDelete,
    deploymentId: manifest.deploymentId,
    environment: options.environment ?? manifest.environment,
    packageVersion: options.packageVersion,
  });

  // Merge block diff into plan
  plan.creates.push(...blockDiff.creates);
  plan.updates.push(...blockDiff.updates);
  if (options.allowDelete) {
    plan.deletes.push(...blockDiff.deletes);
  } else {
    plan.skipped.push(...blockDiff.deletes.map((d) => ({ ...d, type: 'skip' as const, reason: 'Orphaned - use --allow-delete to remove' })));
  }
  plan.skipped.push(...blockDiff.skipped);
  plan.promotes.push(...blockDiff.promotes);

  // Future: Add agent and group diffing when those operations are implemented

  // Update summary
  plan.summary = {
    toCreate: plan.creates.length,
    toUpdate: plan.updates.length,
    toDelete: plan.deletes.length,
    toPromote: plan.promotes.length,
    unchanged: plan.skipped.length,
    total:
      plan.creates.length +
      plan.updates.length +
      plan.deletes.length +
      plan.skipped.length +
      plan.promotes.length,
  };

  return plan;
}

/**
 * Execute a single plan action
 */
async function executeTemplateAction(
  client: LettaClient,
  action: TemplatePlanAction,
  manifestByName: Map<string, BlockTemplateManifestEntry>,
  existingByName: Map<string, BlockTemplateResponse>,
  options: TemplateApplyOptions
): Promise<TemplateApplyActionResult> {
  try {
    switch (action.type) {
      case 'create': {
        if (action.entityType !== 'block') {
          throw new Error(`Create not implemented for ${action.entityType}`);
        }
        const entry = manifestByName.get(action.name);
        if (!entry) {
          throw new Error(`No manifest entry for template: ${action.name}`);
        }
        const template = await createBlockTemplate(client, entry, {
          packageVersion: options.packageVersion,
        });
        return {
          action,
          success: true,
          templateId: template.id,
        };
      }

      case 'update': {
        if (action.entityType !== 'block') {
          throw new Error(`Update not implemented for ${action.entityType}`);
        }
        const entry = manifestByName.get(action.name);
        const existing = existingByName.get(action.name);
        if (!entry || !existing || !action.templateId) {
          throw new Error(
            `Missing entry, existing template, or templateId for update`
          );
        }
        const template = await updateBlockTemplate(
          client,
          action.templateId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          templateId: template.id,
        };
      }

      case 'delete': {
        if (action.entityType !== 'block') {
          throw new Error(`Delete not implemented for ${action.entityType}`);
        }
        if (!action.templateId) {
          throw new Error(`Missing templateId for delete`);
        }
        await deleteBlockTemplate(client, action.templateId);
        return {
          action,
          success: true,
          templateId: action.templateId,
        };
      }

      case 'skip':
        return {
          action,
          success: true,
          templateId: action.templateId,
        };

      case 'promote':
        // Promotion is handled separately
        return {
          action,
          success: false,
          error: 'Promotion must be executed via promoteTemplates()',
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
 * Apply the template reconciliation plan
 */
export async function applyTemplateReconciliation(
  client: LettaClient,
  manifest: TemplateManifest,
  options: TemplateApplyOptions
): Promise<TemplateApplyResult> {
  // Build the plan
  const plan = await buildTemplateReconcilePlan(client, manifest, options);

  // If dry-run, return the plan as a result without executing
  if (options.dryRun) {
    return {
      results: [
        ...plan.creates.map((a) => ({ action: a, success: true })),
        ...plan.updates.map((a) => ({ action: a, success: true })),
        ...plan.deletes.map((a) => ({ action: a, success: true })),
        ...plan.skipped.map((a) => ({ action: a, success: true })),
        ...plan.promotes.map((a) => ({ action: a, success: true })),
      ],
      summary: {
        created: plan.summary.toCreate,
        updated: plan.summary.toUpdate,
        deleted: plan.summary.toDelete,
        promoted: plan.summary.toPromote,
        failed: 0,
        skipped: plan.summary.unchanged,
      },
      errors: [],
      success: true,
    };
  }

  // Index manifest by template name
  const manifestByName = new Map<string, BlockTemplateManifestEntry>();
  for (const entry of manifest.blocks) {
    manifestByName.set(entry.templateName, entry);
  }

  // Get existing templates
  const existingBlocks = await listManagedTemplateBlocks(
    client,
    manifest.deploymentId
  );
  const existingByName = new Map<string, BlockTemplateResponse>();
  for (const block of existingBlocks) {
    const name = block.template_name ?? block.label;
    existingByName.set(name, block);
  }

  // Execute all actions
  const results: TemplateApplyActionResult[] = [];
  const errors: string[] = [];

  // Execute creates
  for (const action of plan.creates) {
    const result = await executeTemplateAction(
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

  // Execute updates
  for (const action of plan.updates) {
    const result = await executeTemplateAction(
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
    const result = await executeTemplateAction(
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
      templateId: action.templateId,
    });
  }

  // Calculate summary
  const summary = {
    created: results.filter((r) => r.success && r.action.type === 'create')
      .length,
    updated: results.filter((r) => r.success && r.action.type === 'update')
      .length,
    deleted: results.filter((r) => r.success && r.action.type === 'delete')
      .length,
    promoted: results.filter((r) => r.success && r.action.type === 'promote')
      .length,
    failed: results.filter((r) => !r.success).length,
    skipped: results.filter((r) => r.success && r.action.type === 'skip')
      .length,
  };

  return {
    results,
    summary,
    errors,
    success: errors.length === 0,
  };
}

/**
 * Get the template reconciliation plan without applying changes
 */
export async function getTemplateReconcilePlan(
  client: LettaClient,
  manifest: TemplateManifest,
  options: Omit<TemplateApplyOptions, 'dryRun'> = {}
): Promise<TemplateReconcilePlan> {
  return buildTemplateReconcilePlan(client, manifest, { ...options, dryRun: true });
}

// =============================================================================
// Version Promotion
// =============================================================================

/**
 * Environment promotion order
 */
const ENVIRONMENT_ORDER: TemplateEnvironment[] = ['dev', 'staging', 'production'];

/**
 * Validate that a promotion is valid (can only promote forward)
 */
function validatePromotion(
  from: TemplateEnvironment,
  to: TemplateEnvironment
): void {
  const fromIndex = ENVIRONMENT_ORDER.indexOf(from);
  const toIndex = ENVIRONMENT_ORDER.indexOf(to);

  if (fromIndex === -1 || toIndex === -1) {
    throw new Error(`Invalid environment: ${from} or ${to}`);
  }

  if (toIndex <= fromIndex) {
    throw new Error(
      `Cannot promote from ${from} to ${to}. Promotion must move forward (dev -> staging -> production).`
    );
  }

  if (toIndex - fromIndex > 1) {
    throw new Error(
      `Cannot skip environments. Promote from ${from} to ${ENVIRONMENT_ORDER[fromIndex + 1]} first.`
    );
  }
}

/**
 * Promote templates from one environment to another
 */
export async function promoteTemplates(
  client: LettaClient,
  request: TemplatePromotionRequest
): Promise<TemplatePromotionResult> {
  // Validate the promotion
  validatePromotion(request.fromEnvironment, request.toEnvironment);

  const promotedEntities: TemplatePromotionResult['promotedEntities'] = [];
  const errors: string[] = [];

  // Get all entities in the deployment from the source environment
  const { entities } = await listDeploymentEntities(
    client,
    request.deploymentId,
    request.entityTypes
  );

  // Filter to source environment
  const sourceEntities = entities.filter((entity) => {
    // We need to check the entity's metadata for environment
    // This requires fetching the full entity
    return true; // For now, promote all entities in the deployment
  });

  const now = new Date().toISOString();

  // Promote each entity
  for (const entity of sourceEntities) {
    try {
      if (entity.type === 'block') {
        const block = await client.blocks.retrieve(entity.id);
        const existingMetadata =
          (block.metadata as unknown as ManagedTemplateMetadata) ?? {};

        // Update metadata with promotion info
        const promotedMetadata: Record<string, unknown> = {
          ...existingMetadata,
          environment: request.toEnvironment,
          promoted_at: now,
          promoted_from: request.fromEnvironment,
          last_synced: now,
        };

        if (request.version) {
          promotedMetadata.version = request.version;
        }

        await client.blocks.update(entity.id, {
          metadata: promotedMetadata,
        });

        promotedEntities.push({
          type: entity.type,
          id: entity.id,
          name: entity.name ?? entity.id,
        });
      }
      // Future: Handle agent and group promotion
    } catch (error) {
      errors.push(
        `Failed to promote ${entity.type} ${entity.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return {
    success: errors.length === 0,
    promotedEntities,
    errors,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Load a template manifest from a file path
 * This is a placeholder - actual implementation depends on file format
 */
export function parseTemplateManifest(
  content: string,
  format: 'json' | 'yaml' = 'json'
): TemplateManifest {
  if (format === 'json') {
    const parsed = JSON.parse(content);
    return {
      deploymentId: parsed.deploymentId ?? parsed.deployment_id,
      projectId: parsed.projectId ?? parsed.project_id,
      environment: parsed.environment,
      version: parsed.version,
      blocks: (parsed.blocks ?? []).map((b: Record<string, unknown>) => ({
        templateName: b.templateName ?? b.template_name,
        label: b.label,
        value: b.value,
        limit: b.limit,
        description: b.description,
        deploymentId: b.deploymentId ?? b.deployment_id ?? parsed.deploymentId ?? parsed.deployment_id,
        entityId: b.entityId ?? b.entity_id,
        projectId: b.projectId ?? b.project_id ?? parsed.projectId ?? parsed.project_id,
        version: b.version ?? parsed.version,
        environment: b.environment ?? parsed.environment,
        sourcePath: b.sourcePath ?? b.source_path,
      })),
      agents: parsed.agents ?? [],
      groups: parsed.groups ?? [],
    };
  }

  // YAML support would require a YAML parser
  throw new Error('YAML format not yet implemented. Use JSON format.');
}

/**
 * Validate a template manifest
 */
export function validateTemplateManifest(
  manifest: TemplateManifest
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!manifest.deploymentId) {
    errors.push('deploymentId is required');
  }

  // Validate block templates
  for (const block of manifest.blocks) {
    if (!block.templateName) {
      errors.push(`Block template missing templateName`);
    }
    if (!block.label) {
      errors.push(`Block template ${block.templateName} missing label`);
    }
    if (!block.value) {
      errors.push(`Block template ${block.templateName} missing value`);
    }
  }

  // Validate unique template names
  const names = new Set<string>();
  for (const block of manifest.blocks) {
    if (names.has(block.templateName)) {
      errors.push(`Duplicate template name: ${block.templateName}`);
    }
    names.add(block.templateName);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
