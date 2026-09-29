import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { UNAVAILABLE_POLICY, type VerificationOutcome, type Verifier } from '../src/orchestrator/contracts.ts';
import { consumesCapacity } from '../src/orchestrator/orchestrator.ts';
import type { TrackerComment } from '../src/tracker/types.ts';
import { Harness, report } from './helpers/orchestrator.ts';

/** Service comments other than the one-per-session greeting. */
function workflowComment(comment: TrackerComment): boolean {
  return comment.fromService && !(comment.serviceKey ?? '').startsWith('session-started:');
}

const HEAD_1 = '1'.repeat(40);
const HEAD_2 = '2'.repeat(40);

let harness: Harness;

async function setup(t: TestContext, options: Parameters<typeof Harness.create>[0] = {}): Promise<Harness> {
  harness = await Harness.create(options);
  t.after(() => report(t, harness));
  return harness;
}

afterEach(async () => {
  await harness?.close();
});

describe('orchestrator: direct repair', () => {
  it('enrolls a bug-smasher issue, starts one capped repair session and records the PR from structured output', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels: ['bug-smasher'] });

    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'queued');
    assert.equal(h.createRequests().length, 0, 'one step per cycle: enrolment only');

    await h.cycle();
    const record = h.record(issue.key);
    assert.equal(record.stage, 'fixing');
    const [create] = h.createRequests();
    assert.ok(create);
    assert.equal(create.body.max_acu_limit, 5);
    assert.deepEqual(create.body.secret_ids, []);
    assert.deepEqual(create.body.session_secrets, []);
    assert.equal(create.body.structured_output_required, false);
    assert.ok(create.body.structured_output_schema);
    assert.ok(create.tags.includes(`bug-smasher:bug=${issue.key}`));
    assert.ok(create.tags.includes('bug-smasher:route=fix'));
    assert.match(create.prompt, /No investigation was run/);
    assert.match(create.prompt, /Resize to 400px/);
    assert.match(create.prompt, /Never merge/);

    const id = h.sessionId(issue.key);
    h.working(id);
    await h.cycle();
    assert.equal(h.record(issue.key).session?.liveState, 'running');

    const pr = h.tracker.seedPullRequest({ title: 'Fix legend', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.opensPr(id, pr.url);
    await h.cycle();
    const verifying = h.record(issue.key);
    assert.equal(verifying.stage, 'verifying');
    assert.equal(verifying.fix?.prNumber, pr.number);
    assert.equal(verifying.fix?.headSha, HEAD_1);

    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'verifying', 'no verifier configured: nothing is treated as verified');
    assert.ok(h.types(issue.key).includes('verifier-unavailable'));
    assert.equal(h.createRequests().length, 1);
  });
});

