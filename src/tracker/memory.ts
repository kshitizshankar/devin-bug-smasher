import { createHash } from 'node:crypto';
import type { GitHubRepo } from '../config/settings.ts';
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
  type PullRequestFile,
  type PullRequestFiles,
  type Review,
  type ReviewState,
  type Tracker,
  type TrackerComment,
  type TrackerErrorCode,
  type TrackerIssue,
  type TrackerOperation,
  type TrackerPullRequest,
} from './types.ts';

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Provider calls a failure can be injected into. `moveLabel` fails through `addLabels` or `removeLabel`. */
export type FailurePoint = Exclude<TrackerOperation, 'moveLabel'>;

const WRITE_POINTS: ReadonlySet<FailurePoint> = new Set([
  'createIssue',
  'postComment',
  'addLabels',
  'removeLabel',
  'closeIssue',
  'reopenIssue',
  'createCommitStatus',
  'mergePullRequest',
]);

export interface SimulatedFailure {
  code: TrackerErrorCode;
  message?: string;
  status?: number;
  retryAfterSeconds?: number;
  /** Defaults to true for applied failures and for `server-error` on writes, as with GitHub 5xx responses. */
  ambiguous?: boolean;
  /** The write takes effect before the failure is reported (a lost response). Only meaningful for writes. */
  applied?: boolean;
}

export interface SeedIssue {
  title: string;
  body?: string;
  labels?: readonly string[];
  state?: 'open' | 'closed';
  author?: string;
}

export interface SeedPullRequest {
  title: string;
  body?: string;
  headSha: string;
  baseSha?: string;
  headRef?: string;
  baseRef?: string;
  author?: string;
  draft?: boolean;
  files?: readonly PullRequestFile[];
  /** Number of changed files the provider reports; defaults to `files.length`. More means truncated. */
  changedFiles?: number;
  /** `null` simulates a diff GitHub refuses to render because it is too large. */
  diff?: string | null;
  /** Issues whose timeline shows a cross-reference from this PR. */
  references?: readonly number[];
  /** Labels on the PR itself. GitHub lists labelled PRs among issues; trackers must filter them out. */
  labels?: readonly string[];
}

export interface InMemoryTrackerOptions {
  repo?: GitHubRepo;
  /** Actor recorded for changes made through the tracker (the service's own identity). */
  actor?: Actor;
  now?: () => string;
}

interface IssueEntry {
  issue: TrackerIssue;
  comments: TrackerComment[];
  events: IssueEvent[];
  references: number[];
}

interface PullRequestEntry {
  pr: TrackerPullRequest;
  files: PullRequestFile[];
  diff: string | null;
  reviews: Review[];
  mergeBlock: string | null;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function user(login: string): Actor {
  return { login, type: login.endsWith('[bot]') ? 'bot' : 'user' };
}

/**
 * Offline stand-in for `GitHubTracker` with the same contract and failure behaviour. Besides the `Tracker`
 * methods it offers a simulation API (`seed*`, `external*`, `pushHead`, `blockMerge`, `failNext`, ...) so
 * orchestrator tests can model people and GitHub acting outside the service.
 */
export class InMemoryTracker implements Tracker {
  readonly repo: GitHubRepo;
  readonly actor: Actor;
  readonly #now: () => string;
  readonly #issues = new Map<number, IssueEntry>();
  readonly #pulls = new Map<number, PullRequestEntry>();
  readonly #statuses = new Map<string, CommitStatus[]>();
  readonly #checkRuns = new Map<string, CheckRun[]>();
  readonly #failures = new Map<FailurePoint, SimulatedFailure[]>();
  #applied: TrackerError | null = null;
  #nextNumber = 1;
  #nextId = 1000;

