import { DevinError } from './errors.ts';
import { DevinTransport, type DevinFetch, type DevinRequest } from './http.ts';

/**
 * Devin environment setup operations for the later setup task: Playbooks and Knowledge notes (v3), and
 * repository indexing, blueprints and snapshot builds (v3beta1). Kept apart from `DevinClient` so the
 * service's session work never depends on beta endpoints.
 */

export interface Playbook {
  playbook_id: string;
  title: string;
  body: string;
  macro: string | null;
  updated_at: number;
}

export interface KnowledgeNote {
  note_id: string;
  name: string;
  body: string;
  trigger: string;
  is_enabled: boolean;
  pinned_repo: string | null;
  folder_path: string;
  updated_at: number;
}

export interface RepositoryIndexing {
  repository_path: string;
  indexing_enabled: boolean;
  branches: string[];
}

export interface RepositoryIndexingStatus {
  indexing_enabled: boolean;
  latest_indexes: { job_id: string; status: 'failed' | 'completed' | 'in_progress'; commit: string; branch_name: string | null; created_at: number }[];
}

export interface Blueprint {
  blueprint_id: string;
  type: 'enterprise' | 'org' | 'repo';
  repo_name: string | null;
  created_at: string | number;
  updated_at: string | number;
}

export interface SnapshotBuild {
  build_id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  pinned: boolean;
  started_at: string | number | null;
  completed_at: string | number | null;
}

export interface DevinSetupClientOptions {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetch?: DevinFetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DevinSetupClient {
  readonly #transport: DevinTransport;
  readonly #org: string;

  constructor(options: DevinSetupClientOptions) {
    if (options.orgId.trim() === '') {
      throw new DevinError({ kind: 'not-configured', operation: 'configure', status: null, message: 'A Devin organization id is required', retryAfterSeconds: null, ambiguous: false });
    }
    this.#transport = new DevinTransport(options);
    this.#org = encodeURIComponent(options.orgId);
  }

  // Playbooks (v3)

  listPlaybooks(): Promise<Playbook[]> {
    return this.#list('list-playbooks', `/v3/organizations/${this.#org}/playbooks`, {}, 'playbook_id');
  }

  createPlaybook(input: { title: string; body: string; macro?: string | null }): Promise<Playbook> {
    return this.#object('create-playbook', { method: 'POST', path: `/v3/organizations/${this.#org}/playbooks`, body: { title: input.title, body: input.body, macro: input.macro ?? null } }, 'playbook_id');
  }

