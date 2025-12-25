/**
 * Letta API Client
 *
 * Provides a typed interface to the Letta REST API with:
 * - Retry with exponential backoff
 * - Rate limit handling (429 status)
 * - JSON logging with secret redaction
 * - Project scoping via X-Project header
 */

import type {
  Block,
  CreateBlockRequest,
  UpdateBlockRequest,
  Identity,
  CreateIdentityRequest,
  Tool,
  CreateToolRequest,
  Folder,
  CreateFolderRequest,
  AgentState,
  PaginationParams,
  LettaClientConfig,
  LettaSettings,
  HttpMethod,
  RequestConfig,
} from './types.js';
import {
  withRetry,
  ApiRequestError,
  parseRetryAfter,
  DEFAULT_RETRY_CONFIG,
  type RetryOptions,
} from './retry.js';
import { logger, ApiLogger, redactString } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'node:child_process';

// =============================================================================
// Types
// =============================================================================

/**
 * List blocks filter options
 * Note: Both camelCase and snake_case are supported for backwards compatibility
 */
export interface ListBlocksOptions extends PaginationParams {
  label?: string;
  labelSearch?: string;
  label_search?: string; // Backwards compat alias
  descriptionSearch?: string;
  description_search?: string; // Backwards compat alias
  valueSearch?: string;
  value_search?: string; // Backwards compat alias
  templatesOnly?: boolean;
  templates_only?: boolean; // Backwards compat alias
  name?: string;
  identityId?: string;
  identity_id?: string; // Backwards compat alias
}

/**
 * List identities filter options
 */
export interface ListIdentitiesOptions extends PaginationParams {
  name?: string;
  identifierKey?: string;
  identityType?: string;
}

/**
 * List tools filter options
 */
export interface ListToolsOptions extends PaginationParams {
  name?: string;
  names?: string[];
  toolIds?: string[];
  search?: string;
  toolTypes?: string[];
  excludeToolTypes?: string[];
  returnOnlyLettaTools?: boolean;
}

/**
 * List agents filter options
 */
export interface ListAgentsOptions extends PaginationParams {
  name?: string;
  tags?: string[];
}

/**
 * Update identity request
 */
export interface UpdateIdentityRequest {
  name?: string;
  identityType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Update tool request
 */
export interface UpdateToolRequest {
  name?: string;
  description?: string;
  sourceCode?: string;
  jsonSchema?: Record<string, unknown>;
  tags?: string[];
}

/**
 * Blocks sub-client
 */
export interface BlocksClient {
  list(options?: ListBlocksOptions): Promise<Block[]>;
  count(): Promise<number>;
  retrieve(blockId: string): Promise<Block>;
  create(request: CreateBlockRequest): Promise<Block>;
  update(blockId: string, request: UpdateBlockRequest): Promise<Block>;
  delete(blockId: string): Promise<void>;
  listAgents(blockId: string, options?: PaginationParams): Promise<AgentState[]>;
}

/**
 * Identities sub-client
 */
export interface IdentitiesClient {
  list(options?: ListIdentitiesOptions): Promise<Identity[]>;
  count(): Promise<number>;
  retrieve(identityId: string): Promise<Identity>;
  create(request: CreateIdentityRequest): Promise<Identity>;
  upsert(request: CreateIdentityRequest): Promise<Identity>;
  update(identityId: string, request: UpdateIdentityRequest): Promise<Identity>;
  delete(identityId: string): Promise<void>;
  listAgents(identityId: string, options?: PaginationParams): Promise<AgentState[]>;
  listBlocks(identityId: string, options?: PaginationParams): Promise<Block[]>;
}

/**
 * Tools sub-client
 */
export interface ToolsClient {
  list(options?: ListToolsOptions): Promise<Tool[]>;
  count(): Promise<number>;
  retrieve(toolId: string): Promise<Tool>;
  create(request: CreateToolRequest): Promise<Tool>;
  upsert(request: CreateToolRequest): Promise<Tool>;
  update(toolId: string, request: UpdateToolRequest): Promise<Tool>;
  delete(toolId: string): Promise<void>;
}

/**
 * Agents sub-client
 *
 * Note: earlier versions treated this as read-only, but upgrade/scope-sync needs
 * attach/detach operations.
 */
export interface AgentsClient {
  list(options?: ListAgentsOptions): Promise<AgentState[]>;
  count(): Promise<number>;
  retrieve(agentId: string): Promise<AgentState>;
  /** Legacy alias used by some reconcilers */
  get?(agentId: string): Promise<AgentState>;

