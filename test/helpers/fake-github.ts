import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHubRepo } from '../../src/config/settings.ts';
import { closesIssue } from '../../src/tracker/common.ts';
import type { FailurePoint, SeedIssue, SeedPullRequest, SimulatedFailure } from '../../src/tracker/memory.ts';
import type { PullRequestFile, ReviewState, TrackerErrorCode } from '../../src/tracker/types.ts';

/**
 * Offline stand-in for the GitHub REST API (issues, comments, events, timeline, labels, pulls, merge, check runs
 * and statuses), serving raw GitHub-shaped JSON with Link pagination. Its simulation methods mirror
 * `InMemoryTracker`'s so the same contract tests drive both implementations.
 */

export interface RecordedRequest {
  method: string;
  /** Path relative to `/repos/{owner}/{name}/`, or the full path for other routes. */
  route: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  /** Objects are sent as JSON, strings verbatim. */
  body?: unknown;
}

interface Override {
  match: (request: RecordedRequest) => boolean;
  response: FakeResponse | ((request: RecordedRequest) => FakeResponse);
  /** Runs the real handler (mutating state) before sending the override. */
  applied: boolean;
}

interface FakeUser {
  login: string;
  id: number;
  type: 'User' | 'Bot';
}

interface FakeComment {
  id: number;
  user: FakeUser;
  body: string;
  created_at: string;
  updated_at: string;
}

interface FakeEvent {
  id: number;
  event: string;
  actor: FakeUser;
  label?: { name: string };
  created_at: string;
}

interface FakePull {
  head_sha: string;
  head_ref: string;
  base_sha: string;
  base_ref: string;
  draft: boolean;
  merged_at: string | null;
  merged_by: FakeUser | null;
  merge_commit_sha: string | null;
  files: PullRequestFile[];
  changed_files: number;
  diff: string | null;
  reviews: Array<{ id: number; user: FakeUser; state: string; commit_id: string; submitted_at: string | null; body: string }>;
  threads: FakeThread[];
  mergeBlock: string | null;
}

/** A review thread in GraphQL shape: bot logins without `[bot]`, `__typename` telling bots apart. */
interface FakeThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: { author: { login: string; __typename: string }; body: string; url: string; createdAt: string; originalCommit: { oid: string } | null }[];
}

interface FakeBranch {
  sha: string;
  protected: boolean;
  requiredChecks: string[] | null;
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  labels: string[];
  user: FakeUser;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull: FakePull | null;
  comments: FakeComment[];
  events: FakeEvent[];
  references: number[];
}

interface FakeStatus {
  id: number;
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
  creator: FakeUser;
  created_at: string;
  updated_at: string;
}

const ROUTES: Record<FailurePoint, { method: string; pattern: RegExp; diff?: boolean }> = {
  listOpenIssues: { method: 'GET', pattern: /^issues$/ },
  getIssue: { method: 'GET', pattern: /^issues\/\d+$/ },
  createIssue: { method: 'POST', pattern: /^issues$/ },
  listComments: { method: 'GET', pattern: /^issues\/\d+\/comments$/ },
  postComment: { method: 'POST', pattern: /^issues\/\d+\/comments$/ },
  listIssueEvents: { method: 'GET', pattern: /^issues\/\d+\/events$/ },
  addLabels: { method: 'POST', pattern: /^issues\/\d+\/labels$/ },
  removeLabel: { method: 'DELETE', pattern: /^issues\/\d+\/labels\/.+$/ },
  closeIssue: { method: 'PATCH', pattern: /^issues\/\d+$/ },
  reopenIssue: { method: 'PATCH', pattern: /^issues\/\d+$/ },
  findLinkedPullRequests: { method: 'GET', pattern: /^issues\/\d+\/timeline$/ },
  getPullRequest: { method: 'GET', pattern: /^pulls\/\d+$/, diff: false },
  getPullRequestDiff: { method: 'GET', pattern: /^pulls\/\d+$/, diff: true },
  listPullRequestFiles: { method: 'GET', pattern: /^pulls\/\d+\/files$/ },
  listReviews: { method: 'GET', pattern: /^pulls\/\d+\/reviews$/ },
  listCheckRuns: { method: 'GET', pattern: /^commits\/[^/]+\/check-runs$/ },
  getCombinedStatus: { method: 'GET', pattern: /^commits\/[^/]+\/status$/ },
  createCommitStatus: { method: 'POST', pattern: /^statuses\/[^/]+$/ },
  mergePullRequest: { method: 'PUT', pattern: /^pulls\/\d+\/merge$/ },
  listReviewThreads: { method: 'POST', pattern: /^\/graphql$/ },
  getBranch: { method: 'GET', pattern: /^branches\/[^/]+$/ },
  getDefaultBranch: { method: 'GET', pattern: /^\/repos\/[^/]+\/[^/]+$/ },
};

