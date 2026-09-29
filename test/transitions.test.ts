import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presentBug } from '../src/model/presentation.ts';
import { applyEvent, type ModelEvent } from '../src/model/transitions.ts';
import type { BugRecord } from '../src/model/types.ts';
import {
  act,
  attempt,
  enroll,
  event,
  expectError,
  expectOk,
  facts,
  findings,
  fixInfo,
  fixingRecord,
  HEAD_A,
  HEAD_B,
  LABEL,
  now,
  options,
  triagingRecord,
  verifyingRecord,
} from './helpers/model.ts';

function reject(record: BugRecord, modelEvent: ModelEvent, code: string): void {
  const snapshot = structuredClone(record);
  expectError(applyEvent(record, modelEvent, options, now()), code);
  assert.deepEqual(record, snapshot, 'an invalid event must leave the record unchanged');
}

function stages(record: BugRecord): string[] {
  return record.stageHistory.map((entry) => entry.stage);
}

describe('investigation, questions and replies', () => {
  it('moves to needs-input for a question and resumes after a reply', () => {
    const triaging = triagingRecord();
    assert.equal(triaging.stage, 'triaging');
    assert.equal(triaging.session?.id, 'session-triage');

    const waiting = event(triaging, { type: 'question-asked', question: { id: 'q1', summary: 'Which browser?' } });
    assert.equal(waiting.stage, 'needs-input');
    const view = presentBug(waiting, facts([LABEL.triage]), LABEL);
    assert.equal(view.statusLabel, 'Waiting for a reply');
    assert.equal(view.group, 'Triage');
    assert.ok(view.actions.includes('reply'));
    assert.equal(view.history.outstandingQuestion?.id, 'q1');

    const resumed = event(waiting, { type: 'reply-received', questionId: 'q1' });
    assert.equal(resumed.stage, 'triaging');
    assert.ok(resumed.questions[0]?.answeredAt);
    assert.deepEqual(stages(resumed), ['queued', 'triaging', 'needs-input', 'triaging']);

    const again = expectOk(applyEvent(resumed, { type: 'reply-received', questionId: 'q1' }, options, now()));
    assert.equal(again.changed, false, 'a duplicate reply is not recorded twice');
    assert.equal(again.record.stageHistory.length, resumed.stageHistory.length);
  });

  it('accepts a reply action only while a question is outstanding', () => {
    const triaging = triagingRecord();
    expectError(act(triaging, facts([LABEL.triage]), { name: 'reply', actor: 'ana', answer: 'x' }), 'action-not-permitted');

    const waiting = event(triaging, { type: 'question-asked', question: { id: 'q1', summary: 'Which browser?' } });
    expectError(act(waiting, facts([LABEL.triage]), { name: 'reply', actor: 'ana', answer: '  ' }), 'missing-answer');
    const replied = expectOk(act(waiting, facts([LABEL.triage]), { name: 'reply', actor: 'ana', answer: 'Firefox' }));
    assert.equal(replied.record.stage, 'triaging');
    assert.deepEqual(replied.effects, [{ type: 'post-comment', body: 'Firefox' }]);
    assert.equal(replied.record.decisions.at(-1)?.actor, 'ana');
  });

  it('rejects questions outside investigation and unknown replies without changing the record', () => {
    reject(enroll([LABEL.triage]), { type: 'question-asked', question: { id: 'q', summary: 's' } }, 'invalid-stage');
    reject(triagingRecord(), { type: 'reply-received', questionId: 'nope' }, 'unknown-question');
  });

  it('finishes at triaged for a decision and stores findings without executing proposed commands', () => {
    const triaged = event(triagingRecord(), { type: 'triage-completed', findings: findings() });
    assert.equal(triaged.stage, 'triaged');
    assert.equal(triaged.triage?.proposedTest.command, 'rm -rf / # data only');
    const view = presentBug(triaged, facts([LABEL.triage]), LABEL);
    assert.equal(view.statusLabel, 'Needs a decision');
    assert.deepEqual(view.actions, ['fix', 'engineer', 'close']);
    assert.equal(view.history.recommendation, 'devin_fix');
  });

  it('rejects malformed triage findings', () => {
    reject(
      triagingRecord(),
      { type: 'triage-completed', findings: { ...findings(), confidence: 'certain' as 'high' } },
      'invalid-data',
    );
  });
});

