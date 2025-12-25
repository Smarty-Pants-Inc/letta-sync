/**
 * MCP Server manual setup report generator
 *
 * Generates detailed instructions for manually setting up MCP servers
 * that cannot be auto-reconciled due to credential requirements.
 *
 * Based on: docs/research/tools-mcp-research.md
 */

import type {
  MCPDiffResult,
  MCPServerClassification,
  MCPServerManifestEntry,
  MCPSetupInstructions,
  MCPSetupReport,
  SetupStep,
  ToolBundleStatus,
} from './types.js';

import {
  MCPServerOwnership,
  CredentialStatus,
  isLikelySecretEnv,
} from './types.js';

// =============================================================================
// Setup Step Generators
// =============================================================================

/**
 * Generate setup steps for SSE/HTTP MCP server
 */
function generateSSESetupSteps(
  manifest: MCPServerManifestEntry
): SetupStep[] {
  const steps: SetupStep[] = [];
  let stepNum = 1;

  // Step 1: Create server
  steps.push({
    step: stepNum++,
    action: 'Create MCP server',
    details: `Create a new ${manifest.serverType.toUpperCase()} MCP server named '${manifest.name}'`,
    command: `letta mcp-servers create --name "${manifest.name}" --type ${manifest.serverType} --url "${manifest.serverUrl}"`,
    requiresCredentials: false,
  });

  // Step 2: Configure token (if needed)
  if (manifest.tokenSecretRef) {
    steps.push({
      step: stepNum++,
      action: 'Configure authentication token',
      details: `Set up the authentication token for this server. The manifest references secret: ${manifest.tokenSecretRef}`,
      command: `# Retrieve token from your secrets manager, then:\nletta mcp-servers update "${manifest.name}" --token "YOUR_TOKEN"`,
      requiresCredentials: true,
    });
  }

  // Step 3: Configure custom headers (if needed)
  if (manifest.customHeadersSecretRef) {
    steps.push({
      step: stepNum++,
      action: 'Configure custom headers',
      details: `Set up custom headers for this server. The manifest references secret: ${manifest.customHeadersSecretRef}`,
      command: `# Retrieve headers from your secrets manager, then configure via API`,
      requiresCredentials: true,
    });
  }

  // Step 4: Sync tools
  steps.push({
    step: stepNum++,
    action: 'Sync tools from server',
    details: 'Resync to discover and import tools from the MCP server',
    command: `letta mcp-servers resync --name "${manifest.name}"`,
    requiresCredentials: false,
  });

  // Step 5: Verify
  steps.push({
    step: stepNum++,
    action: 'Verify setup',
    details: 'List the tools imported from this MCP server',
    command: `letta tools list --search "mcp:${manifest.name}"`,
    requiresCredentials: false,
  });

  return steps;
}

/**
 * Generate setup steps for Stdio MCP server
 */
function generateStdioSetupSteps(
  manifest: MCPServerManifestEntry
): SetupStep[] {
  const steps: SetupStep[] = [];
  let stepNum = 1;

  const stdioConfig = manifest.stdioConfig;
  if (!stdioConfig) {
    return [{
      step: 1,
      action: 'Error: Missing stdio configuration',
      details: 'The manifest does not include stdio configuration',
      requiresCredentials: false,
    }];
  }

  // Step 1: Verify command exists
  steps.push({
    step: stepNum++,
    action: 'Verify command availability',
    details: `Ensure the command '${stdioConfig.command}' is installed and accessible`,
    command: `which ${stdioConfig.command} || echo "Command not found"`,
    requiresCredentials: false,
  });

  // Step 2: Create server
  const argsString = stdioConfig.args?.map(a => `"${a}"`).join(' ') ?? '';
  steps.push({
    step: stepNum++,
    action: 'Create MCP server',
    details: `Create a new stdio MCP server named '${manifest.name}'`,
    command: `letta mcp-servers create --name "${manifest.name}" --type stdio --command "${stdioConfig.command}" ${argsString ? `--args ${argsString}` : ''}`,
    requiresCredentials: false,
  });

  // Step 3: Configure environment variables
  if (stdioConfig.env && Object.keys(stdioConfig.env).length > 0) {
    const secretEnvs = Object.keys(stdioConfig.env).filter(isLikelySecretEnv);
    const nonSecretEnvs = Object.keys(stdioConfig.env).filter(k => !isLikelySecretEnv(k));

    // Non-secret env vars
    if (nonSecretEnvs.length > 0) {
      const envPairs = nonSecretEnvs.map(k => `${k}="${stdioConfig.env![k]}"`).join(' ');
      steps.push({
        step: stepNum++,
        action: 'Configure environment variables',
        details: `Set non-sensitive environment variables: ${nonSecretEnvs.join(', ')}`,
        command: `# Configure via API with env: { ${envPairs} }`,
        requiresCredentials: false,
      });
    }

    // Secret env vars
    if (secretEnvs.length > 0) {
      steps.push({
        step: stepNum++,
        action: 'Configure secret environment variables',
        details: `Set sensitive environment variables: ${secretEnvs.join(', ')}. These appear to contain secrets.`,
        command: `# Retrieve secrets from your secrets manager, then configure via API`,
        requiresCredentials: true,
      });
    }
  }

  // Step 4: Sync tools
  steps.push({
    step: stepNum++,
    action: 'Sync tools from server',
    details: 'Resync to discover and import tools from the MCP server',
    command: `letta mcp-servers resync --name "${manifest.name}"`,
    requiresCredentials: false,
  });

  // Step 5: Verify
  steps.push({
    step: stepNum++,
    action: 'Verify setup',
    details: 'List the tools imported from this MCP server',
    command: `letta tools list --search "mcp:${manifest.name}"`,
    requiresCredentials: false,
  });

  return steps;
}

