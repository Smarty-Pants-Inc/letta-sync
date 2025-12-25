/**
 * Scope Sync - Attach scope-based memory blocks to agents
 *
 * This module provides scope synchronization for work lanes. It ensures that
 * agents have the appropriate memory blocks attached based on their working
 * directory and the project's scope registry.
 *
 * Key operations:
 * - Ensure shared scope registry and policy blocks exist
 * - Parse scope registry to find matching scopes for cwd
 * - Create/attach scope blocks for matched scopes
 * - Update lane_scopes block with current state
 *
 * This is designed to be "best-effort" - failures are logged but don't break
 * the bootstrap flow.
 *
 * @see docs/specs/scope-registry.md for schema documentation
 * @see docs/specs/lane-bootstrap.md for agent discovery strategy
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import { createClient, type LettaClient } from '../api/client.js';
import type { Block, CreateBlockRequest } from '../api/types.js';
import { loadProjectSettings, saveProjectSettings, type ProjectSettings } from './settings.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Scope registry schema (matches letta-code ScopeSync)
 */
interface ScopeRegistry {
  scopes?: Array<{
    scope: string;
    match?: { path_prefixes?: string[] };
    attach?: { block_types?: string[]; folders?: string[] };
    metadata?: { description?: string; priority?: number };
  }>;
}

/**
 * Options for running scope sync
 */
export interface ScopeSyncOptions {
  /** Agent ID to sync scopes for */
  agentId: string;
  /** Working directory (defaults to cwd) */
  cwd?: string;
  /** Additional touched paths to consider for scope matching */
  touchedPaths?: string[];
  /** Dry run mode - show what would happen without making changes */
  dryRun?: boolean;
  /** Verbose logging callback */
  verbose?: (msg: string) => void;
  /** API client (if not provided, will be created) */
  client?: LettaClient;
}

/**
 * Result of scope sync operation
 */
export interface ScopeSyncResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** Scopes that were matched */
  matchedScopes?: string[];
  /** Focus scope (most specific match for cwd) */
  focusScope?: string | null;
  /** Blocks that were attached */
  attachedBlocks?: Array<{ label: string; blockId: string }>;
  /** Warning messages */
  warnings?: string[];
  /** Error message if failed */
  error?: string;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default scope registry content for smarty-dev monorepo
 */
const DEFAULT_SCOPE_REGISTRY = `# Scope Registry for smarty-dev monorepo
# See docs/specs/scope-registry.md for schema documentation

scopes:
  # Root scope - base level for the entire monorepo
  - scope: smarty-dev
    match:
      path_prefixes:
        - ./
    attach:
      block_types: [project, conventions]
    metadata:
      description: Root smarty-dev monorepo
      priority: 0

  # Partner project scopes
  - scope: smarty-pants
    match:
      path_prefixes:
        - partners/smarty-pants/
    attach:
      block_types: [project, decisions, conventions, glossary]
    metadata:
      description: Smarty Pants partner project
      priority: 10

  - scope: smarty-phoenix
    match:
      path_prefixes:
        - partners/smarty-phoenix/
    attach:
      block_types: [project, decisions, conventions, glossary]
    metadata:
      description: Smarty Phoenix partner project
      priority: 10

  - scope: smarty-playful
    match:
      path_prefixes:
        - partners/smarty-playful/
    attach:
      block_types: [project, decisions, conventions, glossary]
    metadata:
      description: Playful Studios integration
      priority: 10

  - scope: smarty-thousands
    match:
      path_prefixes:
        - partners/smarty-thousands/
    attach:
      block_types: [project, decisions, conventions, glossary]
    metadata:
      description: Thousands multiplayer infrastructure
      priority: 10

  - scope: smarty-wildcard
    match:
      path_prefixes:
        - partners/smarty-wildcard/
    attach:
      block_types: [project, decisions, conventions, glossary]
    metadata:
      description: Wildcard Studios game project
      priority: 10

  # Shared infrastructure scope
  - scope: infra
    match:
      path_prefixes:
        - infrastructure/
        - terraform/
        - .github/
    attach:
      block_types: [project, conventions]
    metadata:
      description: Shared infrastructure and CI/CD
      priority: 5

  # External dependencies scope
  - scope: external
    match:
      path_prefixes:
        - external/
    attach:
      block_types: [project]
    metadata:
      description: External and vendored dependencies
      priority: 5
`;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sanitize a string for use as a block label part
 */
