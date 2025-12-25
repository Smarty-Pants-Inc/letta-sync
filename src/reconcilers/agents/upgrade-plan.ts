/**
 * Upgrade Plan Computation for Agents
 *
 * Computes dry-run upgrade plans for agents by:
 * 1. Resolving desired state from packages (base + org + project)
 * 2. Comparing current state (attached blocks/tools) to desired
 * 3. Computing what needs to be attached/updated
 * 4. Classifying changes as safe (auto-apply) or breaking (requires confirmation)
 *
 * @see docs/specs/role-channel-matrix.md §4 Upgrade Policy
 * @see ../blocks/diff.ts for block-level diff patterns
 */

import type { Block, Tool, Folder, Identity } from '../../api/types.js';
import type {
  DesiredState,
  BlockResource,
  ToolResource,
  FolderResource,
  IdentityResource,
} from '../../packages/types.js';
import type { ManagedState, UpgradeChannel, PackageLayer } from './state.js';
import { toShortSha } from './state.js';
import { MANAGED_STATE_LABEL } from './state.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Agent role defining capabilities and default channel
 */
export type AgentRole = 'lane-dev' | 'repo-curator' | 'org-curator' | 'supervisor';

/**
 * Upgrade action types
 */
export type UpgradeActionType =
  | 'attach_block'    // Attach a new block
  | 'update_block'    // Update existing block content/config
  | 'detach_block'    // Detach (remove) a block
  | 'attach_tool'     // Attach a new tool
  | 'update_tool'     // Update existing tool
  | 'detach_tool'     // Detach (remove) a tool
  | 'attach_folder'   // Attach a new folder
  | 'detach_folder'   // Detach a folder
  | 'attach_identity' // Attach a new identity
  | 'detach_identity' // Detach an identity
  | 'update_config'   // Update agent configuration
  | 'update_prompt'   // Update system prompt
  | 'skip';           // No action needed

/**
 * Change classification per role-channel-matrix.md §4
 */
export type ChangeClassification = 'safe' | 'breaking';

/**
 * Field-level change detail
 */
export interface FieldChange {
  /** Field name */
  field: string;
  /** Previous value */
  oldValue?: unknown;
  /** New value */
  newValue?: unknown;
}

/**
 * Single upgrade action
 */
export interface UpgradeAction {
  /** Type of upgrade action */
  type: UpgradeActionType;
  /** Resource kind affected */
  resourceKind: 'block' | 'tool' | 'folder' | 'identity' | 'agent';
  /** Resource name/label */
  resourceName: string;
  /** Resource ID (if exists) */
  resourceId?: string;
  /** Classification: safe (auto-apply) or breaking (requires confirmation) */
  classification: ChangeClassification;
  /** Human-readable reason for this action */
  reason: string;
  /** Detailed field changes */
  changes?: FieldChange[];
  /** Source layer for this resource */
  sourceLayer?: PackageLayer;
}

/**
 * Summary statistics for upgrade plan
 */
export interface UpgradePlanSummary {
  /** Number of blocks to attach */
  blocksToAttach: number;
  /** Number of blocks to update */
  blocksToUpdate: number;
  /** Number of blocks to detach */
  blocksToDetach: number;
  /** Number of tools to attach */
  toolsToAttach: number;
  /** Number of tools to update */
  toolsToUpdate: number;
  /** Number of tools to detach */
  toolsToDetach: number;
  /** Number of folders to attach */
  foldersToAttach: number;
  /** Number of folders to detach */
  foldersToDetach: number;
  /** Number of identities to attach */
  identitiesToAttach: number;
  /** Number of identities to detach */
  identitiesToDetach: number;
  /** Number of sources to attach (for compatibility) */
  sourcesToAttach: number;
  /** Total safe changes */
  safeChanges: number;
  /** Total breaking changes */
  breakingChanges: number;
  /** Number of skipped (no change) items */
  unchanged: number;
  /** Total changes (for compatibility) */
  totalChanges: number;
}

/**
 * Change type enumeration for upgrade-apply compatibility
 */