describe('orchestrator: investigation, question, reply, approval, repair', () => {
  it('runs the whole flow across restarts, relaying the human reply once and continuing the same session', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Charts look broken {{title}}', labels: ['needs-triage'] });
    h.tracker.externalComment(issue.number, 'reporter', 'Happens on Firefox only.');

    await h.cycle();
    await h.restart();
    await h.cycle();
    const id = h.sessionId(issue.key);
    assert.equal(h.record(issue.key).stage, 'triaging');
    const [create] = h.createRequests();
    assert.ok(create?.tags.includes('bug-smasher:route=triage'));
    assert.match(create?.prompt ?? '', /Charts look broken \{\{title\}\}/, 'issue text is inserted literally');
    assert.match(create?.prompt ?? '', /Happens on Firefox only\./);
    assert.match(create?.prompt ?? '', /Do not change code/);

    h.asks(id, 'Which chart library version do you use?');
    await h.restart();
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'needs-input');
    const question = (await h.tracker.listComments(issue.number)).filter(workflowComment);
    assert.equal(question.length, 1);
    assert.match(question[0]?.body ?? '', /Which chart library version do you use\?/);

    h.tracker.externalComment(issue.number, 'ci-helper[bot]', 'Automated: build passed');
    h.tracker.externalComment(issue.number, 'reporter', 'Version 4.2.1\n  with *custom* theme');
    await h.restart();
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'triaging');
    assert.deepEqual(h.record(issue.key).questions.map((q) => q.answeredAt !== null), [true]);
    const relayed = h.messages(id);
    assert.equal(relayed.length, 1);
    assert.match(relayed[0] ?? '', /Version 4\.2\.1\n {2}with \*custom\* theme/, 'reply relayed unchanged');
    assert.doesNotMatch(relayed[0] ?? '', /build passed/, 'bot comments are never relayed');

    h.completesTriage(id);
    await h.restart();
    await h.cycle(2);
    const triaged = h.record(issue.key);
    assert.equal(triaged.stage, 'triaged');
    assert.equal(triaged.triage?.recommendation, 'devin_fix');
    assert.deepEqual(triaged.decisions.filter((d) => d.action !== 'reply'), [], 'a recommendation is not a decision');
    const summaries = (await h.tracker.listComments(issue.number)).filter((c) => c.serviceKey?.startsWith('triage:'));
    assert.equal(summaries.length, 1);
    assert.match(summaries[0]?.body ?? '', /recommendation, not a decision/);
    assert.match(summaries[0]?.body ?? '', /npm test -- test\/legend\.test\.ts/);

    h.tracker.externalLabel(issue.number, 'bug-smasher', 'add', 'maintainer');
    await h.restart();
    await h.cycle();
    const fixing = h.record(issue.key);
    assert.equal(fixing.stage, 'fixing');
    assert.equal(fixing.session?.id, id, 'same live session continues into repair');
    const decision = fixing.decisions.find((d) => d.action === 'fix');
    assert.equal(decision?.actor, 'github:maintainer');
    assert.equal(h.createRequests().length, 1, 'no second session');
    const messages = h.messages(id);
    assert.equal(messages.length, 2);
    assert.match(messages[1] ?? '', /approved for repair/);
    const labels = (await h.tracker.getIssue(issue.number)).labels;
    assert.deepEqual(labels, ['bug-smasher']);

    await h.restart();
    await h.cycle(3);
    assert.equal(h.messages(id).length, 2, 'restarts repeat no messages');
    const comments = await h.tracker.listComments(issue.number);
    assert.equal(comments.filter(workflowComment).length, 2);
    assert.equal(comments.filter((c) => c.serviceKey?.startsWith('session-started:')).length, 1, 'repair in the same session posts no second link');
  });
});

async function triaged(h: Harness, labels: string[] = ['needs-triage']): Promise<{ number: number; key: string; id: string }> {
  const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', body: 'Resize to 400px', labels });
  await h.cycle(2);
  const id = h.sessionId(issue.key);
  h.completesTriage(id);
  await h.cycle();
  assert.equal(h.record(issue.key).stage, 'triaged');
  return { number: issue.number, key: issue.key, id };
}

describe('orchestrator: repair after the investigation session ended', () => {
  it('starts one new capped repair session carrying the saved findings and the human context', async (t) => {
    const h = await setup(t);
    const issue = await triaged(h);
    h.ends(issue.id);
    await h.cycle();
    assert.equal(h.record(issue.key).session?.liveState, 'ended');

    h.tracker.externalComment(issue.number, 'maintainer', 'Please keep the legend inside the plot area.');
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'add', 'maintainer');
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'queued');
    assert.equal(h.record(issue.key).route, 'fix');
    await h.cycle();
    const record = h.record(issue.key);
    assert.equal(record.stage, 'fixing');
    assert.notEqual(record.session?.id, issue.id);
    const creates = h.createRequests();
    assert.equal(creates.length, 2);
    const repair = creates[1];
    assert.ok(repair?.tags.includes('bug-smasher:route=fix'));
    assert.equal(repair?.body.max_acu_limit, 5);
    assert.match(repair?.prompt ?? '', /Suspected cause: Legend offset ignores axis height/, 'saved findings');
    assert.match(repair?.prompt ?? '', /npm test -- test\/legend\.test\.ts/, 'saved proposed check');
    assert.match(repair?.prompt ?? '', /Please keep the legend inside the plot area\./);
    assert.equal(h.messages(issue.id).length, 0, 'the ended session is not messaged');
  });
});

