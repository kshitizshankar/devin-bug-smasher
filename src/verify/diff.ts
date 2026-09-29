import type { DiffFinding } from '../model/types.ts';
import { isConfigPath, isTestPath } from './paths.ts';

/** One file changed between the merge base and the pull request head, with both full contents. */
export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** `null` for binary files. */
  additions: number | null;
  deletions: number | null;
  /** Content at the merge base; `null` when the file did not exist there. */
  base: string | null;
  /** Content at the head; `null` when the file was deleted. */
  head: string | null;
}

export interface DiffReport {
  violations: DiffFinding[];
  flags: DiffFinding[];
}

const TEST_DECLARATIONS = [
  /\b(?:it|test|describe|context|suite|specify)(?:\.\w+)*\s*\(\s*(['"`])(.+?)\1/g,
  /^\s*(?:async\s+)?def\s+(test\w*)\s*\(/gm,
  /^\s*func\s+(Test\w*)\s*\(/gm,
];

const DISABLE_MARKERS = [
  /\b(?:it|test|describe|context|suite|specify)\.(?:skip|only|todo|fixme)\b/g,
  /\b[xf](?:it|describe|test|context|specify)\s*\(/g,
  /\bpytest\.mark\.(?:skip|skipif|xfail)\b/g,
  /\bpytest\.(?:skip|xfail)\s*\(/g,
  /\bunittest\.(?:skip\w*|expectedFailure)\b/g,
  /@(?:Disabled|Ignore)\b/g,
  /\bt\.Skip(?:Now|f)?\s*\(/g,
  /[{,]\s*(?:skip|todo|only)\s*:\s*(?!false\b)[^,}\s]/g,
];

const ASSERTIONS = [
  /\bassert(?:[._]?[A-Za-z]\w*)*\s*\(/g,
  /^\s*assert\s/gm,
  /\bexpect\s*\(/g,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\brequire\.\w+\s*\(/g,
  /\.should\b/g,
];

const SUPPRESSIONS = [
  /#\s*noqa\b/g,
  /#\s*type:\s*ignore\b/g,
  /#\s*pyright:\s*ignore\b/g,
  /\bpylint:\s*disable\b/g,
  /\beslint-disable\b/g,
  /@ts-ignore\b/g,
  /@ts-expect-error\b/g,
  /@ts-nocheck\b/g,
  /\bbiome-ignore\b/g,
  /\/\/\s*nolint\b/g,
  /\bistanbul\s+ignore\b/g,
  /\bc8\s+ignore\b/g,
  /\bpragma:\s*no\s*cover\b/g,
  /\brubocop:disable\b/g,
  /@SuppressWarnings\b/g,
];

function count(text: string | null, patterns: readonly RegExp[]): number {
  if (text === null) return 0;
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

function testNames(text: string | null): Set<string> {
  const names = new Set<string>();
  if (text === null) return names;
  for (const pattern of TEST_DECLARATIONS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[2] ?? match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * Checks a pull request's changes for ways a test run can pass while the bug survives. Each violation fails
 * verification with its own reason; a change outside tests that only deletes lines is a flag, not a failure.
 */
export function checkChanges(changes: readonly FileChange[]): DiffReport {
  const violations: DiffFinding[] = [];
  const flags: DiffFinding[] = [];
  let sourceAdditions = 0;
  let sourceDeletions = 0;
  let sourceFiles = 0;

  for (const change of changes) {
    const file = change.path;
    if (isConfigPath(file)) {
      violations.push({ check: 'rules-changed', file, detail: `test, lint, type-check or CI configuration ${change.status}` });
    }

    const silenced = count(change.head, SUPPRESSIONS) - count(change.base, SUPPRESSIONS);
    if (silenced > 0) {
      violations.push({ check: 'check-silenced', file, detail: `${silenced} suppression comment(s) added` });
    }

    if (isTestPath(file)) {
      if (change.status === 'deleted') {
        violations.push({ check: 'test-removed', file, detail: 'test file deleted' });
        continue;
      }
      const before = testNames(change.base);
      const after = testNames(change.head);
      const removed = [...before].filter((name) => !after.has(name));
      if (removed.length > 0) {
        violations.push({ check: 'test-removed', file, detail: `test(s) removed: ${removed.join(', ')}` });
      }
      const markers = count(change.head, DISABLE_MARKERS) - count(change.base, DISABLE_MARKERS);
      if (markers > 0) {
        violations.push({ check: 'test-disabled', file, detail: `${markers} skip, expected-failure or only marker(s) added` });
      }
      if (change.status === 'modified' && removed.length === 0) {
        const assertionsBefore = count(change.base, ASSERTIONS);
        const assertionsAfter = count(change.head, ASSERTIONS);
        if (assertionsAfter < assertionsBefore) {
          violations.push({
            check: 'test-weakened',
            file,
            detail: `assertions dropped from ${assertionsBefore} to ${assertionsAfter}`,
          });
        }
      }
      continue;
    }

    if (!isConfigPath(file)) {
      sourceFiles += 1;
      sourceAdditions += change.additions ?? 0;
      sourceDeletions += change.deletions ?? 0;
    }
  }

  if (sourceFiles > 0 && sourceAdditions === 0 && sourceDeletions > 0) {
    flags.push({
      check: 'deletion-only',
      file: '',
      detail: `the change outside tests only removes lines (${sourceDeletions} removed, none added); review before merging`,
    });
  }
  return { violations, flags };
}

export function describeFinding(finding: DiffFinding): string {
  return finding.file === '' ? `${finding.check}: ${finding.detail}` : `${finding.check} in ${finding.file}: ${finding.detail}`;
}
