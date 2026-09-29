import type { BugRecord, VerificationAttempt } from '../model/types.ts';
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
  phase: 'pre-merge';
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

export const UNAVAILABLE_VERIFIER: Verifier = {
  live: false,
  verify: async () => ({ status: 'unavailable', reason: 'No verifier is configured yet (M1.5)' }),
};

export const UNAVAILABLE_POLICY: DecisionPolicy = {
  live: false,
  decide: async () => ({ status: 'unavailable', reason: 'No decision policy is configured yet (M1.6)' }),
};
