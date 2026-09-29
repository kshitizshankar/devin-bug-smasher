import { effectiveSettings, type Settings } from '../config/settings.ts';
import { redact } from '../devin/errors.ts';
import { calculateMetrics } from '../metrics/calculate.ts';
import { readDevinEvidence, readGitHubEvidence, type EvidenceDevin, type EvidenceTracker } from '../metrics/evidence.ts';
import type { MetricsReport, Sourced } from '../metrics/types.ts';
import { parseBugKey } from '../model/keys.ts';
import { attention, GATES, OVERVIEW_GROUPS, presentBug, STATUS_CODES, type Presentation } from '../model/presentation.ts';
import type { BugRecord } from '../model/types.ts';
import { toGitHubFacts } from '../tracker/common.ts';
import type { Tracker, TrackerIssue, TrackerPullRequest } from '../tracker/types.ts';
import type {
  MetricsResponse,
  Overview,
  OverviewIssue,
  OverviewResponse,
  RefreshProblem,
  RefreshStatus,
  SettingsResponse,
} from './types.ts';

export type DashboardTracker = EvidenceTracker & Pick<Tracker, 'listOpenIssues'>;

/** Where a refresh reads from. Every call is a read; the dashboard never writes to a provider or the store. */
export interface DashboardSources {
  store: { list(): BugRecord[] };
  tracker: DashboardTracker;
  devin: EvidenceDevin;
  lastCycleAt: () => string | null;
}

export interface DashboardOptions {
  settings: Settings;
  now?: () => Date;
}

/** What the API serves. */
export interface DashboardApi {
  overview(): OverviewResponse;
  metrics(): MetricsResponse;
  settings(): SettingsResponse;
}

interface Snapshot {
  at: string;
  overview: Overview;
  metrics: MetricsReport;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(read: () => Promise<Sourced<T>>): Promise<Sourced<T>> {
  try {
    return await read();
  } catch (error) {
    return { status: 'unavailable', reason: describe(error) };
  }
}

function countsOf<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function timestampFor(issue: TrackerIssue, record: BugRecord | undefined, pr: TrackerPullRequest | null, presentation: Presentation): OverviewIssue['timestamp'] {
  const stageAt = record?.stageHistory.at(-1)?.at ?? null;
  switch (presentation.status) {
    case 'closed':
      return { kind: 'closed', at: issue.closedAt ?? stageAt ?? issue.updatedAt };
    case 'merged':
      return { kind: 'merged', at: pr?.mergedAt ?? record?.fix?.mergedAt ?? stageAt ?? issue.updatedAt };
    case 'waiting-for-reply':
      if (presentation.history.outstandingQuestion !== null) return { kind: 'asked', at: presentation.history.outstandingQuestion.askedAt };
  }
  return stageAt === null ? { kind: 'opened', at: issue.createdAt } : { kind: 'stage-entered', at: stageAt };
}

/** One compact overview record; provider fields appear only when the record or GitHub supplies them. */
export function overviewIssue(issue: TrackerIssue, record: BugRecord | undefined, pr: TrackerPullRequest | null, presentation: Presentation): OverviewIssue {
  const item: OverviewIssue = {
    key: presentation.key,
    number: issue.number,
    title: issue.title,
    kind: presentation.kind,
    url: issue.url,
    issueState: issue.state,
    status: presentation.status,
    statusLabel: presentation.statusLabel,
    group: presentation.group,
    attention: attention(presentation),
    recommendation: presentation.history.recommendation,
    timestamp: timestampFor(issue, record, pr, presentation),
  };
  if (pr !== null) item.pullRequest = { number: pr.number, url: pr.url, state: pr.state };
  const session = record?.session ?? null;
  if (session !== null && session.url !== '') item.session = { id: session.id, url: session.url, state: session.liveState };
  const verification = presentation.history.latestVerification;
  if (verification !== null) {
    item.verification = {
      phase: verification.phase,
      result: verification.result,
      reason: verification.reason,
      headSha: verification.headSha,
      at: verification.at,
      currentHeadVerified: presentation.history.currentHeadVerified,
    };
  }
  const review = presentation.automation.review;
  if (review !== null) {
    item.review = { status: review.status, findings: review.findings.map((finding) => ({ url: finding.url, path: finding.path, line: finding.line })) };
  }
  return item;
}

/**
 * Read-only dashboard state. `refresh()` reads GitHub (authoritative for issues, labels and PRs), the store
 * and Devin, derives every status with `presentBug` and every figure with `calculateMetrics`, and replaces
 * the snapshot only when all sources were read. A failed refresh keeps the previous snapshot and marks it
 * stale; without one the data is unavailable.
 */
export class Dashboard implements DashboardApi {
  readonly #settings: Settings;
  readonly #now: () => Date;
  readonly #secrets: string[];
  #sources: DashboardSources | null = null;
  #snapshot: Snapshot | null = null;
  #lastAttemptAt: string | null = null;
  #problems: RefreshProblem[] = [{ source: 'workflow', reason: 'No refresh has completed yet' }];
  #refreshing: Promise<void> | null = null;
  #queued: Promise<void> | null = null;

  constructor(options: DashboardOptions) {
    this.#settings = options.settings;
    this.#now = options.now ?? (() => new Date());
    this.#secrets = [options.settings.github.token, options.settings.devin.apiKey].filter((value): value is string => value !== null);
  }