export type UpgradeChangeType =
  | 'new_optional_block'
  | 'block_content_update'
  | 'block_detachment'
  | 'block_deletion'
  | 'new_tool_additive'
  | 'tool_config_update'
  | 'tool_removal'
  | 'new_folder'
  | 'new_source'
  | 'bug_fix';

/**
 * Upgrade change for compatibility with upgrade-apply.ts
 * Maps UpgradeAction to the format expected by the apply logic
 */
export interface UpgradeChange {
  /** Type of change */
  type: UpgradeChangeType;
  /** Classification */
  classification: ChangeClassification;
  /** Resource identifier */
  resourceId: string;
  /** Human-readable description */
  description: string;
  /** Source layer */
  layer?: PackageLayer;
}

/**
 * Complete upgrade plan for an agent
 */
export interface UpgradePlan {
  /** Unique plan ID */
  planId: string;
  /** Timestamp when plan was computed */
  timestamp: string;
  /** Target agent ID */
  agentId: string;
  /** Agent name */
  agentName?: string;
  /** Agent role */
  role: AgentRole;
  /** Upgrade channel */
  channel: UpgradeChannel;
  /** Current managed state (if exists) */
  currentState?: ManagedState;
  /** Target package versions by layer */
  targetVersions: Partial<Record<PackageLayer, string>>;
  /** All planned actions */
  actions: UpgradeAction[];
  /** Summary statistics */
  summary: UpgradePlanSummary;
  /** Whether any changes are needed */
  hasChanges: boolean;
  /** Whether the plan requires manual confirmation */
  requiresConfirmation: boolean;
  /** Errors encountered during plan computation */
  errors: string[];
  /** Warnings (non-blocking issues) */
  warnings: string[];
  
  // Compatibility properties for upgrade-apply.ts
  /** Whether the agent is already up to date */
  isUpToDate: boolean;
  /** Whether plan contains breaking changes */
  hasBreakingChanges: boolean;
  /** All changes in the plan (for apply) */
  changes: UpgradeChange[];
  /** Safe changes only (auto-apply) */
  safeChanges: UpgradeChange[];
  /** Breaking changes only (require --force) */
  breakingChanges: UpgradeChange[];
}

/**
 * Current agent state for comparison
 */
export interface AgentCurrentState {
  /** Agent ID */
  agentId: string;
  /** Agent name */
  agentName?: string;
  /** Attached blocks */
  blocks: Block[];
  /** Attached tools */
  tools: Tool[];
  /** Attached folders */
  folders: Folder[];
  /** Attached identities */
  identities: Identity[];
  /** System prompt (if accessible) */
  systemPrompt?: string;
  /** Agent tags */
  tags?: string[];
  /** Managed state (if exists) */
  managedState?: ManagedState;
}

/**
 * Options for computing upgrade plan
 */
export interface ComputePlanOptions {
  /** Agent role */
  role: AgentRole;
  /** Upgrade channel */
  channel: UpgradeChannel;
  /** Target package versions */
  targetVersions?: Partial<Record<PackageLayer, string>>;
  /** Include skipped (unchanged) items in plan */
  includeUnchanged?: boolean;
  /** Force all changes to be classified as breaking */
  forceBreaking?: boolean;
}

// =============================================================================
// Plan Computation
// =============================================================================

/**
 * Generate a unique plan ID
 */
function generatePlanId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `plan-${timestamp}-${random}`;
}

/**
 * Determine if a block change is breaking per spec §4.2
 *
 * Breaking changes (require confirmation):
 * - Block deletions/detachments
 * - Block label renames
 * - Required block structure changes
 *
 * Safe changes (auto-apply):
 * - Block content updates (append/insert)
 * - New optional blocks
 * - Bug fixes
 */
