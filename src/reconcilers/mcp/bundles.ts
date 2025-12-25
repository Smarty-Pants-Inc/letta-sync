/**
 * Tool Attachment Bundles for MCP Reconciler
 *
 * Implements role-based tool bundles per the tool-manifest.md specification.
 * Bundles group tools for specific roles (lane-dev, repo-curator, etc.)
 * with special handling for MCP-sourced tools.
 *
 * Based on: docs/specs/tool-manifest.md, docs/specs/role-channel-matrix.md
 */

import type { Layer } from '../../registry/types.js';
import type {
  ToolAttachmentBundle,
  ToolBundleStatus,
  MCPServerClassification,
  AgentRole,
  ToolRefType,
} from './types.js';
import { MCPServerOwnership } from './types.js';

// Re-export these types for convenience
export type { AgentRole, ToolRefType };

// =============================================================================
// Bundle Types
// =============================================================================

/**
 * Single tool reference in a bundle definition
 */
export interface ToolRef {
  /** Tool name reference */
  ref: string;
  /** Reference type (inferred from ref if not specified) */
  type?: ToolRefType;
  /** MCP server name (required for mcp type) */
  mcpServer?: string;
  /** Whether tool is required (default: true for builtin/custom, false for mcp) */
  required?: boolean;
  /** Override description */
  description?: string;
}

/**
 * Conditional tool attachment based on context
 */
export interface ConditionalToolSet {
  /** Condition expression (e.g., "role == 'lane-dev'") */
  condition: string;
  /** Tools to include if condition matches */
  tools: ToolRef[];
}

/**
 * Complete tool bundle definition
 */
export interface ToolBundleDefinition {
  /** Bundle name (unique identifier) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Target role for this bundle */
  role: AgentRole;
  /** Bundle category */
  category: 'core' | 'development' | 'curation' | 'management' | 'communication';
  /** Scoping layer */
  layer: Layer;
  /** Whether reconciler manages this bundle */
  managed?: boolean;
  /** Parent bundles to inherit from */
  extends?: string[];
  /** Tool references */
  tools: ToolRef[];
  /** Conditional tools */
  conditionalTools?: ConditionalToolSet[];
  /** Version string */
  version?: string;
}

/**
 * Resolved bundle with all inherited tools
 */
export interface ResolvedBundle {
  /** Bundle name */
  name: string;
  /** Description */
  description?: string;
  /** Target role */
  role: AgentRole;
  /** All tools (including inherited) */
  tools: ToolRef[];
  /** Source bundles that contributed tools */
  sourceBundles: string[];
  /** Whether bundle can be attached (all required tools available) */
  ready: boolean;
  /** Detailed status per tool */
  toolStatus: ToolRefStatus[];
}

/**
 * Status of a single tool reference
 */
export interface ToolRefStatus {
  /** Tool reference */
  ref: string;
  /** Reference type */
  type: ToolRefType;
  /** Whether tool is available */
  available: boolean;
  /** Whether tool is required */
  required: boolean;
  /** MCP server name (if mcp type) */
  mcpServer?: string;
  /** MCP server status (if mcp type) */
  mcpServerConfigured?: boolean;
  /** Reason if not available */
  unavailableReason?: string;
}

/**
 * Bundle attachment context
 */
export interface AttachmentContext {
  /** Agent role */
  role: AgentRole;
  /** Project identifier */
  project?: string;
  /** Organization identifier */
  org?: string;
  /** Current layer */
  layer: Layer;
  /** Additional context variables for conditions */
  vars?: Record<string, unknown>;
}

/**
 * Bundle attachment result
 */
export interface BundleAttachmentResult {
  /** Bundle name */
  bundleName: string;
  /** Tools that should be attached */
  toolsToAttach: string[];
  /** Tools that are missing/unavailable */
  missingTools: ToolRefStatus[];
  /** Whether all required tools are available */
  ready: boolean;
  /** Warnings (non-blocking issues) */
  warnings: string[];
  /** Errors (blocking issues) */
  errors: string[];
}

