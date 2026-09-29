import { parseBugKey } from '../model/keys.ts';
import { currentHeadVerification, currentMergeVerifications } from '../model/presentation.ts';
import type { BugRecord, Decision, FixInfo, HandoffReason, Recommendation, Stage, VerificationAttempt, WorkRoute } from '../model/types.ts';
import {
  allTime,
  count,
  DAY_MS,
  hoursBetween,
  HOUR_MS,
  inWindow,
  median,
  noData,
  pointInTime,
  previousWindow,
  rate,
  recentWindow,
  sampleFigure,
  trendWeeks,
  unavailable,
  valueFigure,
  type FigureBase,
} from './stats.ts';
import type {
  CohortMetrics,
  CostMetrics,
  CrossCheckMetrics,
  DevinEvidence,
  Engine,
  Figure,
  GitHubEvidence,
  IssueActivity,
  LivenessMetrics,
  MetricsInput,
  MetricsReport,
  MetricWindow,
  PullRequestFacts,
  RecordMode,
  RecordRow,
  SessionCost,
  SessionFact,
  ThroughputWeek,
} from './types.ts';

export const NOT_REPORTED = 'Not reported by Devin on this plan';
export const BASELINE_MIN_SAMPLES = 5;
export const UNANSWERED_AFTER_MS = 2 * DAY_MS;
export const STALLED_AFTER_MS = 2 * HOUR_MS;
export const LARGEST_SESSIONS = 5;

/** Handoffs that count as a failed fix; other reasons are a person's or Devin's own choice. */
export const FAILURE_REASONS = ['verification-failed', 'verification-error', 'session-ended', 'pr-closed-unmerged'] as const satisfies readonly HandoffReason[];
const FAILURE_LABELS: Record<(typeof FAILURE_REASONS)[number], string> = {
  'verification-failed': 'verification failed twice',
  'verification-error': 'verification could not run',
  'session-ended': 'the session ended',
  'pr-closed-unmerged': 'the pull request was closed unmerged',
};

const OPEN_STAGES = ['queued', 'triaging', 'needs-input', 'triaged', 'fixing', 'verifying', 'ready-to-merge', 'with-engineer'] as const satisfies readonly Stage[];
const DECISION_STAGES = [
  { stage: 'needs-input', label: 'answer to Devin' },
  { stage: 'triaged', label: 'fix, engineer or close decision' },
  { stage: 'ready-to-merge', label: 'merge decision' },
] as const satisfies readonly { stage: Stage; label: string }[];
const RECOMMENDATION_ACTIONS: Record<Recommendation, Decision['action']> = { devin_fix: 'fix', needs_engineer: 'engineer', close: 'close' };
const TRIAGE_DECISIONS: readonly Decision['action'][] = ['fix', 'engineer', 'close', 'triage'];
const PEOPLE_ACTIONS = ['filed', 'answered', 'decided', 'merged'] as const;
type PeopleAction = (typeof PEOPLE_ACTIONS)[number];
const POLICY_RULES = {
  fix: { rule: 'policy:decision-rule', auto: 'policy:decision-auto' },
  engineer: { rule: 'policy:decision-rule', auto: 'policy:decision-auto' },
  merge: { rule: 'policy:merge-rule', auto: 'policy:merge-auto' },
} as const;

const SOURCE = {
  records: 'bug store records',
  proof: 'bug store merge records and independent verification attempts',
  github: 'GitHub issues and pull requests',
  sessions: 'Devin session list (Bug Smasher tags)',
  insights: 'Devin Session Insights',
  devinMetrics: "Devin's organisation metrics endpoints",
};

function repositoryOf(key: string): string {
  const parts = parseBugKey(key);
  return parts === null ? key : `${parts.owner}/${parts.repo}`;
}

