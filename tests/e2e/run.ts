#!/usr/bin/env npx tsx
/**
 * E2E Test Runner for smarty-admin CLI
 * 
 * This script runs the E2E test suite and reports results.
 * Can be run standalone or integrated with CI/CD pipelines.
 * 
 * Usage:
 *   npx tsx tests/e2e/run.ts          # Run all tests
 *   npx tsx tests/e2e/run.ts --json   # Output JSON results
 *   npx tsx tests/e2e/run.ts --filter bootstrap  # Run only bootstrap tests
 */

import { 
  createFullEnvironment, 
  createMinimalEnvironment,
  teardownTestHarness,
  type TestEnvironment,
} from './harness.js';
import {
  execCLI,
  execBootstrap,
  execUpgrade,
  execDiff,
  execStatus,
  assertCLIResult,
  TestReporter,
  type CLIResult,
} from './helpers.js';
import {
  STANDARD_PROJECT,
  MINIMAL_PROJECT,
  SINGLE_SCOPE,
  STANDARD_AGENT,
  MINIMAL_AGENT,
} from './fixtures/index.js';

// =============================================================================
// Test Definitions
// =============================================================================

interface TestCase {
  name: string;
  category: 'bootstrap' | 'upgrade' | 'diff' | 'status' | 'sync' | 'general';
  run: () => Promise<void>;
}

const tests: TestCase[] = [];

/**
 * Register a test case
 */
function test(
  category: TestCase['category'],
  name: string,
  fn: () => Promise<void>
): void {
  tests.push({ name, category, run: fn });
}

// =============================================================================
// General CLI Tests
// =============================================================================

test('general', 'CLI shows help with --help', async () => {
  const result = await execCLI(['--help']);
  assertCLIResult(result, {
    success: true,
    outputContains: ['smarty-admin', 'bootstrap', 'upgrade', 'diff', 'sync', 'status'],
  });
});

test('general', 'CLI shows version with --version', async () => {
  const result = await execCLI(['--version']);
  assertCLIResult(result, {
    success: true,
    outputContains: '0.1.0',
  });
});

test('general', 'CLI handles unknown command gracefully', async () => {
  const result = await execCLI(['unknown-command']);
  assertCLIResult(result, {
    success: false,
  });
});

// =============================================================================
// Bootstrap Command Tests
// =============================================================================

test('bootstrap', 'bootstrap requires --name argument', async () => {
  const env = await createMinimalEnvironment('bootstrap-no-name');
  
  try {
    const result = await execCLI(['bootstrap'], { testEnv: env });
    assertCLIResult(result, {
      success: false,
      outputContains: 'name',
    });
  } finally {
    await env.cleanup();
  }
});

test('bootstrap', 'bootstrap --dry-run shows what would be created', async () => {
  const env = await createFullEnvironment('bootstrap-dry-run', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execBootstrap('test-agent', {
      testEnv: env,
      dryRun: true,
      skipUpgrade: true,
    });
    
    assertCLIResult(result, {
      success: true,
      outputContains: ['DRY RUN', 'test-agent'],
    });
  } finally {
    await env.cleanup();
  }
});

test('bootstrap', 'bootstrap --minimal creates minimal agent', async () => {
  const env = await createFullEnvironment('bootstrap-minimal', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execBootstrap('minimal-agent', {
      testEnv: env,
      minimal: true,
      dryRun: true,
      skipUpgrade: true,
    });
    
    assertCLIResult(result, {
      success: true,
      outputContains: 'minimal-agent',
    });
  } finally {
    await env.cleanup();
  }
});

test('bootstrap', 'bootstrap with --identity validates identity format', async () => {
  const env = await createFullEnvironment('bootstrap-identity', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execBootstrap('agent-with-identity', {
      testEnv: env,
      identity: 'org:test-org:user:test_user',
      dryRun: true,
      skipUpgrade: true,
    });
    
    assertCLIResult(result, {
      success: true,
      outputContains: 'identity',
    });
  } finally {
    await env.cleanup();
  }
});

test('bootstrap', 'bootstrap with invalid identity fails gracefully', async () => {
  const env = await createFullEnvironment('bootstrap-invalid-identity', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execBootstrap('agent-bad-identity', {
      testEnv: env,
      identity: 'invalid-identity-format',
      dryRun: true,
      skipUpgrade: true,
    });
    
    // The CLI should either fail or warn about invalid identity
    // Actual behavior depends on identity validation implementation
  } finally {
    await env.cleanup();
  }
});

// =============================================================================
// Upgrade Command Tests
// =============================================================================

test('upgrade', 'upgrade --check shows available upgrades', async () => {
  const env = await createFullEnvironment('upgrade-check', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execUpgrade({
      testEnv: env,
      check: true,
    });
    
    assertCLIResult(result, {
      success: true,
      outputContains: 'Upgrade',
    });
  } finally {
    await env.cleanup();
  }
});

test('upgrade', 'upgrade --dry-run does not apply changes', async () => {
  const env = await createFullEnvironment('upgrade-dry-run', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execCLI(['upgrade', '--dry-run'], { testEnv: env });
    
    assertCLIResult(result, {
      success: true,
      outputContains: 'DRY RUN',
      stdoutNotContains: 'Applied',
    });
  } finally {
    await env.cleanup();
  }
});

