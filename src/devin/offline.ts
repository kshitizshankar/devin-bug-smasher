import type { DevinFetch } from './http.ts';
import type { WireInsightsAnalysis, WirePrReview, WireSession, WireSessionMessage } from './wire.ts';

/**
 * An in-memory stand-in for the documented Devin API v3 endpoints the client uses. It speaks the same
 * HTTP/JSON shapes, so `DevinClient` runs unchanged against it (`new DevinClient({ ..., fetch: offline.fetch })`).
 *
 * It never invents results: sessions stay `new` until a test or offline scenario changes them, reviews stay
 * pending, insights are not generated, usage is zero (reported as unavailable) and metrics are forbidden
 * unless explicitly provided.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** True when the request carried the expected bearer token. The token itself is never recorded. */
  authorized: boolean;
}

export interface OfflineFault {
  method?: string;
  /** Substring of the request path. */
  path?: string;
  /** Respond with this HTTP status and ProblemDetail body. */
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding, as `fetch` does on timeout or connection failure. */
  network?: 'timeout' | 'reset';
  /** Apply the request's effect first, then fail: models a create that succeeded but whose answer was lost. */
  applyFirst?: boolean;
}

export interface OfflineDevinOptions {
  apiKey: string;
  orgId: string;
  /** Upper bound on page size, to exercise pagination. */
  maxPageSize?: number;
  now?: () => Date;
}

interface InsightsState {
  analysis_status: 'started' | 'completed' | 'failed' | null;
  analysis: WireInsightsAnalysis | null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  });
}

function problem(status: number, title: string, detail?: string): Response {
  return json(status, { type: 'about:blank', title, status, detail });
}

export class OfflineDevin {
  readonly requests: RecordedRequest[] = [];
  readonly sessions = new Map<string, WireSession>();
  readonly messages = new Map<string, WireSessionMessage[]>();
  /** Keyed by PR URL; the latest review per PR. */
  readonly reviews = new Map<string, WirePrReview>();
  /** Head SHA per PR URL; a review can only be requested for a known PR. */
  readonly pullRequestHeads = new Map<string, string>();
  readonly insights = new Map<string, InsightsState>();
  metrics: { usage?: unknown; sessions?: unknown; prs?: unknown } = {};

  readonly #apiKey: string;
  readonly #orgId: string;
  readonly #maxPageSize: number;
  readonly #now: () => Date;
  readonly #faults: OfflineFault[] = [];
  #nextId = 1;

  constructor(options: OfflineDevinOptions) {
    this.#apiKey = options.apiKey;
    this.#orgId = options.orgId;
    this.#maxPageSize = options.maxPageSize ?? 200;
    this.#now = options.now ?? (() => new Date());
  }

  /** Queues a one-shot fault for the next request matching `method`/`path`. */
  failNext(fault: OfflineFault): void {
    this.#faults.push(fault);
  }

  updateSession(sessionId: string, patch: Partial<WireSession>): WireSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error(`No offline session ${sessionId}`);
    Object.assign(session, patch, { updated_at: this.#seconds() });
    return session;
  }

  readonly fetch: DevinFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as unknown) : undefined;
    const authorized = headers.get('authorization') === `Bearer ${this.#apiKey}`;
    this.requests.push({ method, path: parsed.pathname, query: parsed.searchParams, body, authorized });

