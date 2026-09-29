import type { EffectiveSettings } from '../config/settings.ts';
import type { CohortMetrics, MetricsReport } from '../metrics/types.ts';
import type { Attention, Gate, OverviewGroup, StatusCode } from '../model/presentation.ts';
import type { ScenarioOutcome, ScenarioSource } from '../replay/recording.ts';
import type {
  Recommendation,
  ReviewRoundStatus,
  Stage,
  SessionLiveState,
  TaskKind,
  Timestamp,
  VerificationPhase,
  VerificationResult,
} from '../model/types.ts';

/**
 * Response shapes of the read-only dashboard API. Every response carries `refresh`, which says whether the
 * data is current, a stale earlier snapshot (the latest refresh could not read a provider), or unavailable
 * (no snapshot has been read yet). Unavailable data is `null`, never empty lists or zero counts.
 */

export type Freshness = 'current' | 'stale' | 'unavailable';

export interface RefreshProblem {
  source: 'github' | 'devin' | 'workflow';
  reason: string;
}

export interface RefreshStatus {
  state: Freshness;
  /** When the data served was read from GitHub and Devin; `null` when there is none. */
  lastRefreshAt: Timestamp | null;
  /** When the latest refresh attempt finished, successful or not. */
  lastAttemptAt: Timestamp | null;
  /** Why the latest refresh did not produce current data; empty when current. */
  problems: RefreshProblem[];
}

/** Which scenario of the replay recording an issue belongs to and where its events came from. */
export interface ReplayProvenance {
  scenario: string;
  source: ScenarioSource;
}

export interface ReplayScenarioView {
  id: string;
  title: string;
  /** Bug key of the scenario's issue; `null` until the step that opens it has been played. */
  issue: string | null;
  source: ScenarioSource;
  synthetic: boolean;
  /** Where the full replay leaves the issue. */
  expected: ScenarioOutcome;
  current: { stage: Stage; status: StatusCode } | null;
  reached: boolean;
}

export interface ReplayInfo {
  recording: { id: string; title: string };
  played: number;
  total: number;
  /** The simulated clock after the last played step. */
  simulatedTime: Timestamp;
  next: { step: number; title: string; scenario: string } | null;
  scenarios: ReplayScenarioView[];
}

/**
 * What the served data is. `simulated` is true in replay mode: records come from the replay recording
 * driven through stand-in GitHub and Devin providers, never from a live repository.
 */
export interface DataSource {
  mode: 'live' | 'replay';
  simulated: boolean;
  replay: ReplayInfo | null;
}

export interface OverviewIssue {
  key: string;
  number: number;
  title: string;
  kind: TaskKind;
  /** GitHub issue URL. */
  url: string;
  issueState: 'open' | 'closed';
  status: StatusCode;
  statusLabel: string;
  group: OverviewGroup;
  attention: Attention;
  /** Devin's triage recommendation: advice only, never a decision. */
  recommendation: Recommendation | null;
  /** The timestamp that matters for the current status. */
  timestamp: { kind: 'opened' | 'asked' | 'stage-entered' | 'merged' | 'closed'; at: Timestamp };
  /** The pull request GitHub reports for the recorded fix; absent when there is none. */
  pullRequest?: { number: number; url: string; state: 'open' | 'closed' | 'merged' };
  /** Present only when a Devin session is recorded. */
  session?: { id: string; url: string; state: SessionLiveState };
  /** Present only when a verification attempt is recorded. */
  verification?: {
    phase: VerificationPhase;
    result: VerificationResult;
    reason: string;
    headSha: string;
    at: Timestamp;
    /** True only when a pre-merge verification passed for the head the PR has now. */
    currentHeadVerified: boolean;
  };
  /** Present only when a Devin Review round is recorded for the current PR head. */
  review?: { status: ReviewRoundStatus; findings: { url: string; path: string | null; line: number | null }[] };
  /** Replay mode only: the recording scenario this issue replays. */
  replay?: ReplayProvenance;
}

export interface Headline {
  /** The served cohort's key figures (live, or replay in replay mode), exactly as the shared metrics calculation reports them. */
  fixThroughput: CohortMetrics['keys']['fixThroughput'];
  timeToFixMedian: CohortMetrics['keys']['timeToFixMedian'];
  firstTimePass: CohortMetrics['keys']['firstTimePass'];
  escapedFixes: CohortMetrics['keys']['escapedFixes'];
}

export interface Overview {
  repository: string;
  /** `null` when the target repository has no live cohort yet. */
  headline: Headline | null;
  counts: {
    issues: number;
    groups: Record<OverviewGroup, number>;
    statuses: Record<StatusCode, number>;
    gates: Record<Gate, number>;
  };
  issues: OverviewIssue[];
}

export interface OverviewResponse {
  data: DataSource;
  refresh: RefreshStatus;
  overview: Overview | null;
}

export interface MetricsResponse {
  data: DataSource;
  refresh: RefreshStatus;
  metrics: MetricsReport | null;
}

export interface SettingsResponse {
  data: DataSource;
  refresh: RefreshStatus;
  settings: EffectiveSettings;
}
