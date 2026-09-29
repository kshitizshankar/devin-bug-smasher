import type { EffectiveSettings } from '../config/settings.ts';
import type { CohortMetrics, MetricsReport } from '../metrics/types.ts';
import type { Attention, Gate, OverviewGroup, StatusCode } from '../model/presentation.ts';
import type {
  Recommendation,
  ReviewRoundStatus,
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
}

export interface Headline {
  /** The live cohort's key figures, exactly as the shared metrics calculation reports them. */
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
  refresh: RefreshStatus;
  overview: Overview | null;
}

export interface MetricsResponse {
  refresh: RefreshStatus;
  metrics: MetricsReport | null;
}

export interface SettingsResponse {
  refresh: RefreshStatus;
  settings: EffectiveSettings;
}