// =============================================================================
// Built-in Tool Constants
// =============================================================================

/**
 * Letta built-in core memory tools
 */
export const BUILTIN_MEMORY_TOOLS = [
  'core_memory_append',
  'core_memory_replace',
  'archival_memory_insert',
  'archival_memory_search',
  'conversation_search',
] as const;

/**
 * Letta built-in communication tools
 */
export const BUILTIN_COMMUNICATION_TOOLS = [
  'send_message',
] as const;

/**
 * All Letta built-in tools
 */
export const BUILTIN_TOOLS = [
  ...BUILTIN_MEMORY_TOOLS,
  ...BUILTIN_COMMUNICATION_TOOLS,
] as const;

// =============================================================================
// Pre-defined Role Bundles
// =============================================================================

/**
 * Core memory tools bundle (base layer, shared by all roles)
 */
export const CORE_MEMORY_BUNDLE: ToolBundleDefinition = {
  name: 'core-memory-tools',
  description: 'Essential memory management tools for all agents',
  role: 'shared',
  category: 'core',
  layer: 'base',
  managed: true,
  version: 'v1.0.0',
  tools: [
    { ref: 'core_memory_append', type: 'builtin', required: true, description: 'Append content to a memory block' },
    { ref: 'core_memory_replace', type: 'builtin', required: true, description: 'Replace content in a memory block' },
    { ref: 'archival_memory_insert', type: 'builtin', required: false, description: 'Store information in archival memory' },
    { ref: 'archival_memory_search', type: 'builtin', required: false, description: 'Search archival memory' },
    { ref: 'conversation_search', type: 'builtin', required: false, description: 'Search conversation history' },
  ],
};

/**
 * Lane developer tools bundle
 */
export const LANE_DEVELOPER_BUNDLE: ToolBundleDefinition = {
  name: 'lane-developer-tools',
  description: 'Tools for lane developer agents',
  role: 'lane-dev',
  category: 'development',
  layer: 'org',
  managed: true,
  version: 'v1.0.0',
  extends: ['core-memory-tools'],
  tools: [
    // File Operations
    { ref: 'read_file', type: 'custom', required: true, description: 'Read file contents' },
    { ref: 'write_file', type: 'custom', required: true, description: 'Write content to file' },
    { ref: 'list_directory', type: 'custom', required: true, description: 'List directory contents' },
    { ref: 'search_files', type: 'custom', required: true, description: 'Search for files by pattern' },
    // Code Operations
    { ref: 'run_code', type: 'custom', required: true, description: 'Execute code in sandbox' },
    { ref: 'run_tests', type: 'custom', required: false, description: 'Run test suite' },
    { ref: 'lint_code', type: 'custom', required: false, description: 'Run code linter' },
    // Git Operations
    { ref: 'git_status', type: 'custom', required: true, description: 'Get git repository status' },
    { ref: 'git_commit', type: 'custom', required: true, description: 'Create git commit' },
    { ref: 'git_diff', type: 'custom', required: true, description: 'Show git diff' },
    // Communication
    { ref: 'send_message', type: 'builtin', required: true, description: 'Send message to user' },
  ],
};

/**
 * Repo curator tools bundle
 */
