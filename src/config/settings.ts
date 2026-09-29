import { fileURLToPath } from 'node:url';

export type Env = Readonly<Record<string, string | undefined>>;

export const POLICIES = ['person', 'rule', 'auto'] as const;
export type Policy = (typeof POLICIES)[number];

export interface LabelSettings {
  triage: string;
  fix: string;
  engineer: string;
  feature: string;
}

export interface GitHubRepo {
  owner: string;
  name: string;
}

/** Independent verification (M1.5); see docs/VERIFICATION.md. */
export interface VerifySettings {
  /** The target repository's test image; verification is unavailable until it is set. */
  image: string | null;
  /** Optional dependency preparation run before the tests, e.g. `npm ci`. */
  setupCommand: string | null;
  /** Time limit for each setup and test step. */
  timeoutSeconds: number;
  /** Repository mirror and disposable workspaces. */
  workDir: string;
}

/** Fully parsed settings. Holds secrets; never serialize it directly, use `effectiveSettings`. */
export interface Settings {
  github: {
    repo: GitHubRepo | null;
    token: string | null;
  };
  devin: {
    apiKey: string | null;
    orgId: string | null;
    review: boolean;
    maxActiveSessions: number;
    maxAcuPerSession: number;
  };
  checkCommand: string | null;
  baselineFilter: string | null;
  verify: VerifySettings;
  labels: LabelSettings;
  decision: Policy;
  merge: Policy;
  mergeMaxLines: number;
  maxFixRetries: number;
  pollSeconds: number;
  cost: {
    /** `null` means unknown, never zero. */
    acuPriceUsd: number | null;
    spendUsd: number | null;
    spendReadAt: string | null;
    budgetUsd: number | null;
  };
  server: {
    host: string;
    port: number;
    staticDir: string;
  };
}

/** Secret-free projection of `Settings`, safe to serialize (for example in a future HTTP response). */
export interface EffectiveSettings {
  github: { repo: string | null; tokenConfigured: boolean };
  devin: {
    apiKeyConfigured: boolean;
    orgId: string | null;
    review: boolean;
    maxActiveSessions: number;
    maxAcuPerSession: number;
  };
  checkCommand: string | null;
  baselineFilter: string | null;
  verify: VerifySettings;
  labels: LabelSettings;
  decision: Policy;
  merge: Policy;
  mergeMaxLines: number;
  maxFixRetries: number;
  pollSeconds: number;
  cost: Settings['cost'];
  server: Settings['server'];
}

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../dist/web', import.meta.url));

export const DEFAULT_VERIFY_DIR = fileURLToPath(new URL('../../data/verify', import.meta.url));

export const FILES_PLACEHOLDER = '{files}';

const SECRET_VARIABLES = new Set(['GITHUB_TOKEN', 'DEVIN_API_KEY']);

/** Raised when environment settings are invalid. Messages never contain secret values. */
export class SettingsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], summary = 'Invalid settings') {
    super(`${summary}:\n- ${problems.join('\n- ')}`);
    this.name = 'SettingsError';
    this.problems = problems;
  }
}

class Reader {
  readonly problems: string[] = [];
  readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  raw(name: string): string | undefined {
    const value = this.env[name];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  private invalid(name: string, value: string, expected: string): void {
    const shown = SECRET_VARIABLES.has(name) ? '' : ` ${JSON.stringify(value)}`;
    this.problems.push(`${name}${shown} is invalid: expected ${expected}`);
  }

  string(name: string, fallback: string): string {
    return this.raw(name) ?? fallback;
  }

  optionalString(name: string): string | null {
    return this.raw(name) ?? null;
  }

  enumeration<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const match = allowed.find((option) => option === value.toLowerCase());
    if (match === undefined) {
      this.invalid(name, value, `one of ${allowed.join(', ')}`);
      return fallback;
    }
    return match;
  }

  boolean(name: string, fallback: boolean): boolean {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const lowered = value.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
    this.invalid(name, value, 'true or false');
    return fallback;
  }

  integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const parsed = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `${min}-${max}`;
      this.invalid(name, value, `an integer ${range}`);
      return fallback;
    }
    return parsed;
  }

  decimal(name: string, options: { positive: boolean }): number | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    const parsed = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isFinite(parsed) || (options.positive && parsed <= 0)) {
      this.invalid(name, value, options.positive ? 'a number > 0' : 'a number >= 0');
      return null;
    }
    return parsed;
  }

  timestamp(name: string): string | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    const time = Date.parse(value);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(time)) {
      this.invalid(name, value, 'an ISO 8601 timestamp such as 2026-01-31T12:00:00Z');
      return null;
    }
    return new Date(time).toISOString();
  }

  repo(name: string): GitHubRepo | null {
    const value = this.raw(name);
    if (value === undefined) return null;
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
    if (!match?.[1] || !match[2] || match[2] === '.' || match[2] === '..') {
      this.invalid(name, value, 'owner/name');
      return null;
    }
    return { owner: match[1], name: match[2] };
  }
}

/**
 * Reads settings from the environment into a typed object. Credentials are optional here so that the
 * scaffold, CI and pure model tests run without them; use `assertLiveSettings` before live provider use.
 * Throws `SettingsError` listing every invalid value.
 */
