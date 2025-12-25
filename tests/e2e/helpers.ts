/**
 * E2E Test Helpers for smarty-admin CLI
 * 
 * Provides utilities for:
 * - Executing CLI commands
 * - Capturing and parsing output
 * - Asserting on results
 */

import { spawn, SpawnOptions, ChildProcess } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestEnvironment } from './harness.js';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Path to the CLI entry point
 */
export const CLI_PATH = join(__dirname, '../../dist/cli.js');

/**
 * Path to the CLI source for ts-node/tsx execution
 */
export const CLI_SRC_PATH = join(__dirname, '../../src/cli.ts');

/**
 * Result of executing a CLI command
 */
export interface CLIResult {
  /** Exit code of the process */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Combined output (stdout + stderr) */
  output: string;
  /** Parsed JSON output (if --json flag was used) */
  json?: unknown;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the command succeeded (exit code 0) */
  success: boolean;
}

/**
 * Options for executing CLI commands
 */
export interface ExecOptions {
  /** Working directory (defaults to env.root if env provided) */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Test environment to use */
  testEnv?: TestEnvironment;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to use tsx for TypeScript execution (default: false) */
  useTsx?: boolean;
  /** Additional arguments to prepend */
  prependArgs?: string[];
}

/**
 * Execute a smarty-admin CLI command
 * 
 * @param args - Command line arguments
 * @param options - Execution options
 * @returns Promise resolving to CLI result
 */
export async function execCLI(
  args: string[],
  options: ExecOptions = {}
): Promise<CLIResult> {
  const {
    testEnv,
    timeout = 30000,
    useTsx = false,
    prependArgs = [],
  } = options;
  
  // Determine working directory
  const cwd = options.cwd ?? testEnv?.root ?? process.cwd();
  
  // Build environment variables
  const env = {
    ...process.env,
    ...testEnv?.env,
    ...options.env,
  };
  
  // Determine how to run the CLI
  let command: string;
  let commandArgs: string[];
  
  if (useTsx) {
    // Run TypeScript source directly with tsx
    command = 'npx';
    commandArgs = ['tsx', CLI_SRC_PATH, ...prependArgs, ...args];
  } else {
    // Run compiled JavaScript
    command = 'node';
    commandArgs = [CLI_PATH, ...prependArgs, ...args];
  }
  
  return new Promise<CLIResult>((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    
    const spawnOptions: SpawnOptions = {
      cwd,
      env: env as NodeJS.ProcessEnv,
      shell: false,
    };
    
    const child: ChildProcess = spawn(command, commandArgs, spawnOptions);
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);
    
    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    
    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    
    // Handle completion
    child.on('close', (code) => {
      clearTimeout(timeoutId);
      
      const durationMs = Date.now() - startTime;
      const exitCode = timedOut ? 124 : (code ?? 1);
      const output = stdout + stderr;
      
      // Try to parse JSON output
      let json: unknown;
      try {
        // Look for JSON in stdout (typically from --json flag)
        const jsonMatch = stdout.match(/^\{[\s\S]*\}$/m) || stdout.match(/^\[[\s\S]*\]$/m);
        if (jsonMatch) {
          json = JSON.parse(jsonMatch[0]);
        }
      } catch {
        // Not valid JSON, ignore
      }
      
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: output.trim(),
        json,
        durationMs,
        success: exitCode === 0,
      });
    });
    
    // Handle errors
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        output: err.message,
        durationMs: Date.now() - startTime,
        success: false,
      });
    });
  });
}

/**
 * Execute CLI with JSON output flag
 */
export async function execCLIJson<T = unknown>(
  args: string[],
  options: ExecOptions = {}
): Promise<CLIResult & { json: T | undefined }> {
  const result = await execCLI([...args, '--json'], options);
  return result as CLIResult & { json: T | undefined };
}

/**
 * Execute bootstrap command
 */
export async function execBootstrap(
  name: string,
  options: ExecOptions & {
    template?: string;
    minimal?: boolean;
    identity?: string;
    dryRun?: boolean;
    skipUpgrade?: boolean;
  } = {}
): Promise<CLIResult> {
  const args = ['bootstrap', '--name', name];
  
  if (options.template) args.push('--template', options.template);
  if (options.minimal) args.push('--minimal');
  if (options.identity) args.push('--identity', options.identity);
  if (options.dryRun) args.push('--dry-run');
  if (options.skipUpgrade) args.push('--skip-upgrade');
  
  return execCLI(args, options);
}

/**
 * Execute upgrade command
 */
export async function execUpgrade(
  options: ExecOptions & {
    check?: boolean;
    apply?: boolean;
    force?: boolean;
    target?: string;
    agent?: string;
  } = {}
): Promise<CLIResult> {
  const args = ['upgrade'];
  
  if (options.check) args.push('--check');
  if (options.apply) args.push('--apply');
  if (options.force) args.push('--force');
  if (options.target) args.push('--target', options.target);
  if (options.agent) args.push('--agent', options.agent);
  
  return execCLI(args, options);
}

