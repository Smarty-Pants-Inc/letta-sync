/**
 * E2E Test Harness for letta-sync CLI
 * 
 * Provides setup/teardown for isolated test environments including:
 * - Temporary project directories
 * - Mock Letta API configurations
 * - Git repository setup
 * - Cleanup after tests
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Configuration for a test environment
 */
export interface TestEnvironmentConfig {
  /** Name of the test (used for directory naming) */
  name: string;
  /** Whether to initialize a git repository */
  initGit?: boolean;
  /** Whether to create .letta directory structure (includes project.json) */
  initLetta?: boolean;
  /** Whether to create legacy .smarty directory structure (for backwards compat testing) */
  initSmarty?: boolean;
  /** Custom project configuration */
  projectConfig?: ProjectConfig;
  /** Mock agent ID to use */
  mockAgentId?: string;
  /** Environment variables to set */
  env?: Record<string, string>;
}

/**
 * Project configuration for .letta/project.json
 */
export interface ProjectConfig {
  slug?: string;
  id?: string;
  name?: string;
  org?: string;
}

/**
 * Represents an isolated test environment
 */
export interface TestEnvironment {
  /** Root directory of the test environment */
  root: string;
  /** Path to .letta directory (primary config location) */
  lettaDir: string;
  /** Path to .smarty directory (legacy, for backwards compat testing) */
  smartyDir: string;
  /** Environment variables for this test */
  env: Record<string, string>;
  /** Cleanup function */
  cleanup: () => Promise<void>;
}

/**
 * Default project configuration for tests
 */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  slug: 'test-project',
  id: 'proj_test123',
  name: 'Test Project',
  org: 'test-org',
};

/**
 * Default mock agent ID
 */
export const DEFAULT_MOCK_AGENT_ID = 'agent-e2e-test-001';

/**
 * Create an isolated test environment
 */
export async function createTestEnvironment(
  config: TestEnvironmentConfig
): Promise<TestEnvironment> {
  // Create temporary directory
  const prefix = `letta-sync-e2e-${config.name}-`;
  const root = await mkdtemp(join(tmpdir(), prefix));
  
  const lettaDir = join(root, '.letta');
  const smartyDir = join(root, '.smarty');
  
  // Initialize .letta directory (primary config location)
  if (config.initLetta !== false) {
    await mkdir(lettaDir, { recursive: true });
    
    // Create settings.local.json with mock agent
    const agentId = config.mockAgentId ?? DEFAULT_MOCK_AGENT_ID;
    await writeFile(
      join(lettaDir, 'settings.local.json'),
      JSON.stringify({ lastAgent: agentId }, null, 2)
    );
    
    // Create settings.json for block IDs cache
    await writeFile(
      join(lettaDir, 'settings.json'),
      JSON.stringify({ localSharedBlockIds: {} }, null, 2)
    );
    
    // Create project.json in .letta (primary location)
    const projectConfig = config.projectConfig ?? DEFAULT_PROJECT_CONFIG;
    await writeFile(
      join(lettaDir, 'project.json'),
      JSON.stringify(projectConfig, null, 2)
    );
  }
  
  // Initialize legacy .smarty directory (for backwards compat testing only)
  if (config.initSmarty) {
    await mkdir(smartyDir, { recursive: true });
    
    // Create project.json in .smarty (legacy location)
    const projectConfig = config.projectConfig ?? DEFAULT_PROJECT_CONFIG;
    await writeFile(
      join(smartyDir, 'project.json'),
      JSON.stringify(projectConfig, null, 2)
    );
  }
  
  // Initialize git repository if requested
  if (config.initGit) {
    execSync('git init', { cwd: root, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: root, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: root, stdio: 'pipe' });
    
    // Create initial commit
    await writeFile(join(root, 'README.md'), '# Test Project\n');
    execSync('git add .', { cwd: root, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: root, stdio: 'pipe' });
  }
  
  // Build environment variables
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Mock API key for tests
    LETTA_API_KEY: 'test-api-key-e2e',
    // Disable color output for consistent test results
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // Custom env from config
    ...config.env,
  };
  
  // Cleanup function
  const cleanup = async (): Promise<void> => {
    try {
      if (existsSync(root)) {
        await rm(root, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors in tests
      console.warn(`Warning: Failed to cleanup ${root}:`, err);
    }
  };
  
  return {
    root,
    lettaDir,
    smartyDir,
    env,
    cleanup,
  };
}

/**
 * Create a minimal test environment (no git, just directories)
 */
export async function createMinimalEnvironment(
  name: string
): Promise<TestEnvironment> {
  return createTestEnvironment({
    name,
    initGit: false,
    initLetta: true,
    initSmarty: false,
  });
}

/**
 * Create a full test environment with git repository
 */
export async function createFullEnvironment(
  name: string,
  options: Partial<TestEnvironmentConfig> = {}
): Promise<TestEnvironment> {
  return createTestEnvironment({
    name,
    initGit: true,
    initLetta: true,
    initSmarty: false,
    ...options,
  });
}

/**
 * Utility to read JSON file from test environment
 */
export async function readJsonFile<T>(
  env: TestEnvironment,
  relativePath: string
): Promise<T> {
  const content = await readFile(join(env.root, relativePath), 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * Utility to write JSON file to test environment
 */
export async function writeJsonFile(
  env: TestEnvironment,
  relativePath: string,
  data: unknown
): Promise<void> {
  await writeFile(
    join(env.root, relativePath),
    JSON.stringify(data, null, 2)
  );
}

/**
 * Create a scope registry file for testing scope-related features
 */
export async function createScopeRegistry(
  env: TestEnvironment,
  scopes: ScopeDefinition[] = []
): Promise<void> {
  const registryContent = {
    scopes: scopes.length > 0 ? scopes : [
      {
        scope: 'test-scope',
        match: {
          path_prefixes: ['src/'],
        },
        attach: {
          block_types: ['project', 'decisions', 'conventions', 'glossary'],
        },
      },
    ],
  };
  
  await writeJsonFile(env, '.letta/scope-registry.json', registryContent);
}

/**
 * Scope definition for registry
 */
export interface ScopeDefinition {
  scope: string;
  match: {
    path_prefixes: string[];
  };
  attach: {
    block_types: string[];
  };
}

/**
 * Test harness class for managing multiple test environments
 */
export class TestHarness {
  private environments: TestEnvironment[] = [];
  
  /**
   * Create and track a new test environment
   */
  async createEnvironment(config: TestEnvironmentConfig): Promise<TestEnvironment> {
    const env = await createTestEnvironment(config);
    this.environments.push(env);
    return env;
  }
  
  /**
   * Cleanup all tracked environments
   */
  async cleanupAll(): Promise<void> {
    const cleanupPromises = this.environments.map(env => env.cleanup());
    await Promise.all(cleanupPromises);
    this.environments = [];
  }
  
  /**
   * Get count of active environments
   */
  get environmentCount(): number {
    return this.environments.length;
  }
}

/**
 * Global test harness instance for use with beforeEach/afterEach hooks
 */
let globalHarness: TestHarness | null = null;

/**
 * Get or create the global test harness
 */
export function getGlobalHarness(): TestHarness {
  if (!globalHarness) {
    globalHarness = new TestHarness();
  }
  return globalHarness;
}

/**
 * Setup function for use in beforeAll/beforeEach
 */
export function setupTestHarness(): TestHarness {
  return getGlobalHarness();
}

/**
 * Teardown function for use in afterAll/afterEach
 */
export async function teardownTestHarness(): Promise<void> {
  if (globalHarness) {
    await globalHarness.cleanupAll();
    globalHarness = null;
  }
}