/**
 * Generate setup steps based on server type
 */
function generateSetupSteps(manifest: MCPServerManifestEntry): SetupStep[] {
  switch (manifest.serverType) {
    case 'sse':
    case 'streamable_http':
      return generateSSESetupSteps(manifest);
    case 'stdio':
      return generateStdioSetupSteps(manifest);
    default:
      return [{
        step: 1,
        action: `Unknown server type: ${manifest.serverType}`,
        details: 'Manual configuration required',
        requiresCredentials: false,
      }];
  }
}

// =============================================================================
// Credential Requirements
// =============================================================================

/**
 * Determine credential requirements for a server
 */
function getCredentialRequirements(
  manifest: MCPServerManifestEntry,
  credentialStatus: CredentialStatus
): string[] {
  const requirements: string[] = [];

  if (manifest.tokenSecretRef) {
    requirements.push(`Authentication token (secret ref: ${manifest.tokenSecretRef})`);
  }

  if (manifest.customHeadersSecretRef) {
    requirements.push(`Custom headers (secret ref: ${manifest.customHeadersSecretRef})`);
  }

  if (manifest.stdioConfig?.env) {
    const secretEnvs = Object.keys(manifest.stdioConfig.env).filter(isLikelySecretEnv);
    for (const env of secretEnvs) {
      requirements.push(`Environment variable: ${env}`);
    }
  }

  // Generic requirements based on server type
  if (requirements.length === 0) {
    if (manifest.serverType === 'sse' || manifest.serverType === 'streamable_http') {
      if (credentialStatus === CredentialStatus.UNKNOWN) {
        requirements.push('May require authentication (check server documentation)');
      }
    }
  }

  return requirements;
}

/**
 * Get alternative approaches for server setup
 */
function getAlternatives(manifest: MCPServerManifestEntry): string[] {
  const alternatives: string[] = [];

  if (manifest.serverType === 'sse' || manifest.serverType === 'streamable_http') {
    alternatives.push('Use Letta Cloud UI to configure the MCP server with OAuth flow');
    alternatives.push('Use the REST API directly: POST /v1/mcp-servers');
  }

  if (manifest.serverType === 'stdio') {
    alternatives.push('Run the MCP server locally and configure via REST API');
    alternatives.push('Use a container to run the stdio server');
  }

  return alternatives;
}

/**
 * Get documentation links for server setup
 */
function getDocsLinks(manifest: MCPServerManifestEntry): string[] {
  return [
    'https://docs.letta.com/tools/mcp-servers',
    'https://docs.letta.com/api-reference/mcp-servers',
  ];
}

// =============================================================================
// Setup Instructions Generator
// =============================================================================

/**
 * Generate setup instructions for a single MCP server
 */
export function generateServerSetupInstructions(
  classification: MCPServerClassification
): MCPSetupInstructions | null {
  // Only generate for missing or drifted servers
  if (
    classification.ownership !== MCPServerOwnership.MISSING &&
    classification.ownership !== MCPServerOwnership.DRIFTED
  ) {
    return null;
  }

  if (!classification.manifest) {
    return null;
  }

  const manifest = classification.manifest;

  return {
    serverName: manifest.name,
    serverType: manifest.serverType,
    serverUrl: manifest.serverUrl,
    steps: generateSetupSteps(manifest),
    credentialRequirements: getCredentialRequirements(manifest, classification.credentialStatus),
    alternatives: getAlternatives(manifest),
    docsLinks: getDocsLinks(manifest),
  };
}

