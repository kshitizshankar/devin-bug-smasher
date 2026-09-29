import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FailurePoint, SeedIssue, SeedPullRequest, SimulatedFailure } from '../../src/tracker/memory.ts';
import { TrackerError, type ReviewState, type Tracker, type TrackerErrorCode } from '../../src/tracker/types.ts';

/** Simulation surface shared by `InMemoryTracker` and the fake GitHub server. */
export interface TrackerSimulator {
  failNext(point: FailurePoint, failure: SimulatedFailure | TrackerErrorCode): void;
  seedIssue(seed: SeedIssue): { number: number };
  seedPullRequest(seed: SeedPullRequest): { number: number };
  externalComment(issueNumber: number, login: string, body: string): { id: string };
  externalLabel(issueNumber: number, label: string, action: 'add' | 'remove', login: string): void;
  externalCloseIssue(issueNumber: number, login: string): void;
  externalReopenIssue(issueNumber: number, login: string): void;
  externalMerge(prNumber: number, login: string): string;
  externalClosePullRequest(prNumber: number): void;
  pushHead(prNumber: number, headSha: string): void;
  blockMerge(prNumber: number, reason: string | null): void;
  addReview(prNumber: number, review: { reviewer: string; state: ReviewState; commitId?: string; body?: string }): { id: string };
  addCheckRun(sha: string, run: { name: string; status: string; conclusion: string | null; app?: string }): { id: string };
  addReviewThread(
    prNumber: number,
    thread: { author: string; body: string; path?: string; line?: number; commitSha?: string; outdated?: boolean },
  ): { id: string };
  resolveReviewThread(prNumber: number, threadId: string): void;
  setBranch(name: string, branch: { sha: string; protected?: boolean; requiredChecks?: string[] | null; default?: boolean }): void;
}

export interface TrackerHarness {
  tracker: Tracker;
  sim: TrackerSimulator;
  /** Login the tracker acts as. */
  serviceLogin: string;
  close(): Promise<void>;
}

export const HEAD_1 = '1'.repeat(40);
export const HEAD_2 = '2'.repeat(40);

