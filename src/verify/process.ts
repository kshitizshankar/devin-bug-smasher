import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Combined stdout and stderr, keeping only the last `maxOutput` characters. */
  output: string;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
  startedAt: string;
  endedAt: string;
}

export interface ProcessOptions {
  cwd?: string;
  /** The complete environment; nothing is inherited from the service process. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutput?: number;
  /** Called once when the time limit is reached, before the process is killed. */
  onTimeout?: () => Promise<void> | void;
  now?: () => Date;
}

const DEFAULT_MAX_OUTPUT = 64 * 1024;

/** Runs an argument vector without a shell, with a time limit and bounded output. */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const now = options.now ?? (() => new Date());
  const max = options.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const startedAt = now().toISOString();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > max * 2) output = output.slice(-max);
    };
    const finish = (result: Omit<ProcessResult, 'output' | 'startedAt' | 'endedAt' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut, output: output.slice(-max), startedAt, endedAt: now().toISOString() });
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const kill = (): void => {
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void Promise.resolve(options.onTimeout?.()).catch(() => {}).finally(kill);
    }, options.timeoutMs);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => finish({ exitCode: null, signal: null, spawnError: error.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal, spawnError: null }));
  });
}

/** Keeps only the named variables of `source`, so credentials in the service environment never pass on. */
export function pickEnv(source: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
