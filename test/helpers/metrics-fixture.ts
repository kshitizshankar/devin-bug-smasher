import type { GitHubEvidence, IssueActivity, MetricsEvidence, PullRequestFacts, RecordSet, SessionFact } from '../../src/metrics/types.ts';
import { Bug, headSha, mergedBug, mergeSha, REPO, sha } from './metrics.ts';
import { LABEL } from './model.ts';

export const OWN_REPO = 'kshitizshankar/devin-bug-smasher';

/**
 * A known live history for acme/widgets, evaluated at NOW (Wednesday 2026-03-18 12:00 UTC).
 * The expected value of every metric is derived by hand in test/metrics.test.ts.
 */
export function liveBugs(): Map<number, Bug> {
  const bugs = new Map<number, Bug>();
  const add = (bug: Bug): void => {
    bugs.set(bug.number, bug);
  };
  // Proven, merged exactly at the Monday 00:00 boundary, so it belongs to the current week.
  add(mergedBug(1, { enrolledAt: '2026-03-10T00:00:00.000Z', mergedAt: '2026-03-16T00:00:00.000Z', prNumber: 101 }));
  // Proven, merged one millisecond before the boundary, so it belongs to the previous week.
  add(mergedBug(2, { enrolledAt: '2026-03-15T11:59:59.999Z', mergedAt: '2026-03-15T23:59:59.999Z', prNumber: 102 }));
  // Verified at one head, then pushed to a new head and merged without passing again.
  add(
    new Bug(3, [LABEL.fix], '2026-03-12T00:00:00.000Z')
      .session('session-fix-3', '2026-03-12T01:00:00.000Z')
      .submit(103, headSha(3), '2026-03-12T02:00:00.000Z')
      .verify('pass', headSha(3), '2026-03-12T03:00:00.000Z')
      .event({ type: 'head-changed', prNumber: 103, headSha: sha('b') }, '2026-03-12T04:00:00.000Z')
      .merge(103, mergeSha(3), '2026-03-17T00:00:00.000Z')
      .verify('pass', mergeSha(3), '2026-03-17T00:01:00.000Z', 'post-merge'),
  );
  // Proven before merging, then failed on the merge commit.
  add(mergedBug(4, { enrolledAt: '2026-03-12T00:00:00.000Z', mergedAt: '2026-03-17T06:00:00.000Z', prNumber: 104, postMerge: 'fail' }));
  // Proven, later reverted on GitHub.
  add(mergedBug(5, { enrolledAt: '2026-03-10T00:00:00.000Z', mergedAt: '2026-03-11T00:00:00.000Z', prNumber: 105 }));
  // Proven, then the issue was reopened on GitHub.
  add(mergedBug(6, { enrolledAt: '2026-03-10T00:00:00.000Z', mergedAt: '2026-03-12T00:00:00.000Z', prNumber: 106 }));
  // Verified and ready, never merged.
  add(
    new Bug(7, [LABEL.fix], '2026-03-17T00:00:00.000Z')
      .session('session-fix-7', '2026-03-17T01:00:00.000Z')
      .submit(107, headSha(7), '2026-03-17T02:00:00.000Z')
      .verify('pass', headSha(7), '2026-03-17T03:00:00.000Z'),
  );
  // A feature request merged and proven: never a bug outcome.
  add(mergedBug(8, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 108, labels: [LABEL.feature] }));
  // Enrolled on Sunday 1 March; errored, failed, then passed at a new head. Still waiting to merge.
  add(
    new Bug(9, [LABEL.fix], '2026-03-01T00:00:00.000Z')
      .session('session-fix-9', '2026-03-01T01:00:00.000Z')
      .submit(109, headSha(9), '2026-03-01T02:00:00.000Z')
      .verify('error', headSha(9), '2026-03-01T02:30:00.000Z')
      .verify('fail', headSha(9), '2026-03-01T03:00:00.000Z')
      .event({ type: 'head-changed', prNumber: 109, headSha: sha('d') }, '2026-03-01T04:00:00.000Z')
      .verify('pass', sha('d'), '2026-03-01T05:00:00.000Z'),
  );
  // Asked a question answered after 3 h; Devin recommended a fix, a person sent it to an engineer 4 h later.
  add(
    new Bug(10, [LABEL.triage], '2026-03-02T00:00:00.000Z')
      .session('session-triage-10', '2026-03-02T01:00:00.000Z')
      .event({ type: 'question-asked', question: { id: 'q10', summary: 'Which browser?' } }, '2026-03-02T02:00:00.000Z')
      .event({ type: 'reply-received', questionId: 'q10' }, '2026-03-02T05:00:00.000Z')
      .triaged('2026-03-02T06:00:00.000Z')
      .act({ name: 'engineer', actor: 'github:alice' }, '2026-03-02T10:00:00.000Z'),
  );
  // Devin recommended an engineer; a person agreed 2 h later.
  add(
    new Bug(11, [LABEL.triage], '2026-03-03T00:00:00.000Z')
      .session('session-triage-11', '2026-03-03T01:00:00.000Z')
      .triaged('2026-03-03T02:00:00.000Z', { recommendation: 'needs_engineer' })
      .act({ name: 'engineer', actor: 'github:carol' }, '2026-03-03T04:00:00.000Z'),
  );
  // The Rule policy sent it to a fix; verification failed twice and it went to an engineer.
  add(
    new Bug(12, [LABEL.triage], '2026-03-04T00:00:00.000Z')
      .session('session-triage-12', '2026-03-04T01:00:00.000Z')
      .triaged('2026-03-04T02:00:00.000Z')
      .act({ name: 'fix', actor: 'policy:decision-rule' }, '2026-03-04T02:30:00.000Z')
      .submit(112, headSha(12), '2026-03-04T03:00:00.000Z')
      .verify('fail', headSha(12), '2026-03-04T04:00:00.000Z')
      .event({ type: 'head-changed', prNumber: 112, headSha: sha('e') }, '2026-03-04T05:00:00.000Z')
      .verify('fail', sha('e'), '2026-03-04T06:00:00.000Z'),
  );
  // A question open for more than two days.
  add(
    new Bug(13, [LABEL.triage], '2026-03-05T00:00:00.000Z')
      .session('session-triage-13', '2026-03-05T01:00:00.000Z')
      .event({ type: 'question-asked', question: { id: 'q13', summary: 'Which version?' } }, '2026-03-05T02:00:00.000Z'),
  );
  // A question asked today, with a session that reported progress an hour ago.
  add(
    new Bug(14, [LABEL.triage], '2026-03-18T00:00:00.000Z')
      .session('session-triage-14', '2026-03-18T01:00:00.000Z')
      .event({ type: 'question-asked', question: { id: 'q14', summary: 'Which account?' } }, '2026-03-18T02:00:00.000Z')
      .event({ type: 'session-status', sessionId: 'session-triage-14', liveState: 'running' }, '2026-03-18T11:00:00.000Z'),
  );
  return bugs;
}

