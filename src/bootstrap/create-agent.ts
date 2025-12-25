/**
 * Agent Creation from Templates
 *
 * Creates agents from Letta templates with proper tagging, project scoping,
 * and identity attachment.
 *
 * Key capabilities:
 * - Template resolution by name or role
 * - Tag application per naming conventions
 * - Identity attachment via identifier_keys
 * - Project scoping via registry
 *
 * @see docs/research/template-lifecycle-research.md
 * @see docs/research/letta-api-reference.md
 */

import type { ResolvedProject } from './project-resolver.js';
import {
  resolveIdentitiesForAgent,
  type AttachIdentityOptions,
  type AttachIdentityResult,
  type LettaIdentityClientWithCreate,
} from '../reconcilers/agents/identity.js';
import type { LettaIdentity as ReconcilerLettaIdentity } from '../reconcilers/identities/types.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Tag naming conventions for managed agents
 */
export const TAG_PREFIXES = {
  /** Role tag prefix (e.g., role:assistant, role:moderator) */
  ROLE: 'role:',
  /** Channel tag prefix (e.g., channel:stable, channel:beta) */
  CHANNEL: 'channel:',
  /** Managed by smarty-admin marker */
  MANAGED: 'managed:smarty-admin',
  /** Template origin tag prefix (e.g., template:smarty-assistant) */
  TEMPLATE: 'template:',
  /** Project scope tag prefix (e.g., project:smarty-pants-main) */
  PROJECT: 'project:',
  /** Organization scope tag prefix (e.g., org:smarty-pants) */
  ORG: 'org:',
} as const;

/**
 * Template information for agent creation
 */
export interface TemplateInfo {
  /** Template ID in Letta */
  id: string;
  /** Base template ID (template family) */
  baseTemplateId: string;
  /** Template version ID */
  templateId: string;
  /** Template name for display */
  name: string;
  /** Template description */
  description?: string;
  /** Default role for agents created from this template */
  defaultRole?: string;
}

/**
 * Options for creating an agent from a template
 */
export interface CreateAgentOptions {
  /** Agent name */
  name: string;
  /** Template name or ID to use */
  template: string;
  /** Agent role (e.g., 'assistant', 'moderator') */
  role?: string;
  /** Release channel (stable, beta, pinned) */
  channel?: 'stable' | 'beta' | 'pinned';
  /** Identity handles or identifier_keys to attach */
  identities?: string[];
  /** Auto-create user identities if not found */
  autoCreateIdentity?: boolean;
  /** Additional tags to apply */
  additionalTags?: string[];
  /** Additional metadata for the agent */
  metadata?: Record<string, unknown>;
  /** Resolved project information */
  project: ResolvedProject;
}

/**
 * Result of agent creation
 */
export interface CreateAgentResult {
  /** Whether creation succeeded */
  success: boolean;
  /** Agent ID if created */
  agentId?: string;
  /** Agent name */
  agentName: string;
  /** Tags applied to the agent */
  appliedTags: string[];
  /** Identity attachment result */
  identityResult?: AttachIdentityResult;
  /** Template used for creation */
  templateUsed?: TemplateInfo;
  /** Error messages if any */
  errors: string[];
  /** Warning messages */
  warnings: string[];
}

/**
 * Letta client interface for agent creation
 * Extends the identity client with agent-specific operations
 */
export interface AgentCreationClient extends LettaIdentityClientWithCreate {
  agents: {
    /** List agents with filters */
    list(params: {
      name?: string;
      tags?: string[];
      project_id?: string;
      base_template_id?: string;
      template_id?: string;
      limit?: number;
    }): Promise<AgentState[]>;
    /** Create a new agent */
    create(params: CreateAgentParams): Promise<AgentState>;
    /** Update an existing agent */
    update(
      agentId: string,
      params: UpdateAgentParams
    ): Promise<AgentState>;
    /** Retrieve agent by ID */
    retrieve(agentId: string): Promise<AgentState>;
  };
}

/**
 * Agent state from Letta API
 */
