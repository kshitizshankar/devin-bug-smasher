import { SettingsError, type GitHubRepo, type Settings } from '../config/settings.ts';
import { formatBugKey } from '../model/keys.ts';
import {
  hasLabel,
  isValidCommentKey,
  pullRequestRelation,
  readServiceMarker,
  truncateDescription,
  withServiceMarker,
} from './common.ts';
import {
  TrackerError,
  type Actor,
  type CheckRun,
  type CheckRuns,
  type CombinedStatus,
  type CommitStatus,
  type CommitStatusState,
  type IssueCloseReason,
  type IssueEvent,
  type IssueEventType,
  type LabelMove,
  type LinkedPullRequest,
  type MergeRequest,
  type MergeResult,
  type NewCommitStatus,
  type NewIssue,
  type PostCommentOptions,
  type PullRequestDiff,
  type PutFileInput,
  type PullRequestFile,
  type PullRequestFiles,
  type RateLimitInfo,
  type Branch,
  type Review,
  type ReviewState,
  type ReviewThread,
  type RepositoryAdmin,
  type RepositoryFile,
  type RepositoryLabel,
  type Tracker,
  type TrackerComment,
  type TrackerErrorCode,
  type TrackerIssue,
  type TrackerOperation,
  type TrackerPullRequest,
} from './types.ts';

/** REST API version sent in `X-GitHub-Api-Version`. */
export const GITHUB_API_VERSION = '2026-03-10';
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

export interface GitHubTrackerOptions {
  repo: GitHubRepo;
  token: string;
  /** API root, e.g. a local fixture server in tests. Pagination links to any other origin are refused. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout (default 30 s). */
  timeoutMs?: number;
  /** Items per page (default 100, GitHub's maximum). */
  perPage?: number;
  /** A listing needing more pages than this fails with `incomplete` rather than returning partial data. */
  maxPages?: number;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;

interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  accept?: string;
  /** Status-specific error codes for this endpoint (e.g. merge 405 → `not-mergeable`). */
  statusCodes?: Partial<Record<number, TrackerErrorCode>>;
  /** Returns the response instead of throwing for an expected non-success status. */
  tolerate?: (status: number, message: string) => boolean;
}