/** When each issue was filed on GitHub, and by whom. */
const FILED: Record<number, { at: string; author: string; bot?: boolean }> = {
  1: { at: '2026-03-10T00:00:00.000Z', author: 'maria' },
  2: { at: '2026-03-15T11:59:59.999Z', author: 'dependabot[bot]', bot: true },
  3: { at: '2026-03-12T00:00:00.000Z', author: 'reporter' },
  4: { at: '2026-03-12T00:00:00.000Z', author: 'reporter' },
  5: { at: '2026-03-10T00:00:00.000Z', author: 'reporter' },
  6: { at: '2026-03-10T00:00:00.000Z', author: 'reporter' },
  7: { at: '2026-03-17T00:00:00.000Z', author: 'reporter' },
  8: { at: '2026-03-16T00:00:00.000Z', author: 'reporter' },
  9: { at: '2026-03-01T00:00:00.000Z', author: 'reporter' },
  10: { at: '2026-03-02T00:00:00.000Z', author: 'reporter' },
  11: { at: '2026-03-03T00:00:00.000Z', author: 'reporter' },
  12: { at: '2026-03-04T00:00:00.000Z', author: 'reporter' },
  13: { at: '2026-03-05T00:00:00.000Z', author: 'reporter' },
  14: { at: '2026-03-18T00:00:00.000Z', author: 'reporter' },
};

/** Lines added, lines deleted and files changed per fix pull request. */
const SIZES: Record<number, [number, number, number]> = {
  1: [10, 2, 1],
  2: [3, 1, 1],
  3: [40, 10, 3],
  4: [5, 5, 2],
  5: [1, 1, 1],
  6: [100, 20, 6],
  8: [7, 0, 1],
};

export function githubEvidence(bugs: Map<number, Bug>, baseline: GitHubEvidence['baseline']): GitHubEvidence {
  const issues: IssueActivity[] = [...bugs.values()].map((bug) => {
    const filed = FILED[bug.number] as (typeof FILED)[number];
    const issue: IssueActivity = { key: bug.key, createdAt: filed.at, author: { login: filed.author, bot: filed.bot === true }, comments: [], events: [] };
    if (bug.number === 10) {
      issue.comments.push(
        { author: { login: 'bug-smasher-app[bot]', bot: true }, at: '2026-03-02T02:00:00.000Z', fromService: true },
        { author: { login: 'bob', bot: false }, at: '2026-03-02T04:00:00.000Z', fromService: false },
      );
    }
    if (bug.number === 6) issue.events.push({ type: 'reopened', label: null, actor: { login: 'reporter', bot: false }, at: '2026-03-13T00:00:00.000Z' });
    return issue;
  });
  const pullRequests: PullRequestFacts[] = [];
  for (const bug of bugs.values()) {
    const fix = bug.record.fix;
    const size = SIZES[bug.number];
    if (fix === null || fix.mergeCommitSha === null || size === undefined) continue;
    pullRequests.push({
      key: `${REPO}#${fix.prNumber}`,
      state: 'merged',
      headSha: fix.headSha,
      mergeCommitSha: fix.mergeCommitSha,
      mergedAt: fix.mergedAt ?? null,
      additions: size[0],
      deletions: size[1],
      changedFiles: size[2],
    });
  }
  return {
    repository: REPO,
    readAt: '2026-03-18T12:00:00.000Z',
    issues,
    pullRequests,
    reverts: [{ fixKey: `${REPO}#105`, revertUrl: `https://github.com/${REPO}/pull/150`, mergedAt: '2026-03-12T00:00:00.000Z' }],
    baseline,
  };
}