export interface AgentState {
  id: string;
  name: string;
  tags?: string[];
  identity_ids?: string[];
  template_id?: string;
  base_template_id?: string;
  project_id?: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/**
 * Parameters for creating an agent via Letta API
 */
export interface CreateAgentParams {
  name: string;
  tags?: string[];
  identity_ids?: string[];
  template_id?: string;
  base_template_id?: string;
  deployment_id?: string;
  entity_id?: string;
  metadata?: Record<string, unknown>;
  /** System prompt (may come from template) */
  system_prompt?: string;
  /** Tool IDs to attach */
  tool_ids?: string[];
  /** Block IDs to attach */
  block_ids?: string[];
  /** Model handle to use */
  model?: string;
  /** Embedding model handle to use */
  embedding?: string;
  /** Full embedding config (optional) */
  embedding_config?: unknown;
}

/**
 * Parameters for updating an agent via Letta API
 */
export interface UpdateAgentParams {
  name?: string;
  tags?: string[];
  identity_ids?: string[];
  template_id?: string;
  base_template_id?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Re-export LettaIdentity from reconcilers for convenience
 */
export type LettaIdentity = ReconcilerLettaIdentity;

// =============================================================================
// Tag Building
// =============================================================================

/**
 * Build standard tags for a managed agent
 *
 * @param options - Tag building options
 * @returns Array of tags to apply
 */
export function buildAgentTags(options: {
  role?: string;
  channel?: 'stable' | 'beta' | 'pinned';
  template?: string;
  project?: string;
  org?: string;
  additionalTags?: string[];
}): string[] {
  const tags: string[] = [];

  // Always mark as managed by smarty-admin
  tags.push(TAG_PREFIXES.MANAGED);

  // Role tag
  if (options.role) {
    tags.push(`${TAG_PREFIXES.ROLE}${options.role}`);
  }

  // Channel tag
  if (options.channel) {
    tags.push(`${TAG_PREFIXES.CHANNEL}${options.channel}`);
  }

  // Template origin tag
  if (options.template) {
    tags.push(`${TAG_PREFIXES.TEMPLATE}${options.template}`);
  }

  // Project scope tag
  if (options.project) {
    tags.push(`${TAG_PREFIXES.PROJECT}${options.project}`);
  }

  // Organization scope tag
  if (options.org) {
    tags.push(`${TAG_PREFIXES.ORG}${options.org}`);
  }

  // Additional custom tags
  if (options.additionalTags) {
    tags.push(...options.additionalTags);
  }

  return tags;
}

/**
 * Parse tags from an agent to extract structured information
 *
 * @param tags - Array of tags from agent
 * @returns Parsed tag information
 */
export function parseAgentTags(tags: string[]): {
  isManaged: boolean;
  role?: string;
  channel?: string;
  template?: string;
  project?: string;
  org?: string;
  customTags: string[];
} {
  const result: ReturnType<typeof parseAgentTags> = {
    isManaged: false,
    customTags: [],
  };

  for (const tag of tags) {
    if (tag === TAG_PREFIXES.MANAGED) {
      result.isManaged = true;
    } else if (tag.startsWith(TAG_PREFIXES.ROLE)) {
      result.role = tag.slice(TAG_PREFIXES.ROLE.length);
    } else if (tag.startsWith(TAG_PREFIXES.CHANNEL)) {
      result.channel = tag.slice(TAG_PREFIXES.CHANNEL.length);
    } else if (tag.startsWith(TAG_PREFIXES.TEMPLATE)) {
      result.template = tag.slice(TAG_PREFIXES.TEMPLATE.length);
    } else if (tag.startsWith(TAG_PREFIXES.PROJECT)) {
      result.project = tag.slice(TAG_PREFIXES.PROJECT.length);
    } else if (tag.startsWith(TAG_PREFIXES.ORG)) {
      result.org = tag.slice(TAG_PREFIXES.ORG.length);
    } else {
      result.customTags.push(tag);
    }
  }

  return result;
}

// =============================================================================
// Template Resolution
// =============================================================================

/**
 * Template resolution result
 */
export interface TemplateResolutionResult {
  success: boolean;
  template?: TemplateInfo;
  error?: string;
}

/**
 * Resolve a template by name or role
 *
 * This function looks up templates in the Letta API by:
 * 1. Exact name match
 * 2. Role-based lookup (if name not found)
 * 3. Fuzzy matching as fallback
 *
 * For now, we return a mock/stub since the template listing API
 * requires internal endpoints. In production, this would query:
 * - `GET /v1/agents?templates_only=true` (if available)
 * - Or internal template registry
 *
 * @param client - Letta client (unused in stub)
 * @param nameOrRole - Template name or role to search for
 * @param project - Project context for scoping
 * @returns Resolution result with template info
 */
export async function resolveTemplate(
  _client: AgentCreationClient,
  nameOrRole: string,
  project: ResolvedProject
): Promise<TemplateResolutionResult> {
  // For MVP, we generate template IDs based on naming convention
  // In production, this would query the Letta API
  
  const normalizedName = nameOrRole.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const baseTemplateId = `${project.orgSlug ?? 'default'}-${normalizedName}`;
  const templateId = `${baseTemplateId}:latest`;

  // TODO: Query Letta API for actual template
  // const templates = await client.agents.list({
  //   templates_only: true,
  //   name: nameOrRole,
  // });
  // if (templates.length > 0) {
  //   return {
  //     success: true,
  //     template: {
  //       id: templates[0].id,
  //       baseTemplateId: templates[0].base_template_id!,
  //       templateId: templates[0].template_id!,
  //       name: templates[0].name,
  //     },
  //   };
  // }

  return {
    success: true,
    template: {
      id: `template-${normalizedName}`,
      baseTemplateId,
      templateId,
      name: nameOrRole,
      defaultRole: normalizedName.includes('assistant') ? 'assistant' : undefined,
    },
  };
}

// =============================================================================
// Agent Creation
// =============================================================================

/**
 * Check if an agent with the given name already exists
 *
 * @param client - Letta client
 * @param name - Agent name to check
 * @param projectSlug - Project scope (optional)
 * @returns Existing agent if found, null otherwise
 */
export async function findExistingAgent(
  client: AgentCreationClient,
  name: string,
  projectSlug?: string
): Promise<AgentState | null> {
  try {
    const agents = await client.agents.list({
      name,
      project_id: projectSlug,
      limit: 1,
    });
    return agents.length > 0 ? agents[0] : null;
  } catch {
    // If listing fails, assume no existing agent
    return null;
  }
}

/**
 * Generate a unique deployment ID for agent creation
 *
 * Deployment IDs are used to group related entities (agents, blocks, groups)
 * that are deployed together from a template.
 *
 * @param projectSlug - Project slug for scoping
 * @param agentName - Agent name for identification
 * @returns Generated deployment ID
 */
export function generateDeploymentId(
  projectSlug: string,
  agentName: string
): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `deploy-${projectSlug}-${agentName}-${timestamp}-${random}`;
}

/**
 * Generate an entity ID for the agent within a template deployment
 *
 * Entity IDs are stable identifiers that map entities across template versions.
 *
 * @param role - Agent role
 * @returns Generated entity ID
 */
export function generateEntityId(role: string): string {
  return `agent-${role}`;
}

/**
 * Create an agent from a template
 *
 * This is the main entry point for creating agents from templates.
 * It handles:
 * 1. Template resolution
 * 2. Checking for existing agents
 * 3. Building appropriate tags
 * 4. Creating the agent via Letta API
 * 5. Attaching identities
 *
 * @param client - Letta client with agent and identity operations
 * @param options - Agent creation options
 * @returns Creation result with agent ID and status
 */
export async function createAgentFromTemplate(
  client: AgentCreationClient,
  options: CreateAgentOptions
): Promise<CreateAgentResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const {
    name,
    template,
    role,
    channel = 'stable',
    identities = [],
    autoCreateIdentity = true,
    additionalTags = [],
    metadata = {},
    project,
  } = options;

