import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { presentBug } from '../src/model/presentation.ts';
import { ACTION_NAMES, type BugRecord, type GitHubFacts } from '../src/model/types.ts';
import {
  act,
  attempt,
  enroll,
  event,
  facts,
  findings,
  fixingRecord,
  HEAD_A,
  LABEL,
  MERGE_SHA,
  triagingRecord,
  verifyingRecord,
} from './helpers/model.ts';

interface Row {
  scenario: string;
  build: () => { record: BugRecord | undefined; facts: GitHubFacts };
  status: string;
  group: string;
  actions: string[];
}

const openPr = (labels: string[]) => facts(labels, { pullRequest: { number: 7, state: 'open', headSha: HEAD_A } });
const mergedPr = (state: 'open' | 'closed') =>
  facts([LABEL.fix], { state, pullRequest: { number: 7, state: 'merged', headSha: HEAD_A } });
const ready = () => event(verifyingRecord(), { type: 'verification-recorded', attempt: attempt('pass') });

/** The state/action table, built through real transitions. */
const TABLE: Row[] = [
  {
    scenario: 'unknown, unlabelled open issue',
    build: () => ({ record: undefined, facts: facts(['bug']) }),
    status: 'Not started',
    group: 'Backlog',
    actions: ['triage', 'fix', 'engineer', 'close'],
  },
  {
    scenario: 'queued for investigation',
    build: () => ({ record: enroll([LABEL.triage]), facts: facts([LABEL.triage]) }),
    status: 'Queued for investigation',
    group: 'Triage',
    actions: ['fix', 'engineer', 'close'],
  },
  {
    scenario: 'queued for repair',
    build: () => ({ record: enroll([LABEL.fix]), facts: facts([LABEL.fix]) }),
    status: 'Queued for repair',
    group: 'Fix',
    actions: ['triage', 'engineer', 'close'],
  },
  {
    scenario: 'queued feature',
    build: () => ({ record: enroll([LABEL.feature]), facts: facts([LABEL.feature]) }),
    status: 'Queued for implementation',
    group: 'Fix',
    actions: ['engineer', 'close'],
  },
  {
    scenario: 'feature and bug-fix label conflict',
    build: () => ({ record: enroll([LABEL.feature, LABEL.fix]), facts: facts([LABEL.feature, LABEL.fix]) }),
    status: 'Label conflict',
    group: 'Backlog',
    actions: ['engineer', 'close'],
  },
  {
    scenario: 'investigating',
    build: () => ({ record: triagingRecord(), facts: facts([LABEL.triage]) }),
    status: 'Investigating',
    group: 'Triage',
    actions: ['engineer', 'close'],
  },
  {
    scenario: 'waiting for a reply',
    build: () => ({
      record: event(triagingRecord(), { type: 'question-asked', question: { id: 'q1', summary: 'Which OS?' } }),
      facts: facts([LABEL.triage]),
    }),
    status: 'Waiting for a reply',
    group: 'Triage',
    actions: ['reply', 'engineer', 'close'],
  },
  {
    scenario: 'triaged',
    build: () => ({
      record: event(triagingRecord(), { type: 'triage-completed', findings: findings() }),
      facts: facts([LABEL.triage]),
    }),
    status: 'Needs a decision',
    group: 'Triage',
    actions: ['fix', 'engineer', 'close'],
  },
  {
    scenario: 'fixing',
    build: () => ({ record: fixingRecord(), facts: facts([LABEL.fix]) }),
    status: 'Fixing',
    group: 'Fix',
    actions: ['engineer', 'close'],
  },
  {
    scenario: 'verifying an open PR',
    build: () => ({ record: verifyingRecord(), facts: openPr([LABEL.fix]) }),
    status: 'Verifying',
    group: 'Fix',
    actions: ['engineer', 'close'],
  },
  {
    scenario: 'current head verified, PR open',
    build: () => ({ record: ready(), facts: openPr([LABEL.fix]) }),
    status: 'Ready to merge',
    group: 'Fix',
    actions: ['merge', 'engineer', 'close'],
  },
  {
    scenario: 'merged PR, issue still open',
    build: () => ({ record: event(ready(), { type: 'pr-merged', prNumber: 7, mergeCommitSha: MERGE_SHA }), facts: mergedPr('open') }),
    status: 'Merged',
    group: 'Merged',
    actions: ['close'],
  },
  {
    scenario: 'merged PR, issue closed',
    build: () => ({ record: event(ready(), { type: 'pr-merged', prNumber: 7, mergeCommitSha: MERGE_SHA }), facts: mergedPr('closed') }),
    status: 'Merged',
    group: 'Merged',
    actions: [],
  },
  {
    scenario: 'with an engineer',
    build: () => ({ record: enroll([LABEL.engineer]), facts: facts([LABEL.engineer]) }),
    status: 'Needs an engineer',
    group: 'Backlog',
    actions: ['triage', 'fix', 'close'],
  },
  {
    scenario: 'closed',
    build: () => ({
      record: event(enroll([LABEL.triage]), { type: 'issue-closed' }),
      facts: facts([LABEL.triage], { state: 'closed' }),
    }),
    status: 'Closed',
    group: 'Backlog',
    actions: [],
  },
];