// =============================================================================
// Report Generator
// =============================================================================

/**
 * Generate tool bundle notes
 */
function generateToolBundleNotes(bundles: ToolBundleStatus[]): string[] {
  const notes: string[] = [];

  const notReadyBundles = bundles.filter(b => !b.ready);
  if (notReadyBundles.length > 0) {
    notes.push('');
    notes.push('Tool Bundle Notes:');
    for (const bundle of notReadyBundles) {
      if (!bundle.serverConfigured) {
        notes.push(`  - Bundle '${bundle.bundleName}': Waiting for MCP server '${bundle.mcpServerName}' to be configured`);
      } else if (bundle.missingTools.length > 0) {
        notes.push(`  - Bundle '${bundle.bundleName}': Missing tools: ${bundle.missingTools.join(', ')}`);
        notes.push(`    Run 'letta mcp-servers resync --name "${bundle.mcpServerName}"' to sync tools`);
      }
    }
  }

  return notes;
}

/**
 * Generate global notes for the report
 */
function generateGlobalNotes(result: MCPDiffResult): string[] {
  const notes: string[] = [];

  notes.push('IMPORTANT: MCP servers contain credentials and must be set up manually.');
  notes.push('');

  // Check for OAuth servers
  const hasOAuth = result.servers.some(
    s => s.credentialStatus === CredentialStatus.OAUTH
  );
  if (hasOAuth) {
    notes.push('Some servers require OAuth authentication:');
    notes.push('  - Use Letta Cloud UI for guided OAuth setup');
    notes.push('  - Or use the /v1/mcp-servers/connect endpoint for OAuth flow');
    notes.push('');
  }

  // Check for credential requirements
  const hasCredentials = result.servers.some(
    s => s.credentialStatus !== CredentialStatus.NONE
  );
  if (hasCredentials) {
    notes.push('Credential handling:');
    notes.push('  - Never store credentials in Git');
    notes.push('  - Use secret references (tokenSecretRef) in manifests');
    notes.push('  - Retrieve actual credentials from your secrets manager');
    notes.push('');
  }

  // Tool bundle notes
  if (result.toolBundles.length > 0) {
    notes.push(...generateToolBundleNotes(result.toolBundles));
  }

  return notes;
}

/**
 * Generate complete setup report from diff result
 */
export function generateSetupReport(result: MCPDiffResult): MCPSetupReport {
  const instructions: MCPSetupInstructions[] = [];

  // Generate instructions for each server needing setup
  for (const server of result.servers) {
    const serverInstructions = generateServerSetupInstructions(server);
    if (serverInstructions) {
      instructions.push(serverInstructions);
    }
  }

  const hasOAuthServers = result.servers.some(
    s => s.credentialStatus === CredentialStatus.OAUTH
  );

  const hasCredentialRequirements = instructions.some(
    i => i.credentialRequirements.length > 0
  );

  return {
    timestamp: new Date().toISOString(),
    org: result.org,
    serversNeedingSetup: instructions.length,
    instructions,
    notes: generateGlobalNotes(result),
    hasOAuthServers,
    hasCredentialRequirements,
  };
}

// =============================================================================
// Report Formatting
// =============================================================================

/**
 * Format setup report as human-readable text
 */
