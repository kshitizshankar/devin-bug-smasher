import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pickEnv } from './process.ts';

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const FETCH_REFSPECS = ['+refs/heads/*:refs/remotes/origin/heads/*', '+refs/pull/*/head:refs/remotes/origin/pull/*'];

export class GitError extends Error {}

export interface ChangedPath {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number | null;
  deletions: number | null;
}

export interface GitRepositoryOptions {
  /** Clone URL of the target repository, or a local path (fixtures). */
  remote: string;
  /** Local bare mirror used to resolve commits and export disposable workspaces. */
  dir: string;
  /** GitHub token for private repositories; sent as an HTTP header, never stored in git config or logged. */
  token?: string | null;
}

/**
 * A local bare mirror of the target repository. Commits are resolved to exact SHAs here and workspaces are
 * exported with `git archive`, so workspaces contain no `.git` directory, remote URL or credential.
 */
export class GitRepository {
  readonly #remote: string;
  readonly #dir: string;
  readonly #token: string | null;

  constructor(options: GitRepositoryOptions) {
    this.#remote = options.remote;
    this.#dir = options.dir;
    this.#token = options.token ?? null;
  }

  #env(auth: boolean): Record<string, string> {
    const env: Record<string, string> = {
      ...pickEnv(process.env, ['PATH', 'HOME', 'TMPDIR']),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    if (auth && this.#token !== null) {
      const basic = Buffer.from(`x-access-token:${this.#token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
    return env;
  }

  #redact(text: string): string {
    return this.#token === null ? text : text.split(this.#token).join('[redacted]');
  }

  async #git(args: string[], options: { auth?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await run('git', ['--git-dir', this.#dir, ...args], {
        env: this.#env(options.auth ?? false),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error);
      throw new GitError(this.#redact(`git ${args[0]} failed: ${detail.split('\n').slice(-3).join(' ')}`));
    }
  }

  async #has(sha: string): Promise<boolean> {
    try {
      await this.#git(['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Makes sure every SHA is present locally, fetching from the remote only when one is missing. */
  async ensure(shas: readonly string[]): Promise<void> {
    for (const sha of shas) if (!SHA.test(sha)) throw new GitError(`${sha} is not a full commit SHA`);
    if (!existsSync(this.#dir)) {
      await mkdir(this.#dir, { recursive: true });
      await this.#git(['init', '--bare', '--quiet']);
    }
    const missing = [];
    for (const sha of shas) if (!(await this.#has(sha))) missing.push(sha);
    if (missing.length === 0) return;
    await this.#git(['fetch', '--quiet', '--no-tags', '--', this.#remote, ...FETCH_REFSPECS], { auth: true });
    for (const sha of missing) {
      if (!(await this.#has(sha))) throw new GitError(`commit ${sha} is not available in ${this.#remote}`);
    }
  }

  async firstParent(sha: string): Promise<string> {
    return (await this.#git(['rev-parse', '--verify', `${sha}^1^{commit}`])).trim();
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.#git(['merge-base', a, b])).trim();
  }

  async changes(base: string, head: string): Promise<ChangedPath[]> {
    const names = (await this.#git(['diff', '--no-renames', '--name-status', '-z', base, head])).split('\0');
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const entry of (await this.#git(['diff', '--no-renames', '--numstat', '-z', base, head])).split('\0')) {
      const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(entry);
      if (match?.[3] === undefined) continue;
      counts.set(match[3], {
        additions: match[1] === '-' ? null : Number(match[1]),
        deletions: match[2] === '-' ? null : Number(match[2]),
      });
    }
    const changes: ChangedPath[] = [];
    for (let index = 0; index + 1 < names.length; index += 2) {
      const code = names[index] ?? '';
      const path = names[index + 1] ?? '';
      if (path === '') continue;
      const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
      changes.push({ path, status, ...(counts.get(path) ?? { additions: null, deletions: null }) });
    }
    return changes;
  }

  /** File content at a commit, or `null` when the path does not exist there. */
  async show(sha: string, path: string): Promise<string | null> {
    try {
      return await this.#git(['cat-file', 'blob', `${sha}:${path}`]);
    } catch {
      return null;
    }
  }

  /** Writes the tree of `sha` into `dest` (an existing empty directory). */
  async exportTree(sha: string, dest: string): Promise<void> {
    const env = this.#env(false);
    await new Promise<void>((resolve, reject) => {
      const archive = spawn('git', ['--git-dir', this.#dir, 'archive', '--format=tar', sha], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const tar = spawn('tar', ['-x', '-f', '-', '-C', dest], { env, stdio: ['pipe', 'ignore', 'pipe'] });
      let errors = '';
      archive.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
      tar.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
      archive.stdout.pipe(tar.stdin);
      let pending = 2;
      let failed = false;
      const done = (code: number | null): void => {
        if (code !== 0) failed = true;
        pending -= 1;
        if (pending > 0) return;
        if (failed) reject(new GitError(`could not export ${sha}: ${errors.trim()}`));
        else resolve();
      };
      archive.on('error', reject);
      tar.on('error', reject);
      archive.on('close', done);
      tar.on('close', done);
    });
  }
}