const EVENT_TYPES: ReadonlySet<string> = new Set<IssueEventType>(['labeled', 'unlabeled', 'closed', 'reopened']);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_MESSAGE_LENGTH = 300;
const DEFAULT_SECONDARY_RETRY_SECONDS = 60;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 1) { nodes { author { login __typename } body url createdAt originalCommit { oid } } }
        }
      }
    }
  }
}`;
const COMMIT_STATES: readonly CommitStatusState[] = ['error', 'failure', 'pending', 'success'];

/** Creates the live tracker from settings; requires `GITHUB_REPO` and `GITHUB_TOKEN`. */
export function githubTrackerFromSettings(
  settings: Settings,
  options: Omit<GitHubTrackerOptions, 'repo' | 'token'> = {},
): GitHubTracker {
  const problems: string[] = [];
  if (settings.github.repo === null) problems.push('GITHUB_REPO is required for the GitHub tracker (owner/name)');
  if (settings.github.token === null) problems.push('GITHUB_TOKEN is required for the GitHub tracker');
  if (settings.github.repo === null || settings.github.token === null) {
    throw new SettingsError(problems, 'Settings are incomplete for the GitHub tracker');
  }
  return new GitHubTracker({ ...options, repo: settings.github.repo, token: settings.github.token });
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (!seen.has(id)) seen.set(id, item);
  }
  return [...seen.values()];
}

function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match?.[1] && match[2]?.split(/\s+/).includes('next')) return match[1];
  }
  return null;
}

function intHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** GitHub REST implementation of `Tracker`. Uses only `fetch` from the Node standard library. */
export class GitHubTracker implements Tracker, RepositoryAdmin {
  readonly repo: GitHubRepo;
  readonly #token: string;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #perPage: number;
  readonly #maxPages: number;
  readonly #now: () => number;
  readonly #keyedPosts = new Map<string, Promise<unknown>>();

  constructor(options: GitHubTrackerOptions) {
    this.repo = { ...options.repo };
    this.#token = options.token;
    this.#baseUrl = new URL(`${(options.baseUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '')}/`);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#perPage = options.perPage ?? 100;
    this.#maxPages = options.maxPages ?? 50;
    this.#now = options.now ?? Date.now;
  }

  // Issues -------------------------------------------------------------------------------------------------

  async listOpenIssues(labels: readonly string[]): Promise<TrackerIssue[]> {
    const op = 'listOpenIssues';
    const wanted = uniqueBy(
      labels.map((label) => label.trim()),
      (label) => label.toLowerCase(),
    );
    for (const label of wanted) {
      if (label === '' || label.includes(',')) this.#invalidInput(op, `label ${JSON.stringify(label)} is not valid`);
    }
    const byNumber = new Map<number, TrackerIssue>();
    for (const label of wanted) {
      const { items } = await this.#paginate(op, this.#repoPath('issues'), {
        state: 'open',
        labels: label,
        sort: 'created',
        direction: 'asc',
      });
      for (const raw of items) {
        const item = this.#object(op, raw, 'issue');
        if (item.pull_request !== undefined) continue;
        const issue = this.#issue(op, item);
        if (!byNumber.has(issue.number)) byNumber.set(issue.number, issue);
      }
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  }

  async getIssue(number: number): Promise<TrackerIssue> {
    return this.#readIssue('getIssue', number);
  }

  async createIssue(input: NewIssue): Promise<TrackerIssue> {
    const op = 'createIssue';
    if (input.title.trim() === '') this.#invalidInput(op, 'title must not be empty');
    const response = await this.#send(op, 'POST', this.#repoPath('issues'), {
      body: { title: input.title, body: input.body, labels: [...(input.labels ?? [])] },
    });
    return this.#issue(op, this.#object(op, this.#json(op, response), 'issue'));
  }

  async listComments(issueNumber: number): Promise<TrackerComment[]> {
    return this.#comments('listComments', issueNumber);
  }

  async postComment(issueNumber: number, body: string, options: PostCommentOptions = {}): Promise<TrackerComment> {
    const op = 'postComment';
    this.#checkNumber(op, issueNumber);
    const key = options.key;
    if (key === undefined) return this.#createComment(issueNumber, body, undefined);
    if (!isValidCommentKey(key)) this.#invalidInput(op, 'comment key must match [A-Za-z0-9._:/-]{1,100}');
    // Keyed posts for the same issue and key run one at a time so the second finds the first's comment.
    const slot = `${issueNumber} ${key}`;
    const previous = this.#keyedPosts.get(slot) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const existing = (await this.#comments(op, issueNumber)).find((comment) => comment.serviceKey === key);
        return existing ?? this.#createComment(issueNumber, body, key);
      });
    this.#keyedPosts.set(slot, current);
    try {
      return await current;
    } finally {
      if (this.#keyedPosts.get(slot) === current) this.#keyedPosts.delete(slot);
    }
  }

  async #createComment(issueNumber: number, body: string, key: string | undefined): Promise<TrackerComment> {
    const op = 'postComment';
    const response = await this.#send(op, 'POST', this.#repoPath(`issues/${issueNumber}/comments`), {
      body: { body: withServiceMarker(body, key) },
    });
    return this.#comment(op, issueNumber, this.#object(op, this.#json(op, response), 'comment'));
  }

  async listIssueEvents(issueNumber: number): Promise<IssueEvent[]> {
    const op = 'listIssueEvents';
    this.#checkNumber(op, issueNumber);
    const { items } = await this.#paginate(op, this.#repoPath(`issues/${issueNumber}/events`));
    const events: IssueEvent[] = [];
    for (const raw of items) {
      const item = this.#object(op, raw, 'event');
      const type = this.#string(op, item, 'event');
      if (!EVENT_TYPES.has(type)) continue;
      const label = type === 'labeled' || type === 'unlabeled' ? this.#string(op, this.#object(op, item.label, 'event.label'), 'name') : null;
      events.push({
        id: String(this.#number(op, item, 'id')),
        type: type as IssueEventType,
        label,
        actor: this.#actor(op, item.actor),
        at: this.#string(op, item, 'created_at'),
        commitId: this.#optionalString(op, item, 'commit_id'),
      });
    }
    return uniqueBy(events, (event) => event.id);
  }

  async addLabels(issueNumber: number, labels: readonly string[]): Promise<string[]> {
    return this.#addLabels('addLabels', issueNumber, labels);
  }

  async removeLabel(issueNumber: number, label: string): Promise<string[]> {
    return this.#removeLabel('removeLabel', issueNumber, label);
  }

  async moveLabel(issueNumber: number, move: LabelMove): Promise<string[]> {
    const op = 'moveLabel';
    const afterAdd = await this.#addLabels(op, issueNumber, [move.to]);
    if (move.from.toLowerCase() === move.to.toLowerCase() || !hasLabel(afterAdd, move.from)) return afterAdd;
    return this.#removeLabel(op, issueNumber, move.from);
  }

  async closeIssue(issueNumber: number, options: { reason?: IssueCloseReason } = {}): Promise<TrackerIssue> {
    return this.#setIssueState('closeIssue', issueNumber, { state: 'closed', state_reason: options.reason ?? 'completed' });
  }

  async reopenIssue(issueNumber: number): Promise<TrackerIssue> {
    return this.#setIssueState('reopenIssue', issueNumber, { state: 'open' });
  }

  // Pull requests ------------------------------------------------------------------------------------------

  async findLinkedPullRequests(issueNumber: number): Promise<LinkedPullRequest[]> {
    const op = 'findLinkedPullRequests';
    this.#checkNumber(op, issueNumber);
    const { items } = await this.#paginate(op, this.#repoPath(`issues/${issueNumber}/timeline`));
    const numbers = new Set<number>();
    const repoSuffix = `/repos/${this.repo.owner}/${this.repo.name}`.toLowerCase();
    for (const raw of items) {
      const item = this.#object(op, raw, 'timeline event');
      if (item.event !== 'cross-referenced') continue;
      const source = this.#object(op, item.source, 'timeline source');
      if (source.issue === undefined || source.issue === null) continue;
      const referencing = this.#object(op, source.issue, 'timeline source issue');
      if (referencing.pull_request === undefined || referencing.pull_request === null) continue;
      const repositoryUrl = this.#string(op, referencing, 'repository_url').toLowerCase();
      if (!repositoryUrl.endsWith(repoSuffix)) continue;
      const number = this.#number(op, referencing, 'number');
      if (number !== issueNumber) numbers.add(number);
    }
    const linked: LinkedPullRequest[] = [];
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const pullRequest = await this.#readPullRequest(op, number);
      linked.push({ pullRequest, relation: pullRequestRelation(pullRequest, this.repo, issueNumber) });
    }
    return linked;
  }

  async getPullRequest(number: number): Promise<TrackerPullRequest> {
    return this.#readPullRequest('getPullRequest', number);
  }

  async listPullRequestFiles(number: number): Promise<PullRequestFiles> {
    const op = 'listPullRequestFiles';
    const pr = await this.#readPullRequest(op, number);
    const { items } = await this.#paginate(op, this.#repoPath(`pulls/${number}/files`));
    const files = uniqueBy(
      items.map((raw): PullRequestFile => {
        const item = this.#object(op, raw, 'file');
        return {
          filename: this.#string(op, item, 'filename'),
          previousFilename: this.#optionalString(op, item, 'previous_filename'),
          status: this.#string(op, item, 'status'),
          additions: this.#number(op, item, 'additions'),
          deletions: this.#number(op, item, 'deletions'),
          changes: this.#number(op, item, 'changes'),
          patch: this.#optionalString(op, item, 'patch'),
        };
      }),
      (file) => file.filename,
    );
    return { files, complete: files.length === pr.changedFiles, expectedCount: pr.changedFiles };
  }

  async getPullRequestDiff(number: number): Promise<PullRequestDiff> {
    const op = 'getPullRequestDiff';
    this.#checkNumber(op, number);
    let refused: string | null = null;
    const response = await this.#send(op, 'GET', this.#repoPath(`pulls/${number}`), {
      accept: 'application/vnd.github.diff',
      tolerate: (status, message) => {
        const tooLarge = status === 406 || (status === 422 && /diff/i.test(message));
        if (tooLarge) refused = message;
        return tooLarge;
      },
    });
    if (refused !== null) return { complete: false, reason: refused };
    return { complete: true, diff: response.text };
  }

  async listReviews(number: number): Promise<Review[]> {
    const op = 'listReviews';
    this.#checkNumber(op, number);
    const { items } = await this.#paginate(op, this.#repoPath(`pulls/${number}/reviews`));
    const reviews = items.map((raw): Review => {
      const item = this.#object(op, raw, 'review');
      return {
        id: String(this.#number(op, item, 'id')),
        reviewer: this.#actor(op, item.user),
        state: REVIEW_STATES[this.#string(op, item, 'state')] ?? 'commented',
        commitId: this.#optionalString(op, item, 'commit_id'),
        submittedAt: this.#optionalString(op, item, 'submitted_at'),
        body: this.#optionalString(op, item, 'body') ?? '',
      };
    });
    return uniqueBy(reviews, (review) => review.id);
  }

  async listReviewThreads(number: number): Promise<ReviewThread[]> {
    const op = 'listReviewThreads';
    this.#checkNumber(op, number);
    const threads: ReviewThread[] = [];
    let cursor: string | null = null;
    for (let pages = 0; ; pages += 1) {
      if (pages >= this.#maxPages) {
        throw new TrackerError({ code: 'incomplete', operation: op, message: `listing exceeded ${this.#maxPages} pages; refusing to return partial data` });
      }
      const response = await this.#send(op, 'POST', 'graphql', {
        body: { query: REVIEW_THREADS_QUERY, variables: { owner: this.repo.owner, name: this.repo.name, number, cursor } },
      });
      const json = this.#object(op, this.#json(op, response), 'GraphQL response');
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        const first = json.errors[0] as { message?: unknown; type?: unknown };
        const message = typeof first.message === 'string' ? this.#redact(first.message) : 'GraphQL error';
        throw new TrackerError({ code: first.type === 'NOT_FOUND' ? 'not-found' : 'invalid-response', operation: op, message });
      }
      const repository = this.#object(op, this.#object(op, json.data, 'data').repository, 'repository');
      if (repository.pullRequest === null) {
        throw new TrackerError({ code: 'not-found', operation: op, message: `PR #${number} was not found` });
      }
      const connection = this.#object(op, this.#object(op, repository.pullRequest, 'pullRequest').reviewThreads, 'reviewThreads');
      if (!Array.isArray(connection.nodes)) this.#badResponse(op, 'reviewThreads.nodes is not an array');
      for (const raw of connection.nodes) threads.push(this.#reviewThread(op, this.#object(op, raw, 'review thread')));
      const pageInfo = this.#object(op, connection.pageInfo, 'pageInfo');
      if (pageInfo.hasNextPage !== true) break;
      cursor = this.#string(op, pageInfo, 'endCursor');
    }
    return uniqueBy(threads, (thread) => thread.id);
  }

  async getBranch(name: string): Promise<Branch> {
    const op = 'getBranch';
    this.#checkRef(op, name);
    const response = await this.#send(op, 'GET', this.#repoPath(`branches/${encodeURIComponent(name)}`));
    const item = this.#object(op, this.#json(op, response), 'branch');
    const isProtected = item.protected === true;
    let classic: string[] | null = isProtected ? null : [];
    if (isProtected && item.protection !== undefined && item.protection !== null) {
      const protection = this.#object(op, item.protection, 'branch protection');
      classic = protection.enabled === false ? [] : this.#requiredContexts(op, protection.required_status_checks);
    }
    const rules = await this.#send(op, 'GET', this.#repoPath(`rules/branches/${encodeURIComponent(name)}`), {
      tolerate: (status) => status === 403 || status === 404,
    });
    let ruleset: string[] | null = null;
    if (rules.status < 300) {
      const list = this.#json(op, rules);
      if (!Array.isArray(list)) this.#badResponse(op, 'branch rules are not an array');
      ruleset = list.flatMap((raw) => {
        const rule = this.#object(op, raw, 'branch rule');
        if (rule.type !== 'required_status_checks') return [];
        const parameters = this.#object(op, rule.parameters, 'rule parameters');
        const checks = parameters.required_status_checks;
        if (!Array.isArray(checks)) this.#badResponse(op, 'required_status_checks is not an array');
        return checks.map((check) => this.#string(op, this.#object(op, check, 'required check'), 'context'));
      });
    }
    return {
      name: this.#string(op, item, 'name'),
      sha: this.#string(op, this.#object(op, item.commit, 'branch commit'), 'sha'),
      protected: isProtected || (ruleset?.length ?? 0) > 0,
      requiredChecks: classic === null || ruleset === null ? null : [...new Set([...classic, ...ruleset])],
    };
  }

  async getDefaultBranch(): Promise<Branch> {
    const op = 'getDefaultBranch';
    const response = await this.#send(op, 'GET', `repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}`);
    const name = this.#string(op, this.#object(op, this.#json(op, response), 'repository'), 'default_branch');
    return this.getBranch(name);
  }

  async listCheckRuns(ref: string): Promise<CheckRuns> {
    const op = 'listCheckRuns';
    this.#checkRef(op, ref);
    const { items, total } = await this.#paginate(
      op,
      this.#repoPath(`commits/${encodeURIComponent(ref)}/check-runs`),
      {},
      (page) => ({ items: page.check_runs, total: page.total_count }),
    );
    const runs = uniqueBy(
      items.map((raw): CheckRun => {
        const item = this.#object(op, raw, 'check run');
        const app = item.app === null || item.app === undefined ? null : this.#object(op, item.app, 'check run app');
        return {
          id: String(this.#number(op, item, 'id')),
          name: this.#string(op, item, 'name'),
          status: this.#string(op, item, 'status'),
          conclusion: this.#optionalString(op, item, 'conclusion'),
          app: app === null ? null : this.#optionalString(op, app, 'slug'),
          url: this.#optionalString(op, item, 'html_url'),
          startedAt: this.#optionalString(op, item, 'started_at'),
          completedAt: this.#optionalString(op, item, 'completed_at'),
        };
      }),
      (run) => run.id,
    );
    const totalCount = total ?? runs.length;
    return { runs, complete: runs.length === totalCount, totalCount };
  }

  async getCombinedStatus(ref: string): Promise<CombinedStatus> {
    const op = 'getCombinedStatus';
    this.#checkRef(op, ref);
    const { items, total, first } = await this.#paginate(
      op,
      this.#repoPath(`commits/${encodeURIComponent(ref)}/status`),
      {},
      (page) => ({ items: page.statuses, total: page.total_count }),
    );
    const statuses = uniqueBy(
      items.map((raw) => this.#commitStatus(op, raw)),
      (status) => status.id,
    );
    const totalCount = total ?? statuses.length;
    return {
      sha: this.#string(op, first, 'sha'),
      state: this.#commitState(op, this.#string(op, first, 'state')),
      statuses,
      complete: statuses.length === totalCount,
      totalCount,
    };
  }

  async createCommitStatus(sha: string, status: NewCommitStatus): Promise<CommitStatus> {
    const op = 'createCommitStatus';
    this.#checkSha(op, sha, 'sha');
    if (status.context.trim() === '') this.#invalidInput(op, 'context must not be empty');
    const response = await this.#send(op, 'POST', this.#repoPath(`statuses/${sha}`), {
      body: {
        state: status.state,
        context: status.context,
        description: status.description === undefined ? null : truncateDescription(status.description),
        target_url: status.targetUrl ?? null,
      },
    });
    return this.#commitStatus(op, this.#json(op, response));
  }

  async mergePullRequest(number: number, request: MergeRequest): Promise<MergeResult> {
    const op = 'mergePullRequest';
    this.#checkSha(op, request.expectedHeadSha, 'expectedHeadSha');
    const pr = await this.#readPullRequest(op, number);
    if (pr.headSha !== request.expectedHeadSha) {
      throw new TrackerError({
        code: 'head-mismatch',
        operation: op,
        message: `PR #${number} head is ${pr.headSha}, expected ${request.expectedHeadSha}; refusing to merge`,
      });
    }
    if (pr.state === 'merged' && pr.mergeCommitSha !== null) {
      return { mergeCommitSha: pr.mergeCommitSha, alreadyMerged: true };
    }
    if (pr.state !== 'open') {
      throw new TrackerError({ code: 'not-open', operation: op, message: `PR #${number} is ${pr.state}` });
    }
    const response = await this.#send(op, 'PUT', this.#repoPath(`pulls/${number}/merge`), {
      body: {
        sha: request.expectedHeadSha,
        ...(request.method === undefined ? {} : { merge_method: request.method }),
        ...(request.commitTitle === undefined ? {} : { commit_title: request.commitTitle }),
      },
      statusCodes: { 405: 'not-mergeable', 409: 'head-mismatch' },
    });
    const result = this.#object(op, this.#json(op, response), 'merge result');
    if (result.merged !== true) {
      throw new TrackerError({ code: 'not-mergeable', operation: op, message: `PR #${number} was not merged` });
    }
    return { mergeCommitSha: this.#string(op, result, 'sha'), alreadyMerged: false };
  }

  // Internals ----------------------------------------------------------------------------------------------

  #repoPath(path: string): string {
    return `repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}/${path}`;
  }

  // Repository administration (operator commands only) ---------------------------------------------------

  async listLabels(): Promise<RepositoryLabel[]> {
    const op = 'listLabels';
    const { items } = await this.#paginate(op, this.#repoPath('labels'));
    return items.map((raw) => this.#repositoryLabel(op, this.#object(op, raw, 'label')));
  }

  async createLabel(label: RepositoryLabel): Promise<RepositoryLabel> {
    const op = 'createLabel';
    this.#checkLabel(op, label);
    const response = await this.#send(op, 'POST', this.#repoPath('labels'), {
      body: { name: label.name, color: label.color, description: label.description },
    });
    return this.#repositoryLabel(op, this.#object(op, this.#json(op, response), 'label'));
  }

  async updateLabel(name: string, label: RepositoryLabel): Promise<RepositoryLabel> {
    const op = 'updateLabel';
    if (name.trim() === '') this.#invalidInput(op, 'label name must not be empty');
    this.#checkLabel(op, label);
    const response = await this.#send(op, 'PATCH', this.#repoPath(`labels/${encodeURIComponent(name)}`), {
      body: { new_name: label.name, color: label.color, description: label.description },
    });
    return this.#repositoryLabel(op, this.#object(op, this.#json(op, response), 'label'));
  }

  async getFile(path: string): Promise<RepositoryFile | null> {
    const op = 'getFile';
    let missing = false;
    const response = await this.#send(op, 'GET', this.#repoPath(`contents/${this.#filePath(op, path)}`), {
      tolerate: (status) => {
        missing = status === 404;
        return missing;
      },
    });
    if (missing) return null;
    const item = this.#object(op, this.#json(op, response), 'file');
    if (item.type !== 'file') this.#badResponse(op, `${path} is not a file`);
    if (item.encoding !== 'base64') this.#badResponse(op, `${path} content is not base64`);
    return {
      path: this.#string(op, item, 'path'),
      sha: this.#string(op, item, 'sha'),
      content: Buffer.from(this.#string(op, item, 'content'), 'base64').toString('utf8'),
    };
  }

  async putFile(path: string, input: PutFileInput): Promise<RepositoryFile> {
    const op = 'putFile';
    if (input.message.trim() === '') this.#invalidInput(op, 'commit message must not be empty');
    const response = await this.#send(op, 'PUT', this.#repoPath(`contents/${this.#filePath(op, path)}`), {
      body: {
        message: input.message,
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        ...(input.sha === null ? {} : { sha: input.sha }),
      },
      statusCodes: { 409: 'conflict' },
    });
    const content = this.#object(op, this.#object(op, this.#json(op, response), 'file update').content, 'content');
    return { path: this.#string(op, content, 'path'), sha: this.#string(op, content, 'sha'), content: input.content };
  }

  async listAllIssues(): Promise<TrackerIssue[]> {
    const op = 'listAllIssues';
    const { items } = await this.#paginate(op, this.#repoPath('issues'), { state: 'all', sort: 'created', direction: 'asc' });
    const byNumber = new Map<number, TrackerIssue>();
    for (const raw of items) {
      const item = this.#object(op, raw, 'issue');
      if (item.pull_request !== undefined) continue;
      const issue = this.#issue(op, item);
      byNumber.set(issue.number, issue);
    }
    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  }

  #repositoryLabel(op: TrackerOperation, item: JsonObject): RepositoryLabel {
    return {
      name: this.#string(op, item, 'name'),
      color: this.#string(op, item, 'color').toLowerCase(),
      description: this.#optionalString(op, item, 'description') ?? '',
    };
  }

  #checkLabel(op: TrackerOperation, label: RepositoryLabel): void {
    if (label.name.trim() === '' || label.name.length > 50) this.#invalidInput(op, 'label name must be 1-50 characters');
    if (!/^[0-9a-f]{6}$/.test(label.color)) this.#invalidInput(op, 'label color must be six lower-case hex digits');
    if (label.description.length > 100) this.#invalidInput(op, 'label description must be at most 100 characters');
  }

  #filePath(op: TrackerOperation, path: string): string {
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      this.#invalidInput(op, `file path ${JSON.stringify(path)} is not a relative repository path`);
    }
    return segments.map((segment) => encodeURIComponent(segment)).join('/');
  }

  async #readIssue(op: TrackerOperation, number: number): Promise<TrackerIssue> {
    this.#checkNumber(op, number);
    const response = await this.#send(op, 'GET', this.#repoPath(`issues/${number}`));
    return this.#issue(op, this.#object(op, this.#json(op, response), 'issue'));
  }

  async #setIssueState(op: TrackerOperation, number: number, body: JsonObject): Promise<TrackerIssue> {
    this.#checkNumber(op, number);
    const response = await this.#send(op, 'PATCH', this.#repoPath(`issues/${number}`), { body });
    return this.#issue(op, this.#object(op, this.#json(op, response), 'issue'));
  }

  async #comments(op: TrackerOperation, issueNumber: number): Promise<TrackerComment[]> {
    this.#checkNumber(op, issueNumber);
    const { items } = await this.#paginate(op, this.#repoPath(`issues/${issueNumber}/comments`));
    return uniqueBy(
      items.map((raw) => this.#comment(op, issueNumber, this.#object(op, raw, 'comment'))),
      (comment) => comment.id,
    );
  }

  async #addLabels(op: TrackerOperation, issueNumber: number, labels: readonly string[]): Promise<string[]> {
    this.#checkNumber(op, issueNumber);
    if (labels.length === 0 || labels.some((label) => label.trim() === '')) this.#invalidInput(op, 'labels must be non-empty');
    const response = await this.#send(op, 'POST', this.#repoPath(`issues/${issueNumber}/labels`), {
      body: { labels: [...labels] },
    });
    return this.#labels(op, this.#json(op, response));
  }

  async #removeLabel(op: TrackerOperation, issueNumber: number, label: string): Promise<string[]> {
    this.#checkNumber(op, issueNumber);
    let absent = false;
    const response = await this.#send(
      op,
      'DELETE',
      this.#repoPath(`issues/${issueNumber}/labels/${encodeURIComponent(label)}`),
      {
        tolerate: (status, message) => {
          absent = status === 404 && /label does not exist/i.test(message);
          return absent;
        },
      },
    );
    if (absent) return (await this.#readIssue(op, issueNumber)).labels;
    return this.#labels(op, this.#json(op, response));
  }

  async #readPullRequest(op: TrackerOperation, number: number): Promise<TrackerPullRequest> {
    this.#checkNumber(op, number);
    const response = await this.#send(op, 'GET', this.#repoPath(`pulls/${number}`));
    const item = this.#object(op, this.#json(op, response), 'pull request');
    const merged = item.merged === true || this.#optionalString(op, item, 'merged_at') !== null;
    if (merged && this.#optionalString(op, item, 'merge_commit_sha') === null) {
      // The pinned API version omits merge_commit_sha; the issue's "merged" event carries the merge commit.
      return this.#pullRequest(op, { ...item, merge_commit_sha: await this.#mergeEventCommit(op, number) });
    }
    return this.#pullRequest(op, item);
  }

  async #mergeEventCommit(op: TrackerOperation, number: number): Promise<string | null> {
    const { items } = await this.#paginate(op, this.#repoPath(`issues/${number}/events`));
    let commit: string | null = null;
    for (const raw of items) {
      const event = this.#object(op, raw, 'issue event');
      if (event.event === 'merged') commit = this.#optionalString(op, event, 'commit_id') ?? commit;
    }
    return commit;
  }

  async #paginate(
    op: TrackerOperation,
    path: string,
    query: Record<string, string> = {},
    extract: (page: JsonObject) => { items: unknown; total: unknown } = (page) => ({ items: page, total: undefined }),
  ): Promise<{ items: unknown[]; total: number | null; first: JsonObject }> {
    let url: string | null = this.#url(path, { ...query, per_page: String(this.#perPage) }).href;
    const items: unknown[] = [];
    let total: number | null = null;
    let first: JsonObject | null = null;
    let pages = 0;
    while (url !== null) {
      if (pages >= this.#maxPages) {
        throw new TrackerError({
          code: 'incomplete',
          operation: op,
          message: `listing exceeded ${this.#maxPages} pages; refusing to return partial data`,
        });
      }
      const response = await this.#send(op, 'GET', url);
      pages += 1;
      const json = this.#json(op, response);
      const page: JsonObject = Array.isArray(json) ? { items: json } : this.#object(op, json, 'page');
      first ??= page;
      const extracted = Array.isArray(json) ? { items: json, total: undefined } : extract(page);
      if (!Array.isArray(extracted.items)) this.#badResponse(op, 'page items are not an array');
      items.push(...extracted.items);
      if (extracted.total !== undefined) {
        if (typeof extracted.total !== 'number') this.#badResponse(op, 'total_count is not a number');
        total = extracted.total;
      }
      url = nextLink(response.headers.get('link'));
    }
    return { items, total, first: first ?? {} };
  }

  #url(path: string, query: Record<string, string> = {}): URL {
    const url = new URL(path, this.#baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  }

  async #send(
    op: TrackerOperation,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    pathOrUrl: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse> {
    let url: URL;
    if (/^https?:\/\//i.test(pathOrUrl)) {
      url = new URL(pathOrUrl);
      if (url.origin !== this.#baseUrl.origin) {
        this.#badResponse(op, `pagination link points to another origin (${url.origin}); refusing to follow it`);
      }
    } else {
      url = this.#url(pathOrUrl, options.query);
    }
    const headers: Record<string, string> = {
      accept: options.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${this.#token}`,
      'user-agent': 'bug-smasher',
      'x-github-api-version': GITHUB_API_VERSION,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let text: string;
    try {
      const signal = AbortSignal.timeout(this.#timeoutMs);
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      let target = url;
      for (let redirects = 0; ; redirects += 1) {
        response = await this.#fetch(target, { method, headers, body, redirect: 'manual', signal });
        const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
        if (location === null) break;
        await response.body?.cancel();
        const next = new URL(location, target);
        if (next.origin !== this.#baseUrl.origin) {
          this.#badResponse(op, `redirect to another origin (${next.origin}); refusing to follow it`);
        }
        if (redirects >= MAX_REDIRECTS) this.#badResponse(op, `more than ${MAX_REDIRECTS} redirects`);
        target = next;
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof TrackerError) throw error;
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
      const detail = error instanceof Error ? `${error.message}${cause}` : String(error);
      throw new TrackerError({
        code: timedOut ? 'timeout' : 'network',
        operation: op,
        message: timedOut
          ? `${method} ${url.pathname} timed out after ${this.#timeoutMs} ms`
          : `${method} ${url.pathname} failed: ${this.#redact(detail)}`,
        ambiguous: method !== 'GET',
      });
    }

    if (response.ok) return { status: response.status, headers: response.headers, text };
    const message = this.#providerMessage(text, response.status);
    if (options.tolerate?.(response.status, message) === true) {
      return { status: response.status, headers: response.headers, text };
    }
    throw this.#httpError(op, method, url, response, message, options.statusCodes ?? {});
  }

  #httpError(
    op: TrackerOperation,
    method: string,
    url: URL,
    response: Response,
    message: string,
    statusCodes: Partial<Record<number, TrackerErrorCode>>,
  ): TrackerError {
    const { status, headers } = response;
    const rateLimit = this.#rateLimit(headers);
    const retryAfter = intHeader(headers, 'retry-after');
    const rateLimited =
      status === 429 ||
      (status === 403 && (rateLimit?.remaining === 0 || retryAfter !== null || /rate limit/i.test(message)));
    let code: TrackerErrorCode;
    let retryAfterSeconds: number | null = null;
    if (rateLimited) {
      code = 'rate-limited';
      const resetAt = intHeader(headers, 'x-ratelimit-reset');
      if (retryAfter !== null) retryAfterSeconds = retryAfter;
      else if (rateLimit?.remaining === 0 && resetAt !== null) {
        retryAfterSeconds = Math.max(1, Math.ceil(resetAt - this.#now() / 1000));
      } else retryAfterSeconds = DEFAULT_SECONDARY_RETRY_SECONDS;
    } else {
      code =
        statusCodes[status] ??
        (status === 401
          ? 'unauthorized'
          : status === 403
            ? 'forbidden'
            : status === 404
              ? 'not-found'
              : status === 409
                ? 'conflict'
                : status >= 500
                  ? 'server-error'
                  : 'validation');
    }
    return new TrackerError({
      code,
      operation: op,
      status,
      message: `GitHub ${status} for ${method} ${url.pathname}: ${message}`,
      retryAfterSeconds,
      rateLimit,
      requestId: headers.get('x-github-request-id'),
      ambiguous: method !== 'GET' && status >= 500,
    });
  }

  #rateLimit(headers: Headers): RateLimitInfo | null {
    const limit = intHeader(headers, 'x-ratelimit-limit');
    const remaining = intHeader(headers, 'x-ratelimit-remaining');
    const reset = intHeader(headers, 'x-ratelimit-reset');
    const resource = headers.get('x-ratelimit-resource');
    if (limit === null && remaining === null && reset === null) return null;
    return { limit, remaining, resetAt: reset === null ? null : new Date(reset * 1000).toISOString(), resource };
  }

  #providerMessage(text: string, status: number): string {
    let message = `HTTP ${status}`;
    try {
      const body: unknown = JSON.parse(text);
      if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const record = body as JsonObject;
        const parts: string[] = [];
        if (typeof record.message === 'string') parts.push(record.message);
        if (Array.isArray(record.errors)) {
          for (const entry of record.errors) {
            if (typeof entry === 'string') parts.push(entry);
            else if (typeof entry === 'object' && entry !== null && typeof (entry as JsonObject).message === 'string') {
              parts.push((entry as JsonObject).message as string);
            }
          }
        }
        if (parts.length > 0) message = parts.join('; ');
      }
    } catch {
      if (text.trim() !== '') message = text.trim();
    }
    const safe = this.#redact(message);
    return safe.length > MAX_MESSAGE_LENGTH ? `${safe.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : safe;
  }

  #redact(text: string): string {
    let safe = text;
    if (this.#token.length > 0) safe = safe.split(this.#token).join('[redacted]');
    return safe
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[redacted]')
      .replace(/\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  }

  #json(op: TrackerOperation, response: HttpResponse): unknown {
    try {
      return JSON.parse(response.text);
    } catch {
      return this.#badResponse(op, `HTTP ${response.status} body is not JSON`);
    }
  }

  #badResponse(op: TrackerOperation, message: string): never {
    throw new TrackerError({ code: 'invalid-response', operation: op, message: `unexpected GitHub response: ${message}` });
  }

  #invalidInput(op: TrackerOperation, message: string): never {
    throw new TrackerError({ code: 'validation', operation: op, message });
  }

  #checkNumber(op: TrackerOperation, number: number): void {
    if (!Number.isSafeInteger(number) || number < 1) this.#invalidInput(op, `${number} is not an issue or PR number`);
  }

  #checkSha(op: TrackerOperation, sha: string, name: string): void {
    if (!SHA_PATTERN.test(sha)) this.#invalidInput(op, `${name} must be a full lowercase commit SHA`);
  }

  #checkRef(op: TrackerOperation, ref: string): void {
    if (ref.trim() === '') this.#invalidInput(op, 'ref must not be empty');
  }

  #object(op: TrackerOperation, value: unknown, what: string): JsonObject {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.#badResponse(op, `${what} is not an object`);
    return value as JsonObject;
  }

  #string(op: TrackerOperation, item: JsonObject, key: string): string {
    const value = item[key];
    if (typeof value !== 'string') this.#badResponse(op, `${key} is not a string`);
    return value;
  }

  #optionalString(op: TrackerOperation, item: JsonObject, key: string): string | null {
    const value = item[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') this.#badResponse(op, `${key} is not a string`);
    return value;
  }

  #number(op: TrackerOperation, item: JsonObject, key: string): number {
    const value = item[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) this.#badResponse(op, `${key} is not a number`);
    return value;
  }

  #actor(op: TrackerOperation, value: unknown): Actor | null {
    if (value === null || value === undefined) return null;
    const user = this.#object(op, value, 'user');
    const type = typeof user.type === 'string' ? user.type.toLowerCase() : '';
    return {
      login: this.#string(op, user, 'login'),
      type: type === 'user' || type === 'bot' || type === 'organization' ? type : 'unknown',
    };
  }

  #labels(op: TrackerOperation, value: unknown): string[] {
    if (!Array.isArray(value)) this.#badResponse(op, 'labels are not an array');
    return value.map((label) =>
      typeof label === 'string' ? label : this.#string(op, this.#object(op, label, 'label'), 'name'),
    );
  }

  #issue(op: TrackerOperation, item: JsonObject): TrackerIssue {
    const number = this.#number(op, item, 'number');
    if (item.pull_request !== undefined && item.pull_request !== null) {
      throw new TrackerError({ code: 'not-an-issue', operation: op, message: `#${number} is a pull request, not an issue` });
    }
    const state = this.#string(op, item, 'state');
    if (state !== 'open' && state !== 'closed') this.#badResponse(op, `issue state ${JSON.stringify(state)}`);
    return {
      number,
      key: formatBugKey({ owner: this.repo.owner, repo: this.repo.name, number }),
      title: this.#string(op, item, 'title'),
      body: this.#optionalString(op, item, 'body') ?? '',
      state,
      stateReason: this.#optionalString(op, item, 'state_reason'),
      labels: this.#labels(op, item.labels),
      author: this.#actor(op, item.user),
      url: this.#string(op, item, 'html_url'),
      createdAt: this.#string(op, item, 'created_at'),
      updatedAt: this.#string(op, item, 'updated_at'),
      closedAt: this.#optionalString(op, item, 'closed_at'),
    };
  }

  #comment(op: TrackerOperation, issueNumber: number, item: JsonObject): TrackerComment {
    const body = this.#optionalString(op, item, 'body') ?? '';
    return {
      id: String(this.#number(op, item, 'id')),
      issueNumber,
      author: this.#actor(op, item.user),
      authorAssociation: this.#optionalString(op, item, 'author_association'),
      body,
      url: this.#string(op, item, 'html_url'),
      createdAt: this.#string(op, item, 'created_at'),
      updatedAt: this.#string(op, item, 'updated_at'),
      ...readServiceMarker(body),
    };
  }

  #pullRequest(op: TrackerOperation, item: JsonObject): TrackerPullRequest {
    const head = this.#object(op, item.head, 'head');
    const base = this.#object(op, item.base, 'base');
    const headRepo = head.repo === null || head.repo === undefined ? null : this.#object(op, head.repo, 'head.repo');
    const mergedAt = this.#optionalString(op, item, 'merged_at');
    const merged = item.merged === true || mergedAt !== null;
    const rawState = this.#string(op, item, 'state');
    if (rawState !== 'open' && rawState !== 'closed') this.#badResponse(op, `pull request state ${JSON.stringify(rawState)}`);
    const mergeCommitSha = merged ? this.#optionalString(op, item, 'merge_commit_sha') : null;
    if (merged && mergeCommitSha === null) this.#badResponse(op, 'merged pull request has no merge_commit_sha');
    return {
      number: this.#number(op, item, 'number'),
      url: this.#string(op, item, 'html_url'),
      title: this.#string(op, item, 'title'),
      body: this.#optionalString(op, item, 'body') ?? '',
      state: merged ? 'merged' : rawState,
      draft: item.draft === true,
      author: this.#actor(op, item.user),
      headSha: this.#string(op, head, 'sha'),
      headRef: this.#string(op, head, 'ref'),
      headRepo: headRepo === null ? null : this.#string(op, headRepo, 'full_name'),
      baseSha: this.#string(op, base, 'sha'),
      baseRef: this.#string(op, base, 'ref'),
      mergeable: typeof item.mergeable === 'boolean' ? item.mergeable : null,
      mergeableState: this.#optionalString(op, item, 'mergeable_state'),
      mergeCommitSha,
      mergedBy: this.#actor(op, item.merged_by),
      mergedAt,
      closedAt: this.#optionalString(op, item, 'closed_at'),
      createdAt: this.#string(op, item, 'created_at'),
      updatedAt: this.#string(op, item, 'updated_at'),
      changedFiles: this.#number(op, item, 'changed_files'),
      additions: this.#number(op, item, 'additions'),
      deletions: this.#number(op, item, 'deletions'),
    };
  }

  #requiredContexts(op: TrackerOperation, value: unknown): string[] {
    if (value === undefined || value === null) return [];
    const checks = this.#object(op, value, 'required status checks');
    const contexts = Array.isArray(checks.contexts) ? checks.contexts.map(String) : [];
    const named = Array.isArray(checks.checks)
      ? checks.checks.map((check) => this.#string(op, this.#object(op, check, 'required check'), 'context'))
      : [];
    return [...new Set([...contexts, ...named])];
  }

  #reviewThread(op: TrackerOperation, item: JsonObject): ReviewThread {
    const comments = this.#object(op, item.comments, 'thread comments');
    if (!Array.isArray(comments.nodes)) this.#badResponse(op, 'thread comments are not an array');
    const parsed = comments.nodes.map((raw) => {
      const comment = this.#object(op, raw, 'thread comment');
      const author = comment.author === null || comment.author === undefined ? null : this.#object(op, comment.author, 'author');
      const login = author === null ? 'ghost' : this.#string(op, author, 'login');
      const bot = author?.__typename === 'Bot' && !login.endsWith('[bot]');
      const commit = comment.originalCommit === null || comment.originalCommit === undefined
        ? null
        : this.#optionalString(op, this.#object(op, comment.originalCommit, 'originalCommit'), 'oid');
      return {
        authorLogin: bot ? `${login}[bot]` : login,
        body: this.#optionalString(op, comment, 'body') ?? '',
        url: this.#optionalString(op, comment, 'url') ?? '',
        createdAt: this.#string(op, comment, 'createdAt'),
        commit,
      };
    });
    const line = item.line;
    return {
      id: this.#string(op, item, 'id'),
      isResolved: item.isResolved === true,
      isOutdated: item.isOutdated === true,
      path: this.#optionalString(op, item, 'path'),
      line: typeof line === 'number' ? line : null,
      commitSha: parsed[0]?.commit ?? null,
      comments: parsed.map(({ commit: _commit, ...comment }) => comment),
    };
  }

  #commitState(op: TrackerOperation, state: string): CommitStatusState {
    const match = COMMIT_STATES.find((candidate) => candidate === state);
    if (match === undefined) this.#badResponse(op, `commit status state ${JSON.stringify(state)}`);
    return match;
  }

  #commitStatus(op: TrackerOperation, raw: unknown): CommitStatus {
    const item = this.#object(op, raw, 'commit status');
    return {
      id: String(this.#number(op, item, 'id')),
      context: this.#string(op, item, 'context'),
      state: this.#commitState(op, this.#string(op, item, 'state')),
      description: this.#optionalString(op, item, 'description'),
      targetUrl: this.#optionalString(op, item, 'target_url'),
      creator: this.#actor(op, item.creator),
      createdAt: this.#string(op, item, 'created_at'),
      updatedAt: this.#string(op, item, 'updated_at'),
    };
  }
}
