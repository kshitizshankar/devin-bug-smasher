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
  verifications: VerificationAttempt[];
  decisions: Decision[];
  questions: Question[];
  stageHistory: StageEntry[];
  handoff: Handoff | null;
  insights: SessionInsights | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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