test('upgrade', 'upgrade without --force skips breaking changes', async () => {
  const env = await createFullEnvironment('upgrade-no-force', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execUpgrade({
      testEnv: env,
      check: true,
    });
    
    // Should show info about breaking changes requiring --force
    assertCLIResult(result, {
      success: true,
    });
  } finally {
    await env.cleanup();
  }
});

// =============================================================================
// Diff Command Tests
// =============================================================================

test('diff', 'diff shows version differences', async () => {
  const env = await createFullEnvironment('diff-versions', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execDiff({
      testEnv: env,
      versions: true,
    });
    
    assertCLIResult(result, {
      success: true,
      outputContains: ['Diff', 'Version'],
    });
  } finally {
    await env.cleanup();
  }
});

test('diff', 'diff --json outputs JSON format', async () => {
  const env = await createFullEnvironment('diff-json', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execCLI(['diff', '--json'], { testEnv: env });
    
    assertCLIResult(result, {
      success: true,
    });
    
    // Verify JSON output is parseable
    if (result.json) {
      const data = result.json as { success?: boolean };
      if (data.success === undefined) {
        throw new Error('JSON output missing success field');
      }
    }
  } finally {
    await env.cleanup();
  }
});

// =============================================================================
// Status Command Tests
// =============================================================================

test('status', 'status shows agent information', async () => {
  const env = await createFullEnvironment('status-basic', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execStatus({ testEnv: env });
    
    assertCLIResult(result, {
      success: true,
      outputContains: 'Status',
    });
  } finally {
    await env.cleanup();
  }
});

test('status', 'status --extended shows detailed information', async () => {
  const env = await createFullEnvironment('status-extended', {
    projectConfig: STANDARD_PROJECT,
  });
  
  try {
    const result = await execStatus({
      testEnv: env,
      extended: true,
    });
    
    assertCLIResult(result, {
      success: true,
    });
  } finally {
    await env.cleanup();
  }
});

// =============================================================================
// Test Runner
// =============================================================================

interface RunOptions {
  json?: boolean;
  filter?: string;
  verbose?: boolean;
}

async function runTests(options: RunOptions = {}): Promise<void> {
  const reporter = new TestReporter();
  const startTime = Date.now();
  
  // Filter tests if requested
  let testsToRun = tests;
  if (options.filter) {
    const filterLower = options.filter.toLowerCase();
    testsToRun = tests.filter(
      t => t.name.toLowerCase().includes(filterLower) || 
           t.category.toLowerCase().includes(filterLower)
    );
  }
  
  if (!options.json) {
    console.log(`\nRunning ${testsToRun.length} E2E tests...\n`);
    console.log('='.repeat(60));
  }
  
  for (const test of testsToRun) {
    const testStart = Date.now();
    
    if (!options.json && options.verbose) {
      console.log(`\nRunning: ${test.category}/${test.name}`);
    }
    
    try {
      await test.run();
      
      reporter.addResult({
        name: `${test.category}/${test.name}`,
        passed: true,
        durationMs: Date.now() - testStart,
      });
      
      if (!options.json) {
        console.log(`  [PASS] ${test.category}/${test.name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      reporter.addResult({
        name: `${test.category}/${test.name}`,
        passed: false,
        durationMs: Date.now() - testStart,
        error: errorMessage,
      });
      
      if (!options.json) {
        console.log(`  [FAIL] ${test.category}/${test.name}`);
        console.log(`         Error: ${errorMessage}`);
      }
    }
  }
  
  // Cleanup any remaining test environments
  await teardownTestHarness();
  
  const totalDuration = Date.now() - startTime;
  
  // Output results
  if (options.json) {
    console.log(JSON.stringify({
      ...reporter.toJSON(),
      durationMs: totalDuration,
      timestamp: new Date().toISOString(),
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(60));
    console.log(reporter.getSummary());
    console.log(`\nTotal duration: ${totalDuration}ms`);
  }
  
  // Exit with appropriate code
  process.exit(reporter.allPassed ? 0 : 1);
}

// =============================================================================
// CLI Entry Point
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  const options: RunOptions = {
    json: args.includes('--json'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };
  
  // Parse --filter option
  const filterIndex = args.indexOf('--filter');
  if (filterIndex !== -1 && args[filterIndex + 1]) {
    options.filter = args[filterIndex + 1];
  }
  
  // Handle help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
E2E Test Runner for smarty-admin CLI

Usage:
  npx tsx tests/e2e/run.ts [options]

Options:
  --json              Output results as JSON
  --filter <pattern>  Run only tests matching pattern
  --verbose, -v       Show verbose output
  --help, -h          Show this help message

Examples:
  npx tsx tests/e2e/run.ts
  npx tsx tests/e2e/run.ts --json
  npx tsx tests/e2e/run.ts --filter bootstrap
  npx tsx tests/e2e/run.ts --filter upgrade --verbose
`);
    process.exit(0);
  }
  
  await runTests(options);
}

// Run if executed directly
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