  constructor(options: InMemoryTrackerOptions = {}) {
    this.repo = { ...(options.repo ?? { owner: 'acme', name: 'widgets' }) };
    this.actor = { ...(options.actor ?? { login: 'bug-smasher[bot]', type: 'bot' }) };
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  // Simulation API -----------------------------------------------------------------------------------------

  /** The next call that reaches `operation` throws this failure instead of acting. Queued per operation. */
  failNext(operation: FailurePoint, failure: SimulatedFailure | TrackerErrorCode): void {
    const queue = this.#failures.get(operation) ?? [];
    queue.push(typeof failure === 'string' ? { code: failure } : failure);
    this.#failures.set(operation, queue);
  }

  seedIssue(seed: SeedIssue): TrackerIssue {
    const number = this.#nextNumber++;
    const at = this.#now();
    const closed = seed.state === 'closed';
    const issue: TrackerIssue = {
      number,
      key: formatBugKey({ owner: this.repo.owner, repo: this.repo.name, number }),
      title: seed.title,
      body: seed.body ?? '',
      state: closed ? 'closed' : 'open',
      stateReason: closed ? 'completed' : null,
      labels: [...(seed.labels ?? [])],
      author: user(seed.author ?? 'reporter'),
      url: `https://github.com/${this.repo.owner}/${this.repo.name}/issues/${number}`,
      createdAt: at,
      updatedAt: at,
      closedAt: closed ? at : null,
    };
    this.#issues.set(number, { issue, comments: [], events: [], references: [] });
    return copy(issue);
  }

  seedPullRequest(seed: SeedPullRequest): TrackerPullRequest {
    const number = this.#nextNumber++;
    const at = this.#now();
    const files = [...(seed.files ?? [])];
    const pr: TrackerPullRequest = {
      number,
      url: `https://github.com/${this.repo.owner}/${this.repo.name}/pull/${number}`,
      title: seed.title,
      body: seed.body ?? '',
      state: 'open',
      draft: seed.draft ?? false,
      author: user(seed.author ?? 'devin-ai-integration[bot]'),
      headSha: seed.headSha,
      headRef: seed.headRef ?? `fix-${number}`,
      headRepo: `${this.repo.owner}/${this.repo.name}`,
      baseSha: seed.baseSha ?? '0'.repeat(40),
      baseRef: seed.baseRef ?? 'main',
      mergeable: true,
      mergeableState: 'clean',
      mergeCommitSha: null,
      mergedBy: null,
      mergedAt: null,
      closedAt: null,
      createdAt: at,
      updatedAt: at,
      changedFiles: seed.changedFiles ?? files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
    this.#pulls.set(number, {
      pr,
      files,
      diff: seed.diff === undefined ? '' : seed.diff,
      reviews: [],
      mergeBlock: null,
    });
    for (const issueNumber of seed.references ?? []) this.#issueEntry('findLinkedPullRequests', issueNumber).references.push(number);
    return copy(pr);
  }