export const REPO_CURATOR_BUNDLE: ToolBundleDefinition = {
  name: 'repo-curator-tools',
  description: 'Tools for repository curator agents',
  role: 'repo-curator',
  category: 'curation',
  layer: 'org',
  managed: true,
  version: 'v1.0.0',
  extends: ['core-memory-tools'],
  tools: [
    // Block Management
    { ref: 'read_block', type: 'custom', required: true, description: 'Read shared memory block' },
    { ref: 'update_block', type: 'custom', required: true, description: 'Update shared memory block' },
    { ref: 'create_block', type: 'custom', required: true, description: 'Create new shared block' },
    // Documentation
    { ref: 'read_file', type: 'custom', required: true, description: 'Read documentation files' },
    { ref: 'write_file', type: 'custom', required: true, description: 'Write documentation files' },
    { ref: 'search_documentation', type: 'custom', required: true, description: 'Search project documentation' },
    // Git (Read-only)
    { ref: 'git_log', type: 'custom', required: true, description: 'View git history' },
    { ref: 'git_show', type: 'custom', required: true, description: 'Show commit details' },
    // RAG/Knowledge
    { ref: 'archival_memory_search', type: 'builtin', required: true, description: 'Search knowledge base' },
    { ref: 'archival_memory_insert', type: 'builtin', required: true, description: 'Add to knowledge base' },
  ],
};

/**
 * Org curator tools bundle
 */
export const ORG_CURATOR_BUNDLE: ToolBundleDefinition = {
  name: 'org-curator-tools',
  description: 'Tools for organization curator agents',
  role: 'org-curator',
  category: 'curation',
  layer: 'org',
  managed: true,
  version: 'v1.0.0',
  extends: ['core-memory-tools'],
  tools: [
    // Organization Block Management
    { ref: 'list_org_blocks', type: 'custom', required: true, description: 'List organization-level blocks' },
    { ref: 'read_org_block', type: 'custom', required: true, description: 'Read organization block' },
    { ref: 'update_org_block', type: 'custom', required: true, description: 'Update organization block' },
    { ref: 'create_org_block', type: 'custom', required: true, description: 'Create organization block' },
    // Policy Management
    { ref: 'list_policies', type: 'custom', required: true, description: 'List organization policies' },
    { ref: 'update_policy', type: 'custom', required: false, description: 'Update organization policy' },
    // Agent Management
    { ref: 'list_agents', type: 'custom', required: true, description: 'List agents in organization' },
    { ref: 'get_agent_status', type: 'custom', required: true, description: 'Get agent status and health' },
    // Communication
    { ref: 'broadcast_update', type: 'custom', required: false, description: 'Broadcast updates to curators' },
  ],
};

/**
 * Supervisor tools bundle
 */
export const SUPERVISOR_BUNDLE: ToolBundleDefinition = {
  name: 'supervisor-tools',
  description: 'Tools for supervisor/program manager agents',
  role: 'supervisor',
  category: 'management',
  layer: 'org',
  managed: true,
  version: 'v1.0.0',
  extends: ['core-memory-tools'],
  tools: [
    // Agent Orchestration
    { ref: 'delegate_task', type: 'custom', required: true, description: 'Delegate task to another agent' },
    { ref: 'query_agent', type: 'custom', required: true, description: 'Send query to specific agent' },
    { ref: 'get_agent_status', type: 'custom', required: true, description: 'Get agent status and workload' },
    { ref: 'coordinate_agents', type: 'custom', required: true, description: 'Coordinate multiple agents' },
    // Task Management
    { ref: 'create_task', type: 'custom', required: true, description: 'Create new task' },
    { ref: 'update_task_status', type: 'custom', required: true, description: 'Update task status' },
    { ref: 'list_tasks', type: 'custom', required: true, description: 'List active tasks' },
    // Reporting
    { ref: 'generate_report', type: 'custom', required: false, description: 'Generate progress report' },
    { ref: 'summarize_activity', type: 'custom', required: false, description: 'Summarize agent activity' },
    // Communication
    { ref: 'send_message', type: 'builtin', required: true, description: 'Send message to user' },
    { ref: 'broadcast_message', type: 'custom', required: false, description: 'Broadcast to multiple agents' },
  ],
};

/**
 * All pre-defined bundles
 */
export const PREDEFINED_BUNDLES: ToolBundleDefinition[] = [
  CORE_MEMORY_BUNDLE,
  LANE_DEVELOPER_BUNDLE,
  REPO_CURATOR_BUNDLE,
  ORG_CURATOR_BUNDLE,
  SUPERVISOR_BUNDLE,
];

