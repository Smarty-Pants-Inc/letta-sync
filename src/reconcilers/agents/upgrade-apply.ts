/**
 * Agent upgrade apply logic
 *
 * Applies computed upgrade plans to agents. Enforces safe upgrade policy:
 * - Safe changes: auto-applied without confirmation
 * - Breaking changes: require explicit --force flag
 *
 * @see docs/specs/role-channel-matrix.md §4 Upgrade Policy
 */

import type { LettaClient } from '../../api/client.js';
import { ApiRequestError } from '../../api/retry.js';
import type { DesiredState, BlockResource } from '../../packages/types.js';
import type { PackageLayer, ManagedState, UpgradeType, UpgradeChannel } from './state.js';
import {
  createInitialState,
  applyPackageToState,
  serializeManagedState,
  createAppliedPackageInfo,
  MANAGED_STATE_LABEL,
  MANAGED_STATE_BLOCK_METADATA,
  MANAGED_STATE_LIMIT,
} from './state.js';
import {
  updateAppliedTags,
  ensureManagedTags,
} from './tracking.js';
import type {
  UpgradePlan,
  UpgradeAction,
  ChangeClassification,
} from './upgrade-plan.js';

/**
 * Result of a single action application
 */
export interface ApplyActionResult {
  /** The action that was applied */
  action: UpgradeAction;
  /** Whether the action succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Resource ID that was affected */
  resourceId?: string;
}

/**
 * Result of applying an upgrade plan
 */
export interface ApplyUpgradeResult {
  /** Plan ID */
  planId: string;
  /** Agent ID */
  agentId: string;
  /** Whether the upgrade succeeded */
  success: boolean;
  /** Overall error message if failed */
  error?: string;
  /** Results for each action */
  actionResults: ApplyActionResult[];
  /** Applied state after upgrade */
  appliedState?: ManagedState;
  /** Summary statistics */
  summary: {
    applied: number;
    skipped: number;
    failed: number;
  };
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Actions that were skipped (breaking without --force) */
  skippedActions: UpgradeAction[];
  /** Errors encountered */
  errors: string[];
}

/**
 * Options for applying an upgrade
 */
export interface ApplyUpgradeOptions {
  /** Don't actually apply changes, just show what would happen */
  dryRun: boolean;
  /** Force breaking changes without confirmation */
  force?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Package version (git SHA) to stamp on synced state */
  packageVersion?: string;
  /** Package paths by layer */
  packagePaths?: Partial<Record<PackageLayer, string>>;

  /** Optional desired state so block updates/attachments can be precise */
  desiredState?: DesiredState;
}

function findDesiredBlock(desiredState: DesiredState | undefined, label: string): BlockResource | undefined {
  return desiredState?.blocks?.find((b) => b.spec.label === label);
}

/**
 * Extended Letta client interface with agent operations
 */
export interface LettaAgentClient extends LettaClient {
  // Extend the read-only AgentsClient with the additional write operations
  // needed for applying upgrades.
  agents: LettaClient['agents'] & {
    // Legacy alias used by some older codepaths
    get?(agentId: string): Promise<AgentResponse>;

    update?(agentId: string, request: UpdateAgentRequest): Promise<AgentResponse>;
    attachBlock?(agentId: string, blockId: string): Promise<void>;
    detachBlock?(agentId: string, blockId: string): Promise<void>;
    attachTool?(agentId: string, toolId: string): Promise<void>;
    detachTool?(agentId: string, toolId: string): Promise<void>;
    attachFolder?(agentId: string, folderId: string): Promise<void>;
    attachSource?(agentId: string, sourceId: string): Promise<void>;
  };
}

/**
 * Agent response from Letta API
 */
export interface AgentResponse {
  id: string;
  name: string;
  tags?: string[];
  memory?: {
    blocks?: Array<{
      id: string;
      label: string;
    }>;
  };
  tools?: Array<{
    id: string;
    name: string;
  }>;
}

/**
 * Update agent request
 */
export interface UpdateAgentRequest {
  name?: string;
  tags?: string[];
  system?: string;
}

/**
 * Error for upgrade failures
 */