describe('orchestrator: close, handoff and reopen', () => {
  it('stops active work on close, reroutes on reopen and hands off on the engineer label', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['bug-smasher'] });
    await h.cycle(2);
    const first = h.sessionId(issue.key);
    h.working(first);

    h.tracker.externalCloseIssue(issue.number, 'maintainer');
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'closed');
    assert.equal(h.session(first).status, 'exit', 'closing stops the session');
    h.ends(first);
    await h.cycle(2);
    assert.equal(h.record(issue.key).session?.liveState, 'ended');
    assert.equal(h.createRequests().length, 1);

    h.tracker.externalReopenIssue(issue.number, 'maintainer');
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'queued');
    assert.equal(h.record(issue.key).route, 'fix');
    await h.cycle();
    const second = h.sessionId(issue.key);
    assert.notEqual(second, first);
    h.working(second);
    await h.cycle();

    h.tracker.externalLabel(issue.number, 'needs-engineer', 'add', 'maintainer');
    await h.cycle();
    const record = h.record(issue.key);
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.handoff?.reason, 'person');
    assert.equal(record.decisions.at(-1)?.actor, 'github:maintainer');
    assert.equal(h.session(second).status, 'exit', 'handoff stops the session');
    assert.deepEqual((await h.tracker.getIssue(issue.number)).labels, ['needs-engineer']);
    assert.equal((await h.tracker.getIssue(issue.number)).state, 'open', 'the service never closes issues');
    assert.equal(h.createRequests().length, 2);
  });

  it('hands off instead of restarting when a session ends unexpectedly', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend overlaps axis', labels: ['bug-smasher'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.ends(id);
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.handoff?.reason, 'session-ended');
    assert.equal(h.createRequests().length, 1);
    assert.ok((await h.tracker.getIssue(issue.number)).labels.includes('needs-engineer'));
  });
});

describe('orchestrator: labels', () => {
  it('leaves an unknown unlabelled issue untouched', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Question about the roadmap', labels: ['question'] });
    await h.cycle(3);
    assert.equal(h.store.get(issue.key), undefined);
    assert.equal(h.createRequests().length, 0);
    assert.deepEqual(await h.tracker.listComments(issue.number), []);
    assert.deepEqual((await h.tracker.getIssue(issue.number)).labels, ['question']);
  });

  it('does not start work for conflicting feature and bug-fix labels', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend', labels: ['bug-smasher', 'devin-builds-feature'] });
    await h.cycle(3);
    assert.equal(h.createRequests().length, 0);
    assert.equal(h.record(issue.key).route, null, 'a label conflict routes no work');
    h.tracker.externalLabel(issue.number, 'devin-builds-feature', 'remove', 'maintainer');
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'fixing');
    assert.equal(h.record(issue.key).kind, 'bug');
  });

  it('keeps tracking a live repair after its work label is removed', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend', labels: ['bug-smasher'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.working(id);
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'remove', 'maintainer');
    await h.cycle(3);
    assert.equal(h.record(issue.key).stage, 'fixing', 'removing the label neither forgets nor stops the work');
    assert.equal(h.session(id).status, 'running');
    const pr = h.tracker.seedPullRequest({ title: 'Fix', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.opensPr(id, pr.url);
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'verifying');
  });

  it('routes queued repair back to investigation when a person relabels it', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '1' } });
    const busy = h.tracker.seedIssue({ title: 'Busy', labels: ['bug-smasher'] });
    const issue = h.tracker.seedIssue({ title: 'Legend', labels: ['bug-smasher'] });
    await h.cycle(2);
    assert.equal(h.record(busy.key).stage, 'fixing');
    assert.equal(h.record(issue.key).route, 'fix');

    h.tracker.externalLabel(issue.number, 'needs-triage', 'add', 'maintainer');
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'remove', 'maintainer');
    await h.cycle();
    const record = h.record(issue.key);
    assert.equal(record.stage, 'queued');
    assert.equal(record.route, 'triage');
    assert.equal(record.decisions.at(-1)?.actor, 'github:maintainer');

    h.ends(h.sessionId(busy.key));
    await h.cycle(3);
    assert.equal(h.record(issue.key).stage, 'triaging');
    assert.ok(h.createRequests()[1]?.tags.includes('bug-smasher:route=triage'));
  });
});