describe('decision and repair', () => {
  it('turns a fix decision into a queued repair, label effects and one decision entry', () => {
    const triaged = event(triagingRecord(), { type: 'triage-completed', findings: findings() });
    const decided = expectOk(act(triaged, facts([LABEL.triage]), { name: 'fix', actor: 'ana', context: 'go' }));
    assert.equal(decided.record.stage, 'queued');
    assert.equal(decided.record.route, 'fix');
    assert.deepEqual(decided.effects, [
      { type: 'add-label', label: LABEL.fix },
      { type: 'remove-label', label: LABEL.triage },
      { type: 'stop-session', sessionId: 'session-triage' },
    ]);
    assert.equal(decided.record.decisions.length, 1);
    assert.deepEqual(
      { ...decided.record.decisions[0], at: undefined },
      { action: 'fix', outcome: 'applied', actor: 'ana', at: undefined, context: 'go' },
    );

    const stale = [LABEL.triage];
    reject(
      decided.record,
      { type: 'session-started', session: { id: 's', url: 'u' }, issueState: 'open', labels: stale },
      'label-mismatch',
    );
    const labelled = [LABEL.triage, LABEL.fix];
    assert.equal(event(decided.record, { type: 'labels-changed', labels: stale }).route, 'fix');
    const fixing = event(decided.record, {
      type: 'session-started',
      session: { id: 'session-fix', url: 'u' },
      issueState: 'open',
      labels: labelled,
    });
    assert.equal(fixing.stage, 'fixing');
    assert.equal(fixing.triage?.title, findings().title, 'triage findings are retained through repair');
  });

  it('proceeds from fixing to verifying to ready-to-merge only with a passing current-head proof', () => {
    const verifying = verifyingRecord();
    assert.equal(verifying.stage, 'verifying');
    const open = facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: HEAD_A } });
    assert.equal(presentBug(verifying, open, LABEL).statusLabel, 'Verifying');
    assert.ok(!presentBug(verifying, open, LABEL).actions.includes('merge'), 'a mere open PR is not mergeable');

    const ready = event(verifying, { type: 'verification-recorded', attempt: attempt('pass') });
    assert.equal(ready.stage, 'ready-to-merge');
    const view = presentBug(ready, open, LABEL);
    assert.equal(view.statusLabel, 'Ready to merge');
    assert.deepEqual(view.actions, ['merge', 'engineer', 'close']);
    assert.equal(view.history.currentHeadVerified, true);
  });

  it('refuses a session start for a closed issue or while a session is active', () => {
    const queued = enroll([LABEL.fix]);
    reject(
      queued,
      { type: 'session-started', session: { id: 's', url: 'u' }, issueState: 'closed', labels: [LABEL.fix] },
      'issue-closed',
    );
    reject(
      fixingRecord(),
      { type: 'session-started', session: { id: 's2', url: 'u' }, issueState: 'open', labels: [LABEL.fix] },
      'invalid-stage',
    );
  });
});

