/**
 * Tool reconciliation apply/upsert logic
 *
 * This module implements the core reconciliation logic for tools:
 * 1. Create missing tools with proper metadata/tags
 * 2. Update existing tools (sourceCode, description, schema)
 * 3. Never delete unmanaged tools
 * 4. Deletions require explicit --allow-delete flag
 * 5. Attach/detach tools to agents
 *
 * Supports dry-run mode to preview changes without applying them.
 */

import type { LettaClient, ToolsClient } from '../../api/client.js';
import type { Tool, CreateToolRequest } from '../../api/types.js';
import type { Layer } from '../../registry/types.js';
import type {
  ToolManifestEntry,
  ManagedToolMetadata,
  ApplyOptions,
  ApplyResult,
  ApplyActionResult,
  ReconcilePlan,
  PlanAction,
  ToolClassification,
  AttachToolOptions,
  AttachToolResult,
} from './types.js';
import { ToolOwnership } from './types.js';
import {
  parseToolManagement,
  isToolManaged,
  extractManagedMetadata,
  classifyToolOwnership,
} from './diff.js';

/**
 * Options for creating a managed tool
 */
export interface CreateToolOptions {
  /** Package version (git SHA) to stamp on the tool */
  packageVersion?: string;
}

/**
 * Options for updating a managed tool
 */
export interface UpdateToolOptions {
  /** Package version (git SHA) to stamp on the tool */
  packageVersion?: string;
  /** Whether to force update even if values match */
  force?: boolean;
}

/**
 * Result of comparing tool fields
 */
