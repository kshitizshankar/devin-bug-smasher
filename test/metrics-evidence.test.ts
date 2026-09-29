import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DevinSession } from '../src/devin/sessions.ts';
import { readDevinEvidence, readGitHubEvidence, type EvidenceDevin, type EvidenceTracker } from '../src/metrics/evidence.ts';
import { InMemoryTracker } from '../src/tracker/memory.ts';
import { headSha, mergedBug, mergeSha, NOW } from './helpers/metrics.ts';
import { Harness } from './helpers/orchestrator.ts';

function clockedTracker(): { tracker: InMemoryTracker; at: (iso: string) => void } {
  let now = '2026-03-01T00:00:00.000Z';
  return { tracker: new InMemoryTracker({ now: () => now }), at: (iso) => (now = iso) };
}

describe('metrics evidence: GitHub', () => {
  it('reads issue activity and merged pull request facts for target records only', async () => {
    const { tracker, at } = clockedTracker();
    at('2026-03-02T09:00:00.000Z');
    const issue = tracker.seedIssue({ title: 'Legend overlaps', author: 'reporter' });
    at('2026-03-02T10:00:00.000Z');
    const pr = tracker.seedPullRequest({ title: 'Fix legend', headSha: headSha(1) });
    at('2026-03-03T11:00:00.000Z');
    tracker.externalComment(issue.number, 'bob', 'Thanks!');
    at('2026-03-04T12:00:00.000Z');
    tracker.externalMerge(pr.number, 'maria', mergeSha(1));
    tracker.externalCloseIssue(issue.number, 'maria');
    at('2026-03-05T12:00:00.000Z');
    tracker.externalReopenIssue(issue.number, 'reporter');

    const target = mergedBug(issue.number, { enrolledAt: '2026-03-02T09:00:00.000Z', mergedAt: '2026-03-04T12:00:00.000Z', prNumber: pr.number });
    const foreign = mergedBug(7, { enrolledAt: '2026-03-02T09:00:00.000Z', mergedAt: '2026-03-04T12:00:00.000Z', prNumber: 8, repo: 'acme/other' });
    const result = await readGitHubEvidence(tracker, [target.record, foreign.record], null, NOW);

    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    const evidence = result.value;
    assert.equal(evidence.repository, 'acme/widgets');
    assert.equal(evidence.readAt, NOW.toISOString());
    assert.deepEqual(evidence.issues.map((entry) => entry.key), ['acme/widgets#1']);
    const activity = evidence.issues[0];
    assert.equal(activity?.createdAt, '2026-03-02T09:00:00.000Z');
    assert.deepEqual(activity?.author, { login: 'reporter', bot: false });
    assert.deepEqual(activity?.comments, [{ author: { login: 'bob', bot: false }, at: '2026-03-03T11:00:00.000Z', fromService: false }]);
    assert.deepEqual(activity?.events.map((event) => [event.type, event.actor?.login, event.at]), [
      ['closed', 'maria', '2026-03-04T12:00:00.000Z'],
      ['reopened', 'reporter', '2026-03-05T12:00:00.000Z'],
    ]);
    assert.deepEqual(evidence.pullRequests, [
      {
        key: 'acme/widgets#2',
        state: 'merged',
        headSha: headSha(1),
        mergeCommitSha: mergeSha(1),
        mergedAt: '2026-03-04T12:00:00.000Z',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
      },
    ]);
    assert.deepEqual(evidence.reverts, []);
    assert.deepEqual(evidence.baseline, { status: 'unavailable', reason: 'BASELINE_FILTER is not set' });
  });

  it('finds merged reverts of a fix and closed issues matching every BASELINE_FILTER label', async () => {
    const { tracker, at } = clockedTracker();
    const issue = tracker.seedIssue({ title: 'Crash' });
    const fix = tracker.seedPullRequest({ title: 'Fix crash', headSha: headSha(1) });
    tracker.externalMerge(fix.number, 'maria', mergeSha(1));
    const revert = tracker.seedPullRequest({ title: 'Revert "Fix crash"', body: `Reverts acme/widgets#${fix.number}`, headSha: headSha(3) });
    at('2026-03-06T08:00:00.000Z');
    tracker.externalMerge(revert.number, 'maria', mergeSha(3));
    const mention = tracker.seedPullRequest({ title: 'Revert unrelated', body: 'Reverts acme/widgets#99', headSha: headSha(4) });
    tracker.externalMerge(mention.number, 'maria', mergeSha(4));
    at('2026-03-01T00:00:00.000Z');
    const comparable = tracker.seedIssue({ title: 'Old bug', labels: ['Bug', 'area:ui'] });
    const other = tracker.seedIssue({ title: 'Old chore', labels: ['bug'] });
    const stub: EvidenceTracker = {
      repo: tracker.repo,
      getIssue: (number) => tracker.getIssue(number),
      listComments: (number) => tracker.listComments(number),
      listIssueEvents: (number) => tracker.listIssueEvents(number),
      getPullRequest: (number) => tracker.getPullRequest(number),
      findLinkedPullRequests: async (number) =>
        number === fix.number
          ? [
              { pullRequest: await tracker.getPullRequest(revert.number), relation: 'mention' },
              { pullRequest: await tracker.getPullRequest(mention.number), relation: 'mention' },
            ]
          : [],
      listAllIssues: async () => [
        { ...(await tracker.getIssue(comparable.number)), state: 'closed', stateReason: 'completed', closedAt: '2026-03-03T00:00:00.000Z' },
        { ...(await tracker.getIssue(other.number)), state: 'closed', stateReason: 'completed', closedAt: '2026-03-03T00:00:00.000Z' },
        { ...(await tracker.getIssue(issue.number)), labels: ['bug', 'area:ui'] },
      ],
    };
    const bug = mergedBug(issue.number, { enrolledAt: '2026-03-01T00:00:00.000Z', mergedAt: '2026-03-02T00:00:00.000Z', prNumber: fix.number });
    const result = await readGitHubEvidence(stub, [bug.record], ' bug , AREA:UI ', NOW);

    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    assert.deepEqual(result.value.reverts, [
      { fixKey: `acme/widgets#${fix.number}`, revertUrl: `https://github.com/acme/widgets/pull/${revert.number}`, mergedAt: '2026-03-06T08:00:00.000Z' },
    ]);
    assert.deepEqual(result.value.baseline, {
      status: 'available',
      value: { filter: ' bug , AREA:UI ', issues: [{ number: comparable.number, createdAt: '2026-03-01T00:00:00.000Z', closedAt: '2026-03-03T00:00:00.000Z' }] },
    });
  });

  it('says why the baseline is missing when the tracker cannot list closed issues', async () => {
    const { tracker } = clockedTracker();
    const result = await readGitHubEvidence(tracker, [], 'bug', NOW);
    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    assert.deepEqual(result.value.baseline, { status: 'unavailable', reason: 'The tracker cannot list closed issues' });
  });

  it('reports GitHub as unavailable instead of partial figures when a read fails', async () => {
    const { tracker } = clockedTracker();
    tracker.seedIssue({ title: 'Crash' });
    tracker.failNext('getIssue', 'rate-limited');
    const bug = mergedBug(1, { enrolledAt: '2026-03-01T00:00:00.000Z', mergedAt: '2026-03-02T00:00:00.000Z', prNumber: 2 });
    const result = await readGitHubEvidence(tracker, [bug.record], null, NOW);
    assert.equal(result.status, 'unavailable');
  });
});

