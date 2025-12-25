/**
 * E2E Test Setup
 *
 * Shared setup and utilities for E2E tests.
 * This file is automatically loaded by vitest before tests run.
 */

import { beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

/**
 * Global test timeout (ms)
 */
export const TEST_TIMEOUT = 30000;

/**
 * Test project slug used across tests
 */
export const TEST_PROJECT = 'e2e-test-project';

/**
 * Test organization used across tests
 */
export const TEST_ORG = 'e2e-test-org';

/**
 * Generate a unique test agent name
 */
export function generateTestAgentName(prefix = 'test'): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-agent-${timestamp}-${random}`;
}

/**
 * Generate a unique test block label
 */
export function generateTestBlockLabel(prefix = 'test'): string {
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}_block_${random}`;
}

/**
 * Sleep utility for async tests
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function until it succeeds or max attempts reached
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error('Retry failed');
}

/**
 * Global setup - runs once before all tests
 */
beforeAll(async () => {
  // Validate environment
  if (!process.env.LETTA_API_KEY && process.env.E2E_LIVE_API === 'true') {
    console.warn(
      'Warning: LETTA_API_KEY not set. Live API tests will be skipped.'
    );
  }

  // Set test-specific environment variables (use new names, keep backwards compat)
  process.env.LETTA_SYNC_PROJECT = process.env.LETTA_SYNC_PROJECT ?? process.env.SMARTY_PROJECT ?? TEST_PROJECT;
  process.env.LETTA_SYNC_ORG = process.env.LETTA_SYNC_ORG ?? process.env.SMARTY_ORG ?? TEST_ORG;
});

/**
 * Global teardown - runs once after all tests
 */
afterAll(async () => {
  // Cleanup any global resources
});

/**
 * Per-test setup
 */
beforeEach(async () => {
  // Reset any per-test state
});

/**
 * Per-test teardown
 */
afterEach(async () => {
  // Cleanup per-test resources
});

/**
 * Check if live API tests should run
 */
export function shouldRunLiveTests(): boolean {
  return (
    process.env.E2E_LIVE_API === 'true' &&
    Boolean(process.env.LETTA_API_KEY)
  );
}

/**
 * Skip test if live API not available
 */
export function skipIfNoLiveApi(): void {
  if (!shouldRunLiveTests()) {
    console.log('Skipping live API test - LETTA_API_KEY not available');
  }
}

/**
 * Type guard for checking if value is defined
 */
export function isDefined<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

/**
 * Assert that arrays contain the same elements (order-independent)
 * Note: Requires vitest expect to be imported in the test file
 */
export function expectSameElements<T>(
  actual: T[],
  expected: T[],
  comparator?: (a: T, b: T) => boolean
): { equals: boolean; message: string } {
  const comp = comparator ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));

  if (actual.length !== expected.length) {
    return {
      equals: false,
      message: `Array lengths differ: actual ${actual.length}, expected ${expected.length}`,
    };
  }

  for (const item of expected) {
    const found = actual.some(a => comp(a, item));
    if (!found) {
      return {
        equals: false,
        message: `Expected item not found: ${JSON.stringify(item)}`,
      };
    }
  }

  return { equals: true, message: 'Arrays contain same elements' };
}

/**
 * Mock block response factory
 */
export interface MockBlockOptions {
  id?: string;
  label?: string;
  value?: string;
  description?: string;
  limit?: number;
  isManaged?: boolean;
  layer?: 'base' | 'org' | 'project' | 'user' | 'lane';
}

export function createMockBlockResponse(options: MockBlockOptions = {}) {
  const {
    id = `block-${Math.random().toString(36).substring(2)}`,
    label = 'test_block',
    value = 'Test content',
    description = 'A test block',
    limit = 5000,
    isManaged = false,
    layer = 'project',
  } = options;

  return {
    id,
    label,
    value,
    description,
    limit,
    metadata: isManaged
      ? {
          managed_by: 'smarty-admin',
          layer,
          last_synced: new Date().toISOString(),
        }
      : {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mock manifest entry factory
 */
export interface MockManifestOptions {
  label?: string;
  value?: string;
  description?: string;
  layer?: 'base' | 'org' | 'project' | 'user' | 'lane';
  limit?: number;
}

export function createMockManifestEntry(options: MockManifestOptions = {}) {
  const {
    label = 'test_block',
    value = 'Test content',
    description = 'A test block',
    layer = 'project',
    limit,
  } = options;

  return {
    label,
    value,
    description,
    layer,
    ...(limit !== undefined ? { limit } : {}),
  };
}