describe('state/action table', () => {
  for (const row of TABLE) {
    it(`${row.scenario}: ${row.status} in ${row.group} offering [${row.actions.join(', ')}]`, () => {
      const { record, facts: githubFacts } = row.build();
      const view = presentBug(record, githubFacts, LABEL);
      assert.equal(view.statusLabel, row.status);
      assert.equal(view.group, row.group);
      assert.deepEqual(view.actions, row.actions);
    });

    it(`${row.scenario}: applyAction accepts exactly the offered actions`, () => {
      const { record, facts: githubFacts } = row.build();
      for (const name of ACTION_NAMES) {
        const snapshot = structuredClone(record);
        const result = act(record, githubFacts, { name, actor: 'ana', answer: 'An answer' });
        const offered = row.actions.includes(name);
        if (offered) {
          assert.ok(result.ok, `${name} should be accepted: ${result.ok ? '' : result.error.message}`);
        } else {
          assert.ok(!result.ok && result.error.code === 'action-not-permitted', `${name} should be refused`);
        }
        assert.deepEqual(record, snapshot, 'applyAction never mutates its input');
      }
    });
  }

  it('covers every overview group and never labels a mere open PR as fixed', () => {
    const groups = new Set(TABLE.map((row) => row.group));
    assert.deepEqual([...groups].sort(), ['Backlog', 'Fix', 'Merged', 'Triage']);
    for (const row of TABLE) {
      const { record, facts: githubFacts } = row.build();
      assert.doesNotMatch(presentBug(record, githubFacts, LABEL).statusLabel, /\bfixed\b/i);
    }
  });

  it('exposes recorded policy, Review, CI, required-status and blocker evidence for the current head only', () => {
    assert.deepEqual(presentBug(undefined, facts(['bug']), LABEL).automation, {
      decision: null,
      review: null,
      resolvedFindings: 0,
      merge: null,
      ci: null,
      requiredVerification: null,
      ready: null,
      blockers: [],
    });
    const at = '2026-01-01T00:00:00.000Z';
    let record = event(ready(), {
      type: 'review-recorded',
      review: {
        rounds: [{ prNumber: 7, headSha: HEAD_A, status: 'unavailable', requestedAt: at, completedAt: at, detail: 'forbidden', findings: [], correctionSentAt: null, blocker: null }],
        resolutions: [],
      },
    });
    record = event(record, {
      type: 'policy-evaluated',
      evaluation: {
        kind: 'merge',
        policy: 'rule',
        rule: 'merge-rule',
        subject: HEAD_A,
        outcome: 'wait',
        reproduction: null,
        at,
        checks: [
          { name: 'ci', ok: false, blocking: true, detail: 'CI is pending' },
          { name: 'branch-protection', ok: false, blocking: false, detail: 'main does not require bug-smasher/verification' },
        ],
      },
    });
    const shown = presentBug(record, openPr([LABEL.fix]), LABEL).automation;
    assert.equal(shown.review?.status, 'unavailable');
    assert.equal(shown.merge?.outcome, 'wait');
    assert.equal(shown.ci?.detail, 'CI is pending');
    assert.equal(shown.requiredVerification?.ok, false);
    assert.deepEqual(shown.blockers, ['CI is pending']);
    const moved = event(record, { type: 'head-changed', prNumber: 7, headSha: 'f'.repeat(40) });
    const later = presentBug(moved, facts([LABEL.fix], { pullRequest: { number: 7, state: 'open', headSha: 'f'.repeat(40) } }), LABEL).automation;
    assert.equal(later.merge, null, 'an older head\'s evaluation is not current');
    assert.equal(later.review, null);
  });

  it('derives presentation without persisting display strings', () => {
    const record = ready();
    const serialized = JSON.stringify(record);
    for (const row of TABLE) assert.ok(!serialized.includes(row.status), `record must not store "${row.status}"`);
  });
});