  // 1. Resolve template
  const templateResult = await resolveTemplate(client, template, project);
  if (!templateResult.success || !templateResult.template) {
    return {
      success: false,
      agentName: name,
      appliedTags: [],
      errors: [templateResult.error ?? `Template "${template}" not found`],
      warnings: [],
    };
  }

  const templateInfo = templateResult.template;
  const effectiveRole = role ?? templateInfo.defaultRole ?? 'agent';

  // 2. Check for existing agent
  const existingAgent = await findExistingAgent(
    client,
    name,
    project.projectSlug
  );
  if (existingAgent) {
    return {
      success: false,
      agentId: existingAgent.id,
      agentName: name,
      appliedTags: existingAgent.tags ?? [],
      templateUsed: templateInfo,
      errors: [
        `Agent "${name}" already exists (ID: ${existingAgent.id}). ` +
          `Use upgrade command to update existing agents.`,
      ],
      warnings: [],
    };
  }

  // 3. Build tags
  const tags = buildAgentTags({
    role: effectiveRole,
    channel,
    template: templateInfo.name,
    project: project.projectSlug,
    org: project.orgSlug,
    additionalTags,
  });

  // 4. Resolve identities
  let identityResult: AttachIdentityResult | undefined;
  const identityIds: string[] = [];

