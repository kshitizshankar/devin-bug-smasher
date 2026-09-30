import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import type { BugRecord, DiffFinding } from '../src/model/types.ts';
import type { VerificationOutcome, VerificationRequest, Verifier } from '../src/orchestrator/contracts.ts';
import type { TrackerComment } from '../src/tracker/types.ts';
import { Harness, report } from './helpers/orchestrator.ts';

/** The token is the operator's own: the account it authenticates as is a user, not a bot. */
const OPERATOR = 'operator';
const DEVIN = 'devin-ai-integration[bot]';
const HEAD_1 = '1'.repeat(40);

let harness: Harness;

async function setup(t: TestContext, options: Parameters<typeof Harness.create>[0] = {}): Promise<Harness> {
  harness = await Harness.create({ actor: { login: OPERATOR, type: 'user' }, ...options });
  t.after(() => report(t, harness));
  return harness;
}

afterEach(async () => {
  await harness?.close();
});

async function until(h: Harness, key: string, done: (record: BugRecord) => boolean, cycles = 12): Promise<BugRecord> {
  for (let index = 0; index < cycles; index += 1) {
    if (done(h.record(key))) return h.record(key);
    await h.cycle();
  }
  assert.fail(`condition not reached; stage ${h.record(key).stage}`);
}

function onlyPeople(comments: TrackerComment[], what = 'the service posts no comment'): void {
  assert.ok(comments.every((comment) => !comment.fromService), what);
}

async function triagedBug(h: Harness): Promise<{ key: string; number: number; id: string }> {
  const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels: ['needs-triage'], author: 'reporter' });
  await h.cycle(2);
  const id = h.sessionId(issue.key);
  h.completesTriage(id);
  await h.cycle();
  assert.equal(h.record(issue.key).stage, 'triaged');
  return { key: issue.key, number: issue.number, id };
}

