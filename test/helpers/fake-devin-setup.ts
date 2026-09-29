import type { DevinFetch } from '../../src/devin/http.ts';
import type { Blueprint, KnowledgeNote, Playbook, SnapshotBuild } from '../../src/devin/setup.ts';

export interface DevinCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorized: boolean;
}

export interface FakeBlueprint extends Blueprint {
  contents: string;
}

export const DOWNLOAD_HOST = 'files.devin.test';

/**
 * Offline Devin setup API: repositories, Playbooks, Knowledge notes, indexing, blueprints, builds and their
 * presigned log/contents downloads. Organization-wide and other repositories' resources can be seeded to prove
 * callers leave them alone. Every request is recorded.
 */
export class FakeDevinSetup {
  readonly orgId: string;
  readonly calls: DevinCall[] = [];
  reachable: string[] = [];
  readonly playbooks: Playbook[] = [];
  readonly notes: KnowledgeNote[] = [];
  readonly indexing = new Map<string, boolean>();
  readonly blueprints: FakeBlueprint[] = [];
  readonly builds: SnapshotBuild[] = [];
  readonly logs = new Map<string, string>();
  readonly #failures: { match: (call: DevinCall) => boolean; status: number; body: unknown }[] = [];
  #next = 1;

  constructor(orgId: string) {
    this.orgId = orgId;
  }

  /** Requests that could change state (anything but GET). */
  writes(): DevinCall[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  failNext(match: (call: DevinCall) => boolean, status: number, body: unknown): void {
    this.#failures.push({ match, status, body });
  }

  seedBuild(build: Partial<SnapshotBuild> & { build_id: string }, log: string): void {
    this.builds.push({ status: 'succeeded', pinned: false, started_at: null, completed_at: null, created_at: null, ...build });
    this.logs.set(build.build_id, log);
  }

  readonly fetch: DevinFetch = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const call: DevinCall = {
      method: init.method ?? 'GET',
      path: parsed.pathname,
      query: parsed.searchParams,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorized: headers.has('authorization'),
    };
    this.calls.push(call);
    if (parsed.hostname === DOWNLOAD_HOST) return this.#download(parsed.pathname);
    const failure = this.#failures.findIndex((candidate) => candidate.match(call));
    const removed = failure >= 0 ? this.#failures.splice(failure, 1)[0] : undefined;
    if (removed !== undefined) return json(removed.status, removed.body);
    return this.#route(call);
  };