  if (identities.length > 0) {
    const identityOptions: AttachIdentityOptions = {
      org: project.orgSlug ?? 'default',
      autoCreate: autoCreateIdentity,
      createdBy: 'agent-bootstrap',
    };

    identityResult = await resolveIdentitiesForAgent(
      client,
      identities,
      identityOptions
    );

    if (identityResult.success) {
      identityIds.push(...identityResult.identityIds);
    } else {
      // Identity resolution failed - continue but with warnings
      warnings.push(...identityResult.errors);
    }
  }

  // 5. Create the agent
  const deploymentId = generateDeploymentId(project.projectSlug, name);
  const entityId = generateEntityId(effectiveRole);

  const createParams: CreateAgentParams = {
    name,
    tags,
    identity_ids: identityIds.length > 0 ? identityIds : undefined,
    template_id: templateInfo.templateId,
    base_template_id: templateInfo.baseTemplateId,
    deployment_id: deploymentId,
    entity_id: entityId,
    // Self-hosted Letta requires an explicit model or llm_config.
    // Project policy: default to a strong model (Sonnet 4.5) for all agents.
    // Individual flows (e.g. E2E orchestrator) can override via LETTA_DEFAULT_MODEL.
    model:
      process.env.LETTA_DEFAULT_MODEL ??
      process.env.LETTA_MODEL ??
      'anthropic/claude-sonnet-4-5-20250929',
    embedding: process.env.LETTA_DEFAULT_EMBEDDING ?? process.env.LETTA_EMBEDDING ?? 'openai/text-embedding-3-small',
    metadata: {
      ...metadata,
      // Track bootstrap metadata
      bootstrap: {
        createdAt: new Date().toISOString(),
        template: templateInfo.name,
        role: effectiveRole,
        channel,
        reconcilerVersion: '1.0.0',
      },
    },
  };

  try {
    const agent = await client.agents.create(createParams);

    return {
      success: true,
      agentId: agent.id,
      agentName: name,
      appliedTags: tags,
      identityResult,
      templateUsed: templateInfo,
      errors: [],
      warnings,
    };
  } catch (error) {
    return {
      success: false,
      agentName: name,
      appliedTags: tags,
      identityResult,
      templateUsed: templateInfo,
      errors: [
        `Failed to create agent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
      warnings,
    };
  }
}

// =============================================================================
// Dry Run Support
// =============================================================================

/**
 * Preview agent creation without actually creating
 *
 * @param options - Agent creation options
 * @returns Simulated result showing what would be created
 */
export function previewAgentCreation(
  options: CreateAgentOptions
): CreateAgentResult {
  const {
    name,
    template,
    role,
    channel = 'stable',
    additionalTags = [],
    project,
    identities = [],
  } = options;

  // Build the same tags that would be applied
  const tags = buildAgentTags({
    role: role ?? 'agent',
    channel,
    template,
    project: project.projectSlug,
    org: project.orgSlug,
    additionalTags,
  });

  return {
    success: true,
    agentName: name,
    appliedTags: tags,
    templateUsed: {
      id: `template-${template}`,
      baseTemplateId: `${project.orgSlug ?? 'default'}-${template}`,
      templateId: `${project.orgSlug ?? 'default'}-${template}:latest`,
      name: template,
    },
    errors: [],
    warnings: identities.length > 0
      ? [`Would resolve ${identities.length} identity/identities`]
      : [],
  };
}
