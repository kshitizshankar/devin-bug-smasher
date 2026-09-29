import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import type { BugRecord, DiffFinding, ReproductionOutcome } from '../src/model/types.ts';
import {
  VERIFICATION_STATUS_CONTEXT,
  type Reproducer,
  type ReproductionRequest,
  type ReproductionResult,
  type VerificationOutcome,
  type VerificationRequest,
  type Verifier,
} from '../src/orchestrator/contracts.ts';
import type { Env } from '../src/config/settings.ts';
import type { TrackerComment, TrackerPullRequest } from '../src/tracker/types.ts';
import { Harness, report } from './helpers/orchestrator.ts';

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);
const HEAD_3 = '3'.repeat(40);
const BOT = 'devin-ai-integration[bot]';
const DELETION_ONLY: DiffFinding = { check: 'deletion-only', file: 'src/legend.ts', detail: 'the change outside tests only deletes lines' };

/** Passes pre-merge verification (optionally with flags) and returns scripted post-merge results. */
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

async function setup(t: TestContext, env: Env = {}, maxReviewRepairs?: number): Promise<{ h: Harness; world: World }> {
  const world = new World();
  const h = await Harness.create({ env, verifier: world, reproducer: world, ...(maxReviewRepairs === undefined ? {} : { maxReviewRepairs }) });
  harness = h;
  t.after(() => report(t, h));
  return { h, world };
}

function serviceComments(comments: TrackerComment[], prefix: string): TrackerComment[] {
  return comments.filter((comment) => comment.fromService && (comment.serviceKey ?? '').startsWith(prefix));
}

async function comments(h: Harness, issueNumber: number, prefix: string): Promise<TrackerComment[]> {
  return serviceComments(await h.tracker.listComments(issueNumber), prefix);
}

async function until(h: Harness, key: string, done: (record: BugRecord) => boolean, cycles = 12): Promise<BugRecord> {
  for (let index = 0; index < cycles; index += 1) {
    if (done(h.record(key))) return h.record(key);
    await h.cycle();
  }
  assert.fail(`condition not reached; stage ${h.record(key).stage}`);
}

function reviewPosts(h: Harness): number {
  return h.offline.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/pr-reviews')).length;
}

function completeReview(h: Harness, pr: TrackerPullRequest, head: string): void {
  const review = h.offline.reviews.get(pr.url);
  assert.equal(review?.commit_sha, head);
  h.offline.reviews.set(pr.url, { ...review, status: 'completed' });
}

function lines(additions: number, deletions = 0) {
  return [{ filename: 'src/legend.ts', previousFilename: null, status: 'modified', additions, deletions, changes: additions + deletions, patch: null }];
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
async function readyFix(t: TestContext, env: Env = {}, options: { changed?: number; review?: boolean; maxReviewRepairs?: number } = {}): Promise<Fix> {
  const { h, world } = await setup(t, env, options.maxReviewRepairs);
  const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels: ['bug-smasher'], author: 'reporter' });
  await h.cycle(2);
  const sessionId = h.sessionId(issue.key);
  const pr = h.tracker.seedPullRequest({
    title: 'Fix legend',
    body: `Fixes #${issue.number}`,
    headSha: HEAD_1,
    references: [issue.number],
    files: lines(options.changed ?? 20),
  });
  if (options.review !== false) h.offline.pullRequestHeads.set(pr.url, HEAD_1);
  h.opensPr(sessionId, pr.url);
  await until(h, issue.key, (record) => record.stage === 'ready-to-merge');
  return { h, world, key: issue.key, issueNumber: issue.number, sessionId, pr };
}

function greenCi(h: Harness, sha: string): void {
  h.tracker.addCheckRun(sha, { name: 'test', status: 'completed', conclusion: 'success' });
}

