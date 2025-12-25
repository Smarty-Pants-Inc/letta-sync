/**
 * new-task command - archive previous task and reset current_task
 *
 * Design:
 * - Keep durable "how we work" blocks stable.
 * - Treat current_task as the session block.
 * - Archive old current_task into repo markdown files.
 * - Keep archives "in sync like any other block" by updating a managed
 *   `task_archive_index` block in manifests and running `sync`.
 */

import type { CommandContext, CommandResult } from '../types.js';
import {
  header,
  info,
  success,
  warn,
  error as printError,
} from '../utils/output.js';
import { syncCommand } from './sync.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

export interface NewTaskOptions {
  title: string;
  goal?: string;
  done?: string;
  /** Also update manifests + run sync (default true) */
  sync?: boolean;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function timestampUtcCompact(d = new Date()): string {
  // YYYYMMDDTHHMMSSZ
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function readPinnedAgentId(repoRoot: string): string | null {
  const p = path.join(repoRoot, '.letta', 'settings.local.json');
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf-8')) as { lastAgent?: string };
    return obj.lastAgent ?? null;
  } catch {
    return null;
  }
}

function findRepoRoot(startDir: string): string {
  // Heuristic: walk up until we find .git or .letta
  let current = startDir;
  const root = path.parse(current).root;
  while (true) {
    if (fs.existsSync(path.join(current, '.git')) || fs.existsSync(path.join(current, '.letta'))) {
      return current;
    }
    if (current === root) return startDir;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function loadMultiDocYaml(filePath: string): yaml.Document.Parsed[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.parseAllDocuments(content);
}

function saveMultiDocYaml(filePath: string, docs: yaml.Document.Parsed[]): void {
  // yaml.Document#toString() already includes the leading '---' document marker.
  // If we add our own separators, we end up with lots of '---\n---' empty docs.
  const rendered = docs
    .filter((d) => d.contents != null)
    .map((d) => d.toString().trimEnd())
    .filter((s) => s.length > 0)
    .join('\n');
  fs.writeFileSync(filePath, rendered.endsWith('\n') ? rendered : rendered + '\n', 'utf-8');
}

function setBlockValueInManifest(opts: {
  blocksYamlPath: string;
  label: string;
  value: string;
}): void {
  const docs = loadMultiDocYaml(opts.blocksYamlPath);

  let found = false;
  for (const d of docs) {
    const obj = d.toJSON() as any;
    if (!obj || obj.kind !== 'Block') continue;
    if (obj.spec?.label !== opts.label) continue;

    // Mutate via Document API so YAML stays valid.
    d.setIn(['spec', 'value'], opts.value);
    found = true;
    break;
  }

  if (!found) {
    throw new Error(`Could not find Block with spec.label=${opts.label} in ${opts.blocksYamlPath}`);
  }

  saveMultiDocYaml(opts.blocksYamlPath, docs);
}

function buildCurrentTaskMarkdown(opts: { title: string; goal?: string; done?: string }): string {
  const lines: string[] = [];
  lines.push(`# Current Task`);
  lines.push('');
  lines.push(`## Title`);
  lines.push(`- ${opts.title}`);
  lines.push('');
  if (opts.goal) {
    lines.push('## Goal');
    lines.push(`- ${opts.goal}`);
    lines.push('');
  }
  if (opts.done) {
    lines.push('## Definition Of Done');
    lines.push(`- ${opts.done}`);
    lines.push('');
  }
  lines.push('## Next Steps');
  lines.push('- [ ] (fill in)');
  lines.push('');
  lines.push('## Open Questions');
  lines.push('- (none)');
  lines.push('');
  lines.push('## Notes');
  lines.push('-');
  lines.push('');
  return lines.join('\n');
}

export async function newTaskCommand(
  ctx: CommandContext,
  options: NewTaskOptions
): Promise<CommandResult<{ archivePath: string }>> {
  const { options: globalOpts, outputFormat } = ctx;

  if (outputFormat === 'human') {
    header('New Task');
  }

  const repoRoot = findRepoRoot(process.cwd());
  const agentId = readPinnedAgentId(repoRoot);

  const ts = timestampUtcCompact();
  const slug = slugify(options.title);

  const archivesDir = path.join(repoRoot, 'docs', 'agent-archives');
  const tasksDir = path.join(archivesDir, 'tasks');
  const indexPath = path.join(archivesDir, 'index.md');
  const taskPath = path.join(tasksDir, `${ts}-${slug}.md`);

  fs.mkdirSync(tasksDir, { recursive: true });

  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      '# Agent Task Archive\n\nThis file is managed by `smarty-admin new-task`.\n\n',
      'utf-8'
    );
  }

  // Read current_task from manifests as the thing we're archiving.
  const blocksYamlPath = path.join(repoRoot, 'packages', 'examples', 'project-smarty-dev', 'blocks.yaml');
  let currentTaskValue = '';
  try {
    const docs = loadMultiDocYaml(blocksYamlPath);
    for (const d of docs) {
      const obj = d.toJSON() as any;
      if (obj?.kind === 'Block' && obj?.spec?.label === 'current_task') {
        currentTaskValue = String(obj?.spec?.value ?? '');
        break;
      }
    }
  } catch {
    // best effort
  }

  const archiveLines: string[] = [];
  archiveLines.push(`# Task Archive Entry`);
  archiveLines.push('');
  archiveLines.push(`- Timestamp (UTC): ${ts}`);
  archiveLines.push(`- Title: ${options.title}`);
  if (agentId) archiveLines.push(`- Agent: ${agentId}`);
  archiveLines.push(`- Repo: ${path.basename(repoRoot)}`);
  archiveLines.push('');
  archiveLines.push('## Previous Current Task');
  archiveLines.push('');
  archiveLines.push(
    currentTaskValue.trim().length > 0
      ? currentTaskValue.trim()
      : '(no prior current_task found)'
  );
  archiveLines.push('');

  fs.writeFileSync(taskPath, archiveLines.join('\n'), 'utf-8');

  // Append to index
  const relTaskPath = path.relative(archivesDir, taskPath).split(path.sep).join('/');
  const indexEntry = `- ${ts} - [${options.title}](./${relTaskPath})\n`;
  fs.appendFileSync(indexPath, indexEntry, 'utf-8');

  // Reset current_task in manifests
  const newCurrentTask = buildCurrentTaskMarkdown({
    title: options.title,
    goal: options.goal,
    done: options.done,
  });
  setBlockValueInManifest({ blocksYamlPath, label: 'current_task', value: newCurrentTask });

  // Update task archive index block in manifests (create if missing is future work).
  // For now, we store the index contents as a managed block.
  const indexContents = fs.readFileSync(indexPath, 'utf-8');
  try {
    setBlockValueInManifest({
      blocksYamlPath,
      label: 'task_archive_index',
      value: indexContents,
    });
  } catch {
    // If the block doesn't exist yet, warn and continue.
    warn(`Missing task_archive_index block in ${blocksYamlPath} (add it to manifests to sync archives to Letta)`);
  }

  if (outputFormat === 'human') {
    success(`Archived previous task to: ${taskPath}`);
    success(`Reset current_task in manifests`);
  }

  // Optionally run sync so Letta stays aligned with repo source-of-truth.
  const doSync = options.sync !== false;
  if (doSync) {
    if (outputFormat === 'human') {
      info('Syncing blocks to Letta...');
    }
    const syncResult = await syncCommand(ctx, { pruneDuplicates: true });
    if (!syncResult.success) {
      return {
        success: false,
        message: 'new-task completed locally but sync failed',
        errors: [syncResult.message],
        data: { archivePath: taskPath },
      };
    }
  }

  return {
    success: true,
    message: 'new-task complete',
    data: { archivePath: taskPath },
  };
}
