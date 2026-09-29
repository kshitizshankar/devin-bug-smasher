import { randomUUID } from 'node:crypto';
import type { Settings } from '../config/settings.ts';
import type { Timestamp, WorkRoute } from '../model/types.ts';
import { DevinError, type DevinErrorInfo } from './errors.ts';
import { DevinTransport, type DevinFetch, type DevinRequest } from './http.ts';
import { interpretInsights, type InsightsResult } from './insights.ts';
import { correctionMessage, reviewState, type ReviewFinding, type ReviewState } from './review.ts';
import { bugTag, parseSession, sessionTags, tagList, unixToIso, type DevinSession, type SessionTags } from './sessions.ts';
import { STRUCTURED_OUTPUT_SCHEMA } from './structured-output.ts';
import { acuReading, unixSeconds, windowProblems, type AcuReading, type TimeWindow } from './usage.ts';
import type { WirePage, WirePrReview, WireSessionCreateRequest } from './wire.ts';

export interface DevinClientOptions {
  apiKey: string;
  orgId: string;
  /** Sent as `max_acu_limit` on every session; a positive integer. */
  maxAcuPerSession: number;
  /** `DEVIN_REVIEW`; when false, Review operations report `unavailable: disabled` without a call. */
  reviewEnabled: boolean;
  baseUrl?: string;
  fetch?: DevinFetch;
  timeoutMs?: number;
  /** Source of per-attempt tag ids; defaults to random UUIDs. */
  newAttemptId?: () => string;
}

export interface CreateSessionInput {
  /** Shared-model bug key, `owner/repo#number`. */
  bugKey: string;
  route: WorkRoute;
  prompt: string;
  title?: string | null;
  /** Repositories the session works on, `owner/repo`. */
  repos?: string[];
  playbookId?: string | null;
  knowledgeIds?: string[] | null;
}

export type CreateSessionResult =
  | { outcome: 'created'; session: DevinSession; tags: SessionTags }
  /**
   * No usable answer arrived (timeout, network failure, 5xx or an unreadable body). The session may or may
   * not exist; call `reconcileCreate` with this result instead of creating again.
   */
  | { outcome: 'ambiguous'; tags: SessionTags; requestedAt: Timestamp; error: DevinErrorInfo };

export type ReconcileResult =
  | { outcome: 'found'; session: DevinSession }
  /** No session carries the attempt tag yet. Creation may still be in flight; check again before retrying. */
  | { outcome: 'not-found' }
  /** More than one session carries the attempt tag; a person or the orchestrator must pick and stop the rest. */
  | { outcome: 'duplicates'; sessions: DevinSession[] };

export interface DevinMessage {
  id: string;
  source: 'devin' | 'user';
  text: string;
  createdAt: Timestamp;
}

export type Availability<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; reason: 'forbidden' | 'not-found'; detail: string };

export interface SessionUsage {
  total: AcuReading;
  byDate: { date: Timestamp; acus: AcuReading }[];
}

export interface UsageMetrics {
  sessionsCount: number;
  searchesCount: number;
  prsCreatedCount: number;
  prsMergedCount: number;
}

export interface SessionMetrics {
  sessionsCreatedCount: number;
  sessionsWithMergedPrsCount: number;
  sessionsCreatedWithPlaybookCount: number;
  avgAcusPerSession: AcuReading;
}

export interface PrMetrics {
  prsCreatedCount: number;
  prsOpenedCount: number;
  prsMergedCount: number;
  prsClosedCount: number;
}

export type GenerateInsightsResult = { status: 'started' } | { status: 'already-exists' } | { status: 'unknown'; providerStatus: string };

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notConfigured(message: string): DevinError {
  return new DevinError({
    kind: 'not-configured',
    operation: 'configure',
    status: null,
    message,
    retryAfterSeconds: null,
    ambiguous: false,
  });
}

/**
 * Typed Devin API v3 operations for Bug Smasher sessions, Review, Insights, usage and metrics.
 * Environment/setup (beta) operations live separately in `setup.ts`.
 */
