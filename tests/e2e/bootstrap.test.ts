/**
 * E2E Tests: Bootstrap Flow
 *
 * Tests for creating new agents from templates using `smarty-admin bootstrap`.
 * Validates that agents are correctly created with proper tagging, identity
 * attachment, and initial configuration.
 *
 * Test approaches:
 * - CLI execution tests (via helpers.ts) - tests full command execution
 * - Direct function tests - tests command functions directly for reliability
 *
 * @see docs/testing/e2e-test-cases.md
 * @see tools/smarty-admin/src/commands/bootstrap.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createFullEnvironment,
  createMinimalEnvironment,
  type TestEnvironment,
} from './harness.js';
import {
  execCLI,
  execBootstrap,
  assertCLIResult,
} from './helpers.js';
import {
  STANDARD_PROJECT,
} from './fixtures/index.js';
import type { CommandContext, GlobalOptions, BootstrapConfig } from '../../src/types.js';
import { bootstrapCommand, type BootstrapOptions } from '../../src/commands/bootstrap.js';

// =============================================================================
// Helper Functions for Direct Function Testing
// =============================================================================

/**
 * Create a test command context for direct function testing
 */
function createTestContext(overrides: Partial<GlobalOptions> = {}): CommandContext {
  const defaultOpts: GlobalOptions = {
    dryRun: true,
    json: true,
    channel: 'stable',
    verbose: false,
    ...overrides,
  };

  return {
    options: defaultOpts,
    outputFormat: 'json',
    project: { slug: 'test-project' },
    projectSource: 'cli',
  };
}

// =============================================================================
// CLI Execution Tests (Full E2E)
// =============================================================================

