# Letta-Sync Migration Plan

This document describes the end-to-end migration plan from the current, Smarty-branded `smarty-admin` tool to a general-purpose, Letta-Code-adjacent tool tentatively named **`letta-sync`**.

The intent is to make the "Git-backed managed layer" workflow reusable outside of Smarty Pants:

- Git-authored desired state for Letta resources (blocks/tools/templates/MCP/sources/identities)
- A reconciler that can `diff` and `sync` desired state into Letta
- Bootstrap and in-place upgrades for long-lived agents, without patching `letta-code`

---

## Goals

- Provide a standalone CLI that complements `letta` (Letta Code) without requiring upstream patches.
- Make Git the human-governed source of truth for managed Letta resources:
  - PR review, history, revert, promotion, pinning
- Support "in-place upgrades": improve managed resources while preserving agent continuity (messages/history).
- Preserve (and formalize) safe operational behavior:
  - dry-run first
  - idempotent sync
  - no clobbering of unmanaged resources
  - clear tagging/metadata so cleanup and drift detection is safe
- Use a similar distribution stack to `letta-code`:
  - Bun-first development
  - single-file bundled executable output
  - GitHub Actions release w/ npm OIDC trusted publishing

## Non-goals (v1)

- Not re-implementing the `letta` TUI.
- Not trying to sync observed runtime state (messages/runs/steps/jobs).
- Not building a full package manager (lockfiles, semver graph resolution) in v1.
- Not baking in Smarty Pants-specific conventions (vault layout, manifest layout, workflows).

---

## Naming, Publishing, and Ownership

We are not part of the Letta organization, so we should assume we cannot publish under `@letta-ai/*`.

Recommended naming strategy:

- CLI binary: `letta-sync`
  - This is user-facing and should stay stable.

- npm package name (choose one):
  1) Preferred if available: `letta-sync` (unscoped)
     - Best UX: `npm i -g letta-sync`.
     - Downside: name may already be taken.

  2) Practical default: scoped package, unscoped binary
     - Example: `@smarty-pants/letta-sync` (or another org you control)
     - Publish config: set `bin` to `letta-sync` so UX is still `letta-sync ...`.

  3) Future collaboration option: transfer or dual-publish
     - If Letta wants it to be official, we can either:
       - transfer the npm package ownership, or
       - publish a new official package under `@letta-ai/letta-sync` and deprecate the original.

Important: even if the package is not `@letta-ai/*`, it can still be framed as "Letta-compatible" and can depend on the official `@letta-ai/letta-client`.

---

## Where We Are Today (Current State)

The current implementation lives in:

- `tools/letta-sync/`

It already contains most of what `letta-sync` needs:

- CLI entrypoint and command wiring: `tools/letta-sync/src/cli.ts`
- Desired-state loading:
  - resource schema: `tools/letta-sync/src/packages/types.ts`
  - loading: `tools/letta-sync/src/packages/loader.ts`
  - merging/layering: `tools/letta-sync/src/packages/merge.ts`
- Reconcilers:
  - blocks: `tools/letta-sync/src/reconcilers/blocks/*`
  - tools: `tools/letta-sync/src/reconcilers/tools/*`
  - MCP: `tools/letta-sync/src/reconcilers/mcp/*`
  - templates: `tools/letta-sync/src/reconcilers/templates/*`
  - folders/sources: `tools/letta-sync/src/reconcilers/folders/*`
  - identities: `tools/letta-sync/src/reconcilers/identities/*`
  - agent upgrades: `tools/letta-sync/src/reconcilers/agents/*`
- Bootstrap, pinning, and exec:
  - `tools/letta-sync/src/bootstrap/*`
- Tests:
  - unit: `tools/letta-sync/tests/unit/*`
  - e2e: `tools/letta-sync/tests/e2e/*`

However, it also has Smarty-specific assumptions we must remove or isolate:

- Auth resolver includes Smarty repo vault behavior: `tools/letta-sync/src/config/letta-auth.ts`
- Project targeting uses `.smarty/*` config and `SMARTY_*` env vars: `tools/letta-sync/src/config/project.ts`, `tools/letta-sync/src/cli.ts`
- Manifest discovery in some commands assumes monorepo layout (e.g. `packages/examples/**`): `tools/letta-sync/src/commands/sync.ts`
- Workflow-specific commands (not generic): `tools/letta-sync/src/commands/new-task.ts`

---

## Target Product Definition (What `letta-sync` Is)

`letta-sync` is a companion CLI to `letta` (Letta Code) that provides the missing GitOps-style control plane:

