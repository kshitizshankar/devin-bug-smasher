import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { interpretStructuredOutput, questionId } from '../src/devin/structured-output.ts';
import { fixSubmittedEvent, parseSession, structuredOutputEvents, type DevinSession } from '../src/devin/sessions.ts';
import { COMPLETE_TRIAGE, HEAD_SHA, PR_URL } from './helpers/devin.ts';
import { event, fixingRecord, triagingRecord } from './helpers/model.ts';

const SESSION = 'devin-abc';

function session(structuredOutput: unknown): DevinSession {
  const parsed = parseSession({
    session_id: SESSION,
    url: 'https://app.devin.ai/sessions/abc',
    status: 'running',
    status_detail: 'finished',
    tags: [],
    org_id: 'org-1',
    created_at: 1790000000,
    updated_at: 1790000100,
    acus_consumed: 1,
    pull_requests: [],
    structured_output: structuredOutput,
  });
  assert.ok('session' in parsed);
  return parsed.session;
}

describe('structured output validation', () => {
  it('treats missing output as absent', () => {
    assert.deepEqual(interpretStructuredOutput(SESSION, null), { status: 'absent' });
    assert.deepEqual(interpretStructuredOutput(SESSION, undefined), { status: 'absent' });
    assert.deepEqual(structuredOutputEvents(session(null)), []);
  });

  it('rejects malformed output with specific problems', () => {
    const cases: [unknown, RegExp][] = [
      ['triage_complete', /must be an object/],
      [{ status: 'triage_complete' }, /phase must be one of/],
      [{ phase: 'triage', status: 'done' }, /status must be one of/],
      [{ ...COMPLETE_TRIAGE, reproduced: 'yes' }, /reproduced must be a boolean/],
      [{ ...COMPLETE_TRIAGE, bucket: 'ship_it' }, /bucket must be one of/],
      [{ ...COMPLETE_TRIAGE, affected_files: 'src/a.ts' }, /affected_files must be an array of strings/],
      [{ ...COMPLETE_TRIAGE, proposed_check: { command: 42 } }, /proposed_check.command must be a string/],
      [{ ...COMPLETE_TRIAGE, phase: 'fix' }, /triage_complete requires phase triage/],
      [{ phase: 'triage', status: 'pr_opened', pr_url: PR_URL, fix_summary: 's' }, /pr_opened requires phase fix/],
    ];
    for (const [raw, pattern] of cases) {
      const result = interpretStructuredOutput(SESSION, raw);
      assert.equal(result.status, 'invalid', JSON.stringify(raw));
      assert.ok(result.status === 'invalid');
      assert.match(result.problems.join('; '), pattern);
      assert.deepEqual(structuredOutputEvents(session(raw)), []);
    }
  });

  it('keeps partial triage output incomplete and lists what is missing', () => {
    const { bucket: _bucket, proposed_check: _check, ...partial } = COMPLETE_TRIAGE;
    const result = interpretStructuredOutput(SESSION, partial);
    assert.equal(result.status, 'incomplete');
    assert.ok(result.status === 'incomplete');
    assert.ok(result.missing.includes('bucket'));
    assert.ok(result.missing.includes('proposed_check'));
    assert.deepEqual(structuredOutputEvents(session(partial)), []);

    const halfCheck = interpretStructuredOutput(SESSION, { ...COMPLETE_TRIAGE, proposed_check: { description: 'd' } });
    assert.ok(halfCheck.status === 'incomplete');
    assert.deepEqual(halfCheck.missing, ['proposed_check.test_file', 'proposed_check.command']);

    const blankTitle = interpretStructuredOutput(SESSION, { ...COMPLETE_TRIAGE, title: '  ' });
    assert.equal(blankTitle.status, 'incomplete');
  });

  it('requires a question for needs_input and blocked', () => {
    for (const status of ['needs_input', 'blocked']) {
      const missing = interpretStructuredOutput(SESSION, { phase: 'triage', status });
      assert.ok(missing.status === 'incomplete');
      assert.deepEqual(missing.missing, ['question']);
      assert.equal(interpretStructuredOutput(SESSION, { phase: 'triage', status, question: '   ' }).status, 'incomplete');
    }
  });

  it('turns a question into a question-asked event with a stable id', () => {
    const raw = { phase: 'triage', status: 'needs_input', question: 'Which browser shows the overlap?' };
    const events = structuredOutputEvents(session(raw));
    const id = questionId(SESSION, 'Which browser shows the overlap?');
    assert.deepEqual(events, [{ type: 'question-asked', question: { id, summary: 'Which browser shows the overlap?' } }]);
    assert.deepEqual(structuredOutputEvents(session(raw)), events, 're-reading yields the same id');
    assert.notEqual(questionId('devin-other', 'Which browser shows the overlap?'), id);
  });

  it('maps complete triage onto model findings the model accepts', () => {
    const events = structuredOutputEvents(session(COMPLETE_TRIAGE));
    assert.equal(events.length, 1);
    const event = events[0];
    assert.ok(event?.type === 'triage-completed');
    assert.deepEqual(event.findings, {
      title: COMPLETE_TRIAGE.title,
      summary: COMPLETE_TRIAGE.summary,
      reproductionSteps: COMPLETE_TRIAGE.steps_to_reproduce,
      expectedBehavior: COMPLETE_TRIAGE.expected,
      actualBehavior: COMPLETE_TRIAGE.actual,
      suspectedCause: COMPLETE_TRIAGE.suspected_cause,
      affectedFiles: COMPLETE_TRIAGE.affected_files,
      reproduced: true,
      reproductionNotes: COMPLETE_TRIAGE.reproduction_notes,
      proposedTest: { description: 'Legend offset accounts for axis', file: 'test/legend.test.ts', command: 'npm test -- test/legend.test.ts' },
      recommendation: 'devin_fix',
      reason: COMPLETE_TRIAGE.bucket_reason,
      confidence: 'high',
    });
  });

  it('requires a GitHub PR URL and summary for pr_opened, and a GitHub head SHA for fix-submitted', () => {
    const incomplete = [
      { phase: 'fix', status: 'pr_opened', fix_summary: 'Fixed offset' },
      { phase: 'fix', status: 'pr_opened', pr_url: 'https://github.com/acme/widgets/issues/7', fix_summary: 'Fixed offset' },
      { phase: 'fix', status: 'pr_opened', pr_url: PR_URL },
    ];
    for (const raw of incomplete) {
      assert.equal(interpretStructuredOutput(SESSION, raw).status, 'incomplete', JSON.stringify(raw));
      assert.equal(fixSubmittedEvent(session(raw), HEAD_SHA), null);
    }

    const raw = { phase: 'fix', status: 'pr_opened', pr_url: PR_URL, fix_summary: 'Fixed offset', test_files: ['test/legend.test.ts'] };
    const opened = session(raw);
    assert.deepEqual(structuredOutputEvents(opened), [], 'no fix event without the GitHub head');
    assert.deepEqual(fixSubmittedEvent(opened, HEAD_SHA), {
      type: 'fix-submitted',
      fix: { prNumber: 7, prUrl: PR_URL, headSha: HEAD_SHA, testFiles: ['test/legend.test.ts'], summary: 'Fixed offset' },
    });
  });

  it('produces events the shared model applies', () => {
    const triaging = triagingRecord();
    const asked = session({ phase: 'triage', status: 'needs_input', question: 'Which browser?' });
    const [question] = structuredOutputEvents(asked);
    assert.ok(question);
    const waiting = event(triaging, question);
    assert.equal(waiting.stage, 'needs-input');

    const [triaged] = structuredOutputEvents(session(COMPLETE_TRIAGE));
    assert.ok(triaged);
    assert.equal(event(triagingRecord(), triaged).stage, 'triaged');

    const opened = session({ phase: 'fix', status: 'pr_opened', pr_url: PR_URL, fix_summary: 'Fixed offset' });
    const fix = fixSubmittedEvent(opened, HEAD_SHA);
    assert.ok(fix);
    assert.equal(event(fixingRecord(), fix).stage, 'verifying');
  });
});
