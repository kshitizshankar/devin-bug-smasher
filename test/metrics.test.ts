import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateMetrics, NOT_REPORTED } from '../src/metrics/calculate.ts';
import { median, percentile, trendWeeks, weekStart } from '../src/metrics/stats.ts';
import type { Figure, MetricsReport } from '../src/metrics/types.ts';
import { Bug, input, live, mergedBug, NO_COST, NOW, REPO, unavailableEvidence } from './helpers/metrics.ts';
import { LABEL } from './helpers/model.ts';
import { devinSessions, fullEvidence, liveBugs, OWN_REPO, recordSets, session } from './helpers/metrics-fixture.ts';

type Expected = Partial<Pick<Figure, 'status' | 'value' | 'numerator' | 'denominator' | 'samples' | 'display'>> & { start?: string | null; end?: string };

function expectFigure(figure: Figure | undefined, expected: Expected): void {
  assert.ok(figure !== undefined, 'figure exists');
  const actual: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    actual[key] = key === 'start' ? figure.window.start : key === 'end' ? figure.window.end : figure[key as keyof Figure];
  }
  assert.deepEqual(actual, expected, figure.id);
}

function find(figures: readonly Figure[], id: string): Figure | undefined {
  return figures.find((figure) => figure.id === id);
}

const RECENT = { start: '2026-02-16T12:00:00.000Z', end: '2026-03-18T12:00:00.000Z' };
const PREVIOUS = { start: '2026-01-17T12:00:00.000Z', end: '2026-02-16T12:00:00.000Z' };

function fullReport(settings = { ...NO_COST, acuPriceUsd: 2, budgetUsd: 100, baselineFilter: 'bug' }): MetricsReport {
  const bugs = liveBugs();
  return calculateMetrics(input(recordSets(bugs), { settings, evidence: fullEvidence(bugs) }));
}

function liveOf(report: MetricsReport): NonNullable<MetricsReport['live']> {
  assert.ok(report.live !== null, 'live cohort');
  return report.live;
}

describe('metric statistics', () => {
  it('uses UTC weeks starting Monday 00:00', () => {
    assert.equal(weekStart(new Date('2026-03-16T00:00:00.000Z')).toISOString(), '2026-03-16T00:00:00.000Z');
    assert.equal(weekStart(new Date('2026-03-15T23:59:59.999Z')).toISOString(), '2026-03-09T00:00:00.000Z');
    assert.equal(weekStart(new Date('2026-03-22T23:59:59.999Z')).toISOString(), '2026-03-16T00:00:00.000Z');
    const weeks = trendWeeks(NOW);
    assert.equal(weeks.length, 8);
    assert.equal(weeks[0]?.start, '2026-01-26T00:00:00.000Z');
    assert.equal(weeks.at(-1)?.start, '2026-03-16T00:00:00.000Z');
    assert.equal(weeks.at(-1)?.end, NOW.toISOString());
  });

  it('takes the middle value, or the mean of the two middle values, as the median', () => {
    assert.equal(median([5, 1, 3]), 3);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });

  it('uses the nearest rank for P90', () => {
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
    assert.equal(percentile([12, 24, 48, 144], 0.9), 144);
    assert.equal(percentile([7], 0.9), 7);
    assert.equal(percentile([], 0.9), null);
  });
});

