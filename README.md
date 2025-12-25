# letta-sync

CLI tool for managing Letta agent configurations. Provides commands for syncing, diffing, bootstrapping, and upgrading agent configurations between local files and the Letta API.

## Installation

```bash
cd tools/letta-sync
npm install
npm run build
```

For development:
```bash
npm run dev -- <command>  # Run without building
```

## Usage

```bash
letta-sync <command> [options]
```

### Global Options

| Option | Description | Default |
|--------|-------------|---------|
| `--project <slug>` | Target Letta project | (from env or config) |
| `--org <slug>` | Target organization | (from env or config) |
| `--agent <id>` | Target specific agent ID | (all agents) |
| `--dry-run` | Show what would happen without making changes | `false` |
| `--json` | Output JSON for CI/automation | `false` |
| `--channel <name>` | Release channel: `stable`, `beta`, `pinned` | `stable` |
| `-v, --verbose` | Enable verbose logging | `false` |

### Environment Variables

- `LETTA_SYNC_PROJECT` - Default project slug or ID (primary)
- `LETTA_SYNC_ORG` - Default organization slug
- `LETTA_SYNC_AGENT` - Default agent ID
- `LETTA_PROJECT` - Alternative project env var (alias)
- `LETTA_API_KEY` - API authentication key
- `LETTA_BASE_URL` - Letta server URL (default: https://api.letta.com)

<details>
<summary>Backwards compatibility aliases</summary>

The following legacy environment variables are still supported for backwards compatibility:
- `SMARTY_PROJECT` - Legacy project env var
- `SMARTY_ORG` - Legacy organization env var
- `SMARTY_AGENT` - Legacy agent env var

</details>

## Project Targeting

letta-sync resolves which Letta project to target using the following priority order:

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | `--project` flag | `--project my-project` |
| 2 | `LETTA_SYNC_PROJECT` env var | `export LETTA_SYNC_PROJECT=my-project` |
| 3 | `.letta/project.json` | Local project config |
| 4 | Registry mapping | Repo-to-project mapping |
| 5 (lowest) | Default project | From registry |

### Project Identifiers

Projects can be specified as:
- **Slug**: `my-project` - Human-readable identifier
- **ID**: `proj_abc123` - API identifier
- **Combined**: `my-project:proj_abc123` - Both slug and ID

### Local Project Configuration

Create `.letta/project.json` in your project root:

```json
{
  "slug": "my-project",
  "id": "proj_abc123",
  "name": "My Project"
}
```

### Project Registry

For multi-repo setups, create `.letta/registry.json`:

```json
{
  "version": "1.0",
  "defaultProject": {
    "slug": "default-project"
  },
  "mappings": {
    "org/frontend-repo": {
      "projectSlug": "frontend",
      "projectId": "proj_frontend123"
    },
    "org/backend-repo": {
      "projectSlug": "backend",
      "projectId": "proj_backend456"
    }
  }
}
```

## Commands

### `diff`

Show differences between local and remote configuration.

```bash
# Show all differences
letta-sync diff

# Show differences for a specific agent
letta-sync diff --agent agent-123

# Show all fields, not just changed ones
letta-sync diff --full

# Output as JSON for scripting
letta-sync diff --json
```

### `sync`

Apply local configuration changes to the remote Letta agent.

```bash
# Preview changes (dry run)
letta-sync sync --dry-run

# Apply changes
letta-sync sync

# Force sync even with conflicts
letta-sync sync --force

# Sync only specific sections
letta-sync sync --only system_prompt memory_blocks
```

### `status`

Show current agent configuration state.

```bash
# Show status
letta-sync status

# Show extended information
letta-sync status --extended

# Get status as JSON
letta-sync status --json
```

### `bootstrap`

Initialize a new agent configuration. The bootstrap command:
1. Creates the agent with appropriate tags and configuration
2. Pins the agent to the project
3. Runs auto-upgrade to apply latest template versions
4. Runs scope sync to attach relevant memory blocks (best-effort)
5. Optionally launches Letta Code with the new agent

```bash
# Create a new agent
letta-sync bootstrap --name "my-agent"

# Use a template
letta-sync bootstrap --name "my-agent" --template coding-assistant

# Create minimal configuration
letta-sync bootstrap --name "my-agent" --minimal

# Preview what would be created
letta-sync bootstrap --name "my-agent" --dry-run

# Launch Letta Code after bootstrap
letta-sync bootstrap --name "my-agent" --exec

# Skip scope sync (useful for CI/testing)
letta-sync bootstrap --name "my-agent" --skip-scope-sync
```

#### Scope Sync

By default, bootstrap runs scope sync to automatically attach relevant memory blocks
based on the project's scope registry. This ensures the agent has access to:

- **Scope registry block**: YAML configuration defining project scopes
- **Scope policy block**: Guidelines for how agents should use scopes
- **Scope-specific blocks**: Memory blocks for matched scopes (project, conventions, etc.)
- **Lane scopes block**: Lane-private state tracking matched scopes and focus scope

Scope sync is "best-effort" - if it fails, bootstrap continues successfully with a warning.
Use `--skip-scope-sync` to disable this behavior.

See `docs/specs/scope-registry.md` for scope registry documentation.

### `upgrade`

Upgrade an existing agent configuration to a new version.

```bash
# Check for available upgrades
letta-sync upgrade --check

# Upgrade to latest version
letta-sync upgrade

# Upgrade to specific version
letta-sync upgrade --target 2.0.0

# Skip confirmation prompts
letta-sync upgrade --yes
```

## Examples

### Project Targeting

```bash
# Use project slug
letta-sync status --project my-project

# Use project ID
letta-sync status --project proj_abc123

# Use combined format (slug:id)
letta-sync sync --project my-project:proj_abc123

# Use environment variable
export LETTA_SYNC_PROJECT=production
letta-sync diff

# Verbose mode shows project resolution
letta-sync status --project staging -v
# [verbose] Project resolution attempted: cli
# [verbose] Resolved project: staging (via cli)
```

### CI/CD Pipeline Usage

```bash
# Check for drift in CI with explicit project
LETTA_SYNC_PROJECT=production letta-sync diff --json > drift-report.json
if [ $(jq '.data | length' drift-report.json) -gt 0 ]; then
  echo "Configuration drift detected!"
  exit 1
fi
```

### Multi-Project Workflow

```bash
# Diff against staging
letta-sync diff --project staging

# Preview sync to production
letta-sync sync --project production --dry-run

# Apply to production
letta-sync sync --project production
```

### Multi-Agent Management

```bash
# Sync all agents in a project
letta-sync sync --project my-project

# Upgrade specific agent
letta-sync upgrade --agent agent-abc123 --target 1.2.0
```

### Development Workflow

```bash
# 1. Check current status
letta-sync status

# 2. See what would change
letta-sync diff

# 3. Preview the sync
letta-sync sync --dry-run

# 4. Apply changes
letta-sync sync
```

## CI/CD Workflows

letta-sync includes GitHub Actions workflows for automated configuration management.

### Configuration Diff (`.github/workflows/letta-sync-diff.yml`)

Automatically runs on PRs to main when Letta configuration files change.

**Triggers:**
- Pull requests to `main` that modify `.letta/**` or `partners/*/.letta/**`
- Manual trigger via workflow_dispatch

**Features:**
- Detects configuration drift between local and remote
- Comments diff report on PRs
- Optionally fails on breaking changes (version downgrades)

### Staging Sync (`.github/workflows/letta-sync-staging-sync.yml`)

Syncs local configuration to the staging environment with safety controls.

**Triggers:**
- Push to `main` (after merge) when config files change
- Manual trigger via workflow_dispatch

**Safety Features:**
1. **Dry-run first**: Always previews changes before syncing
2. **Environment approval**: Requires approval from `staging` environment reviewers
3. **Skip approval option**: For emergency fixes (use with caution)
4. **Force sync option**: Override conflicts when necessary

**Manual Trigger Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `dry_run_only` | Only preview changes, don't sync | `false` |
| `force_sync` | Override conflicts | `false` |
| `agent_id` | Target specific agent | (all agents) |
| `skip_approval` | Bypass environment approval | `false` |

**Required Setup:**

1. **Secrets:**
   - `LETTA_API_KEY` - API key for Letta authentication

2. **Variables:**
   - `STAGING_PROJECT` - Target project slug (default: `staging`)

3. **Environment:**
   - Create a `staging` environment in GitHub repo settings
   - Configure required reviewers for approval gate

**Example: Manual staging sync**
```bash
# Trigger via GitHub CLI
gh workflow run letta-sync-staging-sync.yml \
  --field dry_run_only=false \
  --field agent_id=agent-123
```

## Project Structure

```
tools/letta-sync/
├── src/
│   ├── cli.ts           # Main entry point with arg parsing
│   ├── types.ts         # Shared types and interfaces
│   ├── config/
│   │   ├── index.ts     # Config module exports
│   │   └── project.ts   # Project resolution logic
│   ├── commands/
│   │   ├── index.ts     # Command exports
│   │   ├── diff.ts      # diff command implementation
│   │   ├── sync.ts      # sync command implementation
│   │   ├── status.ts    # status command implementation
│   │   ├── bootstrap.ts # bootstrap command implementation
│   │   └── upgrade.ts   # upgrade command implementation
│   └── utils/
│       └── output.ts    # Output formatting utilities
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- status

# Type check
npm run typecheck

# Build for production
npm run build

# Run built version
npm start -- status
```

## Roadmap

- [ ] Letta API integration
- [x] Project targeting (--project flag, env vars, registry)
- [x] Local configuration file support (`.letta/project.json`)
- [ ] Template system for bootstrap
- [ ] Configuration validation
- [ ] Interactive mode for conflict resolution
- [ ] Git integration for change tracking
- [ ] Project registry with branch overrides
