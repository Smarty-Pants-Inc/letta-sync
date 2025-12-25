/**
 * MCP Server diff algorithm (OBSERVE-ONLY)
 *
 * Compares desired MCP server state (from manifest) with actual state
 * (from Letta API) and generates a diff report. This reconciler is
 * OBSERVE-ONLY due to credential handling requirements.
 *
 * Key principles:
 * - Never copy or expose credential values
 * - Generate manual setup instructions instead of auto-applying
 * - Detect drift but don't auto-remediate
 *
 * Based on: docs/research/tools-mcp-research.md
 */

import type {
  MCPServerRecord,
  MCPServerManifestEntry,
  MCPServerClassification,
  MCPServerDrift,
  MCPDriftType,
  MCPDiffResult,
  MCPDiffSummary,
  MCPDiffOptions,
  ToolAttachmentBundle,
  ToolBundleStatus,
} from './types.js';

import {
  MCPServerOwnership,
  CredentialStatus,
  isLikelySecretEnv,
} from './types.js';

// =============================================================================
// Credential Detection
// =============================================================================

/**
 * Detect credential status from manifest entry
 */
export function detectCredentialStatus(
  manifest?: MCPServerManifestEntry,
  actual?: MCPServerRecord
): CredentialStatus {
  // Check manifest for secret references
  if (manifest?.tokenSecretRef || manifest?.customHeadersSecretRef) {
    return CredentialStatus.SECRET_REF;
  }

  // Check actual server for credentials
  if (actual?.hasToken || actual?.hasCustomHeaders) {
    return CredentialStatus.PRESENT;
  }

  // Check stdio config for potential secrets in env vars
  const stdioConfig = manifest?.stdioConfig ?? actual?.stdioConfig;
  if (stdioConfig?.env) {
    const hasSecretEnvs = Object.keys(stdioConfig.env).some(isLikelySecretEnv);
    if (hasSecretEnvs) {
      return CredentialStatus.PRESENT;
    }
  }

  // For SSE/HTTP servers without explicit credentials
  if (manifest?.serverType === 'sse' || manifest?.serverType === 'streamable_http') {
    // Assume credentials may be needed unless explicitly stated
    return CredentialStatus.UNKNOWN;
  }

  return CredentialStatus.NONE;
}

// =============================================================================
// Drift Detection
// =============================================================================

/**
 * Compute drifts between desired and actual MCP server state
 */
export function computeMCPDrifts(
  manifest: MCPServerManifestEntry,
  actual: MCPServerRecord
): MCPServerDrift[] {
  const drifts: MCPServerDrift[] = [];

  // Server type drift
  if (manifest.serverType !== actual.serverType) {
    drifts.push({
      type: 'server_type',
      field: 'serverType',
      actual: actual.serverType,
      desired: manifest.serverType,
      description: `Server type differs: expected '${manifest.serverType}', found '${actual.serverType}'`,
      requiresCredentials: false,
    });
  }

  // Server URL drift (for SSE/HTTP)
  if (manifest.serverType !== 'stdio') {
    if (manifest.serverUrl && manifest.serverUrl !== actual.serverUrl) {
      drifts.push({
        type: 'server_url',
        field: 'serverUrl',
        actual: actual.serverUrl,
        desired: manifest.serverUrl,
        description: `Server URL differs: expected '${manifest.serverUrl}', found '${actual.serverUrl ?? 'not set'}'`,
        requiresCredentials: false,
      });
    }
  }

  // Stdio config drift
  if (manifest.serverType === 'stdio' && manifest.stdioConfig) {
    const actualStdio = actual.stdioConfig;

    if (!actualStdio) {
      drifts.push({
        type: 'stdio_config',
        field: 'stdioConfig',
        actual: undefined,
        desired: manifest.stdioConfig,
        description: 'Stdio configuration not set',
        requiresCredentials: false,
      });
    } else {
      // Command drift
      if (manifest.stdioConfig.command !== actualStdio.command) {
        drifts.push({
          type: 'stdio_config',
          field: 'stdioConfig.command',
          actual: actualStdio.command,
          desired: manifest.stdioConfig.command,
          description: `Stdio command differs: expected '${manifest.stdioConfig.command}', found '${actualStdio.command}'`,
          requiresCredentials: false,
        });
      }

      // Args drift (simple comparison)
      const desiredArgs = manifest.stdioConfig.args?.join(' ') ?? '';
      const actualArgs = actualStdio.args?.join(' ') ?? '';
      if (desiredArgs !== actualArgs) {
        drifts.push({
          type: 'stdio_config',
          field: 'stdioConfig.args',
          actual: actualArgs,
          desired: desiredArgs,
          description: 'Stdio arguments differ',
          requiresCredentials: false,
        });
      }

      // Env vars drift (only check non-secret keys)
      if (manifest.stdioConfig.env) {
        const desiredNonSecretEnvs = Object.keys(manifest.stdioConfig.env)
          .filter(k => !isLikelySecretEnv(k));
        const actualNonSecretEnvs = Object.keys(actualStdio.env ?? {})
          .filter(k => !isLikelySecretEnv(k));

        // Check for missing non-secret envs
        for (const key of desiredNonSecretEnvs) {
          if (!actualNonSecretEnvs.includes(key)) {
            drifts.push({
              type: 'stdio_config',
              field: `stdioConfig.env.${key}`,
              actual: undefined,
              desired: manifest.stdioConfig.env[key],
              description: `Environment variable '${key}' not configured`,
              requiresCredentials: false,
            });
          }
        }
      }
    }
  }

  // Credential-related drift (detect but don't expose values)
  if (manifest.tokenSecretRef && !actual.hasToken) {
    drifts.push({
      type: 'credentials',
      field: 'token',
      actual: 'not configured',
      desired: `secret ref: ${manifest.tokenSecretRef}`,
      description: 'Token not configured but required by manifest',
      requiresCredentials: true,
    });
  }

  if (manifest.customHeadersSecretRef && !actual.hasCustomHeaders) {
    drifts.push({
      type: 'credentials',
      field: 'customHeaders',
      actual: 'not configured',
      desired: `secret ref: ${manifest.customHeadersSecretRef}`,
      description: 'Custom headers not configured but required by manifest',
      requiresCredentials: true,
    });
  }

  return drifts;
}

