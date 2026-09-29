import type { BugRecord, VerificationAttempt, VerificationPhase, WorkflowOperation } from '../model/types.ts';
import type { TrackerIssue } from '../tracker/types.ts';

/** Actor recorded for actions taken through the service's own interface; never an invented person. */
export const INTERFACE_ACTOR = 'interface:bug-smasher';

export function githubActor(login: string): string {
  return `github:${login}`;
}

export function policyActor(rule: string): string {
  return `policy:${rule}`;
}

export interface VerificationRequest {
  bugKey: string;
  /**
   * `pre-merge` proves `headSha` (the PR head) against `baseSha` (the PR base). `post-merge` proves `headSha`
   * (the merge commit) against its first parent; `baseSha` is then the PR base, kept for reference.
   */
  phase: VerificationPhase;
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseSha: string;
  testFiles: string[];
}

export type VerificationOutcome =
  | { status: 'completed'; attempt: Omit<VerificationAttempt, 'sessionId'> }
  /** Nothing was verified; the record keeps waiting. Never treated as a pass. */
  | { status: 'unavailable'; reason: string };

/** Independent verification, implemented by M1.5. */
export interface Verifier {
  /** False for stubs and fixtures; their results are refused when the orchestrator requires live results. */
  readonly live: boolean;
  verify(request: VerificationRequest): Promise<VerificationOutcome>;
}

export interface DecisionRequest {
  record: BugRecord;
  issue: TrackerIssue;
}

export type PolicyOutcome =
  | { status: 'decided'; action: 'fix' | 'engineer'; rule: string; reasons: string[] }
  | { status: 'wait'; reason: string }
  | { status: 'unavailable'; reason: string };

/** Automatic repair decision for triaged bugs (`DECISION_POLICY=rule|auto`), implemented by M1.6. */
export interface DecisionPolicy {
  readonly live: boolean;
  decide(request: DecisionRequest): Promise<PolicyOutcome>;
}

/** Stable commit-status context for verification results, so branch protection can require it. */
export const VERIFICATION_STATUS_CONTEXT = 'bug-smasher/verification';

const STATUS_STATE = { pass: 'success', fail: 'failure', error: 'error' } as const;
const STATUS_LABEL = { pass: 'Passed', fail: 'Failed', error: 'Error' } as const;

/** The commit status that publishes an attempt on the exact commit it checked. */
export function verificationStatus(attempt: Omit<VerificationAttempt, 'sessionId'>): Extract<WorkflowOperation, { type: 'set-commit-status' }> {
  const phase = attempt.phase === 'post-merge' ? 'Post-merge ' : '';
  const flagged = (attempt.evidence?.flags.length ?? 0) > 0 ? ' [flagged]' : '';
  const description = `${phase}${STATUS_LABEL[attempt.result]}${flagged}: ${attempt.reason}`;
  return {
    type: 'set-commit-status',
    sha: attempt.headSha,
    state: STATUS_STATE[attempt.result],
    context: VERIFICATION_STATUS_CONTEXT,
    description: description.length > 140 ? `${description.slice(0, 139)}…` : description,
  };
}

export const UNAVAILABLE_VERIFIER: Verifier = {
  live: false,
  verify: async () => ({ status: 'unavailable', reason: 'No verifier is configured yet (M1.5)' }),
};

export const UNAVAILABLE_POLICY: DecisionPolicy = {
  live: false,
  decide: async () => ({ status: 'unavailable', reason: 'No decision policy is configured yet (M1.6)' }),
};
