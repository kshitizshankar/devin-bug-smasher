import type { LabelSettings } from '../config/settings.ts';
import { formatBugKey } from './keys.ts';
import { intakeEligibility, resolveLabels } from './labels.ts';
import { currentMergeVerifications, mergedFixHandedOff, outstandingQuestion, presentBug } from './presentation.ts';
import type {
  ActionName,
  BugRecord,
  FixInfo,
  SubmittedFix,
  GitHubFacts,
  HandoffReason,
  PolicyEvaluation,
  ReviewRecord,
  SessionInsights,
  SessionLiveState,
  Stage,
  Timestamp,
  TriageFindings,
  VerificationAttempt,
  WorkRoute,
} from './types.ts';
import {
  validateBugRecord,
  validateFixInfo,
  validatePolicyEvaluation,
  validateReviewRecord,
  validateSessionInsights,
  validateTriageFindings,
  validateVerificationAttempt,
} from './validate.ts';

export interface ModelOptions {
  labels: LabelSettings;
  /** Failed-proof retries allowed per fix session before handoff (`MAX_FIX_RETRIES`, default 1). */
  maxFixRetries: number;
  /** Verification infrastructure errors per fix session that trigger handoff (default 3). */
  maxVerificationErrors: number;
}

export const DEFAULT_MAX_VERIFICATION_ERRORS = 3;

/** Side effects a future adapter should apply, in order. The model never performs them itself. */
export type Effect =
  | { type: 'add-label'; label: string }
  | { type: 'remove-label'; label: string }
  | { type: 'close-issue' }
  | { type: 'stop-session'; sessionId: string }
  | { type: 'continue-session'; sessionId: string; route: WorkRoute }
  | { type: 'post-comment'; body: string }
  | { type: 'merge-pr'; prNumber: number; expectedHeadSha: string };

export interface ModelError {
  code:
    | 'not-eligible'
    | 'issue-closed'
    | 'invalid-stage'
    | 'label-mismatch'
    | 'label-conflict'
    | 'session-active'
    | 'unknown-pr'
    | 'unknown-question'
    | 'duplicate-question'
    | 'invalid-data'
    | 'stale-head'
    | 'no-fix'
    | 'already-merged'
    | 'action-not-permitted'
    | 'missing-answer';
  message: string;
}

export type ModelResult =
  | { ok: true; record: BugRecord; changed: boolean; effects: Effect[] }
  | { ok: false; error: ModelError };

/** Facts and outcomes observed from GitHub, Devin or verification, expressed as model events. */
export type ModelEvent =
  | { type: 'labels-changed'; labels: string[] }
  | {
      type: 'session-started';
      session: { id: string; url: string };
      issueState: 'open' | 'closed';
      labels: string[];
    }
  | { type: 'session-status'; sessionId: string; liveState: SessionLiveState }
  | { type: 'question-asked'; question: { id: string; summary: string } }
  | { type: 'reply-received'; questionId: string }
  | { type: 'triage-completed'; findings: TriageFindings }
  | { type: 'fix-submitted'; fix: SubmittedFix }
  | { type: 'head-changed'; prNumber: number; headSha: string }
  | { type: 'verification-recorded'; attempt: Omit<VerificationAttempt, 'sessionId'> }
  /** `mergedBy` is the merging actor (`github:<login>`) and `mergedAt` the merge time, as GitHub reports them. */
  | { type: 'pr-merged'; prNumber: number; mergeCommitSha: string; mergedBy?: string | null; mergedAt?: Timestamp | null }
  | { type: 'pr-closed'; prNumber: number }
  | { type: 'issue-closed' }
  | { type: 'issue-reopened'; labels: string[] }
  | { type: 'insights-recorded'; insights: SessionInsights }
  /** Replaces the Devin Review evidence for the current fix; it never changes the stage. */
  | { type: 'review-recorded'; review: ReviewRecord }
  /** Appends a Rule or Automatic policy evaluation; acting on it is a separate action. */
  | { type: 'policy-evaluated'; evaluation: PolicyEvaluation }
  /** The orchestrator found a reason work must not start or continue automatically, e.g. an existing PR. */
  | { type: 'handoff-requested'; reason: 'existing-pr' | 'session-suspended' | 'verification-error'; detail: string };

