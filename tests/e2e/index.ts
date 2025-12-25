/**
 * E2E Test Index
 *
 * This file exports shared utilities and re-exports test modules
 * for easier importing in test runners and CI/CD pipelines.
 */

// Export setup utilities
export * from './setup.js';

// Test suites are auto-discovered by vitest based on *.test.ts pattern
// This file provides programmatic access if needed

/**
 * E2E Test Categories
 *
 * 1. Bootstrap Tests (bootstrap.test.ts)
 *    - Agent creation from templates
 *    - Tag assignment
 *    - Identity attachment
 *    - Project resolution
 *
 * 2. Upgrade Tests (upgrade.test.ts)
 *    - Package update detection
 *    - Safe vs breaking change classification
 *    - Force flag behavior
 *    - Multi-layer upgrades
 *
 * 3. Diff Tests (diff.test.ts)
 *    - Drift detection (value, description, limit, metadata)
 *    - Block classification (managed, unmanaged, orphaned, adopted)
 *    - Summary accuracy
 *
 * 4. Idempotency Tests (idempotency.test.ts)
 *    - Command repeatability
 *    - Convergence behavior
 *    - State stability
 */

/**
 * Run modes:
 *
 * Unit tests (mock API):
 *   npm run test:e2e
 *
 * Integration tests (live API):
 *   E2E_LIVE_API=true LETTA_API_KEY=... npm run test:e2e
 *
 * All tests with coverage:
 *   npm run test:coverage
 */