function classifyBlockChange(
  actionType: UpgradeActionType,
  currentBlock?: Block,
  desiredBlock?: BlockResource
): ChangeClassification {
  // Detachments are always breaking
  if (actionType === 'detach_block') {
    return 'breaking';
  }

  // New blocks are safe (additive)
  if (actionType === 'attach_block' && !currentBlock) {
    return 'safe';
  }

  // Updates need more analysis
  if (actionType === 'update_block' && currentBlock && desiredBlock) {
    // Label rename is breaking
    if (currentBlock.label !== desiredBlock.spec.label) {
      return 'breaking';
    }

    // Content updates are generally safe (append/insert pattern)
    // Full rewrites could be breaking, but we assume package authors
    // follow the spec and use append patterns
    return 'safe';
  }

  return 'safe';
}

/**
 * Determine if a tool change is breaking per spec §4.2
 *
 * Breaking changes:
 * - Tool removals
 *
 * Safe changes:
 * - New tool attachments (additive)
 * - Tool configuration updates (backward compatible)
 */
function classifyToolChange(
  actionType: UpgradeActionType,
  _currentTool?: Tool,
  _desiredTool?: ToolResource
): ChangeClassification {
  // Tool detachments are breaking
  if (actionType === 'detach_tool') {
    return 'breaking';
  }

  // New tools are safe (additive)
  if (actionType === 'attach_tool') {
    return 'safe';
  }

  // Tool updates are generally safe (backward compatible configs)
  return 'safe';
}

/**
 * Compute block-level actions
 */
function computeBlockActions(
  currentBlocks: Block[],
  desiredBlocks: BlockResource[],
  options: ComputePlanOptions
): UpgradeAction[] {
  const actions: UpgradeAction[] = [];

  // Index current blocks by label
  const currentByLabel = new Map<string, Block>();
  for (const block of currentBlocks) {
    currentByLabel.set(block.label, block);
  }

  // Index desired blocks by name (spec.label)
  const desiredByLabel = new Map<string, BlockResource>();
  for (const block of desiredBlocks) {
    desiredByLabel.set(block.spec.label, block);
  }

  // Check for blocks to attach or update
  for (const [label, desired] of Array.from(desiredByLabel.entries())) {
    const current = currentByLabel.get(label);

    if (!current) {
      // New block - needs attachment
      const actionType: UpgradeActionType = 'attach_block';
      actions.push({
        type: actionType,
        resourceKind: 'block',
        resourceName: label,
        classification: options.forceBreaking
          ? 'breaking'
          : classifyBlockChange(actionType, undefined, desired),
        reason: `Block '${label}' is defined in package but not attached to agent`,
        changes: [
          { field: 'value', newValue: truncate(desired.spec.value, 100) },
          { field: 'layer', newValue: desired.spec.layer },
        ],
        sourceLayer: desired.spec.layer as PackageLayer,
      });
    } else {
      // Existing block - check for drift
      const changes: FieldChange[] = [];

      if (current.value !== desired.spec.value) {
        changes.push({
          field: 'value',
          oldValue: truncate(current.value, 50),
          newValue: truncate(desired.spec.value, 50),
        });
      }

      if (current.description !== desired.metadata.description) {
        changes.push({
          field: 'description',
          oldValue: current.description,
          newValue: desired.metadata.description,
        });
      }

      if (desired.spec.limit && current.limit !== desired.spec.limit) {
        changes.push({
          field: 'limit',
          oldValue: current.limit,
          newValue: desired.spec.limit,
        });
      }

      if (changes.length > 0) {
        const actionType: UpgradeActionType = 'update_block';
        actions.push({
          type: actionType,
          resourceKind: 'block',
          resourceName: label,
          resourceId: current.id,
          classification: options.forceBreaking
            ? 'breaking'
            : classifyBlockChange(actionType, current, desired),
          reason: `Block '${label}' has ${changes.length} drift(s)`,
          changes,
          sourceLayer: desired.spec.layer as PackageLayer,
        });
      } else if (options.includeUnchanged) {
        actions.push({
          type: 'skip',
          resourceKind: 'block',
          resourceName: label,
          resourceId: current.id,
          classification: 'safe',
          reason: 'Block is in sync with package',
        });
      }
    }
  }

  // Check for blocks to detach (orphans)
  // Only consider package-managed blocks (those created by smarty-admin from
  // layered package manifests). This intentionally excludes other smarty-admin
  // features that create blocks (e.g. scope-sync lane/scope blocks).
  for (const [label, current] of Array.from(currentByLabel.entries())) {
    // Never detach the managed_state tracking block.
    if (label === MANAGED_STATE_LABEL) continue;
    if (!desiredByLabel.has(label)) {
      // Check if this is a managed block that should be removed
      const md = (current.metadata as Record<string, unknown> | undefined) ?? undefined;
      const isManaged = md?.managed_by === 'smarty-admin';
      const src = typeof md?.source === 'string' ? (md.source as string) : '';
      const isPackageManaged =
        src.startsWith('base_') || src.startsWith('org_') || src.startsWith('project_');

      if (isManaged && isPackageManaged) {
        const actionType: UpgradeActionType = 'detach_block';
        actions.push({
          type: actionType,
          resourceKind: 'block',
          resourceName: label,
          resourceId: current.id,
          classification: options.forceBreaking
            ? 'breaking'
            : classifyBlockChange(actionType, current, undefined),
          reason: `Block '${label}' is managed but no longer in package (orphaned)`,
        });
      }
    }
  }

  return actions;
}

