import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runProcess, type ProcessResult } from '../../src/verify/process.ts';
import type { Sandbox, SandboxRuntime, SandboxSpec } from '../../src/verify/docker.ts';
import { GitRepository } from '../../src/verify/git.ts';
import { CheckedVerifier, type CheckedVerifierOptions } from '../../src/verify/verifier.ts';

const GIT_ENV = {
  PATH: process.env.PATH ?? '',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/** The buggy library every fixture starts from: `add` subtracts. */
export const BASE_FILES: Record<string, string> = {
  'package.json': '{ "name": "fixture", "type": "module" }\n',
  'src/math.mjs': [
    'export function add(a, b) {',
    '  if (a > 1000) return 0;',
    '  return a - b;',
    '}',
    '',
    'export function double(a) {',
    '  return a * 2;',
    '}',
    '',
  ].join('\n'),
  'test/double.test.mjs': [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { double } from '../src/math.mjs';",
    '',
    "test('doubles', () => {",
    '  assert.equal(double(2), 4);',
    '  assert.equal(double(0), 0);',
    '});',
    '',
    "test('doubles negatives', () => {",
    '  assert.equal(double(-2), -4);',
    '});',
    '',
  ].join('\n'),
  '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
};

export const ADD_TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/math.mjs';",
  '',
  "test('adds', () => {",
  '  assert.equal(add(1, 2), 3);',
  '});',
  '',
].join('\n');

export const FIXED_MATH = BASE_FILES['src/math.mjs']!.replace('return a - b;', 'return a + b;');

/** A git repository on disk with a `main` branch; PR heads are extra commits on top of the base. */
export class FixtureRepo {
  readonly dir: string;
  readonly base: string;

  private constructor(dir: string, base: string) {
    this.dir = dir;
    this.base = base;
  }

  static async create(root: string): Promise<FixtureRepo> {
    const dir = join(root, 'origin');
    await mkdir(dir, { recursive: true });
    git(dir, ['init', '--quiet', '--initial-branch=main']);
    const base = await commitFiles(dir, BASE_FILES, 'base');
    return new FixtureRepo(dir, base);
  }

  /** Commits `files` (content, or `null` to delete) on a new branch from `from` and returns the head SHA. */
  async head(branch: string, files: Record<string, string | null>, from = this.base): Promise<string> {
    git(this.dir, ['checkout', '--quiet', '-B', branch, from]);
    const sha = await commitFiles(this.dir, files, branch);
    git(this.dir, ['checkout', '--quiet', 'main']);
    return sha;
  }

  /** Commits a symbolic link at `path` pointing to `target` directly on main and returns the new main SHA. */
  async advanceMainWithLink(path: string, target: string): Promise<string> {
    git(this.dir, ['checkout', '--quiet', 'main']);
    const link = join(this.dir, path);
    await mkdir(dirname(link), { recursive: true });
    await symlink(target, link);
    return commitFiles(this.dir, {}, `link ${path}`);
  }

  /** Commits `files` directly on main and returns the new main SHA. */
  async advanceMain(files: Record<string, string | null>): Promise<string> {
    git(this.dir, ['checkout', '--quiet', 'main']);
    return commitFiles(this.dir, files, 'main moves on');
  }

  /**
   * A merge commit of `branch` into main (first parent: main). `overrides` are written into the merge result,
   * as when a merge combines two changes that do not work together.
   */
  async merge(branch: string, overrides: Record<string, string | null> = {}): Promise<string> {
    git(this.dir, ['checkout', '--quiet', 'main']);
    git(this.dir, ['merge', '--quiet', '--no-ff', '--no-commit', branch]);
    return commitFiles(this.dir, overrides, `merge ${branch}`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function commitFiles(dir: string, files: Record<string, string | null>, message: string): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await rm(target, { force: true });
    if (content !== null) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * Local stand-in for `DockerRuntime` in automated tests: runs the configured argv directly in the host
 * workspace with only `PATH` in the environment. Records every start and command, so tests can assert that
 * nothing ran.
 */
export class LocalRuntime implements SandboxRuntime {
  readonly live = false;
  readonly starts: SandboxSpec[] = [];
  readonly commands: string[][] = [];
  readonly envs: Record<string, string>[] = [];

  async start(spec: SandboxSpec): Promise<Sandbox> {
    this.starts.push(spec);
    const runtime = this;
    return {
      workspace: spec.workspace,
      results: spec.results,
      async exec(argv: readonly string[], timeoutMs: number): Promise<ProcessResult> {
        runtime.commands.push([...argv]);
        const env = { PATH: process.env.PATH ?? '' };
        runtime.envs.push(env);
        const [command, ...args] = argv;
        return runProcess(command ?? '', args, { cwd: spec.workspace, env, timeoutMs });
      },
      async isolate(): Promise<void> {},
      async dispose(): Promise<void> {},
    };
  }
}

export const NODE = process.execPath;
export const CHECK_COMMAND = `${NODE} --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={results} {files}`;

export interface VerifyWorld {
  root: string;
  repo: FixtureRepo;
  runtime: LocalRuntime;
  verifier: CheckedVerifier;
  close(): Promise<void>;
}

export async function verifyWorld(overrides: Partial<CheckedVerifierOptions> = {}): Promise<VerifyWorld> {
  const root = await mkdtemp(join(tmpdir(), 'bug-smasher-verify-'));
  const repo = await FixtureRepo.create(root);
  const runtime = new LocalRuntime();
  const verifier = new CheckedVerifier({
    repository: new GitRepository({ remote: repo.dir, dir: join(root, 'mirror.git') }),
    runtime,
    image: 'fixture/test-image:1',
    checkCommand: CHECK_COMMAND,
    setupCommand: null,
    timeoutSeconds: 20,
    workDir: join(root, 'runs'),
    ...overrides,
  });
  return { root, repo, runtime, verifier, close: () => rm(root, { recursive: true, force: true }) };
}