/** Closed issues matching BASELINE_FILTER: five untracked (10, 24, 30, 40 and 50 h) and one tracked bug. */
export const BASELINE_ISSUES = [
  { number: 90, createdAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-02T00:00:00.000Z' },
  { number: 91, createdAt: '2026-01-05T00:00:00.000Z', closedAt: '2026-01-05T10:00:00.000Z' },
  { number: 92, createdAt: '2026-01-06T00:00:00.000Z', closedAt: '2026-01-07T06:00:00.000Z' },
  { number: 93, createdAt: '2026-01-08T00:00:00.000Z', closedAt: '2026-01-10T02:00:00.000Z' },
  { number: 94, createdAt: '2026-01-11T00:00:00.000Z', closedAt: '2026-01-12T16:00:00.000Z' },
  { number: 1, createdAt: '2026-03-10T00:00:00.000Z', closedAt: '2026-03-16T00:00:00.000Z' },
];

export function session(id: string, bugKey: string | null, route: SessionFact['route'], acus: number | null, extra: Partial<SessionFact> = {}): SessionFact {
  return {
    id,
    bugKey,
    route,
    createdAt: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-10T06:00:00.000Z',
    status: 'exit',
    statusDetail: null,
    working: false,
    ended: true,
    acus,
    knowledge: null,
    ...extra,
  };
}

/** Five target sessions (10 ACUs, one at the 5 ACU cap) and one for Bug Smasher's own repository. */
export function devinSessions(): SessionFact[] {
  return [
    session('session-fix-1', `${REPO}#1`, 'fix', 2, { knowledge: ['note-a', 'note-b'] }),
    session('session-fix-2', `${REPO}#2`, 'fix', 1, { knowledge: ['note-a'] }),
    session('session-triage-10', `${REPO}#10`, 'triage', 0.5, { knowledge: [] }),
    session('session-triage-12', `${REPO}#12`, 'triage', 5, { knowledge: ['note-b'] }),
    session('session-triage-13', `${REPO}#13`, 'triage', 1.5, { createdAt: '2026-03-17T00:00:00.000Z' }),
    session('session-own-20', `${OWN_REPO}#20`, 'fix', 10, { knowledge: ['note-z'] }),
  ];
}

export function fullEvidence(bugs: Map<number, Bug>, sessions: SessionFact[] = devinSessions()): MetricsEvidence {
  return {
    github: { status: 'available', value: githubEvidence(bugs, { status: 'available', value: { filter: 'bug', issues: BASELINE_ISSUES } }) },
    devin: {
      status: 'available',
      value: {
        readAt: '2026-03-18T12:00:00.000Z',
        sessions,
        crossCheck: {
          window: { start: '2026-02-16T12:00:00.000Z', end: '2026-03-18T12:00:00.000Z' },
          usage: { status: 'unavailable', reason: 'HTTP 403' },
          sessions: { status: 'available', value: { sessionsCreatedCount: 9, sessionsWithMergedPrsCount: 3, sessionsCreatedWithPlaybookCount: 0, avgAcusPerSession: { status: 'unavailable', reason: 'not-reported' } } },
          prs: { status: 'available', value: { prsCreatedCount: 8, prsOpenedCount: 2, prsMergedCount: 7, prsClosedCount: 1 } },
        },
      },
    },
    orchestrator: { status: 'available', value: { lastCycleAt: '2026-03-18T11:59:00.000Z' } },
  };
}

/** The live set plus separate cohorts: Bug Smasher's own repository, a replay and a v1 engine run. */
export function recordSets(bugs: Map<number, Bug>): RecordSet[] {
  const own = mergedBug(20, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 120, repo: OWN_REPO });
  const replay = mergedBug(1, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 201 });
  const v1 = mergedBug(30, { enrolledAt: '2026-03-16T00:00:00.000Z', mergedAt: '2026-03-17T00:00:00.000Z', prNumber: 130 });
  return [
    { mode: 'live', engine: 'current', records: [...[...bugs.values()].map((bug) => bug.record), own.record] },
    { mode: 'replay', engine: 'current', records: [replay.record] },
    { mode: 'live', engine: 'v1', records: [v1.record] },
  ];
}