export class UpgradeError extends Error {
  constructor(
    message: string,
    public readonly code: UpgradeErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'UpgradeError';
  }
}

/**
 * Error codes for upgrade failures
 */
export type UpgradeErrorCode =
  | 'BREAKING_CHANGES_REQUIRE_FORCE'
  | 'PINNED_CHANNEL_NO_AUTO'
  | 'APPLY_FAILED'
  | 'STATE_UPDATE_FAILED'
  | 'AGENT_NOT_FOUND'
  | 'RESOURCE_NOT_FOUND';

/**
 * Check if upgrade can proceed based on policy
 */
export function canProceedWithUpgrade(
  plan: UpgradePlan,
  options: ApplyUpgradeOptions
): { canProceed: boolean; reason?: string } {
  // Pinned channel never auto-applies (except security patches)
  if (plan.channel === 'pinned' && !options.force) {
    return {
      canProceed: false,
      reason: 'Agent is on pinned channel. Use --force to apply upgrades manually.',
    };
  }

  // Breaking changes require --force
  if (plan.summary.breakingChanges > 0 && !options.force) {
    const breakingActions = plan.actions.filter(a => a.classification === 'breaking');
    const breakingList = breakingActions
      .map(a => `  - ${a.resourceKind}: ${a.resourceName} (${a.reason})`)
      .join('\n');
    return {
      canProceed: false,
      reason: `Upgrade contains ${plan.summary.breakingChanges} breaking change(s):\n${breakingList}\n\nUse --force to apply breaking changes.`,
    };
  }

  return { canProceed: true };
}

/**
 * Check if plan requires the --force flag
 */
export function requiresForce(plan: UpgradePlan): boolean {
  return plan.summary.breakingChanges > 0 || plan.channel === 'pinned';
}

/**
 * Apply a single block attachment action
 */