describe('bootstrap command (CLI)', () => {
  let env: TestEnvironment;

  afterEach(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  describe('argument validation', () => {
    it('requires --name argument', async () => {
      env = await createMinimalEnvironment('bootstrap-req-name');

      const result = await execCLI(['bootstrap'], { testEnv: env });

      expect(result.success).toBe(false);
      expect(result.output.toLowerCase()).toContain('name');
    });

    it('accepts --name argument', async () => {
      env = await createFullEnvironment('bootstrap-with-name', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execBootstrap('my-test-agent', {
        testEnv: env,
        dryRun: true,
        skipUpgrade: true,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('my-test-agent');
    });
  });

  describe('dry-run mode', () => {
    it('shows what would be created without applying', async () => {
      env = await createFullEnvironment('bootstrap-dry', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execBootstrap('dry-run-agent', {
        testEnv: env,
        dryRun: true,
        skipUpgrade: true,
      });

      assertCLIResult(result, {
        success: true,
        outputContains: ['dry-run-agent'],
      });
    });

    it('dry-run returns JSON output with --json flag', async () => {
      env = await createFullEnvironment('bootstrap-dry-json', {
        projectConfig: STANDARD_PROJECT,
      });

      const result = await execCLI(
        ['bootstrap', '--name', 'json-agent', '--dry-run', '--json', '--skip-upgrade'],
        { testEnv: env }
      );

      expect(result.success).toBe(true);
      expect(result.json).toBeDefined();

      const data = result.json as { success?: boolean; data?: { agentName?: string } };
      expect(data.success).toBe(true);
      expect(data.data?.agentName).toBe('json-agent');
    });
  });

  describe('help and usage', () => {
    it('shows help with bootstrap --help', async () => {
      const result = await execCLI(['bootstrap', '--help']);

      assertCLIResult(result, {
        success: true,
        outputContains: ['--name', '--template', '--minimal'],
      });
    });
  });
});

// =============================================================================
// Direct Function Tests (Unit-style E2E)
// =============================================================================

describe('Bootstrap Flow (Direct Function Tests)', () => {
  describe('BOOT-01: Basic Agent Creation', () => {
    it('should create an agent with a valid name', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'test-agent-001',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.agentName).toBe('test-agent-001');
    });

    it('should fail without an agent name', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {};

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Please provide an agent name with --name <name>');
    });
  });

  describe('BOOT-02: Template Selection', () => {
    it('should use default template when none specified', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'template-test-agent',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.template).toBeUndefined();
    });

    it('should accept custom template specification', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'custom-template-agent',
        template: 'lane-dev',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.template).toBe('lane-dev');
    });
  });

  describe('BOOT-03: Agent Tagging', () => {
    it('should apply standard management tags', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'tagged-agent',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeDefined();

      const tags = result.data?.tags ?? [];

      expect(tags.some(t => t.startsWith('managed:'))).toBe(true);
      expect(tags.some(t => t.startsWith('channel:'))).toBe(true);
      expect(tags.some(t => t.startsWith('role:'))).toBe(true);
    });

    it('should apply channel tag matching context', async () => {
      const ctx = createTestContext({ dryRun: true, channel: 'beta' });
      const options: BootstrapOptions = {
        name: 'beta-agent',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.tags).toContain('channel:beta');
    });
  });

  describe('BOOT-04: Identity Attachment', () => {
    it('should attach primary identity when specified', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: BootstrapOptions = {
        name: 'identity-agent',
        identity: 'user123',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.identities).toBeDefined();
      expect(result.data?.identities?.length).toBeGreaterThanOrEqual(1);
    });

    it('should attach multiple identities when specified', async () => {
      const ctx = createTestContext({ dryRun: true, org: 'test-org' });
      const options: BootstrapOptions = {
        name: 'multi-identity-agent',
        identity: 'primary_user',
        identities: ['secondary_user', 'third_user'],
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.identities).toBeDefined();
      expect(result.data?.identities?.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('BOOT-05: Minimal Configuration', () => {
    it('should create minimal agent when --minimal flag is set', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'minimal-agent',
        minimal: true,
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.systemPrompt).toBe('You are a helpful assistant.');
      expect(result.data?.tools).toEqual([]);
    });
  });

  describe('BOOT-06: Dry Run Mode', () => {
    it('should not create actual resources in dry-run mode', async () => {
      const ctx = createTestContext({ dryRun: true });
      const options: BootstrapOptions = {
        name: 'dry-run-agent',
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Dry run');
    });
  });
});

// =============================================================================
// Bootstrap Integration Tests
// =============================================================================

describe('Bootstrap Integration Tests', () => {
  describe('BOOT-INT-01: End-to-End Bootstrap Flow', () => {
    it('should complete full bootstrap workflow in dry-run', async () => {
      const ctx = createTestContext({
        dryRun: true,
        project: 'integration-project',
        org: 'test-org',
        channel: 'stable',
      });
      const options: BootstrapOptions = {
        name: 'full-integration-agent',
        template: 'lane-dev',
        identity: 'test_user',
        skipUpgrade: true,
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();

      const data = result.data!;
      expect(data.agentName).toBe('full-integration-agent');
      expect(data.template).toBe('lane-dev');
      expect(data.identities?.length).toBeGreaterThan(0);
      expect(data.tags).toBeDefined();
    });
  });

  describe('BOOT-INT-02: Bootstrap with All Options', () => {
    it('should handle all bootstrap options together', async () => {
      const ctx = createTestContext({
        dryRun: true,
        project: 'full-options-project',
        org: 'full-org',
        channel: 'beta',
        verbose: true,
      });
      const options: BootstrapOptions = {
        name: 'all-options-agent',
        template: 'lane-dev',
        minimal: false,
        identity: 'primary_identity',
        identities: ['secondary_identity'],
        autoCreateIdentity: true,
        skipUpgrade: true,
        additionalTags: ['custom:tag1', 'custom:tag2'],
      };

      const result = await bootstrapCommand(ctx, options);

      expect(result.success).toBe(true);
      expect(result.data?.tags).toBeDefined();

      const tags = result.data?.tags ?? [];
      expect(tags.some(t => t === 'custom:tag1')).toBe(true);
      expect(tags.some(t => t === 'custom:tag2')).toBe(true);
    });
  });
});