describe('four keys on the known live history', () => {
  const report = fullReport();
  const keys = liveOf(report).keys;

  it('counts only fixes merged at the verified head and passed on the merge commit, by merge week', () => {
    // This week: #1 (Monday 00:00, proven), #3 (merged at an unverified head), #4 (failed on the merge commit).
    expectFigure(keys.fixThroughput.figure, { status: 'value', value: 1, numerator: 1, denominator: 3, samples: 3, display: '1', start: '2026-03-16T00:00:00.000Z', end: NOW.toISOString() });
    // Previous week: #2 (23:59:59.999 Sunday), #5 and #6; a revert or reopen does not remove a proven merge.
    expectFigure(keys.fixThroughput.reference, { value: 3, numerator: 3, denominator: 3, start: '2026-03-09T00:00:00.000Z', end: '2026-03-16T00:00:00.000Z' });
    assert.deepEqual(
      keys.trend.at(-1)?.excluded.map((item) => [item.key, item.reason]),
      [
        [`${REPO}#3`, 'merged commit bbbbbbb did not pass verification'],
        [`${REPO}#4`, 'failed verification on merge commit 4ffffff'],
      ],
    );
  });

  it('keeps an eight-week trend where empty weeks are no data', () => {
    assert.deepEqual(
      keys.trend.map((week) => [week.figure.window.start, week.figure.display]),
      [
        ['2026-01-26T00:00:00.000Z', 'No data'],
        ['2026-02-02T00:00:00.000Z', 'No data'],
        ['2026-02-09T00:00:00.000Z', 'No data'],
        ['2026-02-16T00:00:00.000Z', 'No data'],
        ['2026-02-23T00:00:00.000Z', 'No data'],
        ['2026-03-02T00:00:00.000Z', 'No data'],
        ['2026-03-09T00:00:00.000Z', '3'],
        ['2026-03-16T00:00:00.000Z', '1'],
      ],
    );
    assert.equal(keys.trend[0]?.figure.value, null);
  });

  it('measures time to fix from filing to merge, with median, P90 and the repository baseline', () => {
    // Proven in the last 30 days: #1 144 h, #2 12 h, #5 24 h, #6 48 h.
    expectFigure(keys.timeToFixMedian.figure, { status: 'value', value: 36, samples: 4, numerator: null, denominator: null, display: '36 h', ...RECENT });
    expectFigure(keys.timeToFixP90, { value: 144, samples: 4, display: '144 h' });
    // Untracked comparable closed issues: 24, 10, 30, 50 and 40 h; tracked #1 is excluded.
    expectFigure(keys.timeToFixMedian.reference, { status: 'value', value: 30, samples: 5, display: '30 h' });
  });

  it('first-time pass rate counts the first non-error pre-merge attempt of each fix session', () => {
    // Passed first: #1 #2 #3 #4 #5 #6 #7. Failed first: #9 (after an error) and #12.
    expectFigure(keys.firstTimePass.figure, { value: 7 / 9, numerator: 7, denominator: 9, samples: 9, display: '77.8% (7 of 9)', ...RECENT });
    expectFigure(keys.firstTimePass.reference, { status: 'no-data', value: null, samples: 0, display: 'No data', ...PREVIOUS });
  });

  it('escaped-fix rate counts post-merge failures, reverts and reopens among merged fixes', () => {
    expectFigure(keys.escapedFixes.figure, { value: 0.5, numerator: 3, denominator: 6, samples: 6, display: '50% (3 of 6)', ...RECENT });
    expectFigure(keys.escapedFixes.reference, { status: 'no-data', display: 'No data' });
    const outcomes = new Map(report.rows.filter((row) => row.cohort === `${REPO} (live)`).map((row) => [row.key, row.outcome]));
    assert.equal(outcomes.get(`${REPO}#4`), 'escaped: failed verification on merge commit 4ffffff');
    assert.equal(outcomes.get(`${REPO}#5`), `escaped: reverted by https://github.com/${REPO}/pull/150`);
    assert.equal(outcomes.get(`${REPO}#6`), 'escaped: issue reopened 2026-03-13T00:00:00.000Z');
    assert.equal(outcomes.get(`${REPO}#7`), 'open (ready-to-merge)');
  });

  it('never counts a verified but unmerged fix, or a feature request', () => {
    const row7 = report.rows.find((row) => row.key === `${REPO}#7`);
    assert.equal(row7?.verification, 'pre-merge pass at 7aaaaaa');
    assert.equal(liveOf(report).bugs, 13);
    assert.equal(liveOf(report).features, 1);
    assert.equal(report.rows.find((row) => row.key === `${REPO}#8`)?.outcome, 'feature request (not a bug outcome)');
  });

  it('refuses a fix GitHub reports merged at a different head than the verified one', () => {
    const bug = mergedBug(1, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 101 });
    const fix = bug.record.fix;
    assert.ok(fix !== null);
    const evidence = unavailableEvidence();
    evidence.github = {
      status: 'available',
      value: {
        repository: REPO,
        readAt: NOW.toISOString(),
        issues: [],
        pullRequests: [{ key: `${REPO}#101`, state: 'merged', headSha: '9'.repeat(40), mergeCommitSha: fix.mergeCommitSha, mergedAt: fix.mergedAt ?? null, additions: 1, deletions: 0, changedFiles: 1 }],
        reverts: [],
        baseline: { status: 'unavailable', reason: 'BASELINE_FILTER is not set' },
      },
    };
    const result = calculateMetrics(input([live(bug)], { evidence }));
    expectFigure(liveOf(result).keys.fixThroughput.figure, { value: 0, numerator: 0, denominator: 1 });
    assert.equal(liveOf(result).keys.trend.at(-1)?.excluded[0]?.reason, 'merged at 9999999, not the recorded head 1aaaaaa');
  });
});

