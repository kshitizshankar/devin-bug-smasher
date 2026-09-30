import type {
  BugRecord,
  PolicyEvaluation,
  ReproductionCheck,
  VerificationAttempt,
  VerificationPhase,
  WorkflowOperation,
} from '../model/types.ts';
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

export interface ReproductionRequest {
  bugKey: string;
  /** Current default-branch commit the proposed test runs against. */
  sha: string;
  testFile: string;
  /** Proposed test contents (`proposed_check.test_code`); `null` runs the file already committed at `sha`. */
  testCode: string | null;
}

export type ReproductionResult =
  | { status: 'completed'; check: ReproductionCheck }
  /** Nothing ran; the Rule decision treats reproduction as unknown. */
  | { status: 'unavailable'; reason: string };

/** Runs a triage's proposed test on current code with the administrator's check command only. */
export interface Reproducer {
  readonly live: boolean;
  reproduce(request: ReproductionRequest): Promise<ReproductionResult>;
}

export interface DecisionRequest {
  record: BugRecord;
  issue: TrackerIssue;
}

/** `evaluation` is the evidence to persist; `null` for policies that record none. */
export type PolicyOutcome =
  | { status: 'decided'; action: 'fix' | 'engineer'; rule: string; reasons: string[]; evaluation: PolicyEvaluation | null }
  | { status: 'wait'; reason: string; rule: string | null; evaluation: PolicyEvaluation | null }
  | { status: 'unavailable'; reason: string };

/** Automatic repair decision for triaged bugs (`DECISION=rule|auto`). */
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

/**
 * Stable commit-status context for "Devin is done", so branch protection can hold merges. It says
 * nothing about verification: a green `bug-smasher/ready` never means the fix was verified.
 */
export const READY_STATUS_CONTEXT = 'bug-smasher/ready';

/** The commit status published on the fix PR's current head each cycle while it is unmerged. */
export function readyStatus(
  headSha: string,
  ready: { state: 'pending' | 'success'; detail: string },
): Extract<WorkflowOperation, { type: 'set-commit-status' }> {
  const description = ready.state === 'pending' ? `Devin is still working on this: ${ready.detail}` : ready.detail;
  return {
    type: 'set-commit-status',
    sha: headSha,
    state: ready.state,
    context: READY_STATUS_CONTEXT,
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