/**
 * Create drift for a missing server
 */
function createMissingServerDrifts(manifest: MCPServerManifestEntry): MCPServerDrift[] {
  const drifts: MCPServerDrift[] = [];

  drifts.push({
    type: 'missing',
    field: 'server',
    actual: undefined,
    desired: manifest.name,
    description: `MCP server '${manifest.name}' is not configured in Letta`,
    requiresCredentials: detectCredentialStatus(manifest) !== CredentialStatus.NONE,
  });

  return drifts;
}

/**
 * Create drift for an unmanaged server
 */
function createUnmanagedServerDrift(actual: MCPServerRecord): MCPServerDrift {
  return {
    type: 'extra',
    field: 'server',
    actual: actual.serverName,
    desired: undefined,
    description: `MCP server '${actual.serverName}' exists in Letta but not in manifest`,
    requiresCredentials: false,
  };
}

// =============================================================================
// Classification
// =============================================================================

/**
 * Classify a single MCP server
 */
export function classifyMCPServer(
  manifest: MCPServerManifestEntry | undefined,
  actual: MCPServerRecord | undefined
): MCPServerClassification {
  const name = manifest?.name ?? actual?.serverName ?? 'unknown';

  // Server only in manifest (missing)
  if (manifest && !actual) {
    return {
      name,
      ownership: MCPServerOwnership.MISSING,
      credentialStatus: detectCredentialStatus(manifest),
      drifts: createMissingServerDrifts(manifest),
      reason: 'Server defined in manifest but not configured in Letta',
      manifest,
    };
  }

  // Server only in Letta (unmanaged)
  if (!manifest && actual) {
    return {
      name,
      ownership: MCPServerOwnership.UNMANAGED,
      credentialStatus: detectCredentialStatus(undefined, actual),
      drifts: [createUnmanagedServerDrift(actual)],
      reason: 'Server exists in Letta but not defined in manifest',
      actual,
    };
  }

  // Server in both - check for drift
  if (manifest && actual) {
    const drifts = computeMCPDrifts(manifest, actual);

    if (drifts.length === 0) {
      return {
        name,
        ownership: MCPServerOwnership.MANAGED,
        credentialStatus: detectCredentialStatus(manifest, actual),
        drifts: [],
        reason: 'Server configuration matches manifest',
        manifest,
        actual,
      };
    }

    return {
      name,
      ownership: MCPServerOwnership.DRIFTED,
      credentialStatus: detectCredentialStatus(manifest, actual),
      drifts,
      reason: `Server has ${drifts.length} configuration drift(s)`,
      manifest,
      actual,
    };
  }

  // Should not reach here
  return {
    name,
    ownership: MCPServerOwnership.UNMANAGED,
    credentialStatus: CredentialStatus.UNKNOWN,
    drifts: [],
    reason: 'Unable to classify server',
  };
}

// =============================================================================
// Tool Bundle Analysis
// =============================================================================

/**
 * Analyze tool attachment bundle status
 */