function safeScopeLabelPart(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function shortHash(raw: string): string {
  // Deterministic suffix to disambiguate collisions after sanitization.
  return createHash('sha1').update(raw).digest('hex').slice(0, 6);
}

/**
 * Get the project slug from the repo root path
 */
function getProjectSlug(repoRoot: string): string {
  const baseName = path.basename(repoRoot);
  return safeScopeLabelPart(baseName) || 'default';
}

/**
 * Find the git repository root
 */
function getRepoRoot(cwd: string): string {
  // Prefer the nearest ancestor that contains a scope registry.
  // This allows scope sync to work even when called from a nested git repo.
  {
    let current = path.resolve(cwd);
    const root = path.parse(current).root;
    while (true) {
      const candidate = path.join(current, '.letta', 'scope_registry.yaml');
      if (fs.existsSync(candidate)) {
        return current;
      }
      if (current === root) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // Not in a git repo, use cwd
  }
  return cwd;
}

/**
 * Convert a path to repo-relative POSIX format
 */
function toRepoRelativePosix(repoRoot: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/');
}

// =============================================================================
// Block Management
// =============================================================================

/**
 * Extended client interface for agent block operations
 * Note: The standard LettaClient.agents is read-only, so we need direct API calls
 * for block attachment. This is a workaround until the API client is extended.
 */
interface AgentBlocksClient {
  attach(agentId: string, blockId: string): Promise<void>;
}

/**
 * Create an agent blocks client for block attachment
 * This makes direct API calls since the standard client is read-only for agents
 */
function createAgentBlocksClient(
  client: LettaClient,
  verbose?: (msg: string) => void
): AgentBlocksClient {
  const log = verbose ?? (() => {});

  // Prefer the typed client methods (which handle auth via vault/env/settings).
  // This also uses the correct Cloud attach endpoints.
  const agentsAny = (client as any).agents;
  if (agentsAny?.attachBlock) {
    return {
      async attach(agentId: string, blockId: string): Promise<void> {
        log(`Attaching block ${blockId} to agent ${agentId}`);
        await agentsAny.attachBlock(agentId, blockId);
      },
    };
  }

  // Fallback path for older/self-hosted servers.
  // Get API configuration from environment.
  const apiKey = process.env.LETTA_API_KEY;
  const baseUrl = process.env.LETTA_BASE_URL ?? process.env.LETTA_API_URL ?? 'https://api.letta.com';

  return {
    async attach(agentId: string, blockId: string): Promise<void> {
      log(`Attaching block ${blockId} to agent ${agentId}`);

      // Self-hosted Letta uses the block *label* for this endpoint, not the block ID.
      // Resolve the label from the block ID via the normal blocks client.
      const block = await client.blocks.retrieve(blockId);
      const blockLabel = block.label ?? blockId;

      const url = `${baseUrl}/v1/agents/${agentId}/core-memory/blocks/${encodeURIComponent(blockLabel)}`;
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        // Some Letta servers validate that a JSON body is present even if empty.
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to attach block: ${response.status} ${errorText}`);
      }
    },
  };
}

/**
 * Ensure a shared block exists, creating it if necessary
 * Returns the block ID (from settings cache or newly created)
 */
async function ensureSharedBlockId(
  client: LettaClient,
  workingDirectory: string,
  label: string,
  description: string,
  value: string,
  verbose?: (msg: string) => void
): Promise<string> {
  const log = verbose ?? (() => {});

  // Check settings cache first
  const settings = loadProjectSettings(workingDirectory) ?? { lastAgent: null };
  const existing = settings.localSharedBlockIds?.[label];
  if (existing) {
    // Validate cached block still exists (stale cache can happen if blocks were
    // cleaned up between runs).
    try {
      await client.blocks.retrieve(existing);
      log(`Using cached block ID for ${label}: ${existing}`);
      return existing;
    } catch {
      log(`Cached block ID for ${label} is stale; will recreate: ${existing}`);
      // Best-effort: clear the cached entry.
      try {
        const next = {
          ...settings,
          localSharedBlockIds: { ...(settings.localSharedBlockIds ?? {}) },
        };
        delete next.localSharedBlockIds![label];
        saveProjectSettings(next, workingDirectory);
      } catch {
        // ignore
      }
    }
  }

  // Check if block already exists by label
  try {
    const blocks = await client.blocks.list({ label, limit: 50 } as any);
    if (blocks.length > 0) {
      const preferred = blocks.find(
        (b: any) => b?.metadata?.managed_by === 'smarty-admin' && b?.metadata?.source === 'scope-sync'
      );
      const chosen = preferred ?? blocks[0];
      const blockId = chosen.id;
      if (blocks.length > 1) {
        log(`Warning: Multiple blocks found with label ${label} (${blocks.length}); using ${blockId}`);
      }

      log(`Found existing block ${label}: ${blockId}`);

      // Mark as managed so demo cleanup can remove scope artifacts safely.
      try {
        const md = (chosen as any).metadata ?? {};
        if (md.managed_by !== 'smarty-admin') {
          await client.blocks.update(blockId, {
            metadata: { ...md, managed_by: 'smarty-admin', source: 'scope-sync' },
          } as any);
        }
      } catch {
        // best effort
      }

      // Cache it for future use
      saveProjectSettings({
        ...settings,
        localSharedBlockIds: {
          ...settings.localSharedBlockIds,
          [label]: blockId,
        },
      }, workingDirectory);

      return blockId;
    }
  } catch (err) {
    log(`Warning: Failed to search for existing block ${label}: ${err}`);
  }

  // Create the block
  log(`Creating shared block: ${label}`);
  const created = await client.blocks.create({
    label,
    value,
    description,
    limit: 20000,
    metadata: { managed_by: 'smarty-admin', source: 'scope-sync' },
  });

  if (!created.id) {
    throw new Error(`Created block ${label} has no id`);
  }

  // Cache the block ID
  saveProjectSettings({
    ...settings,
    localSharedBlockIds: {
      ...settings.localSharedBlockIds,
      [label]: created.id,
    },
  }, workingDirectory);

  log(`Created block ${label}: ${created.id}`);
  return created.id;
}

/**
 * Attach a block to an agent if not already attached
 */
async function attachBlockIfMissing(
  agentBlocksClient: AgentBlocksClient,
  agentId: string,
  blockId: string,
  attachedBlockIds: Set<string>,
  dryRun: boolean,
  verbose?: (msg: string) => void
): Promise<void> {
  const log = verbose ?? (() => {});

  if (attachedBlockIds.has(blockId)) {
    log(`Block ${blockId} already attached`);
    return;
  }

  if (dryRun) {
    log(`[DRY RUN] Would attach block ${blockId}`);
    return;
  }

  await agentBlocksClient.attach(agentId, blockId);
  attachedBlockIds.add(blockId);
  log(`Attached block ${blockId}`);
}

// =============================================================================
// Main Scope Sync Function
// =============================================================================

/**
 * Run scope sync for an agent
 *
 * This attaches appropriate scope-based memory blocks to the agent based on
 * the working directory and scope registry configuration.
 *
 * @param options - Scope sync options
 * @returns Result of the operation
 */
export async function runScopeSync(options: ScopeSyncOptions): Promise<ScopeSyncResult> {
  const {
    agentId,
    cwd = process.cwd(),
    touchedPaths = [],
    dryRun = false,
    verbose,
  } = options;

  const log = verbose ?? (() => {});
  // When invoked from a subdirectory (e.g. tools/smarty-admin), treat a relative
  // cwd argument as repo-relative rather than relative to the current shell.
  const baseForRelative = getRepoRoot(process.cwd());
  const workingDirectory = path.isAbsolute(cwd)
    ? path.resolve(cwd)
    : path.resolve(baseForRelative, cwd);
  const warnings: string[] = [];
  const attachedBlocks: Array<{ label: string; blockId: string }> = [];

  try {
    log(`Starting scope sync for agent ${agentId}`);
    log(`Working directory: ${workingDirectory}`);

    // Create or use provided client
    const client = options.client ?? createClient();

    // Create agent blocks client for attachment operations
    const agentBlocksClient = createAgentBlocksClient(client, verbose);

    // Get repo root and project slug
    const repoRoot = getRepoRoot(workingDirectory);
    const projectSlug = getProjectSlug(repoRoot);
    log(`Repo root: ${repoRoot}`);
    log(`Project slug: ${projectSlug}`);

    // Ensure shared blocks exist
    log('Ensuring shared scope registry block...');

    // Prefer the repo's scope_registry.yaml if present.
    const scopeRegistryPath = path.join(repoRoot, '.letta', 'scope_registry.yaml');
    const scopeRegistryValue = fs.existsSync(scopeRegistryPath)
      ? fs.readFileSync(scopeRegistryPath, 'utf-8')
      : DEFAULT_SCOPE_REGISTRY;

    const registryBlockId = await ensureSharedBlockId(
      client,
      workingDirectory,
      `scope_registry_${projectSlug}`,
      `Shared scope registry for nested projects in ${projectSlug} (YAML).`,
      scopeRegistryValue,
      verbose
    );

    // If the registry already exists from a prior run, keep it updated with the
    // repo's .letta/scope_registry.yaml so demos don't drift.
    if (!dryRun) {
      try {
        const existing = await client.blocks.retrieve(registryBlockId);
        const existingValue = (existing.value ?? '').trim();
        const desiredValue = scopeRegistryValue.trim();
        if (existingValue !== desiredValue) {
          await client.blocks.update(registryBlockId, { value: scopeRegistryValue });
          log(`Updated scope registry block from repo file: ${registryBlockId}`);
        }
      } catch (err) {
        warnings.push(
          `Could not refresh scope registry block ${registryBlockId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    log('Ensuring shared scope policy block...');
    const policyBlockId = await ensureSharedBlockId(
      client,
      workingDirectory,
      `scope_runtime_policy_${projectSlug}`,
      `Policy for how agents should use scopes and when to run ScopeSync in ${projectSlug}.`,
      'When working in a nested project path, call ScopeSync to attach matching scope blocks. Prefer writing to the focus scope blocks.',
      verbose
    );

    // Get current attached blocks (ids + labels) so we can purge any legacy
    // non-namespaced scope artifacts.
    log('Retrieving agent state...');
    const agentBlocks = (client as any).agents?.listBlocks
      ? await (client as any).agents.listBlocks(agentId)
      : [];

    const attachedBlockIds = new Set<string>(
      (agentBlocks ?? []).map((b: any) => b?.id).filter((id: any) => typeof id === 'string')
    );

    // Purge legacy blocks created by earlier iterations (no backwards-compat needed).
    // Keep registry/policy blocks; only purge legacy scope_ blocks and lane_scopes.
    const keepScopePrefixes = new Set<string>([
      `scope_${projectSlug}_`,
      `scope_registry_`,
      `scope_runtime_policy_`,
    ]);

    const legacyToDetach: Array<{ id: string; label: string }> = [];
    for (const b of agentBlocks ?? []) {
      const label = String((b as any).label ?? '');
      const id = String((b as any).id ?? '');
      if (!label || !id) continue;

      const isScopeish = label.startsWith('scope_') || label.startsWith('lane_scopes');
      if (!isScopeish) continue;

      const isKept = Array.from(keepScopePrefixes).some((p) => label.startsWith(p)) || label === `lane_scopes_${projectSlug}`;
      if (!isKept) {
        legacyToDetach.push({ id, label });
      }
    }

    if (legacyToDetach.length > 0) {
      log(`Detaching ${legacyToDetach.length} legacy scope/lane block(s)...`);
      for (const b of legacyToDetach) {
        if (dryRun) {
          log(`[DRY RUN] Would detach legacy block: ${b.label} ${b.id}`);
          continue;
        }
        try {
          await (client as any).agents.detachBlock(agentId, b.id);
          attachedBlockIds.delete(b.id);
          log(`Detached legacy block: ${b.label} ${b.id}`);
        } catch (err) {
          warnings.push(
            `Failed to detach legacy block ${b.label} ${b.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    log(`Agent has ${attachedBlockIds.size} block(s) attached (post-purge)`);

    // Attach registry and policy blocks
    await attachBlockIfMissing(agentBlocksClient, agentId, registryBlockId, attachedBlockIds, dryRun, verbose);
    await attachBlockIfMissing(agentBlocksClient, agentId, policyBlockId, attachedBlockIds, dryRun, verbose);

    // Parse the scope registry
    log('Parsing scope registry...');
    const registryBlock = await client.blocks.retrieve(registryBlockId);
    const parsed = parseYaml(registryBlock.value ?? '') as ScopeRegistry;
    const scopes = Array.isArray(parsed.scopes) ? parsed.scopes : [];
    log(`Found ${scopes.length} scopes in registry`);

    // Build candidate paths for matching
    const candidates = new Set<string>();
    candidates.add(toRepoRelativePosix(repoRoot, workingDirectory));
    for (const p of touchedPaths) {
      candidates.add(toRepoRelativePosix(repoRoot, p));
    }
    log(`Candidate paths: ${Array.from(candidates).join(', ')}`);

    // Match scopes
    const matched: Array<{ scope: string; prefixes: string[]; blockTypes: string[] }> = [];
    for (const s of scopes) {
      const scopeName = typeof s.scope === 'string' ? s.scope : '';
      const prefixes = (s.match?.path_prefixes ?? []).filter(
        (p): p is string => typeof p === 'string' && p.length > 0
      );
      if (!scopeName || prefixes.length === 0) continue;

      const normalizedPrefixes = prefixes.map((raw) => {
        // Allow YAML to use "./" for repo root.
        let p = raw.startsWith('./') ? raw.slice(2) : raw;
        if (p === '.' || p === './') p = '';
        if (p === '') return '';
        return p.endsWith('/') ? p : `${p}/`;
      });

      const isMatch = Array.from(candidates).some((cand) =>
        normalizedPrefixes.some(
          (pref) => pref === '' || cand === pref.slice(0, -1) || cand.startsWith(pref)
        )
      );
      if (!isMatch) continue;

      const blockTypes = (s.attach?.block_types ?? []).filter(
        (bt): bt is string => typeof bt === 'string' && bt.length > 0
      );
      matched.push({ scope: scopeName, prefixes: normalizedPrefixes, blockTypes });
    }
    log(`Matched ${matched.length} scopes: ${matched.map((m) => m.scope).join(', ')}`);

    // Determine focus scope (most specific match)
    const cwdRel = toRepoRelativePosix(repoRoot, workingDirectory);
    let focusScope: string | null = null;
    let focusLen = -1;
    for (const m of matched) {
      for (const pref of m.prefixes) {
        if (pref === '' || cwdRel === pref.slice(0, -1) || cwdRel.startsWith(pref)) {
          if (pref.length > focusLen) {
            focusLen = pref.length;
            focusScope = m.scope;
          }
        }
      }
    }
    log(`Focus scope: ${focusScope ?? 'none'}`);

    // Create and attach scope blocks
    const usedScopeKeys = new Map<string, string>();
    for (const m of matched) {
      let scopeKey = safeScopeLabelPart(m.scope);
      if (!scopeKey) {
        warnings.push(`Skipping scope with invalid name: ${m.scope}`);
        continue;
      }

      // Avoid collisions if two different scopes normalize to the same key.
      const prev = usedScopeKeys.get(scopeKey);
      if (prev && prev !== m.scope) {
        scopeKey = `${scopeKey}_${shortHash(m.scope)}`;
      }
      usedScopeKeys.set(scopeKey, m.scope);

      for (const btRaw of m.blockTypes) {
        const bt = safeScopeLabelPart(btRaw);
        if (!bt) continue;
        // Namespacing with projectSlug avoids collisions across repos/projects
        // inside the same Letta Cloud project.
        const label = `scope_${projectSlug}_${scopeKey}_${bt}`;

        const blockId = await ensureSharedBlockId(
          client,
          workingDirectory,
          label,
          `Shared scope block (${m.scope}) for ${btRaw}`,
          '',
          verbose
        );

        await attachBlockIfMissing(agentBlocksClient, agentId, blockId, attachedBlockIds, dryRun, verbose);
        attachedBlocks.push({ label, blockId });
      }
    }

    // Create/update lane_scopes block (lane-private)
    if (!dryRun) {
      log('Creating/updating lane_scopes block...');
      const laneScopesLabel = `lane_scopes_${projectSlug}`;
      const laneScopesValue = JSON.stringify(
        {
          matched_scopes: matched.map((m) => m.scope),
          focus_scope: focusScope,
          cwd: cwdRel,
          repo_root: repoRoot,
          updated_at: new Date().toISOString(),
        },
        null,
        2
      );

      // Check if lane_scopes exists
      const existingLaneScopes = await client.blocks.list({ label: laneScopesLabel });
      if (existingLaneScopes.length > 0 && existingLaneScopes[0].id) {
        const blockId = existingLaneScopes[0].id;
        const md = (existingLaneScopes[0] as any).metadata ?? {};
        await client.blocks.update(blockId, {
          value: laneScopesValue,
          metadata: { ...md, managed_by: 'smarty-admin', source: 'scope-sync' },
        } as any);
        await attachBlockIfMissing(agentBlocksClient, agentId, blockId, attachedBlockIds, dryRun, verbose);
        log(`Updated lane_scopes block: ${blockId}`);
      } else {
        const created = await client.blocks.create({
          label: laneScopesLabel,
          value: laneScopesValue,
          description: 'Lane-private scope state (matched scopes + focus scope)',
          limit: 4000,
          metadata: { managed_by: 'smarty-admin', source: 'scope-sync' },
        });
        if (created.id) {
          await agentBlocksClient.attach(agentId, created.id);
          log(`Created and attached lane_scopes block: ${created.id}`);
        }
      }
    }

    return {
      success: true,
      message: `Scope sync complete. Matched ${matched.length} scope(s), focus: ${focusScope ?? 'root'}`,
      matchedScopes: matched.map((m) => m.scope),
      focusScope,
      attachedBlocks,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`Scope sync failed: ${errorMessage}`);

    return {
      success: false,
      message: 'Scope sync failed',
      error: errorMessage,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}

/**
 * Run scope sync as best-effort (don't throw on failure)
 *
 * This is the recommended way to call scope sync from bootstrap flows.
 * It logs results but doesn't fail the parent operation.
 */
export async function runScopeSyncBestEffort(
  options: ScopeSyncOptions,
  onResult?: (result: ScopeSyncResult) => void
): Promise<ScopeSyncResult> {
  try {
    const result = await runScopeSync(options);

    if (onResult) {
      onResult(result);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const result: ScopeSyncResult = {
      success: false,
      message: 'Scope sync failed unexpectedly',
      error: errorMessage,
    };

    if (onResult) {
      onResult(result);
    }

    return result;
  }
}
