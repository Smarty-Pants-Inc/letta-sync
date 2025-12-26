/**
 * Minimal Projects API wrapper.
 *
 * Letta Cloud re-introduced /v1/projects, but the TS SDK may lag behind typed
 * support. We keep a small wrapper here that uses the SDK's baseURL + fetch.
 */

import { Letta } from '@letta-ai/letta-client';

export interface LettaProject {
  id: string;
  slug: string;
  name: string;
}

interface ListProjectsResponse {
  projects: LettaProject[];
  hasNextPage?: boolean;
}

function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}

async function fetchJson<T>(
  client: Letta,
  apiKey: string,
  path: string,
  init: { method: string; body?: unknown }
): Promise<{ status: number; json: T } | { status: number; error: string; raw: string }> {
  const url = new URL(path, client.baseURL).toString();
  // The SDK's `fetch` helper exists at runtime, but is not part of the public
  // TypeScript surface in some versions.
  const res = await (client as any).fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const raw = await res.text();
  try {
    const json = raw ? (JSON.parse(raw) as T) : ({} as T);
    return { status: res.status, json };
  } catch (err) {
    return {
      status: res.status,
      error: err instanceof Error ? err.message : String(err),
      raw,
    };
  }
}

export async function listProjects(apiKey: string): Promise<LettaProject[]> {
  const client = new Letta({ apiKey });
  const resp = await fetchJson<ListProjectsResponse>(client, apiKey, '/v1/projects', { method: 'GET' });
  if ('error' in resp) {
    throw new Error(`Failed to list projects: ${resp.status} (${resp.error})`);
  }
  return resp.json.projects ?? [];
}

export async function createProject(
  apiKey: string,
  params: { slug: string; name?: string }
): Promise<LettaProject> {
  const client = new Letta({ apiKey });
  const slug = normalizeSlug(params.slug);
  const name = params.name ?? params.slug;

  const resp = await fetchJson<LettaProject>(client, apiKey, '/v1/projects', {
    method: 'POST',
    body: { slug, name },
  });
  if ('error' in resp) {
    throw new Error(`Failed to create project: ${resp.status} (${resp.error})`);
  }
  return resp.json;
}

export async function ensureProject(
  apiKey: string,
  params: { slug: string; name?: string }
): Promise<{ project: LettaProject; created: boolean }> {
  const slug = normalizeSlug(params.slug);
  const projects = await listProjects(apiKey);
  const existing = projects.find((p) => normalizeSlug(p.slug) === slug);
  if (existing) {
    return { project: existing, created: false };
  }
  const project = await createProject(apiKey, { slug, name: params.name ?? params.slug });
  return { project, created: true };
}