/**
 * Compute tool-level actions
 */
function computeToolActions(
  currentTools: Tool[],
  desiredTools: ToolResource[],
  options: ComputePlanOptions
): UpgradeAction[] {
  const actions: UpgradeAction[] = [];

  // Index current tools by name
  const currentByName = new Map<string, Tool>();
  for (const tool of currentTools) {
    currentByName.set(tool.name, tool);
  }

  // Index desired tools by name
  const desiredByName = new Map<string, ToolResource>();
  for (const tool of desiredTools) {
    desiredByName.set(tool.metadata.name, tool);
  }

  // Check for tools to attach or update
  for (const [name, desired] of Array.from(desiredByName.entries())) {
    const current = currentByName.get(name);

    if (!current) {
      // New tool - needs attachment
      const actionType: UpgradeActionType = 'attach_tool';
      actions.push({
        type: actionType,
        resourceKind: 'tool',
        resourceName: name,
        classification: options.forceBreaking
          ? 'breaking'
          : classifyToolChange(actionType, undefined, desired),
        reason: `Tool '${name}' is defined in package but not attached to agent`,
        changes: [
          { field: 'sourceType', newValue: desired.spec.sourceType },
          { field: 'toolType', newValue: desired.spec.toolType ?? 'custom' },
        ],
        sourceLayer: desired.spec.layer as PackageLayer,
      });
    } else {
      // Existing tool - check for drift
      const changes: FieldChange[] = [];

      // Compare source code (significant change)
      if (current.sourceCode !== desired.spec.sourceCode) {
        changes.push({
          field: 'sourceCode',
          oldValue: '[changed]',
          newValue: '[changed]',
        });
      }

      // Compare description
      if (current.description !== desired.metadata.description) {
        changes.push({
          field: 'description',
          oldValue: current.description,
          newValue: desired.metadata.description,
        });
      }

      if (changes.length > 0) {
        const actionType: UpgradeActionType = 'update_tool';
        actions.push({
          type: actionType,
          resourceKind: 'tool',
          resourceName: name,
          resourceId: current.id,
          classification: options.forceBreaking
            ? 'breaking'
            : classifyToolChange(actionType, current, desired),
          reason: `Tool '${name}' has ${changes.length} drift(s)`,
          changes,
          sourceLayer: desired.spec.layer as PackageLayer,
        });
      } else if (options.includeUnchanged) {
        actions.push({
          type: 'skip',
          resourceKind: 'tool',
          resourceName: name,
          resourceId: current.id,
          classification: 'safe',
          reason: 'Tool is in sync with package',
        });
      }
    }
  }

  // Check for tools to detach
  // Similar to blocks, only consider managed tools
  for (const [name, current] of Array.from(currentByName.entries())) {
    if (!desiredByName.has(name)) {
      // Check if this is a managed tool (has managed tag or metadata)
      const isManaged = current.tags?.includes('managed:smarty-admin');

      if (isManaged) {
        const actionType: UpgradeActionType = 'detach_tool';
        actions.push({
          type: actionType,
          resourceKind: 'tool',
          resourceName: name,
          resourceId: current.id,
          classification: options.forceBreaking
            ? 'breaking'
            : classifyToolChange(actionType, current, undefined),
          reason: `Tool '${name}' is managed but no longer in package (orphaned)`,
        });
      }
    }
  }

  return actions;
}