   update(agentId: string, request: { name?: string; description?: string; system?: string; tags?: string[] }): Promise<AgentState>;

   // Agent subresources
   listBlocks(agentId: string): Promise<Block[]>;
   attachBlock(agentId: string, blockId: string): Promise<void>;
   detachBlock(agentId: string, blockId: string): Promise<void>;

   listTools(agentId: string): Promise<Tool[]>;
   attachTool(agentId: string, toolId: string): Promise<void>;
   detachTool(agentId: string, toolId: string): Promise<void>;

   listFolders(agentId: string): Promise<Folder[]>;
   attachFolder(agentId: string, folderId: string): Promise<void>;
   detachFolder(agentId: string, folderId: string): Promise<void>;

   attachIdentity(agentId: string, identityId: string): Promise<void>;
   detachIdentity(agentId: string, identityId: string): Promise<void>;
}

/**
 * List folders filter options
 */
export interface ListFoldersOptions extends PaginationParams {
  name?: string;
}

/**
 * Update folder request
 */
export interface UpdateFolderRequest {
  name?: string;
  description?: string;
  instructions?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Folders sub-client
 */
export interface FoldersClient {
  list(options?: ListFoldersOptions): Promise<Folder[]>;
  count(): Promise<number>;
  retrieve(folderId: string): Promise<Folder>;
  create(request: CreateFolderRequest): Promise<Folder>;
  update(folderId: string, request: UpdateFolderRequest): Promise<Folder>;
  delete(folderId: string): Promise<void>;
  listAgents(folderId: string, options?: PaginationParams): Promise<string[]>;
}

/**
 * Main Letta client interface
 */
export interface LettaClient {
  readonly blocks: BlocksClient;
  readonly identities: IdentitiesClient;
  readonly tools: ToolsClient;
  readonly agents: AgentsClient;
  readonly folders: FoldersClient;

  /** Get current configuration (with redacted secrets) */
  getConfig(): { baseUrl: string; project?: string; hasApiKey: boolean };
}

// =============================================================================
// Configuration Resolution
// =============================================================================

/**
 * Load settings from ~/.letta/settings.json
 */
function loadSettingsFile(): LettaSettings | null {
  try {
    const settingsPath = path.join(os.homedir(), '.letta', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, 'utf-8');
      return JSON.parse(content) as LettaSettings;
    }
  } catch (error) {
    // Silently ignore settings file errors
  }
  return null;
}

/**
 * Resolve API key from environment or settings file
 */
function findRepoRoot(startDir: string): string {
  let current = startDir;
  const root = path.parse(current).root;
  while (true) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.letta'))) {
      return current;
    }
    if (current === root) return startDir;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function resolveVaultApiKey(): string | undefined {
  const repoRoot = findRepoRoot(process.cwd());
  const vaultPath = path.join(repoRoot, '.secrets', 'dev.env.enc');
  if (!fs.existsSync(vaultPath)) return undefined;

  try {
    execFileSync('sops', ['--version'], { stdio: 'ignore' });
  } catch {
    return undefined;
  }

  const env = { ...process.env };
  if (!env.SOPS_AGE_KEY_FILE) {
    const defaultKeys = path.join(os.homedir(), '.config', 'sops', 'age', 'keys.txt');
    if (fs.existsSync(defaultKeys)) {
      env.SOPS_AGE_KEY_FILE = defaultKeys;
    }
  }

  try {
    const out = execFileSync(
      'sops',
      ['-d', '--input-type', 'dotenv', '--output-type', 'dotenv', vaultPath],
      { encoding: 'utf-8', env }
    );
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('LETTA_API_KEY=')) {
        const v = line.slice('LETTA_API_KEY='.length).trim();
        if (v.length > 0) return v;
      }
    }
  } catch {
    // ignore
  }

  return undefined;
}