export function loadSettings(env: Env = process.env): Settings {
  const read = new Reader(env);

  const labels: LabelSettings = {
    triage: read.string('TRIAGE_LABEL', 'needs-triage'),
    fix: read.string('FIX_LABEL', 'bug-smasher'),
    engineer: read.string('ENGINEER_LABEL', 'needs-engineer'),
    feature: read.string('FEATURE_LABEL', 'devin-builds-feature'),
  };
  const labelVariables: Record<keyof LabelSettings, string> = {
    triage: 'TRIAGE_LABEL',
    fix: 'FIX_LABEL',
    engineer: 'ENGINEER_LABEL',
    feature: 'FEATURE_LABEL',
  };
  const seen = new Map<string, string>();
  for (const role of Object.keys(labels) as (keyof LabelSettings)[]) {
    const normalized = labels[role].toLowerCase();
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      read.problems.push(
        `${labelVariables[role]} must differ from ${previous}: GitHub labels are case-insensitive and ` +
          `both are ${JSON.stringify(labels[role])}`,
      );
    } else {
      seen.set(normalized, labelVariables[role]);
    }
  }

  const settings: Settings = {
    github: {
      repo: read.repo('GITHUB_REPO'),
      token: read.optionalString('GITHUB_TOKEN'),
    },
    devin: {
      apiKey: read.optionalString('DEVIN_API_KEY'),
      orgId: read.optionalString('DEVIN_ORG_ID'),
      review: read.boolean('DEVIN_REVIEW', true),
      maxActiveSessions: read.integer('MAX_ACTIVE_SESSIONS', 3, 1),
      maxAcuPerSession: read.integer('MAX_ACU_PER_SESSION', 5, 1),
    },
    checkCommand: read.optionalString('CHECK_COMMAND'),
    baselineFilter: read.optionalString('BASELINE_FILTER'),
    verify: {
      image: read.optionalString('VERIFY_IMAGE'),
      setupCommand: read.optionalString('VERIFY_SETUP_COMMAND'),
      timeoutSeconds: read.integer('VERIFY_TIMEOUT_SECONDS', 600, 1),
      workDir: read.string('VERIFY_WORK_DIR', DEFAULT_VERIFY_DIR),
    },
    labels,
    decision: read.enumeration('DECISION', POLICIES, 'person'),
    merge: read.enumeration('MERGE', POLICIES, 'person'),
    mergeMaxLines: read.integer('MERGE_MAX_LINES', 200, 1),
    maxFixRetries: read.integer('MAX_FIX_RETRIES', 1, 0),
    pollSeconds: read.integer('POLL_SECONDS', 60, 1),
    cost: {
      acuPriceUsd: read.decimal('DEVIN_ACU_PRICE_USD', { positive: true }),
      spendUsd: read.decimal('DEVIN_SPEND_USD', { positive: false }),
      spendReadAt: read.timestamp('DEVIN_SPEND_READ_AT'),
      budgetUsd: read.decimal('DEVIN_BUDGET_USD', { positive: false }),
    },
    server: {
      host: read.string('HOST', '127.0.0.1'),
      port: read.integer('PORT', 8080, 0, 65535),
      staticDir: read.string('STATIC_DIR', DEFAULT_STATIC_DIR),
    },
  };

  if (read.problems.length > 0) {
    throw new SettingsError(read.problems);
  }
  return settings;
}

/** Lists what is missing or invalid for live provider use. Never includes secret values. */
export function liveSettingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  if (settings.github.repo === null) problems.push('GITHUB_REPO is required in live mode (owner/name)');
  if (settings.github.token === null) problems.push('GITHUB_TOKEN is required in live mode');
  if (settings.devin.apiKey === null) problems.push('DEVIN_API_KEY is required in live mode');
  if (settings.devin.orgId === null) problems.push('DEVIN_ORG_ID is required in live mode');
  if (settings.checkCommand === null) {
    problems.push(`CHECK_COMMAND is required in live mode and must contain ${FILES_PLACEHOLDER}`);
  } else if (!settings.checkCommand.includes(FILES_PLACEHOLDER)) {
    problems.push(`CHECK_COMMAND must contain ${FILES_PLACEHOLDER}`);
  }
  return problems;
}

/** Throws `SettingsError` unless the settings are complete for live provider use. */
export function assertLiveSettings(settings: Settings): void {
  const problems = liveSettingsProblems(settings);
  if (problems.length > 0) {
    throw new SettingsError(problems, 'Settings are incomplete for live mode');
  }
}

export function effectiveSettings(settings: Settings): EffectiveSettings {
  return {
    github: {
      repo: settings.github.repo ? `${settings.github.repo.owner}/${settings.github.repo.name}` : null,
      tokenConfigured: settings.github.token !== null,
    },
    devin: {
      apiKeyConfigured: settings.devin.apiKey !== null,
      orgId: settings.devin.orgId,
      review: settings.devin.review,
      maxActiveSessions: settings.devin.maxActiveSessions,
      maxAcuPerSession: settings.devin.maxAcuPerSession,
    },
    checkCommand: settings.checkCommand,
    baselineFilter: settings.baselineFilter,
    verify: { ...settings.verify },
    labels: { ...settings.labels },
    decision: settings.decision,
    merge: settings.merge,
    mergeMaxLines: settings.mergeMaxLines,
    maxFixRetries: settings.maxFixRetries,
    pollSeconds: settings.pollSeconds,
    cost: { ...settings.cost },
    server: { ...settings.server },
  };
}