class Passing implements Verifier {
  readonly live = true;
  readonly #flags: DiffFinding[];
  constructor(flags: DiffFinding[] = []) {
    this.#flags = flags;
  }
  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    return {
      status: 'completed',
      attempt: {
        phase: request.phase,
        baseSha: request.baseSha,
        headSha: request.headSha,
        result: 'pass',
        reason: 'The selected tests fail on base and pass on head',
        outputTail: 'pass output',
        at: '2026-01-01T00:00:00Z',
        evidence: { runs: [], violations: [], flags: request.phase === 'pre-merge' ? [...this.#flags] : [] },
      },
    };
  }
}

describe('orchestrator: Devin speaks for the work', () => {
  it('posts no comment from the service account on a full triage-then-fix run', async (t) => {
    const h = await setup(t);
    const bug = await triagedBug(h);
    // Devin comments on the issue itself, from its own GitHub account.
    h.tracker.externalComment(bug.number, DEVIN, "Hey @reporter - I'm picking this up. You can follow along in the session.");
    h.tracker.externalComment(bug.number, DEVIN, '**Investigation: Legend overlaps axis**\n\n**Recommendation:** Devin can fix this (high confidence).');

    h.tracker.externalLabel(bug.number, 'bug-smasher', 'add', OPERATOR);
    await h.cycle();
    assert.equal(h.record(bug.key).stage, 'fixing');
    assert.ok(h.messages(bug.id).some((message) => /approved for repair/.test(message)));

    const pr = h.tracker.seedPullRequest({ title: 'Fix legend', body: `Fixes #${bug.number}`, headSha: HEAD_1, references: [bug.number] });
    h.opensPr(bug.id, pr.url);
    await h.cycle(3);

    const comments = await h.tracker.listComments(bug.number);
    assert.equal(comments.length, 2, 'the thread holds only what Devin itself posted');
    assert.ok(comments.every((comment) => comment.author?.login === DEVIN));
    onlyPeople(comments);
  });

  it("starts the fix on the operator's own fix label, and hands off on the engineer label", async (t) => {
    const h = await setup(t);
    const bug = await triagedBug(h);
    h.tracker.externalLabel(bug.number, 'bug-smasher', 'add', OPERATOR);
    await h.cycle();
    assert.equal(h.record(bug.key).stage, 'fixing', 'a label added by the token account counts as a person decision');
    assert.equal(h.record(bug.key).decisions.at(-1)?.actor, `github:${OPERATOR}`);

    const other = await triagedBug(h);
    h.tracker.externalLabel(other.number, 'needs-engineer', 'add', OPERATOR);
    await h.cycle();
    assert.equal(h.record(other.key).stage, 'with-engineer');
    assert.equal(h.record(other.key).handoff?.reason, 'person');
    assert.equal(h.record(other.key).decisions.at(-1)?.actor, `github:${OPERATOR}`);
  });

  it("relays the operator's reply to a question to the session once", async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.asks(id, 'Which browser?');
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'needs-input');

    h.tracker.externalComment(issue.number, OPERATOR, 'Firefox 128');
    await h.cycle(2);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'triaging');
    assert.equal(record.questions[0]?.answeredAt !== null, true);
    assert.equal(h.messages(id).length, 1, 'the reply is relayed exactly once');
    assert.match(h.messages(id)[0] ?? '', /Firefox 128/);

    await h.restart();
    await h.cycle(3);
    assert.equal(h.messages(id).length, 1, 'a restart relays nothing again');
  });

  it('never reads a label the service itself added or removed as a person decision', async (t) => {
    const h = await setup(t);
    const bug = await triagedBug(h);
    // The person's action runs through the service interface: the service adds the label itself.
    const outcome = await h.orchestrator.performAction(bug.key, { name: 'fix', context: 'Approve the fix' });
    assert.equal(outcome.status, 'applied');
    await h.cycle(3);
    const record = h.record(bug.key);
    assert.equal(record.stage, 'fixing');
    const fixes = record.decisions.filter((decision) => decision.action === 'fix');
    assert.equal(fixes.length, 1, 'the labeled event the service wrote is not a second decision');
    assert.equal(fixes[0]?.actor, 'interface:bug-smasher');
    assert.deepEqual(
      (record.workflow?.ownLabelChanges ?? []).map((change) => [change.type, change.label]),
      [['unlabeled', 'needs-triage']],
      'the service remembers its own removals too; only adds can ever be a decision',
    );

    const handoff = await h.orchestrator.performAction(bug.key, { name: 'engineer', context: 'Needs a person' });
    assert.equal(handoff.status, 'applied');
    await h.cycle(3);
    const handed = h.record(bug.key);
    assert.equal(handed.stage, 'with-engineer');
    assert.deepEqual(
      handed.decisions.filter((decision) => decision.action === 'engineer').map((decision) => decision.actor),
      ['interface:bug-smasher'],
      'the service labels added and removed by the handoff are not a person decision',
    );
  });

  it("never relays a comment by Devin's account back to Devin", async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.asks(id, 'Which browser?');
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'needs-input');

    h.tracker.externalComment(issue.number, DEVIN, "I'm picking this up. You can follow along in the session.");
    await h.cycle(3);
    assert.equal(h.messages(id).length, 0, 'bot comments are never relayed');
    assert.equal(h.record(issue.key).stage, 'needs-input', 'a Devin comment does not answer the question');
  });

  it('sends verification flags and a review blocker to the session as messages, posting no comment', async (t) => {
    const verifier = new Passing([{ check: 'deletion-only', file: 'src/legend.ts', detail: 'the change outside tests only deletes lines' }]);
    const h = await setup(t, { verifier, maxReviewRepairs: 0 });
    const issue = h.tracker.seedIssue({ title: 'Legend', labels: ['bug-smasher'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const pr = h.tracker.seedPullRequest({ title: 'Fix legend', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.offline.pullRequestHeads.set(pr.url, HEAD_1);
    h.opensPr(id, pr.url);
    await until(h, issue.key, (record) => record.stage === 'ready-to-merge');
    const flags = h.messages(id).filter((message) => message.includes('bug-smasher:verification-flags:'));
    assert.equal(flags.length, 1);
    assert.match(flags[0] ?? '', /deletion-only/);
    assert.match(flags[0] ?? '', new RegExp(pr.url));

    await until(h, issue.key, (record) => (record.review?.rounds.length ?? 0) === 1);
    const review = h.offline.reviews.get(pr.url);
    h.tracker.addReviewThread(pr.number, { author: DEVIN, body: 'Finding one', path: 'src/legend.ts', line: 4 });
    h.offline.reviews.set(pr.url, { ...review!, status: 'completed' });
    await h.cycle(3);
    const round = h.record(issue.key).review?.rounds[0];
    assert.match(round?.blocker ?? '', /limit of 0 Devin Review repair round/);
    const blockers = h.messages(id).filter((message) => message.includes('bug-smasher:review-blocker:'));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0] ?? '', new RegExp(pr.url));

    onlyPeople(await h.tracker.listComments(issue.number));
    assert.equal(h.record(issue.key).stage, 'ready-to-merge');
  });
});
