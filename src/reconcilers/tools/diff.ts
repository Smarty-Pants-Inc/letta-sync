/**
 * Tool diff algorithm
 *
 * Compares desired tool state (from manifest/config) with actual tool state
 * (from Letta API) and generates a reconciliation plan.
 */

import type { Tool } from '../../api/types.js';
import type { Layer } from '../../registry/types.js';
import type {
  ToolManifestEntry,
  ManagedToolMetadata,
  ManagedToolInfo,
  ReconcilePlan,
  PlanAction,
  PlanActionType,
} from './types.js';

import { ToolOwnership } from './types.js';

/**
 * Options for the diff operation
 */
export interface ToolDiffOptions {
  /** Include orphaned tools in the diff */
  includeOrphans?: boolean;
  /** Include unmanaged tools in the diff (for reporting) */
  includeUnmanaged?: boolean;
  /** Only show tools with changes */
  changesOnly?: boolean;
  /** Filter by layer */
  layer?: Layer;
  /** Filter by specific names */
  names?: string[];
  /** Package version (git SHA) for change detection */
  packageVersion?: string;
}

/**
 * Types of drift that can occur between desired and actual state
 */
export type DriftType =
  | 'source_code'     // Tool source code differs
  | 'description'     // Tool description differs
  | 'json_schema'     // JSON schema differs
  | 'tags'            // Tags differ
  | 'tool_type'       // Tool type differs
  | 'metadata';       // Management metadata differs

/**
 * Represents a single drift (difference) in a tool field
 */