/** Completes the Review of the current head with no findings. */
async function reviewed(f: Fix, head = HEAD_1): Promise<void> {
  await until(f.h, f.key, (record) => (record.review?.rounds.some((round) => round.headSha === head) ?? false));
  completeReview(f.h, f.pr, head);
  await until(f.h, f.key, (record) => record.review?.rounds.find((round) => round.headSha === head)?.status === 'completed');
}

function mergeEvaluations(record: BugRecord) {
  return (record.evaluations ?? []).filter((evaluation) => evaluation.kind === 'merge');
}

async function triagedIssue(h: Harness, labels: string[], overrides: Record<string, unknown> = {}) {
  const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels, author: 'reporter' });
  await h.cycle(2);
  h.completesTriage(h.sessionId(issue.key), overrides);
  await h.cycle();
  return issue;
}

describe('decision policies in the orchestrator', () => {
  it('Person (the default) never acts on a recommendation', async (t) => {
    const { h, world } = await setup(t);
    const issue = await triagedIssue(h, ['needs-triage', 'crash']);
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'triaged');
    assert.deepEqual(record.decisions, []);
    assert.equal(record.evaluations, undefined);
    assert.equal(world.reproductions.length, 0);
    assert.deepEqual((await h.tracker.getIssue(issue.number)).labels.sort(), ['crash', 'needs-triage']);
  });

  it('Rule fixes a reproduced bug whose class labels are all allowed, persisting its evidence and one comment', async (t) => {
    const { h, world } = await setup(t, { DECISION: 'rule', DECISION_RULE_CLASSES: 'crash,ui' });
    const issue = await triagedIssue(h, ['needs-triage', 'crash']);
    const record = await until(h, issue.key, (r) => r.stage === 'fixing', 3);
    const decision = record.decisions.find((d) => d.action === 'fix');
    assert.equal(decision?.actor, 'policy:decision-rule');
    const [evaluation] = record.evaluations ?? [];
    assert.equal(evaluation?.policy, 'rule');
    assert.equal(evaluation?.outcome, 'fix');
    assert.equal(evaluation?.reproduction?.outcome, 'reproduced');
    assert.deepEqual(evaluation?.checks.map((check) => check.ok), [true, true, true]);
    assert.equal(world.reproductions.length, 1);
    await h.restart();
    await h.cycle(3);
    assert.equal((await comments(h, issue.number, 'decision:')).length, 1);
    assert.equal(world.reproductions.length, 1);
  });

  it('Rule waits for a person when the bug is not reproduced, with one durable wait comment across restarts', async (t) => {
    const { h, world } = await setup(t, { DECISION: 'rule', DECISION_RULE_CLASSES: 'crash' });
    world.reproduction = 'not-reproduced';
    const issue = await triagedIssue(h, ['needs-triage', 'crash']);
    await h.cycle();
    await h.restart();
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'triaged');
    assert.deepEqual(record.decisions, []);
    assert.equal(record.evaluations?.length, 1);
    assert.equal(record.evaluations?.[0]?.outcome, 'wait');
    const waits = await comments(h, issue.number, 'decision-wait:');
    assert.equal(waits.length, 1);
    assert.match(waits[0]?.body ?? '', /Not reproduced/);
    assert.equal(world.reproductions.length, 1, 'the same default-branch commit is not reproduced again');
  });

  it('Rule waits for a person when DECISION_RULE_CLASSES is empty', async (t) => {
    const { h, world } = await setup(t, { DECISION: 'rule' });
    const issue = await triagedIssue(h, ['needs-triage', 'crash']);
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'triaged');
    assert.match((await comments(h, issue.number, 'decision-wait:'))[0]?.body ?? '', /DECISION_RULE_CLASSES is empty/);
    assert.equal(world.reproductions.length, 0);
  });

  it('Automatic applies fix and engineer recommendations, and waits for a person on close', async (t) => {
    const { h } = await setup(t, { DECISION: 'auto' });
    const engineer = await triagedIssue(h, ['needs-triage'], { bucket: 'needs_engineer' });
    const close = await triagedIssue(h, ['needs-triage'], { bucket: 'close' });
    const fix = await triagedIssue(h, ['needs-triage']);
    await h.cycle(2);
    assert.equal(h.record(engineer.key).stage, 'with-engineer');
    assert.equal(h.record(engineer.key).decisions.at(-1)?.actor, 'policy:decision-auto');
    assert.ok((await h.tracker.getIssue(engineer.number)).labels.includes('needs-engineer'));
    assert.equal(h.record(fix.key).stage, 'fixing');
    const closing = h.record(close.key);
    assert.equal(closing.stage, 'triaged');
    assert.equal((await h.tracker.getIssue(close.number)).state, 'open', 'the service never closes an issue');
    assert.equal(closing.evaluations?.at(-1)?.outcome, 'wait');
    assert.equal((await comments(h, close.number, 'decision-wait:')).length, 1);
  });
});

