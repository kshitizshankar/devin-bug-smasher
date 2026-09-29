import type { GitHubRepo } from '../config/settings.ts';

/**
 * Tracker contract used by the orchestrator. GitHub (`github.ts`) and the offline stand-in (`memory.ts`)
 * implement it with the same behaviour, including failures. Every method either returns complete,
 * normalized data or throws `TrackerError`; lists that the provider may truncate report `complete`.
 */

/** ISO 8601 timestamp string, as reported by the provider. */
export type Timestamp = string;

export interface Actor {
  login: string;
  type: 'user' | 'bot' | 'organization' | 'unknown';
}

export type IssueState = 'open' | 'closed';
export type IssueCloseReason = 'completed' | 'not_planned';

export interface TrackerIssue {
  number: number;
  /** `owner/repo#number`, the bug store key. */
  key: string;
  title: string;
  body: string;
  state: IssueState;
  stateReason: string | null;
  labels: string[];
  author: Actor | null;
  url: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  closedAt: Timestamp | null;
}

export interface NewIssue {
  title: string;
  body: string;
  labels?: readonly string[];
}

export interface TrackerComment {
  /** Stable provider ID; use it to deduplicate replies across polls. */
  id: string;
  issueNumber: number;
  author: Actor | null;
  /** GitHub author association, e.g. `OWNER`, `MEMBER`, `CONTRIBUTOR`, `NONE`. */
  authorAssociation: string | null;
  body: string;
  url: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** True when the body carries the service marker added by `postComment`. */
  fromService: boolean;
  /** Idempotency key embedded by `postComment(..., { key })`, if any. */
  serviceKey: string | null;
}

export interface PostCommentOptions {
  /**
   * Idempotency key (`[A-Za-z0-9._:/-]`, at most 100 characters). When a comment with this key already
   * exists it is returned instead of posting again, so a retried or ambiguous post is not duplicated.
   */
  key?: string;
}

export type IssueEventType = 'labeled' | 'unlabeled' | 'closed' | 'reopened';

export interface IssueEvent {
  /** Stable provider ID; use it to deduplicate events across polls. */
  id: string;
  type: IssueEventType;
  /** Label name for `labeled` / `unlabeled`, otherwise `null`. */
  label: string | null;
  actor: Actor | null;
  at: Timestamp;
  /** Commit that closed the issue, when GitHub reports one. */
  commitId: string | null;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface TrackerPullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  /** `merged` only when GitHub reports the PR merged; a closed unmerged PR is `closed`. */
  state: PullRequestState;
  draft: boolean;
  author: Actor | null;
  headSha: string;
  headRef: string;
  /** `owner/name` of the head repository; `null` when the fork was deleted. */
  headRepo: string | null;
  baseSha: string;
  baseRef: string;
  /** `null` while GitHub is still computing mergeability. */
  mergeable: boolean | null;
  mergeableState: string | null;
  /** Set only once merged; GitHub's test-merge SHA for open PRs is never exposed. */
  mergeCommitSha: string | null;
  mergedBy: Actor | null;
  mergedAt: Timestamp | null;
  closedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  changedFiles: number;
  additions: number;
  deletions: number;
}

/**
 * `closing`: the PR title or body uses a closing keyword for this issue (`Fixes #12`, `closes owner/repo#12`,
 * or the issue URL). `mention`: the PR only references the issue.
 */
export type PullRequestRelation = 'closing' | 'mention';

export interface LinkedPullRequest {
  pullRequest: TrackerPullRequest;
  relation: PullRequestRelation;
}

export interface PullRequestFile {
  filename: string;
  previousFilename: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** `null` when the provider omits the patch (binary or very large files). */
  patch: string | null;
}

export interface PullRequestFiles {
  files: PullRequestFile[];
  /** False when the provider returned fewer files than the PR changes (GitHub lists at most 3000). */
  complete: boolean;
  expectedCount: number;
}

export type PullRequestDiff = { complete: true; diff: string } | { complete: false; reason: string };

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';

export interface Review {
  id: string;
  reviewer: Actor | null;
  state: ReviewState;
  /** Commit the review was made on; compare with the PR head to spot stale approvals. */
  commitId: string | null;
  submittedAt: Timestamp | null;
  body: string;
}

export interface CheckRun {
  id: string;
  name: string;
  /** `queued`, `in_progress`, `completed`, `waiting`, `requested` or `pending`. */
  status: string;
  /** `success`, `failure`, `neutral`, `cancelled`, `skipped`, `timed_out`, `action_required` or `null`. */
  conclusion: string | null;
  app: string | null;
  url: string | null;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
}

export interface CheckRuns {
  runs: CheckRun[];
  complete: boolean;
  totalCount: number;
}

export type CommitStatusState = 'error' | 'failure' | 'pending' | 'success';

export interface CommitStatus {
  id: string;
  context: string;
  state: CommitStatusState;
  description: string | null;
  targetUrl: string | null;
  creator: Actor | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface NewCommitStatus {
  state: CommitStatusState;
  context: string;
  /** Truncated to GitHub's 140-character limit. */
  description?: string;
  targetUrl?: string;
}

export interface CombinedStatus {
  sha: string;
  /** Combined state: `failure` if any context failed or errored, `pending` if none or any pending. */
  state: CommitStatusState;
  /** Latest status per context. */
  statuses: CommitStatus[];
  complete: boolean;
  totalCount: number;
}

/** A review thread on a pull request; its first comment starts it. */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** Commit the first comment was made on, if known. */
  commitSha: string | null;
  /** Bot logins carry the `[bot]` suffix, as in REST responses. */
  comments: { authorLogin: string; body: string; url: string; createdAt: Timestamp }[];
}