export function analyzeToolBundle(
  bundle: ToolAttachmentBundle,
  serverClassifications: MCPServerClassification[],
  availableTools: string[]
): ToolBundleStatus {
  const serverClassification = serverClassifications.find(
    s => s.name === bundle.mcpServerName
  );

  const serverConfigured = serverClassification?.ownership === MCPServerOwnership.MANAGED;

  // Filter available tools to those in the bundle
  const bundleToolsAvailable = bundle.tools.filter(t => availableTools.includes(t));
  const missingTools = bundle.tools.filter(t => !availableTools.includes(t));

  return {
    bundleName: bundle.name,
    mcpServerName: bundle.mcpServerName,
    serverConfigured,
    toolsAvailable: bundleToolsAvailable.length,
    toolsExpected: bundle.tools.length,
    missingTools,
    ready: serverConfigured && missingTools.length === 0,
  };
}

// =============================================================================
// Main Diff Function
// =============================================================================

/**
 * Generate a unique diff ID
 */
function generateDiffId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `mcp-diff-${timestamp}-${random}`;
}

/**
 * Main diff function - compares desired state with actual state
 * and generates an observe-only diff report
 */
export function diffMCPServers(
  desired: MCPServerManifestEntry[],
  actual: MCPServerRecord[],
  options: MCPDiffOptions = {},
  toolBundles: ToolAttachmentBundle[] = [],
  availableTools: string[] = []
): MCPDiffResult {
  const {
    includeUnmanaged = true,
    issuesOnly = false,
    serverNames,
    serverType,
    includeToolBundles = true,
  } = options;

  const errors: string[] = [];
  const warnings: string[] = [];
  const servers: MCPServerClassification[] = [];

  // Index desired servers by name
  const desiredByName = new Map<string, MCPServerManifestEntry>();
  for (const server of desired) {
    if (desiredByName.has(server.name)) {
      warnings.push(`Duplicate server name in manifest: ${server.name}`);
    }
    desiredByName.set(server.name, server);
  }

  // Index actual servers by name
  const actualByName = new Map<string, MCPServerRecord>();
  for (const server of actual) {
    if (actualByName.has(server.serverName)) {
      warnings.push(`Duplicate server name in Letta: ${server.serverName}`);
    }
    actualByName.set(server.serverName, server);
  }

  // Process desired servers
  for (const [name, manifestServer] of desiredByName) {
    // Apply filters
    if (serverNames && !serverNames.includes(name)) {
      continue;
    }
    if (serverType && manifestServer.serverType !== serverType) {
      continue;
    }

    const actualServer = actualByName.get(name);
    const classification = classifyMCPServer(manifestServer, actualServer);

    // Apply issues-only filter
    if (issuesOnly && classification.ownership === MCPServerOwnership.MANAGED) {
      continue;
    }

    servers.push(classification);
  }

  // Process actual servers not in manifest (unmanaged)
  if (includeUnmanaged) {
    for (const [name, actualServer] of actualByName) {
      // Skip if already processed
      if (desiredByName.has(name)) {
        continue;
      }

      // Apply filters
      if (serverNames && !serverNames.includes(name)) {
        continue;
      }
      if (serverType && actualServer.serverType !== serverType) {
        continue;
      }

      const classification = classifyMCPServer(undefined, actualServer);

      // Apply issues-only filter (unmanaged may or may not be an issue)
      if (issuesOnly) {
        continue; // Unmanaged is informational, not an issue
      }

      servers.push(classification);
    }
  }

  // Compute summary
  const summary: MCPDiffSummary = {
    configured: servers.filter(s => s.ownership === MCPServerOwnership.MANAGED).length,
    drifted: servers.filter(s => s.ownership === MCPServerOwnership.DRIFTED).length,
    missing: servers.filter(s => s.ownership === MCPServerOwnership.MISSING).length,
    unmanaged: servers.filter(s => s.ownership === MCPServerOwnership.UNMANAGED).length,
    total: servers.length,
  };

  // Analyze tool bundles
  const toolBundleStatuses: ToolBundleStatus[] = [];
  if (includeToolBundles && toolBundles.length > 0) {
    for (const bundle of toolBundles) {
      toolBundleStatuses.push(
        analyzeToolBundle(bundle, servers, availableTools)
      );
    }
  }

  const hasIssues = summary.missing > 0 || summary.drifted > 0;

  return {
    timestamp: new Date().toISOString(),
    diffId: generateDiffId(),
    hasIssues,
    servers,
    summary,
    toolBundles: toolBundleStatuses,
    errors,
    warnings,
  };
}

// =============================================================================
// Formatting Functions
// =============================================================================

/**
 * Format diff result as human-readable summary
 */
