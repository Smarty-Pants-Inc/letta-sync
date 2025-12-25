/**
 * Tests for discover.ts
 *
 * Covers:
 * - Repo root discovery
 * - Manifest location discovery (new .letta/manifests and legacy packages/examples)
 * - Manifest loading via packages loader
 * - Deprecation warnings
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findRepoRoot,
  discoverManifests,
  loadManifests,
  LETTA_MANIFESTS_DIR,
  LEGACY_PACKAGES_DIR,
} from '../../src/discover.js';

// =============================================================================
// Test Fixtures
// =============================================================================

const TEST_BLOCK_YAML = `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: test_block
  description: Test block for discovery tests
spec:
  managed: true
  layer: base
  label: test_block
  value: |
    This is a test block.
  limit: 1000
`;

const TEST_ORG_BLOCK_YAML = `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: org_test_block
  description: Org layer test block
spec:
  managed: true
  layer: org
  label: org_test_block
  value: |
    This is an org test block.
  limit: 1000
`;

// =============================================================================
// Helper Functions
// =============================================================================

function createTempDir(): string {
  const tempBase = join(tmpdir(), 'letta-sync-test-');
  const tempDir = `${tempBase}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// findRepoRoot Tests
// =============================================================================

describe('findRepoRoot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should find repo root by .letta directory', () => {
    // Create .letta directory
    mkdirSync(join(tempDir, '.letta'), { recursive: true });
    // Create a subdirectory to search from
    const subDir = join(tempDir, 'src', 'commands');
    mkdirSync(subDir, { recursive: true });

    const result = findRepoRoot(subDir);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(tempDir);
    expect(result?.detectedBy).toBe('.letta');
  });

  it('should find repo root by .git directory', () => {
    // Create .git directory
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    // Create a subdirectory to search from
    const subDir = join(tempDir, 'packages', 'app');
    mkdirSync(subDir, { recursive: true });

    const result = findRepoRoot(subDir);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(tempDir);
    expect(result?.detectedBy).toBe('.git');
  });

  it('should prefer .letta over .git when both exist', () => {
    // Create both directories
    mkdirSync(join(tempDir, '.letta'), { recursive: true });
    mkdirSync(join(tempDir, '.git'), { recursive: true });
    // Create a subdirectory to search from
    const subDir = join(tempDir, 'src');
    mkdirSync(subDir, { recursive: true });

    const result = findRepoRoot(subDir);

    expect(result).not.toBeNull();
    expect(result?.path).toBe(tempDir);
    expect(result?.detectedBy).toBe('.letta');
  });

  it('should return null when no repo root found', () => {
    // Create a bare temp directory with no .letta or .git
    const result = findRepoRoot(tempDir);

    expect(result).toBeNull();
  });
});

// =============================================================================
// discoverManifests Tests
// =============================================================================

describe('discoverManifests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Always create .letta for repo root detection
    mkdirSync(join(tempDir, '.letta'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should prefer .letta/manifests over packages/examples', () => {
    // Create both directories
    mkdirSync(join(tempDir, LETTA_MANIFESTS_DIR), { recursive: true });
    mkdirSync(join(tempDir, LEGACY_PACKAGES_DIR), { recursive: true });

    const result = discoverManifests(tempDir);

    expect(result.location.type).toBe('letta-manifests');
    expect(result.location.path).toBe(join(tempDir, LETTA_MANIFESTS_DIR));
    expect(result.deprecationWarning).toBeUndefined();
  });

  it('should use packages/examples as fallback with deprecation warning', () => {
    // Create only legacy directory
    mkdirSync(join(tempDir, LEGACY_PACKAGES_DIR), { recursive: true });

    const result = discoverManifests(tempDir);

    expect(result.location.type).toBe('legacy-packages-examples');
    expect(result.location.path).toBe(join(tempDir, LEGACY_PACKAGES_DIR));
    expect(result.deprecationWarning).toBeDefined();
    expect(result.deprecationWarning).toContain('deprecated');
    expect(result.deprecationWarning).toContain(LETTA_MANIFESTS_DIR);
  });

  it('should throw error when no manifest location found', () => {
    // No manifest directories created
    expect(() => discoverManifests(tempDir)).toThrow(/No manifest directory found/);
  });

  it('should throw error when repo root not found', () => {
    // Create a directory without .letta or .git
    const isolatedDir = createTempDir();
    try {
      expect(() => discoverManifests(isolatedDir)).toThrow(/Could not find repository root/);
    } finally {
      cleanupTempDir(isolatedDir);
    }
  });

  it('should include helpful error message with suggested paths', () => {
    try {
      discoverManifests(tempDir);
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      const message = (err as Error).message;
      expect(message).toContain('.letta/manifests');
      expect(message).toContain('base/');
      expect(message).toContain('org/');
      expect(message).toContain('project/');
    }
  });
});

// =============================================================================
// loadManifests Tests
// =============================================================================

describe('loadManifests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Always create .letta for repo root detection
    mkdirSync(join(tempDir, '.letta'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should load manifests from .letta/manifests/base', async () => {
    // Create base layer directory with a manifest
    const baseDir = join(tempDir, LETTA_MANIFESTS_DIR, 'base');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'blocks.yaml'), TEST_BLOCK_YAML);

    const result = await loadManifests(tempDir);

    expect(result.discovery.location.type).toBe('letta-manifests');
    expect(result.packages.base).toBeDefined();
    expect(result.desiredState.blocks.length).toBeGreaterThan(0);
    expect(result.desiredState.blocks[0].metadata.name).toBe('test_block');
  });

  it('should load and merge manifests from multiple layers', async () => {
    // Create base and org layer directories
    const baseDir = join(tempDir, LETTA_MANIFESTS_DIR, 'base');
    const orgDir = join(tempDir, LETTA_MANIFESTS_DIR, 'org');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });
    writeFileSync(join(baseDir, 'blocks.yaml'), TEST_BLOCK_YAML);
    writeFileSync(join(orgDir, 'blocks.yaml'), TEST_ORG_BLOCK_YAML);

    const result = await loadManifests(tempDir);

    expect(result.packages.base).toBeDefined();
    expect(result.packages.org).toBeDefined();
    expect(result.desiredState.blocks.length).toBe(2);
    
    const blockNames = result.desiredState.blocks.map(b => b.metadata.name);
    expect(blockNames).toContain('test_block');
    expect(blockNames).toContain('org_test_block');
  });

  it('should load manifests from legacy packages/examples', async () => {
    // Create legacy directory structure
    const baseDir = join(tempDir, LEGACY_PACKAGES_DIR, 'base');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'blocks.yaml'), TEST_BLOCK_YAML);

    const result = await loadManifests(tempDir);

    expect(result.discovery.location.type).toBe('legacy-packages-examples');
    expect(result.discovery.deprecationWarning).toBeDefined();
    expect(result.warnings.some(w => w.includes('deprecated'))).toBe(true);
    expect(result.packages.base).toBeDefined();
    expect(result.desiredState.blocks.length).toBeGreaterThan(0);
  });

  it('should handle missing layer directories gracefully', async () => {
    // Create only base layer
    const baseDir = join(tempDir, LETTA_MANIFESTS_DIR, 'base');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'blocks.yaml'), TEST_BLOCK_YAML);

    const result = await loadManifests(tempDir);

    // Should succeed with just base layer
    expect(result.packages.base).toBeDefined();
    expect(result.packages.org).toBeUndefined();
    expect(result.packages.project).toBeUndefined();
    expect(result.desiredState.blocks.length).toBeGreaterThan(0);
  });

  it('should include warnings for layer loading failures', async () => {
    // Create base layer with invalid YAML
    const baseDir = join(tempDir, LETTA_MANIFESTS_DIR, 'base');
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'blocks.yaml'), 'invalid: yaml: content: [');

    const result = await loadManifests(tempDir);

    // Should have a warning about loading failure
    expect(result.warnings.some(w => w.includes('base layer'))).toBe(true);
  });

  it('should return empty desired state when no manifests found', async () => {
    // Create manifest directory but with no files
    mkdirSync(join(tempDir, LETTA_MANIFESTS_DIR), { recursive: true });

    const result = await loadManifests(tempDir);

    expect(result.desiredState.blocks.length).toBe(0);
    expect(result.desiredState.tools.length).toBe(0);
  });
});

// =============================================================================
// Layer Precedence Tests
// =============================================================================

describe('Layer Precedence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, '.letta'), { recursive: true });
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should override base layer with org layer', async () => {
    const baseDir = join(tempDir, LETTA_MANIFESTS_DIR, 'base');
    const orgDir = join(tempDir, LETTA_MANIFESTS_DIR, 'org');
    mkdirSync(baseDir, { recursive: true });
    mkdirSync(orgDir, { recursive: true });

    // Same block name, different values
    writeFileSync(join(baseDir, 'blocks.yaml'), `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: shared_block
  description: Base version
spec:
  managed: true
  layer: base
  label: shared_label
  value: base_value
  limit: 1000
`);

    writeFileSync(join(orgDir, 'blocks.yaml'), `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: shared_block
  description: Org version
spec:
  managed: true
  layer: org
  label: shared_label
  value: org_value
  limit: 1000
`);

    const result = await loadManifests(tempDir);

    // Org should override base
    expect(result.desiredState.blocks.length).toBe(1);
    expect(result.desiredState.blocks[0].spec.value).toBe('org_value');
  });

  it('should override org layer with project layer', async () => {
    const orgDir = join(tempDir, LETTA_MANIFESTS_DIR, 'org');
    const projectDir = join(tempDir, LETTA_MANIFESTS_DIR, 'project');
    mkdirSync(orgDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(orgDir, 'blocks.yaml'), `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: shared_block
  description: Org version
spec:
  managed: true
  layer: org
  label: shared_label
  value: org_value
  limit: 1000
`);

    writeFileSync(join(projectDir, 'blocks.yaml'), `
apiVersion: letta.ai/v1
kind: Block
metadata:
  name: shared_block
  description: Project version
spec:
  managed: true
  layer: project
  label: shared_label
  value: project_value
  limit: 1000
`);

    const result = await loadManifests(tempDir);

    // Project should override org
    expect(result.desiredState.blocks.length).toBe(1);
    expect(result.desiredState.blocks[0].spec.value).toBe('project_value');
  });
});
