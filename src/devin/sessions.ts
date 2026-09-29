import type { ModelEvent } from '../model/transitions.ts';
import type { SessionLiveState, Timestamp, WorkRoute } from '../model/types.ts';
import { interpretStructuredOutput, type StructuredOutputResult } from './structured-output.ts';
import { acuReading, type AcuReading } from './usage.ts';
import { DEVIN_SESSION_STATUSES, type DevinSessionStatus, type WireSession } from './wire.ts';

export const TAG_PREFIX = 'bug-smasher';

/** Tags that identify one creation attempt of a Bug Smasher session for one bug. */
export interface SessionTags {
  /** Marks every Bug Smasher session. */
  service: string;
  /** `bug-smasher:bug=<owner/repo#number>`. */
  bug: string;
  /** `bug-smasher:route=<triage|fix>`. */
  route: string;
  /** `bug-smasher:attempt=<id>`; unique per create call so an ambiguous create can be reconciled exactly. */
  attempt: string;
}

export function sessionTags(bugKey: string, route: WorkRoute, attemptId: string): SessionTags {
  return {
    service: TAG_PREFIX,
    bug: bugTag(bugKey),
    route: `${TAG_PREFIX}:route=${route}`,
    attempt: `${TAG_PREFIX}:attempt=${attemptId}`,
  };
}

export function bugTag(bugKey: string): string {
  return `${TAG_PREFIX}:bug=${bugKey}`;
}

export function tagList(tags: SessionTags): string[] {
  return [tags.service, tags.bug, tags.route, tags.attempt];
}

/** Reasons a session is suspended that need a person (billing/admin) rather than a message to resume. */
const PROVIDER_LIMIT_DETAILS = new Set([
  'usage_limit_exceeded',
  'out_of_credits',
  'out_of_quota',
  'no_quota_allocation',
  'payment_declined',
  'org_usage_limit_exceeded',
  'user_usage_limit_exceeded',
  'total_session_limit_exceeded',
  'contract_expired',
]);

/**
 * What the session is doing, derived only from `status` and `status_detail`. None of these states means
 * the work is complete: completion is only ever a `valid` structured output.
 */
export type SessionActivity =
  | { kind: 'starting' }
  | { kind: 'working' }
  /** Devin is waiting for a user message or for an approval. */
  | { kind: 'waiting'; on: 'user' | 'approval' }
  /** Devin finished its current turn; it may still be asked to continue. */
  | { kind: 'idle' }
  /**
   * Suspended sessions keep their state. `resumable` is true for inactivity and user requests; provider
   * limits (credits, quota, payment, contract) and provider errors need a person to act.
   */
  | { kind: 'suspended'; reason: 'inactivity' | 'user-request' | 'provider-limit' | 'provider-error' | 'unknown'; detail: string | null; resumable: boolean }
  | { kind: 'ended'; reason: 'exit' | 'error'; detail: string | null }
  /** A status this adapter does not know. Never treated as progress or completion. */
  | { kind: 'unknown'; status: string; detail: string | null };

export function classifySession(status: string, detail: string | null): SessionActivity {
  if (!(DEVIN_SESSION_STATUSES as readonly string[]).includes(status)) return { kind: 'unknown', status, detail };
  switch (status as DevinSessionStatus) {
    case 'new':
    case 'claimed':
    case 'resuming':
      return { kind: 'starting' };
    case 'running':
      if (detail === 'waiting_for_user') return { kind: 'waiting', on: 'user' };
      if (detail === 'waiting_for_approval') return { kind: 'waiting', on: 'approval' };
      if (detail === 'finished') return { kind: 'idle' };
      if (detail === null || detail === 'working') return { kind: 'working' };
      return { kind: 'unknown', status, detail };
    case 'suspended':
      if (detail === 'inactivity') return { kind: 'suspended', reason: 'inactivity', detail, resumable: true };
      if (detail === 'user_request') return { kind: 'suspended', reason: 'user-request', detail, resumable: true };
      if (detail !== null && PROVIDER_LIMIT_DETAILS.has(detail)) {
        return { kind: 'suspended', reason: 'provider-limit', detail, resumable: false };
      }
      if (detail === 'error') return { kind: 'suspended', reason: 'provider-error', detail, resumable: false };
      return { kind: 'suspended', reason: 'unknown', detail, resumable: false };
    case 'exit':
      return { kind: 'ended', reason: 'exit', detail };
    case 'error':
      return { kind: 'ended', reason: 'error', detail };
  }
}

/** Maps activity onto the shared model's live state; `unknown` maps to null (report nothing). */
export function liveStateFor(activity: SessionActivity): SessionLiveState | null {
  switch (activity.kind) {
    case 'starting':
      return 'starting';
    case 'working':
      return 'running';
    case 'waiting':
    case 'idle':
    case 'suspended':
      return 'blocked';
    case 'ended':
      return 'ended';
    case 'unknown':
      return null;
  }
}