export interface Branch {
  name: string;
  sha: string;
  protected: boolean;
  /**
   * Status check contexts required before merging (branch protection and rulesets together). `null` when the
   * requirement could not be read, which is never treated as "none required".
   */
  requiredChecks: string[] | null;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface MergeRequest {
  /** The merge is refused (`head-mismatch`) unless the PR head is still this commit. */
  expectedHeadSha: string;
  method?: MergeMethod;
  commitTitle?: string;
}

export interface MergeResult {
  mergeCommitSha: string;
  /** True when the PR was already merged at the expected head (a repeated or external merge). */
  alreadyMerged: boolean;
}

export interface LabelMove {
  /** Previous workflow label; removed only after `to` was added. */
  from: string;
  to: string;
}

export interface Tracker {
  readonly repo: GitHubRepo;

  /** Open issues (never pull requests) carrying any of `labels`, all pages, sorted by number. */
  listOpenIssues(labels: readonly string[]): Promise<TrackerIssue[]>;
  /** Any issue, open or closed, regardless of labels. Pull requests are refused with `not-an-issue`. */
  getIssue(number: number): Promise<TrackerIssue>;
  createIssue(input: NewIssue): Promise<TrackerIssue>;

  listComments(issueNumber: number): Promise<TrackerComment[]>;
  postComment(issueNumber: number, body: string, options?: PostCommentOptions): Promise<TrackerComment>;
  /** Label, close and reopen events with actor and time, oldest first. */
  listIssueEvents(issueNumber: number): Promise<IssueEvent[]>;

  /** Returns the issue's labels afterwards. Adding a label that is already present is not an error. */
  addLabels(issueNumber: number, labels: readonly string[]): Promise<string[]>;
  /** Returns the issue's labels afterwards. Removing an absent label is a no-op. */
  removeLabel(issueNumber: number, label: string): Promise<string[]>;
  /** Adds `to`, then removes `from`. If adding fails, `from` is left in place and the error is thrown. */
  moveLabel(issueNumber: number, move: LabelMove): Promise<string[]>;
  closeIssue(issueNumber: number, options?: { reason?: IssueCloseReason }): Promise<TrackerIssue>;
  reopenIssue(issueNumber: number): Promise<TrackerIssue>;

  /** Pull requests in this repository that reference the issue, with how they reference it. */
  findLinkedPullRequests(issueNumber: number): Promise<LinkedPullRequest[]>;
  getPullRequest(number: number): Promise<TrackerPullRequest>;
  listPullRequestFiles(number: number): Promise<PullRequestFiles>;
  getPullRequestDiff(number: number): Promise<PullRequestDiff>;
  listReviews(number: number): Promise<Review[]>;
  /** All review threads on the PR, with their first comment, oldest first. */
  listReviewThreads(number: number): Promise<ReviewThread[]>;
  getBranch(name: string): Promise<Branch>;
  getDefaultBranch(): Promise<Branch>;
  listCheckRuns(ref: string): Promise<CheckRuns>;
  getCombinedStatus(ref: string): Promise<CombinedStatus>;
  createCommitStatus(sha: string, status: NewCommitStatus): Promise<CommitStatus>;
  /** Merges at `expectedHeadSha` only; honours branch protection (never bypasses it). */
  mergePullRequest(number: number, request: MergeRequest): Promise<MergeResult>;
}

export type TrackerOperation = Exclude<keyof Tracker, 'repo'>;

export type TrackerErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'not-an-issue'
  | 'rate-limited'
  | 'validation'
  | 'head-mismatch'
  | 'not-open'
  | 'not-mergeable'
  | 'conflict'
  | 'server-error'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'incomplete';

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** When the primary rate limit window resets. */
  resetAt: Timestamp | null;
  resource: string | null;
}

export interface TrackerErrorDetails {
  code: TrackerErrorCode;
  operation: TrackerOperation;
  message: string;
  status?: number | null;
  retryable?: boolean;
  retryAfterSeconds?: number | null;
  rateLimit?: RateLimitInfo | null;
  requestId?: string | null;
  ambiguous?: boolean;
}

const RETRYABLE_CODES: ReadonlySet<TrackerErrorCode> = new Set(['rate-limited', 'server-error', 'network', 'timeout']);

/**
 * Safe tracker failure. Messages never contain credentials. `retryable` says whether repeating the same call
 * later may succeed, `retryAfterSeconds` how long to wait when the provider said so, and `ambiguous` that a
 * write may or may not have been applied (re-read before retrying).
 */
export class TrackerError extends Error {
  readonly code: TrackerErrorCode;
  readonly operation: TrackerOperation;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly rateLimit: RateLimitInfo | null;
  readonly requestId: string | null;
  readonly ambiguous: boolean;

  constructor(details: TrackerErrorDetails) {
    super(`${details.operation}: ${details.message}`);
    this.name = 'TrackerError';
    this.code = details.code;
    this.operation = details.operation;
    this.status = details.status ?? null;
    this.retryable = details.retryable ?? RETRYABLE_CODES.has(details.code);
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.rateLimit = details.rateLimit ?? null;
    this.requestId = details.requestId ?? null;
    this.ambiguous = details.ambiguous ?? false;
  }

  toJSON(): Omit<TrackerErrorDetails, 'operation'> & { operation: TrackerOperation } {
    return {
      code: this.code,
      operation: this.operation,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterSeconds,
      rateLimit: this.rateLimit,
      requestId: this.requestId,
      ambiguous: this.ambiguous,
    };
  }
}