describe('verification failures, errors and retries', () => {
  it('allows one retry after the first failed proof and hands off on the second failure', () => {
    const verifying = verifyingRecord();
    const retry = event(verifying, { type: 'verification-recorded', attempt: attempt('fail') });
    assert.equal(retry.stage, 'fixing', 'first failure goes back to Devin for one retry');
    assert.equal(retry.handoff, null);

    const reverifying = event(retry, { type: 'head-changed', headSha: HEAD_B });
    assert.equal(reverifying.stage, 'verifying');
    const handed = event(reverifying, { type: 'verification-recorded', attempt: attempt('fail', HEAD_B) });
    assert.equal(handed.stage, 'with-engineer');
    assert.equal(handed.handoff?.reason, 'verification-failed');
    assert.equal(handed.verifications.length, 2);
  });

  it('honours a configured retry budget of zero', () => {
    const verifying = verifyingRecord();
    const result = expectOk(
      applyEvent(verifying, { type: 'verification-recorded', attempt: attempt('fail') }, { ...options, maxFixRetries: 0 }, now()),
    );
    assert.equal(result.record.stage, 'with-engineer');
    assert.deepEqual(result.effects, [{ type: 'stop-session', sessionId: 'session-fix' }]);
  });

  it('counts infrastructure errors separately: retries, then hands off on the third error', () => {
    let record = verifyingRecord();
    record = event(record, { type: 'verification-recorded', attempt: attempt('error') });
    assert.equal(record.stage, 'verifying', 'first error retries verification');
    record = event(record, { type: 'verification-recorded', attempt: attempt('error') });
    assert.equal(record.stage, 'verifying', 'second error retries verification');
    record = event(record, { type: 'verification-recorded', attempt: attempt('error') });
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.handoff?.reason, 'verification-error');
  });

  it('never counts infrastructure errors as failed-fix attempts', () => {
    let record = verifyingRecord();
    record = event(record, { type: 'verification-recorded', attempt: attempt('error') });
    record = event(record, { type: 'verification-recorded', attempt: attempt('error') });
    record = event(record, { type: 'verification-recorded', attempt: attempt('fail') });
    assert.equal(record.stage, 'fixing', 'two errors do not consume the failed-proof retry');

    record = event(record, { type: 'head-changed', headSha: HEAD_B });
    record = event(record, { type: 'verification-recorded', attempt: attempt('pass', HEAD_B) });
    assert.equal(record.stage, 'ready-to-merge', 'errors plus one failure still allow a passing retry');
  });

  it('does not let failed proofs consume the infrastructure error budget', () => {
    let record = verifyingRecord();
    record = event(record, { type: 'verification-recorded', attempt: attempt('fail') });
    record = event(record, { type: 'head-changed', headSha: HEAD_B });
    record = event(record, { type: 'verification-recorded', attempt: attempt('error', HEAD_B) });
    record = event(record, { type: 'verification-recorded', attempt: attempt('error', HEAD_B) });
    assert.equal(record.stage, 'verifying', 'one failure plus two errors is below both budgets');
  });

  it('rejects a verification result for a head other than the current one', () => {
    reject(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass', HEAD_B) }, 'stale-head');
  });
});

describe('changed-head invalidation', () => {
  it('invalidates a passing proof when the PR head changes', () => {
    const ready = event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') });
    const moved = event(ready, { type: 'head-changed', headSha: HEAD_B });
    assert.equal(moved.stage, 'verifying');
    const view = presentBug(moved, facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: HEAD_B } }), LABEL);
    assert.equal(view.statusLabel, 'Verifying');
    assert.ok(!view.actions.includes('merge'));
    assert.equal(view.history.currentHeadVerified, false);
    assert.equal(view.history.latestVerification?.headSha, HEAD_A, 'the old proof stays visible as history');
    expectError(act(moved, facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: HEAD_B } }), { name: 'merge', actor: 'ana' }), 'action-not-permitted');
  });

  it('does not offer merge when GitHub reports a newer head than the verified one', () => {
    const ready = event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') });
    const newer = facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: HEAD_B } });
    const view = presentBug(ready, newer, LABEL);
    assert.equal(view.status, 'verifying');
    assert.ok(!view.actions.includes('merge'));
  });
});

