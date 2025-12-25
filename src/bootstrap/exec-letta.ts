/**
 * Exec Letta - Launch Letta Code with a pinned agent
 *
 * This is the final step in the bootstrap flow. After an agent exists and is
 * upgraded, this module handles launching Letta Code with the correct:
 * - Agent ID (--agent flag)
 * - Environment variables (LETTA_API_KEY)
 * - Working directory (project root)
 */

import { spawn, execSync, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Error thrown when the letta executable cannot be found
 */
export class LettaNotFoundError extends Error {
  constructor(
    public readonly searchedPaths: string[],
    public readonly suggestion: string = 'Install Letta Code with `npm install -g @letta-ai/letta-code` or ensure it\'s in your PATH'
  ) {
    super(`Letta Code executable not found in PATH`);
    this.name = 'LettaNotFoundError';
  }

  toUserMessage(): string {
    let msg = `Error: ${this.message}`;
    if (this.searchedPaths.length > 0) {
      msg += `\n\nSearched paths:\n${this.searchedPaths.map(p => `  - ${p}`).join('\n')}`;
    }
    msg += `\n\nSuggestion: ${this.suggestion}`;
    return msg;
  }
}

/**
 * Error thrown when LETTA_API_KEY is not configured
 */
export class MissingApiKeyError extends Error {
  constructor() {
    super('LETTA_API_KEY environment variable is not set');
    this.name = 'MissingApiKeyError';
  }

  toUserMessage(): string {
    return `Error: ${this.message}\n\nSuggestion: Set the LETTA_API_KEY environment variable or configure it in your shell profile`;
  }
}

/**
 * Options for executing Letta Code
 */
export interface ExecLettaOptions {
  /** Agent ID to pass via --agent flag */
  agentId: string;
  /** Working directory for letta (defaults to cwd) */
  cwd?: string;
  /** API key (defaults to LETTA_API_KEY env var) */
  apiKey?: string;
  /** Additional arguments to pass to letta */
  extraArgs?: string[];
  /** Verbose logging callback */
  verbose?: (msg: string) => void;
  /** Skip API key validation */
  skipApiKeyCheck?: boolean;
  /** Custom letta executable path (bypasses PATH search) */
  lettaPath?: string;
}

/**
 * Result of letta path resolution
 */
export interface LettaPathResult {
  /** Resolved path to letta executable */
  path: string;
  /** How the path was found */
  source: 'custom' | 'which' | 'npm-global' | 'common-path';
}

/**
 * Common installation paths to check for letta executable
 */
const COMMON_LETTA_PATHS = [
  // npm global (Unix)
  '/usr/local/bin/letta',
  // npm global (macOS with nvm)
  `${process.env.HOME}/.nvm/versions/node/*/bin/letta`,
  // npm global (Linux)
  `${process.env.HOME}/.npm-global/bin/letta`,
  // Homebrew (macOS)
  '/opt/homebrew/bin/letta',
  // Local node_modules
  './node_modules/.bin/letta',
];

/**
 * Find the letta executable in PATH or common locations
 *
 * @param customPath - Optional custom path to use directly
 * @param verbose - Optional logging callback
 * @returns LettaPathResult with the resolved path
 * @throws LettaNotFoundError if letta cannot be found
 */
export function findLettaExecutable(
  customPath?: string,
  verbose?: (msg: string) => void
): LettaPathResult {
  const log = verbose ?? (() => {});
  const searchedPaths: string[] = [];

  function looksLikeLettaCode(binPath: string): boolean {
    try {
      const out = execSync(`${binPath} --help`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.includes('Letta Code');
    } catch {
      return false;
    }
  }

  // If custom path provided, use it directly
  if (customPath) {
    log(`Using custom letta path: ${customPath}`);
    if (existsSync(customPath)) {
      return { path: customPath, source: 'custom' };
    }
    throw new LettaNotFoundError(
      [customPath],
      `Custom letta path does not exist: ${customPath}`
    );
  }

  // Try `which letta` (Unix) or `where letta` (Windows)
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execSync(`${whichCmd} letta`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (result) {
      const lettaPath = result.split('\n')[0].trim();
      log(`Found letta via ${whichCmd}: ${lettaPath}`);

      // Avoid a common naming collision: some systems install a different `letta`
      // binary (e.g. server CLI) which does not support Letta Code operations.
      if (looksLikeLettaCode(lettaPath)) {
        return { path: lettaPath, source: 'which' };
      }
      log(`Binary at ${lettaPath} is not Letta Code (help output mismatch); continuing search...`);
    }
  } catch {
    log(`letta not found in PATH via which/where`);
    searchedPaths.push('PATH (via which/where)');
  }

  // Try npm global bin
  try {
    const npmBin = execSync('npm bin -g', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const npmLettaPath = join(npmBin, 'letta');
    log(`Checking npm global bin: ${npmLettaPath}`);
    searchedPaths.push(npmLettaPath);

    if (existsSync(npmLettaPath) && looksLikeLettaCode(npmLettaPath)) {
      log(`Found Letta Code in npm global: ${npmLettaPath}`);
      return { path: npmLettaPath, source: 'npm-global' };
    }
  } catch {
    log(`Failed to get npm global bin`);
  }

  // Check common paths
  for (const commonPath of COMMON_LETTA_PATHS) {
    // Skip glob patterns for now (would need to expand them)
    if (commonPath.includes('*')) {
      continue;
    }

    const expandedPath = commonPath.replace('$HOME', process.env.HOME ?? '~');
    log(`Checking common path: ${expandedPath}`);
    searchedPaths.push(expandedPath);

    if (existsSync(expandedPath) && looksLikeLettaCode(expandedPath)) {
      log(`Found Letta Code at common path: ${expandedPath}`);
      return { path: expandedPath, source: 'common-path' };
    }
  }

  // Not found
  throw new LettaNotFoundError(searchedPaths);
}

/**
 * Build the environment for launching letta
 *
 * @param apiKey - API key to set (or use from env)
 * @param extraEnv - Additional environment variables
 * @returns Environment object for spawn
 */
export function buildLettaEnvironment(
  apiKey?: string,
  extraEnv?: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Set or override LETTA_API_KEY
  if (apiKey) {
    env.LETTA_API_KEY = apiKey;
  }

  // Merge any extra environment variables
  if (extraEnv) {
    Object.assign(env, extraEnv);
  }

  return env;
}

/**
 * Validate that all required configuration is present
 *
 * @param options - Exec options to validate
 * @throws MissingApiKeyError if API key is not available
 */
export function validateExecConfig(options: ExecLettaOptions): void {
  if (options.skipApiKeyCheck) {
    return;
  }

  const apiKey = options.apiKey ?? process.env.LETTA_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }
}

/**
 * Build the command-line arguments for letta
 *
 * @param options - Exec options
 * @returns Array of command-line arguments
 */
export function buildLettaArgs(options: ExecLettaOptions): string[] {
  const args: string[] = [];

  // Always pass the agent ID
  args.push('--agent', options.agentId);

  // Add any extra arguments
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  return args;
}

/**
 * Execute Letta Code with the specified agent
 *
 * This function spawns letta as a child process with stdio inherited,
 * effectively replacing the current terminal interaction. The parent
 * process waits for letta to exit.
 *
 * @param options - Execution options
 * @returns Promise that resolves with the exit code
 * @throws LettaNotFoundError if letta cannot be found
 * @throws MissingApiKeyError if API key is not configured
 */
export async function execLetta(options: ExecLettaOptions): Promise<number> {
  const log = options.verbose ?? (() => {});

  // Validate configuration
  log('Validating exec configuration...');
  validateExecConfig(options);

  // Find letta executable
  log('Finding letta executable...');
  const { path: lettaPath, source } = findLettaExecutable(
    options.lettaPath,
    options.verbose
  );
  log(`Using letta from ${source}: ${lettaPath}`);

  // Build arguments
  const args = buildLettaArgs(options);
  log(`Letta arguments: ${args.join(' ')}`);

  // Build environment
  const env = buildLettaEnvironment(options.apiKey);

  // Spawn options
  const spawnOptions: SpawnOptions = {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: 'inherit', // Inherit stdio for interactive use
  };
  log(`Working directory: ${spawnOptions.cwd}`);

  // Launch letta
  log(`Launching: ${lettaPath} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn(lettaPath, args, spawnOptions);

    child.on('error', (error) => {
      reject(new Error(`Failed to launch letta: ${error.message}`));
    });

    child.on('close', (code) => {
      resolve(code ?? 0);
    });
  });
}

/**
 * Synchronously execute Letta Code (for use in CLI completion handlers)
 *
 * Note: This uses execSync which blocks the event loop. Prefer execLetta()
 * for most use cases.
 *
 * @param options - Execution options
 * @throws LettaNotFoundError if letta cannot be found
 * @throws MissingApiKeyError if API key is not configured
 */
export function execLettaSync(options: ExecLettaOptions): void {
  const log = options.verbose ?? (() => {});

  // Validate configuration
  validateExecConfig(options);

  // Find letta executable
  const { path: lettaPath } = findLettaExecutable(
    options.lettaPath,
    options.verbose
  );

  // Build arguments
  const args = buildLettaArgs(options);

  // Build environment
  const env = buildLettaEnvironment(options.apiKey);

  // Execute
  const command = `"${lettaPath}" ${args.map(a => `"${a}"`).join(' ')}`;
  log(`Executing: ${command}`);

  execSync(command, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: 'inherit',
  });
}

/**
 * Check if letta is available without throwing
 *
 * @returns Object with availability status and path if found
 */
export function checkLettaAvailability(): {
  available: boolean;
  path?: string;
  source?: LettaPathResult['source'];
  error?: string;
} {
  try {
    const result = findLettaExecutable();
    return {
      available: true,
      path: result.path,
      source: result.source,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