export class DevinClient {
  readonly #transport: DevinTransport;
  readonly #orgPath: string;
  readonly #maxAcu: number;
  readonly #reviewEnabled: boolean;
  readonly #newAttemptId: () => string;

  constructor(options: DevinClientOptions) {
    if (options.orgId.trim() === '') throw notConfigured('A Devin organization id is required');
    if (!Number.isInteger(options.maxAcuPerSession) || options.maxAcuPerSession < 1) {
      throw notConfigured('maxAcuPerSession must be a positive integer (the API takes an integer max_acu_limit)');
    }
    this.#transport = new DevinTransport(options);
    this.#orgPath = `/v3/organizations/${encodeURIComponent(options.orgId)}`;
    this.#maxAcu = options.maxAcuPerSession;
    this.#reviewEnabled = options.reviewEnabled;
    this.#newAttemptId = options.newAttemptId ?? randomUUID;
  }

  static fromSettings(settings: Settings, overrides: Pick<DevinClientOptions, 'baseUrl' | 'fetch' | 'timeoutMs' | 'newAttemptId'> = {}): DevinClient {
    if (settings.devin.apiKey === null) throw notConfigured('DEVIN_API_KEY is not set');
    if (settings.devin.orgId === null) throw notConfigured('DEVIN_ORG_ID is not set');
    return new DevinClient({
      apiKey: settings.devin.apiKey,
      orgId: settings.devin.orgId,
      maxAcuPerSession: settings.devin.maxAcuPerSession,
      reviewEnabled: settings.devin.review,
      ...overrides,
    });
  }

  toJSON(): { orgPath: string; maxAcuPerSession: number; reviewEnabled: boolean } {
    return { orgPath: this.#orgPath, maxAcuPerSession: this.#maxAcu, reviewEnabled: this.#reviewEnabled };
  }

  // Sessions

  /** The exact `SessionCreateRequest` body sent for an input; exposed so callers and tests can inspect it. */
  createRequestBody(input: CreateSessionInput, tags: SessionTags): WireSessionCreateRequest {
    return {
      prompt: input.prompt,
      title: input.title ?? null,
      tags: tagList(tags),
      max_acu_limit: this.#maxAcu,
      structured_output_schema: structuredClone(STRUCTURED_OUTPUT_SCHEMA) as unknown as Record<string, unknown>,
      structured_output_required: false,
      secret_ids: [],
      session_secrets: [],
      repos: input.repos === undefined ? null : [...input.repos],
      playbook_id: input.playbookId ?? null,
      knowledge_ids: input.knowledgeIds === undefined || input.knowledgeIds === null ? null : [...input.knowledgeIds],
    };
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (input.prompt.trim() === '') throw this.#invalidInput('create-session', 'prompt must not be empty');
    const tags = sessionTags(input.bugKey, input.route, this.#newAttemptId());
    const requestedAt = new Date().toISOString();
    let body: unknown;
    try {
      body = await this.#transport.request({
        operation: 'create-session',
        method: 'POST',
        path: `${this.#orgPath}/sessions`,
        body: this.createRequestBody(input, tags),
      });
    } catch (error) {
      if (error instanceof DevinError && error.ambiguous) return { outcome: 'ambiguous', tags, requestedAt, error: error.info() };
      throw error;
    }
    const parsed = parseSession(body);
    if ('problems' in parsed) {
      const error = this.#transport.invalidResponse('create-session', parsed.problems.join('; '), true);
      return { outcome: 'ambiguous', tags, requestedAt, error: error.info() };
    }
    return { outcome: 'created', session: parsed.session, tags };
  }

  async getSession(sessionId: string): Promise<DevinSession> {
    return this.#session('get-session', { method: 'GET', path: this.#sessionPath(sessionId) });
  }