  connect(sources: DashboardSources): void {
    this.#sources = sources;
  }

  /** No providers can be read; responses are unavailable, or stale if a snapshot was read earlier. */
  disconnect(reason: string): void {
    this.#sources = null;
    this.#problems = [{ source: 'workflow', reason }];
  }

  /** Serialized: a call while a refresh is in flight runs one more refresh after it, shared by every such call. */
  refresh(): Promise<void> {
    if (this.#refreshing === null) {
      this.#refreshing = this.#refresh().finally(() => {
        this.#refreshing = null;
      });
      return this.#refreshing;
    }
    this.#queued ??= this.#refreshing.then(() => {
      this.#queued = null;
      return this.refresh();
    });
    return this.#queued;
  }

  overview(): OverviewResponse {
    return this.#sanitize({ refresh: this.#status(), overview: this.#snapshot?.overview ?? null });
  }

  metrics(): MetricsResponse {
    return this.#sanitize({ refresh: this.#status(), metrics: this.#snapshot?.metrics ?? null });
  }

  settings(): SettingsResponse {
    return this.#sanitize({ refresh: this.#status(), settings: effectiveSettings(this.#settings) });
  }

  #status(): RefreshStatus {
    const snapshot = this.#snapshot;
    const state = snapshot === null ? 'unavailable' : this.#problems.length === 0 ? 'current' : 'stale';
    return { state, lastRefreshAt: snapshot?.at ?? null, lastAttemptAt: this.#lastAttemptAt, problems: this.#problems.map((problem) => ({ ...problem })) };
  }

  #sanitize<T>(value: T): T {
    return JSON.parse(redact(JSON.stringify(value), this.#secrets)) as T;
  }

  async #refresh(): Promise<void> {
    const sources = this.#sources;
    if (sources === null) return;
    const now = this.#now();
    const records = sources.store.list();
    const problems: RefreshProblem[] = [];

    let issues: OverviewIssue[] | null = null;
    try {
      issues = await this.#readIssues(sources, records);
    } catch (error) {
      problems.push({ source: 'github', reason: describe(error) });
    }
    const github = issues === null
      ? null
      : await guarded(() => readGitHubEvidence(sources.tracker, records, this.#settings.baselineFilter, now));
    if (github?.status === 'unavailable') problems.push({ source: 'github', reason: github.reason });
    const devin = await guarded(() => readDevinEvidence(sources.devin, now));
    if (devin.status === 'unavailable') problems.push({ source: 'devin', reason: devin.reason });

    this.#lastAttemptAt = now.toISOString();
    if (issues === null || github === null || problems.length > 0) {
      this.#problems = problems;
      return;
    }
    const repo = sources.tracker.repo;
    const repository = `${repo.owner}/${repo.name}`;
    const metrics = calculateMetrics({
      now,
      target: repository,
      recordSets: [{ mode: 'live', engine: 'current', records }],
      settings: { ...this.#settings.cost, maxAcuPerSession: this.#settings.devin.maxAcuPerSession, baselineFilter: this.#settings.baselineFilter },
      evidence: { github, devin, orchestrator: { status: 'available', value: { lastCycleAt: sources.lastCycleAt() } } },
    });
    this.#snapshot = { at: now.toISOString(), overview: this.#overview(repository, issues, metrics), metrics };
    this.#problems = [];
  }

  async #readIssues(sources: DashboardSources, records: readonly BugRecord[]): Promise<OverviewIssue[]> {
    const { tracker } = sources;
    const labels = this.#settings.labels;
    const open = await tracker.listOpenIssues([labels.triage, labels.fix, labels.engineer, labels.feature]);
    const issues = new Map(open.map((issue) => [issue.number, issue]));
    const tracked = new Map<number, BugRecord>();
    for (const record of records) {
      const parts = parseBugKey(record.key);
      if (parts === null || parts.owner !== tracker.repo.owner || parts.repo !== tracker.repo.name) continue;
      tracked.set(parts.number, record);
      if (!issues.has(parts.number)) issues.set(parts.number, await tracker.getIssue(parts.number));
    }
    const result: OverviewIssue[] = [];
    for (const issue of [...issues.values()].sort((a, b) => a.number - b.number)) {
      const record = tracked.get(issue.number);
      const pr = record?.fix == null ? null : await tracker.getPullRequest(record.fix.prNumber);
      const presentation = presentBug(record, toGitHubFacts(tracker.repo, issue, pr), labels);
      result.push(overviewIssue(issue, record, pr, presentation));
    }
    return result;
  }

  #overview(repository: string, issues: OverviewIssue[], metrics: MetricsReport): Overview {
    const groups = countsOf(OVERVIEW_GROUPS);
    const statuses = countsOf(STATUS_CODES);
    const gates = countsOf(GATES);
    for (const issue of issues) {
      groups[issue.group] += 1;
      statuses[issue.status] += 1;
      if (issue.attention.gate !== null) gates[issue.attention.gate] += 1;
    }
    const keys = metrics.live?.keys ?? null;
    return {
      repository,
      headline: keys === null
        ? null
        : { fixThroughput: keys.fixThroughput, timeToFixMedian: keys.timeToFixMedian, firstTimePass: keys.firstTimePass, escapedFixes: keys.escapedFixes },
      counts: { issues: issues.length, groups, statuses, gates },
      issues,
    };
  }
}
