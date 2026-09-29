import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryTracker } from '../src/tracker/memory.ts';
import { HEAD_1, rejectsWith, trackerContract } from './helpers/tracker-contract.ts';

trackerContract('InMemoryTracker', async () => {
  const tracker = new InMemoryTracker();
  return { tracker, sim: tracker, serviceLogin: tracker.actor.login, close: async () => {} };
});

describe('InMemoryTracker', () => {
  it('returns copies so callers cannot mutate tracker state', async () => {
    const tracker = new InMemoryTracker();
    const issue = tracker.seedIssue({ title: 'bug', labels: ['needs-triage'] });
    const read = await tracker.getIssue(issue.number);
    read.labels.push('tampered');
    assert.deepEqual((await tracker.getIssue(issue.number)).labels, ['needs-triage']);
  });

  it('keeps the destination label when removing the source fails', async () => {
    const tracker = new InMemoryTracker();
    const issue = tracker.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
    tracker.failNext('removeLabel', 'server-error');
    await rejectsWith(tracker.moveLabel(issue.number, { from: 'bug-smasher', to: 'needs-engineer' }), 'server-error');
    assert.deepEqual((await tracker.getIssue(issue.number)).labels, ['bug-smasher', 'needs-engineer']);
  });

  it('refuses issue operations on pull request numbers', async () => {
    const tracker = new InMemoryTracker();
    const pr = tracker.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
    await rejectsWith(tracker.addLabels(pr.number, ['x']), 'not-an-issue');
  });
});