export async function rejectsWith(promise: Promise<unknown>, code: TrackerErrorCode): Promise<TrackerError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TrackerError, `expected TrackerError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

/**
 * Behaviour every `Tracker` must share. Runs against `InMemoryTracker` and against `GitHubTracker` talking to the
 * fake GitHub server, so the offline stand-in cannot drift from the adapter.
 */
export function trackerContract(name: string, setup: () => Promise<TrackerHarness>): void {
  describe(`${name}: tracker contract`, () => {
    let h: TrackerHarness;
    beforeEach(async () => {
      h = await setup();
    });
    afterEach(async () => {
      await h.close();
    });

    it('lists open issues with any requested label, excluding PRs, closed and unlabelled issues', async () => {
      const a = h.sim.seedIssue({ title: 'triage me', labels: ['needs-triage'] });
      const b = h.sim.seedIssue({ title: 'build me', labels: ['devin-builds-feature', 'needs-triage'] });
      h.sim.seedIssue({ title: 'unlabelled' });
      h.sim.seedIssue({ title: 'closed', labels: ['needs-triage'], state: 'closed' });
      h.sim.seedPullRequest({ title: 'labelled PR', headSha: HEAD_1, labels: ['needs-triage'] });
      const c = h.sim.seedIssue({ title: 'engineer', labels: ['Needs-Engineer'] });
      const d = h.sim.seedIssue({ title: 'late', labels: ['needs-triage'] });

      const issues = await h.tracker.listOpenIssues(['needs-triage', 'devin-builds-feature', 'needs-engineer']);
      assert.deepEqual(
        issues.map((issue) => issue.number),
        [a.number, b.number, c.number, d.number],
      );
      const first = issues[0];
      assert.equal(first?.key, `${h.tracker.repo.owner}/${h.tracker.repo.name}#${a.number}`);
      assert.equal(first?.state, 'open');
      assert.equal(first?.author?.login, 'reporter');
      assert.deepEqual(await h.tracker.listOpenIssues([]), []);
    });

    it('reads a known issue after it was closed and unlabelled, and refuses PRs and unknown numbers', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', body: 'steps', labels: ['needs-triage'] });
      h.sim.externalLabel(issue.number, 'needs-triage', 'remove', 'maintainer');
      h.sim.externalCloseIssue(issue.number, 'maintainer');
      const read = await h.tracker.getIssue(issue.number);
      assert.equal(read.state, 'closed');
      assert.deepEqual(read.labels, []);
      assert.equal(read.body, 'steps');
      assert.ok(read.closedAt);

      const pr = h.sim.seedPullRequest({ title: 'fix', headSha: HEAD_1 });
      await rejectsWith(h.tracker.getIssue(pr.number), 'not-an-issue');
      await rejectsWith(h.tracker.getIssue(999), 'not-found');
      await rejectsWith(h.tracker.getIssue(0), 'validation');
    });

    it('creates issues with labels', async () => {
      const created = await h.tracker.createIssue({ title: 'Found during verification', body: 'details', labels: ['needs-triage'] });
      assert.equal(created.state, 'open');
      assert.deepEqual(created.labels, ['needs-triage']);
      assert.equal(created.author?.login, h.serviceLogin);
      assert.equal((await h.tracker.getIssue(created.number)).title, 'Found during verification');
      await rejectsWith(h.tracker.createIssue({ title: ' ', body: '' }), 'validation');
    });

    it('preserves comment IDs and authors, marks service comments and deduplicates keyed posts', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      const question = await h.tracker.postComment(issue.number, 'Which browser?', { key: 'question:q1' });
      assert.equal(question.fromService, true);
      assert.equal(question.serviceKey, 'question:q1');
      assert.equal(question.author?.login, h.serviceLogin);
      const reply = h.sim.externalComment(issue.number, 'reporter', 'Firefox 130');

      const retried = await h.tracker.postComment(issue.number, 'Which browser?', { key: 'question:q1' });
      assert.equal(retried.id, question.id, 'a retried keyed post returns the existing comment');
      const plain = await h.tracker.postComment(issue.number, 'Status update');
      assert.equal(plain.serviceKey, null);
      assert.equal(plain.fromService, true);

      const comments = await h.tracker.listComments(issue.number);
      assert.deepEqual(
        comments.map((comment) => comment.id),
        [question.id, reply.id, plain.id],
      );
      const external = comments[1];
      assert.equal(external?.author?.login, 'reporter');
      assert.equal(external?.fromService, false);
      assert.equal(external?.body, 'Firefox 130');
      assert.ok(external?.url.includes(`#issuecomment-${reply.id}`));
      await rejectsWith(h.tracker.postComment(issue.number, 'x', { key: 'bad key' }), 'validation');
    });

    it('does not duplicate a keyed comment whose post failed after GitHub applied it', async () => {
      const issue = h.sim.seedIssue({ title: 'bug' });
      h.sim.failNext('postComment', { code: 'server-error', applied: true });
      const error = await rejectsWith(h.tracker.postComment(issue.number, 'Plan ready', { key: 'plan:1' }), 'server-error');
      assert.equal(error.ambiguous, true);
      assert.equal(error.retryable, true);
      const retried = await h.tracker.postComment(issue.number, 'Plan ready', { key: 'plan:1' });
      const comments = await h.tracker.listComments(issue.number);
      assert.equal(comments.length, 1);
      assert.equal(comments[0]?.id, retried.id);
    });

    it('reports label, close and reopen events with actor, time and stable IDs', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['needs-triage'] });
      await h.tracker.moveLabel(issue.number, { from: 'needs-triage', to: 'bug-smasher' });
      h.sim.externalComment(issue.number, 'reporter', 'thanks');
      h.sim.externalCloseIssue(issue.number, 'maintainer');
      h.sim.externalReopenIssue(issue.number, 'reporter');

      const events = await h.tracker.listIssueEvents(issue.number);
      assert.deepEqual(
        events.map((event) => [event.type, event.label, event.actor?.login]),
        [
          ['labeled', 'bug-smasher', h.serviceLogin],
          ['unlabeled', 'needs-triage', h.serviceLogin],
          ['closed', null, 'maintainer'],
          ['reopened', null, 'reporter'],
        ],
      );
      assert.equal(new Set(events.map((event) => event.id)).size, events.length);
      for (const event of events) assert.ok(!Number.isNaN(Date.parse(event.at)));
      const again = await h.tracker.listIssueEvents(issue.number);
      assert.deepEqual(
        again.map((event) => event.id),
        events.map((event) => event.id),
      );
    });

    it('moves labels by adding the destination before removing the source', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['needs-triage', 'priority'] });
      assert.deepEqual(await h.tracker.moveLabel(issue.number, { from: 'needs-triage', to: 'bug-smasher' }), [
        'priority',
        'bug-smasher',
      ]);
      assert.deepEqual(await h.tracker.moveLabel(issue.number, { from: 'needs-triage', to: 'bug-smasher' }), [
        'priority',
        'bug-smasher',
      ]);
      assert.deepEqual(await h.tracker.removeLabel(issue.number, 'absent'), ['priority', 'bug-smasher']);
      assert.deepEqual(await h.tracker.addLabels(issue.number, ['bug-smasher', 'needs-engineer']), [
        'priority',
        'bug-smasher',
        'needs-engineer',
      ]);
    });

    it('keeps the source label when adding the destination label fails', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      h.sim.failNext('addLabels', 'forbidden');
      const error = await rejectsWith(h.tracker.moveLabel(issue.number, { from: 'bug-smasher', to: 'needs-engineer' }), 'forbidden');
      assert.equal(error.operation, 'moveLabel');
      assert.equal(error.retryable, false);
      assert.deepEqual((await h.tracker.getIssue(issue.number)).labels, ['bug-smasher']);
    });

    it('closes and reopens issues and observes external changes', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['bug-smasher'] });
      const closed = await h.tracker.closeIssue(issue.number, { reason: 'not_planned' });
      assert.equal(closed.state, 'closed');
      assert.equal(closed.stateReason, 'not_planned');
      h.sim.externalReopenIssue(issue.number, 'reporter');
      assert.equal((await h.tracker.getIssue(issue.number)).state, 'open');
      h.sim.externalCloseIssue(issue.number, 'maintainer');
      const reopened = await h.tracker.reopenIssue(issue.number);
      assert.equal(reopened.state, 'open');
      assert.equal(reopened.closedAt, null);
    });

    it('finds linked PRs and classifies only exact closing references as closing', async () => {
      const issue = h.sim.seedIssue({ title: 'bug' });
      const closing = h.sim.seedPullRequest({ title: 'Fix crash', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
      const mention = h.sim.seedPullRequest({
        title: 'Refactor',
        body: `Related to #${issue.number}; fixes #${issue.number}0`,
        headSha: HEAD_2,
        references: [issue.number],
      });
      h.sim.seedPullRequest({ title: `Unrelated fixes #${issue.number}`, headSha: HEAD_2 });

      const linked = await h.tracker.findLinkedPullRequests(issue.number);
      assert.deepEqual(
        linked.map((link) => [link.pullRequest.number, link.relation]),
        [
          [closing.number, 'closing'],
          [mention.number, 'mention'],
        ],
      );
      assert.equal(linked[0]?.pullRequest.headSha, HEAD_1);
      assert.equal(linked[0]?.pullRequest.state, 'open');
    });

    it('distinguishes closed-unmerged PRs from merged ones and never exposes an unmerged merge SHA', async () => {
      const issue = h.sim.seedIssue({ title: 'bug' });
      const abandoned = h.sim.seedPullRequest({ title: 'Try 1', headSha: HEAD_1 });
      const fix = h.sim.seedPullRequest({ title: 'Fix', body: `Closes #${issue.number}`, headSha: HEAD_2, references: [issue.number] });

      const open = await h.tracker.getPullRequest(fix.number);
      assert.equal(open.state, 'open');
      assert.equal(open.mergeCommitSha, null);

      h.sim.externalClosePullRequest(abandoned.number);
      const closed = await h.tracker.getPullRequest(abandoned.number);
      assert.equal(closed.state, 'closed');
      assert.equal(closed.mergeCommitSha, null);
      assert.equal(closed.mergedBy, null);

      const sha = h.sim.externalMerge(fix.number, 'maintainer');
      const merged = await h.tracker.getPullRequest(fix.number);
      assert.equal(merged.state, 'merged');
      assert.equal(merged.mergeCommitSha, sha);
      assert.equal(merged.mergedBy?.login, 'maintainer');
      assert.equal((await h.tracker.getIssue(issue.number)).state, 'closed', 'GitHub closes the linked issue');
      await rejectsWith(h.tracker.getPullRequest(issue.number), 'not-found');
    });

    it('merges only at the expected head, honours branch protection and is idempotent', async () => {
      const pr = h.sim.seedPullRequest({ title: 'Fix', headSha: HEAD_1 });
      h.sim.pushHead(pr.number, HEAD_2);
      await rejectsWith(h.tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_1 }), 'head-mismatch');
      assert.equal((await h.tracker.getPullRequest(pr.number)).state, 'open', 'a moved head is never merged');

      h.sim.blockMerge(pr.number, 'At least 1 approving review is required by reviewers with write access.');
      const blocked = await rejectsWith(h.tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_2 }), 'not-mergeable');
      assert.match(blocked.message, /approving review/);
      h.sim.blockMerge(pr.number, null);

      const result = await h.tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_2, method: 'squash' });
      assert.equal(result.alreadyMerged, false);
      assert.match(result.mergeCommitSha, /^[0-9a-f]{40}$/);
      const again = await h.tracker.mergePullRequest(pr.number, { expectedHeadSha: HEAD_2 });
      assert.deepEqual(again, { mergeCommitSha: result.mergeCommitSha, alreadyMerged: true });
      assert.equal((await h.tracker.getPullRequest(pr.number)).mergedBy?.login, h.serviceLogin);

      const closed = h.sim.seedPullRequest({ title: 'Abandoned', headSha: HEAD_1 });
      h.sim.externalClosePullRequest(closed.number);
      await rejectsWith(h.tracker.mergePullRequest(closed.number, { expectedHeadSha: HEAD_1 }), 'not-open');
      await rejectsWith(h.tracker.mergePullRequest(pr.number, { expectedHeadSha: 'abc' }), 'validation');
    });

    it('reports PR files, diff and reviews, flagging incomplete data', async () => {
      const file = { filename: 'src/a.ts', previousFilename: null, status: 'modified', additions: 2, deletions: 1, changes: 3, patch: '@@ -1 +1,2 @@' };
      const pr = h.sim.seedPullRequest({ title: 'Fix', headSha: HEAD_1, files: [file], diff: 'diff --git a/src/a.ts b/src/a.ts\n' });
      const files = await h.tracker.listPullRequestFiles(pr.number);
      assert.deepEqual(files, { files: [file], complete: true, expectedCount: 1 });
      assert.deepEqual(await h.tracker.getPullRequestDiff(pr.number), { complete: true, diff: 'diff --git a/src/a.ts b/src/a.ts\n' });

      const huge = h.sim.seedPullRequest({ title: 'Huge', headSha: HEAD_2, files: [file], changedFiles: 3500, diff: null });
      const partial = await h.tracker.listPullRequestFiles(huge.number);
      assert.equal(partial.complete, false);
      assert.equal(partial.expectedCount, 3500);
      const diff = await h.tracker.getPullRequestDiff(huge.number);
      assert.equal(diff.complete, false);

      const approval = h.sim.addReview(pr.number, { reviewer: 'maintainer', state: 'approved' });
      h.sim.pushHead(pr.number, HEAD_2);
      const reviews = await h.tracker.listReviews(pr.number);
      assert.deepEqual(
        reviews.map((review) => [review.id, review.state, review.reviewer?.login, review.commitId]),
        [[approval.id, 'approved', 'maintainer', HEAD_1]],
      );
      assert.notEqual(reviews[0]?.commitId, (await h.tracker.getPullRequest(pr.number)).headSha, 'stale approval is visible');
    });

    it('reads check runs and combined statuses and creates commit statuses', async () => {
      h.sim.addCheckRun(HEAD_1, { name: 'typecheck', status: 'completed', conclusion: 'success' });
      h.sim.addCheckRun(HEAD_1, { name: 'build-and-smoke-test', status: 'in_progress', conclusion: null });
      const checks = await h.tracker.listCheckRuns(HEAD_1);
      assert.equal(checks.complete, true);
      assert.equal(checks.totalCount, 2);
      assert.deepEqual(
        checks.runs.map((run) => [run.name, run.status, run.conclusion, run.app]),
        [
          ['typecheck', 'completed', 'success', 'github-actions'],
          ['build-and-smoke-test', 'in_progress', null, 'github-actions'],
        ],
      );

      assert.equal((await h.tracker.getCombinedStatus(HEAD_1)).state, 'pending');
      await h.tracker.createCommitStatus(HEAD_1, { context: 'bug-smasher/verify', state: 'pending', description: 'x'.repeat(200) });
      const done = await h.tracker.createCommitStatus(HEAD_1, {
        context: 'bug-smasher/verify',
        state: 'success',
        description: 'verified',
        targetUrl: 'https://example.test/evidence',
      });
      assert.equal(done.creator?.login, h.serviceLogin);
      const combined = await h.tracker.getCombinedStatus(HEAD_1);
      assert.equal(combined.sha, HEAD_1);
      assert.equal(combined.state, 'success');
      assert.deepEqual(
        combined.statuses.map((status) => [status.id, status.state, status.targetUrl]),
        [[done.id, 'success', 'https://example.test/evidence']],
      );
      await h.tracker.createCommitStatus(HEAD_1, { context: 'other', state: 'failure' });
      assert.equal((await h.tracker.getCombinedStatus(HEAD_1)).state, 'failure');
      await rejectsWith(h.tracker.createCommitStatus('main', { context: 'x', state: 'success' }), 'validation');
    });

    it('lists review threads with their first comment, commit and resolution', async () => {
      const pr = h.sim.seedPullRequest({ title: 'Fix', headSha: HEAD_1 });
      const first = h.sim.addReviewThread(pr.number, { author: 'devin-ai-integration[bot]', body: 'Off by one', path: 'src/a.ts', line: 3 });
      const second = h.sim.addReviewThread(pr.number, { author: 'maintainer', body: 'Nit', commitSha: HEAD_2, outdated: true });
      h.sim.resolveReviewThread(pr.number, second.id);
      const threads = await h.tracker.listReviewThreads(pr.number);
      assert.deepEqual(
        threads.map((thread) => [thread.id, thread.isResolved, thread.isOutdated, thread.path, thread.line, thread.commitSha, thread.comments[0]?.authorLogin, thread.comments[0]?.body]),
        [
          [first.id, false, false, 'src/a.ts', 3, HEAD_1, 'devin-ai-integration[bot]', 'Off by one'],
          [second.id, true, true, null, null, HEAD_2, 'maintainer', 'Nit'],
        ],
      );
      assert.ok(threads[0]?.comments[0]?.url.startsWith('https://'));
      await rejectsWith(h.tracker.listReviewThreads(9999), 'not-found');
    });

    it('reports branch protection required checks, and unreadable requirements as unknown', async () => {
      assert.deepEqual(await h.tracker.getDefaultBranch(), { name: 'main', sha: (await h.tracker.getDefaultBranch()).sha, protected: false, requiredChecks: [] });
      h.sim.setBranch('main', { sha: HEAD_1, requiredChecks: ['bug-smasher/verification', 'ci'], default: true });
      assert.deepEqual(await h.tracker.getBranch('main'), {
        name: 'main',
        sha: HEAD_1,
        protected: true,
        requiredChecks: ['bug-smasher/verification', 'ci'],
      });
      h.sim.setBranch('release', { sha: HEAD_2, requiredChecks: null });
      assert.deepEqual(await h.tracker.getBranch('release'), { name: 'release', sha: HEAD_2, protected: true, requiredChecks: null });
      h.sim.setBranch('dev', { sha: HEAD_2, default: true });
      assert.equal((await h.tracker.getDefaultBranch()).name, 'dev');
      await rejectsWith(h.tracker.getBranch('missing'), 'not-found');
    });

    it('reports rate limits and server errors as retryable with a wait hint', async () => {
      const issue = h.sim.seedIssue({ title: 'bug', labels: ['needs-triage'] });
      h.sim.failNext('listOpenIssues', 'rate-limited');
      const limited = await rejectsWith(h.tracker.listOpenIssues(['needs-triage']), 'rate-limited');
      assert.equal(limited.retryable, true);
      assert.ok((limited.retryAfterSeconds ?? 0) > 0);
      assert.equal(limited.ambiguous, false);

      h.sim.failNext('getIssue', 'server-error');
      const failed = await rejectsWith(h.tracker.getIssue(issue.number), 'server-error');
      assert.equal(failed.retryable, true);
      assert.equal(failed.ambiguous, false, 'a failed read changed nothing');

      h.sim.failNext('closeIssue', 'server-error');
      assert.equal((await rejectsWith(h.tracker.closeIssue(issue.number), 'server-error')).ambiguous, true);
      assert.deepEqual(
        (await h.tracker.listOpenIssues(['needs-triage'])).map((open) => open.number),
        [issue.number],
      );
    });
  });
}
