import { DevinError, kindForStatus, redact } from './errors.ts';

export const DEVIN_API_BASE_URL = 'https://api.devin.ai';
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The subset of `fetch` the client uses. Tests and offline mode inject a stand-in. */
export type DevinFetch = (url: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export interface DevinRequest {
  operation: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path below the API base, e.g. `/v3/organizations/org-1/sessions`. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export interface TransportOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: DevinFetch;
  timeoutMs?: number;
}

/**
 * Authenticated JSON transport for the Devin API. The API key lives in a private field so it is not
 * reachable through serialization or `util.inspect`, and every error message is redacted.
 */
export class DevinTransport {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: DevinFetch;
  readonly #timeoutMs: number;

  constructor(options: TransportOptions) {
    if (options.apiKey.trim() === '') {
      throw new DevinError({
        kind: 'not-configured',
        operation: 'configure',
        status: null,
        message: 'A Devin API key is required',
        retryAfterSeconds: null,
        ambiguous: false,
      });
    }
    const baseUrl = (options.baseUrl ?? DEVIN_API_BASE_URL).replace(/\/+$/, '');
    if (!isSecureBaseUrl(baseUrl)) {
      throw new DevinError({
        kind: 'not-configured',
        operation: 'configure',
        status: null,
        message: 'The Devin API base URL must use https (plain http is allowed only for loopback hosts)',
        retryAfterSeconds: null,
        ambiguous: false,
      });
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  redact(text: string): string {
    return redact(text, [this.#apiKey]);
  }

  async request(request: DevinRequest): Promise<unknown> {
    const url = new URL(this.#baseUrl + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
    };
    // A redirect could carry the Authorization header to another host.
    const init: RequestInit = { method: request.method, headers, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) };
    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    // A GET cannot change provider state; anything else may have been applied if no answer arrives.
    const mayHaveApplied = request.method !== 'GET';

    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url.toString(), init);
      text = await response.text();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const cause = error instanceof Error ? error.message : String(error);
      throw this.#error(request.operation, timedOut ? 'timeout' : 'network', null, mayHaveApplied, `${cause}`);
    }

    if (!response.ok) {
      const retryAfter = response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null;
      const kind = kindForStatus(response.status);
      throw this.#error(
        request.operation,
        kind,
        response.status,
        mayHaveApplied && response.status >= 500,
        problemDetail(text) ?? `HTTP ${response.status}`,
        retryAfter,
      );
    }
    if (text.trim() === '') return null;
    try {
      return this.#scrub(JSON.parse(text) as unknown);
    } catch {
      throw this.#error(request.operation, 'invalid-response', response.status, mayHaveApplied, 'Response is not JSON');
    }
  }

  /** Redacts credentials from every string in a provider body, so none reach records, comments or logs. */
  #scrub(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.#scrub(item));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#scrub(item)]));
    }
    return value;
  }

  /** Builds a redacted `invalid-response` error for a body that does not match the documented shape. */
  invalidResponse(operation: string, problem: string, ambiguous: boolean): DevinError {
    return this.#error(operation, 'invalid-response', null, ambiguous, problem);
  }

  #error(
    operation: string,
    kind: DevinError['kind'],
    status: number | null,
    ambiguous: boolean,
    detail: string,
    retryAfterSeconds: number | null = null,
  ): DevinError {
    const where = status === null ? kind : `${kind} (HTTP ${status})`;
    return new DevinError({
      kind,
      operation,
      status,
      message: this.redact(`Devin ${operation} failed: ${where}: ${detail}`),
      retryAfterSeconds,
      ambiguous,
    });
  }
}

function isSecureBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** Extracts `title`/`detail` from an RFC 9457 ProblemDetail body, as documented for Devin API errors. */
function problemDetail(text: string): string | null {
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body !== 'object' || body === null) return null;
    const { title, detail } = body as { title?: unknown; detail?: unknown };
    const parts = [title, typeof detail === 'string' ? detail : detail === undefined ? undefined : JSON.stringify(detail)]
      .filter((part): part is string => typeof part === 'string' && part !== '');
    return parts.length > 0 ? parts.join(': ') : null;
  } catch {
    return text.trim() === '' ? null : text.trim().slice(0, 200);
  }
}
