import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { attention, presentBug, type Presentation } from '../src/model/presentation.ts';
import type { BugRecord, DiffFinding, ReproductionOutcome } from '../src/model/types.ts';
import { READY_STATUS_CONTEXT, type Reproducer, type ReproductionRequest, type ReproductionResult, type VerificationOutcome, type VerificationRequest, type Verifier } from '../src/orchestrator/contracts.ts';
import type { Env } from '../src/config/settings.ts';
import { toGitHubFacts } from '../src/tracker/common.ts';
import type { TrackerPullRequest } from '../src/tracker/types.ts';
import { Harness, report } from './helpers/orchestrator.ts';

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);
const BOT = 'devin-ai-integration[bot]';
const ADDRESSING_REVIEW = '<!-- devin-review-autofix-status -->\n## Devin is addressing Devin Review findings';
const DONE_REVIEW = '<!-- devin-review-autofix-status -->\n## 2 findings need your review';

/** Passes pre-merge verification and returns scripted post-merge results. */
class World implements Verifier, Reproducer {
  readonly live = true;
  readonly calls: VerificationRequest[] = [];
  readonly reproductions: ReproductionRequest[] = [];
  flags: DiffFinding[] = [];
  postMerge: 'pass' | 'fail' = 'pass';
  reproduction: ReproductionOutcome = 'reproduced';

  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    this.calls.push(request);
    const result = request.phase === 'post-merge' ? this.postMerge : 'pass';
    return {
      status: 'completed',
      attempt: {
        phase: request.phase,
        baseSha: request.baseSha,
        headSha: request.headSha,
        result,
        reason: result === 'pass' ? 'The selected tests fail on base and pass on head' : 'The selected tests fail on head',
        outputTail: `${result} output`,
        at: new Date(0).toISOString(),
        evidence: { runs: [], violations: [], flags: request.phase === 'pre-merge' ? [...this.flags] : [] },
      },
    };
  }

  async reproduce(request: ReproductionRequest): Promise<ReproductionResult> {
    this.reproductions.push(request);
    return {
      status: 'completed',
      check: { sha: request.sha, testFile: request.testFile, outcome: this.reproduction, reason: `test ${this.reproduction}`, at: new Date(0).toISOString(), runs: [] },
    };
  }
}

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function setup(t: TestContext, env: Env = {}): Promise<{ h: Harness; world: World }> {
  const world = new World();
  const h = await Harness.create({ env, verifier: world, reproducer: world });
  harness = h;
  t.after(() => report(t, h));
  return { h, world };
}

async function until(h: Harness, key: string, done: (record: BugRecord) => boolean, cycles = 12): Promise<BugRecord> {
  for (let index = 0; index < cycles; index += 1) {
    if (done(h.record(key))) return h.record(key);
    await h.cycle();
  }
  assert.fail(`condition not reached; stage ${h.record(key).stage}`);
}

interface Fix {
  h: Harness;
  world: World;
  key: string;
  issueNumber: number;
  sessionId: string;
  pr: TrackerPullRequest;
}

/** A fix-labelled issue with a PR whose head HEAD_1 passed verification (`ready-to-merge`). */
async function readyFix(t: TestContext, env: Env = {}, options: { review?: boolean } = {}): Promise<Fix> {
  const { h, world } = await setup(t, env);
  const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels: ['bug-smasher'], author: 'reporter' });
  await h.cycle(2);
  const sessionId = h.sessionId(issue.key);
  const pr = h.tracker.seedPullRequest({
    title: 'Fix legend',
    body: `Fixes #${issue.number}`,
    headSha: HEAD_1,
    references: [issue.number],
    files: [{ filename: 'src/legend.ts', previousFilename: null, status: 'modified', additions: 20, deletions: 0, changes: 20, patch: null }],
  });
  if (options.review !== false) h.offline.pullRequestHeads.set(pr.url, HEAD_1);
  h.opensPr(sessionId, pr.url);
  await until(h, issue.key, (record) => record.stage === 'ready-to-merge');
  return { h, world, key: issue.key, issueNumber: issue.number, sessionId, pr };
}

function greenCi(h: Harness, sha: string): void {
  h.tracker.addCheckRun(sha, { name: 'test', status: 'completed', conclusion: 'success' });
}

/** Completes the requested Devin Review of `head` with no findings. */
async function reviewed(f: Fix, head = HEAD_1): Promise<void> {
  await until(f.h, f.key, (record) => (record.review?.rounds.some((round) => round.headSha === head) ?? false));
  const review = f.h.offline.reviews.get(f.pr.url);
  assert.equal(review?.commit_sha, head);
  f.h.offline.reviews.set(f.pr.url, { ...review, status: 'completed' });
  await until(f.h, f.key, (record) => record.review?.rounds.find((round) => round.headSha === head)?.status === 'completed');
}

function mergeEvaluations(record: BugRecord) {
  return (record.evaluations ?? []).filter((evaluation) => evaluation.kind === 'merge');
}

/** The service's `bug-smasher/ready` status on `sha`, or `null` when none was published. */
async function readyOf(h: Harness, sha: string) {
  const combined = await h.tracker.getCombinedStatus(sha);
  return combined.statuses.find((status) => status.context === READY_STATUS_CONTEXT) ?? null;
}

/** What the overview and API show as the bug's next action. */
async function nextAction(f: Fix): Promise<{ gate: string | null; waitingOn: string | null; text: string }> {
  const record = f.h.record(f.key);
  const issue = await f.h.tracker.getIssue(f.issueNumber);
  const pr = await f.h.tracker.getPullRequest(f.pr.number);
  const presentation: Presentation = presentBug(record, toGitHubFacts(f.h.tracker.repo, issue, pr), f.h.settings.labels);
  return attention(presentation);
}

