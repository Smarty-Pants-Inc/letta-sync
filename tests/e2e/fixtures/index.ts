/**
 * E2E Test Fixtures for smarty-admin CLI
 * 
 * Provides pre-defined test data including:
 * - Project configurations
 * - Agent configurations
 * - Scope registries
 * - Mock API responses
 */

import type { ProjectConfig, ScopeDefinition } from '../harness.js';

// =============================================================================
// Project Configurations
// =============================================================================

/**
 * Standard test project configuration
 */
export const STANDARD_PROJECT: ProjectConfig = {
  slug: 'e2e-test-project',
  id: 'proj_e2e_test_001',
  name: 'E2E Test Project',
  org: 'e2e-test-org',
};

/**
 * Minimal project configuration (no org)
 */
export const MINIMAL_PROJECT: ProjectConfig = {
  slug: 'minimal-project',
  name: 'Minimal Test Project',
};

/**
 * Multi-org project configuration
 */
export const MULTI_ORG_PROJECT: ProjectConfig = {
  slug: 'multi-org-project',
  id: 'proj_multi_001',
  name: 'Multi-Org Test Project',
  org: 'parent-org',
};

// =============================================================================
// Scope Definitions
// =============================================================================

/**
 * Standard single-scope configuration
 */
export const SINGLE_SCOPE: ScopeDefinition[] = [
  {
    scope: 'main',
    match: {
      path_prefixes: ['src/'],
    },
    attach: {
      block_types: ['project', 'decisions', 'conventions', 'glossary'],
    },
  },
];

/**
 * Multi-scope configuration
 */
export const MULTI_SCOPE: ScopeDefinition[] = [
  {
    scope: 'frontend',
    match: {
      path_prefixes: ['src/frontend/', 'src/web/'],
    },
    attach: {
      block_types: ['project', 'decisions', 'conventions'],
    },
  },
  {
    scope: 'backend',
    match: {
      path_prefixes: ['src/backend/', 'src/api/'],
    },
    attach: {
      block_types: ['project', 'decisions', 'conventions'],
    },
  },
  {
    scope: 'shared',
    match: {
      path_prefixes: ['src/shared/', 'src/common/'],
    },
    attach: {
      block_types: ['project', 'glossary'],
    },
  },
];

/**
 * Nested scope configuration (for testing scope precedence)
 */
export const NESTED_SCOPE: ScopeDefinition[] = [
  {
    scope: 'root',
    match: {
      path_prefixes: ['partners/'],
    },
    attach: {
      block_types: ['project'],
    },
  },
  {
    scope: 'partner-a',
    match: {
      path_prefixes: ['partners/partner-a/'],
    },
    attach: {
      block_types: ['project', 'decisions', 'conventions', 'glossary'],
    },
  },
  {
    scope: 'partner-a-frontend',
    match: {
      path_prefixes: ['partners/partner-a/frontend/'],
    },
    attach: {
      block_types: ['project', 'decisions'],
    },
  },
];

// =============================================================================
// Agent Configurations
// =============================================================================

/**
 * Standard agent configuration for bootstrap tests
 */
export const STANDARD_AGENT = {
  name: 'E2E Test Agent',
  template: 'default',
  channel: 'stable' as const,
  identity: 'org:e2e-test-org:user:test_user',
};

/**
 * Minimal agent configuration
 */
export const MINIMAL_AGENT = {
  name: 'Minimal Agent',
  minimal: true,
};

/**
 * Agent with multiple identities
 */
export const MULTI_IDENTITY_AGENT = {
  name: 'Multi-Identity Agent',
  identities: [
    'org:e2e-test-org:user:user_one',
    'org:e2e-test-org:user:user_two',
    'org:e2e-test-org:team:dev_team',
  ],
};

// =============================================================================
// Mock API Responses
// =============================================================================

/**
 * Mock agent response from Letta API
 */
export const MOCK_AGENT_RESPONSE = {
  id: 'agent-e2e-mock-001',
  name: 'Mock Agent',
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  agent_type: 'memgpt',
  llm_config: {
    model: 'gpt-4o-mini',
    model_endpoint: 'openai',
  },
  tags: [
    'managed:smarty-admin',
    'channel:stable',
    'layer:project',
    'applied:base@abc1234',
  ],
  blocks: [
    { label: 'project', id: 'block-001' },
    { label: 'persona', id: 'block-002' },
  ],
  tools: [
    { name: 'read_file', id: 'tool-001' },
    { name: 'write_file', id: 'tool-002' },
  ],
};

/**
 * Mock blocks response
 */
export const MOCK_BLOCKS_RESPONSE = {
  blocks: [
    {
      id: 'block-project-001',
      label: 'scope_main_project',
      value: 'Project context for E2E testing',
      description: 'Shared scope block (main) for project',
    },
    {
      id: 'block-decisions-001',
      label: 'scope_main_decisions',
      value: 'ADR-001: Use TypeScript for CLI',
      description: 'Shared scope block (main) for decisions',
    },
  ],
};

/**
 * Mock upgrade plan response
 */
export const MOCK_UPGRADE_PLAN = {
  agentId: 'agent-e2e-mock-001',
  channel: 'stable',
  isUpToDate: false,
  canAutoApply: true,
  targetVersions: {
    base: 'abc1234567890',
    org: 'def4567890123',
    project: 'ghi7890123456',
  },
  changes: [
    {
      type: 'attach_block',
      description: 'Attach org_policies block',
      layer: 'org',
      classification: 'safe',
    },
    {
      type: 'attach_tool',
      description: 'Attach scope_sync tool',
      layer: 'base',
      classification: 'safe',
    },
  ],
  safeChanges: [
    {
      type: 'attach_block',
      description: 'Attach org_policies block',
      layer: 'org',
      classification: 'safe',
    },
  ],
  breakingChanges: [],
  summary: {
    totalChanges: 2,
    safeChanges: 2,
    breakingChanges: 0,
    blocksToAttach: 1,
    blocksToDetach: 0,
    toolsToAttach: 1,
    toolsToDetach: 0,
    foldersToAttach: 0,
    sourcesToAttach: 0,
  },
};

// =============================================================================
// Test Scenarios
// =============================================================================

/**
 * Pre-defined test scenarios combining fixtures
 */
export const SCENARIOS = {
  /**
   * Fresh project with no agent
   */
  freshProject: {
    project: STANDARD_PROJECT,
    scopes: SINGLE_SCOPE,
    hasAgent: false,
  },
  
  /**
   * Existing project with managed agent
   */
  managedAgent: {
    project: STANDARD_PROJECT,
    scopes: SINGLE_SCOPE,
    hasAgent: true,
    agentTags: ['managed:smarty-admin', 'channel:stable'],
  },
  
  /**
   * Project requiring upgrade
   */
  needsUpgrade: {
    project: STANDARD_PROJECT,
    scopes: MULTI_SCOPE,
    hasAgent: true,
    agentTags: ['managed:smarty-admin', 'channel:stable', 'applied:base@old123'],
    currentVersion: 'old123',
    targetVersion: 'new456',
  },
  
  /**
   * Complex multi-scope project
   */
  multiScope: {
    project: MULTI_ORG_PROJECT,
    scopes: NESTED_SCOPE,
    hasAgent: true,
    agentTags: ['managed:smarty-admin', 'channel:stable'],
  },
} as const;

// =============================================================================
// Helper Types
// =============================================================================

export type ScenarioName = keyof typeof SCENARIOS;
export type Scenario = typeof SCENARIOS[ScenarioName];