  updatePlaybook(playbookId: string, input: { title: string; body: string; macro?: string | null }): Promise<Playbook> {
    return this.#object('update-playbook', {
      method: 'PUT',
      path: `/v3/organizations/${this.#org}/playbooks/${encodeURIComponent(playbookId)}`,
      body: { title: input.title, body: input.body, macro: input.macro ?? null },
    }, 'playbook_id');
  }

  // Knowledge notes (v3)

  listKnowledgeNotes(filter: { pinnedRepo?: string; search?: string } = {}): Promise<KnowledgeNote[]> {
    return this.#list('list-knowledge-notes', `/v3/organizations/${this.#org}/knowledge/notes`, { pinned_repo: filter.pinnedRepo, search: filter.search }, 'note_id');
  }

  createKnowledgeNote(input: { name: string; body: string; trigger: string; pinnedRepo?: string | null }): Promise<KnowledgeNote> {
    return this.#object('create-knowledge-note', {
      method: 'POST',
      path: `/v3/organizations/${this.#org}/knowledge/notes`,
      body: { name: input.name, body: input.body, trigger: input.trigger, pinned_repo: input.pinnedRepo ?? null },
    }, 'note_id');
  }

  updateKnowledgeNote(noteId: string, input: { name: string; body: string; trigger: string; pinnedRepo?: string | null }): Promise<KnowledgeNote> {
    return this.#object('update-knowledge-note', {
      method: 'PUT',
      path: `/v3/organizations/${this.#org}/knowledge/notes/${encodeURIComponent(noteId)}`,
      body: { name: input.name, body: input.body, trigger: input.trigger, pinned_repo: input.pinnedRepo ?? null },
    }, 'note_id');
  }

  // Repository indexing (v3beta1)

  indexRepository(repositoryPath: string, branchNames: string[] = []): Promise<RepositoryIndexing> {
    return this.#object('index-repository', { method: 'PUT', path: this.#indexingPath(repositoryPath), body: { branch_names: branchNames } }, 'repository_path');
  }

  getRepositoryIndexing(repositoryPath: string): Promise<RepositoryIndexingStatus> {
    return this.#object('get-repository-indexing', { method: 'GET', path: this.#indexingPath(repositoryPath) }, 'indexing_enabled');
  }

  // Snapshot setup (v3beta1)

  async listBlueprints(repoName?: string): Promise<Blueprint[]> {
    const body = await this.#transport.request({ operation: 'list-blueprints', method: 'GET', path: `/v3beta1/organizations/${this.#org}/snapshot-setup/blueprints`, query: { repo_name: repoName } });
    if (!isRecord(body) || !Array.isArray(body.data)) throw this.#transport.invalidResponse('list-blueprints', 'expected a BlueprintList', false);
    return body.data as Blueprint[];
  }

  createBlueprint(input: { contents: string; repoName?: string | null }): Promise<Blueprint> {
    return this.#object('create-blueprint', {
      method: 'POST',
      path: `/v3beta1/organizations/${this.#org}/snapshot-setup/blueprints`,
      body: { contents: input.contents, repo_name: input.repoName ?? null },
    }, 'blueprint_id');
  }

  updateBlueprint(blueprintId: string, input: { contents: string }): Promise<Blueprint> {
    return this.#object('update-blueprint', {
      method: 'PATCH',
      path: `/v3beta1/organizations/${this.#org}/snapshot-setup/blueprints/${encodeURIComponent(blueprintId)}`,
      body: { contents: input.contents },
    }, 'blueprint_id');
  }

  triggerBuild(): Promise<SnapshotBuild> {
    return this.#object('trigger-build', { method: 'POST', path: `/v3beta1/organizations/${this.#org}/snapshot-setup/builds`, body: {} }, 'build_id');
  }

  getBuild(buildId: string): Promise<SnapshotBuild> {
    return this.#object('get-build', { method: 'GET', path: `/v3beta1/organizations/${this.#org}/snapshot-setup/builds/${encodeURIComponent(buildId)}` }, 'build_id');
  }

  #indexingPath(repositoryPath: string): string {
    // `owner/repo`: each segment is encoded and the separator kept, matching the documented path parameter.
    const encoded = repositoryPath.split('/').map(encodeURIComponent).join('/');
    return `/v3beta1/organizations/${this.#org}/repositories/${encoded}/indexing`;
  }

  async #object<T>(operation: string, request: Omit<DevinRequest, 'operation'>, requiredField: string): Promise<T> {
    const body = await this.#transport.request({ operation, ...request });
    if (!isRecord(body) || body[requiredField] === undefined) {
      throw this.#transport.invalidResponse(operation, `response is missing ${requiredField}`, request.method !== 'GET');
    }
    return body as T;
  }

  async #list<T>(operation: string, path: string, query: DevinRequest['query'], requiredField: string): Promise<T[]> {
    const items: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const body = await this.#transport.request({ operation, method: 'GET', path, query: { ...query, first: 100, after } });
      if (!isRecord(body) || !Array.isArray(body.items) || !body.items.every((item) => isRecord(item) && item[requiredField] !== undefined)) {
        throw this.#transport.invalidResponse(operation, 'expected a paginated response', false);
      }
      items.push(...(body.items as T[]));
      if (body.has_next_page !== true) return items;
      if (typeof body.end_cursor !== 'string' || body.end_cursor === '') {
        throw this.#transport.invalidResponse(operation, 'has_next_page is true but end_cursor is missing', false);
      }
      after = body.end_cursor;
    }
    throw this.#transport.invalidResponse(operation, 'too many pages', false);
  }
}
