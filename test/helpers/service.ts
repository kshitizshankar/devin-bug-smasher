import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface RunningService {
  baseUrl: string;
  /** Combined stdout and stderr the service has written so far. */
  output: () => string;
  /** Exit code or signal if the service process has exited, otherwise undefined. */
  exitStatus: () => string | undefined;
  stop: () => Promise<void>;
}

const READY_PATTERN = /listening on (http:\/\/\S+)/;
const STARTUP_TIMEOUT_MS = 10_000;

/**
 * Starts the real service entrypoint (`src/server/main.ts`) as a child process on an
 * OS-assigned free port and resolves once it reports the URL it is listening on.
 */
export async function startService(env: Record<string, string> = {}, args: string[] = ['src/server/main.ts']): Promise<RunningService> {
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Service did not start within ${STARTUP_TIMEOUT_MS}ms. Output:\n${output}`));
    }, STARTUP_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = READY_PATTERN.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Service exited before ready (code=${code}, signal=${signal}). Output:\n${output}`));
    });
  });

  return {
    baseUrl,
    output: () => output,
    exitStatus: () =>
      child.exitCode !== null || child.signalCode !== null
        ? `code=${child.exitCode}, signal=${child.signalCode}`
        : undefined,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    },
  };
}
