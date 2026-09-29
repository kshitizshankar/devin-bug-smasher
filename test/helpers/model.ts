import assert from 'node:assert/strict';
import { loadSettings } from '../../src/config/settings.ts';
import {
  applyAction,
  applyEvent,
  DEFAULT_MAX_VERIFICATION_ERRORS,
  enrollBug,
  type ActionRequest,
  type ModelEvent,
  type ModelOptions,
  type ModelResult,
} from '../../src/model/transitions.ts';
import type { BugRecord, GitHubFacts, SubmittedFix, TriageFindings, VerificationAttempt } from '../../src/model/types.ts';

export const settings = loadSettings({});

export const options: ModelOptions = {
  labels: settings.labels,
  maxFixRetries: settings.maxFixRetries,
  maxVerificationErrors: DEFAULT_MAX_VERIFICATION_ERRORS,
};

export const LABEL = settings.labels;

let tick = 0;
/** Monotonic ISO timestamps so stage history ordering is observable. */
export function now(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
}

export function facts(
  labels: string[] = [],
  overrides: { state?: 'open' | 'closed'; pullRequest?: GitHubFacts['pullRequest'] } = {},
): GitHubFacts {
  return {
    issue: { owner: 'acme', repo: 'widgets', number: 42, state: overrides.state ?? 'open', labels },
    pullRequest: overrides.pullRequest ?? null,
  };
}

export const HEAD_A = 'a'.repeat(40);
export const HEAD_B = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);
export const MERGE_SHA = 'e'.repeat(40);

export function findings(overrides: Partial<TriageFindings> = {}): TriageFindings {
  return {
    title: 'Crash when saving an empty widget',
    summary: 'Saving a widget without a name throws',
    reproductionSteps: ['Open the editor', 'Clear the name', 'Press save'],
    expectedBehavior: 'A validation message',
    actualBehavior: 'TypeError: name is undefined',
    suspectedCause: 'Missing null check in save handler',
    affectedFiles: ['src/save.ts'],
    reproduced: true,
    reproductionNotes: 'Reproduced on main',
    proposedTest: { description: 'Rejects empty names', file: 'test/save.test.ts', command: 'rm -rf / # data only' },
    recommendation: 'devin_fix',
    reason: 'Small, well-understood fix',
    confidence: 'high',
    ...overrides,
  };
}

export function fixInfo(headSha = HEAD_A): SubmittedFix {
  return {
    prNumber: 7,
    prUrl: 'https://github.com/acme/widgets/pull/7',
    headSha,
    testFiles: ['test/save.test.ts'],
    summary: 'Validate the name before saving',
  };
}

export function attempt(
  result: VerificationAttempt['result'],
  headSha = HEAD_A,
  phase: VerificationAttempt['phase'] = 'pre-merge',
): Omit<VerificationAttempt, 'sessionId'> {
  return { phase, baseSha: BASE, headSha, result, reason: `verification ${result}`, outputTail: '...tail', at: now() };
}

export function expectOk(result: ModelResult): Extract<ModelResult, { ok: true }> {
  if (!result.ok) assert.fail(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result;
}

export function expectError(result: ModelResult, code: string): void {
  assert.equal(result.ok, false, 'expected the transition to be rejected');
  if (!result.ok) assert.equal(result.error.code, code, result.error.message);
}

export function enroll(labels: string[]): BugRecord {
  return expectOk(enrollBug(facts(labels), options, now())).record;
}

export function event(record: BugRecord, modelEvent: ModelEvent): BugRecord {
  return expectOk(applyEvent(record, modelEvent, options, now())).record;
}

export function act(record: BugRecord | undefined, githubFacts: GitHubFacts, request: ActionRequest): ModelResult {
  return applyAction(record, githubFacts, request, options, now());
}

/** Drives a record to `fixing` with an active fix session. */
export function fixingRecord(sessionId = 'session-fix'): BugRecord {
  const queued = enroll([LABEL.fix]);
  return event(queued, {
    type: 'session-started',
    session: { id: sessionId, url: `https://app.devin.ai/sessions/${sessionId}` },
    issueState: 'open',
    labels: [LABEL.fix],
  });
}

/** Drives a record to `verifying` for PR #7 at HEAD_A. */
export function verifyingRecord(): BugRecord {
  return event(fixingRecord(), { type: 'fix-submitted', fix: fixInfo(HEAD_A) });
}

/** Drives a record to `triaging` with an active triage session. */
export function triagingRecord(): BugRecord {
  const queued = enroll([LABEL.triage]);
  return event(queued, {
    type: 'session-started',
    session: { id: 'session-triage', url: 'https://app.devin.ai/sessions/session-triage' },
    issueState: 'open',
    labels: [LABEL.triage],
  });
}