describe('bug-smasher/ready', () => {
  it('is pending on the head while Devin is still working, and the next action never asks for the merge', async (t) => {
    const f = await readyFix(t);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success', 4);

    f.h.working(f.sessionId);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'pending');
    const status = await readyOf(f.h, HEAD_1);
    assert.equal(status?.state, 'pending');
    assert.match(status?.description ?? '', /Devin is still working on this: the Devin session is still working/);

    const next = await nextAction(f);
    assert.match(next.text, /Devin is still working on the pull request/);
    assert.doesNotMatch(next.text, /merge/i);
    assert.equal(next.waitingOn, 'devin');
    assert.notEqual(next.gate, 'merge');
  });

  it('is pending while Devin’s review comment says it is addressing findings, and turns success when it no longer does', async (t) => {
    const f = await readyFix(t);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success', 4);

    f.h.tracker.addReview(f.pr.number, { reviewer: BOT, state: 'commented', body: ADDRESSING_REVIEW });
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'pending');
    const pending = await readyOf(f.h, HEAD_1);
    assert.match(pending?.description ?? '', /still addressing Devin Review findings/);
    assert.doesNotMatch((await nextAction(f)).text, /merge/i);

    // The session stays finished; only the review comment changes to asking for a person.
    f.h.tracker.addReview(f.pr.number, { reviewer: BOT, state: 'commented', body: DONE_REVIEW });
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success');
    const status = await readyOf(f.h, HEAD_1);
    assert.equal(status?.state, 'success');
    assert.match(status?.description ?? '', /Devin is done working on this pull request/);

    const next = await nextAction(f);
    assert.match(next.text, /Review and merge the pull request/);
    assert.equal(next.gate, 'merge');
    assert.equal(next.waitingOn, 'person');
  });

  it('puts a new head from Devin back to pending, and turns it success once the commit ages and Devin is done', async (t) => {
    const f = await readyFix(t);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success', 4);
    assert.equal((await readyOf(f.h, HEAD_1))?.state, 'success');

    // Devin resumes work and pushes a new commit to the same pull request.
    f.h.working(f.sessionId);
    f.h.tracker.pushHead(f.pr.number, HEAD_2);
    f.h.offline.pullRequestHeads.set(f.pr.url, HEAD_2);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_2 && record.workflow?.ready?.headSha === HEAD_2);
    const moved = await readyOf(f.h, HEAD_2);
    assert.equal(moved?.state, 'pending');
    assert.equal((await readyOf(f.h, HEAD_1))?.state, 'success', 'the previous head keeps the status it was published');
    assert.doesNotMatch((await nextAction(f)).text, /merge/i);

    // Once Devin ends, its review completes and the commit is no longer fresh, the new head turns green.
    f.h.ends(f.sessionId);
    f.h.advance(95 * 1000);
    await reviewed(f, HEAD_2);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_2 && record.stage === 'ready-to-merge' && record.workflow?.ready?.state === 'success');
    assert.equal((await readyOf(f.h, HEAD_2))?.state, 'success');
    assert.match((await nextAction(f)).text, /Review and merge the pull request/);
  });

  for (const merge of ['rule', 'auto'] as const) {
    it(`MERGE=${merge} waits while the status is pending and merges once it is success`, async (t) => {
      const f = await readyFix(t, { MERGE: merge });
      greenCi(f.h, HEAD_1);
      if (merge === 'rule') await reviewed(f);

      f.h.working(f.sessionId);
      const waited = await until(f.h, f.key, (record) => mergeEvaluations(record).length > 0);
      const evaluation = mergeEvaluations(waited).at(-1);
      assert.equal(evaluation?.outcome, 'wait');
      const check = evaluation?.checks.find((candidate) => candidate.name === 'ready');
      assert.equal(check?.ok, false);
      assert.match(check?.detail ?? '', /Devin is still working on the pull request/);
      assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).state, 'open', 'nothing merges while Devin is still working');

      f.h.ends(f.sessionId);
      const merged = await until(f.h, f.key, (record) => record.stage === 'merged');
      assert.equal(merged.decisions.at(-1)?.actor, `policy:merge-${merge}`);
      assert.equal(mergeEvaluations(merged).at(-1)?.checks.find((candidate) => candidate.name === 'ready')?.ok, true);
    });
  }

  it('stays pending with the reason when the session cannot be read, and never turns green', async (t) => {
    const f = await readyFix(t);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success', 4);

    f.h.offline.failNext({ method: 'GET', path: `/sessions/${f.sessionId}`, status: 500 });
    await f.h.cycle();
    const status = await readyOf(f.h, HEAD_1);
    assert.equal(status?.state, 'pending');
    assert.match(status?.description ?? '', /the Devin session could not be read/);

    // A restarted service still keeps it pending while the read fails, and still does not ask for the merge.
    await f.h.restart();
    f.h.offline.failNext({ method: 'GET', path: `/sessions/${f.sessionId}`, status: 500 });
    await f.h.cycle();
    const afterRestart = await readyOf(f.h, HEAD_1);
    assert.equal(afterRestart?.state, 'pending');
    assert.match(afterRestart?.description ?? '', /the Devin session could not be read/);
    assert.doesNotMatch((await nextAction(f)).text, /merge/i);
  });

  it('stays pending with the reason when the review comment cannot be read', async (t) => {
    const f = await readyFix(t);
    await until(f.h, f.key, (record) => record.workflow?.ready?.state === 'success', 4);

    f.h.tracker.failNext('listReviews', 'server-error');
    await f.h.cycle();
    const status = await readyOf(f.h, HEAD_1);
    assert.equal(status?.state, 'pending');
    assert.match(status?.description ?? '', /review comment could not be read/);
  });
});