describe('session-start comment', () => {
  it('posts one reporter-addressed link per session, and another only for a new session', async (t) => {
    const { h } = await setup(t);
    const issue = await triagedIssue(h, ['needs-triage']);
    const first = h.sessionId(issue.key);
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'add', 'maintainer');
    await h.cycle();
    assert.equal(h.record(issue.key).session?.id, first, 'repair continues in the same session');
    await h.restart();
    await h.cycle(2);
    let greetings = await comments(h, issue.number, 'session-started:');
    assert.equal(greetings.length, 1);
    assert.match(greetings[0]?.body ?? '', /@reporter/);
    assert.ok(greetings[0]?.body.includes(h.record(issue.key).session?.url ?? '-'));

    h.ends(first);
    await h.cycle();
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'remove', 'maintainer');
    h.tracker.externalLabel(issue.number, 'needs-triage', 'add', 'maintainer');
    await h.cycle(3);
    const second = h.record(issue.key).session?.id;
    assert.notEqual(second, first);
    greetings = await comments(h, issue.number, 'session-started:');
    assert.equal(greetings.length, 2);
    assert.ok(greetings[1]?.body.includes(h.record(issue.key).session?.url ?? '-'));
  });
});

describe('Devin Review', () => {
  it('requests one Review per verified head, records completion and sends findings to the same session', async (t) => {
    const f = await readyFix(t);
    await f.h.cycle(3);
    assert.equal(reviewPosts(f.h), 1, 'requested exactly once');
    assert.equal(f.h.record(f.key).review?.rounds[0]?.status, 'pending');

    const thread = f.h.tracker.addReviewThread(f.pr.number, { author: BOT, body: 'The legend offset ignores padding', path: 'src/legend.ts', line: 4 });
    f.h.tracker.addReviewThread(f.pr.number, { author: 'maintainer', body: 'Not a Devin finding' });
    completeReview(f.h, f.pr, HEAD_1);
    await f.h.cycle(3);
    const [round] = f.h.record(f.key).review?.rounds ?? [];
    assert.equal(round?.status, 'completed');
    assert.deepEqual(round?.findings.map((finding) => finding.threadId), [thread.id]);
    assert.notEqual(round?.correctionSentAt, null);
    const corrections = f.h.messages(f.sessionId).filter((message) => message.includes(`bug-smasher:review:${HEAD_1}`));
    assert.equal(corrections.length, 1);
    assert.match(corrections[0] ?? '', /legend offset ignores padding/);
    assert.equal(f.h.createRequests().length, 1, 'no new session');

    f.h.tracker.pushHead(f.pr.number, HEAD_2);
    f.h.offline.pullRequestHeads.set(f.pr.url, HEAD_2);
    f.h.tracker.resolveReviewThread(f.pr.number, thread.id);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_2 && record.stage === 'ready-to-merge');
    assert.deepEqual(f.world.calls.map((call) => call.headSha), [HEAD_1, HEAD_2], 'every new head is verified afresh');
    await reviewed(f, HEAD_2);
    const review = f.h.record(f.key).review;
    assert.equal(reviewPosts(f.h), 2);
    assert.deepEqual(review?.rounds.map((r) => [r.headSha, r.status]), [[HEAD_1, 'completed'], [HEAD_2, 'completed']]);
    assert.deepEqual(review?.resolutions.map((r) => [r.threadId, r.foundOnHead, r.resolvedOnHead, r.via]), [[thread.id, HEAD_1, HEAD_2, 'same-session']]);
    await f.h.restart();
    await f.h.cycle(3);
    assert.equal(reviewPosts(f.h), 2, 'restarts request nothing again');
  });

  it('records an unavailable Review, never treats it as passed, and Rule merge waits', async (t) => {
    const f = await readyFix(t, { MERGE: 'rule' }, { review: false });
    greenCi(f.h, HEAD_1);
    await f.h.cycle(3);
    const record = f.h.record(f.key);
    assert.equal(record.review?.rounds[0]?.status, 'unavailable');
    assert.match(record.review?.rounds[0]?.detail ?? '', /not-requested/);
    assert.equal(record.stage, 'ready-to-merge');
    const [evaluation] = mergeEvaluations(record);
    assert.equal(evaluation?.outcome, 'wait');
    assert.equal(evaluation?.checks.find((check) => check.name === 'review')?.ok, false);
    assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).state, 'open');
  });

  it('stops after the repair cap with a durable blocker and one comment', async (t) => {
    const f = await readyFix(t, {}, { maxReviewRepairs: 1 });
    await f.h.cycle();
    f.h.tracker.addReviewThread(f.pr.number, { author: BOT, body: 'First finding' });
    completeReview(f.h, f.pr, HEAD_1);
    await f.h.cycle(2);
    f.h.tracker.pushHead(f.pr.number, HEAD_2);
    f.h.offline.pullRequestHeads.set(f.pr.url, HEAD_2);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_2 && record.stage === 'ready-to-merge');
    await f.h.cycle();
    f.h.tracker.addReviewThread(f.pr.number, { author: BOT, body: 'Second finding', commitSha: HEAD_2 });
    completeReview(f.h, f.pr, HEAD_2);
    await f.h.cycle(3);
    await f.h.restart();
    await f.h.cycle(2);
    const round = f.h.record(f.key).review?.rounds.at(-1);
    assert.equal(round?.headSha, HEAD_2);
    assert.equal(round?.correctionSentAt, null);
    assert.match(round?.blocker ?? '', /limit of 1 Devin Review repair round/);
    assert.equal(f.h.messages(f.sessionId).filter((message) => message.includes('bug-smasher:review:')).length, 1);
    assert.equal((await comments(f.h, f.issueNumber, 'review-blocker:')).length, 1);
  });
});

