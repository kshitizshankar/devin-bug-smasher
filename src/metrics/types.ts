import type { PrMetrics, SessionMetrics, UsageMetrics } from '../devin/client.ts';
import type { BugRecord, Stage, Timestamp, WorkRoute } from '../model/types.ts';

/** Evidence that was read, or the reason it could not be. */
export type Sourced<T> = { status: 'available'; value: T } | { status: 'unavailable'; reason: string };

export const RECORD_MODES = ['live', 'replay'] as const;
export type RecordMode = (typeof RECORD_MODES)[number];

export const ENGINES = ['current', 'v1'] as const;
export type Engine = (typeof ENGINES)[number];

/** One bug store and how its records were produced. */
export interface RecordSet {
  mode: RecordMode;
  engine: Engine;
  records: readonly BugRecord[];
}

// Evidence -----------------------------------------------------------------------------------------------------

export interface Person {
  login: string;
  bot: boolean;
}

export interface IssueActivity {
  key: string;
  createdAt: Timestamp;
  author: Person | null;
  comments: { author: Person | null; at: Timestamp; fromService: boolean }[];
  events: { type: 'labeled' | 'unlabeled' | 'closed' | 'reopened'; label: string | null; actor: Person | null; at: Timestamp }[];
}

/** GitHub's view of a fix pull request. */
export interface PullRequestFacts {
  /** `owner/repo#number` of the pull request. */
  key: string;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  mergeCommitSha: string | null;
  mergedAt: Timestamp | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** A merged pull request that reverted a merged fix. */
export interface RevertFact {
  /** `owner/repo#number` of the reverted fix pull request. */
  fixKey: string;
  revertUrl: string;
  mergedAt: Timestamp;
}

export interface BaselineIssue {
  number: number;
  createdAt: Timestamp;
  closedAt: Timestamp;
}

export interface GitHubEvidence {
  repository: string;
  readAt: Timestamp;
  issues: IssueActivity[];
  pullRequests: PullRequestFacts[];
  reverts: RevertFact[];
  /** Closed issues matching `BASELINE_FILTER`, or why none were read. */
  baseline: Sourced<{ filter: string; issues: BaselineIssue[] }>;
}

export interface SessionFact {
  id: string;
  /** From the `bug-smasher:bug=` tag. */
  bugKey: string | null;
  route: WorkRoute | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  status: string;
  statusDetail: string | null;
  working: boolean;
  ended: boolean;
  /** Reported ACUs; `null` when Devin reports none (zero or missing). */
  acus: number | null;
  /** Knowledge note IDs Devin reported using, from Session Insights; `null` when Insights are unavailable. */
  knowledge: string[] | null;
}

export interface DevinCrossCheck {
  window: { start: Timestamp; end: Timestamp };
  usage: Sourced<UsageMetrics>;
  sessions: Sourced<SessionMetrics>;
  prs: Sourced<PrMetrics>;
}

export interface DevinEvidence {
  readAt: Timestamp;
  sessions: SessionFact[];
  crossCheck: DevinCrossCheck;
}

export interface MetricsEvidence {
  github: Sourced<GitHubEvidence>;
  devin: Sourced<DevinEvidence>;
  /** Last finished orchestrator cycle, when the calculation runs beside the orchestrator. */
  orchestrator: Sourced<{ lastCycleAt: Timestamp | null }>;
}

export interface MetricsSettings {
  acuPriceUsd: number | null;
  spendUsd: number | null;
  spendReadAt: Timestamp | null;
  budgetUsd: number | null;
  maxAcuPerSession: number;
  baselineFilter: string | null;
}

export interface MetricsInput {
  now: Date;
  /** `owner/repo` whose live bugs are the headline outcome; `null` when `GITHUB_REPO` is not set. */
  target: string | null;
  recordSets: readonly RecordSet[];
  settings: MetricsSettings;
  evidence: MetricsEvidence;
}

// Output -------------------------------------------------------------------------------------------------------

export type FigureStatus = 'value' | 'no-data' | 'unavailable';
export type FigureUnit = 'count' | 'ratio' | 'hours' | 'usd' | 'acus' | 'timestamp' | 'lines' | 'files';

/** `start` is inclusive and `end` exclusive; `start` is `null` for all-time or point-in-time figures. */
export interface MetricWindow {
  start: Timestamp | null;
  end: Timestamp;
  label: string;
}

export interface Figure {
  id: string;
  label: string;
  status: FigureStatus;
  unit: FigureUnit;
  /** For `ratio` a share between 0 and 1; `null` unless `status` is `value`. */
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  samples: number;
  window: MetricWindow;
  source: string;
  /** The exact text every consumer shows for this figure. */
  display: string;
  /** Why the figure is `no-data` or `unavailable`, or a caveat on a value. */
  note: string | null;
}

export interface KeyFigure {
  figure: Figure;
  reference: Figure;
}

export interface ThroughputWeek {
  figure: Figure;
  /** Merged bug fixes in the week that did not count, with the reason. */
  excluded: { key: string; pullRequest: string; reason: string }[];
}

export interface CohortMetrics {
  id: string;
  label: string;
  repository: string;
  mode: RecordMode;
  engine: Engine;
  /** True only for current-engine live records of the target repository. */
  live: boolean;
  records: number;
  bugs: number;
  features: number;
  keys: {
    fixThroughput: KeyFigure;
    trend: ThroughputWeek[];
    timeToFixMedian: KeyFigure;
    timeToFixP90: Figure;
    firstTimePass: KeyFigure;
    escapedFixes: KeyFigure;
  };
  flow: {
    bugsIn: Figure[];
    openByStage: Figure[];
    longestWait: Figure[];
    resolution: Figure;
    failure: Figure;
    failureByReason: Figure[];
    fixSizeLines: Figure[];
    fixSizeFiles: Figure[];
  };
  adoption: {
    peopleByWeek: Figure[];
    peopleByAction: Figure[];
    answerTime: Figure;
    decisionTime: Figure[];
    unansweredQuestions: Figure;
    agreement: Figure[];
    automation: Figure[];
  };
}

export interface SessionCost {
  id: string;
  bugKey: string | null;
  route: WorkRoute | null;
  acus: number;
  usd: number;
}

export interface CostMetrics {
  source: 'acus' | 'manual' | 'none';
  /** Text shown with every cost figure: where it came from and when it was read. */
  sourceLabel: string;
  readAt: Timestamp | null;
  scope: string;
  totalSpend: Figure;
  budgetRemaining: Figure;
  costPerFixedBug: Figure;
  costPerSession: Figure;
  costPerSessionByRoute: Figure[];
  largestSessions: SessionCost[];
  sessionsAtCap: Figure;
}

export interface LivenessMetrics {
  lastCycle: Figure;
  workingSessions: Figure;
  verificationErrors: Figure;
  stalledSessions: Figure;
  knowledgeUsed: Figure[];
}

export interface CrossCheckMetrics {
  note: string;
  figures: { devin: Figure; local: Figure }[];
}

export interface RecordRow {
  key: string;
  cohort: string;
  kind: BugRecord['kind'];
  stage: Stage;
  path: string;
  decision: string;
  pullRequest: string;
  verification: string;
  outcome: string;
}

export interface MetricsReport {
  generatedAt: Timestamp;
  timezone: 'UTC';
  weekStartsOn: 'Monday';
  target: string | null;
  sources: { github: string; devin: string; orchestrator: string };
  rows: RecordRow[];
  /** The headline cohort (live bugs of the target repository), or `null` when there is none. */
  live: CohortMetrics | null;
  /** Every other cohort, reported separately and never counted in live outcomes. */
  otherCohorts: CohortMetrics[];
  cost: CostMetrics;
  liveness: LivenessMetrics;
  crossCheck: CrossCheckMetrics;
}