/** A validated, provider-neutral view of one Devin session. Contains no credentials. */
export interface DevinSession {
  id: string;
  url: string;
  title: string | null;
  tags: string[];
  status: string;
  statusDetail: string | null;
  activity: SessionActivity;
  liveState: SessionLiveState | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  isArchived: boolean;
  acus: AcuReading;
  pullRequests: { url: string; state: string | null }[];
  structuredOutput: StructuredOutputResult;
}

/** ISO form of a documented Unix timestamp (milliseconds accepted too), or null if it is not a valid date. */
export function unixToIso(value: unknown): Timestamp | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value > 1e12 ? value : value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a `SessionResponse`. Returns problems instead of throwing so callers can classify the failure. */
export function parseSession(value: unknown): { session: DevinSession } | { problems: string[] } {
  if (!isRecord(value)) return { problems: ['session response must be an object'] };
  const problems: string[] = [];
  const wire = value as Partial<WireSession>;
  if (typeof wire.session_id !== 'string' || wire.session_id === '') problems.push('session_id must be a string');
  if (typeof wire.url !== 'string') problems.push('url must be a string');
  if (typeof wire.status !== 'string') problems.push('status must be a string');
  if (!Array.isArray(wire.tags) || !wire.tags.every((tag) => typeof tag === 'string')) problems.push('tags must be strings');
  const createdAt = unixToIso(wire.created_at);
  const updatedAt = unixToIso(wire.updated_at);
  if (createdAt === null) problems.push('created_at must be a valid Unix timestamp');
  if (updatedAt === null) problems.push('updated_at must be a valid Unix timestamp');
  const detail = wire.status_detail ?? null;
  if (detail !== null && typeof detail !== 'string') problems.push('status_detail must be a string or null');
  if (problems.length > 0 || createdAt === null || updatedAt === null) return { problems };
  const id = wire.session_id as string;
  const activity = classifySession(wire.status as string, detail);
  const pullRequests = Array.isArray(wire.pull_requests)
    ? wire.pull_requests
        .filter((pr): pr is { pr_url: string; pr_state: string | null } => isRecord(pr) && typeof pr.pr_url === 'string')
        .map((pr) => ({ url: pr.pr_url, state: typeof pr.pr_state === 'string' ? pr.pr_state : null }))
    : [];
  return {
    session: {
      id,
      url: wire.url as string,
      title: typeof wire.title === 'string' ? wire.title : null,
      tags: [...(wire.tags as string[])],
      status: wire.status as string,
      statusDetail: detail,
      activity,
      liveState: liveStateFor(activity),
      createdAt,
      updatedAt,
      isArchived: wire.is_archived === true,
      acus: acuReading(wire.acus_consumed),
      pullRequests,
      structuredOutput: interpretStructuredOutput(id, wire.structured_output),
    },
  };
}

/** A `session-status` model event, or null when the state is unknown (never guess). */
export function sessionStatusEvent(session: DevinSession): ModelEvent | null {
  if (session.liveState === null) return null;
  return { type: 'session-status', sessionId: session.id, liveState: session.liveState };
}

/**
 * Model events justified by a session's structured output alone. `pr-opened` produces none: a
 * `fix-submitted` event needs the PR head SHA, which comes from GitHub (see `fixSubmittedEvent`).
 * Questions become `question-asked` only in the triage phase, the one stage where the model accepts them;
 * a fix-phase `needs_input`/`blocked` stays visible as `structuredOutput.signal` for the orchestrator.
 */
export function structuredOutputEvents(session: DevinSession): ModelEvent[] {
  const result = session.structuredOutput;
  if (result.status !== 'valid') return [];
  const signal = result.signal;
  switch (signal.type) {
    case 'needs-input':
    case 'blocked':
      if (signal.phase !== 'triage') return [];
      return [{ type: 'question-asked', question: { id: signal.questionId, summary: signal.question } }];
    case 'triage-complete':
      return [{ type: 'triage-completed', findings: structuredClone(signal.findings) }];
    case 'pr-opened':
      return [];
  }
}

/** Combines a `pr-opened` signal with the head SHA GitHub reports for that PR. */
export function fixSubmittedEvent(session: DevinSession, headSha: string): ModelEvent | null {
  const result = session.structuredOutput;
  if (result.status !== 'valid' || result.signal.type !== 'pr-opened') return null;
  const { pullRequest, testFiles, summary } = result.signal;
  return {
    type: 'fix-submitted',
    fix: { prNumber: pullRequest.number, prUrl: pullRequest.url, headSha, testFiles: [...testFiles], summary },
  };
}