const OPEN_PR_TEST_MERGE_SHA = 'e'.repeat(40);

export function failureResponse(failure: SimulatedFailure): FakeResponse {
  const statusFor: Partial<Record<TrackerErrorCode, number>> = {
    unauthorized: 401,
    forbidden: 403,
    'not-found': 404,
    validation: 422,
    conflict: 409,
    'server-error': 502,
    'not-mergeable': 405,
    'head-mismatch': 409,
  };
  if (failure.code === 'rate-limited') {
    const reset = Math.ceil(Date.now() / 1000) + (failure.retryAfterSeconds ?? 60);
    return {
      status: failure.status ?? 403,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(reset),
        'x-ratelimit-resource': 'core',
        'x-github-request-id': 'FAKE:RATE',
      },
      body: { message: failure.message ?? 'API rate limit exceeded for user ID 1.' },
    };
  }
  return {
    status: failure.status ?? statusFor[failure.code] ?? 500,
    headers: { 'x-github-request-id': `FAKE:${failure.code.toUpperCase()}` },
    body: { message: failure.message ?? `simulated ${failure.code}` },
  };
}

function user(login: string): FakeUser {
  const id = Number.parseInt(createHash('sha1').update(login).digest('hex').slice(0, 8), 16);
  return { login, id, type: login.endsWith('[bot]') ? 'Bot' : 'User' };
}

export class FakeGitHub {
  readonly repo: GitHubRepo;
  readonly token: string;
  readonly actor: FakeUser;
  readonly requests: RecordedRequest[] = [];
  readonly #server: Server;
  readonly #issues = new Map<number, FakeIssue>();
  readonly #statuses = new Map<string, FakeStatus[]>();
  readonly #checkRuns = new Map<string, object[]>();
  readonly #branches = new Map<string, FakeBranch>([['main', { sha: '0'.repeat(40), protected: false, requiredChecks: [] }]]);
  #defaultBranch = 'main';
  readonly #repoLabels: { name: string; color: string; description: string | null }[] = [];
  readonly #files = new Map<string, { sha: string; content: string }>();
  readonly #foreignIssues = new Map<string, { number: number; title: string; body: string; user: FakeUser; created_at: string; state: 'open' | 'closed'; pull: boolean }>();
  readonly #overrides: Override[] = [];
  #baseUrl = '';
  #nextNumber = 1;
  #nextId = 1000;
  #clock = Date.UTC(2026, 0, 1);

  private constructor(repo: GitHubRepo, token: string) {
    this.repo = repo;
    this.token = token;
    this.actor = user('bug-smasher[bot]');
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
  }