describe('flow and health on the known live history', () => {
  const flow = liveOf(fullReport()).flow;

  it('counts bugs in per enrolment week, with a Sunday enrolment in the earlier week', () => {
    assert.deepEqual(
      flow.bugsIn.map((figure) => [figure.window.start, figure.display]),
      [
        ['2026-01-26T00:00:00.000Z', 'No data'],
        ['2026-02-02T00:00:00.000Z', 'No data'],
        ['2026-02-09T00:00:00.000Z', 'No data'],
        ['2026-02-16T00:00:00.000Z', 'No data'],
        ['2026-02-23T00:00:00.000Z', '1'],
        ['2026-03-02T00:00:00.000Z', '4'],
        ['2026-03-09T00:00:00.000Z', '6'],
        ['2026-03-16T00:00:00.000Z', '2'],
      ],
    );
  });

  it('counts open bugs by stage and the longest wait at each decision', () => {
    const open = Object.fromEntries(flow.openByStage.map((figure) => [figure.id, [figure.value, figure.denominator]]));
    assert.deepEqual(open, {
      'open-bugs:queued': [0, 8],
      'open-bugs:triaging': [0, 8],
      'open-bugs:needs-input': [2, 8],
      'open-bugs:triaged': [0, 8],
      'open-bugs:fixing': [0, 8],
      'open-bugs:verifying': [0, 8],
      'open-bugs:ready-to-merge': [2, 8],
      'open-bugs:with-engineer': [4, 8],
    });
    // #13 has waited since 03-05 02:00 (322 h); #9 has been ready since 03-01 05:00 (415 h).
    expectFigure(find(flow.longestWait, 'longest-wait:needs-input'), { value: 322, samples: 2, display: '322 h' });
    expectFigure(find(flow.longestWait, 'longest-wait:triaged'), { status: 'no-data', display: 'No data' });
    expectFigure(find(flow.longestWait, 'longest-wait:ready-to-merge'), { value: 415, samples: 2 });
  });

  it('calculates the 30-day resolution rate and fix-routed failure rate by reason', () => {
    expectFigure(flow.resolution, { value: 4 / 13, numerator: 4, denominator: 13, display: '30.8% (4 of 13)', ...RECENT });
    expectFigure(flow.failure, { numerator: 1, denominator: 9, display: '11.1% (1 of 9)' });
    expectFigure(find(flow.failureByReason, 'failure:verification-failed'), { numerator: 1, denominator: 9 });
    expectFigure(find(flow.failureByReason, 'failure:session-ended'), { value: 0, numerator: 0, denominator: 9, display: '0% (0 of 9)' });
  });

  it('reports the smallest, median and largest merged fix in lines and files', () => {
    // Bug fixes merged in the window: 12, 4, 50, 10, 2 and 120 lines; 1, 1, 3, 2, 1 and 6 files.
    assert.deepEqual(flow.fixSizeLines.map((figure) => [figure.value, figure.samples]), [[2, 6], [11, 6], [120, 6]]);
    assert.deepEqual(flow.fixSizeFiles.map((figure) => figure.display), ['1 files', '1.5 files', '6 files']);
  });
});