function resolveApiKey(configApiKey?: string, baseUrl?: string): string | undefined {
  // Priority 1: Explicit config
  if (configApiKey) return configApiKey;

  // Priority 2: Repo vault (for Letta Cloud)
  if ((baseUrl ?? '').includes('api.letta.com')) {
    const vaultKey = resolveVaultApiKey();
    if (vaultKey) return vaultKey;
  }

  // Priority 3: Environment variable (support both general and project-specific)
  if (process.env.LETTA_DEMO_API_KEY) return process.env.LETTA_DEMO_API_KEY;
  if (process.env.LETTA_API_KEY) return process.env.LETTA_API_KEY;

  // Priority 4: Settings file
  const settings = loadSettingsFile();
  return settings?.env?.LETTA_API_KEY;
}

/**
 * Resolve base URL from environment or settings file
 */
function resolveBaseUrl(configBaseUrl?: string): string {
  // Priority 1: Explicit config
  if (configBaseUrl) return configBaseUrl;

  // Priority 2: Environment variable (support both names)
  if (process.env.LETTA_BASE_URL) return process.env.LETTA_BASE_URL;
  if (process.env.LETTA_API_URL) return process.env.LETTA_API_URL;

  // Priority 3: Settings file
  const settings = loadSettingsFile();
  if (settings?.env?.LETTA_BASE_URL) return settings.env.LETTA_BASE_URL;

  // Default: Letta Cloud
  return 'https://api.letta.com';
}

// =============================================================================
// Client Implementation
// =============================================================================

/**
 * Create a Letta API client with retry and logging
 *
 * @param config - Client configuration options
 * @returns Configured Letta client
 */
