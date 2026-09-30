import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BugRecord, DiffFinding, ReviewRound } from '../src/model/types.ts';
import { VERIFICATION_STATUS_CONTEXT, type PolicyOutcome, type Reproducer, type ReproductionRequest } from '../src/orchestrator/contracts.ts';
import {
  decisionPolicy,
  evaluateCi,
  evaluateMerge,
  requiredStatus,
  type CiSummary,
  type MergeFacts,
  type ReviewGate,
} from '../src/orchestrator/policies.ts';
import type { Branch, CheckRun, CheckRuns, CombinedStatus, CommitStatus, TrackerIssue, TrackerPullRequest } from '../src/tracker/types.ts';
import { attempt, event, findings, HEAD_A, HEAD_B, LABEL, triagingRecord, verifyingRecord } from './helpers/model.ts';

const MAIN_SHA = 'd'.repeat(40);

function triaged(overrides: Parameters<typeof findings>[0] = {}): BugRecord {
  return event(triagingRecord(), { type: 'triage-completed', findings: findings(overrides) });
}

function issue(labels: string[]): TrackerIssue {
  return {
    number: 42,
    key: 'acme/widgets#42',
    title: 'Crash',
    body: '',
    state: 'open',
    stateReason: null,
    labels,
    author: { login: 'reporter', type: 'user' },
    url: 'https://github.com/acme/widgets/issues/42',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
  };
}

