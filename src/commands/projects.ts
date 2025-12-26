/**
 * projects command - List and create Letta Cloud projects.
 */

import type { CommandContext, CommandResult } from '../types.js';
import { header, info, success, error as printError } from '../utils/output.js';
import { resolveLettaApiKey } from '../config/letta-auth.js';
import { listProjects, ensureProject, type LettaProject } from '../api/projects.js';

export interface ProjectsListOptions {}

export async function projectsListCommand(
  ctx: CommandContext,
  _options: ProjectsListOptions = {}
): Promise<CommandResult<{ projects: LettaProject[] }>> {
  const { outputFormat } = ctx;
  const apiKey = resolveLettaApiKey();
  if (!apiKey) {
    return { success: false, message: 'LETTA_API_KEY is required (vault-first or env)' };
  }

  const projects = await listProjects(apiKey);

  if (outputFormat === 'human') {
    header('Projects');
    if (projects.length === 0) {
      info('No projects found.');
    } else {
      for (const p of projects) {
        info(`${p.slug}  (${p.id})  ${p.name}`);
      }
    }
  }

  return { success: true, message: 'Projects listed', data: { projects } };
}

export interface ProjectsCreateOptions {
  slug: string;
  name?: string;
}

export async function projectsCreateCommand(
  ctx: CommandContext,
  options: ProjectsCreateOptions
): Promise<CommandResult<{ project: LettaProject; created: boolean }>> {
  const { outputFormat } = ctx;
  const apiKey = resolveLettaApiKey();
  if (!apiKey) {
    return { success: false, message: 'LETTA_API_KEY is required (vault-first or env)' };
  }

  if (!options.slug) {
    return { success: false, message: 'Missing required option: --slug <slug>' };
  }

  try {
    const { project, created } = await ensureProject(apiKey, { slug: options.slug, name: options.name });

    if (outputFormat === 'human') {
      header('Project');
      if (created) {
        success(`Created project: ${project.slug}`);
      } else {
        info(`Project already exists: ${project.slug}`);
      }
      info(`ID: ${project.id}`);
      info(`Name: ${project.name}`);
    }

    return { success: true, message: created ? 'Project created' : 'Project already exists', data: { project, created } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (outputFormat === 'human') {
      printError(msg);
    }
    return { success: false, message: msg };
  }
}
