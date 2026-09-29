import { createHash } from 'node:crypto';
import { validateTriageFindings } from '../model/validate.ts';
import { CONFIDENCES, RECOMMENDATIONS, type TriageFindings } from '../model/types.ts';

/**
 * The session-wide structured-output schema (spec Appendix B). It is set on every session with
 * `structured_output_required: false`, so Devin can ask a question before it has a result.
 */
export const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    phase: { type: 'string', enum: ['triage', 'fix'] },
    status: { type: 'string', enum: ['needs_input', 'triage_complete', 'pr_opened', 'blocked'] },
    question: { type: 'string' },
    title: { type: 'string', description: 'A precise title for the bug' },
    summary: { type: 'string', description: 'The bug rewritten precisely' },
    steps_to_reproduce: { type: 'array', items: { type: 'string' } },
    expected: { type: 'string' },
    actual: { type: 'string' },
    suspected_cause: { type: 'string' },
    affected_files: { type: 'array', items: { type: 'string' } },
    reproduced: { type: 'boolean' },
    reproduction_notes: { type: 'string' },
    proposed_check: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        test_file: { type: 'string' },
        command: { type: 'string' },
      },
    },
    bucket: { type: 'string', enum: ['devin_fix', 'needs_engineer', 'close'] },
    bucket_reason: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    pr_url: { type: 'string' },
    test_files: { type: 'array', items: { type: 'string' } },
    fix_summary: { type: 'string' },
  },
  required: ['phase', 'status'],
} as const;

export const STRUCTURED_PHASES = ['triage', 'fix'] as const;
export type StructuredPhase = (typeof STRUCTURED_PHASES)[number];
export const STRUCTURED_STATUSES = ['needs_input', 'triage_complete', 'pr_opened', 'blocked'] as const;
export type StructuredStatus = (typeof STRUCTURED_STATUSES)[number];

/** A structured output that matched the schema's types. Fields Devin has not filled in are absent. */
export interface StructuredOutput {
  phase: StructuredPhase;
  status: StructuredStatus;
  question?: string;
  title?: string;
  summary?: string;
  steps_to_reproduce?: string[];
  expected?: string;
  actual?: string;
  suspected_cause?: string;
  affected_files?: string[];
  reproduced?: boolean;
  reproduction_notes?: string;
  proposed_check?: { description?: string; test_file?: string; command?: string };
  bucket?: (typeof RECOMMENDATIONS)[number];
  bucket_reason?: string;
  confidence?: (typeof CONFIDENCES)[number];
  pr_url?: string;
  test_files?: string[];
  fix_summary?: string;
}