class FixedReproducer implements Reproducer {
  readonly live = true;
  readonly calls: ReproductionRequest[] = [];
  readonly #outcome: 'reproduced' | 'not-reproduced' | 'unknown' | 'unavailable';
  constructor(outcome: 'reproduced' | 'not-reproduced' | 'unknown' | 'unavailable') {
    this.#outcome = outcome;
  }
  async reproduce(request: ReproductionRequest) {
    this.calls.push(request);
    if (this.#outcome === 'unavailable') return { status: 'unavailable' as const, reason: 'runner offline' };
    return {
      status: 'completed' as const,
      check: { sha: request.sha, testFile: request.testFile, outcome: this.#outcome, reason: `test ${this.#outcome}`, at: '2026-01-01T00:00:00.000Z', runs: [] },
    };
  }
}

const MAIN: Branch = { name: 'main', sha: MAIN_SHA, protected: false, requiredChecks: [] };

function rule(reproducer: Reproducer | null, ruleClasses: string[] = ['crash']) {
  return decisionPolicy('rule', { labels: LABEL, ruleClasses, reproducer, defaultBranch: async () => MAIN });
}

describe('Rule decision', () => {
  it('fixes when Devin recommends a fix, every class label is allowed and the proposed test fails on the default branch', async () => {
    const reproducer = new FixedReproducer('reproduced');
    const outcome = await rule(reproducer).decide({ record: triaged(), issue: issue([LABEL.triage, 'Crash']) });
    assert.equal(outcome.status, 'decided');
    if (outcome.status !== 'decided') return;
    assert.equal(outcome.action, 'fix');
    assert.equal(outcome.rule, 'decision-rule');
    assert.deepEqual(outcome.evaluation?.checks.map((check) => [check.name, check.ok]), [
      ['recommendation', true],
      ['classes', true],
      ['reproduction', true],
    ]);
    assert.equal(outcome.evaluation?.reproduction?.sha, MAIN_SHA);
    assert.deepEqual(reproducer.calls.map((call) => [call.sha, call.testFile]), [[MAIN_SHA, 'test/save.test.ts']]);
    assert.ok(outcome.reasons.some((reason) => /Reproduced independently/.test(reason)));
  });

  const waits: [string, () => Promise<PolicyOutcome>, RegExp][] = [
    ['Devin recommends something other than a fix', () => rule(new FixedReproducer('reproduced')).decide({ record: triaged({ recommendation: 'needs_engineer' }), issue: issue(['crash']) }), /recommends needs_engineer/],
    ['the proposed test passes on current code', () => rule(new FixedReproducer('not-reproduced')).decide({ record: triaged(), issue: issue(['crash']) }), /Not reproduced/],
    ['the reproduction result is unknown', () => rule(new FixedReproducer('unknown')).decide({ record: triaged(), issue: issue(['crash']) }), /Reproduction unknown/],
    ['the verifier cannot run the test', () => rule(new FixedReproducer('unavailable')).decide({ record: triaged(), issue: issue(['crash']) }), /Reproduction unknown: runner offline/],
    ['no reproducer is configured', () => rule(null).decide({ record: triaged(), issue: issue(['crash']) }), /No independent verifier/],
    ['a class label is not on the list', () => rule(new FixedReproducer('reproduced')).decide({ record: triaged(), issue: issue(['crash', 'security']) }), /not in DECISION_RULE_CLASSES: security/],
    ['the issue has no class label', () => rule(new FixedReproducer('reproduced')).decide({ record: triaged(), issue: issue([LABEL.triage]) }), /no class label/],
    ['the class list is empty (the default)', () => rule(new FixedReproducer('reproduced'), []).decide({ record: triaged(), issue: issue(['crash']) }), /DECISION_RULE_CLASSES is empty/],
  ];
  for (const [name, run, reason] of waits) {
    it(`waits for a person when ${name}`, async () => {
      const outcome = await run();
      assert.equal(outcome.status, 'wait');
      if (outcome.status !== 'wait') return;
      assert.match(outcome.reason, reason);
      assert.equal(outcome.evaluation?.outcome, 'wait');
      assert.equal(outcome.evaluation?.rule, 'decision-rule');
    });
  }

  it('does not run the proposed test when another condition already fails, and reuses a result for the same commit', async () => {
    const reproducer = new FixedReproducer('not-reproduced');
    await rule(reproducer).decide({ record: triaged({ recommendation: 'close' }), issue: issue(['crash']) });
    assert.equal(reproducer.calls.length, 0);
    const record = triaged();
    const first = await rule(reproducer).decide({ record, issue: issue(['crash']) });
    assert.equal(first.status, 'wait');
    if (first.status !== 'wait' || first.evaluation === null) return;
    const withEvidence = event(record, { type: 'policy-evaluated', evaluation: first.evaluation });
    await rule(reproducer).decide({ record: withEvidence, issue: issue(['crash']) });
    assert.equal(reproducer.calls.length, 1, 'the same default-branch commit is not reproduced twice');
  });

  it('passes proposed test code to the reproducer when triage gave it', async () => {
    const reproducer = new FixedReproducer('reproduced');
    const record = triaged({ proposedTest: { description: 'd', file: 'test/new.test.ts', command: 'npm test', code: 'test code' } });
    await rule(reproducer).decide({ record, issue: issue(['crash']) });
    assert.deepEqual(reproducer.calls.map((call) => [call.testFile, call.testCode]), [['test/new.test.ts', 'test code']]);
  });
});

describe('Automatic decision', () => {
  const auto = decisionPolicy('auto', { labels: LABEL, ruleClasses: [], reproducer: null, defaultBranch: async () => MAIN });

  it('applies a fix or engineer recommendation with its rule', async () => {
    for (const [recommendation, action] of [['devin_fix', 'fix'], ['needs_engineer', 'engineer']] as const) {
      const outcome = await auto.decide({ record: triaged({ recommendation }), issue: issue([]) });
      assert.equal(outcome.status, 'decided');
      if (outcome.status !== 'decided') return;
      assert.equal(outcome.action, action);
      assert.equal(outcome.rule, 'decision-auto');
      assert.equal(outcome.evaluation?.outcome, action);
    }
  });

  it('waits for a person on a close recommendation', async () => {
    const outcome = await auto.decide({ record: triaged({ recommendation: 'close' }), issue: issue([]) });
    assert.equal(outcome.status, 'wait');
    if (outcome.status === 'wait') assert.match(outcome.reason, /closing is always a person's decision/);
  });

  it('is not built for Person', () => {
    assert.equal(decisionPolicy('person', { labels: LABEL, ruleClasses: ['x'], reproducer: null, defaultBranch: async () => MAIN }).live, false);
  });
});

function run(name: string, status: string, conclusion: string | null): CheckRun {
  return { id: name, name, status, conclusion, app: 'github-actions', url: null, startedAt: null, completedAt: null };
}

function commitStatus(context: string, state: CommitStatus['state']): CommitStatus {
  return { id: context, context, state, description: null, targetUrl: null, creator: null, createdAt: '', updatedAt: '' };
}

function ci(runs: CheckRun[], statuses: CommitStatus[] = [], complete = true): CiSummary {
  const checkRuns: CheckRuns = { runs, complete, totalCount: runs.length };
  const combined: CombinedStatus = { sha: HEAD_A, state: 'success', statuses, complete: true, totalCount: statuses.length };
  return evaluateCi(checkRuns, combined);
}

describe('CI state', () => {
  it('distinguishes green, pending, failing, missing and unknown, ignoring the verification status', () => {
    assert.equal(ci([run('test', 'completed', 'success'), run('lint', 'completed', 'skipped')]).state, 'green');
    assert.equal(ci([run('test', 'in_progress', null)]).state, 'pending');
    assert.equal(ci([], [commitStatus('legacy', 'pending')]).state, 'pending');
    assert.equal(ci([run('test', 'completed', 'failure'), run('lint', 'queued', null)]).state, 'failing');
    assert.equal(ci([run('test', 'completed', 'timed_out')]).state, 'failing');
    assert.equal(ci([], [commitStatus('legacy', 'error')]).state, 'failing');
    assert.equal(ci([]).state, 'missing');
    assert.equal(ci([], [commitStatus(VERIFICATION_STATUS_CONTEXT, 'success')]).state, 'missing', 'the service\'s own status is not CI');
    assert.equal(ci([run('test', 'completed', 'success')], [], false).state, 'unknown');
  });
});

describe('required verification status', () => {
  it('reports the verification status as required, missing or unknown', () => {
    assert.equal(requiredStatus({ name: 'main', sha: MAIN_SHA, protected: true, requiredChecks: [VERIFICATION_STATUS_CONTEXT] }).state, 'required');
    const missing = requiredStatus({ name: 'main', sha: MAIN_SHA, protected: true, requiredChecks: ['ci'] });
    assert.equal(missing.state, 'missing');
    assert.match(missing.detail, /does not require bug-smasher\/verification/);
    assert.equal(requiredStatus({ name: 'main', sha: MAIN_SHA, protected: false, requiredChecks: [] }).state, 'missing');
    assert.equal(requiredStatus({ name: 'main', sha: MAIN_SHA, protected: true, requiredChecks: null }).state, 'unknown');
    assert.equal(requiredStatus(null).state, 'unknown');
  });
});

function pr(lines: number, headSha = HEAD_A): TrackerPullRequest {
  return {
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
    title: 'Fix',
    body: '',
    state: 'open',
    draft: false,
    author: null,
    headSha,
    headRef: 'fix',
    headRepo: 'acme/widgets',
    baseSha: 'c'.repeat(40),
    baseRef: 'main',
    mergeable: true,
    mergeableState: 'clean',
    mergeCommitSha: null,
    mergedBy: null,
    mergedAt: null,
    closedAt: null,
    createdAt: '',
    updatedAt: '',
    changedFiles: 1,
    additions: lines - Math.floor(lines / 2),
    deletions: Math.floor(lines / 2),
  };
}

const DELETION_ONLY: DiffFinding = { check: 'deletion-only', file: '', detail: 'the change only deletes lines' };

function ready(flags: DiffFinding[] = []): BugRecord {
  const passed = attempt('pass', HEAD_A);
  const record = event(verifyingRecord(), { type: 'verification-recorded', attempt: { ...passed, evidence: { runs: [], violations: [], flags } } });
  record.workflow = {
    dispatch: null,
    outbox: [],
    relayedCommentIds: [],
    handledEventIds: [],
    ownLabelChanges: [],
    workQuestion: null,
    notices: [],
    ready: { headSha: HEAD_A, state: 'success', detail: 'Devin is done working on this pull request', at: '2026-01-01T00:00:00.000Z' },
  };
  return record;
}

function round(status: ReviewRound['status'] = 'completed', headSha = HEAD_A): ReviewRound {
  return { prNumber: 7, headSha, status, requestedAt: '', completedAt: '', detail: status === 'unavailable' ? 'forbidden' : null, findings: [], correctionSentAt: null, blocker: null };
}

const GREEN: CiSummary = { state: 'green', detail: 'CI is green' };
const REVIEWED: ReviewGate = { enabled: true, round: round(), unresolved: 0 };

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    record: ready(),
    pr: pr(200),
    ci: GREEN,
    review: REVIEWED,
    protection: { state: 'required', detail: 'required' },
    maxLines: 200,
    ...overrides,
  };
}

function blocked(policy: 'rule' | 'auto', merge: MergeFacts): string[] {
  const result = evaluateMerge(policy, merge, new Date(0));
  return result.checks.filter((check) => check.blocking && !check.ok).map((check) => check.name);
}

describe('merge policies', () => {
  it('Rule merges at exactly MERGE_MAX_LINES when every condition holds', () => {
    const result = evaluateMerge('rule', facts(), new Date(0));
    assert.equal(result.outcome, 'merge');
    assert.equal(result.rule, 'merge-rule');
    assert.equal(result.subject, HEAD_A);
  });

  it('Rule refuses one condition at a time and records why', () => {
    assert.deepEqual(blocked('rule', facts({ record: ready([DELETION_ONLY]) })), ['diff-checks']);
    assert.deepEqual(blocked('rule', facts({ ci: { state: 'missing', detail: 'none' } })), ['ci']);
    assert.deepEqual(blocked('rule', facts({ ci: { state: 'pending', detail: 'pending' } })), ['ci']);
    assert.deepEqual(blocked('rule', facts({ ci: { state: 'failing', detail: 'failing' } })), ['ci']);
    assert.deepEqual(blocked('rule', facts({ review: { ...REVIEWED, unresolved: 1 } })), ['review']);
    assert.deepEqual(blocked('rule', facts({ pr: pr(201) })), ['size']);
    const older = event(ready(), { type: 'head-changed', prNumber: 7, headSha: HEAD_B });
    assert.deepEqual(blocked('rule', facts({ record: older, pr: pr(200, HEAD_B), review: { ...REVIEWED, round: round('completed', HEAD_B) } })), ['verification', 'ready', 'diff-checks']);
  });

  it('Rule never treats an unavailable, pending, missing or disabled Review as passed', () => {
    assert.deepEqual(blocked('rule', facts({ review: { enabled: true, round: round('unavailable'), unresolved: null } })), ['review']);
    assert.deepEqual(blocked('rule', facts({ review: { enabled: true, round: round('pending'), unresolved: null } })), ['review']);
    assert.deepEqual(blocked('rule', facts({ review: { enabled: true, round: null, unresolved: null } })), ['review']);
    assert.deepEqual(blocked('rule', facts({ review: { enabled: false, round: null, unresolved: null } })), ['review']);
  });

  it('Automatic merges with a deletion-only flag, unresolved Review and a large change, but not with CI pending or failing', () => {
    const merge = facts({ record: ready([DELETION_ONLY]), review: { enabled: true, round: null, unresolved: null }, pr: pr(5000) });
    const result = evaluateMerge('auto', merge, new Date(0));
    assert.equal(result.outcome, 'merge');
    assert.equal(result.rule, 'merge-auto');
    assert.ok(result.checks.some((check) => check.name === 'diff-checks' && !check.blocking));
    assert.equal(evaluateMerge('rule', merge, new Date(0)).outcome, 'wait', 'Rule would refuse it');
    assert.deepEqual(blocked('auto', facts({ ci: { state: 'pending', detail: 'p' } })), ['ci']);
    assert.deepEqual(blocked('auto', facts({ ci: { state: 'failing', detail: 'f' } })), ['ci']);
  });

  it('reports missing branch protection without blocking either policy', () => {
    const result = evaluateMerge('rule', facts({ protection: requiredStatus({ name: 'main', sha: MAIN_SHA, protected: false, requiredChecks: [] }) }), new Date(0));
    assert.equal(result.outcome, 'merge');
    const protection = result.checks.find((check) => check.name === 'branch-protection');
    assert.equal(protection?.ok, false);
    assert.equal(protection?.blocking, false);
  });
});