async function applyBlockAttach(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean,
  desiredState?: DesiredState
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  try {
    // Prefer the managed block matching our manifest source.
    const desired = findDesiredBlock(desiredState, action.resourceName);
    const sourceKey = desired?.metadata?.name;

    const blocks = await client.blocks.list({ label: action.resourceName, limit: 200 } as any);
    if (blocks.length === 0) {
      return { action, success: false, error: `Block not found: ${action.resourceName}` };
    }

    const chosen = sourceKey
      ? (blocks.find((b: any) => b?.metadata?.managed_by === 'smarty-admin' && b?.metadata?.source === sourceKey) ?? blocks[0])
      : blocks[0];

    if (!client.agents.attachBlock) throw new UpgradeError('agents.attachBlock not implemented', 'APPLY_FAILED');

    try {
      await client.agents.attachBlock(agentId, chosen.id);
    } catch (err) {
      // Treat "already attached" as success for idempotency.
      if (err instanceof ApiRequestError && err.status === 409) {
        return { action, success: true, resourceId: chosen.id };
      }
      throw err;
    }

    return { action, success: true, resourceId: chosen.id };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single block update action (updates the block resource to match desired state)
 */
async function applyBlockUpdate(
  client: LettaAgentClient,
  action: UpgradeAction,
  dryRun: boolean,
  desiredState?: DesiredState
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  const desired = findDesiredBlock(desiredState, action.resourceName);
  if (!desired) {
    // Without desired state, we can't safely update content.
    return { action, success: true };
  }

  try {
    // Prefer updating the exact block that is attached to the agent (resourceId)
    // so we don't accidentally mutate a different block with the same label.
    const blockId = action.resourceId;
    if (!blockId) {
      return { action, success: false, error: 'Missing resourceId for update_block' };
    }

    await client.blocks.update(blockId, {
      value: desired.spec.value,
      description: desired.metadata.description,
      limit: desired.spec.limit,
    } as any);

    return { action, success: true, resourceId: blockId };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single block detachment action
 */
async function applyBlockDetach(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  try {
    if (!action.resourceId) {
      // Look up block by label
      const blocks = await client.blocks.list({ label: action.resourceName });
      if (blocks.length === 0) {
        // Block doesn't exist - consider success (idempotent)
        return { action, success: true };
      }
      action.resourceId = blocks[0].id;
    }

    if (!client.agents.detachBlock) throw new UpgradeError('agents.detachBlock not implemented', 'APPLY_FAILED');
    try {
      await client.agents.detachBlock(agentId, action.resourceId);
    } catch (err) {
      // Treat "already detached" as success if the server responds with conflict.
      if (err instanceof ApiRequestError && err.status === 409) {
        return { action, success: true, resourceId: action.resourceId };
      }
      throw err;
    }

    return {
      action,
      success: true,
      resourceId: action.resourceId,
    };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single tool attachment action
 */
async function applyToolAttach(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  try {
    // For now, we assume tool ID is passed in resourceId
    // In real implementation, would need tool lookup
    const toolId = action.resourceId ?? action.resourceName;
    if (!client.agents.attachTool) throw new UpgradeError('agents.attachTool not implemented', 'APPLY_FAILED');
    await client.agents.attachTool(agentId, toolId);

    return {
      action,
      success: true,
      resourceId: toolId,
    };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single tool detachment action
 */
async function applyToolDetach(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  try {
    const toolId = action.resourceId ?? action.resourceName;
    if (!client.agents.detachTool) throw new UpgradeError('agents.detachTool not implemented', 'APPLY_FAILED');
    await client.agents.detachTool(agentId, toolId);

    return {
      action,
      success: true,
      resourceId: toolId,
    };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single folder attachment action
 */
async function applyFolderAttach(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean
): Promise<ApplyActionResult> {
  if (dryRun) {
    return { action, success: true };
  }

  try {
    const folderId = action.resourceId ?? action.resourceName;
    if (!client.agents.attachFolder) throw new UpgradeError('agents.attachFolder not implemented', 'APPLY_FAILED');
    await client.agents.attachFolder(agentId, folderId);

    return {
      action,
      success: true,
      resourceId: folderId,
    };
  } catch (err) {
    return {
      action,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply a single action based on its type
 */
async function applyAction(
  client: LettaAgentClient,
  agentId: string,
  action: UpgradeAction,
  dryRun: boolean,
  desiredState?: DesiredState
): Promise<ApplyActionResult> {
  switch (action.type) {
    case 'attach_block':
      return applyBlockAttach(client, agentId, action, dryRun, desiredState);

    case 'update_block':
      return applyBlockUpdate(client, action, dryRun, desiredState);

    case 'detach_block':
      return applyBlockDetach(client, agentId, action, dryRun);

    case 'attach_tool':
      return applyToolAttach(client, agentId, action, dryRun);

    case 'update_tool':
      return applyToolAttach(client, agentId, action, dryRun);

    case 'detach_tool':
      return applyToolDetach(client, agentId, action, dryRun);

    case 'attach_folder':
      return applyFolderAttach(client, agentId, action, dryRun);

    case 'skip':
      return { action, success: true };

    default:
      return {
        action,
        success: false,
        error: `Unsupported action type: ${action.type}`,
      };
  }
}

/**
 * Update agent tags with applied versions
 */
async function updateAgentTags(
  client: LettaAgentClient,
  agentId: string,
  plan: UpgradePlan,
  _options: ApplyUpgradeOptions,
  dryRun: boolean
): Promise<{ success: boolean; error?: string; tags?: string[] }> {
  if (dryRun) {
    return { success: true };
  }

  try {
    // Get current agent
    if (!client.agents.get) throw new UpgradeError('agents.get not implemented', 'APPLY_FAILED');
    const agent = await client.agents.get(agentId);
    const currentTags = agent.tags ?? [];

    // Build applied version updates
    const versionUpdates: Partial<Record<PackageLayer, string>> = {};
    for (const [layer, version] of Object.entries(plan.targetVersions)) {
      if (version) {
        versionUpdates[layer as PackageLayer] = version;
      }
    }

    // Update applied tags
    let newTags = updateAppliedTags(currentTags, versionUpdates);

    // Ensure managed tags are present
    newTags = ensureManagedTags(newTags, {
      channel: plan.channel,
      role: plan.role,
    });

    // Update agent
    if (!client.agents.update) throw new UpgradeError('agents.update not implemented', 'APPLY_FAILED');
    await client.agents.update(agentId, { tags: newTags });

    return { success: true, tags: newTags };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Update or create the managed_state block
 */
async function updateManagedStateBlock(
  client: LettaAgentClient,
  agentId: string,
  plan: UpgradePlan,
  options: ApplyUpgradeOptions,
  upgradeType: UpgradeType,
  dryRun: boolean
): Promise<{ success: boolean; error?: string; state?: ManagedState }> {
  if (dryRun) {
    // Return what the state would be
    let newState = plan.currentState ?? createInitialState(plan.channel);
    for (const [layer, version] of Object.entries(plan.targetVersions)) {
      if (version && options.packagePaths?.[layer as PackageLayer]) {
        newState = applyPackageToState(
          newState,
          layer as PackageLayer,
          createAppliedPackageInfo(version, options.packagePaths[layer as PackageLayer]!),
          upgradeType
        );
      }
    }
    return { success: true, state: newState };
  }

  try {
    // Build new state
    let newState = plan.currentState ?? createInitialState(plan.channel);
    for (const [layer, version] of Object.entries(plan.targetVersions)) {
      if (version) {
        const packagePath = options.packagePaths?.[layer as PackageLayer] ?? `packages/${layer}`;
        newState = applyPackageToState(
          newState,
          layer as PackageLayer,
          createAppliedPackageInfo(version, packagePath),
          upgradeType
        );
      }
    }

    // Serialize to YAML
    const blockValue = serializeManagedState(newState);

    // managed_state is lane-private per agent. We store one per agent using a
    // disambiguating metadata.source.
    const sourceKey = `managed_state:${agentId}`;

    // Find or create the correct managed_state block.
    const existingBlocks = await client.blocks.list({ label: MANAGED_STATE_LABEL, limit: 200 } as any);
    const matching = (existingBlocks as any[]).find(
      (b) => b?.metadata?.managed_by === 'smarty-admin' && b?.metadata?.source === sourceKey
    );

    let blockId: string;
    if (matching?.id) {
      blockId = matching.id;
      await client.blocks.update(blockId, {
        value: blockValue,
        metadata: { ...MANAGED_STATE_BLOCK_METADATA, source: sourceKey },
      } as any);
    } else {
      const newBlock = await client.blocks.create({
        label: MANAGED_STATE_LABEL,
        value: blockValue,
        description: MANAGED_STATE_BLOCK_METADATA.description,
        metadata: { ...MANAGED_STATE_BLOCK_METADATA, source: sourceKey },
        limit: MANAGED_STATE_LIMIT,
      });
      blockId = newBlock.id;
    }

    // Ensure the correct managed_state block is attached to this agent.
    if (!client.agents.attachBlock) throw new UpgradeError('agents.attachBlock not implemented', 'APPLY_FAILED');
    const agentBlocks = (client as any).agents?.listBlocks ? await (client as any).agents.listBlocks(agentId) : [];
    const attachedIds = new Set((agentBlocks ?? []).map((b: any) => b?.id).filter((id: any) => typeof id === 'string'));
    if (!attachedIds.has(blockId)) {
      await client.agents.attachBlock(agentId, blockId);
    }

    return { success: true, state: newState };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply an upgrade plan to an agent
 *
 * Enforces the safe upgrade policy:
 * - Safe changes are auto-applied
 * - Breaking changes require --force flag
 * - Pinned channel agents require --force for any changes
 */
export async function applyUpgradePlan(
  client: LettaAgentClient,
  plan: UpgradePlan,
  options: ApplyUpgradeOptions
): Promise<ApplyUpgradeResult> {
  const result: ApplyUpgradeResult = {
    planId: plan.planId,
    agentId: plan.agentId,
    success: true,
    actionResults: [],
    summary: {
      applied: 0,
      skipped: 0,
      failed: 0,
    },
    dryRun: options.dryRun,
    skippedActions: [],
    errors: [],
  };

  // If already up to date, still continue so we can stamp tracking tags and
  // managed_state on first run.

  // Check upgrade policy
  const policyCheck = canProceedWithUpgrade(plan, options);
  if (!policyCheck.canProceed) {
    if (options.force) {
      // Force flag overrides policy
    } else {
      // Return with skipped breaking changes
      result.success = false;
      result.error = policyCheck.reason;
      
      // Separate safe and breaking actions
      const safeActions = plan.actions.filter(a => a.classification === 'safe' && a.type !== 'skip');
      const breakingActions = plan.actions.filter(a => a.classification === 'breaking');
      
      result.skippedActions = breakingActions;
      result.summary.skipped = breakingActions.length;
      
      // Still apply safe changes if any
      for (const action of safeActions) {
        const actionResult = await applyAction(
          client,
          plan.agentId,
          action,
          options.dryRun,
          options.desiredState
        );
        result.actionResults.push(actionResult);
        if (actionResult.success) {
          result.summary.applied++;
        } else {
          result.summary.failed++;
          if (actionResult.error) {
            result.errors.push(`${action.resourceKind} ${action.resourceName}: ${actionResult.error}`);
          }
        }
      }
      
      return result;
    }
  }

  // Determine which actions to apply
  const actionsToApply = options.force 
    ? plan.actions.filter(a => a.type !== 'skip')
    : plan.actions.filter(a => a.classification === 'safe' && a.type !== 'skip');
  const actionsToSkip = options.force 
    ? [] 
    : plan.actions.filter(a => a.classification === 'breaking');
  
  result.skippedActions = actionsToSkip;
  result.summary.skipped = actionsToSkip.length;

  // Apply each action
  for (const action of actionsToApply) {
    const actionResult = await applyAction(
      client,
      plan.agentId,
      action,
      options.dryRun,
      options.desiredState
    );
    result.actionResults.push(actionResult);

    if (actionResult.success) {
      result.summary.applied++;
    } else {
      result.summary.failed++;
      result.success = false;
      if (actionResult.error) {
        result.errors.push(`${action.resourceKind} ${action.resourceName}: ${actionResult.error}`);
      }
    }
  }

  // Update tags (only if not dry-run and we have changes)
  if (!options.dryRun) {
    const tagResult = await updateAgentTags(
      client,
      plan.agentId,
      plan,
      options,
      options.dryRun
    );
    if (!tagResult.success) {
      result.errors.push(`Failed to update tags: ${tagResult.error}`);
    }
  }

  // Update managed_state block
  const upgradeType: UpgradeType = options.force ? 'breaking_manual' : 'safe_auto';
  const stateResult = await updateManagedStateBlock(
    client,
    plan.agentId,
    plan,
    options,
    upgradeType,
    options.dryRun
  );

  if (stateResult.success) {
    result.appliedState = stateResult.state;
  } else {
    result.errors.push(`Failed to update managed_state: ${stateResult.error}`);
    // Don't fail the whole upgrade for state update failure
  }

  // Overall success requires no failures
  result.success = result.summary.failed === 0 && result.errors.length === 0;

  return result;
}

/**
 * Preview what an upgrade would do (always dry-run)
 */
export async function previewUpgrade(
  client: LettaAgentClient,
  plan: UpgradePlan,
  options: Omit<ApplyUpgradeOptions, 'dryRun'>
): Promise<ApplyUpgradeResult> {
  return applyUpgradePlan(client, plan, { ...options, dryRun: true });
}

/**
 * Format upgrade result for display
 */
export function formatUpgradeResult(result: ApplyUpgradeResult): string {
  const lines: string[] = [];

  if (result.dryRun) {
    lines.push('[DRY RUN] No changes applied\n');
  }

  // Summary
  lines.push(`Applied: ${result.summary.applied}`);
  lines.push(`Skipped: ${result.summary.skipped}`);
  lines.push(`Failed: ${result.summary.failed}`);

  // Skipped actions (breaking without --force)
  if (result.skippedActions.length > 0) {
    lines.push('\nSkipped breaking changes (use --force to apply):');
    for (const action of result.skippedActions) {
      lines.push(`  - [${action.resourceKind}] ${action.resourceName}: ${action.reason}`);
    }
  }

  // Errors
  if (result.errors.length > 0) {
    lines.push('\nErrors:');
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
  }

  return lines.join('\n');
}