  /** Sessions carrying every given tag (filtered again locally; the API's multi-tag semantics are not documented). */
  async findSessions(tags: readonly string[], options: { createdAfter?: Date } = {}): Promise<DevinSession[]> {
    if (tags.length === 0) throw this.#invalidInput('find-sessions', 'at least one tag is required');
    const query = {
      tags: [...tags],
      created_after: options.createdAfter === undefined ? undefined : unixSeconds(options.createdAfter),
    };
    const items = await this.#paginate('find-sessions', `${this.#orgPath}/sessions`, query);
    const sessions: DevinSession[] = [];
    for (const item of items) {
      const parsed = parseSession(item);
      if ('problems' in parsed) throw this.#transport.invalidResponse('find-sessions', parsed.problems.join('; '), false);
      if (tags.every((tag) => parsed.session.tags.includes(tag))) sessions.push(parsed.session);
    }
    return sessions;
  }

  /** All Bug Smasher sessions for one bug, across routes and attempts. */
  async findBugSessions(bugKey: string): Promise<DevinSession[]> {
    return this.findSessions([bugTag(bugKey)]);
  }

  /** Resolves an ambiguous create by looking the attempt up by its unique tag. Never creates a session. */
  async reconcileCreate(pending: { tags: SessionTags }): Promise<ReconcileResult> {
    const sessions = await this.findSessions([pending.tags.attempt]);
    const [first] = sessions;
    if (first === undefined) return { outcome: 'not-found' };
    if (sessions.length === 1) return { outcome: 'found', session: first };
    return { outcome: 'duplicates', sessions };
  }

