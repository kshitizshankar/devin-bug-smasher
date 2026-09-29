import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { VerificationOutcome } from '../orchestrator/contracts.ts';
import type { SandboxRuntime } from '../verify/docker.ts';
import { GitRepository } from '../verify/git.ts';
import { CheckedVerifier } from '../verify/verifier.ts';

const run = promisify(execFile);

/** Node's built-in runner, which every Node image has; the fixture's tests use it. */
export const VERIFY_CHECK_COMMAND =
  'node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={results} {files}';
const TEST_FILE = 'test/add.test.mjs';

const BUGGY = 'export function add(a, b) {\n  return a - b;\n}\n';
const FIXED = 'export function add(a, b) {\n  return a + b;\n}\n';
const TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.mjs';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(1, 2), 3);',
  '});',
  '',
].join('\n');

export interface VerifyCheckOptions {
  runtime: SandboxRuntime;
  /** Image with `node` on its PATH. */
  image: string;
  /** Parent of the disposable fixture and workspaces: `VERIFY_WORK_DIR`. */
  workDir: string;
  timeoutSeconds: number;
  checkCommand?: string;
}

export interface VerifyCheckResult {
  outcome: VerificationOutcome;
  baseSha: string;
  headSha: string;
  /** Where the fixture and workspaces were created (removed afterwards). */
  root: string;
}

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Bug Smasher verify-check',
  GIT_AUTHOR_EMAIL: 'verify-check@localhost',
  GIT_COMMITTER_NAME: 'Bug Smasher verify-check',
  GIT_COMMITTER_EMAIL: 'verify-check@localhost',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...GIT_ENV } });
  return stdout.trim();
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git(dir, ['add', '--all']);
  await git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

/**
 * Proves the verification path end to end on this host: a throwaway git repository whose base has a bug and
 * whose head fixes it with a regression test, verified by the real `CheckedVerifier` through `runtime`.
 * With `DockerRuntime` the tests run in sibling containers of `image`, reading workspaces under `workDir`,
 * which must be the same absolute path for this process and the Docker daemon. No network or credential is used.
 */
export async function verifyCheck(options: VerifyCheckOptions): Promise<VerifyCheckResult> {
  const workDir = resolve(options.workDir);
  await mkdir(workDir, { recursive: true });
  const root = await mkdtemp(join(workDir, 'verify-check-'));
  try {
    const origin = join(root, 'origin');
    await mkdir(origin);
    await git(origin, ['init', '--quiet', '--initial-branch=main']);
    const baseSha = await commit(origin, { 'package.json': '{ "name": "verify-check", "type": "module" }\n', 'src/math.mjs': BUGGY }, 'base: add subtracts');
    await git(origin, ['checkout', '--quiet', '-b', 'fix']);
    const headSha = await commit(origin, { 'src/math.mjs': FIXED, [TEST_FILE]: TEST }, 'fix: add adds');
    const verifier = new CheckedVerifier({
      repository: new GitRepository({ remote: origin, dir: join(root, 'mirror.git') }),
      runtime: options.runtime,
      image: options.image,
      checkCommand: options.checkCommand ?? VERIFY_CHECK_COMMAND,
      setupCommand: null,
      timeoutSeconds: options.timeoutSeconds,
      workDir: join(root, 'runs'),
    });
    const outcome = await verifier.verify({
      bugKey: 'verify-check/fixture#1',
      phase: 'pre-merge',
      prNumber: 1,
      prUrl: 'https://github.com/verify-check/fixture/pull/1',
      headSha,
      baseSha,
      testFiles: [TEST_FILE],
    });
    return { outcome, baseSha, headSha, root };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