/**
 * Role to default bundle mapping
 */
export const ROLE_BUNDLE_MAP: Record<AgentRole, string> = {
  'lane-dev': 'lane-developer-tools',
  'repo-curator': 'repo-curator-tools',
  'org-curator': 'org-curator-tools',
  'supervisor': 'supervisor-tools',
  'shared': 'core-memory-tools',
};

// =============================================================================
// MCP Tool Bundle Helpers
// =============================================================================

/**
 * Create an MCP tool bundle for a specific server
 */
export function createMCPToolBundle(
  serverName: string,
  toolNames: string[],
  options?: {
    description?: string;
    role?: AgentRole;
    layer?: Layer;
  }
): ToolBundleDefinition {
  return {
    name: `${serverName}-tools`,
    description: options?.description ?? `Tools from MCP server: ${serverName}`,
    role: options?.role ?? 'shared',
    category: 'development',
    layer: options?.layer ?? 'org',
    managed: false, // MCP bundles require manual setup
    version: 'v1.0.0',
    tools: toolNames.map(name => ({
      ref: name,
      type: 'mcp' as const,
      mcpServer: serverName,
      required: false, // MCP tools default to optional since setup needed
    })),
  };
}

/**
 * GitHub tools bundle template (MCP-based)
 */
export function createGitHubToolsBundle(serverName: string = 'github-server'): ToolBundleDefinition {
  return createMCPToolBundle(serverName, [
    'github_create_issue',
    'github_list_issues',
    'github_create_pr',
    'github_list_prs',
    'github_get_repo',
  ], {
    description: 'GitHub integration tools (requires MCP server setup)',
    role: 'lane-dev',
    layer: 'org',
  });
}

/**
 * Slack tools bundle template (MCP-based)
 */
export function createSlackToolsBundle(serverName: string = 'slack-server'): ToolBundleDefinition {
  return createMCPToolBundle(serverName, [
    'slack_send_message',
    'slack_list_channels',
    'slack_search_messages',
  ], {
    description: 'Slack integration tools (requires MCP server setup)',
    role: 'shared',
    layer: 'org',
  });
}

// =============================================================================
// Bundle Resolution
// =============================================================================

/**
 * Bundle registry for resolution
 */
export class BundleRegistry {
  private bundles: Map<string, ToolBundleDefinition>;

  constructor(bundles: ToolBundleDefinition[] = PREDEFINED_BUNDLES) {
    this.bundles = new Map();
    for (const bundle of bundles) {
      this.bundles.set(bundle.name, bundle);
    }
  }

  /**
   * Register a new bundle
   */
  register(bundle: ToolBundleDefinition): void {
    this.bundles.set(bundle.name, bundle);
  }

  /**
   * Get a bundle by name
   */
  get(name: string): ToolBundleDefinition | undefined {
    return this.bundles.get(name);
  }

  /**
   * Get all registered bundles
   */
  getAll(): ToolBundleDefinition[] {
    return Array.from(this.bundles.values());
  }

  /**
   * Get bundles for a specific role
   */
  getByRole(role: AgentRole): ToolBundleDefinition[] {
    return this.getAll().filter(b => b.role === role || b.role === 'shared');
  }

  /**
   * Get the default bundle for a role
   */
  getDefaultForRole(role: AgentRole): ToolBundleDefinition | undefined {
    const bundleName = ROLE_BUNDLE_MAP[role];
    return bundleName ? this.get(bundleName) : undefined;
  }
}

/**
 * Resolve a bundle with all inherited tools (flattened)
 */