export function formatMCPDiffSummary(result: MCPDiffResult): string {
  const lines: string[] = [];
  const { summary } = result;

  lines.push('MCP Server Diff Summary (Observe-Only)');
  lines.push('======================================');
  lines.push('');
  lines.push(`Timestamp: ${result.timestamp}`);
  lines.push(`Diff ID: ${result.diffId}`);
  if (result.org) lines.push(`Organization: ${result.org}`);
  lines.push('');

  lines.push('Server Status:');
  if (summary.configured > 0) lines.push(`  [OK] Configured: ${summary.configured}`);
  if (summary.drifted > 0) lines.push(`  [!]  Drifted: ${summary.drifted}`);
  if (summary.missing > 0) lines.push(`  [X]  Missing: ${summary.missing}`);
  if (summary.unmanaged > 0) lines.push(`  [?]  Unmanaged: ${summary.unmanaged}`);
  lines.push(`  Total: ${summary.total}`);
  lines.push('');

  // Tool bundles summary
  if (result.toolBundles.length > 0) {
    lines.push('Tool Bundles:');
    for (const bundle of result.toolBundles) {
      const status = bundle.ready ? '[OK]' : '[!] ';
      const toolStatus = `${bundle.toolsAvailable}/${bundle.toolsExpected} tools`;
      lines.push(`  ${status} ${bundle.bundleName}: ${toolStatus}`);
      if (bundle.missingTools.length > 0) {
        lines.push(`       Missing: ${bundle.missingTools.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  ! ${warning}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('Errors:');
    for (const error of result.errors) {
      lines.push(`  X ${error}`);
    }
    lines.push('');
  }

  if (result.hasIssues) {
    lines.push('Status: MANUAL SETUP REQUIRED');
    lines.push('');
    lines.push('Note: MCP servers require manual setup due to credential handling.');
    lines.push('Run `smarty-admin mcp report` for detailed setup instructions.');
  } else if (summary.total === 0) {
    lines.push('Status: NO MCP SERVERS DEFINED');
  } else {
    lines.push('Status: ALL CONFIGURED');
  }

  return lines.join('\n');
}

/**
 * Format diff details as human-readable report
 */
export function formatMCPDiffDetails(result: MCPDiffResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Detailed Server Status:');
  lines.push('-----------------------');

  // Group by ownership
  const missing = result.servers.filter(s => s.ownership === MCPServerOwnership.MISSING);
  const drifted = result.servers.filter(s => s.ownership === MCPServerOwnership.DRIFTED);
  const configured = result.servers.filter(s => s.ownership === MCPServerOwnership.MANAGED);
  const unmanaged = result.servers.filter(s => s.ownership === MCPServerOwnership.UNMANAGED);

  // Missing servers (need setup)
  if (missing.length > 0) {
    lines.push('');
    lines.push('MISSING (Need Manual Setup):');
    for (const server of missing) {
      lines.push(`  [X] ${server.name}`);
      lines.push(`      Type: ${server.manifest?.serverType}`);
      if (server.manifest?.serverUrl) {
        lines.push(`      URL: ${server.manifest.serverUrl}`);
      }
      lines.push(`      Credentials: ${server.credentialStatus}`);
      if (server.drifts.length > 0) {
        lines.push(`      Drifts:`);
        for (const drift of server.drifts) {
          lines.push(`        - ${drift.description}`);
        }
      }
    }
  }

  // Drifted servers (need reconfiguration)
  if (drifted.length > 0) {
    lines.push('');
    lines.push('DRIFTED (Configuration Mismatch):');
    for (const server of drifted) {
      lines.push(`  [!] ${server.name}`);
      lines.push(`      Reason: ${server.reason}`);
      for (const drift of server.drifts) {
        const credMarker = drift.requiresCredentials ? ' [credentials]' : '';
        lines.push(`      - ${drift.description}${credMarker}`);
      }
    }
  }

  // Configured servers
  if (configured.length > 0) {
    lines.push('');
    lines.push('CONFIGURED (OK):');
    for (const server of configured) {
      lines.push(`  [OK] ${server.name} (${server.actual?.serverType})`);
    }
  }

  // Unmanaged servers
  if (unmanaged.length > 0) {
    lines.push('');
    lines.push('UNMANAGED (Not in Manifest):');
    for (const server of unmanaged) {
      lines.push(`  [?] ${server.name} (${server.actual?.serverType})`);
    }
  }

  return lines.join('\n');
}

/**
 * Format diff result as JSON (machine-readable)
 */
export function formatMCPDiffAsJson(result: MCPDiffResult): string {
  return JSON.stringify(result, null, 2);
}
