import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { attention, presentBug } from '../src/model/presentation.ts';
import { consumesCapacity } from '../src/orchestrator/orchestrator.ts';
import { facts } from './helpers/model.ts';
import { Harness, report } from './helpers/orchestrator.ts';

let harness: Harness;

async function setup(t: TestContext, options: Parameters<typeof Harness.create>[0] = {}): Promise<Harness> {
  harness = await Harness.create(options);
  t.after(() => report(t, harness));
  return harness;
}

afterEach(async () => {
  await harness?.close();
});

/** Devin stops and waits in chat without recording a structured question. */
function waitsSilently(h: Harness, id: string): void {
  h.offline.updateSession(id, { status: 'running', status_detail: 'waiting_for_user' });
}

describe('orchestrator: a session waiting without a structured question', () => {
  it('during investigation: records one question with the session link, frees capacity and resumes on a person reply', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '1' } });
    const a = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    const b = h.tracker.seedIssue({ title: 'B', labels: ['needs-triage'] });
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.equal(h.record(b.key).stage, 'queued');
    const id = h.sessionId(a.key);
    const url = h.record(a.key).session?.url ?? '';
    assert.ok(url !== '');

    waitsSilently(h, id);
    await h.cycle();
    const record = h.record(a.key);
    assert.equal(record.questions.length, 1, 'one question recorded for the stop');
    assert.ok(record.questions[0]?.summary.includes(url), 'the recorded question links the session');
    assert.deepEqual(await h.tracker.listComments(a.number), [], 'the service posts no comment');
    assert.equal(h.messages(id).length, 1, 'the session is told to ask on the issue');
    assert.match(h.messages(id)[0] ?? '', /bug-smasher:session-waiting:/);
    assert.match(h.messages(id)[0] ?? '', /on the issue/);
    assert.equal(record.stage, 'needs-input');
    assert.ok(!consumesCapacity(record));
    const note = attention(presentBug(record, facts(['needs-triage']), h.settings.labels));
    assert.equal(note.waitingOn, 'person');
    assert.equal(note.gate, 'reply');

    await h.cycle(3);
    assert.equal(h.record(a.key).questions.length, 1, 'later cycles record nothing more for the same stop');
    assert.equal(h.messages(id).length, 1, 'one nudge per stop');
    assert.deepEqual(await h.tracker.listComments(a.number), []);
    assert.equal(h.record(b.key).stage, 'triaging', 'the freed slot lets new work start');

    h.tracker.externalComment(a.number, 'ci-helper[bot]', 'Automated: build passed');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 1, 'a bot comment does not resume the session');
    assert.equal(h.record(a.key).stage, 'needs-input');

    h.completesTriage(h.sessionId(b.key));
    await h.cycle(2);
    h.tracker.externalComment(a.number, 'reporter', 'Use Firefox 128');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 2);
    assert.match(h.messages(id).at(-1) ?? '', /Use Firefox 128/);
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.ok(consumesCapacity(h.record(a.key)));

    await h.cycle(2);
    assert.equal(h.record(a.key).questions.length, 1, 'a stale waiting status after the reply is not a new stop');

    h.working(id);
    await h.cycle();
    waitsSilently(h, id);
    await h.cycle(3);
    assert.equal(h.record(a.key).questions.length, 2, 'a new stop records its own question');
    assert.equal(h.messages(id).length, 3, 'a new stop gets its own nudge');
  });

  it('during repair: records one question, frees capacity and resumes on a person reply', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '1' } });
    const a = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    const b = h.tracker.seedIssue({ title: 'B', labels: ['bug-smasher'] });
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'fixing');
    const id = h.sessionId(a.key);
    const url = h.record(a.key).session?.url ?? '';

    waitsSilently(h, id);
    await h.cycle();
    const record = h.record(a.key);
    const question = record.workflow?.workQuestion;
    assert.ok(question, 'one question recorded for the stop');
    assert.ok(question.summary.includes(url), 'the recorded question links the session');
    assert.deepEqual(await h.tracker.listComments(a.number), [], 'the service posts no comment');
    assert.equal(h.messages(id).length, 1, 'the session is told to ask on the issue');
    assert.match(h.messages(id)[0] ?? '', /bug-smasher:session-waiting:/);
    assert.equal(record.stage, 'fixing');
    assert.ok(!consumesCapacity(record));
    const note = attention(presentBug(record, facts(['bug-smasher']), h.settings.labels));
    assert.equal(note.waitingOn, 'person');
    assert.equal(note.gate, 'reply');

    await h.cycle(3);
    assert.equal(h.record(a.key).workflow?.workQuestion?.id, question.id, 'later cycles keep the same question');
    assert.equal(h.record(b.key).stage, 'fixing', 'the freed slot lets new work start');

    h.tracker.externalComment(a.number, 'ci-helper[bot]', 'Automated: build passed');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 1, 'a bot comment does not resume the session');

    h.ends(h.sessionId(b.key));
    await h.cycle(2);
    h.tracker.externalComment(a.number, 'maintainer', 'Keep the old API');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 2);
    assert.equal(h.record(a.key).stage, 'fixing');
    assert.ok(consumesCapacity(h.record(a.key)));
    await h.cycle(2);
    assert.deepEqual((await h.tracker.listComments(a.number)).filter((c) => c.fromService), [], 'the service posts no comment');
  });

  it('returns to work without a reply when the waiting session is resumed in Devin', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '2' } });
    const a = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    const b = h.tracker.seedIssue({ title: 'B', labels: ['bug-smasher'] });
    await h.cycle(2);
    const idA = h.sessionId(a.key);
    const idB = h.sessionId(b.key);
    for (const id of [idA, idB]) h.offline.updateSession(id, { status: 'running', status_detail: 'waiting_for_approval' });
    await h.cycle();
    assert.equal(h.record(a.key).stage, 'needs-input');
    assert.ok(!consumesCapacity(h.record(b.key)));

    h.working(idA);
    h.working(idB);
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.ok(consumesCapacity(h.record(a.key)));
    assert.equal(h.record(b.key).stage, 'fixing');
    assert.ok(consumesCapacity(h.record(b.key)));
    assert.equal(h.messages(idA).length + h.messages(idB).length, 2, 'one nudge each; resumed without a reply');

    h.completesTriage(idA);
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'triaged');
    assert.equal(h.record(a.key).questions.length, 1, 'the wait question stays recorded');
    assert.deepEqual(await h.tracker.listComments(a.number), []);
  });

  it('counts a wait that starts in the same second the stage was entered', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const entered = Date.parse(h.record(issue.key).stageHistory.at(-1)?.at ?? '');
    waitsSilently(h, id);
    h.session(id).updated_at = Math.floor(entered / 1000);
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'needs-input');
    assert.equal(h.record(issue.key).questions.length, 1);
  });

  it('keeps the structured-question behaviour when a question is recorded', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.asks(id, 'Which browser?');
    await h.cycle(3);
    assert.deepEqual(h.record(issue.key).questions.map((q) => q.summary), ['Which browser?']);
    assert.deepEqual(await h.tracker.listComments(issue.number), [], 'the question reaches people through Devin, not a service comment');
  });
});
