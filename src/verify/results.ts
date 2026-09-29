import type { RunOutcome } from '../model/types.ts';
import type { ProcessResult } from './process.ts';

export interface JUnitSummary {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failedNames: string[];
  messages: string[];
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Reads a JUnit XML report. Returns `null` when the text is not a JUnit report. */
export function parseJUnit(xml: string): JUnitSummary | null {
  if (!/<testsuites?\b/.test(xml)) return null;
  const summary: JUnitSummary = { tests: 0, failures: 0, errors: 0, skipped: 0, failedNames: [], messages: [] };
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const name = decode(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? '');
    summary.tests += 1;
    if (/<error\b/.test(body)) {
      summary.errors += 1;
      summary.failedNames.push(name);
      summary.messages.push(decode(body));
    } else if (/<failure\b/.test(body)) {
      summary.failures += 1;
      summary.failedNames.push(name);
      summary.messages.push(decode(body));
    } else if (/<skipped\b/.test(body)) {
      summary.skipped += 1;
    }
  }
  return summary;
}

const MISSING_DEPENDENCY = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find (?:module|package)\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /No module named\b/,
  /\bLoadError\b/,
  /cannot find package\b/,
];

export interface Classification {
  outcome: RunOutcome;
  reason: string;
}

/** Classifies a setup step: it either completed or is an error; it never produces a test result. */
export function classifySetup(result: ProcessResult, timeoutSeconds: number): Classification {
  if (result.spawnError !== null) return { outcome: 'error', reason: `setup could not start: ${result.spawnError}` };
  if (result.timedOut) return { outcome: 'error', reason: `setup timed out after ${timeoutSeconds} s` };
  if (result.exitCode === null) return { outcome: 'error', reason: `setup crashed (signal ${result.signal ?? 'unknown'})` };
  if (result.exitCode !== 0) return { outcome: 'error', reason: `setup failed with exit code ${result.exitCode}` };
  return { outcome: 'passed', reason: 'setup completed' };
}

/**
 * Classifies a test step from its exit status, its output and the JUnit report it wrote. Only a readable
 * report with real test failures is `failed`; anything that prevented the tests from running is `error`.
 */
export function classifyTests(
  result: ProcessResult,
  report: string | null,
  selected: readonly string[],
  timeoutSeconds: number,
): Classification {
  if (result.spawnError !== null) return { outcome: 'error', reason: `the test run could not start: ${result.spawnError}` };
  if (result.timedOut) return { outcome: 'error', reason: `the test run timed out after ${timeoutSeconds} s` };
  if (result.exitCode === null) return { outcome: 'error', reason: `the test run crashed (signal ${result.signal ?? 'unknown'})` };
  if (result.exitCode >= 125) return { outcome: 'error', reason: `the test run crashed (exit code ${result.exitCode})` };
  if (report === null) return { outcome: 'error', reason: 'the test results could not be read: no JUnit report was written' };
  const summary = parseJUnit(report);
  if (summary === null) return { outcome: 'error', reason: 'the test results could not be read: the report is not JUnit XML' };
  const evidence = [result.output, ...summary.messages].join('\n');
  if (summary.failures + summary.errors > 0 && MISSING_DEPENDENCY.some((pattern) => pattern.test(evidence))) {
    return { outcome: 'error', reason: 'an import or dependency is missing, so the tests did not run' };
  }
  if (summary.tests === 0) return { outcome: 'error', reason: 'no tests ran' };
  if (summary.errors > 0) return { outcome: 'error', reason: `${summary.errors} test(s) errored outside their assertions` };
  const names = new Set(selected.flatMap((path) => [path, path.split('/').at(-1) ?? path]));
  if (summary.failedNames.some((name) => names.has(name))) {
    return { outcome: 'error', reason: 'a test file failed to load or crashed outside any test' };
  }
  if (summary.skipped === summary.tests) return { outcome: 'error', reason: 'every test was skipped' };
  if (summary.failures > 0) {
    if (result.exitCode === 0) {
      return { outcome: 'error', reason: `the results report ${summary.failures} failure(s) but the runner exited 0` };
    }
    return { outcome: 'failed', reason: `${summary.failures} of ${summary.tests} test(s) failed` };
  }
  if (result.exitCode !== 0) {
    return { outcome: 'error', reason: `the runner exited ${result.exitCode} but the results report no failure` };
  }
  return { outcome: 'passed', reason: `${summary.tests} test(s) passed` };
}