export interface PullRequestRef {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/** What a complete structured output asks the service to do. Only a `valid` result carries one. */
export type StructuredSignal =
  | { type: 'needs-input'; phase: StructuredPhase; questionId: string; question: string }
  | { type: 'blocked'; phase: StructuredPhase; questionId: string; question: string }
  | { type: 'triage-complete'; findings: TriageFindings }
  | { type: 'pr-opened'; pullRequest: PullRequestRef; testFiles: string[]; summary: string };

/**
 * Interpretation of a session's `structured_output`. Only `valid` may drive the model: `absent`,
 * `invalid` and `incomplete` mean "no decision yet", never completion.
 */
export type StructuredOutputResult =
  | { status: 'absent' }
  | { status: 'invalid'; problems: string[] }
  | { status: 'incomplete'; output: StructuredOutput; missing: string[] }
  | { status: 'valid'; output: StructuredOutput; signal: StructuredSignal };

const STRING_FIELDS = [
  'question',
  'title',
  'summary',
  'expected',
  'actual',
  'suspected_cause',
  'reproduction_notes',
  'bucket_reason',
  'pr_url',
  'fix_summary',
] as const;
const STRING_ARRAY_FIELDS = ['steps_to_reproduce', 'affected_files', 'test_files'] as const;
const PROPOSED_CHECK_FIELDS = ['description', 'test_file', 'command'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function checkTypes(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (!oneOf(raw.phase, STRUCTURED_PHASES)) problems.push(`phase must be one of ${STRUCTURED_PHASES.join(', ')}`);
  if (!oneOf(raw.status, STRUCTURED_STATUSES)) problems.push(`status must be one of ${STRUCTURED_STATUSES.join(', ')}`);
  for (const field of STRING_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') problems.push(`${field} must be a string`);
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const value = raw[field];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
      problems.push(`${field} must be an array of strings`);
    }
  }
  if (raw.reproduced !== undefined && typeof raw.reproduced !== 'boolean') problems.push('reproduced must be a boolean');
  if (raw.bucket !== undefined && !oneOf(raw.bucket, RECOMMENDATIONS)) {
    problems.push(`bucket must be one of ${RECOMMENDATIONS.join(', ')}`);
  }
  if (raw.confidence !== undefined && !oneOf(raw.confidence, CONFIDENCES)) {
    problems.push(`confidence must be one of ${CONFIDENCES.join(', ')}`);
  }
  if (raw.proposed_check !== undefined) {
    const check = raw.proposed_check;
    if (!isRecord(check)) problems.push('proposed_check must be an object');
    else {
      for (const field of PROPOSED_CHECK_FIELDS) {
        if (check[field] !== undefined && typeof check[field] !== 'string') {
          problems.push(`proposed_check.${field} must be a string`);
        }
      }
    }
  }
  if (raw.status === 'triage_complete' && raw.phase === 'fix') problems.push('triage_complete requires phase triage');
  if (raw.status === 'pr_opened' && raw.phase === 'triage') problems.push('pr_opened requires phase fix');
  return problems;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/;

export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = GITHUB_PR_URL.exec(url.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return { url: url.trim(), owner: match[1], repo: match[2], number: Number(match[3]) };
}

/** Stable id for a question, so re-reading the same output yields the same id. */
export function questionId(sessionId: string, question: string): string {
  return `q-${createHash('sha256').update(`${sessionId}\n${question.trim()}`).digest('hex').slice(0, 16)}`;
}

function triageFindings(output: StructuredOutput, missing: string[]): TriageFindings | null {
  const required = [
    'title',
    'summary',
    'steps_to_reproduce',
    'expected',
    'actual',
    'suspected_cause',
    'affected_files',
    'reproduced',
    'reproduction_notes',
    'proposed_check',
    'bucket',
    'bucket_reason',
    'confidence',
  ] as const;
  for (const field of required) if (output[field] === undefined) missing.push(field);
  const check = output.proposed_check;
  if (check !== undefined) {
    for (const field of PROPOSED_CHECK_FIELDS) if (check[field] === undefined) missing.push(`proposed_check.${field}`);
  }
  if (output.title !== undefined && !nonEmpty(output.title)) missing.push('title');
  if (missing.length > 0) return null;
  const findings: TriageFindings = {
    title: output.title ?? '',
    summary: output.summary ?? '',
    reproductionSteps: [...(output.steps_to_reproduce ?? [])],
    expectedBehavior: output.expected ?? '',
    actualBehavior: output.actual ?? '',
    suspectedCause: output.suspected_cause ?? '',
    affectedFiles: [...(output.affected_files ?? [])],
    reproduced: output.reproduced ?? false,
    reproductionNotes: output.reproduction_notes ?? '',
    proposedTest: {
      description: check?.description ?? '',
      file: check?.test_file ?? '',
      command: check?.command ?? '',
    },
    recommendation: output.bucket ?? 'needs_engineer',
    reason: output.bucket_reason ?? '',
    confidence: output.confidence ?? 'low',
  };
  missing.push(...validateTriageFindings(findings, 'findings'));
  return missing.length > 0 ? null : findings;
}

/**
 * Validates a session's raw `structured_output` against the schema and decides whether it is complete
 * enough to act on. Free-text session messages are never consulted.
 */
export function interpretStructuredOutput(sessionId: string, raw: unknown): StructuredOutputResult {
  if (raw === null || raw === undefined) return { status: 'absent' };
  if (!isRecord(raw)) return { status: 'invalid', problems: ['structured output must be an object'] };
  const problems = checkTypes(raw);
  if (problems.length > 0) return { status: 'invalid', problems };
  const output = structuredClone(raw) as unknown as StructuredOutput;
  const missing: string[] = [];

  switch (output.status) {
    case 'needs_input':
    case 'blocked': {
      if (!nonEmpty(output.question)) return { status: 'incomplete', output, missing: ['question'] };
      const question = output.question.trim();
      return {
        status: 'valid',
        output,
        signal: {
          type: output.status === 'needs_input' ? 'needs-input' : 'blocked',
          phase: output.phase,
          questionId: questionId(sessionId, question),
          question,
        },
      };
    }
    case 'triage_complete': {
      const findings = triageFindings(output, missing);
      if (findings === null) return { status: 'incomplete', output, missing };
      return { status: 'valid', output, signal: { type: 'triage-complete', findings } };
    }
    case 'pr_opened': {
      const pullRequest = output.pr_url === undefined ? null : parsePullRequestUrl(output.pr_url);
      if (pullRequest === null) missing.push('pr_url (a https://github.com/<owner>/<repo>/pull/<n> URL)');
      if (!nonEmpty(output.fix_summary)) missing.push('fix_summary');
      if (pullRequest === null || missing.length > 0) return { status: 'incomplete', output, missing };
      return {
        status: 'valid',
        output,
        signal: {
          type: 'pr-opened',
          pullRequest,
          testFiles: [...(output.test_files ?? [])],
          summary: output.fix_summary ?? '',
        },
      };
    }
  }
}