function isPersonActor(actor: string): boolean {
  return actor.startsWith('github:') || actor.startsWith('interface:');
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function later(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

function latestEntryAtOrBefore(record: BugRecord, stage: Stage, at: string): string | null {
  let found: string | null = null;
  for (const entry of record.stageHistory) {
    if (entry.stage === stage && !later(entry.at, at)) found = entry.at;
  }
  return found;
}

/** When the record became ready to merge, if that was its stage when the fix merged. */
function readySinceBeforeMerge(record: BugRecord, mergedAt: string): string | null {
  const before = record.stageHistory.filter((entry) => entry.stage !== 'merged' && !later(entry.at, mergedAt)).at(-1);
  return before?.stage === 'ready-to-merge' ? before.at : null;
}

function currentStageSince(record: BugRecord): string {
  return record.stageHistory.at(-1)?.at ?? record.updatedAt;
}

// Proof ------------------------------------------------------------------------------------------------------

export interface FixAssessment {
  record: BugRecord;
  fix: FixInfo;
  pullRequest: string;
  mergedAt: string | null;
  /** When post-merge verification proved the fix; `null` while it is not fixed and proven. */
  provenAt: string | null;
  /** Why the fix does not count in throughput; `null` when it is fixed and proven. */
  unproven: string | null;
  /** Why the fix escaped after the merge; `null` when it held. */
  escaped: string | null;
}

interface Evidence {
  github: GitHubEvidence | null;
  githubReason: string;
  issues: Map<string, IssueActivity>;
  pulls: Map<string, PullRequestFacts>;
}

function pullKey(record: BugRecord, fix: FixInfo): string {
  return `${repositoryOf(record.key)}#${fix.prNumber}`;
}

export function mergedFixes(record: BugRecord): FixInfo[] {
  return [...record.priorFixes, ...(record.fix === null ? [] : [record.fix])].filter((fix) => fix.mergeCommitSha !== null);
}

function assessFix(record: BugRecord, fix: FixInfo, evidence: Evidence): FixAssessment {
  const key = pullKey(record, fix);
  const pr = evidence.pulls.get(key) ?? null;
  const mergedAt = fix.mergedAt ?? pr?.mergedAt ?? null;
  const mergeCommit = fix.mergeCommitSha as string;
  const post = record.verifications.filter((attempt) => attempt.phase === 'post-merge' && attempt.headSha === mergeCommit);
  const verifiedAtHead = record.verifications.some(
    (attempt) => attempt.phase === 'pre-merge' && attempt.headSha === fix.headSha && attempt.result === 'pass',
  );
  let unproven: string | null = null;
  let escaped: string | null = null;
  const postFailed = post.find((attempt) => attempt.result === 'fail');
  if (postFailed !== undefined) escaped = `failed verification on merge commit ${short(mergeCommit)}`;

  if (pr !== null && pr.state !== 'merged') unproven = 'GitHub does not report the pull request as merged';
  else if (pr !== null && pr.headSha !== fix.headSha) unproven = `merged at ${short(pr.headSha)}, not the recorded head ${short(fix.headSha)}`;
  else if (pr !== null && pr.mergeCommitSha !== mergeCommit) unproven = `GitHub reports merge commit ${short(pr.mergeCommitSha ?? '')}, not ${short(mergeCommit)}`;
  else if (!verifiedAtHead) unproven = `merged commit ${short(fix.headSha)} did not pass verification`;
  else if (postFailed !== undefined) unproven = escaped;
  else if (post.at(-1)?.result !== 'pass') unproven = `not yet verified on merge commit ${short(mergeCommit)}`;
  else if (mergedAt === null) unproven = 'merge time unknown';

  if (escaped === null && evidence.github !== null && mergedAt !== null) {
    const revert = evidence.github.reverts.find((candidate) => candidate.fixKey === key && later(candidate.mergedAt, mergedAt));
    if (revert !== undefined) escaped = `reverted by ${revert.revertUrl}`;
    const reopened = evidence.issues.get(record.key)?.events.find((event) => event.type === 'reopened' && later(event.at, mergedAt));
    if (escaped === null && reopened !== undefined) escaped = `issue reopened ${reopened.at}`;
  }
  const provenAt = unproven === null ? (post.at(-1)?.at ?? null) : null;
  return { record, fix, pullRequest: fix.prUrl, mergedAt, provenAt, unproven, escaped };
}

// Cohorts ----------------------------------------------------------------------------------------------------

interface Cohort {
  id: string;
  label: string;
  repository: string;
  mode: RecordMode;
  engine: Engine;
  live: boolean;
  records: BugRecord[];
}

function cohortsOf(input: MetricsInput): Cohort[] {
  const byId = new Map<string, Cohort>();
  for (const set of input.recordSets) {
    for (const record of set.records) {
      const repository = repositoryOf(record.key);
      const id = `${repository}:${set.mode}:${set.engine}`;
      let cohort = byId.get(id);
      if (cohort === undefined) {
        const live = input.target !== null && repository === input.target && set.mode === 'live' && set.engine === 'current';
        const detail = [set.mode, ...(set.engine === 'v1' ? ['v1 engine'] : []), ...(live || input.target === null || repository === input.target ? [] : ['not the target repository'])];
        cohort = { id, label: `${repository} (${detail.join(', ')})`, repository, mode: set.mode, engine: set.engine, live, records: [] };
        byId.set(id, cohort);
      }
      cohort.records.push(record);
    }
  }
  return [...byId.values()].sort((a, b) => Number(b.live) - Number(a.live) || a.id.localeCompare(b.id));
}

function evidenceFor(repository: string, input: MetricsInput): Evidence {
  const github = input.evidence.github;
  if (github.status === 'unavailable') return { github: null, githubReason: `GitHub was not read: ${github.reason}`, issues: new Map(), pulls: new Map() };
  if (github.value.repository !== repository) {
    return { github: null, githubReason: `GitHub was read for ${github.value.repository} only`, issues: new Map(), pulls: new Map() };
  }
  return {
    github: github.value,
    githubReason: '',
    issues: new Map(github.value.issues.map((issue) => [issue.key, issue])),
    pulls: new Map(github.value.pullRequests.map((pr) => [pr.key, pr])),
  };
}

function base(id: string, label: string, unit: FigureBase['unit'], window: MetricWindow, source: string): FigureBase {
  return { id, label, unit, window, source };
}

function cohortMetrics(cohort: Cohort, input: MetricsInput): CohortMetrics {
  const now = input.now;
  const evidence = evidenceFor(cohort.repository, input);
  const bugs = cohort.records.filter((record) => record.kind === 'bug');
  const fixes = bugs.flatMap((record) => mergedFixes(record).map((fix) => assessFix(record, fix, evidence)));
  const recent = recentWindow(now);
  const previous = previousWindow(now);
  const proofSource = evidence.github === null ? `${SOURCE.proof} (${evidence.githubReason})` : `${SOURCE.proof}, checked against ${SOURCE.github}`;

  // Fix throughput
  const trend: ThroughputWeek[] = trendWeeks(now).map((window) => {
    const merged = fixes.filter((fix) => inWindow(fix.mergedAt, window));
    const proven = merged.filter((fix) => fix.unproven === null);
    return {
      figure: count(base(`fix-throughput:${window.start}`, 'Bugs fixed and proven', 'count', window, proofSource), proven.length, merged.length, 'No bug fix was merged in this week'),
      excluded: merged
        .filter((fix) => fix.unproven !== null)
        .map((fix) => ({ key: fix.record.key, pullRequest: fix.pullRequest, reason: fix.unproven as string })),
    };
  });
  const thisWeek = trend.at(-1) as ThroughputWeek;
  const lastWeek = trend.at(-2) as ThroughputWeek;
  const fixThroughput = {
    figure: { ...thisWeek.figure, id: 'fix-throughput', label: 'Fix throughput (bugs fixed and proven this week)' },
    reference: { ...lastWeek.figure, id: 'fix-throughput.previous', label: 'Previous week' },
  };

  // Time to fix
  const ttfBase = (id: string, label: string): FigureBase => base(id, label, 'hours', recent, `${SOURCE.github} (issue filed) and ${SOURCE.proof} (merge)`);
  let timeToFixMedian: Figure;
  let timeToFixP90: Figure;
  const provenRecent = fixes.filter((fix) => fix.unproven === null && inWindow(fix.mergedAt, recent));
  if (evidence.github === null) {
    timeToFixMedian = unavailable(ttfBase('time-to-fix.median', 'Time to fix (median)'), evidence.githubReason);
    timeToFixP90 = unavailable(ttfBase('time-to-fix.p90', 'Time to fix (90th percentile)'), evidence.githubReason);
  } else {
    const durations = provenRecent.flatMap((fix) => {
      const filed = evidence.issues.get(fix.record.key)?.createdAt;
      return filed === undefined ? [] : [hoursBetween(filed, fix.mergedAt as string)];
    });
    timeToFixMedian = sampleFigure(ttfBase('time-to-fix.median', 'Time to fix (median)'), durations, 'median', 'No bug fixed and proven in the window');
    timeToFixP90 = sampleFigure(ttfBase('time-to-fix.p90', 'Time to fix (90th percentile)'), durations, 'p90', 'No bug fixed and proven in the window');
  }
  const timeToFix = { figure: timeToFixMedian, reference: baselineFigure(input, evidence, cohort) };

  // First-time pass rate
  const firstTime = (window: MetricWindow, id: string, label: string): Figure => {
    const groups = new Map<string, VerificationAttempt[]>();
    for (const record of bugs) {
      for (const attempt of record.verifications) {
        if (attempt.phase !== 'pre-merge' || attempt.result === 'error') continue;
        const group = `${record.key}|${attempt.sessionId ?? ''}`;
        groups.set(group, [...(groups.get(group) ?? []), attempt]);
      }
    }
    const firsts = [...groups.values()].map((attempts) => attempts[0] as VerificationAttempt).filter((attempt) => inWindow(attempt.at, window));
    return rate(
      { id, label, window, source: `${SOURCE.records} (pre-merge verification attempts per fix session; errors are not attempts)` },
      firsts.filter((attempt) => attempt.result === 'pass').length,
      firsts.length,
      'No pull request was first verified in the window',
    );
  };

  const escapedRate = (window: MetricWindow, id: string, label: string): Figure => {
    const merged = fixes.filter((fix) => inWindow(fix.mergedAt, window));
    return rate(
      { id, label, window, source: evidence.github === null ? `${SOURCE.proof} (${evidence.githubReason}; reverts and reopens not checked)` : `${SOURCE.proof}, ${SOURCE.github} (reverts, reopens)` },
      merged.filter((fix) => fix.escaped !== null).length,
      merged.length,
      'No bug fix was merged in the window',
    );
  };

  return {
    id: cohort.id,
    label: cohort.label,
    repository: cohort.repository,
    mode: cohort.mode,
    engine: cohort.engine,
    live: cohort.live,
    records: cohort.records.length,
    bugs: bugs.length,
    features: cohort.records.length - bugs.length,
    keys: {
      fixThroughput,
      trend,
      timeToFixMedian: timeToFix,
      timeToFixP90,
      firstTimePass: { figure: firstTime(recent, 'first-time-pass', 'First-time pass rate'), reference: firstTime(previous, 'first-time-pass.previous', 'Previous 30 days') },
      escapedFixes: { figure: escapedRate(recent, 'escaped-fixes', 'Escaped-fix rate'), reference: escapedRate(previous, 'escaped-fixes.previous', 'Previous 30 days') },
    },
    flow: flowMetrics(bugs, fixes, evidence, now),
    adoption: adoptionMetrics(bugs, evidence, now),
  };
}

function baselineFigure(input: MetricsInput, evidence: Evidence, cohort: Cohort): Figure {
  const window = allTime(input.now.toISOString(), 'repository history');
  const figureBase = base('time-to-fix.baseline', 'Repository median for comparable closed issues', 'hours', window, `${SOURCE.github} closed issues matching BASELINE_FILTER`);
  if (input.settings.baselineFilter === null) return unavailable(figureBase, 'BASELINE_FILTER is not set', 'Insufficient history: BASELINE_FILTER is not set');
  if (evidence.github === null) return unavailable(figureBase, evidence.githubReason);
  const baseline = evidence.github.baseline;
  if (baseline.status === 'unavailable') return unavailable(figureBase, baseline.reason);
  const tracked = new Set(cohort.records.map((record) => parseBugKey(record.key)?.number));
  const durations = baseline.value.issues.filter((issue) => !tracked.has(issue.number)).map((issue) => hoursBetween(issue.createdAt, issue.closedAt));
  if (durations.length < BASELINE_MIN_SAMPLES) {
    return {
      ...noData(figureBase, `${durations.length} comparable closed issues match BASELINE_FILTER "${baseline.value.filter}"; at least ${BASELINE_MIN_SAMPLES} are needed`, durations.length),
      display: `Insufficient history (${durations.length} comparable closed issues)`,
    };
  }
  return valueFigure(figureBase, median(durations) as number, { samples: durations.length });
}

function flowMetrics(bugs: BugRecord[], fixes: FixAssessment[], evidence: Evidence, now: Date): CohortMetrics['flow'] {
  const recent = recentWindow(now);
  const point = pointInTime(now);
  const bugsIn = trendWeeks(now).map((window) => {
    const n = bugs.filter((record) => inWindow(record.createdAt, window)).length;
    return count({ id: `bugs-in:${window.start}`, label: 'Bugs in', window, source: `${SOURCE.records} (enrolment time)` }, n, n, 'No bug was sent on in this week');
  });
  const open = bugs.filter((record) => (OPEN_STAGES as readonly Stage[]).includes(record.stage));
  const openByStage = OPEN_STAGES.map((stage) =>
    count({ id: `open-bugs:${stage}`, label: `Open bugs: ${stage}`, window: point, source: SOURCE.records }, open.filter((record) => record.stage === stage).length, open.length, 'No open bugs'),
  );
  const longestWait = DECISION_STAGES.map(({ stage, label }) => {
    const waits = bugs.filter((record) => record.stage === stage).map((record) => hoursBetween(currentStageSince(record), now.toISOString()));
    return sampleFigure(base(`longest-wait:${stage}`, `Longest wait for ${label}`, 'hours', point, `${SOURCE.records} (stage history)`), waits, 'max', `No bug is waiting for ${label}`);
  });

  const takenIn = bugs.filter((record) => inWindow(record.createdAt, recent));
  const provenKeys = new Set(fixes.filter((fix) => fix.unproven === null).map((fix) => fix.record.key));
  const resolution = rate(
    { id: 'resolution', label: 'Resolution rate', window: recent, source: `${SOURCE.records} (enrolment time, fixed and proven or closed)` },
    takenIn.filter((record) => provenKeys.has(record.key) || record.stage === 'closed').length,
    takenIn.length,
    'No bug was taken in over the window',
  );

  const sentToFix = bugs.filter((record) => inWindow(record.stageHistory.find((entry) => entry.stage === 'fixing')?.at, recent));
  const failedWith = (reason: HandoffReason): number =>
    sentToFix.filter((record) => record.stage === 'with-engineer' && record.handoff?.reason === reason).length;
  const failureSource = `${SOURCE.records} (first sent to a fix in the window; current handoff reason)`;
  const failure = rate(
    { id: 'failure', label: 'Failure rate', window: recent, source: failureSource },
    FAILURE_REASONS.reduce((sum, reason) => sum + failedWith(reason), 0),
    sentToFix.length,
    'No bug was sent to a fix in the window',
  );
  const failureByReason = FAILURE_REASONS.map((reason) =>
    rate({ id: `failure:${reason}`, label: `Failure rate: ${FAILURE_LABELS[reason]}`, window: recent, source: failureSource }, failedWith(reason), sentToFix.length, 'No bug was sent to a fix in the window'),
  );

  const sizeSource = `${SOURCE.github} (pull request additions, deletions and changed files)`;
  const mergedRecent = fixes.filter((fix) => inWindow(fix.mergedAt, recent));
  const sizes = mergedRecent.flatMap((fix) => {
    const pr = evidence.pulls.get(pullKey(fix.record, fix.fix));
    return pr === undefined ? [] : [{ lines: pr.additions + pr.deletions, files: pr.changedFiles }];
  });
  const sizeFigures = (unit: 'lines' | 'files'): Figure[] =>
    (['min', 'median', 'max'] as const).map((stat) => {
      const label = `Fix size in ${unit} (${stat === 'min' ? 'smallest' : stat === 'max' ? 'largest' : 'median'})`;
      const figureBase = base(`fix-size:${unit}:${stat}`, label, unit, recent, sizeSource);
      if (evidence.github === null) return unavailable(figureBase, evidence.githubReason);
      return sampleFigure(figureBase, sizes.map((size) => size[unit]), stat, 'No bug fix was merged in the window');
    });

  return { bugsIn, openByStage, longestWait, resolution, failure, failureByReason, fixSizeLines: sizeFigures('lines'), fixSizeFiles: sizeFigures('files') };
}

/** Who merged a fix: `null` when a Rule or Automatic merge policy did it. */
function personMerge(record: BugRecord, fix: FixInfo): string | null {
  if (fix.mergedAt === null || fix.mergedAt === undefined || fix.mergedBy === null || fix.mergedBy === undefined) return null;
  const mergedAt = fix.mergedAt;
  const earlier = mergedFixes(record)
    .map((candidate) => candidate.mergedAt)
    .filter((at): at is string => typeof at === 'string' && later(mergedAt, at));
  const since = earlier.sort().at(-1) ?? null;
  const byPolicy = record.decisions.some(
    (decision) => decision.action === 'merge' && decision.actor.startsWith('policy:') && !later(decision.at, mergedAt) && (since === null || later(decision.at, since)),
  );
  return byPolicy ? null : fix.mergedBy;
}

function adoptionMetrics(bugs: BugRecord[], evidence: Evidence, now: Date): CohortMetrics['adoption'] {
  const recent = recentWindow(now);
  const point = pointInTime(now);

  // People: every action with who and when.
  const acts: { action: PeopleAction; person: string; at: string }[] = [];
  for (const record of bugs) {
    const issue = evidence.issues.get(record.key);
    if (issue !== undefined && issue.author !== null && !issue.author.bot) acts.push({ action: 'filed', person: issue.author.login, at: issue.createdAt });
    for (const question of record.questions) {
      if (issue === undefined || question.answeredAt === null) continue;
      const answeredAt = question.answeredAt;
      const reply = issue.comments
        .filter((comment) => !comment.fromService && comment.author !== null && !comment.author.bot && later(comment.at, question.askedAt) && !later(comment.at, answeredAt))
        .at(-1);
      if (reply?.author) acts.push({ action: 'answered', person: reply.author.login, at: reply.at });
    }
    for (const decision of record.decisions) {
      if (decision.actor.startsWith('github:') && TRIAGE_DECISIONS.includes(decision.action)) {
        acts.push({ action: 'decided', person: decision.actor.slice('github:'.length), at: decision.at });
      }
    }
    for (const fix of mergedFixes(record)) {
      const person = personMerge(record, fix);
      if (person !== null && person.startsWith('github:') && fix.mergedAt) acts.push({ action: 'merged', person: person.slice('github:'.length), at: fix.mergedAt });
    }
  }
  const peopleSource = `${SOURCE.github} (issue authors, replies to Devin) and ${SOURCE.records} (label decisions, merges)`;
  const people = (id: string, label: string, window: MetricWindow, actions: readonly PeopleAction[]): Figure => {
    const figureBase = { id, label, window, source: peopleSource };
    if (evidence.github === null && actions.some((action) => action === 'filed' || action === 'answered')) {
      return unavailable({ ...figureBase, unit: 'count' }, evidence.githubReason);
    }
    const matching = acts.filter((act) => actions.includes(act.action) && inWindow(act.at, window));
    return count(figureBase, new Set(matching.map((act) => act.person.toLowerCase())).size, matching.length, 'No person acted in the window');
  };
  const peopleByWeek = trendWeeks(now).map((window) => people(`people:${window.start}`, 'People involved', window, PEOPLE_ACTIONS));
  const peopleByAction = PEOPLE_ACTIONS.map((action) => people(`people:${action}`, `People who ${action === 'filed' ? 'filed a bug' : action === 'answered' ? 'answered Devin' : action === 'decided' ? 'made a decision' : 'merged a fix'}`, recent, [action]));

  // Response times.
  const questions = bugs.flatMap((record) => record.questions);
  const answerTime = sampleFigure(
    base('response:answer', 'Median time to answer Devin', 'hours', recent, `${SOURCE.records} (question asked and answered times)`),
    questions.filter((question) => question.answeredAt !== null && inWindow(question.answeredAt, recent)).map((question) => hoursBetween(question.askedAt, question.answeredAt as string)),
    'median',
    'No question was answered in the window',
  );
  const decisionTime = (['fix', 'engineer', 'close', 'merge'] as const).map((action) => {
    const waits: number[] = [];
    for (const record of bugs) {
      if (action === 'merge') {
        for (const fix of mergedFixes(record)) {
          if (personMerge(record, fix) === null || !inWindow(fix.mergedAt, recent)) continue;
          const since = readySinceBeforeMerge(record, fix.mergedAt as string);
          if (since !== null) waits.push(hoursBetween(since, fix.mergedAt as string));
        }
        continue;
      }
      for (const decision of record.decisions) {
        if (decision.action !== action || !isPersonActor(decision.actor) || !inWindow(decision.at, recent)) continue;
        const since = latestEntryAtOrBefore(record, 'triaged', decision.at);
        if (since !== null) waits.push(hoursBetween(since, decision.at));
      }
    }
    return sampleFigure(
      base(`response:${action}`, `Median time to decide ${action}`, 'hours', recent, `${SOURCE.records} (${action === 'merge' ? 'ready to merge until merged' : 'investigation finished until the decision'})`),
      waits,
      'median',
      `No person decided ${action} in the window`,
    );
  });
  const openQuestions = bugs
    .filter((record) => (OPEN_STAGES as readonly Stage[]).includes(record.stage))
    .flatMap((record) => record.questions)
    .filter((question) => question.answeredAt === null);
  const unansweredQuestions = count(
    { id: 'unanswered-questions', label: 'Questions unanswered after two days', window: point, source: `${SOURCE.records} (open questions)` },
    openQuestions.filter((question) => now.getTime() - Date.parse(question.askedAt) >= UNANSWERED_AFTER_MS).length,
    openQuestions.length,
    'No open questions',
  );

  // Agreement: the first triage decision after the latest investigation, when a person made it.
  const agreementSamples: { recommendation: Recommendation; agreed: boolean }[] = [];
  for (const record of bugs) {
    if (record.triage === null) continue;
    const triaged = record.stageHistory.filter((entry) => entry.stage === 'triaged').at(-1);
    if (triaged === undefined) continue;
    const decision = record.decisions.find((candidate) => TRIAGE_DECISIONS.includes(candidate.action) && !later(triaged.at, candidate.at));
    if (decision === undefined || !isPersonActor(decision.actor) || !inWindow(decision.at, recent)) continue;
    agreementSamples.push({ recommendation: record.triage.recommendation, agreed: RECOMMENDATION_ACTIONS[record.triage.recommendation] === decision.action });
  }
  const agreement = (Object.keys(RECOMMENDATION_ACTIONS) as Recommendation[]).map((recommendation) => {
    const samples = agreementSamples.filter((sample) => sample.recommendation === recommendation);
    return rate(
      { id: `agreement:${recommendation}`, label: `Agreement when Devin recommends ${recommendation}`, window: recent, source: `${SOURCE.records} (Devin's recommendation and the person's decision)` },
      samples.filter((sample) => sample.agreed).length,
      samples.length,
      `No person decided on a ${recommendation} recommendation in the window`,
    );
  });

  // Automation share per decision, as actually made.
  const automation = (['fix', 'engineer', 'merge'] as const).flatMap((action) => {
    let actors: string[];
    if (action === 'merge') {
      actors = bugs.flatMap((record) =>
        mergedFixes(record)
          .filter((fix) => inWindow(fix.mergedAt, recent))
          .map((fix) => {
            if (personMerge(record, fix) !== null) return 'person';
            const policy = record.decisions.filter((decision) => decision.action === 'merge' && decision.actor.startsWith('policy:') && !later(decision.at, fix.mergedAt as string)).at(-1);
            return policy?.actor ?? 'person';
          }),
      );
    } else {
      actors = bugs.flatMap((record) => record.decisions.filter((decision) => decision.action === action && inWindow(decision.at, recent)).map((decision) => decision.actor));
    }
    return (['rule', 'auto'] as const).map((policy) =>
      rate(
        { id: `automation:${action}:${policy}`, label: `${action} decisions made by the ${policy === 'rule' ? 'Rule' : 'Automatic'} policy`, window: recent, source: `${SOURCE.records} (decision actors)` },
        actors.filter((actor) => actor === POLICY_RULES[action][policy]).length,
        actors.length,
        `No ${action} decision was made in the window`,
      ),
    );
  });

  return { peopleByWeek, peopleByAction, answerTime, decisionTime, unansweredQuestions, agreement, automation };
}

// Cost -------------------------------------------------------------------------------------------------------

function scopedSessions(input: MetricsInput, devin: DevinEvidence): SessionFact[] {
  return devin.sessions.filter((session) => input.target === null || (session.bugKey !== null && repositoryOf(session.bugKey) === input.target));
}

function costMetrics(input: MetricsInput, live: CohortMetrics | null, liveFixes: FixAssessment[]): CostMetrics {
  const { settings } = input;
  const devin = input.evidence.devin;
  const sessions = devin.status === 'available' ? scopedSessions(input, devin.value) : null;
  const scopeName = input.target ?? 'all repositories';
  const provenBy = (end: string): number => liveFixes.filter((fix) => fix.provenAt !== null && !later(fix.provenAt, end)).length;
  const fixedNote = live === null ? 'There is no live cohort for the target repository' : 'No bug has been fixed and proven yet';

  const acusComplete = sessions !== null && sessions.length > 0 && sessions.every((session) => session.acus !== null);
  const capWindow = allTime(devin.status === 'available' ? devin.value.readAt : input.now.toISOString(), 'to date');
  const capBase = { id: 'sessions-at-cap', label: 'Sessions stopped at the cap', window: capWindow, source: `${SOURCE.sessions} (status detail usage_limit_exceeded, or reported ACUs at MAX_ACU_PER_SESSION)` };
  const sessionsAtCap =
    sessions === null
      ? unavailable({ ...capBase, unit: 'count' }, `Devin was not read: ${devin.status === 'unavailable' ? devin.reason : ''}`)
      : count(
          capBase,
          sessions.filter((session) => session.statusDetail === 'usage_limit_exceeded' || (session.acus !== null && session.acus >= settings.maxAcuPerSession)).length,
          sessions.length,
          'No Bug Smasher sessions',
        );

  if (acusComplete && settings.acuPriceUsd !== null && devin.status === 'available' && sessions !== null) {
    const price = settings.acuPriceUsd;
    const readAt = devin.value.readAt;
    const window = allTime(readAt, `to ${readAt}`);
    const source = `ACUs reported by the Devin API × $${price} per ACU (DEVIN_ACU_PRICE_USD)`;
    const costs: SessionCost[] = sessions.map((session) => ({ id: session.id, bugKey: session.bugKey, route: session.route, acus: session.acus as number, usd: (session.acus as number) * price }));
    const total = costs.reduce((sum, cost) => sum + cost.usd, 0);
    const totalAcus = costs.reduce((sum, cost) => sum + cost.acus, 0);
    const fixed = provenBy(readAt);
    const usd = (id: string, label: string): FigureBase => base(id, label, 'usd', window, source);
    const byRoute = (['triage', 'fix'] as const satisfies readonly WorkRoute[]).map((route) => {
      const routeCosts = costs.filter((cost) => cost.route === route);
      const sum = routeCosts.reduce((acc, cost) => acc + cost.usd, 0);
      return routeCosts.length === 0
        ? noData(usd(`cost-per-session:${route}`, `Cost per ${route} session`), `No ${route} sessions`)
        : valueFigure(usd(`cost-per-session:${route}`, `Cost per ${route} session`), sum / routeCosts.length, { numerator: sum, denominator: routeCosts.length, samples: routeCosts.length });
    });
    return {
      source: 'acus',
      sourceLabel: `${source}, read ${readAt}`,
      readAt,
      scope: `Every Bug Smasher session for ${scopeName} (${sessions.length}), successful or not, to ${readAt}`,
      totalSpend: valueFigure(usd('total-spend', 'Total spend'), total, { numerator: totalAcus, denominator: null, samples: sessions.length, note: `${totalAcus} ACUs` }),
      budgetRemaining: budgetFigure(settings.budgetUsd, total, window, source),
      costPerFixedBug:
        fixed === 0
          ? noData(usd('cost-per-fixed-bug', 'Cost per fixed bug'), fixedNote)
          : valueFigure(usd('cost-per-fixed-bug', 'Cost per fixed bug'), total / fixed, { numerator: total, denominator: fixed, samples: fixed }),
      costPerSession: valueFigure(usd('cost-per-session', 'Cost per session'), total / sessions.length, { numerator: total, denominator: sessions.length, samples: sessions.length }),
      costPerSessionByRoute: byRoute,
      largestSessions: [...costs].sort((a, b) => b.acus - a.acus || a.id.localeCompare(b.id)).slice(0, LARGEST_SESSIONS),
      sessionsAtCap,
    };
  }

  if (settings.spendUsd !== null && settings.spendReadAt !== null) {
    const spend = settings.spendUsd;
    const readAt = settings.spendReadAt;
    const window = allTime(readAt, `to ${readAt}`);
    const source = 'Manual reading from the Devin web app (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT)';
    const usd = (id: string, label: string): FigureBase => base(id, label, 'usd', window, source);
    const fixed = provenBy(readAt);
    const counted = sessions?.filter((session) => !later(session.createdAt, readAt)) ?? null;
    return {
      source: 'manual',
      sourceLabel: `${source}, read ${readAt}`,
      readAt,
      scope: `Devin organisation spend to ${readAt}; averaged over Bug Smasher sessions and bugs fixed and proven for ${scopeName} by that time`,
      totalSpend: valueFigure(usd('total-spend', 'Total spend'), spend, { samples: 1 }),
      budgetRemaining: budgetFigure(settings.budgetUsd, spend, window, source),
      costPerFixedBug:
        fixed === 0 ? noData(usd('cost-per-fixed-bug', 'Cost per fixed bug'), fixedNote) : valueFigure(usd('cost-per-fixed-bug', 'Cost per fixed bug'), spend / fixed, { numerator: spend, denominator: fixed, samples: fixed }),
      costPerSession:
        counted === null
          ? unavailable(usd('cost-per-session', 'Cost per session'), `Devin sessions were not read: ${devin.status === 'unavailable' ? devin.reason : ''}`)
          : counted.length === 0
            ? noData(usd('cost-per-session', 'Cost per session'), 'No Bug Smasher sessions by the read time')
            : valueFigure(usd('cost-per-session', 'Cost per session'), spend / counted.length, { numerator: spend, denominator: counted.length, samples: counted.length }),
      costPerSessionByRoute: (['triage', 'fix'] as const).map((route) =>
        unavailable(usd(`cost-per-session:${route}`, `Cost per ${route} session`), 'Only ACUs reported per session give a split by phase'),
      ),
      largestSessions: [],
      sessionsAtCap,
    };
  }

  let reason: string;
  let display = NOT_REPORTED;
  if (devin.status === 'unavailable') {
    reason = `Devin was not read (${devin.reason}) and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured`;
    display = 'Unavailable';
  } else if (acusComplete) reason = 'Devin reports ACUs but DEVIN_ACU_PRICE_USD is not set, and no manual reading is configured';
  else {
    const missing = sessions === null ? 0 : sessions.filter((session) => session.acus === null).length;
    reason = `Devin reports no ACUs for ${missing} of ${sessions?.length ?? 0} sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured`;
  }
  const window = allTime(input.now.toISOString(), 'to date');
  const none = (id: string, label: string): Figure => unavailable(base(id, label, 'usd', window, 'none'), reason, display);
  return {
    source: 'none',
    sourceLabel: display === NOT_REPORTED ? NOT_REPORTED : reason,
    readAt: null,
    scope: `Every Bug Smasher session for ${scopeName}, successful or not`,
    totalSpend: none('total-spend', 'Total spend'),
    budgetRemaining: none('budget-remaining', 'Budget remaining'),
    costPerFixedBug: none('cost-per-fixed-bug', 'Cost per fixed bug'),
    costPerSession: none('cost-per-session', 'Cost per session'),
    costPerSessionByRoute: (['triage', 'fix'] as const).map((route) => none(`cost-per-session:${route}`, `Cost per ${route} session`)),
    largestSessions: [],
    sessionsAtCap,
  };
}

function budgetFigure(budget: number | null, spent: number, window: MetricWindow, source: string): Figure {
  const figureBase = base('budget-remaining', 'Budget remaining', 'usd', window, `${source} and DEVIN_BUDGET_USD`);
  if (budget === null) return unavailable(figureBase, 'DEVIN_BUDGET_USD is not set');
  return valueFigure(figureBase, budget - spent, { numerator: spent, denominator: budget, samples: 1 });
}

// Liveness and cross-check -----------------------------------------------------------------------------------

function livenessMetrics(input: MetricsInput, liveRecords: readonly BugRecord[]): LivenessMetrics {
  const now = input.now;
  const point = pointInTime(now);
  const recent = recentWindow(now);
  const orchestrator = input.evidence.orchestrator;
  const cycleBase = base('last-cycle', "Orchestrator's last cycle", 'timestamp', point, 'running orchestrator');
  const lastCycle =
    orchestrator.status === 'unavailable'
      ? unavailable(cycleBase, orchestrator.reason)
      : orchestrator.value.lastCycleAt === null
        ? noData(cycleBase, 'No cycle has finished since the service started')
        : valueFigure(cycleBase, Date.parse(orchestrator.value.lastCycleAt), { samples: 1 });

  const devin = input.evidence.devin;
  const devinSessions = new Map(devin.status === 'available' ? devin.value.sessions.map((session) => [session.id, session]) : []);
  const active = liveRecords.flatMap((record) => (record.session !== null && record.session.liveState !== 'ended' && record.session.stopRequestedAt === null ? [record.session] : []));
  const withSession = liveRecords.filter((record) => record.session !== null).length;
  const workingSessions = count(
    { id: 'working-sessions', label: 'Sessions working now', window: point, source: `${SOURCE.records} (session state last observed by the orchestrator)` },
    active.filter((session) => session.liveState === 'starting' || session.liveState === 'running').length,
    withSession,
    'No Bug Smasher sessions',
  );
  const stalledSessions = count(
    {
      id: 'stalled-sessions',
      label: 'Sessions with no progress for two hours',
      window: point,
      source: devin.status === 'available' ? `${SOURCE.records} and ${SOURCE.sessions} (last update)` : `${SOURCE.records} (last session update; Devin was not read)`,
    },
    active.filter((session) => {
      const updated = devinSessions.get(session.id)?.updatedAt ?? session.updatedAt;
      return now.getTime() - Date.parse(updated) >= STALLED_AFTER_MS;
    }).length,
    active.length,
    'No session is open',
  );
  const attempts = liveRecords.flatMap((record) => record.verifications.filter((attempt) => inWindow(attempt.at, recent)));
  const verificationErrors = count(
    { id: 'verification-errors', label: 'Verification runs that errored', window: recent, source: `${SOURCE.records} (verification attempts)` },
    attempts.filter((attempt) => attempt.result === 'error').length,
    attempts.length,
    'No verification ran in the window',
  );

  let knowledgeUsed: Figure[];
  const knowledgeWindow = allTime(devin.status === 'available' ? devin.value.readAt : now.toISOString(), 'to date');
  const knowledgeBase = { window: knowledgeWindow, source: SOURCE.insights };
  if (devin.status === 'unavailable') {
    knowledgeUsed = [unavailable({ ...knowledgeBase, id: 'knowledge', label: 'Knowledge used', unit: 'ratio' }, `Devin was not read: ${devin.reason}`)];
  } else {
    const analysed = scopedSessions(input, devin.value).filter((session) => session.knowledge !== null);
    const notes = [...new Set(analysed.flatMap((session) => session.knowledge ?? []))].sort();
    knowledgeUsed =
      analysed.length === 0
        ? [noData({ ...knowledgeBase, id: 'knowledge', label: 'Knowledge used', unit: 'ratio' }, 'No session has Session Insights')]
        : notes.length === 0
          ? [rate({ ...knowledgeBase, id: 'knowledge', label: 'Sessions that used any Knowledge note' }, 0, analysed.length, '')]
          : notes.map((note) =>
              rate({ ...knowledgeBase, id: `knowledge:${note}`, label: `Sessions that used Knowledge note ${note}` }, analysed.filter((session) => session.knowledge?.includes(note)).length, analysed.length, ''),
            );
  }
  return { lastCycle, workingSessions, verificationErrors, stalledSessions, knowledgeUsed };
}

function crossCheckMetrics(input: MetricsInput, liveFixes: FixAssessment[]): CrossCheckMetrics {
  const note = "Devin's organisation-wide figures, shown only as a cross-check; they never change the local counts.";
  const devin = input.evidence.devin;
  if (devin.status === 'unavailable') {
    const window = recentWindow(input.now);
    return { note, figures: [{ devin: unavailable(base('devin:prs-merged', 'Devin: pull requests merged', 'count', window, SOURCE.devinMetrics), `Devin was not read: ${devin.reason}`), local: localMerged(liveFixes, window) }] };
  }
  const { crossCheck } = devin.value;
  const window: MetricWindow = { start: crossCheck.window.start, end: crossCheck.window.end, label: 'cross-check window' };
  const provider = (id: string, label: string, value: number | undefined, reason: string | null): Figure => {
    const figureBase = base(id, label, 'count', window, SOURCE.devinMetrics);
    if (value === undefined) return unavailable(figureBase, reason ?? 'Not reported');
    return valueFigure(figureBase, value, { numerator: value, samples: value });
  };
  const reasonOf = (sourced: { status: string; reason?: string }): string | null => (sourced.status === 'unavailable' ? (sourced.reason ?? null) : null);
  const prs = crossCheck.prs.status === 'available' ? crossCheck.prs.value : undefined;
  const sessionMetrics = crossCheck.sessions.status === 'available' ? crossCheck.sessions.value : undefined;
  const localSessions = scopedSessions(input, devin.value).filter((session) => inWindow(session.createdAt, window)).length;
  return {
    note,
    figures: [
      { devin: provider('devin:prs-merged', 'Devin: pull requests merged', prs?.prsMergedCount, reasonOf(crossCheck.prs)), local: localMerged(liveFixes, window) },
      {
        devin: provider('devin:sessions-with-merged-prs', 'Devin: sessions with merged pull requests', sessionMetrics?.sessionsWithMergedPrsCount, reasonOf(crossCheck.sessions)),
        local: count(
          { id: 'local:fixed-and-proven', label: 'Local: bugs fixed and proven', window, source: SOURCE.proof },
          liveFixes.filter((fix) => fix.unproven === null && inWindow(fix.mergedAt, window)).length,
          liveFixes.filter((fix) => inWindow(fix.mergedAt, window)).length,
          'No bug fix was merged in the window',
        ),
      },
      {
        devin: provider('devin:sessions-created', 'Devin: sessions created', sessionMetrics?.sessionsCreatedCount, reasonOf(crossCheck.sessions)),
        local: count({ id: 'local:sessions', label: 'Local: Bug Smasher sessions', window, source: SOURCE.sessions }, localSessions, localSessions, 'No Bug Smasher session was created in the window'),
      },
    ],
  };
}

function localMerged(liveFixes: FixAssessment[], window: MetricWindow): Figure {
  const merged = liveFixes.filter((fix) => inWindow(fix.mergedAt, window)).length;
  return count({ id: 'local:merged', label: 'Local: bug fixes merged', window, source: SOURCE.proof }, merged, merged, 'No bug fix was merged in the window');
}

// Rows -------------------------------------------------------------------------------------------------------

function recordRow(record: BugRecord, cohort: Cohort, fixes: FixAssessment[]): RecordRow {
  const stages: string[] = [];
  for (const entry of record.stageHistory) if (stages.at(-1) !== entry.stage) stages.push(entry.stage);
  const decision = record.decisions.filter((candidate) => candidate.action !== 'reply').at(-1);
  const verification: string[] = [];
  const pre = currentHeadVerification(record);
  if (pre !== null) verification.push(`pre-merge ${pre.result} at ${short(pre.headSha)}`);
  const post = currentMergeVerifications(record).at(-1);
  if (post !== undefined) verification.push(`post-merge ${post.result} at ${short(post.headSha)}`);
  let outcome: string;
  const latest = fixes.filter((fix) => fix.record === record).at(-1);
  if (record.kind === 'feature') outcome = 'feature request (not a bug outcome)';
  else if (latest !== undefined && latest.escaped !== null) outcome = `escaped: ${latest.escaped}`;
  else if (latest !== undefined && latest.unproven === null) outcome = 'fixed and proven';
  else if (record.stage === 'with-engineer') outcome = `with engineer (${record.handoff?.reason ?? 'unknown'})`;
  else if (record.stage === 'closed') outcome = 'closed';
  else if (record.stage === 'merged') outcome = `merged, not proven: ${latest?.unproven ?? 'no merged fix'}`;
  else outcome = `open (${record.stage})`;
  return {
    key: record.key,
    cohort: cohort.label,
    kind: record.kind,
    stage: record.stage,
    path: stages.join(' → '),
    decision: decision !== undefined ? `${decision.action} by ${decision.actor}` : record.triage !== null ? `none yet (Devin recommends ${record.triage.recommendation})` : 'none',
    pullRequest: record.fix?.prUrl ?? 'none',
    verification: verification.length === 0 ? 'none' : verification.join('; '),
    outcome,
  };
}

// Entry point ------------------------------------------------------------------------------------------------

/** The single calculation of every metric; the dashboard API and RESULTS.md both show its output unchanged. */
export function calculateMetrics(input: MetricsInput): MetricsReport {
  const cohorts = cohortsOf(input);
  const results = cohorts.map((cohort) => ({ cohort, metrics: cohortMetrics(cohort, input) }));
  const liveResult = results.find((result) => result.cohort.live) ?? null;
  const liveCohort = liveResult?.cohort ?? null;
  const liveEvidence = liveCohort === null ? null : evidenceFor(liveCohort.repository, input);
  const liveFixes =
    liveCohort === null || liveEvidence === null
      ? []
      : liveCohort.records.filter((record) => record.kind === 'bug').flatMap((record) => mergedFixes(record).map((fix) => assessFix(record, fix, liveEvidence)));
  const rows = results.flatMap(({ cohort }) => {
    const evidence = evidenceFor(cohort.repository, input);
    const fixes = cohort.records.flatMap((record) => (record.kind === 'bug' ? mergedFixes(record).map((fix) => assessFix(record, fix, evidence)) : []));
    return [...cohort.records].sort((a, b) => a.key.localeCompare(b.key)).map((record) => recordRow(record, cohort, fixes));
  });
  const { github, devin, orchestrator } = input.evidence;
  return {
    generatedAt: input.now.toISOString(),
    timezone: 'UTC',
    weekStartsOn: 'Monday',
    target: input.target,
    sources: {
      github: github.status === 'available' ? `GitHub ${github.value.repository}, read ${github.value.readAt}` : `GitHub not read: ${github.reason}`,
      devin: devin.status === 'available' ? `Devin API, read ${devin.value.readAt}` : `Devin not read: ${devin.reason}`,
      orchestrator: orchestrator.status === 'available' ? 'running orchestrator' : `Orchestrator not read: ${orchestrator.reason}`,
    },
    rows,
    live: liveResult?.metrics ?? null,
    otherCohorts: results.filter((result) => !result.cohort.live).map((result) => result.metrics),
    cost: costMetrics(input, liveResult?.metrics ?? null, liveFixes),
    liveness: livenessMetrics(input, liveCohort?.records ?? []),
    crossCheck: crossCheckMetrics(input, liveFixes),
  };
}
