/**
 * Template diff algorithm
 *
 * Compares desired template state (from manifest/config) with actual template
 * state (from Letta API) and generates a reconciliation plan.
 *
 * Based on: docs/research/letta-api-reference.md (Section 8: Templates)
 */

import type {
  TemplateEntityType,
  TemplateEnvironment,
  ManagedTemplateMetadata,
  ManagedTemplateInfo,
  TemplateClassification,
  BlockTemplateManifestEntry,
  BlockTemplateResponse,
  AgentTemplateManifestEntry,
  AgentTemplateResponse,
  GroupTemplateManifestEntry,
  GroupTemplateResponse,
  DeploymentEntity,
  TemplateReconcilePlan,
  TemplatePlanAction,
  TemplatePlanActionType,
} from './types.js';
import { TemplateOwnership } from './types.js';

/**
 * Options for the diff operation
 */
export interface TemplateDiffOptions {
  /** Include orphaned templates in the diff */
  includeOrphans?: boolean;
  /** Only show templates with changes */
  changesOnly?: boolean;
  /** Filter by entity type */
  entityType?: TemplateEntityType;
  /** Filter by deployment ID */
  deploymentId?: string;
  /** Filter by environment */
  environment?: TemplateEnvironment;
  /** Package version (git SHA) for change detection */
  packageVersion?: string;
}

/**
 * Types of drift that can occur between desired and actual state
 */
export type TemplateDriftType =
  | 'value' // Template value content differs
  | 'description' // Description differs
  | 'label' // Label differs
  | 'limit' // Character limit differs
  | 'metadata' // Management metadata differs
  | 'version' // Version differs
  | 'environment'; // Environment differs

/**
 * Represents a single drift (difference) in a template field
 */