describe('merge, merged and closed', () => {
  const openPr = facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: HEAD_A } });

  it('records a merge request without claiming the PR is merged', () => {
    const ready = event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') });
    const requested = expectOk(act(ready, openPr, { name: 'merge', actor: 'ana' }));
    assert.equal(requested.record.stage, 'ready-to-merge');
    assert.deepEqual(requested.effects, [{ type: 'merge-pr', prNumber: 7, expectedHeadSha: HEAD_A }]);
    assert.equal(requested.record.decisions.at(-1)?.outcome, 'requested');
  });

  it('shows an actual merge as Merged and never offers merge again', () => {
    const ready = event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') });
    const merged = event(ready, { type: 'pr-merged' });
    assert.equal(merged.stage, 'merged');
    const mergedFacts = facts([LABEL.fix], { pullRequest: { number: 7, state: 'merged', headSha: HEAD_A } });
    const view = presentBug(merged, mergedFacts, LABEL);
    assert.equal(view.statusLabel, 'Merged');
    assert.equal(view.group, 'Merged');
    assert.deepEqual(view.actions, ['close']);
    assert.equal(view.history.postMergeVerified, null, 'merged is not yet a proven fix');

    const closedIssue = facts([LABEL.fix], { state: 'closed', pullRequest: { number: 7, state: 'merged', headSha: HEAD_A } });
    assert.deepEqual(presentBug(merged, closedIssue, LABEL).actions, []);
    assert.equal(expectOk(applyEvent(merged, { type: 'issue-closed' }, options, now())).changed, false);
    expectError(act(merged, closedIssue, { name: 'merge', actor: 'ana' }), 'action-not-permitted');
    reject(merged, { type: 'pr-merged' }, 'already-merged');
  });

  it('marks a passing post-merge verification as proven and hands off a failing one', () => {
    const merged = event(event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') }), {
      type: 'pr-merged',
    });
    const mergedFacts = facts([LABEL.fix], { pullRequest: { number: 7, state: 'merged', headSha: HEAD_A } });
    const proven = event(merged, { type: 'verification-recorded', attempt: attempt('pass', HEAD_A, 'post-merge') });
    assert.equal(presentBug(proven, mergedFacts, LABEL).history.postMergeVerified, true);

    const failed = event(merged, { type: 'verification-recorded', attempt: attempt('fail', HEAD_A, 'post-merge') });
    assert.equal(failed.stage, 'with-engineer');
    assert.equal(failed.handoff?.reason, 'post-merge-verification-failed');
    const view = presentBug(failed, mergedFacts, LABEL);
    assert.equal(view.statusLabel, 'Needs an engineer');
    assert.equal(view.history.postMergeVerified, false);
    assert.equal(view.history.wasMerged, true, 'the historical merge stays visible');
    assert.ok(!view.actions.includes('merge'));
  });

  it('shows closed issues as Closed with no actions and no running work', () => {
    const fixing = fixingRecord();
    const closed = expectOk(applyEvent(fixing, { type: 'issue-closed' }, options, now()));
    assert.equal(closed.record.stage, 'closed');
    assert.deepEqual(closed.effects, [{ type: 'stop-session', sessionId: 'session-fix' }]);
    const view = presentBug(closed.record, facts([LABEL.fix], { state: 'closed' }), LABEL);
    assert.equal(view.statusLabel, 'Closed');
    assert.deepEqual(view.actions, []);
    reject(
      closed.record,
      { type: 'session-started', session: { id: 's', url: 'u' }, issueState: 'closed', labels: [LABEL.fix] },
      'issue-closed',
    );
    expectError(act(closed.record, facts([LABEL.fix], { state: 'closed' }), { name: 'fix', actor: 'ana' }), 'action-not-permitted');
  });

  it('shows Closed as soon as GitHub reports the issue closed, before the event is applied', () => {
    const view = presentBug(fixingRecord(), facts([LABEL.fix], { state: 'closed' }), LABEL);
    assert.equal(view.status, 'closed');
    assert.deepEqual(view.actions, []);
  });

  it('closes via the close action with a close-issue effect', () => {
    const result = expectOk(act(enroll([LABEL.triage]), facts([LABEL.triage]), { name: 'close', actor: 'ana' }));
    assert.equal(result.record.stage, 'closed');
    assert.deepEqual(result.effects, [{ type: 'close-issue' }]);
  });
});