export function createClient(config: LettaClientConfig = {}): LettaClient {
  const baseUrl = resolveBaseUrl(config.baseUrl);
  const apiKey = resolveApiKey(config.apiKey, baseUrl);
  const project = config.project;
  const timeout = config.timeout ?? 30000;
  const log = config.debug ? logger : new ApiLogger({ level: 'warn' });

  // Validate API key for cloud endpoints
  if (!apiKey && baseUrl.includes('api.letta.com')) {
    throw new Error(
      'Missing LETTA_API_KEY. Configure authentication using:\n' +
        '  1. Set LETTA_API_KEY environment variable\n' +
        "  2. Run 'letta setup' for interactive configuration\n" +
        '  3. Add to ~/.letta/settings.json\n' +
        '  4. Or store in .secrets/dev.env.enc (SOPS) and ensure SOPS_AGE_KEY_FILE is set'
    );
  }

  // Build default headers
  const defaultHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    defaultHeaders['Authorization'] = `Bearer ${apiKey}`;
  }

  if (project) {
    defaultHeaders['X-Project'] = project;
  }

  if (config.userAgent) {
    defaultHeaders['User-Agent'] = `smarty-admin ${config.userAgent}`;
  }

  /**
   * Make an API request with retry logic
   */
  async function request<T>(
    method: HttpMethod,
    path: string,
    options: {
      params?: Record<string, string | number | boolean | string[] | undefined>;
      body?: unknown;
      headers?: Record<string, string>;
      skipRetry?: boolean;
    } = {}
  ): Promise<T> {
    // Build URL with query params
    const url = new URL(`${baseUrl}/v1${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined) {
          if (Array.isArray(value)) {
            // Handle array params (e.g., tool_ids)
            for (const v of value) {
              url.searchParams.append(key, v);
            }
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }

    const headers = { ...defaultHeaders, ...options.headers };

    // Log request (debug level)
    log.request(method, url.toString(), { headers });

    const makeRequest = async (): Promise<T> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const startTime = Date.now();
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });

        const durationMs = Date.now() - startTime;

        // Log response
        log.response(response.status, url.toString(), { durationMs });

        // Handle errors
        if (!response.ok) {
          let errorMessage = `Letta API error (${response.status})`;
          let errorDetails: Record<string, unknown> | undefined;

          try {
            const errorBody = await response.text();
            if (errorBody) {
              try {
                errorDetails = JSON.parse(errorBody);
                errorMessage = (errorDetails as { detail?: string }).detail || errorMessage;
              } catch {
                errorMessage = errorBody.substring(0, 200);
              }
            }
          } catch {
            // Ignore response body read errors
          }

          // Parse Retry-After header for rate limits
          const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));

          throw new ApiRequestError(errorMessage, response.status, {
            details: errorDetails,
            retryAfter,
          });
        }

        // Handle 204 No Content
        if (response.status === 204) {
          return undefined as T;
        }

        return (await response.json()) as T;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Execute with or without retry
    if (options.skipRetry) {
      return makeRequest();
    }

    const retryOptions: RetryOptions<T> = {
      maxRetries: DEFAULT_RETRY_CONFIG.maxRetries,
      baseDelayMs: DEFAULT_RETRY_CONFIG.baseDelayMs,
      logger: log,
      onRetry: (attempt, error, delayMs) => {
        log.info(`Retrying request to ${path}`, {
          attempt,
          error: error.message,
          delayMs,
        });
      },
    };

    const result = await withRetry(makeRequest, retryOptions);

    if (!result.success) {
      throw result.error;
    }

    return result.data as T;
  }

  // ---------------------------------------------------------------------------
  // Blocks Client
  // ---------------------------------------------------------------------------

  const blocks: BlocksClient = {
    async list(options: ListBlocksOptions = {}): Promise<Block[]> {
      return request<Block[]>('GET', '/blocks/', {
        params: {
          label: options.label,
          label_search: options.labelSearch ?? options.label_search,
          description_search: options.descriptionSearch ?? options.description_search,
          value_search: options.valueSearch ?? options.value_search,
          templates_only: options.templatesOnly ?? options.templates_only,
          name: options.name,
          identity_id: options.identityId ?? options.identity_id,
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async count(): Promise<number> {
      return request<number>('GET', '/blocks/count');
    },

    async retrieve(blockId: string): Promise<Block> {
      return request<Block>('GET', `/blocks/${blockId}`);
    },

    async create(req: CreateBlockRequest): Promise<Block> {
      return request<Block>('POST', '/blocks/', {
        body: {
          label: req.label,
          value: req.value,
          limit: req.limit,
          description: req.description,
          metadata: req.metadata,
          template_name: req.templateName,
          is_template: req.isTemplate,
        },
      });
    },

    async update(blockId: string, req: UpdateBlockRequest): Promise<Block> {
      return request<Block>('PATCH', `/blocks/${blockId}`, {
        body: {
          label: req.label,
          value: req.value,
          limit: req.limit,
          description: req.description,
          metadata: req.metadata,
        },
      });
    },

    async delete(blockId: string): Promise<void> {
      return request<void>('DELETE', `/blocks/${blockId}`);
    },

    async listAgents(blockId: string, options: PaginationParams = {}): Promise<AgentState[]> {
      return request<AgentState[]>('GET', `/blocks/${blockId}/agents`, {
        params: {
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Identities Client
  // ---------------------------------------------------------------------------

  const identities: IdentitiesClient = {
    async list(options: ListIdentitiesOptions = {}): Promise<Identity[]> {
      return request<Identity[]>('GET', '/identities/', {
        params: {
          name: options.name,
          identifier_key: options.identifierKey,
          identity_type: options.identityType,
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async count(): Promise<number> {
      return request<number>('GET', '/identities/count');
    },

    async retrieve(identityId: string): Promise<Identity> {
      return request<Identity>('GET', `/identities/${identityId}`);
    },

    async create(req: CreateIdentityRequest): Promise<Identity> {
      return request<Identity>('POST', '/identities/', {
        body: {
          name: req.name,
          identifier_key: req.identifierKey,
          identity_type: req.identityType,
          properties: req.properties,
          metadata: req.metadata,
        },
      });
    },

    async upsert(req: CreateIdentityRequest): Promise<Identity> {
      return request<Identity>('PUT', '/identities/', {
        body: {
          name: req.name,
          identifier_key: req.identifierKey,
          identity_type: req.identityType,
          properties: req.properties,
          metadata: req.metadata,
        },
      });
    },

    async update(identityId: string, req: UpdateIdentityRequest): Promise<Identity> {
      return request<Identity>('PATCH', `/identities/${identityId}`, {
        body: {
          name: req.name,
          identity_type: req.identityType,
          metadata: req.metadata,
        },
      });
    },

    async delete(identityId: string): Promise<void> {
      return request<void>('DELETE', `/identities/${identityId}`);
    },

    async listAgents(identityId: string, options: PaginationParams = {}): Promise<AgentState[]> {
      return request<AgentState[]>('GET', `/identities/${identityId}/agents`, {
        params: {
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async listBlocks(identityId: string, options: PaginationParams = {}): Promise<Block[]> {
      return request<Block[]>('GET', `/identities/${identityId}/blocks`, {
        params: {
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Tools Client
  // ---------------------------------------------------------------------------

  const tools: ToolsClient = {
    async list(options: ListToolsOptions = {}): Promise<Tool[]> {
      return request<Tool[]>('GET', '/tools/', {
        params: {
          name: options.name,
          names: options.names,
          tool_ids: options.toolIds,
          search: options.search,
          tool_types: options.toolTypes,
          exclude_tool_types: options.excludeToolTypes,
          return_only_letta_tools: options.returnOnlyLettaTools,
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async count(): Promise<number> {
      return request<number>('GET', '/tools/count');
    },

    async retrieve(toolId: string): Promise<Tool> {
      return request<Tool>('GET', `/tools/${toolId}`);
    },

    async create(req: CreateToolRequest): Promise<Tool> {
      return request<Tool>('POST', '/tools/', {
        body: {
          name: req.name,
          source_type: req.sourceType,
          source_code: req.sourceCode,
          json_schema: req.jsonSchema,
          description: req.description,
          tags: req.tags,
          tool_type: req.toolType,
        },
      });
    },

    async upsert(req: CreateToolRequest): Promise<Tool> {
      return request<Tool>('PUT', '/tools/', {
        body: {
          name: req.name,
          source_type: req.sourceType,
          source_code: req.sourceCode,
          json_schema: req.jsonSchema,
          description: req.description,
          tags: req.tags,
          tool_type: req.toolType,
        },
      });
    },

    async update(toolId: string, req: UpdateToolRequest): Promise<Tool> {
      return request<Tool>('PATCH', `/tools/${toolId}`, {
        body: {
          name: req.name,
          description: req.description,
          source_code: req.sourceCode,
          json_schema: req.jsonSchema,
          tags: req.tags,
        },
      });
    },

    async delete(toolId: string): Promise<void> {
      return request<void>('DELETE', `/tools/${toolId}`);
    },
  };

  // ---------------------------------------------------------------------------
  // Agents Client (Read-only)
  // ---------------------------------------------------------------------------

  const agents: AgentsClient = {
    async list(options: ListAgentsOptions = {}): Promise<AgentState[]> {
      return request<AgentState[]>('GET', '/agents/', {
        params: {
          name: options.name,
          tags: options.tags,
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async count(): Promise<number> {
      return request<number>('GET', '/agents/count');
    },

    async retrieve(agentId: string): Promise<AgentState> {
      return request<AgentState>('GET', `/agents/${agentId}`);
    },

    async get(agentId: string): Promise<AgentState> {
      return request<AgentState>('GET', `/agents/${agentId}`);
    },

    async update(
      agentId: string,
      req: { name?: string; description?: string; system?: string; tags?: string[] }
    ): Promise<AgentState> {
      return request<AgentState>('PATCH', `/agents/${agentId}`, {
        body: {
          name: req.name,
          description: req.description,
          system: req.system,
          tags: req.tags,
        },
      });
    },

    async listBlocks(agentId: string): Promise<Block[]> {
      return request<Block[]>('GET', `/agents/${agentId}/core-memory/blocks`);
    },

    async attachBlock(agentId: string, blockId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/core-memory/blocks/attach/${blockId}`, {
        body: {},
      });
    },

    async detachBlock(agentId: string, blockId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/core-memory/blocks/detach/${blockId}`, {
        body: {},
      });
    },

    async listTools(agentId: string): Promise<Tool[]> {
      return request<Tool[]>('GET', `/agents/${agentId}/tools`);
    },

    async attachTool(agentId: string, toolId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/tools/attach/${toolId}`, { body: {} });
    },

    async detachTool(agentId: string, toolId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/tools/detach/${toolId}`, { body: {} });
    },

    async listFolders(agentId: string): Promise<Folder[]> {
      return request<Folder[]>('GET', `/agents/${agentId}/folders`);
    },

    async attachFolder(agentId: string, folderId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/folders/attach/${folderId}`, { body: {} });
    },

    async detachFolder(agentId: string, folderId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/folders/detach/${folderId}`, { body: {} });
    },

    async attachIdentity(agentId: string, identityId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/identities/attach/${identityId}`, { body: {} });
    },

    async detachIdentity(agentId: string, identityId: string): Promise<void> {
      await request<void>('PATCH', `/agents/${agentId}/identities/detach/${identityId}`, { body: {} });
    },
  };

  // ---------------------------------------------------------------------------
  // Folders Client
  // ---------------------------------------------------------------------------

  const folders: FoldersClient = {
    async list(options: ListFoldersOptions = {}): Promise<Folder[]> {
      return request<Folder[]>('GET', '/folders/', {
        params: {
          name: options.name,
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },

    async count(): Promise<number> {
      return request<number>('GET', '/folders/count');
    },

    async retrieve(folderId: string): Promise<Folder> {
      return request<Folder>('GET', `/folders/${folderId}`);
    },

    async create(req: CreateFolderRequest): Promise<Folder> {
      return request<Folder>('POST', '/folders/', {
        body: {
          name: req.name,
          description: req.description,
          instructions: req.instructions,
          embedding: req.embedding,
          embedding_chunk_size: req.embeddingChunkSize,
          metadata: req.metadata,
        },
      });
    },

    async update(folderId: string, req: UpdateFolderRequest): Promise<Folder> {
      return request<Folder>('PATCH', `/folders/${folderId}`, {
        body: {
          name: req.name,
          description: req.description,
          instructions: req.instructions,
          metadata: req.metadata,
        },
      });
    },

    async delete(folderId: string): Promise<void> {
      return request<void>('DELETE', `/folders/${folderId}`);
    },

    async listAgents(folderId: string, options: PaginationParams = {}): Promise<string[]> {
      return request<string[]>('GET', `/folders/${folderId}/agents`, {
        params: {
          limit: options.limit,
          before: options.before,
          after: options.after,
          order: options.order,
          order_by: options.orderBy,
        },
      });
    },
  };

  // ---------------------------------------------------------------------------
  // Return Client
  // ---------------------------------------------------------------------------

  return {
    blocks,
    identities,
    tools,
    agents,
    folders,

    getConfig() {
      return {
        baseUrl,
        project,
        hasApiKey: !!apiKey,
      };
    },
  };
}

// Re-export for backwards compatibility
export type { LettaClient as Client };

// Re-export types that were previously defined in this file
export type { Block as BlockResponse } from './types.js';
export type {
  CreateBlockRequest,
  UpdateBlockRequest,
} from './types.js';