- `letta-sync diff`: show desired vs remote differences
- `letta-sync sync`: apply desired state to remote (idempotent, safe-by-default)
- `letta-sync bootstrap`: create or reuse an agent in the target Letta project and pin it
- `letta-sync upgrade`: upgrade an existing agent in place (managed components only)
- `letta-sync status`: report what is deployed and what the agent/project is bound to

Optional (v1.1 / v2):

- `letta-sync drift`: convert remote edits into local file changes (PR-friendly)

---

## Compatibility With Letta Code

`letta-sync` does not need any `letta-code` patches.

Integration points are:

- `.letta/settings.local.json` pinned `lastAgent` (written by `letta-code` and by our bootstrap)
- launching `letta` by agent id:
  - `letta --agent <id>`

Bootstrap should treat `letta-code` as the front-end harness and Letta API as the back-end runtime.

---

## Design Rules (Carry Over From The Spec)

- Managed vs observed-only split:
  - Observed-only: messages/runs/steps/jobs. Never reconciled.
  - Managed: blocks/tools/templates/MCP/folders/sources/identities and select agent-level settings.

- Managed resources must be clearly identifiable:
  - metadata/tagging (e.g. `managed_by`, `source`, and/or tags)
  - deterministic selection rules when duplicates exist

- Sync must be:
  - diffable
  - idempotent
  - non-destructive by default
  - explicit for deletions/renames

---

## Migration Plan (Phases)

### Phase 0: Decide naming + target repo

Decisions:

- Repo name: `letta-sync`
- Binary name: `letta-sync`
- npm name: pick one of:
  - `letta-sync` (if available)
  - `@smarty-pants/letta-sync` (or another scope you control)

Deliverables:

- Create a new repo (empty skeleton) OR decide to stage the refactor in-place (recommended) and extract later.

Recommendation:

- Stage refactor inside `smarty-dev` first (`tools/letta-sync/`) until tests pass and branding is removed, then split to its own repo.

---

### Phase 1: In-place refactor in this monorepo

Create a working directory:

- Move `tools/letta-sync/` -> `tools/letta-sync/` (git mv)

Then, systematically debrand:

- Rename package/bin:
  - `package.json`: `name`, `bin`, `description`, `author`
  - CLI name/help text in `src/cli.ts`

- Rename env vars:
  - From: `SMARTY_PROJECT`, `SMARTY_ORG`, `SMARTY_AGENT`
  - To: `LETTA_SYNC_PROJECT`, `LETTA_SYNC_ORG`, `LETTA_SYNC_AGENT`
  - Keep backwards-compat aliases for a transition period.

- Rename manager metadata:
  - From: `metadata.managed_by = 'smarty-admin'`
  - To: configurable default `metadata.managed_by = 'letta-sync'`
  - Accept `smarty-admin` as a legacy value for selection/cleanup in existing projects.

Acceptance criteria:

- All CLI surfaces mention `letta-sync`.
- Existing tests still pass.

---

### Phase 2: Remove Smarty-specific auth and config conventions

#### 2.1 Auth

Replace `tools/letta-sync/src/config/letta-auth.ts` behavior:

- Default auth resolution:
  - `process.env.LETTA_API_KEY`
  - else `~/.letta/settings.json` (as written by `letta setup`)

- Optional hook (for Smarty or other teams):
  - `LETTA_SYNC_AUTH_HELPER` command, invoked to print a token
  - this keeps vault-first and other org-specific credential strategies out of core

Acceptance criteria:

- `letta-sync` works in a clean non-Smarty repo with only `letta setup` performed.
- No `.secrets/*` or `sops` assumptions in the default path.

#### 2.2 Project targeting config path

Replace `.smarty/project.json` and `.smarty/registry.json` conventions with `.letta/*` conventions.

Proposed:

- `.letta/project.json` (optional)
- `.letta/registry.json` (optional)

Maintain:

- `LETTA_PROJECT` env var support as a generic alias

Acceptance criteria:

- A repo that already uses `.letta/` for Letta Code can use the same directory for `letta-sync` config.

---

### Phase 3: Make desired-state discovery generic

Remove the hard-coded `packages/examples/**` assumptions.

New configuration model:

- CLI flags:
  - `--manifest <path>` (repeatable)
  - `--manifests-dir <dir>`

- Default behavior (if nothing is provided):
  - resolve repo root by walking up until `.letta/` or `.git/` exists
  - if `.letta/manifests/` exists, load everything under it
  - otherwise error with a helpful message

We should keep the current resource format (it is already generic):

- `apiVersion: letta.ai/v1`
- `kind: Block | Tool | MCPServer | Template | Folder | Identity | AgentPolicy`