  externalComment(issueNumber: number, login: string, body: string): TrackerComment {
    return copy(this.#addComment(this.#issueEntry('postComment', issueNumber), user(login), body));
  }

  externalLabel(issueNumber: number, label: string, action: 'add' | 'remove', login: string): void {
    const entry = this.#issueEntry('addLabels', issueNumber);
    if (action === 'add') this.#applyAddLabels(entry, [label], user(login));
    else this.#applyRemoveLabel(entry, label, user(login));
  }

  externalCloseIssue(issueNumber: number, login: string): void {
    this.#applyIssueState(this.#issueEntry('closeIssue', issueNumber), 'closed', 'completed', user(login));
  }

  externalReopenIssue(issueNumber: number, login: string): void {
    this.#applyIssueState(this.#issueEntry('reopenIssue', issueNumber), 'open', null, user(login));
  }

  /**
   * A person merges the PR on GitHub; issues it closes are closed as GitHub would. `mergeCommitSha` sets the
   * resulting commit (for example a real commit in a fixture repository); otherwise one is derived.
   */
  externalMerge(prNumber: number, login: string, mergeCommitSha?: string): string {
    return this.#applyMerge(this.#pullEntry('mergePullRequest', prNumber), user(login), mergeCommitSha);
  }

  externalClosePullRequest(prNumber: number): void {
    const entry = this.#pullEntry('getPullRequest', prNumber);
    if (entry.pr.state !== 'open') return;
    entry.pr.state = 'closed';
    entry.pr.closedAt = this.#now();
    entry.pr.updatedAt = entry.pr.closedAt;
  }

  pushHead(prNumber: number, headSha: string): void {
    const entry = this.#pullEntry('getPullRequest', prNumber);
    entry.pr.headSha = headSha;
    entry.pr.updatedAt = this.#now();
  }

  /** Simulates branch protection or a conflict refusing the merge (`null` clears it). */
  blockMerge(prNumber: number, reason: string | null): void {
    const entry = this.#pullEntry('mergePullRequest', prNumber);
    entry.mergeBlock = reason;
    entry.pr.mergeableState = reason === null ? 'clean' : 'blocked';
  }

  addReview(prNumber: number, review: { reviewer: string; state: ReviewState; commitId?: string; body?: string }): Review {
    const entry = this.#pullEntry('listReviews', prNumber);
    const added: Review = {
      id: String(this.#nextId++),
      reviewer: user(review.reviewer),
      state: review.state,
      commitId: review.commitId ?? entry.pr.headSha,
      submittedAt: review.state === 'pending' ? null : this.#now(),
      body: review.body ?? '',
    };
    entry.reviews.push(added);
    return copy(added);
  }

  addCheckRun(sha: string, run: { name: string; status: string; conclusion: string | null; app?: string }): CheckRun {
    const added: CheckRun = {
      id: String(this.#nextId++),
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      app: run.app ?? 'github-actions',
      url: null,
      startedAt: this.#now(),
      completedAt: run.status === 'completed' ? this.#now() : null,
    };
    this.#checkRuns.set(sha, [...(this.#checkRuns.get(sha) ?? []), added]);
    return copy(added);
  }

  // Tracker ------------------------------------------------------------------------------------------------

  async listOpenIssues(labels: readonly string[]): Promise<TrackerIssue[]> {
    const op = 'listOpenIssues';
    for (const label of labels) {
      if (label.trim() === '' || label.includes(',')) this.#invalid(op, `label ${JSON.stringify(label)} is not valid`);
    }
    this.#maybeFail(op);
    return [...this.#issues.values()]
      .map((entry) => entry.issue)
      .filter((issue) => issue.state === 'open' && labels.some((label) => hasLabel(issue.labels, label.trim())))
      .sort((a, b) => a.number - b.number)
      .map(copy);
  }

  async getIssue(number: number): Promise<TrackerIssue> {
    this.#maybeFail('getIssue');
    return copy(this.#issueEntry('getIssue', number).issue);
  }

  async createIssue(input: NewIssue): Promise<TrackerIssue> {
    const op = 'createIssue';
    if (input.title.trim() === '') this.#invalid(op, 'title must not be empty');
    this.#maybeFail(op);
    const issue = this.seedIssue({ title: input.title, body: input.body, author: this.actor.login });
    const entry = this.#issueEntry(op, issue.number);
    entry.issue.author = { ...this.actor };
    if (input.labels !== undefined && input.labels.length > 0) this.#applyAddLabels(entry, input.labels, this.actor, false);
    this.#settle();
    return copy(entry.issue);
  }

  async listComments(issueNumber: number): Promise<TrackerComment[]> {
    this.#maybeFail('listComments');
    return copy(this.#issueEntry('listComments', issueNumber).comments);
  }

  async postComment(issueNumber: number, body: string, options: PostCommentOptions = {}): Promise<TrackerComment> {
    const op = 'postComment';
    this.#checkNumber(op, issueNumber);
    if (options.key !== undefined && !isValidCommentKey(options.key)) {
      this.#invalid(op, 'comment key must match [A-Za-z0-9._:/-]{1,100}');
    }
    const entry = this.#issueEntry(op, issueNumber);
    if (options.key !== undefined) {
      const existing = entry.comments.find((comment) => comment.serviceKey === options.key);
      if (existing !== undefined) return copy(existing);
    }
    this.#maybeFail(op);
    const comment = this.#addComment(entry, this.actor, withServiceMarker(body, options.key));
    this.#settle();
    return copy(comment);
  }

  async listIssueEvents(issueNumber: number): Promise<IssueEvent[]> {
    this.#maybeFail('listIssueEvents');
    return copy(this.#issueEntry('listIssueEvents', issueNumber).events);
  }

  async addLabels(issueNumber: number, labels: readonly string[]): Promise<string[]> {
    return this.#addLabels('addLabels', issueNumber, labels);
  }

  async removeLabel(issueNumber: number, label: string): Promise<string[]> {
    return this.#removeLabel('removeLabel', issueNumber, label);
  }

  async moveLabel(issueNumber: number, move: LabelMove): Promise<string[]> {
    const afterAdd = await this.#addLabels('moveLabel', issueNumber, [move.to]);
    if (move.from.toLowerCase() === move.to.toLowerCase() || !hasLabel(afterAdd, move.from)) return afterAdd;
    return this.#removeLabel('moveLabel', issueNumber, move.from);
  }

  async closeIssue(issueNumber: number, options: { reason?: IssueCloseReason } = {}): Promise<TrackerIssue> {
    const op = 'closeIssue';
    const entry = this.#issueEntry(op, issueNumber);
    this.#maybeFail(op);
    this.#applyIssueState(entry, 'closed', options.reason ?? 'completed', this.actor);
    this.#settle();
    return copy(entry.issue);
  }

  async reopenIssue(issueNumber: number): Promise<TrackerIssue> {
    const op = 'reopenIssue';
    const entry = this.#issueEntry(op, issueNumber);
    this.#maybeFail(op);
    this.#applyIssueState(entry, 'open', null, this.actor);
    this.#settle();
    return copy(entry.issue);
  }

  async findLinkedPullRequests(issueNumber: number): Promise<LinkedPullRequest[]> {
    const op = 'findLinkedPullRequests';
    const entry = this.#issueEntry(op, issueNumber);
    this.#maybeFail(op);
    return [...new Set(entry.references)]
      .sort((a, b) => a - b)
      .map((number) => {
        const pr = this.#pullEntry(op, number).pr;
        return { pullRequest: copy(pr), relation: pullRequestRelation(pr, this.repo, issueNumber) };
      });
  }

  async getPullRequest(number: number): Promise<TrackerPullRequest> {
    this.#maybeFail('getPullRequest');
    return copy(this.#pullEntry('getPullRequest', number).pr);
  }

  async listPullRequestFiles(number: number): Promise<PullRequestFiles> {
    const op = 'listPullRequestFiles';
    const entry = this.#pullEntry(op, number);
    this.#maybeFail(op);
    return {
      files: copy(entry.files),
      complete: entry.files.length === entry.pr.changedFiles,
      expectedCount: entry.pr.changedFiles,
    };
  }

  async getPullRequestDiff(number: number): Promise<PullRequestDiff> {
    const op = 'getPullRequestDiff';
    const entry = this.#pullEntry(op, number);
    this.#maybeFail(op);
    if (entry.diff === null) return { complete: false, reason: 'The diff is too large to render' };
    return { complete: true, diff: entry.diff };
  }

  async listReviews(number: number): Promise<Review[]> {
    const op = 'listReviews';
    const entry = this.#pullEntry(op, number);
    this.#maybeFail(op);
    return copy(entry.reviews);
  }

  async listCheckRuns(ref: string): Promise<CheckRuns> {
    const op = 'listCheckRuns';
    if (ref.trim() === '') this.#invalid(op, 'ref must not be empty');
    this.#maybeFail(op);
    const runs = copy(this.#checkRuns.get(this.#resolveRef(ref)) ?? []);
    return { runs, complete: true, totalCount: runs.length };
  }

  async getCombinedStatus(ref: string): Promise<CombinedStatus> {
    const op = 'getCombinedStatus';
    if (ref.trim() === '') this.#invalid(op, 'ref must not be empty');
    this.#maybeFail(op);
    const sha = this.#resolveRef(ref);
    const latest = new Map<string, CommitStatus>();
    for (const status of [...(this.#statuses.get(sha) ?? [])].reverse()) {
      if (!latest.has(status.context)) latest.set(status.context, status);
    }
    const statuses = [...latest.values()];
    const states = statuses.map((status) => status.state);
    const state: CombinedStatus['state'] = states.some((s) => s === 'error' || s === 'failure')
      ? 'failure'
      : states.length === 0 || states.includes('pending')
        ? 'pending'
        : 'success';
    return { sha, state, statuses: copy(statuses), complete: true, totalCount: statuses.length };
  }

  async createCommitStatus(sha: string, status: NewCommitStatus): Promise<CommitStatus> {
    const op = 'createCommitStatus';
    if (!SHA_PATTERN.test(sha)) this.#invalid(op, 'sha must be a full lowercase commit SHA');
    if (status.context.trim() === '') this.#invalid(op, 'context must not be empty');
    this.#maybeFail(op);
    const at = this.#now();
    const created: CommitStatus = {
      id: String(this.#nextId++),
      context: status.context,
      state: status.state,
      description: status.description === undefined ? null : truncateDescription(status.description),
      targetUrl: status.targetUrl ?? null,
      creator: { ...this.actor },
      createdAt: at,
      updatedAt: at,
    };
    this.#statuses.set(sha, [...(this.#statuses.get(sha) ?? []), created]);
    this.#settle();
    return copy(created);
  }

  async mergePullRequest(number: number, request: MergeRequest): Promise<MergeResult> {
    const op = 'mergePullRequest';
    if (!SHA_PATTERN.test(request.expectedHeadSha)) this.#invalid(op, 'expectedHeadSha must be a full lowercase commit SHA');
    const entry = this.#pullEntry(op, number);
    const pr = entry.pr;
    if (pr.headSha !== request.expectedHeadSha) {
      throw new TrackerError({
        code: 'head-mismatch',
        operation: op,
        message: `PR #${number} head is ${pr.headSha}, expected ${request.expectedHeadSha}; refusing to merge`,
      });
    }
    if (pr.state === 'merged' && pr.mergeCommitSha !== null) return { mergeCommitSha: pr.mergeCommitSha, alreadyMerged: true };
    if (pr.state !== 'open') throw new TrackerError({ code: 'not-open', operation: op, message: `PR #${number} is ${pr.state}` });
    this.#maybeFail(op);
    if (entry.mergeBlock !== null) {
      throw new TrackerError({ code: 'not-mergeable', operation: op, status: 405, message: entry.mergeBlock });
    }
    const mergeCommitSha = this.#applyMerge(entry, this.actor);
    this.#settle();
    return { mergeCommitSha, alreadyMerged: false };
  }

  // Internals ----------------------------------------------------------------------------------------------

  #maybeFail(point: FailurePoint, reportAs: TrackerOperation = point): void {
    this.#applied = null;
    const failure = this.#failures.get(point)?.shift();
    if (failure === undefined) return;
    const write = WRITE_POINTS.has(point);
    const applied = write && failure.applied === true;
    const error = new TrackerError({
      code: failure.code,
      operation: reportAs,
      message: failure.message ?? `simulated ${failure.code}`,
      status: failure.status ?? null,
      retryAfterSeconds: failure.retryAfterSeconds ?? (failure.code === 'rate-limited' ? 60 : null),
      ambiguous: failure.ambiguous ?? (applied || (write && failure.code === 'server-error')),
    });
    if (!applied) throw error;
    this.#applied = error;
  }

  /** Reports a failure injected with `applied: true` once the write has taken effect. */
  #settle(): void {
    const error = this.#applied;
    this.#applied = null;
    if (error !== null) throw error;
  }

  #invalid(op: TrackerOperation, message: string): never {
    throw new TrackerError({ code: 'validation', operation: op, message });
  }

  #checkNumber(op: TrackerOperation, number: number): void {
    if (!Number.isSafeInteger(number) || number < 1) this.#invalid(op, `${number} is not an issue or PR number`);
  }

  #notFound(op: TrackerOperation, number: number): never {
    throw new TrackerError({ code: 'not-found', operation: op, status: 404, message: `#${number} not found` });
  }

  /** Issue entry; pull request numbers are refused like GitHub's issue endpoints returning a PR. */
  #issueEntry(op: TrackerOperation, number: number): IssueEntry {
    this.#checkNumber(op, number);
    if (this.#pulls.has(number)) {
      throw new TrackerError({ code: 'not-an-issue', operation: op, message: `#${number} is a pull request, not an issue` });
    }
    return this.#issues.get(number) ?? this.#notFound(op, number);
  }

  #pullEntry(op: TrackerOperation, number: number): PullRequestEntry {
    this.#checkNumber(op, number);
    return this.#pulls.get(number) ?? this.#notFound(op, number);
  }

  #resolveRef(ref: string): string {
    for (const { pr } of this.#pulls.values()) if (pr.headRef === ref) return pr.headSha;
    return ref;
  }

  #event(entry: IssueEntry, type: IssueEventType, label: string | null, actor: Actor): void {
    entry.events.push({ id: String(this.#nextId++), type, label, actor: { ...actor }, at: this.#now(), commitId: null });
  }

  #addComment(entry: IssueEntry, author: Actor, body: string): TrackerComment {
    const at = this.#now();
    const id = String(this.#nextId++);
    const comment: TrackerComment = {
      id,
      issueNumber: entry.issue.number,
      author: { ...author },
      authorAssociation: author.login === this.actor.login ? 'NONE' : 'MEMBER',
      body,
      url: `${entry.issue.url}#issuecomment-${id}`,
      createdAt: at,
      updatedAt: at,
      ...readServiceMarker(body),
    };
    entry.comments.push(comment);
    return comment;
  }

  async #addLabels(op: TrackerOperation, issueNumber: number, labels: readonly string[]): Promise<string[]> {
    if (labels.length === 0 || labels.some((label) => label.trim() === '')) this.#invalid(op, 'labels must be non-empty');
    const entry = this.#issueEntry(op, issueNumber);
    this.#maybeFail('addLabels', op);
    this.#applyAddLabels(entry, labels, this.actor);
    this.#settle();
    return [...entry.issue.labels];
  }

  async #removeLabel(op: TrackerOperation, issueNumber: number, label: string): Promise<string[]> {
    const entry = this.#issueEntry(op, issueNumber);
    this.#maybeFail('removeLabel', op);
    this.#applyRemoveLabel(entry, label, this.actor);
    this.#settle();
    return [...entry.issue.labels];
  }

  #applyAddLabels(entry: IssueEntry, labels: readonly string[], actor: Actor, recordEvents = true): void {
    for (const label of labels) {
      if (hasLabel(entry.issue.labels, label)) continue;
      entry.issue.labels.push(label);
      if (recordEvents) this.#event(entry, 'labeled', label, actor);
    }
    entry.issue.updatedAt = this.#now();
  }

  #applyRemoveLabel(entry: IssueEntry, label: string, actor: Actor): void {
    const index = entry.issue.labels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase());
    if (index === -1) return;
    const [removed] = entry.issue.labels.splice(index, 1);
    this.#event(entry, 'unlabeled', removed ?? label, actor);
    entry.issue.updatedAt = this.#now();
  }

  #applyIssueState(entry: IssueEntry, state: 'open' | 'closed', reason: string | null, actor: Actor): void {
    if (entry.issue.state === state) return;
    const at = this.#now();
    entry.issue.state = state;
    entry.issue.stateReason = state === 'open' ? 'reopened' : reason;
    entry.issue.closedAt = state === 'closed' ? at : null;
    entry.issue.updatedAt = at;
    this.#event(entry, state === 'closed' ? 'closed' : 'reopened', null, actor);
  }

  #applyMerge(entry: PullRequestEntry, actor: Actor, mergeCommitSha?: string): string {
    const pr = entry.pr;
    if (pr.state === 'merged' && pr.mergeCommitSha !== null) return pr.mergeCommitSha;
    const at = this.#now();
    const sha = mergeCommitSha ?? createHash('sha1').update(`merge:${pr.number}:${pr.headSha}`).digest('hex');
    Object.assign(pr, {
      state: 'merged',
      mergeCommitSha: sha,
      mergedBy: { ...actor },
      mergedAt: at,
      closedAt: at,
      updatedAt: at,
      mergeable: null,
      mergeableState: 'unknown',
    } satisfies Partial<TrackerPullRequest>);
    for (const issueEntry of this.#issues.values()) {
      if (issueEntry.references.includes(pr.number) && pullRequestRelation(pr, this.repo, issueEntry.issue.number) === 'closing') {
        this.#applyIssueState(issueEntry, 'closed', 'completed', actor);
      }
    }
    return sha;
  }
}