export interface ActionRequest {
  name: ActionName;
  actor: string;
  /** Added context, e.g. when returning a handoff to investigation or repair. */
  context?: string;
  /** Required for `reply`. */
  answer?: string;
}

const ACTIVE_WORK_STAGES: readonly Stage[] = ['triaging', 'needs-input', 'fixing'];
const CANCELLABLE_FIX_STAGES: readonly Stage[] = ['fixing', 'verifying', 'ready-to-merge'];

function fail(code: ModelError['code'], message: string): ModelResult {
  return { ok: false, error: { code, message } };
}

function unchanged(record: BugRecord): ModelResult {
  return { ok: true, record, changed: false, effects: [] };
}

function done(record: BugRecord, now: Timestamp, effects: Effect[] = []): ModelResult {
  record.updatedAt = now;
  return { ok: true, record, changed: true, effects };
}

function moveTo(record: BugRecord, stage: Stage, now: Timestamp): void {
  if (record.stage === stage) return;
  record.stage = stage;
  record.stageHistory.push({ stage, at: now });
}

function sessionRunning(record: BugRecord): boolean {
  return record.session !== null && record.session.liveState !== 'ended' && record.session.stopRequestedAt === null;
}

/** Requests a stop for a running session once, recording why; later calls emit nothing. */
function stopSessionEffects(record: BugRecord, now: Timestamp, reason: string): Effect[] {
  if (record.session === null || !sessionRunning(record)) return [];
  record.session.stopRequestedAt = now;
  record.session.stopReason = reason;
  return [{ type: 'stop-session', sessionId: record.session.id }];
}

/**
 * Hands work to an engineer and stops any running session. Automatic handoffs also move the issue to the
 * engineer label; a person's `engineer` action moves labels itself, and `engineer-label` is already there.
 */
function handOff(
  record: BugRecord,
  reason: HandoffReason,
  detail: string | null,
  options: ModelOptions,
  now: Timestamp,
): Effect[] {
  const { triage, fix, feature, engineer } = options.labels;
  const labelEffects: Effect[] =
    reason === 'engineer-label' || reason === 'person'
      ? []
      : [
          { type: 'add-label', label: engineer },
          ...[triage, fix, feature].map((label): Effect => ({ type: 'remove-label', label })),
        ];
  const effects = [...labelEffects, ...stopSessionEffects(record, now, reason)];
  moveTo(record, 'with-engineer', now);
  record.route = null;
  record.handoff = { reason, detail, at: now, engineerLabelSeen: reason === 'engineer-label' };
  return effects;
}

/** Moves the current fix PR to history when work restarts, so a closed or merged old PR no longer applies. */
function archiveFix(record: BugRecord): void {
  if (record.fix === null) return;
  record.priorFixes.push(record.fix);
  record.fix = null;
}