export function formatSetupReport(report: MCPSetupReport): string {
  const lines: string[] = [];

  lines.push('MCP Server Manual Setup Report');
  lines.push('==============================');
  lines.push('');
  lines.push(`Generated: ${report.timestamp}`);
  if (report.org) lines.push(`Organization: ${report.org}`);
  lines.push(`Servers needing setup: ${report.serversNeedingSetup}`);
  lines.push('');

  // Global notes
  if (report.notes.length > 0) {
    lines.push('Notes:');
    for (const note of report.notes) {
      lines.push(note);
    }
    lines.push('');
  }

  // No servers need setup
  if (report.instructions.length === 0) {
    lines.push('All MCP servers are configured. No manual setup required.');
    return lines.join('\n');
  }

  lines.push('='.repeat(60));
  lines.push('');

  // Instructions for each server
  for (const instruction of report.instructions) {
    lines.push(`Server: ${instruction.serverName}`);
    lines.push(`Type: ${instruction.serverType.toUpperCase()}`);
    if (instruction.serverUrl) {
      lines.push(`URL: ${instruction.serverUrl}`);
    }
    lines.push('');

    // Credential requirements
    if (instruction.credentialRequirements.length > 0) {
      lines.push('Credential Requirements:');
      for (const req of instruction.credentialRequirements) {
        lines.push(`  - ${req}`);
      }
      lines.push('');
    }

    // Setup steps
    lines.push('Setup Steps:');
    for (const step of instruction.steps) {
      const credMarker = step.requiresCredentials ? ' [CREDENTIALS]' : '';
      lines.push(`  ${step.step}. ${step.action}${credMarker}`);
      if (step.details) {
        lines.push(`     ${step.details}`);
      }
      if (step.command) {
        lines.push(`     $ ${step.command}`);
      }
      lines.push('');
    }

    // Alternatives
    if (instruction.alternatives && instruction.alternatives.length > 0) {
      lines.push('Alternative Approaches:');
      for (const alt of instruction.alternatives) {
        lines.push(`  - ${alt}`);
      }
      lines.push('');
    }

    // Documentation
    if (instruction.docsLinks && instruction.docsLinks.length > 0) {
      lines.push('Documentation:');
      for (const link of instruction.docsLinks) {
        lines.push(`  - ${link}`);
      }
      lines.push('');
    }

    lines.push('-'.repeat(60));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format setup report as markdown
 */
export function formatSetupReportMarkdown(report: MCPSetupReport): string {
  const lines: string[] = [];

  lines.push('# MCP Server Manual Setup Report');
  lines.push('');
  lines.push(`> Generated: ${report.timestamp}`);
  if (report.org) lines.push(`> Organization: ${report.org}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Servers needing setup:** ${report.serversNeedingSetup}`);
  lines.push(`- **Has OAuth servers:** ${report.hasOAuthServers ? 'Yes' : 'No'}`);
  lines.push(`- **Has credential requirements:** ${report.hasCredentialRequirements ? 'Yes' : 'No'}`);
  lines.push('');

  // Global notes
  if (report.notes.length > 0) {
    lines.push('## Important Notes');
    lines.push('');
    for (const note of report.notes) {
      if (note.trim()) {
        lines.push(note);
      }
    }
    lines.push('');
  }

  // No servers need setup
  if (report.instructions.length === 0) {
    lines.push('**All MCP servers are configured. No manual setup required.**');
    return lines.join('\n');
  }

  // Instructions for each server
  lines.push('## Server Setup Instructions');
  lines.push('');

  for (const instruction of report.instructions) {
    lines.push(`### ${instruction.serverName}`);
    lines.push('');
    lines.push(`- **Type:** ${instruction.serverType.toUpperCase()}`);
    if (instruction.serverUrl) {
      lines.push(`- **URL:** \`${instruction.serverUrl}\``);
    }
    lines.push('');

    // Credential requirements
    if (instruction.credentialRequirements.length > 0) {
      lines.push('#### Credential Requirements');
      lines.push('');
      for (const req of instruction.credentialRequirements) {
        lines.push(`- ${req}`);
      }
      lines.push('');
    }

    // Setup steps
    lines.push('#### Setup Steps');
    lines.push('');
    for (const step of instruction.steps) {
      const credMarker = step.requiresCredentials ? ' **[CREDENTIALS]**' : '';
      lines.push(`${step.step}. **${step.action}**${credMarker}`);
      if (step.details) {
        lines.push(`   - ${step.details}`);
      }
      if (step.command) {
        lines.push('   ```bash');
        lines.push(`   ${step.command}`);
        lines.push('   ```');
      }
      lines.push('');
    }

    // Alternatives
    if (instruction.alternatives && instruction.alternatives.length > 0) {
      lines.push('#### Alternative Approaches');
      lines.push('');
      for (const alt of instruction.alternatives) {
        lines.push(`- ${alt}`);
      }
      lines.push('');
    }

    // Documentation
    if (instruction.docsLinks && instruction.docsLinks.length > 0) {
      lines.push('#### Documentation');
      lines.push('');
      for (const link of instruction.docsLinks) {
        lines.push(`- [${link}](${link})`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format setup report as JSON
 */
export function formatSetupReportJson(report: MCPSetupReport): string {
  return JSON.stringify(report, null, 2);
}