describe('orchestrator: existing pull requests', () => {
  it('hands off instead of opening a duplicate repair PR', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'Legend', labels: ['bug-smasher'] });
    const pr = h.tracker.seedPullRequest({ title: 'Fix legend', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.handoff?.reason, 'existing-pr');
    assert.equal(h.createRequests().length, 0);
    const notices = (await h.tracker.listComments(issue.number)).filter((c) => c.fromService);
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.body ?? '', new RegExp(`#${pr.number}`));
  });

  it('hands off instead of continuing a live investigation into a duplicate repair', async (t) => {
    const h = await setup(t);
    const issue = await triaged(h);
    h.tracker.seedPullRequest({ title: 'Fix legend', body: `Closes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'add', 'maintainer');
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'with-engineer');
    assert.equal(h.record(issue.key).handoff?.reason, 'existing-pr');
    assert.ok(!h.messages(issue.id).some((message) => /approved for repair/.test(message)));
  });
});

describe('orchestrator: review hardening', () => {
  it('does not start repair when a bot adds the repair label to a triaged issue', async (t) => {
    const h = await setup(t);
    const issue = await triaged(h);
    h.tracker.externalLabel(issue.number, 'bug-smasher', 'add', 'automation[bot]');
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'triaged');
    assert.ok(h.types(issue.key).includes('decision-label-ignored'));
    assert.equal(h.messages(issue.id).length, 0);
    assert.equal(h.createRequests().length, 1);
  });

  it('includes every undelivered human comment when dispatching', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    for (let i = 1; i <= 12; i += 1) h.tracker.externalComment(issue.number, 'reporter', `detail number ${i}.`);
    await h.cycle(2);
    const prompt = h.createRequests()[0]?.prompt ?? '';
    for (let i = 1; i <= 12; i += 1) assert.match(prompt, new RegExp(`detail number ${i}\\.`));
  });

  it('does not carry a repair question into the work started after close and reopen', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle(2);
    h.asks(h.sessionId(issue.key), 'Which locale?', 'fix');
    await h.cycle();
    assert.ok(h.record(issue.key).workflow?.workQuestion);
    h.tracker.externalCloseIssue(issue.number, 'maintainer');
    await h.cycle(2);
    h.tracker.externalReopenIssue(issue.number, 'maintainer');
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'fixing');
    assert.equal(record.workflow?.workQuestion, null);
    assert.ok(consumesCapacity(record));
  });

  it('refuses a reported PR that does not close the issue', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle(2);
    const pr = h.tracker.seedPullRequest({ title: 'Unrelated', headSha: HEAD_1 });
    h.opensPr(h.sessionId(issue.key), pr.url);
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'fixing');
    assert.equal(h.record(issue.key).fix, null);
    assert.ok(h.lines(['structured-output-ignored']).some((line) => line.includes('does not close')));
  });
});

describe('orchestrator: exact-once effects', () => {
  it('does not resend a reply whose delivery answer was lost, nor repost a comment after a failed write', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.asks(id, 'Which browser?');
    h.tracker.failNext('postComment', { code: 'server-error', applied: true });
    await h.cycle();
    assert.ok(h.types(issue.key).includes('effect-failed'));
    await h.cycle(2);
    assert.equal((await h.tracker.listComments(issue.number)).filter(workflowComment).length, 1);

    h.tracker.externalComment(issue.number, 'reporter', 'Firefox');
    h.offline.failNext({ method: 'POST', path: '/messages', network: 'reset', applyFirst: true });
    await h.cycle();
    await h.restart();
    await h.cycle(2);
    assert.ok(h.types(issue.key).includes('message-already-delivered'));
    assert.equal(h.messages(id).length, 1);
    assert.equal(h.record(issue.key).workflow?.outbox.length, 0);
  });
});

describe('orchestrator: capacity', () => {
  it('queues work at MAX_ACTIVE_SESSIONS; sessions waiting on a person free capacity and are woken only when it is available', async (t) => {
    const h = await setup(t, { env: { MAX_ACTIVE_SESSIONS: '1' } });
    const a = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    const b = h.tracker.seedIssue({ title: 'B', labels: ['needs-triage'] });
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.equal(h.record(b.key).stage, 'queued');
    assert.ok(h.types(b.key).includes('waiting-for-capacity'));
    assert.equal(h.createRequests().length, 1);

    const idA = h.sessionId(a.key);
    h.asks(idA, 'Which browser?');
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'needs-input');
    assert.equal(h.record(b.key).stage, 'triaging', 'a session waiting on a person does not hold capacity');
    assert.equal(h.createRequests().length, 2);

    h.tracker.externalComment(a.number, 'reporter', 'Firefox');
    await h.cycle(2);
    assert.equal(h.record(a.key).stage, 'needs-input', 'the reply waits for capacity');
    assert.equal(h.messages(idA).length, 0);

    h.completesTriage(h.sessionId(b.key));
    await h.cycle(2);
    assert.equal(h.record(b.key).stage, 'triaged');
    assert.equal(h.record(a.key).stage, 'triaging');
    assert.equal(h.messages(idA).length, 1);
  });

  it('never runs two cycles at once', async (t) => {
    const h = await setup(t);
    h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await Promise.all([h.orchestrator.runCycle(), h.orchestrator.runCycle()]);
    assert.equal(h.trace.filter((e) => e.type === 'cycle-started').length, 1);
    assert.equal(h.trace.filter((e) => e.type === 'cycle-skipped').length, 1);
  });
});

describe('orchestrator: ambiguous session creation', () => {
  it('reconciles a create whose answer was lost by its attempt tag instead of creating again, across a restart', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle();
    h.offline.failNext({ method: 'POST', path: '/sessions', network: 'timeout', applyFirst: true });
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'queued');
    assert.ok(h.record(issue.key).workflow?.dispatch?.attemptTag);
    assert.ok(h.types(issue.key).includes('create-ambiguous'));

    await h.restart();
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'fixing');
    assert.equal(h.record(issue.key).workflow?.dispatch, null);
    assert.equal(h.createRequests().length, 1, 'no second create');
    assert.equal(h.offline.sessions.size, 1);
  });

  it('gives up on an ambiguous create only after reconciliation finds nothing, then dispatches again', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle();
    h.offline.failNext({ method: 'POST', path: '/sessions', network: 'timeout' });
    await h.cycle();
    await h.cycle(3);
    assert.ok(h.types(issue.key).includes('reconcile-not-found'));
    assert.ok(h.types(issue.key).includes('create-abandoned'));
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'fixing');
    assert.equal(h.offline.sessions.size, 1);
  });
});

describe('orchestrator: structured output', () => {
  it('refuses malformed or incomplete structured output and never parses chat text', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    h.offline.updateSession(id, { status: 'running', status_detail: 'finished', structured_output: { phase: 'triage', status: 'complete', title: 'x' } });
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'triaging');
    assert.equal(h.record(issue.key).triage, null);
    assert.ok(h.types(issue.key).includes('structured-output-ignored'));

    h.offline.updateSession(id, { structured_output: 'Triage complete: devin_fix' as unknown as Record<string, unknown> });
    await h.cycle(2);
    assert.equal(h.record(issue.key).stage, 'triaging');
    assert.deepEqual((await h.tracker.listComments(issue.number)).filter(workflowComment), []);
  });

  it('refuses a PR opened by an investigation session and posts one notice', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['needs-triage'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const pr = h.tracker.seedPullRequest({ title: 'Oops', headSha: HEAD_1, references: [issue.number] });
    h.opensPr(id, pr.url);
    await h.cycle(3);
    const record = h.record(issue.key);
    assert.equal(record.fix, null);
    assert.notEqual(record.stage, 'verifying');
    assert.ok(h.types(issue.key).includes('unexpected-triage-pr'));
    assert.equal((await h.tracker.listComments(issue.number)).filter(workflowComment).length, 1);
  });
});

describe('orchestrator: features', () => {
  it('skips bug triage and specifies the feature by the issue acceptance criteria only', async (t) => {
    const h = await setup(t);
    const body = '## Acceptance criteria\n- Export charts as SVG';
    const issue = h.tracker.seedIssue({ title: 'SVG export', body, labels: ['devin-builds-feature'] });
    await h.cycle(2);
    const record = h.record(issue.key);
    assert.equal(record.kind, 'feature');
    assert.equal(record.stage, 'fixing');
    const [create] = h.createRequests();
    assert.ok(create?.tags.includes('bug-smasher:route=fix'));
    assert.match(create?.prompt ?? '', /Export charts as SVG/);
    assert.match(create?.prompt ?? '', /acceptance criteria/i);
    assert.match(create?.prompt ?? '', /do not invent bug reproduction steps/);
    assert.doesNotMatch(create?.prompt ?? '', /Investigation findings/);
  });
});

describe('orchestrator: merge', () => {
  it('records the actual merge commit and acknowledges it once to the live session', async (t) => {
    const h = await setup(t);
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const pr = h.tracker.seedPullRequest({ title: 'Fix', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.opensPr(id, pr.url);
    await h.cycle();
    const mergeSha = h.tracker.externalMerge(pr.number, 'maintainer');
    await h.cycle();
    await h.restart();
    await h.cycle(2);
    const record = h.record(issue.key);
    assert.equal(record.stage, 'merged');
    assert.equal(record.fix?.mergeCommitSha, mergeSha);
    const acks = h.messages(id).filter((message) => message.includes(`merge commit ${mergeSha}`));
    assert.equal(acks.length, 1);
    assert.ok(!h.lines(['effect-applied']).some((line) => line.includes('close-issue')), 'GitHub closes the issue, not the service');
  });
});

class ScriptedVerifier implements Verifier {
  readonly live = true;
  readonly calls: string[] = [];
  readonly #results: ('pass' | 'fail' | 'error' | 'unavailable')[];
  constructor(results: ('pass' | 'fail' | 'error' | 'unavailable')[]) {
    this.#results = results;
  }
  async verify(request: Parameters<Verifier['verify']>[0]): Promise<VerificationOutcome> {
    this.calls.push(request.headSha);
    const result = this.#results.shift() ?? 'unavailable';
    if (result === 'unavailable') return { status: 'unavailable', reason: 'runner offline' };
    return {
      status: 'completed',
      attempt: {
        phase: 'pre-merge',
        baseSha: request.baseSha,
        headSha: request.headSha,
        result,
        reason: result === 'fail' ? 'regression test still fails' : result === 'error' ? 'runner crashed' : 'passed',
        outputTail: `${result} output`,
        at: new Date(0).toISOString(),
      },
    };
  }
}

describe('orchestrator: verification contract', () => {
  it('keeps failed-proof and infrastructure-error budgets separate and retries on the same PR branch', async (t) => {
    const verifier = new ScriptedVerifier(['error', 'fail', 'unavailable']);
    const h = await setup(t, { verifier, env: { MAX_FIX_RETRIES: '1' } });
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle(2);
    const id = h.sessionId(issue.key);
    const pr = h.tracker.seedPullRequest({ title: 'Fix', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.opensPr(id, pr.url);
    await h.cycle();
    assert.equal(h.record(issue.key).stage, 'verifying');

    await h.cycle(2);
    const afterError = h.record(issue.key);
    assert.deepEqual(afterError.verifications.map((v) => v.result), ['error']);
    assert.equal(afterError.stage, 'verifying', 'an infrastructure error does not spend the fix-retry budget');

    await h.cycle(2);
    const afterFail = h.record(issue.key);
    assert.deepEqual(afterFail.verifications.map((v) => v.result), ['error', 'fail']);
    assert.equal(afterFail.stage, 'fixing', 'a failed proof sends the fix back for one retry');
    const retry = h.messages(id).find((message) => /regression test still fails/.test(message));
    assert.ok(retry);
    assert.match(retry, new RegExp(HEAD_1));
    assert.match(retry, /same (pull request|PR|branch)/i);

    h.tracker.pushHead(pr.number, HEAD_2);
    h.opensPr(id, pr.url);
    await h.cycle(2);
    assert.equal(h.record(issue.key).fix?.headSha, HEAD_2);
    await h.cycle(3);
    assert.deepEqual(h.record(issue.key).verifications.map((v) => v.result), ['error', 'fail'], 'unavailable is never recorded as a pass');
    assert.equal(h.record(issue.key).stage, 'verifying');
    assert.ok(h.types(issue.key).includes('verifier-unavailable'));
  });

  it('refuses results from a non-live verifier when live results are required', async (t) => {
    const verifier: Verifier = { live: false, verify: async () => assert.fail('must not be called') };
    const h = await setup(t, { verifier, requireLiveResults: true });
    const issue = h.tracker.seedIssue({ title: 'A', labels: ['bug-smasher'] });
    await h.cycle(2);
    const pr = h.tracker.seedPullRequest({ title: 'Fix', body: `Fixes #${issue.number}`, headSha: HEAD_1, references: [issue.number] });
    h.opensPr(h.sessionId(issue.key), pr.url);
    await h.cycle(3);
    assert.equal(h.record(issue.key).stage, 'verifying');
    assert.deepEqual(h.record(issue.key).verifications, []);
  });

  it('does not decide for a person when the decision policy is unavailable', async (t) => {
    const h = await setup(t, { env: { DECISION: 'rule' }, policy: UNAVAILABLE_POLICY });
    const issue = await triaged(h);
    await h.cycle(3);
    assert.equal(h.record(issue.key).stage, 'triaged');
    assert.ok(h.types(issue.key).includes('policy-unavailable'));
    assert.equal(h.createRequests().length, 1);
  });
});

describe('orchestrator: interface actions', () => {
  it('records interface actions with the interface actor, not an invented person', async (t) => {
    const h = await setup(t);
    const issue = await triaged(h);
    const outcome = await h.orchestrator.performAction(issue.key, { name: 'engineer', context: 'Needs a schema change' });
    assert.equal(outcome.status, 'applied');
    const record = h.record(issue.key);
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.decisions.at(-1)?.actor, 'interface:bug-smasher');
    assert.equal(h.session(issue.id).status, 'exit');
    const refused = await h.orchestrator.performAction(issue.key, { name: 'reply', answer: '   ' });
    assert.equal(refused.status, 'refused');
  });
});