function newRecord(facts: GitHubFacts, now: Timestamp): BugRecord {
  return {
    key: formatBugKey({ owner: facts.issue.owner, repo: facts.issue.repo, number: facts.issue.number }),
    kind: 'bug',
    stage: 'queued',
    route: null,
    session: null,
    triage: null,
    fix: null,
    priorFixes: [],
    verifications: [],
    decisions: [],
    questions: [],
    stageHistory: [{ stage: 'queued', at: now }],
    handoff: null,
    insights: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Continues a live investigation session into repair: the record moves straight to `fixing` with the same
 * session, and the adapter is told to instruct it. Returns null when there is no live investigation session.
 */
function continueIntoRepair(record: BugRecord, now: Timestamp): Effect[] | null {
  const session = record.session;
  if (record.stage !== 'triaged' || session === null || session.route !== 'triage' || !sessionRunning(record)) {
    return null;
  }
  session.route = 'fix';
  session.updatedAt = now;
  record.route = 'fix';
  moveTo(record, 'fixing', now);
  return [{ type: 'continue-session', sessionId: session.id, route: 'fix' }];
}

/**
 * Applies a label route to a record that is queued, triaged or with an engineer. Returns the effects when
 * the record changed, or null when the labels change nothing.
 */
function routeFromLabels(record: BugRecord, labels: string[], options: ModelOptions, now: Timestamp): Effect[] | null {
  const { route, conflict } = resolveLabels(labels, options.labels);
  if (conflict !== null || route === null || route === 'engineer') return null;
  const workRoute: WorkRoute = route === 'triage' ? 'triage' : 'fix';
  const kind = route === 'feature' ? 'feature' : 'bug';

  if (record.stage === 'with-engineer' || (record.stage === 'queued' && record.route === null)) {
    if (record.stage === 'with-engineer') archiveFix(record);
    record.kind = kind;
    record.route = workRoute;
    moveTo(record, 'queued', now);
    return [];
  }
  // A queued or triaged record is only upgraded to repair; a triage-only snapshot never downgrades
  // queued repair (it may be stale while the adapter is moving labels). Use the `triage` action instead.
  if ((record.stage === 'queued' || record.stage === 'triaged') && workRoute === 'fix') {
    if (record.stage === 'queued' && record.route === 'fix' && record.kind === kind) return null;
    record.kind = kind;
    const continued = continueIntoRepair(record, now);
    if (continued !== null) return continued;
    record.route = 'fix';
    moveTo(record, 'queued', now);
    return [];
  }
  return null;
}

/**
 * Stops a running or merge-ready fix whose labels no longer request it: without workflow labels the record
 * returns to an unrouted `queued`; relabelled for investigation it is queued for triage. Returns null otherwise.
 */
function cancelFromLabels(record: BugRecord, labels: string[], options: ModelOptions, now: Timestamp): Effect[] | null {
  if (!CANCELLABLE_FIX_STAGES.includes(record.stage)) return null;
  const { route, conflict } = resolveLabels(labels, options.labels);
  if (conflict !== null || (route !== null && route !== 'triage')) return null;
  const effects = stopSessionEffects(record, now, route === null ? 'labels-removed' : 'returned-to-triage');
  archiveFix(record);
  if (route === 'triage') record.kind = 'bug';
  record.route = route;
  moveTo(record, 'queued', now);
  return effects;
}

/**
 * Classifies a PR event: `current` for the recorded fix PR, `stale` for an earlier fix PR (to be ignored),
 * otherwise a failure result.
 */
function prEventTarget(record: BugRecord, prNumber: number): 'current' | 'stale' | ModelResult {
  if (record.fix !== null && record.fix.prNumber === prNumber) return 'current';
  if (record.priorFixes.some((fix) => fix.prNumber === prNumber)) return 'stale';
  if (record.fix === null && record.priorFixes.length === 0) return fail('no-fix', 'No fix PR is recorded');
  return fail('unknown-pr', `PR #${prNumber} is not a recorded fix PR`);
}

/**
 * Enrolls an issue that has no stored record. Refused for unlabelled issues (not eligible) and for closed
 * issues (no work may run). Engineer-labelled issues are enrolled directly with an engineer.
 */
export function enrollBug(facts: GitHubFacts, options: ModelOptions, now: Timestamp): ModelResult {
  const eligibility = intakeEligibility(undefined, facts.issue.labels, options.labels);
  if (!eligibility.eligible) return fail('not-eligible', eligibility.reason);
  if (facts.issue.state === 'closed') return fail('issue-closed', 'Closed issues are not enrolled');

  const record = newRecord(facts, now);
  const { route } = resolveLabels(facts.issue.labels, options.labels);
  if (route === 'engineer') {
    handOff(record, 'engineer-label', null, options, now);
  } else {
    routeFromLabels(record, facts.issue.labels, options, now);
  }
  return { ok: true, record, changed: true, effects: [] };
}

export function countSessionAttempts(record: BugRecord, result: VerificationAttempt['result']): number {
  const sessionId = record.session?.id ?? null;
  return record.verifications.filter(
    (attempt) => attempt.phase === 'pre-merge' && attempt.sessionId === sessionId && attempt.result === result,
  ).length;
}

/**
 * Pure transition function. Returns a new record for valid events; invalid events return an error and the
 * input record is never modified. An event is refused (`invalid-data`) if the resulting record would not
 * pass `validateBugRecord`, so every accepted event can be persisted.
 */
export function applyEvent(
  current: BugRecord,
  event: ModelEvent,
  options: ModelOptions,
  now: Timestamp,
): ModelResult {
  const result = transition(current, event, options, now);
  if (!result.ok || !result.changed) return result;
  const problems = validateBugRecord(result.record);
  return problems.length > 0 ? fail('invalid-data', problems.join('; ')) : result;
}

function transition(current: BugRecord, event: ModelEvent, options: ModelOptions, now: Timestamp): ModelResult {
  const record = structuredClone(current);

  switch (event.type) {
    case 'labels-changed': {
      if (record.stage === 'closed' || record.stage === 'merged') return unchanged(current);
      const { route } = resolveLabels(event.labels, options.labels);
      if (route === 'engineer') {
        if (record.stage !== 'with-engineer') {
          return done(record, now, handOff(record, 'engineer-label', null, options, now));
        }
        if (record.handoff === null || record.handoff.engineerLabelSeen) return unchanged(current);
        record.handoff.engineerLabelSeen = true;
        return done(record, now);
      }
      if (record.stage === 'with-engineer' && record.handoff !== null && !record.handoff.engineerLabelSeen) {
        return unchanged(current);
      }
      const effects = cancelFromLabels(record, event.labels, options, now) ?? routeFromLabels(record, event.labels, options, now);
      return effects === null ? unchanged(current) : done(record, now, effects);
    }

    case 'session-started': {
      if (event.issueState === 'closed') return fail('issue-closed', 'Closed issues permit no running work');
      if (record.stage !== 'queued' || record.route === null) {
        return fail('invalid-stage', `A session can only start from a routed queued record (stage ${record.stage})`);
      }
      if (record.session !== null && record.session.liveState !== 'ended') {
        const stopping = record.session.stopRequestedAt === null ? '' : ' (stop requested)';
        return fail(
          'session-active',
          `Session ${record.session.id} is still ${record.session.liveState}${stopping}; wait until it has ended`,
        );
      }
      const labels = resolveLabels(event.labels, options.labels);
      if (labels.conflict !== null) return fail('label-conflict', labels.conflict);
      const expected = record.route === 'triage' ? ['triage'] : [record.kind === 'feature' ? 'feature' : 'fix'];
      if (labels.route === null || !expected.includes(labels.route)) {
        return fail(
          'label-mismatch',
          `Labels request ${labels.route ?? 'no work'} but the record is queued for ${record.route} (${record.kind})`,
        );
      }
      record.session = {
        id: event.session.id,
        url: event.session.url,
        route: record.route,
        liveState: 'starting',
        startedAt: now,
        updatedAt: now,
        stopRequestedAt: null,
      };
      moveTo(record, record.route === 'triage' ? 'triaging' : 'fixing', now);
      return done(record, now);
    }

    case 'session-status': {
      // Statuses from earlier sessions, and any status after `ended` (which is final), are stale.
      if (record.session === null || record.session.id !== event.sessionId) return unchanged(current);
      if (record.session.liveState === 'ended' || record.session.liveState === event.liveState) {
        return unchanged(current);
      }
      record.session.liveState = event.liveState;
      record.session.updatedAt = now;
      if (event.liveState === 'ended' && ACTIVE_WORK_STAGES.includes(record.stage)) {
        return done(record, now, handOff(record, 'session-ended', `Session ended while ${record.stage}`, options, now));
      }
      return done(record, now);
    }

    case 'question-asked': {
      if (record.stage !== 'triaging') {
        return fail('invalid-stage', `Questions can only be asked during investigation (stage ${record.stage})`);
      }
      if (record.questions.some((question) => question.id === event.question.id)) {
        return fail('duplicate-question', `Question ${event.question.id} already exists`);
      }
      record.questions.push({ ...event.question, askedAt: now, answeredAt: null });
      moveTo(record, 'needs-input', now);
      return done(record, now);
    }

    case 'reply-received': {
      const question = record.questions.find((candidate) => candidate.id === event.questionId);
      if (question === undefined) return fail('unknown-question', `Question ${event.questionId} does not exist`);
      if (question.answeredAt !== null) return unchanged(current);
      if (record.stage !== 'needs-input') {
        return fail('invalid-stage', `Replies are only accepted while waiting for input (stage ${record.stage})`);
      }
      question.answeredAt = now;
      if (outstandingQuestion(record) === null) moveTo(record, 'triaging', now);
      return done(record, now);
    }

    case 'triage-completed': {
      if (record.stage !== 'triaging') {
        return fail('invalid-stage', `Triage can only complete during investigation (stage ${record.stage})`);
      }
      const problems = validateTriageFindings(event.findings, 'findings');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      record.triage = structuredClone(event.findings);
      moveTo(record, 'triaged', now);
      return done(record, now);
    }

    case 'fix-submitted': {
      if (record.stage !== 'fixing') {
        return fail('invalid-stage', `A fix can only be submitted while fixing (stage ${record.stage})`);
      }
      const fix: FixInfo = { ...structuredClone(event.fix), mergeCommitSha: null };
      const problems = validateFixInfo(fix, 'fix');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      record.fix = fix;
      moveTo(record, 'verifying', now);
      return done(record, now);
    }

    case 'head-changed': {
      const target = prEventTarget(record, event.prNumber);
      if (target === 'stale') return unchanged(current);
      if (target !== 'current') return target;
      if (record.fix === null) return fail('no-fix', 'No fix PR is recorded');
      if (!['fixing', 'verifying', 'ready-to-merge'].includes(record.stage)) {
        return fail('invalid-stage', `Head changes only apply to an unmerged fix (stage ${record.stage})`);
      }
      if (record.fix.headSha === event.headSha) return unchanged(current);
      record.fix.headSha = event.headSha;
      moveTo(record, 'verifying', now);
      return done(record, now);
    }

    case 'verification-recorded': {
      const attempt: VerificationAttempt = { ...event.attempt, sessionId: record.session?.id ?? null };
      const problems = validateVerificationAttempt(attempt, 'attempt');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));

      if (attempt.phase === 'post-merge') {
        if (record.stage !== 'merged') {
          return fail('invalid-stage', `Post-merge verification requires a merged record (stage ${record.stage})`);
        }
        const mergeCommit = record.fix?.mergeCommitSha ?? null;
        if (attempt.headSha !== mergeCommit) {
          return fail('stale-head', `Post-merge attempt is for ${attempt.headSha} but the merge commit is ${mergeCommit}`);
        }
        record.verifications.push(attempt);
        if (attempt.result === 'fail') {
          return done(record, now, handOff(record, 'post-merge-verification-failed', attempt.reason, options, now));
        }
        if (attempt.result === 'error') {
          const errors = currentMergeVerifications(record).filter((candidate) => candidate.result === 'error').length;
          if (errors >= options.maxVerificationErrors) {
            return done(record, now, handOff(record, 'verification-error', attempt.reason, options, now));
          }
        }
        return done(record, now);
      }

      if (record.stage !== 'verifying' || record.fix === null) {
        return fail('invalid-stage', `Pre-merge verification requires a fix being verified (stage ${record.stage})`);
      }
      if (attempt.headSha !== record.fix.headSha) {
        return fail('stale-head', `Attempt is for ${attempt.headSha} but the PR head is ${record.fix.headSha}`);
      }
      record.verifications.push(attempt);
      if (attempt.result === 'pass') {
        moveTo(record, 'ready-to-merge', now);
        return done(record, now);
      }
      if (attempt.result === 'error') {
        if (countSessionAttempts(record, 'error') >= options.maxVerificationErrors) {
          return done(record, now, handOff(record, 'verification-error', attempt.reason, options, now));
        }
        return done(record, now);
      }
      if (countSessionAttempts(record, 'fail') > options.maxFixRetries) {
        return done(record, now, handOff(record, 'verification-failed', attempt.reason, options, now));
      }
      if (!sessionRunning(record)) {
        return done(record, now, handOff(record, 'session-ended', 'Session ended before retrying a failed proof', options, now));
      }
      moveTo(record, 'fixing', now);
      return done(record, now);
    }

    case 'pr-merged': {
      const target = prEventTarget(record, event.prNumber);
      if (target === 'stale') return unchanged(current);
      if (target !== 'current') return target;
      if (record.fix === null) return fail('no-fix', 'No fix PR is recorded');
      if (record.fix.mergeCommitSha !== null) return fail('already-merged', 'The fix PR was already recorded as merged');
      // `closed` is accepted because GitHub may report the issue closed (e.g. "Closes #N") before the merge.
      if (!['fixing', 'verifying', 'ready-to-merge', 'with-engineer', 'closed'].includes(record.stage)) {
        return fail('invalid-stage', `A merge cannot be recorded in stage ${record.stage}`);
      }
      const merged: FixInfo = {
        ...record.fix,
        mergeCommitSha: event.mergeCommitSha,
        mergedBy: event.mergedBy ?? null,
        mergedAt: event.mergedAt ?? null,
      };
      const problems = validateFixInfo(merged, 'fix');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      record.fix = merged;
      const effects = stopSessionEffects(record, now, 'pr-merged');
      moveTo(record, 'merged', now);
      record.route = null;
      return done(record, now, effects);
    }

    case 'pr-closed': {
      const target = prEventTarget(record, event.prNumber);
      if (target === 'stale') return unchanged(current);
      if (target !== 'current') return target;
      if (!['fixing', 'verifying', 'ready-to-merge'].includes(record.stage)) return unchanged(current);
      return done(record, now, handOff(record, 'pr-closed-unmerged', null, options, now));
    }

    case 'issue-closed': {
      if (record.stage === 'closed' || record.stage === 'merged' || mergedFixHandedOff(record)) {
        return unchanged(current);
      }
      const effects = stopSessionEffects(record, now, 'issue-closed');
      moveTo(record, 'closed', now);
      record.route = null;
      return done(record, now, effects);
    }

    case 'issue-reopened': {
      if (record.stage === 'with-engineer') {
        return transition(current, { type: 'labels-changed', labels: event.labels }, options, now);
      }
      if (record.stage !== 'closed') return unchanged(current);
      const { route } = resolveLabels(event.labels, options.labels);
      if (route === 'engineer') return done(record, now, handOff(record, 'engineer-label', null, options, now));
      archiveFix(record);
      if (record.triage !== null && record.kind === 'bug') {
        moveTo(record, 'triaged', now);
        return done(record, now, routeFromLabels(record, event.labels, options, now) ?? []);
      }
      moveTo(record, 'queued', now);
      routeFromLabels(record, event.labels, options, now);
      return done(record, now);
    }

    case 'insights-recorded': {
      const problems = validateSessionInsights(event.insights, 'insights');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      record.insights = structuredClone(event.insights);
      return done(record, now);
    }

    case 'review-recorded': {
      if (record.fix === null) return fail('no-fix', 'Review evidence needs a fix PR');
      const problems = validateReviewRecord(event.review, 'review');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      if (JSON.stringify(record.review) === JSON.stringify(event.review)) return unchanged(current);
      record.review = structuredClone(event.review);
      return done(record, now);
    }

    case 'policy-evaluated': {
      const problems = validatePolicyEvaluation(event.evaluation, 'evaluation');
      if (problems.length > 0) return fail('invalid-data', problems.join('; '));
      record.evaluations = [...(record.evaluations ?? []), structuredClone(event.evaluation)];
      return done(record, now);
    }

    case 'handoff-requested': {
      if (!['queued', 'triaging', 'needs-input', 'triaged', 'fixing', 'verifying'].includes(record.stage)) {
        return fail('invalid-stage', `Automatic handoff does not apply in stage ${record.stage}`);
      }
      return done(record, now, handOff(record, event.reason, event.detail, options, now));
    }
  }
}