/**
 * Compute folder-level actions
 */
function computeFolderActions(
  currentFolders: Folder[],
  desiredFolders: FolderResource[],
  options: ComputePlanOptions
): UpgradeAction[] {
  const actions: UpgradeAction[] = [];

  // Index current folders by name
  const currentByName = new Map<string, Folder>();
  for (const folder of currentFolders) {
    currentByName.set(folder.name, folder);
  }

  // Index desired folders by name
  const desiredByName = new Map<string, FolderResource>();
  for (const folder of desiredFolders) {
    desiredByName.set(folder.metadata.name, folder);
  }

  // Check for folders to attach
  for (const [name, desired] of Array.from(desiredByName.entries())) {
    const current = currentByName.get(name);

    if (!current) {
      actions.push({
        type: 'attach_folder',
        resourceKind: 'folder',
        resourceName: name,
        classification: options.forceBreaking ? 'breaking' : 'safe',
        reason: `Folder '${name}' is defined in package but not attached to agent`,
        sourceLayer: desired.spec.layer as PackageLayer,
      });
    } else if (options.includeUnchanged) {
      actions.push({
        type: 'skip',
        resourceKind: 'folder',
        resourceName: name,
        resourceId: current.id,
        classification: 'safe',
        reason: 'Folder is already attached',
      });
    }
  }

  // Check for folders to detach
  for (const [name, current] of Array.from(currentByName.entries())) {
    if (!desiredByName.has(name)) {
      const isManaged =
        current.metadata &&
        (current.metadata as Record<string, unknown>).managed_by === 'smarty-admin';

      if (isManaged) {
        actions.push({
          type: 'detach_folder',
          resourceKind: 'folder',
          resourceName: name,
          resourceId: current.id,
          classification: options.forceBreaking ? 'breaking' : 'breaking', // Folder detach is breaking
          reason: `Folder '${name}' is managed but no longer in package (orphaned)`,
        });
      }
    }
  }

  return actions;
}

/**
 * Compute identity-level actions
 */
function computeIdentityActions(
  currentIdentities: Identity[],
  desiredIdentities: IdentityResource[],
  options: ComputePlanOptions
): UpgradeAction[] {
  const actions: UpgradeAction[] = [];

  // Index current identities by identifier_key
  const currentByKey = new Map<string, Identity>();
  for (const identity of currentIdentities) {
    if (identity.identifierKey) {
      currentByKey.set(identity.identifierKey, identity);
    }
  }

  // Index desired identities by identifier_key
  const desiredByKey = new Map<string, IdentityResource>();
  for (const identity of desiredIdentities) {
    if (identity.spec.identifierKey) {
      desiredByKey.set(identity.spec.identifierKey, identity);
    }
  }

  // Check for identities to attach
  for (const [key, desired] of Array.from(desiredByKey.entries())) {
    const current = currentByKey.get(key);

    if (!current) {
      actions.push({
        type: 'attach_identity',
        resourceKind: 'identity',
        resourceName: key,
        classification: options.forceBreaking ? 'breaking' : 'safe',
        reason: `Identity '${key}' is defined in package but not attached to agent`,
        sourceLayer: desired.spec.layer as PackageLayer,
      });
    } else if (options.includeUnchanged) {
      actions.push({
        type: 'skip',
        resourceKind: 'identity',
        resourceName: key,
        resourceId: current.id,
        classification: 'safe',
        reason: 'Identity is already attached',
      });
    }
  }

  // Note: We don't automatically detach identities - that's a user decision

  return actions;
}

/**
 * Compute summary statistics from actions
 */