describe('handoff and return', () => {
  it('hands off when the fix PR is closed without merging', () => {
    const handed = event(verifyingRecord(), { type: 'pr-closed' });
    assert.equal(handed.stage, 'with-engineer');
    assert.equal(handed.handoff?.reason, 'pr-closed-unmerged');
  });

  it('hands off when the Devin session ends during active work, but not after triage finished', () => {
    const ended = event(fixingRecord(), { type: 'session-status', sessionId: 'session-fix', liveState: 'ended' });
    assert.equal(ended.stage, 'with-engineer');
    assert.equal(ended.handoff?.reason, 'session-ended');

    const triaged = event(triagingRecord(), { type: 'triage-completed', findings: findings() });
    const finished = event(triaged, { type: 'session-status', sessionId: 'session-triage', liveState: 'ended' });
    assert.equal(finished.stage, 'triaged');
    assert.equal(finished.session?.liveState, 'ended');
  });

  it('hands off via the engineer action, stopping the session and moving labels', () => {
    const result = expectOk(act(fixingRecord(), facts([LABEL.fix]), { name: 'engineer', actor: 'ana', context: 'too risky' }));
    assert.equal(result.record.stage, 'with-engineer');
    assert.deepEqual(result.record.handoff && { ...result.record.handoff, at: undefined }, {
      reason: 'person',
      detail: 'too risky',
      at: undefined,
    });
    assert.deepEqual(result.effects, [
      { type: 'add-label', label: LABEL.engineer },
      { type: 'remove-label', label: LABEL.fix },
      { type: 'stop-session', sessionId: 'session-fix' },
    ]);
  });

  it('returns a handoff to investigation or repair with added context', () => {
    const handed = event(verifyingRecord(), { type: 'pr-closed' });
    const engineerFacts = facts([LABEL.engineer]);
    assert.deepEqual(presentBug(handed, engineerFacts, LABEL).actions, ['triage', 'fix', 'close']);

    const back = expectOk(act(handed, engineerFacts, { name: 'fix', actor: 'ana', context: 'Use the v2 API' }));
    assert.equal(back.record.stage, 'queued');
    assert.equal(back.record.route, 'fix');
    assert.equal(back.record.decisions.at(-1)?.context, 'Use the v2 API');
    assert.deepEqual(back.effects, [
      { type: 'add-label', label: LABEL.fix },
      { type: 'remove-label', label: LABEL.engineer },
    ]);

    const toTriage = expectOk(act(handed, engineerFacts, { name: 'triage', actor: 'ana' }));
    assert.equal(toTriage.record.route, 'triage');
  });

  it('returns from an engineer when the engineer label is replaced by a work label', () => {
    const handed = enroll([LABEL.engineer]);
    const back = event(handed, { type: 'labels-changed', labels: [LABEL.triage] });
    assert.equal(back.stage, 'queued');
    assert.equal(back.route, 'triage');
  });

  it('resets retry and error budgets for a new fix session after a return', () => {
    let record = verifyingRecord();
    record = event(record, { type: 'verification-recorded', attempt: attempt('fail') });
    record = event(record, { type: 'head-changed', headSha: HEAD_B });
    record = event(record, { type: 'verification-recorded', attempt: attempt('fail', HEAD_B) });
    assert.equal(record.stage, 'with-engineer');

    record = expectOk(act(record, facts([LABEL.engineer]), { name: 'fix', actor: 'ana' })).record;
    record = event(record, { type: 'session-started', session: { id: 'session-2', url: 'u' }, issueState: 'open', labels: [LABEL.fix] });
    record = event(record, { type: 'fix-submitted', fix: fixInfo('d'.repeat(40)) });
    record = event(record, { type: 'verification-recorded', attempt: attempt('fail', 'd'.repeat(40)) });
    assert.equal(record.stage, 'fixing', 'the new session gets its own retry');
  });
});

describe('closing and reopening', () => {
  it('reopens from completed triage when findings exist', () => {
    const triaged = event(triagingRecord(), { type: 'triage-completed', findings: findings() });
    const closed = event(triaged, { type: 'issue-closed' });
    const reopened = event(closed, { type: 'issue-reopened', labels: [LABEL.triage] });
    assert.equal(reopened.stage, 'triaged');
    assert.equal(presentBug(reopened, facts([LABEL.triage]), LABEL).statusLabel, 'Needs a decision');
    assert.deepEqual(stages(reopened), ['queued', 'triaging', 'triaged', 'closed', 'triaged']);
  });

  it('reopens without findings in the route selected by labels', () => {
    const closed = event(enroll([LABEL.triage]), { type: 'issue-closed' });
    const toFix = event(closed, { type: 'issue-reopened', labels: [LABEL.fix] });
    assert.equal(toFix.stage, 'queued');
    assert.equal(toFix.route, 'fix');

    const toEngineer = event(closed, { type: 'issue-reopened', labels: [LABEL.engineer, LABEL.fix] });
    assert.equal(toEngineer.stage, 'with-engineer');

    const unlabelled = event(closed, { type: 'issue-reopened', labels: [] });
    assert.equal(unlabelled.stage, 'queued');
    assert.equal(unlabelled.route, null);
    assert.equal(presentBug(unlabelled, facts([]), LABEL).status, 'not-started');
  });

  it('records each stage change and timestamp once per actual transition', () => {
    const record = enroll([LABEL.triage]);
    const same = expectOk(applyEvent(record, { type: 'labels-changed', labels: [LABEL.triage] }, options, now()));
    assert.equal(same.changed, false);
    assert.equal(same.record.stageHistory.length, 1);
    assert.equal(same.record.updatedAt, record.updatedAt);
    const times = event(event(record, { type: 'issue-closed' }), { type: 'issue-reopened', labels: [LABEL.triage] })
      .stageHistory.map((entry) => entry.at);
    assert.deepEqual([...times].sort(), times, 'stage timestamps are recorded in order');
    assert.equal(new Set(times).size, times.length);
  });
});
