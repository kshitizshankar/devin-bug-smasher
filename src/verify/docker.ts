import { randomBytes } from 'node:crypto';
import { pickEnv, runProcess, type ProcessResult } from './process.ts';

/** A disposable container with a workspace and a results directory mounted from the host. */
export interface Sandbox {
  /** Workspace path as seen by commands in the sandbox. */
  readonly workspace: string;
  /** Results directory as seen by commands in the sandbox; the host copy is read after the run. */
  readonly results: string;
  exec(argv: readonly string[], timeoutMs: number): Promise<ProcessResult>;
  /** Cuts network access after dependency preparation, before any test runs. */
  isolate(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxSpec {
  image: string;
  /** Host directories. */
  workspace: string;
  results: string;
  /** Network during setup; tests always run after `isolate()` or without a network from the start. */
  network: boolean;
  lifetimeSeconds: number;
  startTimeoutMs: number;
}

export interface SandboxRuntime {
  /** False for local stand-ins used by tests. */
  readonly live: boolean;
  start(spec: SandboxSpec): Promise<Sandbox>;
}

export class SandboxError extends Error {}

/** Variables the Docker CLI itself needs. No other service variable (tokens, API keys) reaches it. */
export const DOCKER_CLI_ENV = [
  'PATH',
  'HOME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
] as const;

const CONTAINER_WORKSPACE = '/workspace';
const CONTAINER_RESULTS = '/bug-smasher-results';

export interface DockerRuntimeOptions {
  docker?: string;
  /** Environment the CLI variables are picked from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs verification in a container of the target repository's test image on this host. The container gets
 * no environment variables from the service (`docker run` passes none unless asked, and none are asked).
 */
export class DockerRuntime implements SandboxRuntime {
  readonly live = true;
  readonly #docker: string;
  readonly #env: Record<string, string>;

  constructor(options: DockerRuntimeOptions = {}) {
    this.#docker = options.docker ?? 'docker';
    this.#env = pickEnv(options.env ?? process.env, DOCKER_CLI_ENV);
  }

  #cli(args: string[], timeoutMs: number): Promise<ProcessResult> {
    return runProcess(this.#docker, args, { env: this.#env, timeoutMs });
  }

  async start(spec: SandboxSpec): Promise<Sandbox> {
    const name = `bug-smasher-verify-${randomBytes(6).toString('hex')}`;
    const started = await this.#cli(
      [
        'run',
        '--detach',
        '--name',
        name,
        '--label',
        'bug-smasher.verification=true',
        '--network',
        spec.network ? 'bridge' : 'none',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '1024',
        '--mount',
        `type=bind,source=${spec.workspace},target=${CONTAINER_WORKSPACE}`,
        '--mount',
        `type=bind,source=${spec.results},target=${CONTAINER_RESULTS}`,
        '--workdir',
        CONTAINER_WORKSPACE,
        '--entrypoint',
        'sleep',
        spec.image,
        String(spec.lifetimeSeconds),
      ],
      spec.startTimeoutMs,
    );
    if (started.timedOut || started.exitCode !== 0) {
      await this.#cli(['rm', '--force', name], 30_000);
      const detail = started.spawnError ?? (started.timedOut ? 'timed out' : started.output.trim().split('\n').slice(-2).join(' '));
      throw new SandboxError(`could not start a container from ${spec.image}: ${detail}`);
    }
    return new DockerSandbox(name, spec.network, (args, timeoutMs) => this.#cli(args, timeoutMs));
  }
}

class DockerSandbox implements Sandbox {
  readonly workspace = CONTAINER_WORKSPACE;
  readonly results = CONTAINER_RESULTS;
  readonly #name: string;
  #connected: boolean;
  #removed = false;
  readonly #cli: (args: string[], timeoutMs: number) => Promise<ProcessResult>;

  constructor(name: string, connected: boolean, cli: (args: string[], timeoutMs: number) => Promise<ProcessResult>) {
    this.#name = name;
    this.#connected = connected;
    this.#cli = cli;
  }

  async exec(argv: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    if (this.#removed) throw new SandboxError('the container was already removed');
    const executed = await this.#cli(['exec', this.#name, ...argv], timeoutMs);
    if (executed.timedOut) await this.#remove();
    return executed;
  }

  async isolate(): Promise<void> {
    if (!this.#connected) return;
    const result = await this.#cli(['network', 'disconnect', 'bridge', this.#name], 60_000);
    if (result.exitCode !== 0) throw new SandboxError(`could not disconnect the container network: ${result.output.trim()}`);
    this.#connected = false;
  }

  async #remove(): Promise<void> {
    if (this.#removed) return;
    this.#removed = true;
    await this.#cli(['rm', '--force', this.#name], 60_000);
  }

  async dispose(): Promise<void> {
    if (!this.#removed && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
      const owner = `${process.getuid()}:${process.getgid()}`;
      await this.#cli(['exec', '--user', '0', this.#name, 'chown', '-R', owner, CONTAINER_WORKSPACE, CONTAINER_RESULTS], 120_000);
    }
    await this.#remove();
  }
}