function computeSummary(actions: UpgradeAction[]): UpgradePlanSummary {
  const summary: UpgradePlanSummary = {
    blocksToAttach: 0,
    blocksToUpdate: 0,
    blocksToDetach: 0,
    toolsToAttach: 0,
    toolsToUpdate: 0,
    toolsToDetach: 0,
    foldersToAttach: 0,
    foldersToDetach: 0,
    identitiesToAttach: 0,
    identitiesToDetach: 0,
    // Sources are not yet modeled in the v1 desired state, but the type expects it.
    sourcesToAttach: 0,
    safeChanges: 0,
    breakingChanges: 0,
    unchanged: 0,
    totalChanges: 0,
  };

  for (const action of actions) {
    if (action.type === 'skip') {
      summary.unchanged++;
      continue;
    }

    // Count by classification
    if (action.classification === 'safe') {
      summary.safeChanges++;
    } else {
      summary.breakingChanges++;
    }

    // Count by type
    switch (action.type) {
      case 'attach_block':
        summary.blocksToAttach++;
        break;
      case 'update_block':
        summary.blocksToUpdate++;
        break;
      case 'detach_block':
        summary.blocksToDetach++;
        break;
      case 'attach_tool':
        summary.toolsToAttach++;
        break;
      case 'update_tool':
        summary.toolsToUpdate++;
        break;
      case 'detach_tool':
        summary.toolsToDetach++;
        break;
      case 'attach_folder':
        summary.foldersToAttach++;
        break;
      case 'detach_folder':
        summary.foldersToDetach++;
        break;
      case 'attach_identity':
        summary.identitiesToAttach++;
        break;
      case 'detach_identity':
        summary.identitiesToDetach++;
        break;
    }
  }

  summary.totalChanges = summary.safeChanges + summary.breakingChanges;

  return summary;
}

/**
 * Compute upgrade plan for an agent
 *
 * Main entry point for plan computation. Compares current agent state
 * to desired state from merged packages and produces a detailed plan.
 *
 * @param currentState - Current agent state (blocks, tools, etc.)
 * @param desiredState - Desired state from merged packages
 * @param options - Plan computation options
 * @returns Complete upgrade plan
 */