  #id(prefix: string): string {
    const id = `${prefix}-${this.#next}`;
    this.#next += 1;
    return id;
  }

  #download(path: string): Response {
    const [, kind, id] = path.split('/');
    if (kind === 'logs') {
      const log = this.logs.get(id ?? '');
      return log === undefined ? new Response('missing', { status: 404 }) : new Response(log, { status: 200 });
    }
    const blueprint = this.blueprints.find((candidate) => candidate.blueprint_id === id);
    return blueprint === undefined ? new Response('missing', { status: 404 }) : new Response(blueprint.contents, { status: 200 });
  }

  #route(call: DevinCall): Response {
    const prefix = `/organizations/${this.orgId}/`;
    const at = call.path.indexOf(prefix);
    if (at < 0) return json(404, { detail: 'unknown organization' });
    const route = call.path.slice(at + prefix.length);
    const body = (call.body ?? {}) as Record<string, unknown>;
    let match: RegExpExecArray | null;

    if (route === 'repositories' && call.method === 'GET') {
      const only = call.query.getAll('only_repo_paths').map((path) => path.toLowerCase());
      const items = this.reachable.filter((path) => only.length === 0 || only.includes(path.toLowerCase())).map((repo_path) => ({ repo_path }));
      return page(items);
    }
    if (route === 'playbooks' && call.method === 'GET') return page(this.playbooks);
    if (route === 'playbooks' && call.method === 'POST') {
      const playbook: Playbook = { playbook_id: this.#id('playbook'), title: String(body.title), body: String(body.body), macro: (body.macro as string | null) ?? null, updated_at: 1 };
      this.playbooks.push(playbook);
      return json(200, playbook);
    }
    if ((match = /^playbooks\/([^/]+)$/.exec(route)) && call.method === 'PUT') {
      const playbook = this.playbooks.find((candidate) => candidate.playbook_id === match?.[1]);
      if (playbook === undefined) return json(404, { detail: 'not found' });
      Object.assign(playbook, { title: body.title, body: body.body, macro: body.macro ?? null });
      return json(200, playbook);
    }
    if (route === 'knowledge/notes' && call.method === 'GET') {
      const pinned = call.query.get('pinned_repo');
      return page(this.notes.filter((note) => pinned === null || note.pinned_repo === pinned));
    }
    if (route === 'knowledge/notes' && call.method === 'POST') {
      const note: KnowledgeNote = {
        note_id: this.#id('note'),
        name: String(body.name),
        body: String(body.body),
        trigger: String(body.trigger),
        is_enabled: true,
        pinned_repo: (body.pinned_repo as string | null) ?? null,
        folder_path: '/',
        updated_at: 1,
      };
      this.notes.push(note);
      return json(200, note);
    }
    if ((match = /^knowledge\/notes\/([^/]+)$/.exec(route)) && call.method === 'PUT') {
      const note = this.notes.find((candidate) => candidate.note_id === match?.[1]);
      if (note === undefined) return json(404, { detail: 'not found' });
      Object.assign(note, { name: body.name, body: body.body, trigger: body.trigger, pinned_repo: body.pinned_repo ?? note.pinned_repo });
      return json(200, note);
    }
    if ((match = /^repositories\/(.+)\/indexing$/.exec(route))) {
      const path = decodeURIComponent(match[1] ?? '');
      if (call.method === 'PUT') {
        this.indexing.set(path, true);
        return json(200, { repository_path: path, indexing_enabled: true, branches: [] });
      }
      if (!this.indexing.has(path)) return json(404, { detail: 'repository is not indexed' });
      return json(200, { indexing_enabled: this.indexing.get(path), latest_indexes: [] });
    }
    // Returns every blueprint, whatever the filter, so callers must pick the target's themselves.
    if (route === 'snapshot-setup/blueprints' && call.method === 'GET') {
      return json(200, { data: this.blueprints.map(({ contents: _contents, ...blueprint }) => blueprint) });
    }
    if (route === 'snapshot-setup/blueprints' && call.method === 'POST') {
      const blueprint: FakeBlueprint = {
        blueprint_id: this.#id('bp'),
        type: body.repo_name === null ? 'org' : 'repo',
        repo_name: (body.repo_name as string | null) ?? null,
        contents: String(body.contents),
        created_at: 1,
        updated_at: 1,
      };
      this.blueprints.push(blueprint);
      const { contents: _contents, ...shown } = blueprint;
      return json(200, shown);
    }
    if ((match = /^snapshot-setup\/blueprints\/([^/]+)$/.exec(route)) && call.method === 'PATCH') {
      const blueprint = this.blueprints.find((candidate) => candidate.blueprint_id === match?.[1]);
      if (blueprint === undefined) return json(404, { detail: 'not found' });
      blueprint.contents = String(body.contents);
      const { contents: _contents, ...shown } = blueprint;
      return json(200, shown);
    }
    if ((match = /^snapshot-setup\/blueprints\/([^/]+)\/contents$/.exec(route))) {
      return json(200, { url: `https://${DOWNLOAD_HOST}/blueprints/${match[1]}?X-Signature=sig`, expires_at: 2_000_000_000 });
    }
    if (route === 'snapshot-setup/builds' && call.method === 'GET') return page(this.builds);
    if (route === 'snapshot-setup/builds' && call.method === 'POST') {
      const build: SnapshotBuild = { build_id: this.#id('build'), status: 'pending', pinned: false, started_at: null, completed_at: null, created_at: null };
      this.builds.push(build);
      return json(200, build);
    }
    if ((match = /^snapshot-setup\/builds\/([^/]+)$/.exec(route))) {
      const build = this.builds.find((candidate) => candidate.build_id === match?.[1]);
      return build === undefined ? json(404, { detail: 'not found' }) : json(200, build);
    }
    if ((match = /^snapshot-setup\/builds\/([^/]+)\/logs$/.exec(route))) {
      return json(200, { url: `https://${DOWNLOAD_HOST}/logs/${match[1]}?X-Signature=sig`, expires_at: 2_000_000_000 });
    }
    return json(404, { detail: `no fake route for ${call.method} ${route}` });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function page(items: readonly unknown[]): Response {
  return json(200, { items, has_next_page: false, end_cursor: null });
}