function labelMoveEffects(add: string, facts: GitHubFacts, options: ModelOptions): Effect[] {
  const present = new Set(facts.issue.labels.map((label) => label.toLowerCase()));
  const { triage, fix, engineer, feature } = options.labels;
  const effects: Effect[] = [];
  if (!present.has(add.toLowerCase())) effects.push({ type: 'add-label', label: add });
  for (const label of [triage, fix, engineer, feature]) {
    if (label !== add && present.has(label.toLowerCase())) effects.push({ type: 'remove-label', label });
  }
  return effects;
}

/**
 * Validates and applies a person's action. Permitted actions come from `presentBug`, so the UI and the
 * model can never disagree. `record` may be undefined for an issue that is not yet enrolled.
 */
export function applyAction(
  current: BugRecord | undefined,
  facts: GitHubFacts,
  request: ActionRequest,
  options: ModelOptions,
  now: Timestamp,
): ModelResult {
  const presentation = presentBug(current, facts, options.labels);
  if (!presentation.actions.includes(request.name)) {
    return fail(
      'action-not-permitted',
      `Action ${request.name} is not permitted while ${presentation.statusLabel}` +
        (presentation.actions.length > 0 ? ` (permitted: ${presentation.actions.join(', ')})` : ''),
    );
  }

  const record = current === undefined ? newRecord(facts, now) : structuredClone(current);
  record.kind = presentation.kind;
  const context = request.context?.trim() ? request.context.trim() : null;
  const decide = (outcome: 'applied' | 'requested'): void => {
    record.decisions.push({ action: request.name, outcome, actor: request.actor, at: now, context });
  };

  switch (request.name) {
    case 'triage':
    case 'fix': {
      if (request.name === 'fix') {
        const continued = continueIntoRepair(record, now);
        if (continued !== null) {
          const labelEffects = labelMoveEffects(
            record.kind === 'feature' ? options.labels.feature : options.labels.fix,
            facts,
            options,
          );
          decide('applied');
          return done(record, now, [...labelEffects, ...continued]);
        }
      }
      const effects = [
        ...labelMoveEffects(
          request.name === 'triage'
            ? options.labels.triage
            : record.kind === 'feature'
              ? options.labels.feature
              : options.labels.fix,
          facts,
          options,
        ),
        ...stopSessionEffects(record, now, `person-${request.name}`),
      ];
      archiveFix(record);
      moveTo(record, 'queued', now);
      record.route = request.name;
      decide('applied');
      return done(record, now, effects);
    }

    case 'engineer': {
      const labelEffects = labelMoveEffects(options.labels.engineer, facts, options);
      const effects = [...labelEffects, ...handOff(record, 'person', context, options, now)];
      decide('applied');
      return done(record, now, effects);
    }

    case 'close': {
      const effects: Effect[] = [...stopSessionEffects(record, now, 'person-close'), { type: 'close-issue' }];
      if (record.stage !== 'merged') {
        moveTo(record, 'closed', now);
        record.route = null;
      }
      decide('applied');
      return done(record, now, effects);
    }

    case 'reply': {
      const answer = request.answer?.trim();
      if (!answer) return fail('missing-answer', 'A reply needs a non-empty answer');
      const question = outstandingQuestion(record);
      if (question === null) return fail('unknown-question', 'There is no outstanding question');
      question.answeredAt = now;
      if (outstandingQuestion(record) === null) moveTo(record, 'triaging', now);
      record.decisions.push({ action: 'reply', outcome: 'applied', actor: request.actor, at: now, context: question.id });
      return done(record, now, [{ type: 'post-comment', body: answer }]);
    }

    case 'merge': {
      if (record.fix === null) return fail('no-fix', 'No fix PR is recorded');
      decide('requested');
      return done(record, now, [
        { type: 'merge-pr', prNumber: record.fix.prNumber, expectedHeadSha: record.fix.headSha },
      ]);
    }
  }
}