/**
 * Execute diff command
 */
export async function execDiff(
  options: ExecOptions & {
    full?: boolean;
    versions?: boolean;
    agent?: string;
  } = {}
): Promise<CLIResult> {
  const args = ['diff'];
  
  if (options.full) args.push('--full');
  if (options.versions) args.push('--versions');
  if (options.agent) args.push('--agent', options.agent);
  
  return execCLI(args, options);
}

/**
 * Execute status command
 */
export async function execStatus(
  options: ExecOptions & {
    extended?: boolean;
    agent?: string;
  } = {}
): Promise<CLIResult> {
  const args = ['status'];
  
  if (options.extended) args.push('--extended');
  if (options.agent) args.push('--agent', options.agent);
  
  return execCLI(args, options);
}

/**
 * Execute sync command
 */
export async function execSync(
  options: ExecOptions & {
    force?: boolean;
    only?: string[];
    dryRun?: boolean;
  } = {}
): Promise<CLIResult> {
  const args = ['sync'];
  
  if (options.force) args.push('--force');
  if (options.only) args.push('--only', ...options.only);
  if (options.dryRun) args.push('--dry-run');
  
  return execCLI(args, options);
}

/**
 * Assert that CLI result matches expected values
 */
export function assertCLIResult(
  result: CLIResult,
  expected: {
    success?: boolean;
    exitCode?: number;
    stdoutContains?: string | string[];
    stderrContains?: string | string[];
    outputContains?: string | string[];
    stdoutNotContains?: string | string[];
    jsonPath?: Record<string, unknown>;
  }
): void {
  if (expected.success !== undefined) {
    if (result.success !== expected.success) {
      throw new Error(
        `Expected success=${expected.success}, got ${result.success}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`
      );
    }
  }
  
  if (expected.exitCode !== undefined) {
    if (result.exitCode !== expected.exitCode) {
      throw new Error(
        `Expected exit code ${expected.exitCode}, got ${result.exitCode}\n` +
        `Output: ${result.output}`
      );
    }
  }
  
  const checkContains = (
    content: string,
    patterns: string | string[],
    name: string
  ): void => {
    const patternList = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of patternList) {
      if (!content.includes(pattern)) {
        throw new Error(
          `Expected ${name} to contain "${pattern}"\n` +
          `Actual ${name}: ${content}`
        );
      }
    }
  };
  
  const checkNotContains = (
    content: string,
    patterns: string | string[],
    name: string
  ): void => {
    const patternList = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of patternList) {
      if (content.includes(pattern)) {
        throw new Error(
          `Expected ${name} to NOT contain "${pattern}"\n` +
          `Actual ${name}: ${content}`
        );
      }
    }
  };
  
  if (expected.stdoutContains) {
    checkContains(result.stdout, expected.stdoutContains, 'stdout');
  }
  
  if (expected.stderrContains) {
    checkContains(result.stderr, expected.stderrContains, 'stderr');
  }
  
  if (expected.outputContains) {
    checkContains(result.output, expected.outputContains, 'output');
  }
  
  if (expected.stdoutNotContains) {
    checkNotContains(result.stdout, expected.stdoutNotContains, 'stdout');
  }
  
  if (expected.jsonPath && result.json) {
    for (const [path, expectedValue] of Object.entries(expected.jsonPath)) {
      const actualValue = getNestedValue(result.json, path);
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        throw new Error(
          `Expected json.${path} to equal ${JSON.stringify(expectedValue)}, ` +
          `got ${JSON.stringify(actualValue)}`
        );
      }
    }
  }
}

/**
 * Get nested value from object using dot notation
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  
  return current;
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Create a test reporter for tracking test results
 */
export interface TestReport {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  output?: string;
}

export class TestReporter {
  private results: TestReport[] = [];
  
  addResult(result: TestReport): void {
    this.results.push(result);
  }
  
  get passedCount(): number {
    return this.results.filter(r => r.passed).length;
  }
  
  get failedCount(): number {
    return this.results.filter(r => !r.passed).length;
  }
  
  get totalCount(): number {
    return this.results.length;
  }
  
  get allPassed(): boolean {
    return this.failedCount === 0;
  }
  
  getSummary(): string {
    const lines: string[] = [
      `\nTest Results: ${this.passedCount}/${this.totalCount} passed`,
      '-'.repeat(50),
    ];
    
    for (const result of this.results) {
      const status = result.passed ? '[PASS]' : '[FAIL]';
      const time = `(${result.durationMs}ms)`;
      lines.push(`${status} ${result.name} ${time}`);
      
      if (!result.passed && result.error) {
        lines.push(`       Error: ${result.error}`);
      }
    }
    
    return lines.join('\n');
  }
  
  toJSON(): { results: TestReport[]; summary: { passed: number; failed: number; total: number } } {
    return {
      results: this.results,
      summary: {
        passed: this.passedCount,
        failed: this.failedCount,
        total: this.totalCount,
      },
    };
  }
}
