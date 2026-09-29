import { DEVIN_REVIEW_STATUSES, type DevinReviewStatus, type WirePrReview } from './wire.ts';

/** GitHub login Devin Review posts findings as (docs: Devin Review > Commit & Comment Attribution). */
export const DEVIN_REVIEW_BOT_LOGIN = 'devin-ai-integration[bot]';

/**
 * Devin Review state for one PR head commit. `completed` only means the provider finished reviewing;
 * whether anything must be fixed is answered by `reviewFindings`, never by the status alone.
 */
export type ReviewState =
  | { status: 'pending'; providerStatus: 'pending' | 'running'; commitSha: string; prNumber: number; repoPath: string }
  | { status: 'completed'; commitSha: string; prNumber: number; repoPath: string; createdAt: string }
  | { status: 'error'; providerStatus: 'errored'; commitSha: string; prNumber: number; repoPath: string }
  | { status: 'unavailable'; reason: ReviewUnavailableReason; detail: string };

export type ReviewUnavailableReason =
  /** `DEVIN_REVIEW=false` in settings; the provider was not called. */
  | 'disabled'
  /** No review exists for this PR/commit (HTTP 404). */
  | 'not-requested'
  /** The API key lacks the review permission (HTTP 403). */
  | 'forbidden'
  /** The provider cancelled or skipped the review. */
  | 'cancelled'
  | 'skipped'
  /** The review found is for a different commit than the head being verified. */
  | 'different-commit'
  /** The provider returned a status this adapter does not know. */
  | 'unknown-status';

/** Full or abbreviated (at least 7 hex characters) SHAs naming the same commit. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

export function reviewState(wire: WirePrReview, expectedHeadSha: string | null): ReviewState {
  if (expectedHeadSha !== null && !sameCommit(wire.commit_sha, expectedHeadSha)) {
    return {
      status: 'unavailable',
      reason: 'different-commit',
      detail: `Review is for ${wire.commit_sha}, not the current head ${expectedHeadSha}`,
    };
  }
  const base = { commitSha: wire.commit_sha, prNumber: wire.pr_number, repoPath: wire.repo_path };
  if (!(DEVIN_REVIEW_STATUSES as readonly string[]).includes(wire.status)) {
    return { status: 'unavailable', reason: 'unknown-status', detail: `Unknown review status ${wire.status}` };
  }
  switch (wire.status as DevinReviewStatus) {
    case 'pending':
    case 'running':
      return { status: 'pending', providerStatus: wire.status as 'pending' | 'running', ...base };
    case 'completed':
      return { status: 'completed', ...base, createdAt: wire.created_at };
    case 'errored':
      return { status: 'error', providerStatus: 'errored', ...base };
    case 'cancelled':
      return { status: 'unavailable', reason: 'cancelled', detail: 'Devin Review was cancelled' };
    case 'skipped':
      return { status: 'unavailable', reason: 'skipped', detail: 'Devin Review skipped this PR' };
  }
}

/**
 * A GitHub review thread on the PR, supplied by the caller (the GitHub adapter owns fetching it). The
 * Devin API reports review status only; the findings themselves are the review's PR comments.
 */
export interface ReviewThreadInput {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** The commit the thread's first comment was made on (GitHub `originalCommit.oid`), if known. */
  commitSha: string | null;
  comments: { authorLogin: string; body: string; url: string; createdAt: string }[];
}

export interface ReviewFinding {
  threadId: string;
  path: string | null;
  line: number | null;
  body: string;
  url: string;
  /** The thread targets code that has since changed; still unresolved until someone resolves it. */
  outdated: boolean;
}

export type ReviewFindings =
  /**
   * `unresolved`: open bot threads from the reviewed commit. `earlier`: open bot threads from other or
   * unknown commits; they do not count against this review.
   */
  | { status: 'known'; commitSha: string; unresolved: ReviewFinding[]; earlier: ReviewFinding[] }
  | { status: 'unavailable'; reason: 'review-not-completed' | 'threads-not-supplied'; detail: string };

/**
 * Unresolved Devin Review findings for a completed review. Findings are threads started by the Devin
 * Review bot on the reviewed commit that nobody has resolved; nothing is inferred from comment wording.
 */
export function reviewFindings(
  review: ReviewState,
  threads: readonly ReviewThreadInput[] | null,
  botLogin: string = DEVIN_REVIEW_BOT_LOGIN,
): ReviewFindings {
  if (review.status !== 'completed') {
    return {
      status: 'unavailable',
      reason: 'review-not-completed',
      detail: review.status === 'unavailable' ? review.detail : `Devin Review is ${review.status}`,
    };
  }
  if (threads === null) {
    return {
      status: 'unavailable',
      reason: 'threads-not-supplied',
      detail: 'The Devin API does not return findings; supply the PR review threads',
    };
  }
  const unresolved: ReviewFinding[] = [];
  const earlier: ReviewFinding[] = [];
  for (const thread of threads) {
    const first = thread.comments[0];
    if (thread.isResolved || first === undefined || first.authorLogin !== botLogin) continue;
    (thread.commitSha !== null && sameCommit(thread.commitSha, review.commitSha) ? unresolved : earlier).push({
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      body: first.body,
      url: first.url,
      outdated: thread.isOutdated,
    });
  }
  return { status: 'known', commitSha: review.commitSha, unresolved, earlier };
}

/**
 * Review Auto-Fix is a Devin web-app setting with no API; this adapter never assumes it is on. Without
 * it, the service sends findings back to the session itself (`DevinClient.sendReviewCorrections`).
 */
export const REVIEW_AUTO_FIX = {
  state: 'unknown',
  configurableByApi: false,
  userAction:
    'An organization admin enables Auto-Fix from the Devin Review sidebar ("Enable auto-fix") or in ' +
    'Settings > Devin > Pull requests > Responding to bots (add devin-ai-integration[bot] or choose All bots).',
  docs: 'https://docs.devin.ai/work-with-devin/devin-review#auto-fix',
} as const;

/** The corrective message sent to the same session for unresolved findings. */
export function correctionMessage(findings: readonly ReviewFinding[]): string {
  const lines = findings.map((finding, index) => {
    const where = finding.path === null ? '' : ` (${finding.path}${finding.line === null ? '' : `:${finding.line}`})`;
    return `${index + 1}. ${finding.url}${where}\n${finding.body.trim()}`;
  });
  return [
    'Devin Review left unresolved findings on your pull request. Fix each one on the same branch, push, and',
    'then update your structured output (phase fix, status pr_opened).',
    '',
    ...lines,
  ].join('\n');
}