export interface ToolDiff {
  hasChanges: boolean;
  changes: {
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
}

/**
 * Build management tags for a tool
 */
export function buildManagedTags(
  entry: ToolManifestEntry,
  options: CreateToolOptions = {}
): string[] {
  const now = new Date().toISOString();
  const tags: string[] = [
    'managed_by:smarty-admin',
    `layer:${entry.layer}`,
    `last_synced:${now}`,
  ];

  if (entry.org) {
    tags.push(`org:${entry.org}`);
  }
  if (entry.project) {
    tags.push(`project:${entry.project}`);
  }
  if (options.packageVersion) {
    tags.push(`package_version:${options.packageVersion}`);
  }

  // Merge with user-defined tags (excluding management tags)
  const userTags = entry.tags?.filter(t =>
    !t.startsWith('managed_by:') &&
    !t.startsWith('layer:') &&
    !t.startsWith('last_synced:') &&
    !t.startsWith('org:') &&
    !t.startsWith('project:') &&
    !t.startsWith('package_version:')
  ) ?? [];

  return [...tags, ...userTags];
}

/**
 * Create a new managed tool in Letta
 */
export async function createManagedTool(
  client: LettaClient,
  entry: ToolManifestEntry,
  options: CreateToolOptions = {}
): Promise<Tool> {
  const tags = buildManagedTags(entry, options);

  const request: CreateToolRequest = {
    name: entry.name,
    sourceType: entry.sourceType,
    sourceCode: entry.sourceCode,
    jsonSchema: entry.jsonSchema,
    description: entry.description,
    tags,
    toolType: entry.toolType,
  };

  const tool = await client.tools.create(request);
  return tool;
}

/**
 * Compare a manifest entry with an existing tool to find differences
 */
export function compareToolWithManifest(
  entry: ToolManifestEntry,
  tool: Tool
): ToolDiff {
  const changes: ToolDiff['changes'] = [];

  // Compare source code
  if (entry.sourceCode !== tool.sourceCode) {
    changes.push({
      field: 'sourceCode',
      oldValue: truncateForDisplay(tool.sourceCode ?? ''),
      newValue: truncateForDisplay(entry.sourceCode),
    });
  }

  // Compare description
  const entryDescription = entry.description ?? undefined;
  const toolDescription = tool.description ?? undefined;
  if (entryDescription !== toolDescription) {
    changes.push({
      field: 'description',
      oldValue: toolDescription,
      newValue: entryDescription,
    });
  }

  // Compare JSON schema
  const entrySchema = JSON.stringify(entry.jsonSchema);
  const toolSchema = JSON.stringify(tool.jsonSchema);
  if (entrySchema !== toolSchema) {
    changes.push({
      field: 'jsonSchema',
      oldValue: tool.jsonSchema,
      newValue: entry.jsonSchema,
    });
  }

  return {
    hasChanges: changes.length > 0,
    changes,
  };
}

/**
 * Build updated tags preserving existing fields
 */
export function buildUpdatedTags(
  existingTags: string[] | undefined,
  entry: ToolManifestEntry,
  options: UpdateToolOptions = {}
): string[] {
  const now = new Date().toISOString();

  // Start with new management tags
  const managementTags: string[] = [
    'managed_by:smarty-admin',
    `layer:${entry.layer}`,
    `last_synced:${now}`,
  ];

  if (entry.org) {
    managementTags.push(`org:${entry.org}`);
  }
  if (entry.project) {
    managementTags.push(`project:${entry.project}`);
  }
  if (options.packageVersion) {
    managementTags.push(`package_version:${options.packageVersion}`);
  }

  // Filter out old management tags from existing tags
  const preservedTags = (existingTags ?? []).filter(t =>
    !t.startsWith('managed_by:') &&
    !t.startsWith('layer:') &&
    !t.startsWith('last_synced:') &&
    !t.startsWith('org:') &&
    !t.startsWith('project:') &&
    !t.startsWith('package_version:')
  );

  // Merge with user-defined tags from entry
  const userTags = entry.tags?.filter(t =>
    !t.startsWith('managed_by:') &&
    !t.startsWith('layer:')
  ) ?? [];

  // Combine: management + preserved + user (deduplicated)
  const allTags = [...managementTags, ...preservedTags, ...userTags];
  return [...new Set(allTags)];
}

/**
 * Update an existing managed tool
 */
export async function updateManagedTool(
  client: LettaClient,
  toolId: string,
  entry: ToolManifestEntry,
  existingTool: Tool,
  options: UpdateToolOptions = {}
): Promise<Tool> {
  // Verify the tool is managed (or being adopted)
  const info = parseToolManagement(existingTool);
  if (!info.isManaged && !options.force) {
    throw new Error(
      `Tool ${toolId} (${existingTool.name}) is not managed by smarty-admin. ` +
      `Use adopt flow to bring it under management.`
    );
  }

  // Build updated tags
  const tags = buildUpdatedTags(existingTool.tags, entry, options);

  // Build update request - only include changed fields
  const updateFields: Record<string, unknown> = {
    tags,
  };

  if (entry.sourceCode !== existingTool.sourceCode) {
    updateFields.sourceCode = entry.sourceCode;
  }

  if ((entry.description ?? undefined) !== existingTool.description) {
    updateFields.description = entry.description;
  }

  const entrySchema = JSON.stringify(entry.jsonSchema);
  const toolSchema = JSON.stringify(existingTool.jsonSchema);
  if (entrySchema !== toolSchema) {
    updateFields.jsonSchema = entry.jsonSchema;
  }

  // Apply update
  const updatedTool = await client.tools.update(toolId, updateFields);
  return updatedTool;
}

/**
 * Adopt an existing unmanaged tool into reconciler management
 */
export async function adoptTool(
  client: LettaClient,
  toolId: string,
  entry: ToolManifestEntry,
  existingTool: Tool,
  options: UpdateToolOptions = {}
): Promise<Tool> {
  const now = new Date().toISOString();

  // Build adoption tags
  const tags: string[] = [
    'managed_by:smarty-admin',
    `layer:${entry.layer}`,
    `last_synced:${now}`,
    `adopted_at:${now}`,
    `original_name:${existingTool.name}`,
  ];

  if (entry.org) {
    tags.push(`org:${entry.org}`);
  }
  if (entry.project) {
    tags.push(`project:${entry.project}`);
  }
  if (options.packageVersion) {
    tags.push(`package_version:${options.packageVersion}`);
  }

  // Preserve existing non-management tags
  const preservedTags = (existingTool.tags ?? []).filter(t =>
    !t.startsWith('managed_by:') &&
    !t.startsWith('layer:')
  );

  // Add user tags from entry
  const userTags = entry.tags?.filter(t =>
    !t.startsWith('managed_by:') &&
    !t.startsWith('layer:')
  ) ?? [];

  const allTags = [...tags, ...preservedTags, ...userTags];

  // Build update request
  const updateFields: Record<string, unknown> = {
    tags: [...new Set(allTags)],
  };

  // If the manifest has different content, update it
  if (entry.sourceCode !== existingTool.sourceCode) {
    updateFields.sourceCode = entry.sourceCode;
  }

  if ((entry.description ?? undefined) !== existingTool.description) {
    updateFields.description = entry.description;
  }

  const entrySchema = JSON.stringify(entry.jsonSchema);
  const toolSchema = JSON.stringify(existingTool.jsonSchema);
  if (entrySchema !== toolSchema) {
    updateFields.jsonSchema = entry.jsonSchema;
  }

  const adoptedTool = await client.tools.update(toolId, updateFields);
  return adoptedTool;
}

/**
 * Classify a tool's ownership status
 */
export function classifyTool(
  tool: Tool,
  manifestNames: Set<string>
): ToolClassification {
  const info = parseToolManagement(tool);

  // Has managed metadata
  if (info.isManaged) {
    // Check if still defined in manifests
    if (manifestNames.has(tool.name)) {
      return {
        ownership: ToolOwnership.MANAGED,
        info,
        reason: 'Tool has managed metadata and exists in Git manifest',
      };
    } else {
      return {
        ownership: ToolOwnership.ORPHANED,
        info,
        reason: 'Tool has managed metadata but not in Git manifest',
      };
    }
  }

  // No managed metadata
  else {
    if (manifestNames.has(tool.name)) {
      return {
        ownership: ToolOwnership.ADOPTED,
        info: undefined,
        reason: 'Tool exists in manifest but lacks management metadata - needs adoption',
      };
    } else {
      return {
        ownership: ToolOwnership.UNMANAGED,
        info: undefined,
        reason: "No managed metadata and not in manifest",
      };
    }
  }
}

/**
 * List all tools that might be managed
 */
async function listManagedCandidates(
  client: LettaClient,
  manifestNames: Set<string>
): Promise<Tool[]> {
  const allTools: Tool[] = [];
  const seenIds = new Set<string>();

  // Search for tools with management tag
  const managedTools = await client.tools.list({
    search: 'managed_by:smarty-admin',
    limit: 100,
  });

  for (const tool of managedTools) {
    if (!seenIds.has(tool.id)) {
      seenIds.add(tool.id);
      allTools.push(tool);
    }
  }

  // Also search for tools by name from manifest
  for (const name of manifestNames) {
    const tools = await client.tools.list({
      name,
      limit: 10,
    });

    for (const tool of tools) {
      if (!seenIds.has(tool.id)) {
        seenIds.add(tool.id);
        allTools.push(tool);
      }
    }
  }

  return allTools;
}

/**
 * Build a reconciliation plan comparing manifest with remote state
 */
export async function buildReconcilePlan(
  client: LettaClient,
  manifest: ToolManifestEntry[],
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
  const manifestByName = new Map<string, ToolManifestEntry>();
  const manifestNames = new Set<string>();
  for (const entry of manifest) {
    manifestByName.set(entry.name, entry);
    manifestNames.add(entry.name);
  }

  // Fetch existing tools that might be managed
  const existingTools = await listManagedCandidates(client, manifestNames);

  // Index existing tools by name
  const existingByName = new Map<string, Tool>();
  for (const tool of existingTools) {
    existingByName.set(tool.name, tool);
  }

  // Process each manifest entry
  for (const entry of manifest) {
    const existing = existingByName.get(entry.name);

    if (!existing) {
      // Tool doesn't exist - needs to be created
      plan.creates.push({
        type: 'create',
        name: entry.name,
        reason: 'Tool does not exist in Letta',
        changes: [
          { field: 'sourceCode', newValue: truncate(entry.sourceCode) },
          { field: 'sourceType', newValue: entry.sourceType },
          { field: 'layer', newValue: entry.layer },
          ...(entry.description ? [{ field: 'description', newValue: entry.description }] : []),
        ],
      });
      plan.summary.toCreate++;
    } else {
      // Tool exists - check if it needs updating
      const classification = classifyTool(existing, manifestNames);

      if (classification.ownership === ToolOwnership.UNMANAGED) {
        // Tool exists but is not managed and not adoptable - skip
        plan.skipped.push({
          type: 'skip',
          name: entry.name,
          toolId: existing.id,
          reason: 'Tool exists but is not managed - skipping to avoid overwriting user data',
        });
        plan.summary.unchanged++;
      } else if (classification.ownership === ToolOwnership.ADOPTED) {
        // Tool exists with matching name but no metadata - needs adoption
        const diff = compareToolWithManifest(entry, existing);
        plan.updates.push({
          type: 'adopt',
          name: entry.name,
          toolId: existing.id,
          reason: 'Tool matches manifest name but lacks management metadata - will adopt',
          changes: [
            { field: 'tags', oldValue: '(none)', newValue: 'managed_by:smarty-admin' },
            ...diff.changes,
          ],
        });
        plan.summary.toUpdate++;
      } else {
        // Tool is managed - check for changes
        const diff = compareToolWithManifest(entry, existing);

        if (diff.hasChanges || options.packageVersion !== classification.info?.packageVersion) {
          plan.updates.push({
            type: 'update',
            name: entry.name,
            toolId: existing.id,
            reason: diff.hasChanges
              ? 'Tool content has changed'
              : 'Package version needs update',
            changes: diff.changes,
          });
          plan.summary.toUpdate++;
        } else {
          // No changes needed
          plan.skipped.push({
            type: 'skip',
            name: entry.name,
            toolId: existing.id,
            reason: 'Tool is already in sync',
          });
          plan.summary.unchanged++;
        }
      }
    }
  }

  // Find orphaned tools (managed tools not in manifest)
  for (const tool of existingTools) {
    if (!manifestNames.has(tool.name)) {
      const classification = classifyTool(tool, manifestNames);

      if (classification.ownership === ToolOwnership.ORPHANED) {
        if (options.allowDelete) {
          plan.deletes.push({
            type: 'delete',
            name: tool.name,
            toolId: tool.id,
            reason: 'Tool was managed but is no longer in manifest',
          });
          plan.summary.toDelete++;
        } else {
          plan.skipped.push({
            type: 'skip',
            name: tool.name,
            toolId: tool.id,
            reason: 'Orphaned tool - use --allow-delete to remove',
          });
        }
      }
      // Unmanaged tools are completely ignored
    }
  }

  return plan;
}

/**
 * Execute a single plan action
 */
async function executeAction(
  client: LettaClient,
  action: PlanAction,
  manifest: Map<string, ToolManifestEntry>,
  existingTools: Map<string, Tool>,
  options: ApplyOptions
): Promise<ApplyActionResult> {
  try {
    const entry = manifest.get(action.name);
    const existing = existingTools.get(action.name);

    switch (action.type) {
      case 'create': {
        if (!entry) {
          throw new Error(`No manifest entry for name: ${action.name}`);
        }
        const tool = await createManagedTool(client, entry, {
          packageVersion: options.packageVersion,
        });
        return {
          action,
          success: true,
          toolId: tool.id,
        };
      }

      case 'update': {
        if (!entry || !existing || !action.toolId) {
          throw new Error(`Missing entry, existing tool, or toolId for update`);
        }
        const tool = await updateManagedTool(
          client,
          action.toolId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          toolId: tool.id,
        };
      }

      case 'adopt': {
        if (!entry || !existing || !action.toolId) {
          throw new Error(`Missing entry, existing tool, or toolId for adopt`);
        }
        const tool = await adoptTool(
          client,
          action.toolId,
          entry,
          existing,
          { packageVersion: options.packageVersion }
        );
        return {
          action,
          success: true,
          toolId: tool.id,
        };
      }

      case 'delete': {
        if (!action.toolId) {
          throw new Error(`Missing toolId for delete`);
        }
        await client.tools.delete(action.toolId);
        return {
          action,
          success: true,
          toolId: action.toolId,
        };
      }

      case 'skip':
        return {
          action,
          success: true,
          toolId: action.toolId,
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
 */
export async function applyToolReconciliation(
  client: LettaClient,
  manifest: ToolManifestEntry[],
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

  // Index manifest and existing tools for execution
  const manifestByName = new Map<string, ToolManifestEntry>();
  const manifestNames = new Set<string>();
  for (const entry of manifest) {
    manifestByName.set(entry.name, entry);
    manifestNames.add(entry.name);
  }

  const existingTools = await listManagedCandidates(client, manifestNames);
  const existingByName = new Map<string, Tool>();
  for (const tool of existingTools) {
    existingByName.set(tool.name, tool);
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
      toolId: action.toolId,
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
 */
export async function getReconcilePlan(
  client: LettaClient,
  manifest: ToolManifestEntry[],
  options: Omit<ApplyOptions, 'dryRun'> = {}
): Promise<ReconcilePlan> {
  return buildReconcilePlan(client, manifest, { ...options, dryRun: true });
}

/**
 * Extended agents client with tool attachment operations
 */
export interface AgentsClientWithTools {
  retrieve(agentId: string): Promise<{
    id: string;
    name: string;
    tools?: Array<{ id: string; name: string }>;
  }>;
  attachTool(agentId: string, toolId: string): Promise<void>;
  detachTool(agentId: string, toolId: string): Promise<void>;
}

/**
 * Extended client interface with agent-tool attachment operations
 */
export interface LettaAgentClient {
  readonly blocks: LettaClient['blocks'];
  readonly identities: LettaClient['identities'];
  readonly tools: LettaClient['tools'];
  readonly agents: AgentsClientWithTools;
  getConfig(): { baseUrl: string; project?: string; hasApiKey: boolean };
}

/**
 * Attach tools to an agent by name
 */
export async function attachToolsToAgent(
  client: LettaAgentClient,
  options: AttachToolOptions
): Promise<AttachToolResult> {
  const result: AttachToolResult = {
    agentId: options.agentId,
    attached: [],
    detached: [],
    unchanged: [],
    errors: [],
    success: true,
  };

  try {
    // Get current agent state
    const agent = await client.agents.retrieve(options.agentId);
    const currentToolIds = new Set(agent.tools?.map(t => t.id) ?? []);
    const currentToolNames = new Map(agent.tools?.map(t => [t.name, t.id]) ?? []);

    // Resolve tool names to IDs
    const desiredToolIds = new Map<string, string>();
    for (const name of options.toolNames) {
      const tools = await client.tools.list({ name, limit: 1 });
      if (tools.length > 0) {
        desiredToolIds.set(name, tools[0].id);
      } else {
        result.errors.push(`Tool not found: ${name}`);
        result.success = false;
      }
    }

    // Attach new tools
    for (const [name, toolId] of desiredToolIds) {
      if (currentToolIds.has(toolId)) {
        result.unchanged.push(name);
      } else {
        try {
          await client.agents.attachTool(options.agentId, toolId);
          result.attached.push(name);
        } catch (err) {
          result.errors.push(`Failed to attach ${name}: ${err instanceof Error ? err.message : String(err)}`);
          result.success = false;
        }
      }
    }

    // Detach tools not in the desired list (if requested)
    if (options.detachOthers) {
      const desiredIds = new Set(desiredToolIds.values());
      for (const [name, toolId] of currentToolNames) {
        if (!desiredIds.has(toolId)) {
          try {
            await client.agents.detachTool(options.agentId, toolId);
            result.detached.push(name);
          } catch (err) {
            result.errors.push(`Failed to detach ${name}: ${err instanceof Error ? err.message : String(err)}`);
            result.success = false;
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`Failed to process agent: ${err instanceof Error ? err.message : String(err)}`);
    result.success = false;
  }

  return result;
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

/**
 * Truncate a string for display in diffs
 */
function truncateForDisplay(value: string, maxLength: number = 100): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength) + '...';
}