  async sendMessage(sessionId: string, message: string): Promise<DevinSession> {
    if (message.trim() === '') throw this.#invalidInput('send-message', 'message must not be empty');
    return this.#session('send-message', {
      method: 'POST',
      path: `${this.#sessionPath(sessionId)}/messages`,
      body: { message },
    });
  }

  /** Session conversation, for display only. Nothing in the service acts on message text. */
  async listMessages(sessionId: string): Promise<DevinMessage[]> {
    const items = await this.#paginate('list-messages', `${this.#sessionPath(sessionId)}/messages`, {});
    return items.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.event_id !== 'string' ||
        (item.source !== 'devin' && item.source !== 'user') ||
        typeof item.message !== 'string' ||
        typeof item.created_at !== 'number'
      ) {
        throw this.#transport.invalidResponse('list-messages', 'message item does not match SessionMessage', false);
      }
      return { id: item.event_id, source: item.source, text: item.message, createdAt: unixToIso(item.created_at) };
    });
  }

  async terminateSession(sessionId: string, options: { archive?: boolean } = {}): Promise<DevinSession> {
    return this.#session('terminate-session', {
      method: 'DELETE',
      path: this.#sessionPath(sessionId),
      query: { archive: options.archive === true ? true : undefined },
    });
  }

  async archiveSession(sessionId: string): Promise<DevinSession> {
    return this.#session('archive-session', { method: 'POST', path: `${this.#sessionPath(sessionId)}/archive` });
  }

  // Devin Review

  async requestReview(prUrl: string, expectedHeadSha: string | null = null): Promise<ReviewState> {
    if (!this.#reviewEnabled) return disabledReview();
    return this.#review('request-review', { method: 'POST', path: `${this.#orgPath}/pr-reviews`, body: { pr_url: prUrl } }, expectedHeadSha);
  }

  async getReview(prUrl: string, headSha: string): Promise<ReviewState> {
    if (!this.#reviewEnabled) return disabledReview();
    return this.#review(
      'get-review',
      { method: 'GET', path: `${this.#orgPath}/pr-reviews`, query: { pr_url: prUrl, commit_sha: headSha } },
      headSha,
    );
  }

  /** Same-session correction: sends unresolved Review findings back to the session that opened the PR. */
  async sendReviewCorrections(sessionId: string, findings: readonly ReviewFinding[]): Promise<DevinSession> {
    if (findings.length === 0) throw this.#invalidInput('send-review-corrections', 'there are no findings to correct');
    return this.sendMessage(sessionId, correctionMessage(findings));
  }

  // Session Insights

  async getInsights(sessionId: string): Promise<InsightsResult> {
    try {
      const body = await this.#transport.request({ operation: 'get-insights', method: 'GET', path: `${this.#sessionPath(sessionId)}/insights` });
      return interpretInsights(sessionId, body);
    } catch (error) {
      const unavailable = unavailableFor(error);
      if (unavailable !== null) return unavailable;
      throw error;
    }
  }

  async generateInsights(sessionId: string): Promise<GenerateInsightsResult> {
    const body = await this.#transport.request({
      operation: 'generate-insights',
      method: 'POST',
      path: `${this.#sessionPath(sessionId)}/insights/generate`,
    });
    const status = isRecord(body) && typeof body.status === 'string' ? body.status : null;
    if (status === null) throw this.#transport.invalidResponse('generate-insights', 'status must be a string', true);
    if (status === 'started') return { status: 'started' };
    if (status === 'already_exists') return { status: 'already-exists' };
    return { status: 'unknown', providerStatus: status };
  }

  // Usage and metrics

  async getSessionUsage(sessionId: string, window?: TimeWindow): Promise<Availability<SessionUsage>> {
    return this.#available('get-session-usage', {
      method: 'GET',
      path: `${this.#orgPath}/consumption/daily/sessions/${encodeURIComponent(sessionId)}`,
      query: this.#windowQuery('get-session-usage', window),
    }, (body) => {
      if (!isRecord(body) || !Array.isArray(body.consumption_by_date)) return null;
      return {
        total: acuReading(body.total_acus),
        byDate: body.consumption_by_date.filter(isRecord).map((day) => ({
          date: typeof day.date === 'number' ? unixToIso(day.date) : '',
          acus: acuReading(day.acus),
        })),
      };
    });
  }

  async getUsageMetrics(window?: TimeWindow): Promise<Availability<UsageMetrics>> {
    return this.#available('get-usage-metrics', {
      method: 'GET',
      path: `${this.#orgPath}/metrics/usage`,
      query: this.#windowQuery('get-usage-metrics', window),
    }, (body) => counts(body, {
      sessionsCount: 'sessions_count',
      searchesCount: 'searches_count',
      prsCreatedCount: 'prs_created_count',
      prsMergedCount: 'prs_merged_count',
    }));
  }

  async getSessionMetrics(window: TimeWindow): Promise<Availability<SessionMetrics>> {
    return this.#available('get-session-metrics', {
      method: 'GET',
      path: `${this.#orgPath}/metrics/sessions`,
      query: this.#windowQuery('get-session-metrics', window),
    }, (body) => {
      const base = counts(body, {
        sessionsCreatedCount: 'sessions_created_count',
        sessionsWithMergedPrsCount: 'sessions_with_merged_prs_count',
        sessionsCreatedWithPlaybookCount: 'sessions_created_with_playbook_count',
      });
      if (base === null || !isRecord(body)) return null;
      return { ...base, avgAcusPerSession: acuReading(body.avg_acus_per_session) };
    });
  }

  async getPrMetrics(window: TimeWindow): Promise<Availability<PrMetrics>> {
    return this.#available('get-pr-metrics', {
      method: 'GET',
      path: `${this.#orgPath}/metrics/prs`,
      query: this.#windowQuery('get-pr-metrics', window),
    }, (body) => counts(body, {
      prsCreatedCount: 'prs_created_count',
      prsOpenedCount: 'prs_opened_count',
      prsMergedCount: 'prs_merged_count',
      prsClosedCount: 'prs_closed_count',
    }));
  }

  // Internals

  #sessionPath(sessionId: string): string {
    if (sessionId.trim() === '') throw this.#invalidInput('session', 'session id must not be empty');
    return `${this.#orgPath}/sessions/${encodeURIComponent(sessionId)}`;
  }

  #invalidInput(operation: string, message: string): DevinError {
    return new DevinError({ kind: 'invalid-request', operation, status: null, message: this.#transport.redact(message), retryAfterSeconds: null, ambiguous: false });
  }

  #windowQuery(operation: string, window: TimeWindow | undefined): Record<string, number | undefined> {
    if (window === undefined) return {};
    const problems = windowProblems(window);
    if (problems.length > 0) throw this.#invalidInput(operation, problems.join('; '));
    return { time_after: unixSeconds(window.after), time_before: unixSeconds(window.before) };
  }

  async #session(operation: string, request: Omit<DevinRequest, 'operation'>): Promise<DevinSession> {
    const body = await this.#transport.request({ operation, ...request });
    const parsed = parseSession(body);
    if ('problems' in parsed) throw this.#transport.invalidResponse(operation, parsed.problems.join('; '), request.method !== 'GET');
    return parsed.session;
  }

  async #paginate(operation: string, path: string, query: DevinRequest['query']): Promise<unknown[]> {
    const items: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = (await this.#transport.request({ operation, method: 'GET', path, query: { ...query, first: PAGE_SIZE, after } })) as Partial<WirePage<unknown>> | null;
      if (!isRecord(body) || !Array.isArray(body.items)) throw this.#transport.invalidResponse(operation, 'expected a paginated response with items', false);
      items.push(...body.items);
      if (body.has_next_page !== true || typeof body.end_cursor !== 'string') return items;
      after = body.end_cursor;
    }
    throw this.#transport.invalidResponse(operation, `more than ${MAX_PAGES * PAGE_SIZE} items; narrow the query`, false);
  }

  async #review(operation: string, request: Omit<DevinRequest, 'operation'>, expectedHeadSha: string | null): Promise<ReviewState> {
    let body: unknown;
    try {
      body = await this.#transport.request({ operation, ...request });
    } catch (error) {
      if (error instanceof DevinError && error.kind === 'not-found') {
        return { status: 'unavailable', reason: 'not-requested', detail: 'No Devin Review exists for this PR commit' };
      }
      if (error instanceof DevinError && error.kind === 'forbidden') {
        return { status: 'unavailable', reason: 'forbidden', detail: 'The Devin API key may not request or read reviews' };
      }
      throw error;
    }
    if (
      !isRecord(body) ||
      typeof body.status !== 'string' ||
      typeof body.commit_sha !== 'string' ||
      typeof body.pr_number !== 'number' ||
      typeof body.repo_path !== 'string'
    ) {
      throw this.#transport.invalidResponse(operation, 'response does not match PrReviewResponse', request.method !== 'GET');
    }
    return reviewState(body as unknown as WirePrReview, expectedHeadSha);
  }

  async #available<T>(operation: string, request: Omit<DevinRequest, 'operation'>, parse: (body: unknown) => T | null): Promise<Availability<T>> {
    let body: unknown;
    try {
      body = await this.#transport.request({ operation, ...request });
    } catch (error) {
      const unavailable = unavailableFor(error);
      if (unavailable !== null) return unavailable;
      throw error;
    }
    const value = parse(body);
    if (value === null) throw this.#transport.invalidResponse(operation, 'response does not match the documented shape', false);
    return { status: 'available', value };
  }
}

function disabledReview(): ReviewState {
  return { status: 'unavailable', reason: 'disabled', detail: 'Devin Review is turned off (DEVIN_REVIEW=false)' };
}

function unavailableFor(error: unknown): { status: 'unavailable'; reason: 'forbidden' | 'not-found'; detail: string } | null {
  if (!(error instanceof DevinError)) return null;
  if (error.kind === 'forbidden') return { status: 'unavailable', reason: 'forbidden', detail: error.message };
  if (error.kind === 'not-found') return { status: 'unavailable', reason: 'not-found', detail: error.message };
  return null;
}

function counts<K extends string>(body: unknown, fields: Record<K, string>): Record<K, number> | null {
  if (!isRecord(body)) return null;
  const result = {} as Record<K, number>;
  for (const [key, wire] of Object.entries(fields) as [K, string][]) {
    const value = body[wire];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    result[key] = value;
  }
  return result;
}