    const faultIndex = this.#faults.findIndex(
      (fault) => (fault.method === undefined || fault.method === method) && (fault.path === undefined || parsed.pathname.includes(fault.path)),
    );
    const fault = faultIndex === -1 ? undefined : this.#faults.splice(faultIndex, 1)[0];
    if (fault !== undefined && !fault.applyFirst) return this.#fail(fault);
    if (!authorized) return problem(401, 'Unauthorized', 'Invalid or missing API key');
    const response = this.#route(method, parsed, body);
    return fault === undefined ? response : this.#fail(fault);
  };

  #fail(fault: OfflineFault): Response {
    if (fault.network === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    if (fault.network === 'reset') throw new TypeError('fetch failed');
    const status = fault.status ?? 500;
    return json(status, fault.body ?? { type: 'about:blank', title: 'Offline fault', status }, fault.headers);
  }

  #seconds(): number {
    return Math.floor(this.#now().getTime() / 1000);
  }

  #route(method: string, url: URL, body: unknown): Response {
    const prefix = `/v3/organizations/${this.#orgId}`;
    if (!url.pathname.startsWith(`${prefix}/`)) return problem(403, 'Forbidden', 'Organization not accessible');
    const path = url.pathname.slice(prefix.length);
    const query = url.searchParams;
    let match: RegExpExecArray | null;

    if (path === '/sessions' && method === 'POST') return this.#createSession(body);
    if (path === '/sessions' && method === 'GET') return this.#listSessions(query);
    if ((match = /^\/sessions\/([^/]+)$/.exec(path))) {
      const session = this.sessions.get(decodeURIComponent(match[1] ?? ''));
      if (session === undefined) return problem(404, 'Not Found', 'Session not found');
      if (method === 'GET') return json(200, session);
      if (method === 'DELETE') {
        this.updateSession(session.session_id, { status: 'exit', status_detail: null, is_archived: query.get('archive') === 'true' || session.is_archived === true });
        return json(200, session);
      }
    }
    if ((match = /^\/sessions\/([^/]+)\/(messages|archive|insights|insights\/generate)$/.exec(path))) {
      const id = decodeURIComponent(match[1] ?? '');
      const session = this.sessions.get(id);
      if (session === undefined) return problem(404, 'Not Found', 'Session not found');
      const action = match[2];
      if (action === 'messages' && method === 'POST') return this.#sendMessage(session, body);
      if (action === 'messages' && method === 'GET') return this.#page(this.messages.get(id) ?? [], query);
      if (action === 'archive' && method === 'POST') return json(200, this.updateSession(id, { is_archived: true }));
      if (action === 'insights' && method === 'GET') {
        const state = this.insights.get(id) ?? { analysis_status: null, analysis: null };
        return json(200, { ...session, num_user_messages: 0, num_devin_messages: 0, session_size: 'xs', ...state });
      }
      if (action === 'insights/generate' && method === 'POST') {
        const state = this.insights.get(id);
        if (state?.analysis_status === 'completed') return json(200, { session_id: id, status: 'already_exists' });
        this.insights.set(id, { analysis_status: 'started', analysis: state?.analysis ?? null });
        return json(200, { session_id: id, status: 'started' });
      }
    }
    if (path === '/pr-reviews') return this.#reviews(method, query, body);
    if ((match = /^\/consumption\/daily\/sessions\/([^/]+)$/.exec(path)) && method === 'GET') {
      const session = this.sessions.get(decodeURIComponent(match[1] ?? ''));
      if (session === undefined) return problem(404, 'Not Found', 'Session not found');
      return json(200, { total_acus: session.acus_consumed, consumption_by_date: [] });
    }
    if ((match = /^\/metrics\/(usage|sessions|prs)$/.exec(path)) && method === 'GET') {
      const value = this.metrics[match[1] as 'usage' | 'sessions' | 'prs'];
      return value === undefined ? problem(403, 'Forbidden', 'Metrics are not available offline') : json(200, value);
    }
    return problem(404, 'Not Found', `No offline route for ${method} ${url.pathname}`);
  }

  #createSession(body: unknown): Response {
    if (typeof body !== 'object' || body === null || typeof (body as { prompt?: unknown }).prompt !== 'string') {
      return problem(422, 'Validation Error', 'prompt is required');
    }
    const request = body as { prompt: string; title?: string | null; tags?: string[] | null; playbook_id?: string | null };
    const id = `devin-offline${String(this.#nextId++).padStart(4, '0')}`;
    const now = this.#seconds();
    const session: WireSession = {
      session_id: id,
      url: `https://app.devin.ai/sessions/${id.slice('devin-'.length)}`,
      status: 'new',
      status_detail: null,
      tags: [...(request.tags ?? [])],
      org_id: this.#orgId,
      created_at: now,
      updated_at: now,
      acus_consumed: 0,
      pull_requests: [],
      structured_output: null,
      title: request.title ?? null,
      is_archived: false,
      playbook_id: request.playbook_id ?? null,
    };
    this.sessions.set(id, session);
    this.messages.set(id, []);
    return json(200, session);
  }

  #listSessions(query: URLSearchParams): Response {
    const tags = query.getAll('tags');
    const createdAfter = query.get('created_after');
    // Any-tag matching: the client must not rely on the provider narrowing to all tags.
    const items = [...this.sessions.values()].filter(
      (session) =>
        (tags.length === 0 || tags.some((tag) => session.tags.includes(tag))) &&
        (createdAfter === null || session.created_at >= Number(createdAfter)),
    );
    return this.#page(items, query);
  }

  #page(items: unknown[], query: URLSearchParams): Response {
    const first = Math.min(Number(query.get('first') ?? 100), this.#maxPageSize);
    const start = Number(query.get('after') ?? 0);
    const slice = items.slice(start, start + first);
    const next = start + slice.length;
    return json(200, { items: slice, has_next_page: next < items.length, end_cursor: next < items.length ? String(next) : null, total: items.length });
  }

  #sendMessage(session: WireSession, body: unknown): Response {
    const message = (body as { message?: unknown } | undefined)?.message;
    if (typeof message !== 'string') return problem(422, 'Validation Error', 'message is required');
    if (session.status === 'exit' || session.status === 'error') return problem(409, 'Conflict', 'Session has ended');
    this.messages.get(session.session_id)?.push({
      event_id: `event-${this.requests.length}`,
      source: 'user',
      message,
      created_at: this.#seconds(),
    });
    return json(200, session);
  }

  #reviews(method: string, query: URLSearchParams, body: unknown): Response {
    if (method === 'POST') {
      const prUrl = (body as { pr_url?: unknown } | undefined)?.pr_url;
      if (typeof prUrl !== 'string') return problem(422, 'Validation Error', 'pr_url is required');
      const head = this.pullRequestHeads.get(prUrl);
      if (head === undefined) return problem(404, 'Not Found', 'Pull request not found');
      const existing = this.reviews.get(prUrl);
      if (existing !== undefined && existing.commit_sha === head) return json(200, existing);
      const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl);
      const review: WirePrReview = {
        status: 'pending',
        repo_path: match?.[1] ?? '',
        pr_number: Number(match?.[2] ?? 0),
        commit_sha: head,
        created_at: this.#now().toISOString(),
      };
      this.reviews.set(prUrl, review);
      return json(200, review);
    }
    if (method === 'GET') {
      const review = this.reviews.get(query.get('pr_url') ?? '');
      const sha = query.get('commit_sha');
      if (review === undefined || (sha !== null && review.commit_sha !== sha)) return problem(404, 'Not Found', 'No review found');
      return json(200, review);
    }
    return problem(405, 'Method Not Allowed');
  }
}
