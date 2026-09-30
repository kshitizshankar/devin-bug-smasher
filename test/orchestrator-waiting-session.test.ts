import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { attention, presentBug } from '../src/model/presentation.ts';
import { consumesCapacity } from '../src/orchestrator/orchestrator.ts';
import type { TrackerComment } from '../src/tracker/types.ts';
import { facts } from './helpers/model.ts';
import { Harness, report } from './helpers/orchestrator.ts';

/** Service comments other than the one-per-session greeting. */
function workflowComment(comment: TrackerComment): boolean {
  return comment.fromService && !(comment.serviceKey ?? '').startsWith('session-started:');
}

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

async function notices(h: Harness, issueNumber: number): Promise<TrackerComment[]> {
  return (await h.tracker.listComments(issueNumber)).filter(workflowComment);
}

describe('orchestrator: a session waiting without a structured question', () => {
  it('during investigation: posts one notice with the session link, frees capacity and resumes on a person reply', async (t) => {
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
    const posted = await notices(h, a.number);
    assert.equal(posted.length, 1, 'one notice for the stop');
    assert.ok(posted[0]?.body.includes(url), 'the notice links the session');
    const record = h.record(a.key);
    assert.equal(record.stage, 'needs-input');
    assert.ok(!consumesCapacity(record));
    const note = attention(presentBug(record, facts(['needs-triage']), h.settings.labels));
    assert.equal(note.waitingOn, 'person');
    assert.equal(note.gate, 'reply');

    await h.cycle(3);
    assert.equal((await notices(h, a.number)).length, 1, 'later cycles post nothing more for the same stop');
    assert.equal(h.record(b.key).stage, 'triaging', 'the freed slot lets new work start');

    h.tracker.externalComment(a.number, 'ci-helper[bot]', 'Automated: build passed');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 0, 'a bot comment does not resume the session');
    assert.equal(h.record(a.key).stage, 'needs-input');

    h.completesTriage(h.sessionId(b.key));
    await h.cycle(2);
    h.tracker.externalComment(a.number, 'reporter', 'Use Firefox 128');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 1);
    assert.match(h.messages(id)[0] ?? '', /Use Firefox 128/);
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.ok(consumesCapacity(h.record(a.key)));

    await h.cycle(2);
    assert.equal((await notices(h, a.number)).length, 1, 'a stale waiting status after the reply is not a new stop');

    h.working(id);
    await h.cycle();
    waitsSilently(h, id);
    await h.cycle(3);
    assert.equal((await notices(h, a.number)).length, 2, 'a new stop gets its own notice');
  });

  it('during repair: posts one notice, frees capacity and resumes on a person reply', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '1' } });
    const a = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    const b = h.tracker.seedIssue({ title: 'B', labels: ['bug-smasher'] });
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'fixing');
    const id = h.sessionId(a.key);
    const url = h.record(a.key).session?.url ?? '';

    waitsSilently(h, id);
    await h.cycle();
    const posted = await notices(h, a.number);
    assert.equal(posted.length, 1);
    assert.ok(posted[0]?.body.includes(url));
    const record = h.record(a.key);
    assert.equal(record.stage, 'fixing');
    assert.ok(!consumesCapacity(record));
    const note = attention(presentBug(record, facts(['bug-smasher']), h.settings.labels));
    assert.equal(note.waitingOn, 'person');
    assert.equal(note.gate, 'reply');

    await h.cycle(3);
    assert.equal((await notices(h, a.number)).length, 1);
    assert.equal(h.record(b.key).stage, 'fixing', 'the freed slot lets new work start');

    h.tracker.externalComment(a.number, 'ci-helper[bot]', 'Automated: build passed');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 0, 'a bot comment does not resume the session');

    h.ends(h.sessionId(b.key));
    await h.cycle(2);
    h.tracker.externalComment(a.number, 'maintainer', 'Keep the old API');
    await h.cycle(2);
    assert.equal(h.messages(id).length, 1);
    assert.equal(h.record(a.key).stage, 'fixing');
    assert.ok(consumesCapacity(h.record(a.key)));
    await h.cycle(2);
    assert.equal((await notices(h, a.number)).length, 1);
  });

  it('keeps the structured-question behaviour when a question is recorded', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const url = h.record(issue.key).session?.url ?? '';
    h.asks(id, 'Which browser?');
    await h.cycle(3);
    const posted = await notices(h, issue.number);
    assert.equal(posted.length, 1);
    assert.match(posted[0]?.body ?? '', /Which browser\?/);
    assert.ok(!(posted[0]?.body ?? '').includes(url));
    assert.deepEqual(h.record(issue.key).questions.map((q) => q.summary), ['Which browser?']);
  });
});