describe('adoption and trust on the known live history', () => {
  const adoption = liveOf(fullReport()).adoption;

  it('counts distinct people by week and by action, leaving out bots and policies', () => {
    const byAction = Object.fromEntries(adoption.peopleByAction.map((figure) => [figure.id, [figure.value, figure.samples]]));
    // Filed: maria (#1) and reporter (11 issues); dependabot is a bot. Answered: bob. Decided: alice, carol. Merged: maria, six times.
    assert.deepEqual(byAction, { 'people:filed': [2, 12], 'people:answered': [1, 1], 'people:decided': [2, 2], 'people:merged': [1, 6] });
    // Week of 03-16: reporter filed #7 and #14; maria merged #1, #3 and #4.
    expectFigure(adoption.peopleByWeek.at(-1), { value: 2, samples: 5 });
    expectFigure(adoption.peopleByWeek[0], { status: 'no-data' });
  });

  it('measures response and decision times and unanswered questions', () => {
    expectFigure(adoption.answerTime, { value: 3, samples: 1, display: '3 h' });
    expectFigure(find(adoption.decisionTime, 'response:engineer'), { value: 3, samples: 2 });
    expectFigure(find(adoption.decisionTime, 'response:fix'), { status: 'no-data' });
    // Person merges waited 36, 3, 31.5, 6 and 12 h in ready-to-merge; #3 merged from verifying.
    expectFigure(find(adoption.decisionTime, 'response:merge'), { value: 12, samples: 5 });
    expectFigure(adoption.unansweredQuestions, { value: 1, denominator: 2, samples: 2 });
  });

  it('calculates agreement per recommendation and automation share per policy', () => {
    expectFigure(find(adoption.agreement, 'agreement:devin_fix'), { numerator: 0, denominator: 1, display: '0% (0 of 1)' });
    expectFigure(find(adoption.agreement, 'agreement:needs_engineer'), { numerator: 1, denominator: 1, display: '100% (1 of 1)' });
    expectFigure(find(adoption.agreement, 'agreement:close'), { status: 'no-data' });
    expectFigure(find(adoption.automation, 'automation:fix:rule'), { numerator: 1, denominator: 1 });
    expectFigure(find(adoption.automation, 'automation:fix:auto'), { numerator: 0, denominator: 1 });
    expectFigure(find(adoption.automation, 'automation:engineer:rule'), { numerator: 0, denominator: 2 });
    expectFigure(find(adoption.automation, 'automation:merge:auto'), { numerator: 0, denominator: 6 });
  });
});

describe('cost', () => {
  it('prices every reported session, successful or not, at DEVIN_ACU_PRICE_USD', () => {
    const { cost } = fullReport();
    assert.equal(cost.source, 'acus');
    // Target sessions: 2 + 1 + 0.5 + 5 + 1.5 = 10 ACUs at $2; Bug Smasher's own session is left out.
    expectFigure(cost.totalSpend, { value: 20, numerator: 10, samples: 5, display: '$20.00' });
    expectFigure(cost.budgetRemaining, { value: 80, display: '$80.00' });
    expectFigure(cost.costPerFixedBug, { value: 5, numerator: 20, denominator: 4, display: '$5.00' });
    expectFigure(cost.costPerSession, { value: 4, numerator: 20, denominator: 5 });
    expectFigure(find(cost.costPerSessionByRoute, 'cost-per-session:fix'), { value: 3, denominator: 2, display: '$3.00' });
    expectFigure(find(cost.costPerSessionByRoute, 'cost-per-session:triage'), { value: 14 / 3, denominator: 3, display: '$4.67' });
    expectFigure(cost.sessionsAtCap, { value: 1, denominator: 5 });
    assert.deepEqual(cost.largestSessions.map((item) => [item.id, item.acus, item.usd]), [
      ['session-triage-12', 5, 10],
      ['session-fix-1', 2, 4],
      ['session-triage-13', 1.5, 3],
      ['session-fix-2', 1, 2],
      ['session-triage-10', 0.5, 1],
    ]);
  });

  it('falls back to the manual spend reading when any session lacks ACUs', () => {
    const bugs = liveBugs();
    const sessions = devinSessions().map((item) => (item.id === 'session-fix-2' ? { ...item, acus: null } : item));
    const report = calculateMetrics(
      input(recordSets(bugs), { settings: { ...NO_COST, acuPriceUsd: 2, spendUsd: 50, spendReadAt: '2026-03-16T12:00:00.000Z' }, evidence: fullEvidence(bugs, sessions) }),
    );
    const { cost } = report;
    assert.equal(cost.source, 'manual');
    assert.equal(cost.readAt, '2026-03-16T12:00:00.000Z');
    expectFigure(cost.totalSpend, { value: 50, display: '$50.00' });
    // Proven by the read time: #1, #2, #5 and #6. Sessions created by then: four (session-triage-13 is later).
    expectFigure(cost.costPerFixedBug, { value: 12.5, denominator: 4 });
    expectFigure(cost.costPerSession, { value: 12.5, denominator: 4 });
    expectFigure(find(cost.costPerSessionByRoute, 'cost-per-session:fix'), { status: 'unavailable' });
    assert.deepEqual(cost.largestSessions, []);
  });

  it('says Devin does not report spend, never $0, when there are no ACUs and no manual reading', () => {
    const bugs = liveBugs();
    const sessions = devinSessions().map((item) => ({ ...item, acus: null }));
    const { cost } = calculateMetrics(input(recordSets(bugs), { settings: { ...NO_COST, acuPriceUsd: 2 }, evidence: fullEvidence(bugs, sessions) }));
    assert.equal(cost.source, 'none');
    assert.equal(cost.sourceLabel, NOT_REPORTED);
    for (const figure of [cost.totalSpend, cost.costPerFixedBug, cost.costPerSession, ...cost.costPerSessionByRoute]) {
      expectFigure(figure, { status: 'unavailable', value: null, display: NOT_REPORTED });
    }
  });
});

