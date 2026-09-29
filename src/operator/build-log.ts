/**
 * Step-by-step reading of a Devin environment build log. The log file's format is not documented (the API
 * only returns a presigned download link), so two line shapes are recognised and anything else is ignored:
 *
 * - JSON Lines: an object with a step name (`step`, `name` or `title`), an outcome (`status`, `result`,
 *   `outcome`, `conclusion` and/or `exit_code`), an optional parent path (`path` array or `parent`/`group`
 *   string) and optional nested `steps`.
 * - Text: `step <name>: <outcome>` or `step <name> <outcome>`, optionally prefixed by a timestamp or `[...]`
 *   tags and followed by `exit code N`. A name may be a path, `a > b > c`.
 *
 * A step seen several times keeps its last outcome. A log with no recognised step is `recognised: false`,
 * which never counts as a clean build.
 */

export type StepOutcome = 'passed' | 'failed' | 'skipped' | 'running';

export interface BuildStep {
  path: string[];
  outcome: StepOutcome;
  exitCode: number | null;
  /** 1-based log line where the step's latest outcome was reported. */
  line: number;
}

export interface BuildLog {
  steps: BuildStep[];
  recognised: boolean;
}

const OUTCOMES: Record<string, StepOutcome> = {
  failed: 'failed',
  failure: 'failed',
  fail: 'failed',
  error: 'failed',
  errored: 'failed',
  'timed out': 'failed',
  timed_out: 'failed',
  timeout: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
  succeeded: 'passed',
  success: 'passed',
  successful: 'passed',
  passed: 'passed',
  ok: 'passed',
  completed: 'passed',
  done: 'passed',
  skipped: 'skipped',
  running: 'running',
  started: 'running',
  pending: 'running',
  in_progress: 'running',
};

const TEXT_STEP =
  /^step\s+["']?(.+?)["']?\s*(?::\s*|\s+)(failed|failure|errored|error|timed out|cancelled|canceled|succeeded|successful|success|passed|ok|completed|done|skipped|running|started)\b(.*)$/i;
const EXIT_CODE = /exit(?:ed)?(?: with)?(?: exit)? code[:\s]+(-?\d+)/i;
const PREFIX = /^(?:\[[^\]]*\]\s*|\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s*|\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*)+/;

function outcomeOf(status: unknown, exitCode: number | null): StepOutcome | null {
  const named = typeof status === 'string' ? (OUTCOMES[status.trim().toLowerCase()] ?? null) : null;
  if (exitCode !== null && exitCode !== 0) return 'failed';
  if (named !== null) return named;
  return exitCode === 0 ? 'passed' : null;
}

function splitPath(name: string): string[] {
  return name
    .split(/\s+[>›]\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBuildLog(text: string): BuildLog {
  const byPath = new Map<string, BuildStep>();
  const record = (path: string[], outcome: StepOutcome, exitCode: number | null, line: number): void => {
    if (path.length === 0) return;
    const key = path.join('\u0000');
    const existing = byPath.get(key);
    if (existing === undefined) byPath.set(key, { path, outcome, exitCode, line });
    else Object.assign(existing, { outcome, exitCode: exitCode ?? (outcome === existing.outcome ? existing.exitCode : null), line });
  };
  const fromJson = (item: Record<string, unknown>, parent: string[], line: number): void => {
    const name = [item.step, item.name, item.title].find((value): value is string => typeof value === 'string' && value.trim() !== '');
    const exitCode = typeof item.exit_code === 'number' && Number.isInteger(item.exit_code) ? item.exit_code : null;
    const base =
      Array.isArray(item.path) && item.path.every((part) => typeof part === 'string')
        ? [...parent, ...(item.path as string[])]
        : [...parent, ...[item.parent, item.group].filter((value): value is string => typeof value === 'string' && value !== '')];
    const path = name === undefined ? base : [...base, ...splitPath(name)];
    const outcome = outcomeOf(item.status ?? item.result ?? item.outcome ?? item.conclusion, exitCode);
    if (name !== undefined && outcome !== null) record(path, outcome, exitCode, line);
    if (Array.isArray(item.steps)) for (const child of item.steps) if (isRecord(child)) fromJson(child, path, line);
  };

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRecord(parsed)) fromJson(parsed, [], index + 1);
        return;
      } catch {
        // Not JSON; fall through to the text shape.
      }
    }
    const match = TEXT_STEP.exec(line.replace(PREFIX, ''));
    if (match === null) return;
    const exit = EXIT_CODE.exec(match[3] ?? '');
    const exitCode = exit?.[1] === undefined ? null : Number(exit[1]);
    const outcome = outcomeOf(match[2], exitCode);
    if (outcome !== null) record(splitPath(match[1] ?? ''), outcome, exitCode, index + 1);
  });
  const steps = [...byPath.values()];
  return { steps, recognised: steps.length > 0 };
}

/** Failed steps, innermost only: a parent that failed because a nested step failed is not listed twice. */
export function failedSteps(log: BuildLog): BuildStep[] {
  const failed = log.steps.filter((step) => step.outcome === 'failed');
  return failed.filter(
    (step) => !failed.some((other) => other !== step && other.path.length > step.path.length && step.path.every((part, i) => other.path[i] === part)),
  );
}