export function resolveBundle(
  bundleName: string,
  registry: BundleRegistry,
  visited: Set<string> = new Set()
): ToolRef[] | null {
  // Circular dependency check
  if (visited.has(bundleName)) {
    return null;
  }
  visited.add(bundleName);

  const bundle = registry.get(bundleName);
  if (!bundle) {
    return null;
  }

  const allTools: ToolRef[] = [];

  // First, resolve inherited bundles
  if (bundle.extends) {
    for (const parentName of bundle.extends) {
      const parentTools = resolveBundle(parentName, registry, visited);
      if (parentTools) {
        allTools.push(...parentTools);
      }
    }
  }

  // Then add this bundle's tools (may override inherited)
  for (const tool of bundle.tools) {
    // Remove any existing tool with same ref (override)
    const existingIndex = allTools.findIndex(t => t.ref === tool.ref);
    if (existingIndex >= 0) {
      allTools.splice(existingIndex, 1);
    }
    allTools.push(tool);
  }

  return allTools;
}

/**
 * Evaluate a condition expression against context
 */
export function evaluateCondition(condition: string, context: AttachmentContext): boolean {
  // Simple condition evaluator
  // Supports: role == 'value', layer == 'value', has('key')
  const cleanCondition = condition.trim();

  // Role equality check
  const roleMatch = cleanCondition.match(/^role\s*==\s*['"](.+)['"]$/);
  if (roleMatch) {
    return context.role === roleMatch[1];
  }

  // Layer equality check
  const layerMatch = cleanCondition.match(/^layer\s*==\s*['"](.+)['"]$/);
  if (layerMatch) {
    return context.layer === layerMatch[1];
  }

  // Has variable check
  const hasMatch = cleanCondition.match(/^has\(['"](.+)['"]\)$/);
  if (hasMatch) {
    return context.vars?.[hasMatch[1]] !== undefined;
  }

  // Unknown condition - default to false
  return false;
}

/**
 * Resolve a bundle with conditional tools applied
 */
export function resolveBundleWithContext(
  bundleName: string,
  registry: BundleRegistry,
  context: AttachmentContext
): ResolvedBundle | null {
  const bundle = registry.get(bundleName);
  if (!bundle) {
    return null;
  }

  const baseTools = resolveBundle(bundleName, registry);
  if (!baseTools) {
    return null;
  }

  const allTools = [...baseTools];
  const sourceBundles = [bundleName];

  // Collect parent bundles
  if (bundle.extends) {
    sourceBundles.push(...bundle.extends);
  }

  // Apply conditional tools
  if (bundle.conditionalTools) {
    for (const conditional of bundle.conditionalTools) {
      if (evaluateCondition(conditional.condition, context)) {
        allTools.push(...conditional.tools);
      }
    }
  }

  // Deduplicate by ref
  const toolMap = new Map<string, ToolRef>();
  for (const tool of allTools) {
    toolMap.set(tool.ref, tool);
  }
  const deduplicatedTools = Array.from(toolMap.values());

  return {
    name: bundleName,
    description: bundle.description,
    role: bundle.role,
    tools: deduplicatedTools,
    sourceBundles,
    ready: false, // Will be set by status check
    toolStatus: [], // Will be populated by status check
  };
}

// =============================================================================
// Bundle Status Analysis
// =============================================================================

/**
 * Check the status of tools in a resolved bundle
 */
export function checkBundleStatus(
  resolvedBundle: ResolvedBundle,
  availableTools: string[],
  mcpServerClassifications: MCPServerClassification[]
): ResolvedBundle {
  const toolStatus: ToolRefStatus[] = [];
  let allRequiredAvailable = true;

  for (const tool of resolvedBundle.tools) {
    const status: ToolRefStatus = {
      ref: tool.ref,
      type: tool.type ?? inferToolType(tool.ref),
      available: false,
      required: tool.required ?? (tool.type !== 'mcp'),
    };

    if (tool.type === 'mcp') {
      status.mcpServer = tool.mcpServer;

      // Check MCP server status
      const serverClassification = mcpServerClassifications.find(
        s => s.name === tool.mcpServer
      );

      status.mcpServerConfigured = serverClassification?.ownership === MCPServerOwnership.MANAGED;

      if (!status.mcpServerConfigured) {
        status.available = false;
        status.unavailableReason = `MCP server '${tool.mcpServer}' not configured`;
      } else if (!availableTools.includes(tool.ref)) {
        status.available = false;
        status.unavailableReason = `Tool not synced from MCP server '${tool.mcpServer}'`;
      } else {
        status.available = true;
      }
    } else if (tool.type === 'builtin') {
      // Built-in tools are always available
      status.available = true;
    } else {
      // Custom tools - check if available
      status.available = availableTools.includes(tool.ref);
      if (!status.available) {
        status.unavailableReason = `Custom tool '${tool.ref}' not found`;
      }
    }

    if (status.required && !status.available) {
      allRequiredAvailable = false;
    }

    toolStatus.push(status);
  }

  return {
    ...resolvedBundle,
    ready: allRequiredAvailable,
    toolStatus,
  };
}

/**
 * Infer tool type from reference name
 */
function inferToolType(ref: string): ToolRefType {
  if (BUILTIN_TOOLS.includes(ref as typeof BUILTIN_TOOLS[number])) {
    return 'builtin';
  }
  return 'custom';
}

// =============================================================================
// Bundle Attachment Logic
// =============================================================================

/**
 * Get tools to attach for a given role
 */
export function getToolsForRole(
  role: AgentRole,
  registry: BundleRegistry,
  availableTools: string[],
  mcpServerClassifications: MCPServerClassification[] = [],
  additionalBundles: string[] = []
): BundleAttachmentResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const toolsToAttach: string[] = [];
  const missingTools: ToolRefStatus[] = [];

  // Get default bundle for role
  const defaultBundle = registry.getDefaultForRole(role);
  if (!defaultBundle) {
    errors.push(`No default bundle found for role: ${role}`);
    return {
      bundleName: `${role}-bundle`,
      toolsToAttach: [],
      missingTools: [],
      ready: false,
      warnings,
      errors,
    };
  }

  const bundleNames = [defaultBundle.name, ...additionalBundles];
  const allToolRefs: ToolRef[] = [];

  // Resolve all bundles
  for (const bundleName of bundleNames) {
    const tools = resolveBundle(bundleName, registry);
    if (tools) {
      allToolRefs.push(...tools);
    } else {
      warnings.push(`Bundle '${bundleName}' not found or has circular dependencies`);
    }
  }

  // Deduplicate
  const toolMap = new Map<string, ToolRef>();
  for (const tool of allToolRefs) {
    toolMap.set(tool.ref, tool);
  }

  // Check availability and build result
  for (const entry of Array.from(toolMap.entries())) {
    const [ref, tool] = entry;
    const type = tool.type ?? inferToolType(ref);
    const required = tool.required ?? (type !== 'mcp');

    let available = false;
    let unavailableReason: string | undefined;
    let mcpServerConfigured: boolean | undefined;

    if (type === 'builtin') {
      // Built-in tools are always available
      available = true;
      toolsToAttach.push(ref);
    } else if (type === 'mcp') {
      // Check MCP server
      const serverClassification = mcpServerClassifications.find(
        s => s.name === tool.mcpServer
      );
      mcpServerConfigured = serverClassification?.ownership === MCPServerOwnership.MANAGED;

      if (!mcpServerConfigured) {
        unavailableReason = `MCP server '${tool.mcpServer}' not configured`;
      } else if (!availableTools.includes(ref)) {
        unavailableReason = `Tool not synced from MCP server`;
      } else {
        available = true;
        toolsToAttach.push(ref);
      }
    } else {
      // Custom tool
      if (availableTools.includes(ref)) {
        available = true;
        toolsToAttach.push(ref);
      } else {
        unavailableReason = `Custom tool '${ref}' not found`;
      }
    }

    if (!available) {
      missingTools.push({
        ref,
        type,
        available: false,
        required,
        mcpServer: tool.mcpServer,
        mcpServerConfigured,
        unavailableReason,
      });

      if (required) {
        errors.push(`Required tool '${ref}' unavailable: ${unavailableReason}`);
      } else {
        warnings.push(`Optional tool '${ref}' unavailable: ${unavailableReason}`);
      }
    }
  }

  const ready = errors.length === 0;

  return {
    bundleName: defaultBundle.name,
    toolsToAttach,
    missingTools,
    ready,
    warnings,
    errors,
  };
}

/**
 * Convert ToolAttachmentBundle (from types.ts) to ToolBundleDefinition
 */
export function legacyBundleToDefinition(
  bundle: ToolAttachmentBundle,
  options?: {
    role?: AgentRole;
    layer?: Layer;
  }
): ToolBundleDefinition {
  return {
    name: bundle.name,
    description: bundle.description,
    role: options?.role ?? 'shared',
    category: 'development',
    layer: options?.layer ?? 'org',
    managed: false,
    tools: bundle.tools.map(toolName => ({
      ref: toolName,
      type: 'mcp' as const,
      mcpServer: bundle.mcpServerName,
      required: false,
    })),
  };
}

/**
 * Convert ToolBundleDefinition to legacy ToolAttachmentBundle
 * (for backward compatibility with existing code)
 */
export function definitionToLegacyBundle(
  definition: ToolBundleDefinition
): ToolAttachmentBundle | null {
  // Only convert if all tools are from same MCP server
  const mcpTools = definition.tools.filter(t => t.type === 'mcp');
  if (mcpTools.length === 0) {
    return null;
  }

  const mcpServer = mcpTools[0].mcpServer;
  if (!mcpServer || !mcpTools.every(t => t.mcpServer === mcpServer)) {
    return null;
  }

  return {
    name: definition.name,
    mcpServerName: mcpServer,
    tools: mcpTools.map(t => t.ref),
    description: definition.description,
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate a bundle definition
 */
export function validateBundleDefinition(bundle: ToolBundleDefinition): string[] {
  const errors: string[] = [];

  if (!bundle.name || bundle.name.trim() === '') {
    errors.push('Bundle name is required');
  }

  if (!bundle.role) {
    errors.push('Bundle role is required');
  }

  if (!bundle.layer) {
    errors.push('Bundle layer is required');
  }

  if (!bundle.tools || bundle.tools.length === 0) {
    errors.push('Bundle must have at least one tool');
  }

  for (const tool of bundle.tools ?? []) {
    if (!tool.ref || tool.ref.trim() === '') {
      errors.push('Tool reference is required');
    }

    if (tool.type === 'mcp' && !tool.mcpServer) {
      errors.push(`MCP tool '${tool.ref}' must specify mcpServer`);
    }
  }

  return errors;
}

/**
 * Format bundle status as human-readable text
 */
export function formatBundleStatus(result: BundleAttachmentResult): string {
  const lines: string[] = [];

  lines.push(`Bundle: ${result.bundleName}`);
  lines.push(`Status: ${result.ready ? 'READY' : 'NOT READY'}`);
  lines.push(`Tools to attach: ${result.toolsToAttach.length}`);

  if (result.toolsToAttach.length > 0) {
    lines.push('  Tools:');
    for (const tool of result.toolsToAttach) {
      lines.push(`    - ${tool}`);
    }
  }

  if (result.missingTools.length > 0) {
    lines.push('  Missing tools:');
    for (const missing of result.missingTools) {
      const requiredTag = missing.required ? ' [REQUIRED]' : '';
      lines.push(`    - ${missing.ref}${requiredTag}: ${missing.unavailableReason}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const warning of result.warnings) {
      lines.push(`    ! ${warning}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push('  Errors:');
    for (const error of result.errors) {
      lines.push(`    X ${error}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format bundle status as JSON
 */
export function formatBundleStatusJson(result: BundleAttachmentResult): string {
  return JSON.stringify(result, null, 2);
}