  static async start(options: { repo?: GitHubRepo; token?: string } = {}): Promise<FakeGitHub> {
    const fake = new FakeGitHub(options.repo ?? { owner: 'acme', name: 'widgets' }, options.token ?? 'ghp_fakeTokenValue0123456789');
    fake.#server.listen(0, '127.0.0.1');
    await once(fake.#server, 'listening');
    const address = fake.#server.address() as AddressInfo;
    fake.#baseUrl = `http://127.0.0.1:${address.port}`;
    return fake;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Requests to a failure point's route, e.g. to assert a call order. */
  requestsFor(point: FailurePoint): RecordedRequest[] {
    return this.requests.filter((request) => this.#matches(point, request));
  }

  /** Replaces the next response matching `match`. */
  respondOnce(match: (request: RecordedRequest) => boolean, response: FakeResponse | ((request: RecordedRequest) => FakeResponse)): void {
    this.#overrides.push({ match, response, applied: false });
  }

  // Simulation API (mirrors InMemoryTracker) ---------------------------------------------------------------

  failNext(point: FailurePoint, failure: SimulatedFailure | TrackerErrorCode): void {
    const spec = typeof failure === 'string' ? { code: failure } : failure;
    this.#overrides.push({
      match: (request) => this.#matches(point, request),
      response: failureResponse(spec),
      applied: spec.applied === true,
    });
  }

  /** A label defined on the target repository (not on any issue). */
  seedLabel(label: { name: string; color: string; description?: string | null }): void {
    this.#repoLabels.push({ name: label.name, color: label.color, description: label.description ?? null });
  }

  /** The target repository's label definitions. */
  repositoryLabels(): { name: string; color: string; description: string | null }[] {
    return this.#repoLabels.map((label) => ({ ...label }));
  }

  seedFile(path: string, content: string): void {
    this.#files.set(path, { sha: this.#blobSha(content), content });
  }

  file(path: string): string | undefined {
    return this.#files.get(path)?.content;
  }

  /** An issue in another repository on the same server; it can be read but never written. */
  seedForeignIssue(repo: GitHubRepo, seed: { number: number; title: string; body?: string; author?: string; pullRequest?: boolean }): void {
    this.#foreignIssues.set(`${repo.owner}/${repo.name}#${seed.number}`.toLowerCase(), {
      number: seed.number,
      title: seed.title,
      body: seed.body ?? '',
      user: user(seed.author ?? 'reporter'),
      created_at: this.#tick(),
      state: 'open',
      pull: seed.pullRequest ?? false,
    });
  }

  /** Recorded requests that could change state (anything but GET). */
  writes(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  seedIssue(seed: SeedIssue): { number: number } {
    const issue = this.#newIssue(seed.title, seed.body ?? '', [...(seed.labels ?? [])], user(seed.author ?? 'reporter'), null);
    if (seed.state === 'closed') {
      issue.state = 'closed';
      issue.state_reason = 'completed';
      issue.closed_at = issue.created_at;
    }
    return { number: issue.number };
  }

  seedPullRequest(seed: SeedPullRequest): { number: number } {
    const files = [...(seed.files ?? [])];
    const issue = this.#newIssue(seed.title, seed.body ?? '', [...(seed.labels ?? [])], user(seed.author ?? 'devin-ai-integration[bot]'), {
      head_sha: seed.headSha,
      head_ref: '',
      base_sha: seed.baseSha ?? '0'.repeat(40),
      base_ref: seed.baseRef ?? 'main',
      draft: seed.draft ?? false,
      merged_at: null,
      merged_by: null,
      merge_commit_sha: null,
      files,
      changed_files: seed.changedFiles ?? files.length,
      diff: seed.diff === undefined ? '' : seed.diff,
      reviews: [],
      threads: [],
      mergeBlock: null,
    });
    const pull = issue.pull as FakePull;
    pull.head_ref = seed.headRef ?? `fix-${issue.number}`;
    for (const number of seed.references ?? []) this.#issue(number).references.push(issue.number);
    return { number: issue.number };
  }

  externalComment(issueNumber: number, login: string, body: string): { id: string } {
    const issue = this.#issue(issueNumber);
    const comment = this.#addComment(issue, user(login), body);
    issue.events.push({ id: this.#nextId++, event: 'subscribed', actor: user(login), created_at: this.#tick() });
    return { id: String(comment.id) };
  }

  externalLabel(issueNumber: number, label: string, action: 'add' | 'remove', login: string): void {
    const issue = this.#issue(issueNumber);
    if (action === 'add') this.#addLabels(issue, [label], user(login));
    else this.#removeLabel(issue, label, user(login));
  }

  externalCloseIssue(issueNumber: number, login: string): void {
    this.#setState(this.#issue(issueNumber), 'closed', 'completed', user(login));
  }

  externalReopenIssue(issueNumber: number, login: string): void {
    this.#setState(this.#issue(issueNumber), 'open', null, user(login));
  }

  externalMerge(prNumber: number, login: string): string {
    return this.#merge(this.#issue(prNumber), user(login));
  }

  externalClosePullRequest(prNumber: number): void {
    const issue = this.#issue(prNumber);
    if (issue.state === 'closed') return;
    issue.state = 'closed';
    issue.closed_at = this.#tick();
    issue.updated_at = issue.closed_at;
  }

  pushHead(prNumber: number, headSha: string): void {
    this.#pull(this.#issue(prNumber)).head_sha = headSha;
  }

  blockMerge(prNumber: number, reason: string | null): void {
    this.#pull(this.#issue(prNumber)).mergeBlock = reason;
  }

  addReviewThread(
    prNumber: number,
    thread: { author: string; body: string; path?: string; line?: number; commitSha?: string; outdated?: boolean },
  ): { id: string } {
    const pull = this.#pull(this.#issue(prNumber));
    const id = `PRRT_${this.#nextId++}`;
    const bot = thread.author.endsWith('[bot]');
    pull.threads.push({
      id,
      isResolved: false,
      isOutdated: thread.outdated ?? false,
      path: thread.path ?? null,
      line: thread.line ?? null,
      comments: [
        {
          author: { login: bot ? thread.author.slice(0, -'[bot]'.length) : thread.author, __typename: bot ? 'Bot' : 'User' },
          body: thread.body,
          url: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${prNumber}#discussion_${id}`,
          createdAt: this.#tick(),
          originalCommit: { oid: thread.commitSha ?? pull.head_sha },
        },
      ],
    });
    return { id };
  }

  resolveReviewThread(prNumber: number, threadId: string): void {
    const thread = this.#pull(this.#issue(prNumber)).threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) throw new Error(`No review thread ${threadId}`);
    thread.isResolved = true;
  }

  setBranch(name: string, branch: { sha: string; protected?: boolean; requiredChecks?: string[] | null; default?: boolean }): void {
    const requiredChecks = branch.requiredChecks === undefined ? [] : branch.requiredChecks;
    this.#branches.set(name, {
      sha: branch.sha,
      protected: branch.protected ?? (requiredChecks === null || requiredChecks.length > 0),
      requiredChecks: requiredChecks === null ? null : [...requiredChecks],
    });
    if (branch.default === true) this.#defaultBranch = name;
  }

  addReview(prNumber: number, review: { reviewer: string; state: ReviewState; commitId?: string; body?: string }): { id: string } {
    const pull = this.#pull(this.#issue(prNumber));
    const id = this.#nextId++;
    pull.reviews.push({
      id,
      user: user(review.reviewer),
      state: review.state.toUpperCase(),
      commit_id: review.commitId ?? pull.head_sha,
      submitted_at: review.state === 'pending' ? null : this.#tick(),
      body: review.body ?? '',
    });
    return { id: String(id) };
  }

  addCheckRun(sha: string, run: { name: string; status: string; conclusion: string | null; app?: string }): { id: string } {
    const id = this.#nextId++;
    const at = this.#tick();
    this.#checkRuns.set(sha, [
      ...(this.#checkRuns.get(sha) ?? []),
      {
        id,
        name: run.name,
        head_sha: sha,
        status: run.status,
        conclusion: run.conclusion,
        app: { slug: run.app ?? 'github-actions' },
        html_url: null,
        started_at: at,
        completed_at: run.status === 'completed' ? at : null,
      },
    ]);
    return { id: String(id) };
  }

  // HTTP ---------------------------------------------------------------------------------------------------

  #matches(point: FailurePoint, request: RecordedRequest): boolean {
    const route = ROUTES[point];
    if (request.method !== route.method || !route.pattern.test(request.route)) return false;
    if (route.diff === undefined) return true;
    return route.diff === String(request.headers.accept ?? '').includes('diff');
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', this.#baseUrl);
    const prefix = `/repos/${this.repo.owner}/${this.repo.name}/`;
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      route: url.pathname.startsWith(prefix) ? decodeURI(url.pathname.slice(prefix.length)) : url.pathname,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
    this.requests.push(request);

    let response: FakeResponse;
    const index = this.#overrides.findIndex((override) => override.match(request));
    if (index !== -1) {
      const [override] = this.#overrides.splice(index, 1);
      if (override === undefined) throw new Error('unreachable');
      if (override.applied) this.#route(request, url);
      response = typeof override.response === 'function' ? override.response(request) : override.response;
    } else if (req.headers.authorization !== `Bearer ${this.token}`) {
      response = { status: 401, body: { message: 'Bad credentials' } };
    } else {
      response = this.#route(request, url);
    }
    const body =
      response.body === undefined ? '' : typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
    res.writeHead(response.status, {
      'content-type': typeof response.body === 'string' ? 'text/plain' : 'application/json',
      ...response.headers,
    });
    res.end(body);
  }

  #route(request: RecordedRequest, url: URL): FakeResponse {
    const { method, route } = request;
    const body = (request.body ?? {}) as Record<string, unknown>;
    let match: RegExpExecArray | null;

    if (route === 'issues' && method === 'GET') {
      const labels = (request.query.get('labels') ?? '').split(',').filter((label) => label !== '');
      const state = request.query.get('state') ?? 'open';
      const items = [...this.#issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .filter((issue) => labels.every((label) => issue.labels.some((l) => l.toLowerCase() === label.toLowerCase())))
        .map((issue) => this.#issueJson(issue));
      return this.#page(url, items);
    }
    if (route === 'issues' && method === 'POST') {
      if (typeof body.title !== 'string' || body.title === '') return this.#error(422, 'Validation Failed');
      const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
      const issue = this.#newIssue(body.title, String(body.body ?? ''), labels, this.actor, null);
      return { status: 201, body: this.#issueJson(issue) };
    }
    if ((match = /^issues\/(\d+)$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      if (method === 'PATCH') {
        if (body.state === 'closed' || body.state === 'open') {
          this.#setState(issue, body.state, typeof body.state_reason === 'string' ? body.state_reason : 'completed', this.actor);
        }
      }
      return { status: 200, body: this.#issueJson(issue) };
    }
    if ((match = /^issues\/(\d+)\/comments$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      if (method === 'POST') return { status: 201, body: this.#commentJson(issue, this.#addComment(issue, this.actor, String(body.body))) };
      return this.#page(url, issue.comments.map((comment) => this.#commentJson(issue, comment)));
    }
    if ((match = /^issues\/(\d+)\/events$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      return this.#page(url, issue.events.map((event) => ({ ...event, commit_id: null })));
    }
    if ((match = /^issues\/(\d+)\/timeline$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      const items: object[] = issue.events.map((event) => ({ ...event }));
      for (const number of issue.references) {
        const source = this.#issue(number);
        items.push({
          event: 'cross-referenced',
          actor: source.user,
          created_at: source.created_at,
          source: { type: 'issue', issue: this.#issueJson(source) },
        });
      }
      return this.#page(url, items);
    }
    if ((match = /^issues\/(\d+)\/labels$/.exec(route)) && method === 'POST') {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      this.#addLabels(issue, Array.isArray(body.labels) ? body.labels.map(String) : [], this.actor);
      return { status: 200, body: issue.labels.map((name) => this.#labelJson(name)) };
    }
    if ((match = /^issues\/(\d+)\/labels\/(.+)$/.exec(route)) && method === 'DELETE') {
      const issue = this.#issues.get(Number(match[1]));
      if (issue === undefined) return this.#error(404, 'Not Found');
      const name = decodeURIComponent(match[2] ?? '');
      if (!issue.labels.some((label) => label.toLowerCase() === name.toLowerCase())) return this.#error(404, 'Label does not exist');
      this.#removeLabel(issue, name, this.actor);
      return { status: 200, body: issue.labels.map((label) => this.#labelJson(label)) };
    }
    if (route === 'labels' && method === 'GET') {
      return this.#page(url, this.#repoLabels.map((label) => ({ id: user(label.name).id, ...label, default: false })));
    }
    if (route === 'labels' && method === 'POST') {
      const name = String(body.name ?? '');
      if (name === '' || this.#repoLabels.some((label) => label.name.toLowerCase() === name.toLowerCase())) {
        return this.#error(422, 'Validation Failed');
      }
      const label = { name, color: String(body.color), description: typeof body.description === 'string' ? body.description : null };
      this.#repoLabels.push(label);
      return { status: 201, body: { id: user(name).id, ...label, default: false } };
    }
    if ((match = /^labels\/(.+)$/.exec(route)) && method === 'PATCH') {
      const name = decodeURIComponent(match[1] ?? '');
      const label = this.#repoLabels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (label === undefined) return this.#error(404, 'Not Found');
      if (typeof body.new_name === 'string') label.name = body.new_name;
      if (typeof body.color === 'string') label.color = body.color;
      if (typeof body.description === 'string') label.description = body.description;
      return { status: 200, body: { id: user(label.name).id, ...label, default: false } };
    }
    if ((match = /^contents\/(.+)$/.exec(route))) {
      const path = match[1] ?? '';
      const file = this.#files.get(path);
      if (method === 'GET') {
        if (file === undefined) return this.#error(404, 'Not Found');
        return { status: 200, body: { type: 'file', path, sha: file.sha, encoding: 'base64', content: Buffer.from(file.content).toString('base64') } };
      }
      if (method === 'PUT') {
        if (file !== undefined && body.sha !== file.sha) return this.#error(409, `${path} does not match ${String(body.sha)}`);
        if (file === undefined && body.sha !== undefined) return this.#error(422, 'sha given for a new file');
        const content = Buffer.from(String(body.content), 'base64').toString('utf8');
        this.seedFile(path, content);
        return { status: file === undefined ? 201 : 200, body: { content: { path, sha: this.#blobSha(content) }, commit: { sha: 'f'.repeat(40) } } };
      }
    }
    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(route))) {
      const [, owner, name, number] = match;
      const foreign = this.#foreignIssues.get(`${owner}/${name}#${number}`.toLowerCase());
      if (method !== 'GET') return this.#error(403, 'Resource not accessible by integration');
      if (foreign === undefined) return this.#error(404, 'Not Found');
      return {
        status: 200,
        body: {
          id: 7_000_000 + foreign.number,
          number: foreign.number,
          title: foreign.title,
          body: foreign.body === '' ? null : foreign.body,
          state: foreign.state,
          state_reason: null,
          labels: [],
          user: foreign.user,
          html_url: `https://github.com/${owner}/${name}/${foreign.pull ? 'pull' : 'issues'}/${foreign.number}`,
          repository_url: `${this.#baseUrl}/repos/${owner}/${name}`,
          created_at: foreign.created_at,
          updated_at: foreign.created_at,
          closed_at: null,
          ...(foreign.pull ? { pull_request: { url: `${this.#baseUrl}/repos/${owner}/${name}/pulls/${foreign.number}` } } : {}),
        },
      };
    }
    if (/^\/repos\//.test(route) && method !== 'GET') return this.#error(403, 'Resource not accessible by integration');
    if ((match = /^pulls\/(\d+)$/.exec(route)) && method === 'GET') {
      const issue = this.#issues.get(Number(match[1]));
      if (issue?.pull == null) return this.#error(404, 'Not Found');
      if (String(request.headers.accept ?? '').includes('diff')) {
        if (issue.pull.diff === null) {
          return this.#error(406, 'Sorry, the diff exceeded the maximum number of files (300). Consider using the list files API.');
        }
        return { status: 200, body: issue.pull.diff };
      }
      return { status: 200, body: this.#pullJson(issue) };
    }
    if ((match = /^pulls\/(\d+)\/files$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue?.pull == null) return this.#error(404, 'Not Found');
      return this.#page(
        url,
        issue.pull.files.map((file) => ({
          filename: file.filename,
          previous_filename: file.previousFilename ?? undefined,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch ?? undefined,
        })),
      );
    }
    if ((match = /^pulls\/(\d+)\/reviews$/.exec(route))) {
      const issue = this.#issues.get(Number(match[1]));
      if (issue?.pull == null) return this.#error(404, 'Not Found');
      return this.#page(url, issue.pull.reviews);
    }
    if ((match = /^pulls\/(\d+)\/merge$/.exec(route)) && method === 'PUT') {
      const issue = this.#issues.get(Number(match[1]));
      if (issue?.pull == null) return this.#error(404, 'Not Found');
      const pull = issue.pull;
      if (typeof body.sha === 'string' && body.sha !== pull.head_sha) {
        return this.#error(409, 'Head branch was modified. Review and try the merge again.');
      }
      if (issue.state !== 'open') return this.#error(405, 'Pull Request is not mergeable');
      if (pull.mergeBlock !== null) return this.#error(405, pull.mergeBlock);
      const sha = this.#merge(issue, this.actor);
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (route === '/graphql' && method === 'POST') {
      const variables = (body.variables ?? {}) as { number?: number; cursor?: string | null };
      const issue = this.#issues.get(Number(variables.number));
      if (issue?.pull == null) {
        return { status: 200, body: { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }] } };
      }
      const start = Number(variables.cursor ?? 0);
      const nodes = issue.pull.threads.slice(start, start + 2);
      const next = start + nodes.length;
      const hasNextPage = next < issue.pull.threads.length;
      return {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage, endCursor: hasNextPage ? String(next) : null },
                  nodes: nodes.map((thread) => ({ ...thread, comments: { nodes: thread.comments } })),
                },
              },
            },
          },
        },
      };
    }
    if (route === `/repos/${this.repo.owner}/${this.repo.name}` && method === 'GET') {
      return { status: 200, body: { name: this.repo.name, full_name: `${this.repo.owner}/${this.repo.name}`, default_branch: this.#defaultBranch } };
    }
    if ((match = /^branches\/([^/]+)$/.exec(route)) && method === 'GET') {
      const name = decodeURIComponent(match[1] ?? '');
      const branch = this.#branches.get(name);
      if (branch === undefined) return this.#error(404, 'Branch not found');
      const protection =
        branch.requiredChecks === null
          ? undefined
          : { enabled: branch.protected, required_status_checks: { enforcement_level: 'everyone', contexts: branch.requiredChecks, checks: branch.requiredChecks.map((context) => ({ context, app_id: null })) } };
      return { status: 200, body: { name, commit: { sha: branch.sha }, protected: branch.protected, ...(protection === undefined ? {} : { protection }) } };
    }
    if ((match = /^rules\/branches\/([^/]+)$/.exec(route)) && method === 'GET') {
      const branch = this.#branches.get(decodeURIComponent(match[1] ?? ''));
      if (branch?.requiredChecks === null) return this.#error(403, 'Resource not accessible by integration');
      return { status: 200, body: [] };
    }
    if ((match = /^commits\/([^/]+)\/check-runs$/.exec(route))) {
      const runs = this.#checkRuns.get(this.#resolve(decodeURIComponent(match[1] ?? ''))) ?? [];
      return this.#page(url, runs, (items) => ({ total_count: runs.length, check_runs: items }));
    }
    if ((match = /^commits\/([^/]+)\/status$/.exec(route))) {
      const sha = this.#resolve(decodeURIComponent(match[1] ?? ''));
      const latest = new Map<string, FakeStatus>();
      for (const status of [...(this.#statuses.get(sha) ?? [])].reverse()) if (!latest.has(status.context)) latest.set(status.context, status);
      const statuses = [...latest.values()];
      const states = statuses.map((status) => status.state);
      const state = states.some((s) => s === 'error' || s === 'failure')
        ? 'failure'
        : states.length === 0 || states.includes('pending')
          ? 'pending'
          : 'success';
      return this.#page(url, statuses, (items) => ({ state, sha, total_count: statuses.length, statuses: items }));
    }
    if ((match = /^statuses\/([^/]+)$/.exec(route)) && method === 'POST') {
      const sha = match[1] ?? '';
      const at = this.#tick();
      const status: FakeStatus = {
        id: this.#nextId++,
        context: String(body.context ?? 'default'),
        state: String(body.state),
        description: typeof body.description === 'string' ? body.description : null,
        target_url: typeof body.target_url === 'string' ? body.target_url : null,
        creator: this.actor,
        created_at: at,
        updated_at: at,
      };
      if (status.description !== null && status.description.length > 140) return this.#error(422, 'description is too long');
      this.#statuses.set(sha, [...(this.#statuses.get(sha) ?? []), status]);
      return { status: 201, body: status };
    }
    return this.#error(404, 'Not Found');
  }

  #page(url: URL, items: readonly unknown[], wrap?: (items: unknown[]) => object): FakeResponse {
    const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? '30'));
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const last = Math.max(1, Math.ceil(items.length / perPage));
    const headers: Record<string, string> = {};
    if (page < last) {
      const link = (n: number): string => {
        const next = new URL(url.href);
        next.searchParams.set('page', String(n));
        return next.href;
      };
      headers.link = `<${link(page + 1)}>; rel="next", <${link(last)}>; rel="last"`;
    }
    return { status: 200, headers, body: wrap === undefined ? slice : wrap(slice) };
  }

  #error(status: number, message: string): FakeResponse {
    return { status, body: { message, documentation_url: 'https://docs.github.com/rest' } };
  }

  // State --------------------------------------------------------------------------------------------------

  #tick(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  #issue(number: number): FakeIssue {
    const issue = this.#issues.get(number);
    if (issue === undefined) throw new Error(`fake GitHub has no #${number}`);
    return issue;
  }

  #pull(issue: FakeIssue): FakePull {
    if (issue.pull === null) throw new Error(`fake GitHub #${issue.number} is not a pull request`);
    return issue.pull;
  }

  #resolve(ref: string): string {
    for (const issue of this.#issues.values()) if (issue.pull?.head_ref === ref) return issue.pull.head_sha;
    return ref;
  }

  #newIssue(title: string, body: string, labels: string[], author: FakeUser, pull: FakePull | null): FakeIssue {
    const at = this.#tick();
    const issue: FakeIssue = {
      number: this.#nextNumber++,
      title,
      body,
      state: 'open',
      state_reason: null,
      labels,
      user: author,
      created_at: at,
      updated_at: at,
      closed_at: null,
      pull,
      comments: [],
      events: [],
      references: [],
    };
    this.#issues.set(issue.number, issue);
    return issue;
  }

  #addComment(issue: FakeIssue, author: FakeUser, body: string): FakeComment {
    const at = this.#tick();
    const comment = { id: this.#nextId++, user: author, body, created_at: at, updated_at: at };
    issue.comments.push(comment);
    return comment;
  }

  #addLabels(issue: FakeIssue, labels: readonly string[], actor: FakeUser): void {
    for (const label of labels) {
      if (issue.labels.some((existing) => existing.toLowerCase() === label.toLowerCase())) continue;
      issue.labels.push(label);
      issue.events.push({ id: this.#nextId++, event: 'labeled', actor, label: { name: label }, created_at: this.#tick() });
    }
  }

  #removeLabel(issue: FakeIssue, label: string, actor: FakeUser): void {
    const index = issue.labels.findIndex((existing) => existing.toLowerCase() === label.toLowerCase());
    if (index === -1) return;
    const [removed] = issue.labels.splice(index, 1);
    issue.events.push({ id: this.#nextId++, event: 'unlabeled', actor, label: { name: removed ?? label }, created_at: this.#tick() });
  }

  #setState(issue: FakeIssue, state: 'open' | 'closed', reason: string | null, actor: FakeUser): void {
    if (issue.state === state) return;
    const at = this.#tick();
    issue.state = state;
    issue.state_reason = state === 'open' ? 'reopened' : reason;
    issue.closed_at = state === 'closed' ? at : null;
    issue.updated_at = at;
    issue.events.push({ id: this.#nextId++, event: state === 'closed' ? 'closed' : 'reopened', actor, created_at: at });
  }

  #merge(issue: FakeIssue, actor: FakeUser): string {
    const pull = this.#pull(issue);
    if (pull.merge_commit_sha !== null) return pull.merge_commit_sha;
    const at = this.#tick();
    const sha = createHash('sha1').update(`merge:${issue.number}:${pull.head_sha}`).digest('hex');
    Object.assign(pull, { merged_at: at, merged_by: actor, merge_commit_sha: sha });
    Object.assign(issue, { state: 'closed', closed_at: at, updated_at: at });
    for (const target of this.#issues.values()) {
      if (target.references.includes(issue.number) && closesIssue(`${issue.title}\n${issue.body}`, this.repo, target.number)) {
        this.#setState(target, 'closed', 'completed', actor);
      }
    }
    return sha;
  }

  // JSON ---------------------------------------------------------------------------------------------------

  #repoUrl(): string {
    return `${this.#baseUrl}/repos/${this.repo.owner}/${this.repo.name}`;
  }

  #blobSha(content: string): string {
    return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
  }

  #labelJson(name: string): object {
    return { id: user(name).id, name, color: 'ededed', default: false };
  }

  #issueJson(issue: FakeIssue): object {
    const kind = issue.pull === null ? 'issues' : 'pull';
    return {
      id: 5_000_000 + issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body === '' ? null : issue.body,
      state: issue.state,
      state_reason: issue.state_reason,
      labels: issue.labels.map((name) => this.#labelJson(name)),
      user: issue.user,
      html_url: `https://github.com/${this.repo.owner}/${this.repo.name}/${kind}/${issue.number}`,
      repository_url: this.#repoUrl(),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      ...(issue.pull === null
        ? {}
        : { pull_request: { url: `${this.#repoUrl()}/pulls/${issue.number}`, merged_at: issue.pull.merged_at } }),
    };
  }

  #commentJson(issue: FakeIssue, comment: FakeComment): object {
    return {
      ...comment,
      author_association: comment.user.login === this.actor.login ? 'NONE' : 'MEMBER',
      html_url: `https://github.com/${this.repo.owner}/${this.repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    };
  }

  #pullJson(issue: FakeIssue): object {
    const pull = this.#pull(issue);
    const merged = pull.merged_at !== null;
    return {
      number: issue.number,
      html_url: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${issue.number}`,
      title: issue.title,
      body: issue.body === '' ? null : issue.body,
      state: issue.state,
      draft: pull.draft,
      user: issue.user,
      head: { sha: pull.head_sha, ref: pull.head_ref, repo: { full_name: `${this.repo.owner}/${this.repo.name}` } },
      base: { sha: pull.base_sha, ref: pull.base_ref, repo: { full_name: `${this.repo.owner}/${this.repo.name}` } },
      merged,
      mergeable: merged ? null : pull.mergeBlock === null,
      mergeable_state: merged ? 'unknown' : pull.mergeBlock === null ? 'clean' : 'blocked',
      merge_commit_sha: merged ? pull.merge_commit_sha : OPEN_PR_TEST_MERGE_SHA,
      merged_by: pull.merged_by,
      merged_at: pull.merged_at,
      closed_at: issue.closed_at,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      changed_files: pull.changed_files,
      additions: pull.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: pull.files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }
}
