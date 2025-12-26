/**
 * Letta Auth Resolution for letta-sync
 *
 * This module provides a generic auth resolution mechanism that works
 * for both Letta Cloud and self-hosted deployments, without any
 * repository-specific vault or secret management assumptions.
 *
 * ## Auth Resolution Order
 *
 * 1. For self-hosted (base URL is NOT api.letta.com):
 *    - LETTA_SERVER_PASSWORD takes precedence if set
 *
 * 2. For all environments:
 *    a) LETTA_SYNC_AUTH_HELPER: Execute external command to get token
 *       - Args via LETTA_SYNC_AUTH_HELPER_ARGS (whitespace-separated or JSON array)
 *       - Falls back on failure (unless helper returns explicit error)
 *    b) LETTA_API_KEY environment variable
 *    c) ~/.letta/settings.json (written by `letta setup`)
 *
 * ## Environment Variables
 *
 * - LETTA_BASE_URL or LETTA_API_URL: Base URL for Letta API (default: https://api.letta.com)
 * - LETTA_API_KEY: API key for Letta Cloud
 * - LETTA_SERVER_PASSWORD: Password for self-hosted Letta server
 * - LETTA_SYNC_AUTH_HELPER: Path to executable that prints token to stdout
 * - LETTA_SYNC_AUTH_HELPER_ARGS: Arguments for auth helper
 *   - Whitespace-separated string: "arg1 arg2 arg3"
 *   - OR JSON array: '["arg1", "arg2", "arg3"]'
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Vault-first (smarty-dev convention)
// ---------------------------------------------------------------------------

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

function resolveVaultApiKey(): string | null {
  // Allow opting out for debugging.
  if (process.env.SMARTY_PREFER_ENV_KEY === '1') return null;

  const repoRoot = findRepoRoot(process.cwd());
  const vaultPath = path.join(repoRoot, '.secrets', 'dev.env.enc');
  if (!fs.existsSync(vaultPath)) return null;

  try {
    execFileSync('sops', ['--version'], { stdio: 'ignore' });
  } catch {
    return null;
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

  return null;
}

/**
 * Determine the Letta API base URL.
 *
 * Checks LETTA_BASE_URL, then LETTA_API_URL, then defaults to Letta Cloud.
 */
function resolveBaseUrl(): string {
  if (process.env.LETTA_BASE_URL) return process.env.LETTA_BASE_URL;
  if (process.env.LETTA_API_URL) return process.env.LETTA_API_URL;
  // Default: Letta Cloud
  return 'https://api.letta.com';
}

/**
 * Check if the given base URL points to Letta Cloud.
 */
function isLettaCloud(baseUrl: string): boolean {
  return baseUrl.includes('api.letta.com');
}

/**
 * Parse auth helper arguments from environment variable.
 *
 * Supports two formats:
 * 1. JSON array: '["arg1", "arg2", "arg3"]'
 * 2. Whitespace-separated string: "arg1 arg2 arg3"
 *
 * Returns empty array if not set or empty.
 */
function parseAuthHelperArgs(): string[] {
  const raw = process.env.LETTA_SYNC_AUTH_HELPER_ARGS;
  if (!raw || raw.trim().length === 0) return [];

  const trimmed = raw.trim();

  // Try JSON array first (starts with '[')
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(arg => String(arg));
      }
    } catch {
      // Fall through to whitespace splitting
    }
  }

  // Whitespace-separated fallback
  return trimmed.split(/\s+/).filter(arg => arg.length > 0);
}

/**
 * Attempt to resolve API key via external auth helper command.
 *
 * The helper is invoked without a shell (execFileSync) for security.
 * It should print the token to stdout and exit 0 on success.
 *
 * Returns null on failure (command not found, non-zero exit, empty output).
 */
function resolveAuthHelperApiKey(): string | null {
  const helper = process.env.LETTA_SYNC_AUTH_HELPER;
  if (!helper || helper.trim().length === 0) return null;

  const args = parseAuthHelperArgs();

  try {
    const output = execFileSync(helper, args, {
      encoding: 'utf-8',
      timeout: 30000, // 30 second timeout
      stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored, capture stdout/stderr
    });

    const token = output.trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    // Auth helper failed - log for debugging but fall through to other methods
    // This allows graceful degradation when helper is unavailable
    if (process.env.DEBUG || process.env.LETTA_SYNC_DEBUG) {
      console.error(`[letta-auth] Auth helper failed: ${err}`);
    }
    return null;
  }
}

/**
 * Resolve API key from ~/.letta/settings.json.
 *
 * This file is written by `letta setup` and contains:
 * {
 *   "env": {
 *     "LETTA_API_KEY": "..."
 *   }
 * }
 */
function resolveSettingsApiKey(): string | null {
  const settingsPath = path.join(os.homedir(), '.letta', 'settings.json');

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const env = obj?.env as Record<string, unknown> | undefined;
    const fromFile = env?.LETTA_API_KEY;

    if (typeof fromFile === 'string' && fromFile.trim().length > 0) {
      return fromFile.trim();
    }
  } catch {
    // File doesn't exist or isn't valid JSON - that's fine
  }

  return null;
}

/**
 * Resolve LETTA_API_KEY for letta-sync.
 *
 * This function implements the full auth resolution chain:
 *
 * 1. For self-hosted servers (base URL is NOT api.letta.com):
 *    - If LETTA_SERVER_PASSWORD is set, use it immediately
 *
 * 2. For all environments (including Cloud):
 *    a) Try LETTA_SYNC_AUTH_HELPER external command
 *    b) Try LETTA_API_KEY environment variable
 *    c) Try ~/.letta/settings.json (from `letta setup`)
 *
 * @returns The resolved API key/token, or null if no credentials found
 */
export function resolveLettaApiKey(): string | null {
  const baseUrl = resolveBaseUrl();
  const isCloud = isLettaCloud(baseUrl);

  // For self-hosted, LETTA_SERVER_PASSWORD takes precedence
  if (!isCloud) {
    const serverPw = process.env.LETTA_SERVER_PASSWORD;
    if (serverPw && serverPw.trim().length > 0) {
      return serverPw.trim();
    }
  }

  // For Letta Cloud, prefer vault-backed key when present.
  if (isCloud) {
    const fromVault = resolveVaultApiKey();
    if (fromVault) return fromVault;
  }

  // Try auth helper first (if configured)
  const fromHelper = resolveAuthHelperApiKey();
  if (fromHelper) return fromHelper;

  // Try environment variable
  const fromEnv = process.env.LETTA_API_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  // Try settings file (written by `letta setup`)
  const fromSettings = resolveSettingsApiKey();
  if (fromSettings) return fromSettings;

  return null;
}

/**
 * Get the resolved base URL for the Letta API.
 *
 * Exported for use by other modules that need to know the target endpoint.
 */
export function getLettaBaseUrl(): string {
  return resolveBaseUrl();
}

/**
 * Check if the current configuration targets Letta Cloud.
 *
 * Exported for use by other modules that may need to adjust behavior
 * based on Cloud vs self-hosted deployment.
 */
export function isTargetingLettaCloud(): boolean {
  return isLettaCloud(resolveBaseUrl());
}
