/**
 * Vitest Configuration for smarty-admin
 *
 * Configures both unit tests and E2E tests.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Include test files
    include: ['tests/**/*.test.ts'],

    // Exclude patterns
    exclude: ['**/node_modules/**', '**/dist/**'],

    // Setup files run before tests
    setupFiles: ['./tests/e2e/setup.ts'],

    // Test timeout (30 seconds for E2E tests)
    testTimeout: 30000,

    // Enable globals for describe, it, expect
    globals: true,

    // Reporter configuration
    reporters: ['verbose'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/cli.ts'],
    },

    // Environment
    environment: 'node',

    // Type checking
    typecheck: {
      enabled: false, // Disable for faster tests; use tsc --noEmit separately
    },
  },

  // Resolve configuration for imports
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
