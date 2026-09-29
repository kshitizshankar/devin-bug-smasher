import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intakeEligibility, resolveLabels } from '../src/model/labels.ts';
import { presentBug } from '../src/model/presentation.ts';
import { applyEvent, enrollBug } from '../src/model/transitions.ts';
import { enroll, event, expectError, expectOk, facts, LABEL, now, options } from './helpers/model.ts';

describe('label precedence and conflicts', () => {
  it('lets the engineer label win over every other workflow label', () => {
    const all = [LABEL.triage, LABEL.fix, LABEL.feature, LABEL.engineer];
    assert.deepEqual(resolveLabels(all, LABEL), { route: 'engineer', conflict: null });

    const record = enroll(all);
    assert.equal(record.stage, 'with-engineer');
    assert.equal(record.handoff?.reason, 'engineer-label');
    const view = presentBug(record, facts(all), LABEL);
    assert.equal(view.statusLabel, 'Needs an engineer');
    assert.equal(view.group, 'Backlog');
  });

  it('prefers the destination repair label when triage and repair labels coexist', () => {
    assert.equal(resolveLabels([LABEL.triage, LABEL.fix], LABEL).route, 'fix');
    const record = enroll([LABEL.triage, LABEL.fix]);
    assert.equal(record.route, 'fix');
    assert.equal(presentBug(record, facts([LABEL.triage, LABEL.fix]), LABEL).group, 'Fix');
  });

  it('routes feature work straight to Fix as a feature, distinct from bug repair', () => {
    const record = enroll([LABEL.feature]);
    assert.equal(record.kind, 'feature');
    assert.equal(record.route, 'fix');
    const view = presentBug(record, facts([LABEL.feature]), LABEL);
    assert.equal(view.statusLabel, 'Queued for implementation');
    assert.equal(view.group, 'Fix');

    const bug = enroll([LABEL.fix]);
    assert.equal(bug.kind, 'bug');
    assert.equal(presentBug(bug, facts([LABEL.fix]), LABEL).statusLabel, 'Queued for repair');
  });

  it('refuses automatic dispatch with a clear reason when feature and bug-fix labels coexist', () => {
    const labels = [LABEL.feature, LABEL.fix];
    const resolution = resolveLabels(labels, LABEL);
    assert.equal(resolution.route, null);
    assert.match(resolution.conflict ?? '', /devin-builds-feature.*bug-smasher/);

    const record = enroll(labels);
    assert.equal(record.route, null);
    const view = presentBug(record, facts(labels), LABEL);
    assert.equal(view.status, 'label-conflict');
    assert.deepEqual(view.actions, ['engineer', 'close']);

    const start = applyEvent(
      { ...record, route: 'fix' },
      { type: 'session-started', session: { id: 's', url: 'u' }, issueState: 'open', labels },
      options,
      now(),
    );
    expectError(start, 'label-conflict');
  });

  it('matches labels case-insensitively, like GitHub', () => {
    assert.equal(resolveLabels(['Needs-Triage'], LABEL).route, 'triage');
    assert.equal(resolveLabels(['NEEDS-ENGINEER', 'bug-smasher'], LABEL).route, 'engineer');
  });

  it('uses the configured label names instead of the defaults', () => {
    const custom = { triage: 'triage-me', fix: 'fix-me', engineer: 'human', feature: 'build-me' };
    assert.equal(resolveLabels(['needs-triage'], custom).route, null);
    assert.equal(resolveLabels(['fix-me', 'triage-me'], custom).route, 'fix');
  });

  it('moves a record to an engineer when the engineer label appears during work', () => {
    const record = enroll([LABEL.triage]);
    const handed = event(record, { type: 'labels-changed', labels: [LABEL.triage, LABEL.engineer] });
    assert.equal(handed.stage, 'with-engineer');
    assert.equal(handed.handoff?.reason, 'engineer-label');
  });
});

describe('intake eligibility', () => {
  it('does not enroll an unlabelled, unknown issue but shows it as Backlog without starting work', () => {
    assert.equal(intakeEligibility(undefined, ['bug', 'ui'], LABEL).eligible, false);
    expectError(enrollBug(facts(['bug', 'ui']), options, now()), 'not-eligible');

    const view = presentBug(undefined, facts(['bug']), LABEL);
    assert.equal(view.key, 'acme/widgets#42');
    assert.equal(view.status, 'not-started');
    assert.equal(view.group, 'Backlog');
    assert.deepEqual(view.actions, ['triage', 'fix', 'engineer', 'close']);
  });

  it('keeps a known record eligible after its workflow labels are removed', () => {
    const record = enroll([LABEL.triage]);
    assert.equal(record.key, 'acme/widgets#42');
    const eligibility = intakeEligibility(record, [], LABEL);
    assert.equal(eligibility.eligible, true);
    const same = expectOk(applyEvent(record, { type: 'labels-changed', labels: [] }, options, now()));
    assert.equal(same.changed, false);
    assert.equal(same.record.stage, 'queued');
  });

  it('enrolls any workflow-labelled issue in the route its labels select', () => {
    assert.equal(enroll([LABEL.triage]).route, 'triage');
    assert.equal(enroll([LABEL.fix]).route, 'fix');
    assert.equal(enroll([LABEL.engineer]).stage, 'with-engineer');
  });

  it('does not enroll closed issues, which permit no running work', () => {
    expectError(enrollBug(facts([LABEL.triage], { state: 'closed' }), options, now()), 'issue-closed');
  });
});
