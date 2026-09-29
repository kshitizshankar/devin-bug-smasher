/** Internal orchestration stages. The overview group is derived from these in `presentation.ts`. */
export const STAGES = [
  'queued',
  'triaging',
  'needs-input',
  'triaged',
  'fixing',
  'verifying',
  'ready-to-merge',
  'merged',
  'with-engineer',
  'closed',
] as const;
export type Stage = (typeof STAGES)[number];

export const TASK_KINDS = ['bug', 'feature'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Devin work a queued or active record is routed to. Feature work always uses `fix` with kind `feature`. */
export const WORK_ROUTES = ['triage', 'fix'] as const;
export type WorkRoute = (typeof WORK_ROUTES)[number];

export const SESSION_LIVE_STATES = ['starting', 'running', 'blocked', 'ended'] as const;
export type SessionLiveState = (typeof SESSION_LIVE_STATES)[number];

export const RECOMMENDATIONS = ['devin_fix', 'needs_engineer', 'close'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const VERIFICATION_RESULTS = ['pass', 'fail', 'error'] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VERIFICATION_PHASES = ['pre-merge', 'post-merge'] as const;
export type VerificationPhase = (typeof VERIFICATION_PHASES)[number];

export const ACTION_NAMES = ['triage', 'fix', 'engineer', 'close', 'reply', 'merge'] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export const DECISION_OUTCOMES = ['applied', 'requested'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const HANDOFF_REASONS = [
  'engineer-label',
  'person',
  'session-ended',
  'pr-closed-unmerged',
  'verification-error',
  'verification-failed',
  'post-merge-verification-failed',
  /** An open PR already addresses the issue, so repair would duplicate it. */
  'existing-pr',
] as const;
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** ISO 8601 timestamp string. */
export type Timestamp = string;

export interface SessionInfo {
  id: string;
  url: string;
  route: WorkRoute;
  liveState: SessionLiveState;
  startedAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when the model asked the adapter to stop this session (a `stop-session` effect). */
  stopRequestedAt: Timestamp | null;
}

export interface TriageFindings {
  title: string;
  summary: string;
  reproductionSteps: string[];
  expectedBehavior: string;
  actualBehavior: string;
  suspectedCause: string;
  affectedFiles: string[];
  reproduced: boolean;
  reproductionNotes: string;
  /** A proposed regression test. `command` is data only and is never executed by the model. */
  proposedTest: {
    description: string;
    file: string;
    command: string;
    /** Full contents of the proposed test file when it does not exist yet; data only, never executed as a command. */
    code?: string;
  };
  recommendation: Recommendation;
  reason: string;
  confidence: Confidence;
}

export interface FixInfo {
  prNumber: number;
  prUrl: string;
  /** Head SHA of the PR the fix is currently being verified against. */
  headSha: string;
  testFiles: string[];
  summary: string;
  /** Merge commit reported by GitHub once the PR merged; post-merge verification must target it. */
  mergeCommitSha: string | null;
  /** Who merged the PR (`github:<login>`) and when, as GitHub reported it; absent on records merged before M1.6. */
  mergedBy?: string | null;
  mergedAt?: Timestamp | null;
}

/** A fix as submitted by a session, before any merge. */
export type SubmittedFix = Omit<FixInfo, 'mergeCommitSha' | 'mergedBy' | 'mergedAt'>;

/** `reproduction` runs a triage's proposed test against the default branch for the Rule decision. */
export const VERIFICATION_RUN_ROLES = ['base', 'head', 'reproduction'] as const;
export type VerificationRunRole = (typeof VERIFICATION_RUN_ROLES)[number];

export const VERIFICATION_STEPS = ['setup', 'test'] as const;
export type VerificationStep = (typeof VERIFICATION_STEPS)[number];

/** `passed`/`failed` are test assertion outcomes; `error` means the step could not run or be read. */
export const RUN_OUTCOMES = ['passed', 'failed', 'error'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const DIFF_CHECKS = [
  'test-removed',
  'test-disabled',
  'test-weakened',
  /** Flag only: suppression comments added on net (older records may hold it as a violation). */
  'check-silenced',
  'rules-changed',
  /** Flag only: the change outside tests removes lines and adds none. */
  'deletion-only',
] as const;
export type DiffCheck = (typeof DIFF_CHECKS)[number];

/** One command the verifier ran in a disposable workspace. */
export interface VerificationRun {
  role: VerificationRunRole;
  step: VerificationStep;
  sha: string;
  /** Argument vector as executed (no shell). */
  command: string[];
  startedAt: Timestamp;
  endedAt: Timestamp;
  exitCode: number | null;
  outcome: RunOutcome;
  reason: string;
  /** Bounded tail of the combined output, with configured secrets redacted. */
  outputTail: string;
}

export interface DiffFinding {
  check: DiffCheck;
  file: string;
  detail: string;
}

export interface VerificationEvidence {
  runs: VerificationRun[];
  /** Diff checks that failed verification. */
  violations: DiffFinding[];
  /** Findings for the person deciding the merge; they never fail verification. */
  flags: DiffFinding[];
}

export interface VerificationAttempt {
  phase: VerificationPhase;
  baseSha: string;
  headSha: string;
  result: VerificationResult;
  reason: string;
  /** Tail of the verification output, kept as evidence. */
  outputTail: string;
  at: Timestamp;
  /** Devin session whose fix was being verified; retry and error budgets are counted per session. */
  sessionId: string | null;
  /** Per-run evidence from the independent verifier; absent on attempts recorded without it. */
  evidence?: VerificationEvidence;
}

export const REVIEW_ROUND_STATUSES = ['pending', 'completed', 'unavailable'] as const;
export type ReviewRoundStatus = (typeof REVIEW_ROUND_STATUSES)[number];

/** An unresolved Devin Review thread. */
export interface ReviewFindingRecord {
  threadId: string;
  path: string | null;
  line: number | null;
  body: string;
  url: string;
  outdated: boolean;
}

/** Devin Review of one PR head. A new head starts a new round after it passes verification. */
export interface ReviewRound {
  prNumber: number;
  headSha: string;
  status: ReviewRoundStatus;
  requestedAt: Timestamp;
  completedAt: Timestamp | null;
  /** Why the review is unavailable or errored; never read as a pass. */
  detail: string | null;
  /** Unresolved Devin Review threads when the round completed. */
  findings: ReviewFindingRecord[];
  /** When the findings were sent back to the same session (a repair round). */
  correctionSentAt: Timestamp | null;
  /** Set when the findings cannot be repaired automatically, e.g. the repair limit was reached. */
  blocker: string | null;
}

export const FINDING_RESOLUTIONS = ['same-session', 'github'] as const;
export type FindingResolutionVia = (typeof FINDING_RESOLUTIONS)[number];

/** A finding that is no longer open on a later review round. */
export interface FindingResolution {
  threadId: string;
  url: string;
  foundOnHead: string;
  resolvedOnHead: string;
  /** `same-session`: the finding was sent back to the session; `github`: resolved on GitHub without a repair. */
  via: FindingResolutionVia;
  at: Timestamp;
}

export interface ReviewRecord {
  rounds: ReviewRound[];
  resolutions: FindingResolution[];
}

export const REPRODUCTION_OUTCOMES = ['reproduced', 'not-reproduced', 'unknown'] as const;
export type ReproductionOutcome = (typeof REPRODUCTION_OUTCOMES)[number];

/** Independent run of the triage's proposed test against current default-branch code. */
export interface ReproductionCheck {
  sha: string;
  testFile: string;
  /** `reproduced` only when the test ran and failed with real test failures. */
  outcome: ReproductionOutcome;
  reason: string;
  at: Timestamp;
  runs: VerificationRun[];
}

export const POLICY_KINDS = ['decision', 'merge'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const AUTOMATIC_POLICIES = ['rule', 'auto'] as const;
export type AutomaticPolicy = (typeof AUTOMATIC_POLICIES)[number];

export const POLICY_OUTCOMES = ['fix', 'engineer', 'merge', 'wait'] as const;
export type PolicyOutcomeName = (typeof POLICY_OUTCOMES)[number];

/** One condition a policy checked. Non-blocking checks are reported but do not stop the policy. */
export interface PolicyCheck {
  name: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
}

/** Evidence for one Rule or Automatic policy evaluation, kept whether it acted or waited for a person. */
export interface PolicyEvaluation {
  kind: PolicyKind;
  policy: AutomaticPolicy;
  /** Stable rule name, e.g. `decision-rule`; also the decision actor `policy:<rule>`. */
  rule: string;
  /** What was evaluated: the triage session for decisions, the PR head SHA for merges. */
  subject: string;
  outcome: PolicyOutcomeName;
  checks: PolicyCheck[];
  reproduction: ReproductionCheck | null;
  at: Timestamp;
}

export interface Decision {
  action: ActionName;
  outcome: DecisionOutcome;
  actor: string;
  at: Timestamp;
  context: string | null;
}

export interface Question {
  id: string;
  summary: string;
  askedAt: Timestamp;
  answeredAt: Timestamp | null;
}

export interface StageEntry {
  stage: Stage;
  at: Timestamp;
}

export interface Handoff {
  reason: HandoffReason;
  detail: string | null;
  at: Timestamp;
  /**
   * True once a label snapshot showed the engineer label. Until then work labels in snapshots are treated
   * as stale (the adapter may not have applied the handoff's label effects yet) and do not return the work.
   */
  engineerLabelSeen: boolean;
}

export interface SessionInsights {
  acuUsed: number | null;
  notes: string | null;
}

/**
 * Persisted orchestration and evidence data for one GitHub issue. GitHub remains authoritative for the
 * issue's open/closed state, labels, text, comments and PR state; those arrive as `GitHubFacts` and are
 * not stored here.
 */
export interface BugRecord {
  /** `owner/repo#number`. */
  key: string;
  kind: TaskKind;
  stage: Stage;
  route: WorkRoute | null;
  session: SessionInfo | null;
  triage: TriageFindings | null;
  fix: FixInfo | null;
  /** Earlier fix PRs replaced when work was returned to investigation or repair. */
  priorFixes: FixInfo[];
  verifications: VerificationAttempt[];
  decisions: Decision[];
  questions: Question[];
  stageHistory: StageEntry[];
  handoff: Handoff | null;
  insights: SessionInsights | null;
  /** Devin Review rounds for fix PR heads; absent until the first review is requested. */
  review?: ReviewRecord;
  /** Rule and Automatic policy evaluations, oldest first; absent until the first one. */
  evaluations?: PolicyEvaluation[];
  /** Orchestrator bookkeeping; absent on records the orchestrator has not handled yet. */
  workflow?: WorkflowState;
  /** Sessions a stop left unarchived, so they could still wake on a pull request comment; absent when none. */
  unarchivedSessions?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A session create the orchestrator persisted before calling Devin, so a lost answer is reconciled, never repeated. */
export interface PendingDispatch {
  route: WorkRoute;
  requestedAt: Timestamp;
  /** The attempt tag once a create returned an ambiguous result; null while the request is in flight. */
  attemptTag: string | null;
  /** Reconciliation lookups that found no session so far. */
  checks: number;
  /** Human comments included in the prompt; marked delivered once the session is recorded. */
  commentIds: string[];
}

export const WORKFLOW_OPERATION_TYPES = [
  'add-label',
  'remove-label',
  'close-issue',
  'stop-session',
  'post-comment',
  'send-message',
  'merge-pr',
  'set-commit-status',
] as const;

/** A side effect accepted with a transition and not yet confirmed applied. Every operation is idempotent. */
export type WorkflowOperation =
  | { type: 'add-label'; label: string }
  | { type: 'remove-label'; label: string }
  | { type: 'close-issue' }
  | { type: 'stop-session'; sessionId: string }
  /** `key` is the tracker idempotency key, so a repeated post returns the existing comment. */
  | { type: 'post-comment'; key: string; body: string }
  /** `marker` is part of `message`; a message already carrying it in the session is not sent again. */
  | { type: 'send-message'; sessionId: string; marker: string; message: string }
  | { type: 'merge-pr'; prNumber: number; expectedHeadSha: string }
  /** Publishes a verification result on the exact commit that was checked. Repeating it is harmless. */
  | {
      type: 'set-commit-status';
      sha: string;
      state: 'success' | 'failure' | 'error';
      context: string;
      description: string;
    };

/** Question a repair or feature session asked; the model tracks investigation questions itself. */
export interface WorkQuestion {
  id: string;
  sessionId: string;
  summary: string;
  askedAt: Timestamp;
}

/** Persisted orchestrator state that lets a restarted service continue without repeating or losing effects. */
export interface WorkflowState {
  dispatch: PendingDispatch | null;
  /** Operations still to apply, in order. */
  outbox: WorkflowOperation[];
  /** GitHub comments already delivered to a Devin session (relayed or included in a prompt). */
  relayedCommentIds: string[];
  /** Issue label events already considered as person decisions. */
  handledEventIds: string[];
  workQuestion: WorkQuestion | null;
  /** One-time notices already queued, e.g. `triage-pr:<sessionId>`. */
  notices: string[];
}

/** Latest GitHub snapshot used as input to derivation. */
export interface GitHubFacts {
  issue: {
    owner: string;
    repo: string;
    number: number;
    state: 'open' | 'closed';
    labels: string[];
  };
  pullRequest: {
    number: number;
    state: 'open' | 'closed' | 'merged';
    headSha: string;
  } | null;
}