export interface ToolDrift {
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
export interface ToolDiffResult extends ReconcilePlan {
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
  /** Detailed drift information per tool */
  driftDetails: Map<string, ToolDrift[]>;
}

/**
 * Check if a tool is managed by smarty-admin based on its tags or metadata
 */
export function isToolManaged(tool: Tool): boolean {
  // Check tags for management marker
  if (tool.tags?.includes('managed_by:smarty-admin')) {
    return true;
  }
  return false;
}

/**
 * Extract management metadata from a tool's tags
 * Tools don't have a metadata field like blocks, so we use tags
 */
export function extractManagedMetadata(
  tool: Tool
): ManagedToolMetadata | null {
  if (!isToolManaged(tool)) {
    return null;
  }

  const metadata: ManagedToolMetadata = {
    managed_by: 'smarty-admin',
    layer: 'org', // Default, will be overridden from tags
  };

  // Parse tags for metadata
  for (const tag of tool.tags ?? []) {
    if (tag.startsWith('layer:')) {
      metadata.layer = tag.slice(6) as Layer;
    } else if (tag.startsWith('org:')) {
      metadata.org = tag.slice(4);
    } else if (tag.startsWith('project:')) {
      metadata.project = tag.slice(8);
    } else if (tag.startsWith('package_version:')) {
      metadata.package_version = tag.slice(16);
    } else if (tag.startsWith('last_synced:')) {
      metadata.last_synced = tag.slice(12);
    }
  }

  return metadata;
}

/**
 * Parse management info from a tool
 */
export function parseToolManagement(tool: Tool): ManagedToolInfo {
  const metadata = extractManagedMetadata(tool);

  if (!metadata) {
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
 * Classify a tool's ownership status
 */
export function classifyToolOwnership(
  tool: Tool,
  desiredNames: Set<string>
): ToolOwnership {
  const isManaged = isToolManaged(tool);
  const inDesired = desiredNames.has(tool.name);

  if (isManaged) {
    // Has managed metadata
    if (inDesired) {
      return ToolOwnership.MANAGED;
    }
    return ToolOwnership.ORPHANED;
  }

  // No managed metadata
  if (inDesired) {
    return ToolOwnership.ADOPTED; // Candidate for adoption
  }

  return ToolOwnership.UNMANAGED;
}

/**
 * Compare JSON schemas for equality
 */
function jsonSchemaEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compare arrays for equality (order-independent for tags)
 */
function arrayEquals(a: string[] | undefined, b: string[] | undefined): boolean {
  const aSet = new Set(a ?? []);
  const bSet = new Set(b ?? []);
  if (aSet.size !== bSet.size) return false;
  for (const item of aSet) {
    if (!bSet.has(item)) return false;
  }
  return true;
}

/**
 * Compute drifts between desired and actual tool state
 */
export function computeDrifts(
  desired: ToolManifestEntry,
  actual: Tool,
  options: ToolDiffOptions = {}
): ToolDrift[] {
  const drifts: ToolDrift[] = [];

  // Source code drift
  if (desired.sourceCode !== actual.sourceCode) {
    drifts.push({
      type: 'source_code',
      field: 'sourceCode',
      actual: truncate(actual.sourceCode ?? '', 100),
      desired: truncate(desired.sourceCode, 100),
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

  // JSON schema drift
  if (!jsonSchemaEquals(desired.jsonSchema, actual.jsonSchema)) {
    drifts.push({
      type: 'json_schema',
      field: 'jsonSchema',
      actual: actual.jsonSchema,
      desired: desired.jsonSchema,
    });
  }

  // Tags drift (excluding management tags)
  const desiredTags = desired.tags?.filter(t => !t.startsWith('managed_by:') && !t.startsWith('layer:')) ?? [];
  const actualTags = actual.tags?.filter(t => !t.startsWith('managed_by:') && !t.startsWith('layer:')) ?? [];
  if (!arrayEquals(desiredTags, actualTags)) {
    drifts.push({
      type: 'tags',
      field: 'tags',
      actual: actualTags,
      desired: desiredTags,
    });
  }

  // Tool type drift
  if (desired.toolType && desired.toolType !== actual.toolType) {
    drifts.push({
      type: 'tool_type',
      field: 'toolType',
      actual: actual.toolType,
      desired: desired.toolType,
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
function driftsToChanges(drifts: ToolDrift[]): PlanAction['changes'] {
  return drifts.map(drift => ({
    field: drift.field,
    oldValue: drift.actual,
    newValue: drift.desired,
  }));
}

/**
 * Create a plan action for a missing tool (needs creation)
 */
function createMissingToolAction(
  desired: ToolManifestEntry
): PlanAction {
  return {
    type: 'create',
    name: desired.name,
    reason: 'Tool does not exist in Letta but is defined in manifest',
    changes: [
      { field: 'sourceType', newValue: desired.sourceType },
      { field: 'sourceCode', newValue: truncate(desired.sourceCode, 100) },
      { field: 'layer', newValue: desired.layer },
      ...(desired.description ? [{ field: 'description', newValue: desired.description }] : []),
    ],
  };
}

/**
 * Create a plan action for an existing tool with drift
 */
function createDriftToolAction(
  desired: ToolManifestEntry,
  actual: Tool,
  drifts: ToolDrift[],
  ownership: ToolOwnership
): PlanAction {
  const actionType: PlanActionType = ownership === ToolOwnership.ADOPTED ? 'adopt' : 'update';

  const driftTypes = drifts.map(d => d.field).join(', ');
  const reason = ownership === ToolOwnership.ADOPTED
    ? `Tool exists but lacks management metadata; needs adoption. Changes: ${driftTypes}`
    : `Tool has ${drifts.length} drift(s): ${driftTypes}`;

  return {
    type: actionType,
    name: desired.name,
    toolId: actual.id,
    reason,
    changes: driftsToChanges(drifts),
  };
}

/**
 * Create a plan action for a tool in sync (skip)
 */
function createInSyncAction(
  desired: ToolManifestEntry,
  actual: Tool
): PlanAction {
  return {
    type: 'skip',
    name: desired.name,
    toolId: actual.id,
    reason: 'Tool is in sync with manifest',
  };
}

/**
 * Create a plan action for an orphaned tool
 */
function createOrphanedToolAction(
  actual: Tool
): PlanAction {
  return {
    type: 'delete',
    name: actual.name,
    toolId: actual.id,
    reason: 'Tool has management metadata but is not in manifest (orphaned)',
  };
}

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `tool-diff-${timestamp}-${random}`;
}

/**
 * Main diff function - compares desired state with actual state
 * and generates a reconciliation plan
 */
export function diffTools(
  desired: ToolManifestEntry[],
  actual: Tool[],
  options: ToolDiffOptions = {}
): ToolDiffResult {
  const {
    includeOrphans = true,
    changesOnly = false,
    layer,
    names,
    packageVersion,
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];
  const driftDetails = new Map<string, ToolDrift[]>();

  const creates: PlanAction[] = [];
  const updates: PlanAction[] = [];
  const deletes: PlanAction[] = [];
  const skipped: PlanAction[] = [];

  // Index desired tools by name
  const desiredByName = new Map<string, ToolManifestEntry>();
  for (const tool of desired) {
    if (desiredByName.has(tool.name)) {
      warnings.push(`Duplicate name in desired state: ${tool.name}`);
    }
    desiredByName.set(tool.name, tool);
  }

  // Index actual tools by name
  const actualByName = new Map<string, Tool>();
  for (const tool of actual) {
    if (actualByName.has(tool.name)) {
      warnings.push(`Duplicate name in actual state: ${tool.name}`);
    }
    actualByName.set(tool.name, tool);
  }

  // Set of desired names for ownership classification
  const desiredNames = new Set(desiredByName.keys());

  // Process desired tools - check for missing or drifted
  for (const [name, desiredTool] of desiredByName) {
    // Apply filters
    if (layer && desiredTool.layer !== layer) {
      continue;
    }
    if (names && !names.includes(name)) {
      continue;
    }

    const actualTool = actualByName.get(name);

    if (!actualTool) {
      // Missing tool - needs creation
      creates.push(createMissingToolAction(desiredTool));
    } else {
      // Tool exists - check for drift
      const ownership = classifyToolOwnership(actualTool, desiredNames);
      const drifts = computeDrifts(desiredTool, actualTool, options);

      if (drifts.length > 0) {
        driftDetails.set(name, drifts);
      }

      if (drifts.length > 0 || ownership === ToolOwnership.ADOPTED) {
        const action = createDriftToolAction(desiredTool, actualTool, drifts, ownership);
        updates.push(action);
      } else if (!changesOnly) {
        skipped.push(createInSyncAction(desiredTool, actualTool));
      }
    }
  }

  // Process actual tools - check for orphans
  for (const [name, actualTool] of actualByName) {
    // Skip if already processed (exists in desired)
    if (desiredByName.has(name)) {
      continue;
    }

    // Apply name filter
    if (names && !names.includes(name)) {
      continue;
    }

    const ownership = classifyToolOwnership(actualTool, desiredNames);

    // Apply layer filter for orphaned tools
    if (layer && ownership === ToolOwnership.ORPHANED) {
      const metadata = extractManagedMetadata(actualTool);
      if (metadata && metadata.layer !== layer) {
        continue;
      }
    }

    if (ownership === ToolOwnership.ORPHANED && includeOrphans) {
      deletes.push(createOrphanedToolAction(actualTool));
    }
    // Note: We don't include unmanaged tools in the plan by default
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
export function formatDiffSummary(result: ToolDiffResult): string {
  const lines: string[] = [];
  const { summary } = result;

  lines.push('Tool Diff Summary');
  lines.push('=================');
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
export function formatDiffDetails(result: ToolDiffResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Detailed Changes:');
  lines.push('-----------------');

  // Format creates
  if (result.creates.length > 0) {
    lines.push('');
    lines.push('Tools to CREATE:');
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
    lines.push('Tools to UPDATE:');
    for (const action of result.updates) {
      const prefix = action.type === 'adopt' ? '*' : '~';
      lines.push(`  ${prefix} ${action.name} (${action.toolId})`);
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
    lines.push('Tools to DELETE (orphaned):');
    for (const action of result.deletes) {
      lines.push(`  - ${action.name} (${action.toolId})`);
      lines.push(`    Reason: ${action.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format diff result as JSON plan (machine-readable)
 */
export function formatDiffAsJson(result: ToolDiffResult): string {
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