describe('liveness and the Devin cross-check', () => {
  it('reports the last cycle, working and stalled sessions, verification errors and Knowledge use', () => {
    const { liveness } = fullReport();
    expectFigure(liveness.lastCycle, { value: Date.parse('2026-03-18T11:59:00.000Z'), display: '2026-03-18T11:59:00.000Z' });
    // Live sessions not asked to stop: #7, #9, #13 and #14; only #14 progressed in the last two hours.
    expectFigure(liveness.workingSessions, { value: 4, denominator: 14 });
    expectFigure(liveness.stalledSessions, { value: 3, denominator: 4 });
    expectFigure(liveness.verificationErrors, { value: 1, denominator: 20 });
    // Target sessions with Insights: fix-1 (a, b), fix-2 (a), triage-10 (none), triage-12 (b).
    assert.deepEqual(liveness.knowledgeUsed.map((figure) => [figure.id, figure.display]), [
      ['knowledge:note-a', '50% (2 of 4)'],
      ['knowledge:note-b', '50% (2 of 4)'],
    ]);
  });

  it('shows Devin endpoint figures next to local ones without changing the local counts', () => {
    const report = fullReport();
    const pairs = Object.fromEntries(report.crossCheck.figures.map((pair) => [pair.devin.id, [pair.devin.display, pair.local.display]]));
    assert.deepEqual(pairs, {
      'devin:prs-merged': ['7', '6'],
      'devin:sessions-with-merged-prs': ['3', '4'],
      'devin:sessions-created': ['9', '5'],
    });
    const bugs = liveBugs();
    const evidence = fullEvidence(bugs);
    if (evidence.devin.status === 'available') {
      evidence.devin.value.crossCheck.prs = { status: 'unavailable', reason: 'HTTP 403' };
      evidence.devin.value.crossCheck.sessions = { status: 'available', value: { sessionsCreatedCount: 0, sessionsWithMergedPrsCount: 99, sessionsCreatedWithPlaybookCount: 0, avgAcusPerSession: { status: 'unavailable', reason: 'not-reported' } } };
    }
    const other = calculateMetrics(input(recordSets(bugs), { settings: { ...NO_COST, acuPriceUsd: 2, budgetUsd: 100, baselineFilter: 'bug' }, evidence }));
    assert.deepEqual(other.live, report.live);
    assert.deepEqual(other.cost, report.cost);
    expectFigure(other.crossCheck.figures[0]?.devin, { status: 'unavailable', display: 'Unavailable' });
  });
});

describe('cohorts', () => {
  it('reports Bug Smasher’s own issues, replays and v1 runs separately from live target outcomes', () => {
    const report = fullReport();
    assert.equal(liveOf(report).label, `${REPO} (live)`);
    assert.deepEqual(
      report.otherCohorts.map((cohort) => [cohort.label, cohort.keys.fixThroughput.figure.value]),
      [
        [`${REPO} (live, v1 engine)`, 1],
        [`${REPO} (replay)`, 1],
        [`${OWN_REPO} (live, not the target repository)`, 1],
      ],
    );
    // The replay of #1 merged this week and the v1 run of #30 did too, yet the live figure is unchanged.
    expectFigure(liveOf(report).keys.fixThroughput.figure, { value: 1, denominator: 3 });
  });

  it('has no live cohort when no target repository is configured', () => {
    const bugs = liveBugs();
    const report = calculateMetrics(input(recordSets(bugs), { target: null }));
    assert.equal(report.live, null);
  });
});