export function computeUpgradePlan(
  currentState: AgentCurrentState,
  desiredState: DesiredState,
  options: ComputePlanOptions
): UpgradePlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const actions: UpgradeAction[] = [];

  // Compute block actions
  try {
    const blockActions = computeBlockActions(
      currentState.blocks,
      desiredState.blocks,
      options
    );
    actions.push(...blockActions);
  } catch (err) {
    errors.push(`Failed to compute block actions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compute tool actions
  try {
    const toolActions = computeToolActions(
      currentState.tools,
      desiredState.tools,
      options
    );
    actions.push(...toolActions);
  } catch (err) {
    errors.push(`Failed to compute tool actions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compute folder actions
  try {
    const folderActions = computeFolderActions(
      currentState.folders,
      desiredState.folders,
      options
    );
    actions.push(...folderActions);
  } catch (err) {
    errors.push(`Failed to compute folder actions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compute identity actions
  try {
    const identityActions = computeIdentityActions(
      currentState.identities,
      desiredState.identities,
      options
    );
    actions.push(...identityActions);
  } catch (err) {
    errors.push(`Failed to compute identity actions: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Compute summary
  const summary = computeSummary(actions);

  // Determine if confirmation is required
  // Per spec §4: breaking changes always require confirmation on all channels
  const requiresConfirmation =
    summary.breakingChanges > 0 || options.channel === 'pinned';

  // Add warning for pinned channel
  if (options.channel === 'pinned' && summary.safeChanges > 0) {
    warnings.push(
      'Agent is on pinned channel - all changes require explicit confirmation'
    );
  }

  // Check for version drift
  if (currentState.managedState && options.targetVersions) {
    for (const layer of ['base', 'org', 'project'] as PackageLayer[]) {
      const currentSha = currentState.managedState.appliedPackages[layer]?.manifestSha;
      const targetSha = options.targetVersions[layer];
      
      if (targetSha && currentSha && currentSha !== toShortSha(targetSha)) {
        warnings.push(
          `${layer} package version drift: ${currentSha} → ${toShortSha(targetSha)}`
        );
      }
    }
  }

  const hasChanges =
    summary.safeChanges > 0 || summary.breakingChanges > 0;

  // Compatibility change list for apply logic.
  const changes: UpgradeChange[] = actions
    .filter((a) => a.type !== 'skip')
    .map((a) => {
      let type: UpgradeChangeType;
      switch (a.type) {
        case 'attach_block':
          type = 'new_optional_block';
          break;
        case 'update_block':
          type = 'block_content_update';
          break;
        case 'detach_block':
          type = 'block_detachment';
          break;
        case 'attach_tool':
          type = 'new_tool_additive';
          break;
        case 'update_tool':
          type = 'tool_config_update';
          break;
        case 'detach_tool':
          type = 'tool_removal';
          break;
        case 'attach_folder':
          type = 'new_folder';
          break;
        default:
          // Identities + agent config/prompt changes aren't modeled yet.
          type = 'bug_fix';
      }

      return {
        type,
        classification: a.classification,
        resourceId: a.resourceId ?? a.resourceName,
        description: `${a.resourceKind}:${a.resourceName} - ${a.reason}`,
        layer: a.sourceLayer,
      };
    });

  const safeChanges = changes.filter((c) => c.classification === 'safe');
  const breakingChanges = changes.filter((c) => c.classification === 'breaking');

  return {
    planId: generatePlanId(),
    timestamp: new Date().toISOString(),
    agentId: currentState.agentId,
    agentName: currentState.agentName,
    role: options.role,
    channel: options.channel,
    currentState: currentState.managedState,
    targetVersions: options.targetVersions ?? {},
    actions,
    summary,
    hasChanges,
    requiresConfirmation,
    errors,
    warnings,

    // Compatibility fields
    isUpToDate: !hasChanges && errors.length === 0,
    hasBreakingChanges: breakingChanges.length > 0,
    changes,
    safeChanges,
    breakingChanges,
  };
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * Format upgrade plan as human-readable summary
 */
export function formatPlanSummary(plan: UpgradePlan): string {
  const lines: string[] = [];

  lines.push('Upgrade Plan Summary');
  lines.push('====================');
  lines.push('');
  lines.push(`Plan ID: ${plan.planId}`);
  lines.push(`Agent: ${plan.agentName ?? plan.agentId}`);
  lines.push(`Role: ${plan.role}`);
  lines.push(`Channel: ${plan.channel}`);
  lines.push(`Timestamp: ${plan.timestamp}`);
  lines.push('');

  // Target versions
  if (Object.keys(plan.targetVersions).length > 0) {
    lines.push('Target Versions:');
    for (const [layer, sha] of Object.entries(plan.targetVersions)) {
      if (sha) {
        lines.push(`  ${layer}: ${toShortSha(sha)}`);
      }
    }
    lines.push('');
  }

  // Summary
  lines.push('Actions:');
  const { summary } = plan;
  
  if (summary.blocksToAttach > 0) lines.push(`  + Blocks to attach: ${summary.blocksToAttach}`);
  if (summary.blocksToUpdate > 0) lines.push(`  ~ Blocks to update: ${summary.blocksToUpdate}`);
  if (summary.blocksToDetach > 0) lines.push(`  - Blocks to detach: ${summary.blocksToDetach}`);
  if (summary.toolsToAttach > 0) lines.push(`  + Tools to attach: ${summary.toolsToAttach}`);
  if (summary.toolsToUpdate > 0) lines.push(`  ~ Tools to update: ${summary.toolsToUpdate}`);
  if (summary.toolsToDetach > 0) lines.push(`  - Tools to detach: ${summary.toolsToDetach}`);
  if (summary.foldersToAttach > 0) lines.push(`  + Folders to attach: ${summary.foldersToAttach}`);
  if (summary.foldersToDetach > 0) lines.push(`  - Folders to detach: ${summary.foldersToDetach}`);
  if (summary.identitiesToAttach > 0) lines.push(`  + Identities to attach: ${summary.identitiesToAttach}`);
  if (summary.identitiesToDetach > 0) lines.push(`  - Identities to detach: ${summary.identitiesToDetach}`);
  if (summary.unchanged > 0) lines.push(`  = Unchanged: ${summary.unchanged}`);
  lines.push('');

  lines.push(`Safe changes: ${summary.safeChanges}`);
  lines.push(`Breaking changes: ${summary.breakingChanges}`);
  lines.push('');

  // Warnings
  if (plan.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of plan.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
    lines.push('');
  }

  // Errors
  if (plan.errors.length > 0) {
    lines.push('Errors:');
    for (const error of plan.errors) {
      lines.push(`  ✗ ${error}`);
    }
    lines.push('');
  }

  // Status
  if (!plan.hasChanges) {
    lines.push('Status: UP TO DATE - No changes needed');
  } else if (plan.requiresConfirmation) {
    lines.push('Status: CONFIRMATION REQUIRED');
    lines.push('  Run with --confirm-breaking to apply breaking changes');
  } else {
    lines.push('Status: READY TO APPLY');
    lines.push('  All changes are safe and can be auto-applied');
  }

  return lines.join('\n');
}

/**
 * Format upgrade plan with detailed action list
 */
export function formatPlanDetails(plan: UpgradePlan): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Detailed Actions:');
  lines.push('-----------------');

  // Group actions by type
  const safeActions = plan.actions.filter(a => a.classification === 'safe' && a.type !== 'skip');
  const breakingActions = plan.actions.filter(a => a.classification === 'breaking');

  if (safeActions.length > 0) {
    lines.push('');
    lines.push('Safe Changes (auto-apply):');
    for (const action of safeActions) {
      const prefix = action.type.includes('attach') ? '+' : action.type.includes('update') ? '~' : '-';
      lines.push(`  ${prefix} [${action.resourceKind}] ${action.resourceName}`);
      lines.push(`    ${action.reason}`);
      if (action.changes && action.changes.length > 0) {
        for (const change of action.changes) {
          if (change.oldValue !== undefined) {
            lines.push(`    - ${change.field}: ${truncate(String(change.oldValue), 40)}`);
          }
          if (change.newValue !== undefined) {
            lines.push(`    + ${change.field}: ${truncate(String(change.newValue), 40)}`);
          }
        }
      }
    }
  }

  if (breakingActions.length > 0) {
    lines.push('');
    lines.push('Breaking Changes (require --confirm-breaking):');
    for (const action of breakingActions) {
      const prefix = action.type.includes('attach') ? '+' : action.type.includes('update') ? '~' : '-';
      lines.push(`  ${prefix} [${action.resourceKind}] ${action.resourceName}`);
      lines.push(`    ⚠ ${action.reason}`);
      if (action.changes && action.changes.length > 0) {
        for (const change of action.changes) {
          if (change.oldValue !== undefined) {
            lines.push(`    - ${change.field}: ${truncate(String(change.oldValue), 40)}`);
          }
          if (change.newValue !== undefined) {
            lines.push(`    + ${change.field}: ${truncate(String(change.newValue), 40)}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format upgrade plan as JSON for automation
 */
export function formatPlanAsJson(plan: UpgradePlan): string {
  return JSON.stringify(plan, null, 2);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Truncate string with ellipsis
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/**
 * Get default channel for a role per spec §3
 */
export function getDefaultChannelForRole(role: AgentRole): UpgradeChannel {
  switch (role) {
    case 'lane-dev':
      return 'stable';
    case 'repo-curator':
      return 'beta';
    case 'org-curator':
      return 'stable';
    case 'supervisor':
      return 'stable';
    default:
      return 'stable';
  }
}

/**
 * Validate role/channel combination per spec §3
 */
export function validateRoleChannelCombination(
  role: AgentRole,
  channel: UpgradeChannel
): { valid: boolean; warning?: string } {
  // Per spec, org-curator on beta is discouraged
  if (role === 'org-curator' && channel === 'beta') {
    return {
      valid: true,
      warning: 'org-curator on beta channel is not recommended - org policies should be stable',
    };
  }

  return { valid: true };
}
