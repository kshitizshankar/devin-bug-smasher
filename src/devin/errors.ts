/**
 * Devin API failures. Messages and serialized forms never contain the API key or any bearer token: every
 * provider-supplied string passes through `redact` before it is stored on the error.
 */

export const DEVIN_ERROR_KINDS = [
  'not-configured',
  'auth',
  'forbidden',
  'not-found',
  'conflict',
  'invalid-request',
  'rate-limited',
  'provider',
  'network',
  'timeout',
  'invalid-response',
] as const;
export type DevinErrorKind = (typeof DEVIN_ERROR_KINDS)[number];

export interface DevinErrorInfo {
  kind: DevinErrorKind;
  /** Operation name, e.g. `create-session`. */
  operation: string;
  /** HTTP status when the provider answered, otherwise null. */
  status: number | null;
  message: string;
  /** Seconds from a numeric `Retry-After` header on 429 responses, otherwise null. */
  retryAfterSeconds: number | null;
  /**
   * True when the request may have taken effect on the provider even though no usable answer arrived
   * (timeouts, network failures and 5xx on non-GET requests). Never retry such a request blindly.
   */
  ambiguous: boolean;
}

export class DevinError extends Error {
  readonly kind: DevinErrorKind;
  readonly operation: string;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly ambiguous: boolean;

  constructor(info: DevinErrorInfo) {
    super(info.message);
    this.name = 'DevinError';
    this.kind = info.kind;
    this.operation = info.operation;
    this.status = info.status;
    this.retryAfterSeconds = info.retryAfterSeconds;
    this.ambiguous = info.ambiguous;
  }

  info(): DevinErrorInfo {
    return {
      kind: this.kind,
      operation: this.operation,
      status: this.status,
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
      ambiguous: this.ambiguous,
    };
  }

  toJSON(): DevinErrorInfo {
    return this.info();
  }
}

const TOKEN_PATTERNS = [
  /\bBearer\s+[^\s"',;]+/gi,
  /\b(?:cog|apk)_[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
];

/** Removes the given secrets and anything shaped like a Devin or GitHub credential or bearer token. */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join('[redacted]');
  }
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

export function kindForStatus(status: number): DevinErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'provider';
  if (status >= 400) return 'invalid-request';
  return 'invalid-response';
}