describe('missing evidence', () => {
  it('is unavailable or no data, never zero', () => {
    const report = calculateMetrics(input([live()]));
    assert.equal(report.live, null);
    expectFigure(report.cost.totalSpend, { status: 'unavailable', value: null, display: 'Unavailable' });
    expectFigure(report.liveness.lastCycle, { status: 'unavailable', value: null });
    expectFigure(report.liveness.knowledgeUsed[0], { status: 'unavailable' });

    const one = mergedBug(1, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 101 });
    const withoutGitHub = liveOf(calculateMetrics(input([live(one)])));
    expectFigure(withoutGitHub.keys.fixThroughput.figure, { value: 1, denominator: 1 });
    expectFigure(withoutGitHub.keys.timeToFixMedian.figure, { status: 'unavailable', value: null, samples: 0 });
    expectFigure(withoutGitHub.keys.timeToFixMedian.reference, { status: 'unavailable', display: 'Insufficient history: BASELINE_FILTER is not set' });
    expectFigure(withoutGitHub.flow.fixSizeLines[0], { status: 'unavailable', value: null });
    expectFigure(find(withoutGitHub.adoption.peopleByAction, 'people:filed'), { status: 'unavailable' });
  });

  it('states that baseline history is insufficient below five comparable issues', () => {
    const bugs = liveBugs();
    const evidence = fullEvidence(bugs);
    if (evidence.github.status === 'available') {
      evidence.github.value.baseline = { status: 'available', value: { filter: 'bug', issues: evidence.github.value.baseline.status === 'available' ? evidence.github.value.baseline.value.issues.slice(2) : [] } };
    }
    const report = calculateMetrics(input(recordSets(bugs), { settings: { ...NO_COST, baselineFilter: 'bug' }, evidence }));
    // #92, #93 and #94 remain; #1 is a tracked bug.
    expectFigure(liveOf(report).keys.timeToFixMedian.reference, { status: 'no-data', samples: 3, display: 'Insufficient history (3 comparable closed issues)' });
  });

  it('gives every figure a numerator, denominator, sample count, window and source', () => {
    const report = fullReport();
    const figures: Figure[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === 'object') {
        if ('display' in value && 'window' in value && 'source' in value) figures.push(value as Figure);
        else Object.values(value).forEach(walk);
      }
    };
    walk(report);
    assert.ok(figures.length > 100);
    for (const figure of figures) {
      assert.ok('numerator' in figure && 'denominator' in figure, figure.id);
      assert.equal(typeof figure.samples, 'number', figure.id);
      assert.ok(figure.window.end !== '' && figure.window.label !== '', figure.id);
      assert.ok(figure.source !== '', figure.id);
      if (figure.status !== 'value') assert.equal(figure.value, null, figure.id);
      if (figure.status === 'no-data') assert.equal(figure.display, 'No data', figure.id);
    }
  });
});

describe('points in time', () => {
  it('leaves questions of closed issues out of the unanswered count', () => {
    const open = new Bug(20, [LABEL.triage], '2026-03-01T00:00:00.000Z')
      .session('session-triage-20', '2026-03-01T01:00:00.000Z')
      .event({ type: 'question-asked', question: { id: 'q20', summary: 'Which OS?' } }, '2026-03-01T02:00:00.000Z');
    const closed = new Bug(21, [LABEL.triage], '2026-03-01T00:00:00.000Z')
      .session('session-triage-21', '2026-03-01T01:00:00.000Z')
      .event({ type: 'question-asked', question: { id: 'q21', summary: 'Which OS?' } }, '2026-03-01T02:00:00.000Z')
      .event({ type: 'issue-closed' }, '2026-03-02T00:00:00.000Z');
    const report = calculateMetrics(input([live(open, closed)]));
    expectFigure(liveOf(report).adoption.unansweredQuestions, { value: 1, numerator: 1, denominator: 1 });
  });

  it('counts a fix toward a spend reading only once it was proven by the read time', () => {
    const one = mergedBug(1, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 101 });
    const at = (spendReadAt: string): Figure =>
      calculateMetrics(input([live(one)], { settings: { ...NO_COST, spendUsd: 50, spendReadAt } })).cost.costPerFixedBug;
    // Merged at 00:00:00, passed on the merge commit at 00:01:00.
    expectFigure(at('2026-03-17T00:00:30.000Z'), { status: 'no-data', value: null });
    expectFigure(at('2026-03-17T00:02:00.000Z'), { value: 50, numerator: 50, denominator: 1 });
  });
});