export interface TemplateDrift {
  /** Type of drift detected */
  type: TemplateDriftType;
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
export interface TemplateDiffResult extends TemplateReconcilePlan {
  /** Timestamp when diff was computed */
  timestamp: string;
  /** Unique identifier for this diff operation */
  diffId: string;
  /** Deployment context */
  deploymentId?: string;
  /** Environment context */
  environment?: TemplateEnvironment;
  /** Whether any changes are needed */
  hasChanges: boolean;
  /** Errors encountered during diff */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
  /** Detailed drift information per template */
  driftDetails: Map<string, TemplateDrift[]>;
}

// =============================================================================
// Template Management Detection
// =============================================================================

/**
 * Check if a template entity is managed by smarty-admin based on its metadata
 */
export function isTemplateManaged(entity: {
  metadata?: Record<string, unknown>;
}): boolean {
  const metadata = entity.metadata as ManagedTemplateMetadata | undefined;
  return metadata?.managed_by === 'smarty-admin';
}

/**
 * Extract management metadata from a template entity
 */
export function extractTemplateMetadata(entity: {
  metadata?: Record<string, unknown>;
}): ManagedTemplateMetadata | null {
  if (!isTemplateManaged(entity)) {
    return null;
  }
  return entity.metadata as unknown as ManagedTemplateMetadata;
}

/**
 * Parse management info from a template entity
 */
export function parseTemplateManagement(entity: {
  metadata?: Record<string, unknown>;
}): ManagedTemplateInfo {
  const metadata = entity.metadata as ManagedTemplateMetadata | undefined;

  if (!metadata || metadata.managed_by !== 'smarty-admin') {
    return { isManaged: false };
  }

  return {
    isManaged: true,
    entityType: metadata.entity_type,
    deploymentId: metadata.deployment_id,
    entityId: metadata.entity_id,
    projectId: metadata.project_id,
    version: metadata.version,
    environment: metadata.environment,
    packageVersion: metadata.package_version,
    lastSynced: metadata.last_synced,
  };
}

/**
 * Classify a template's ownership status
 */
export function classifyTemplateOwnership(
  entity: { metadata?: Record<string, unknown> },
  desiredNames: Set<string>,
  entityName: string
): TemplateOwnership {
  const isManaged = isTemplateManaged(entity);
  const inDesired = desiredNames.has(entityName);

  if (isManaged) {
    if (inDesired) {
      return TemplateOwnership.MANAGED;
    }
    return TemplateOwnership.ORPHANED;
  }

  return TemplateOwnership.UNMANAGED;
}

// =============================================================================
// Block Template Diffing
// =============================================================================

/**
 * Compute drifts between desired and actual block template state
 */
export function computeBlockTemplateDrifts(
  desired: BlockTemplateManifestEntry,
  actual: BlockTemplateResponse,
  options: TemplateDiffOptions = {}
): TemplateDrift[] {
  const drifts: TemplateDrift[] = [];

  // Value drift
  if (desired.value !== actual.value) {
    drifts.push({
      type: 'value',
      field: 'value',
      actual: actual.value,
      desired: desired.value,
    });
  }

  // Label drift
  if (desired.label !== actual.label) {
    drifts.push({
      type: 'label',
      field: 'label',
      actual: actual.label,
      desired: desired.label,
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

  // Limit drift
  if (desired.limit !== undefined && desired.limit !== actual.limit) {
    drifts.push({
      type: 'limit',
      field: 'limit',
      actual: actual.limit,
      desired: desired.limit,
    });
  }

  // Metadata drift (package version)
  const actualMetadata = actual.metadata as ManagedTemplateMetadata | undefined;
  if (
    actualMetadata?.managed_by === 'smarty-admin' &&
    options.packageVersion
  ) {
    if (options.packageVersion !== actualMetadata.package_version) {
      drifts.push({
        type: 'metadata',
        field: 'package_version',
        actual: actualMetadata.package_version,
        desired: options.packageVersion,
      });
    }
  }

  // Version drift
  if (
    desired.version &&
    actualMetadata?.version !== desired.version
  ) {
    drifts.push({
      type: 'version',
      field: 'version',
      actual: actualMetadata?.version,
      desired: desired.version,
    });
  }

  return drifts;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert drifts to plan action changes format
 */
function driftsToChanges(
  drifts: TemplateDrift[]
): TemplatePlanAction['changes'] {
  return drifts.map((drift) => ({
    field: drift.field,
    oldValue: drift.actual,
    newValue: drift.desired,
  }));
}

/**
 * Create a plan action for a missing template (needs creation)
 */
function createMissingTemplateAction(
  entityType: TemplateEntityType,
  name: string,
  deploymentId: string,
  additionalChanges: { field: string; newValue: unknown }[]
): TemplatePlanAction {
  return {
    type: 'create',
    entityType,
    name,
    deploymentId,
    reason: `Template does not exist in Letta but is defined in manifest`,
    changes: [{ field: 'deployment_id', newValue: deploymentId }, ...additionalChanges],
  };
}

/**
 * Create a plan action for a template with drift
 */
function createDriftTemplateAction(
  entityType: TemplateEntityType,
  name: string,
  templateId: string,
  deploymentId: string,
  drifts: TemplateDrift[]
): TemplatePlanAction {
  const driftTypes = drifts.map((d) => d.field).join(', ');

  return {
    type: 'update',
    entityType,
    name,
    templateId,
    deploymentId,
    reason: `Template has ${drifts.length} drift(s): ${driftTypes}`,
    changes: driftsToChanges(drifts),
  };
}

/**
 * Create a plan action for a template in sync (skip)
 */
function createInSyncAction(
  entityType: TemplateEntityType,
  name: string,
  templateId: string,
  deploymentId?: string
): TemplatePlanAction {
  return {
    type: 'skip',
    entityType,
    name,
    templateId,
    deploymentId,
    reason: 'Template is in sync with manifest',
  };
}

/**
 * Create a plan action for an orphaned template
 */
function createOrphanedTemplateAction(
  entityType: TemplateEntityType,
  name: string,
  templateId: string,
  deploymentId?: string
): TemplatePlanAction {
  return {
    type: 'delete',
    entityType,
    name,
    templateId,
    deploymentId,
    reason:
      'Template has management metadata but is not in manifest (orphaned)',
  };
}

/**
 * Create a plan action for promoting a template
 */
function createPromoteAction(
  entityType: TemplateEntityType,
  name: string,
  templateId: string,
  fromEnv: TemplateEnvironment,
  toEnv: TemplateEnvironment,
  deploymentId?: string
): TemplatePlanAction {
  return {
    type: 'promote',
    entityType,
    name,
    templateId,
    deploymentId,
    reason: `Promote template from ${fromEnv} to ${toEnv}`,
    changes: [
      { field: 'environment', oldValue: fromEnv, newValue: toEnv },
    ],
  };
}

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `template-diff-${timestamp}-${random}`;
}

// =============================================================================
// Main Diff Functions
// =============================================================================

/**
 * Diff block templates between desired and actual state
 */
export function diffBlockTemplates(
  desired: BlockTemplateManifestEntry[],
  actual: BlockTemplateResponse[],
  options: TemplateDiffOptions = {}
): TemplateDiffResult {
  const {
    includeOrphans = true,
    changesOnly = false,
    deploymentId,
    environment,
    packageVersion,
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];
  const driftDetails = new Map<string, TemplateDrift[]>();

  const creates: TemplatePlanAction[] = [];
  const updates: TemplatePlanAction[] = [];
  const deletes: TemplatePlanAction[] = [];
  const skipped: TemplatePlanAction[] = [];
  const promotes: TemplatePlanAction[] = [];

  // Index desired templates by template name
  const desiredByName = new Map<string, BlockTemplateManifestEntry>();
  for (const template of desired) {
    if (desiredByName.has(template.templateName)) {
      warnings.push(
        `Duplicate template name in desired state: ${template.templateName}`
      );
    }
    desiredByName.set(template.templateName, template);
  }

  // Index actual templates by template name
  const actualByName = new Map<string, BlockTemplateResponse>();
  for (const template of actual) {
    const name = template.template_name ?? template.label;
    if (actualByName.has(name)) {
      warnings.push(`Duplicate template name in actual state: ${name}`);
    }
    actualByName.set(name, template);
  }

  // Set of desired names for ownership classification
  const desiredNames = new Set(desiredByName.keys());

  // Process desired templates
  for (const [name, desiredTemplate] of desiredByName) {
    // Apply filters
    if (deploymentId && desiredTemplate.deploymentId !== deploymentId) {
      continue;
    }
    if (environment && desiredTemplate.environment !== environment) {
      continue;
    }

    const actualTemplate = actualByName.get(name);

    if (!actualTemplate) {
      // Missing template - needs creation
      creates.push(
        createMissingTemplateAction('block', name, desiredTemplate.deploymentId, [
          { field: 'label', newValue: desiredTemplate.label },
          { field: 'value', newValue: truncate(desiredTemplate.value, 100) },
          ...(desiredTemplate.description
            ? [{ field: 'description', newValue: desiredTemplate.description }]
            : []),
        ])
      );
    } else {
      // Template exists - check for drift
      const ownership = classifyTemplateOwnership(
        actualTemplate,
        desiredNames,
        name
      );
      const drifts = computeBlockTemplateDrifts(
        desiredTemplate,
        actualTemplate,
        options
      );

      if (drifts.length > 0) {
        driftDetails.set(name, drifts);
      }

      if (drifts.length > 0) {
        updates.push(
          createDriftTemplateAction(
            'block',
            name,
            actualTemplate.id,
            desiredTemplate.deploymentId,
            drifts
          )
        );
      } else if (!changesOnly) {
        skipped.push(
          createInSyncAction(
            'block',
            name,
            actualTemplate.id,
            desiredTemplate.deploymentId
          )
        );
      }
    }
  }

  // Process actual templates - check for orphans
  for (const [name, actualTemplate] of actualByName) {
    if (desiredByName.has(name)) {
      continue;
    }

    const ownership = classifyTemplateOwnership(
      actualTemplate,
      desiredNames,
      name
    );

    if (ownership === TemplateOwnership.ORPHANED && includeOrphans) {
      const metadata = extractTemplateMetadata(actualTemplate);
      deletes.push(
        createOrphanedTemplateAction(
          'block',
          name,
          actualTemplate.id,
          metadata?.deployment_id
        )
      );
    }
  }

  // Compute summary
  const summary = {
    toCreate: creates.length,
    toUpdate: updates.length,
    toDelete: deletes.length,
    toPromote: promotes.length,
    unchanged: skipped.length,
    total:
      creates.length +
      updates.length +
      deletes.length +
      skipped.length +
      promotes.length,
  };

  const hasChanges =
    summary.toCreate > 0 ||
    summary.toUpdate > 0 ||
    summary.toDelete > 0 ||
    summary.toPromote > 0;

  return {
    timestamp: new Date().toISOString(),
    diffId: generateDiffId(),
    deploymentId,
    environment,
    creates,
    updates,
    deletes,
    skipped,
    promotes,
    summary,
    hasChanges,
    errors,
    warnings,
    driftDetails,
  };
}

// =============================================================================
// Formatting Functions
// =============================================================================

/**
 * Format diff result as human-readable summary
 */
export function formatTemplateDiffSummary(result: TemplateDiffResult): string {
  const lines: string[] = [];
  const { summary } = result;

  lines.push('Template Diff Summary');
  lines.push('=====================');
  lines.push('');
  lines.push(`Timestamp: ${result.timestamp}`);
  lines.push(`Diff ID: ${result.diffId}`);
  if (result.deploymentId) lines.push(`Deployment: ${result.deploymentId}`);
  if (result.environment) lines.push(`Environment: ${result.environment}`);
  lines.push('');

  lines.push('Actions:');
  if (summary.toCreate > 0) lines.push(`  + Create: ${summary.toCreate}`);
  if (summary.toUpdate > 0) lines.push(`  ~ Update: ${summary.toUpdate}`);
  if (summary.toDelete > 0) lines.push(`  - Delete: ${summary.toDelete}`);
  if (summary.toPromote > 0) lines.push(`  ^ Promote: ${summary.toPromote}`);
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
export function formatTemplateDiffDetails(result: TemplateDiffResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Detailed Changes:');
  lines.push('-----------------');

  // Format creates
  if (result.creates.length > 0) {
    lines.push('');
    lines.push('Templates to CREATE:');
    for (const action of result.creates) {
      lines.push(`  + [${action.entityType}] ${action.name}`);
      if (action.changes) {
        for (const change of action.changes) {
          lines.push(
            `    ${change.field}: ${truncate(String(change.newValue ?? ''), 50)}`
          );
        }
      }
    }
  }

  // Format updates
  if (result.updates.length > 0) {
    lines.push('');
    lines.push('Templates to UPDATE:');
    for (const action of result.updates) {
      lines.push(
        `  ~ [${action.entityType}] ${action.name} (${action.templateId})`
      );
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
    lines.push('Templates to DELETE (orphaned):');
    for (const action of result.deletes) {
      lines.push(
        `  - [${action.entityType}] ${action.name} (${action.templateId})`
      );
      lines.push(`    Reason: ${action.reason}`);
    }
  }

  // Format promotes
  if (result.promotes.length > 0) {
    lines.push('');
    lines.push('Templates to PROMOTE:');
    for (const action of result.promotes) {
      lines.push(
        `  ^ [${action.entityType}] ${action.name} (${action.templateId})`
      );
      lines.push(`    Reason: ${action.reason}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format diff result as JSON plan (machine-readable)
 */
export function formatTemplateDiffAsJson(result: TemplateDiffResult): string {
  const jsonResult = {
    timestamp: result.timestamp,
    diffId: result.diffId,
    deploymentId: result.deploymentId,
    environment: result.environment,
    hasChanges: result.hasChanges,
    summary: result.summary,
    creates: result.creates,
    updates: result.updates,
    deletes: result.deletes,
    promotes: result.promotes,
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