function devinSession(id: string, tags: string[], overrides: Partial<DevinSession> = {}): DevinSession {
  return {
    id,
    url: `https://app.devin.ai/sessions/${id}`,
    title: null,
    tags,
    status: 'running',
    statusDetail: null,
    activity: { kind: 'working' },
    liveState: 'running',
    createdAt: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-11T00:00:00.000Z',
    isArchived: false,
    acus: { status: 'reported', acus: 2.5 },
    pullRequests: [],
    structuredOutput: { status: 'absent' },
    ...overrides,
  };
}

describe('metrics evidence: Devin', () => {
  it('reads tagged sessions, their ACUs and Knowledge use, and the cross-check window', async () => {
    const windows: { after: Date; before: Date }[] = [];
    const client: EvidenceDevin = {
      findSessions: async (tags) => {
        assert.deepEqual(tags, ['bug-smasher']);
        return [
          devinSession('s1', ['bug-smasher', 'bug-smasher:bug=acme/widgets#1', 'bug-smasher:route=fix']),
          devinSession('s2', ['bug-smasher', 'bug-smasher:route=unknown'], { activity: { kind: 'ended', reason: 'exit', detail: null }, acus: { status: 'unavailable', reason: 'zero-reported' } }),
        ];
      },
      getInsights: async (sessionId) =>
        sessionId === 's1'
          ? {
              status: 'available',
              insights: {
                sessionId,
                acus: { status: 'reported', acus: 2.5 },
                sessionSize: null,
                userMessages: null,
                devinMessages: null,
                issues: [],
                actionItems: [],
                suggestedPrompt: null,
                knowledgeUsed: {
                  helpful: [{ noteId: 'note-b', reason: '', message: '' }, { noteId: 'note-a', reason: '', message: '' }],
                  unhelpful: [{ noteId: 'note-b', reason: '', message: '' }],
                },
                skillsUsed: null,
              },
            }
          : { status: 'unavailable', reason: 'not-generated', detail: 'none yet' },
      getUsageMetrics: async (window) => {
        if (window !== undefined) windows.push(window);
        return { status: 'available', value: { sessionsCount: 2, searchesCount: 0, prsCreatedCount: 1, prsMergedCount: 1 } };
      },
      getSessionMetrics: async () => ({ status: 'unavailable', reason: 'forbidden', detail: 'metrics need an admin key' }),
      getPrMetrics: async () => ({ status: 'unavailable', reason: 'not-found', detail: 'no PR metrics' }),
    };
    const result = await readDevinEvidence(client, NOW);

    assert.equal(result.status, 'available');
    if (result.status !== 'available') return;
    const [first, second] = result.value.sessions;
    assert.deepEqual(first, {
      id: 's1',
      bugKey: 'acme/widgets#1',
      route: 'fix',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-11T00:00:00.000Z',
      status: 'running',
      statusDetail: null,
      working: true,
      ended: false,
      acus: 2.5,
      knowledge: ['note-a', 'note-b'],
    });
    assert.equal(second?.bugKey, null);
    assert.equal(second?.route, null);
    assert.equal(second?.ended, true);
    assert.equal(second?.acus, null, 'zero-reported ACUs stay unavailable');
    assert.equal(second?.knowledge, null);
    assert.deepEqual(result.value.crossCheck.window, { start: '2026-02-16T12:00:00.000Z', end: NOW.toISOString() });
    assert.deepEqual(windows.map((window) => window.after.toISOString()), ['2026-02-16T12:00:00.000Z']);
    assert.equal(result.value.crossCheck.usage.status, 'available');
    assert.deepEqual(result.value.crossCheck.sessions, { status: 'unavailable', reason: 'metrics need an admin key' });
    assert.deepEqual(result.value.crossCheck.prs, { status: 'unavailable', reason: 'no PR metrics' });
  });
});

describe('orchestrator liveness', () => {
  it('records when the last cycle finished, including a cycle that found nothing to do', async () => {
    const h = await Harness.create();
    try {
      assert.equal(h.orchestrator.lastCycleAt, null);
      await h.cycle(1);
      const first = h.orchestrator.lastCycleAt;
      assert.ok(first !== null && !Number.isNaN(Date.parse(first)));
      await h.cycle(1);
      assert.ok(Date.parse(h.orchestrator.lastCycleAt ?? '') > Date.parse(first));
    } finally {
      await h.close();
    }
  });
});