Acceptance criteria:

- Running in a minimal repo with `.letta/manifests/*.yaml` works.
- No `packages/examples` assumptions remain in core commands.

---

### Phase 4: Separate "core" from "workflow extras"

Decide the v1 scope of the published tool.

Recommended:

- Keep in core:
  - diff/sync/status/bootstrap/upgrade/scope-sync
  - cleanup-* commands if they are purely about managed resource hygiene

- Move out of core:
  - `new-task` (it hardcodes a docs layout and a specific `current_task` block scheme)

Options for `new-task`:

- Create a small companion package (internal or public) that depends on `letta-sync` and implements that workflow.
- Or keep it in `smarty-dev` only.

Acceptance criteria:

- `letta-sync` contains only generally applicable functionality.

---

### Phase 5: Adopt letta-code-style Bun build and distribution

Switch from the current `tsc`-only build to a single-file bundle, matching `letta-code`.

Implementation:

- Add `build.js` using `Bun.build` similar to `forks/letta-code/build.js`.
- Output: `letta-sync.js` with shebang and executable bit.
- Update `package.json`:
  - `bin`: `letta-sync` -> `letta-sync.js`
  - `files`: include `letta-sync.js` and license/readme
  - scripts:
    - `dev`: `bun run src/index.ts` (or equivalent)
    - `build`: `bun run build.js`
    - `prepare`: `bun run build`

Notes:

- `tools/letta-sync` currently uses `commander` and Node fs; those should work under Bun.
- Consider adopting the same lint stack (`biome`) as `letta-code` for consistency.

Acceptance criteria:

- `bun run build` produces a single runnable `letta-sync.js`.
- `./letta-sync.js --help` works.

---

### Phase 6: CI + Release pipeline (GitHub Actions)

Create workflows modeled after `forks/letta-code/.github/workflows/*`:

- `ci.yml`:
  - bun install
  - lint/typecheck/tests

- `release.yml`:
  - manual dispatch with version bump
  - bun build
  - smoke tests
  - npm publish with OIDC trusted publishing

Acceptance criteria:

- A release produces an npm artifact and (optionally) a GitHub release with the bundled `letta-sync.js`.

---

### Phase 7: Extract to a standalone repo

Once Phases 1-6 are stable and tests pass, split to its own repo.

Options:

- `git subtree split` or `git filter-repo` to preserve history
- or a fresh repo with copied files (simpler, but loses history)

After extraction:

- Update `smarty-dev` to consume `letta-sync` via one of:
  - git submodule
  - npm dev dependency
  - pinned release artifact

Acceptance criteria:

- `smarty-dev` still works with a wrapper (if desired), but the canonical project lives in its own repo.

---

## Proposed repo layout for `letta-sync`

Example layout aligned with letta-code:

- `src/index.ts` (bun shebang entrypoint)
- `src/cli.ts` (command routing)
- `src/reconcilers/**`
- `src/manifests/**` or `src/packages/**` (rename to avoid confusion with package managers)
- `build.js`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `README.md`
- `LICENSE`

---

## Backwards Compatibility Strategy (for `smarty-dev`)

To avoid breaking existing workflows in `smarty-dev`:

- Keep a transitional wrapper command `smarty-admin` that execs `letta-sync`.
- Support legacy env vars (`SMARTY_PROJECT`, etc.) as aliases.
- Accept legacy managed metadata `managed_by: smarty-admin` during reconciliation.

This allows incremental rollout and avoids a flag day.

---

## Acceptance Tests (What "Done" Looks Like)

- In a fresh, non-Smarty repo:
  - `npm i -g <package>`
  - `letta setup`
  - create `.letta/project.json` + `.letta/manifests/blocks.yaml`
  - `letta-sync diff --dry-run` works
  - `letta-sync sync` creates/updates blocks
  - `letta-sync bootstrap --name ... --exec` pins agent and launches `letta`

- Idempotency:
  - running `letta-sync sync` twice produces no changes

- Safety:
  - unmanaged blocks are not clobbered
  - deletions/renames require explicit flags

- Packaging:
  - `letta-sync.js` is a single-file distributable
  - CI builds and tests pass

---

## Open Questions

- Do we want the config directory to be `.letta/sync/` (more structured) or a single `.letta/sync.json`?
- Do we want to keep the resource format as YAML only, or allow JSON as well?
- Do we want `drift` (Letta -> Git) in v1, or ship it as v1.1 once core sync is stable?
- Do we want a plugin interface for org-specific extras (auth helpers, workflow commands), or keep those external?