describe('merge policies in the orchestrator', () => {
  it('Person never merges', async (t) => {
    const f = await readyFix(t);
    greenCi(f.h, HEAD_1);
    await reviewed(f);
    await f.h.cycle(3);
    assert.equal(f.h.record(f.key).stage, 'ready-to-merge');
    assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).state, 'open');
    assert.deepEqual(mergeEvaluations(f.h.record(f.key)), []);
  });

  it('Rule merges the exact verified head at MERGE_MAX_LINES, records the evidence, verifies after merge and thanks the reporter once', async (t) => {
    const f = await readyFix(t, { MERGE: 'rule', MERGE_MAX_LINES: '20' }, { changed: 20 });
    f.h.tracker.setBranch('main', { sha: HEAD_3, requiredChecks: [VERIFICATION_STATUS_CONTEXT] });
    greenCi(f.h, HEAD_1);
    await reviewed(f);
    const merged = await until(f.h, f.key, (record) => record.stage === 'merged');
    const pr = await f.h.tracker.getPullRequest(f.pr.number);
    assert.equal(pr.state, 'merged');
    assert.equal(merged.fix?.mergeCommitSha, pr.mergeCommitSha);
    assert.equal(merged.decisions.at(-1)?.actor, 'policy:merge-rule');
    const [evaluation] = mergeEvaluations(merged);
    assert.equal(evaluation?.outcome, 'merge');
    assert.equal(evaluation?.subject, HEAD_1);
    assert.equal(evaluation?.checks.find((check) => check.name === 'branch-protection')?.ok, true);
    await until(f.h, f.key, (record) => record.verifications.some((v) => v.phase === 'post-merge'));
    assert.equal(f.h.record(f.key).verifications.at(-1)?.result, 'pass');
    await f.h.restart();
    await f.h.cycle(3);
    assert.equal((await comments(f.h, f.issueNumber, 'thanks:')).length, 1);
    assert.match((await comments(f.h, f.issueNumber, 'thanks:'))[0]?.body ?? '', /@reporter/);
    assert.equal((await comments(f.h, f.issueNumber, 'merge-decision:')).length, 1);
    assert.equal((await f.h.tracker.getIssue(f.issueNumber)).state, 'closed', 'GitHub closed it through the closing keyword, not the service');
  });

  it('Rule refuses one line above MERGE_MAX_LINES and reports missing branch protection', async (t) => {
    const f = await readyFix(t, { MERGE: 'rule', MERGE_MAX_LINES: '20' }, { changed: 21 });
    greenCi(f.h, HEAD_1);
    await reviewed(f);
    await f.h.cycle(2);
    const record = f.h.record(f.key);
    assert.equal(record.stage, 'ready-to-merge');
    const evaluation = mergeEvaluations(record).at(-1);
    assert.equal(evaluation?.outcome, 'wait');
    assert.equal(evaluation?.checks.find((check) => check.name === 'size')?.ok, false);
    assert.match(evaluation?.checks.find((check) => check.name === 'branch-protection')?.detail ?? '', /does not require bug-smasher\/verification/);
    assert.equal(mergeEvaluations(record).length, 1, 'an unchanged evaluation is not recorded again');
  });

  it('Rule waits on missing, pending and failing CI and on an unresolved Review comment, then merges once they clear', async (t) => {
    const f = await readyFix(t, { MERGE: 'rule' });
    const thread = f.h.tracker.addReviewThread(f.pr.number, { author: BOT, body: 'Please add a test' });
    f.h.tracker.resolveReviewThread(f.pr.number, thread.id);
    await reviewed(f);
    await f.h.cycle();
    const ci = () => mergeEvaluations(f.h.record(f.key)).at(-1)?.checks.find((check) => check.name === 'ci')?.detail ?? '';
    assert.match(ci(), /No CI/);
    f.h.tracker.addCheckRun(HEAD_1, { name: 'test', status: 'in_progress', conclusion: null });
    await f.h.cycle();
    assert.match(ci(), /pending/);
    f.h.tracker.addCheckRun(HEAD_1, { name: 'lint', status: 'completed', conclusion: 'failure' });
    await f.h.cycle();
    assert.match(ci(), /failing/i);
    assert.equal(f.h.record(f.key).stage, 'ready-to-merge');
  });

  it('Rule refuses when a Devin Review thread is unresolved on GitHub', async (t) => {
    const f = await readyFix(t, { MERGE: 'rule' }, { maxReviewRepairs: 0 });
    greenCi(f.h, HEAD_1);
    await reviewed(f);
    f.h.tracker.addReviewThread(f.pr.number, { author: BOT, body: 'Late finding' });
    await f.h.cycle(2);
    const evaluation = mergeEvaluations(f.h.record(f.key)).at(-1);
    assert.equal(evaluation?.checks.find((check) => check.name === 'review')?.ok, false);
    assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).state, 'open');
  });

  it('Rule refuses a deletion-only flag; Automatic merges it but refuses pending or failing CI', async (t) => {
    const f = await readyFix(t, { MERGE: 'auto' }, { review: false });
    f.world.flags = [DELETION_ONLY];
    f.h.tracker.pushHead(f.pr.number, HEAD_2);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_2 && record.stage === 'ready-to-merge');
    f.h.tracker.addCheckRun(HEAD_2, { name: 'test', status: 'queued', conclusion: null });
    await f.h.cycle(2);
    assert.equal(f.h.record(f.key).stage, 'ready-to-merge');
    assert.equal(mergeEvaluations(f.h.record(f.key)).at(-1)?.outcome, 'wait');
    f.h.tracker.addCheckRun(HEAD_2, { name: 'lint', status: 'completed', conclusion: 'failure' });
    await f.h.cycle(2);
    assert.equal(f.h.record(f.key).stage, 'ready-to-merge');
    f.h.tracker.pushHead(f.pr.number, HEAD_3);
    await until(f.h, f.key, (record) => record.fix?.headSha === HEAD_3 && record.stage === 'ready-to-merge');
    greenCi(f.h, HEAD_3);
    const merged = await until(f.h, f.key, (record) => record.stage === 'merged');
    const evaluation = mergeEvaluations(merged).at(-1);
    assert.equal(evaluation?.rule, 'merge-auto');
    assert.equal(evaluation?.subject, HEAD_3);
    assert.ok(evaluation?.checks.some((check) => check.name === 'diff-checks' && !check.blocking));
  });

  it('refuses to merge when the head moves between evaluation and merge, then verifies the new head afresh', async (t) => {
    const f = await readyFix(t, { MERGE: 'auto' }, { review: false });
    greenCi(f.h, HEAD_1);
    const merge = f.h.tracker.mergePullRequest.bind(f.h.tracker);
    let raced = false;
    f.h.tracker.mergePullRequest = async (number, request) => {
      if (!raced) {
        raced = true;
        f.h.tracker.pushHead(number, HEAD_2);
      }
      return merge(number, request);
    };
    await f.h.cycle(3);
    assert.ok(raced);
    assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).state, 'open', 'the expected-head condition refused it');
    const record = await until(f.h, f.key, (r) => r.fix?.headSha === HEAD_2 && r.stage === 'ready-to-merge');
    assert.deepEqual(f.world.calls.filter((call) => call.phase === 'pre-merge').map((call) => call.headSha), [HEAD_1, HEAD_2]);
    greenCi(f.h, HEAD_2);
    const merged = await until(f.h, f.key, (r) => r.stage === 'merged');
    assert.equal((await f.h.tracker.getPullRequest(f.pr.number)).headSha, HEAD_2);
    assert.equal(merged.fix?.headSha, HEAD_2);
    assert.ok(record);
  });

  it('records a direct merge by a person with actor, time and merge commit, and thanks the reporter once', async (t) => {
    const f = await readyFix(t, {}, { review: false });
    const sha = f.h.tracker.externalMerge(f.pr.number, 'maintainer');
    await f.h.cycle(3);
    const record = f.h.record(f.key);
    assert.equal(record.fix?.mergeCommitSha, sha);
    assert.equal(record.fix?.mergedBy, 'github:maintainer');
    assert.equal(record.fix?.mergedAt, (await f.h.tracker.getPullRequest(f.pr.number)).mergedAt);
    assert.equal((await comments(f.h, f.issueNumber, 'thanks:')).length, 1);
    assert.equal((await comments(f.h, f.issueNumber, 'merge-decision:')).length, 0, 'no policy merged it');
  });

  it('hands a merged fix to an engineer when post-merge verification fails', async (t) => {
    const f = await readyFix(t, {}, { review: false });
    f.world.postMerge = 'fail';
    f.h.tracker.externalMerge(f.pr.number, 'maintainer');
    const handed = await until(f.h, f.key, (record) => record.stage === 'with-engineer');
    assert.equal(handed.verifications.at(-1)?.phase, 'post-merge');
    assert.equal(handed.verifications.at(-1)?.result, 'fail');
    assert.equal(handed.handoff?.reason, 'post-merge-verification-failed');
  });
});
