import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { startService, type RunningService } from './helpers/service.ts';

const REQUEST_TIMEOUT_MS = 5_000;
const procSelfMemAvailable = process.platform === 'linux';

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function failWithServiceState(service: RunningService, what: string, error: unknown): Promise<never> {
  await setTimeout(100);
  const exitStatus = service.exitStatus();
  const state = exitStatus ? `service process exited (${exitStatus})` : 'service process still running';
  throw new Error(`${what} failed; ${state}. Service output:\n${service.output()}`, { cause: error });
}

async function assertHealthy(service: RunningService): Promise<void> {
  const response = await fetch(new URL('/api/health', service.baseUrl), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => failWithServiceState(service, 'Health request', error));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'bug-smasher', stage: 'scaffold' });
}

describe('static asset read failures', () => {
  let fixtureDir: string;
  let unreadableAsset: string;
  let service: RunningService;

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'bug-smasher-read-failure-'));
    unreadableAsset = join(fixtureDir, 'unreadable.js');
    await writeFile(unreadableAsset, 'console.log("unreadable");\n');
    await chmod(unreadableAsset, 0o000);
    if (procSelfMemAvailable) {
      // /proc/self/mem stats as a regular file and opens successfully, but reading offset 0 fails with EIO
      // regardless of privileges, so the failure happens after the response headers are committed.
      await symlink('/proc/self/mem', join(fixtureDir, 'read-error.js'));
    }
    service = await startService({ STATIC_DIR: fixtureDir });
  });

  after(async () => {
    await service?.stop();
    if (fixtureDir) {
      await chmod(unreadableAsset, 0o600).catch(() => {});
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it('returns 500 for an asset that cannot be opened and stays healthy', async (t) => {
    if (await isReadable(unreadableAsset)) {
      t.skip('running with elevated file access: a mode 000 file is still readable');
      return;
    }
    await assertHealthy(service);

    const response = await fetch(new URL('/unreadable.js', service.baseUrl), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => failWithServiceState(service, 'Unreadable asset request', error));

    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Internal server error');
    await assertHealthy(service);
  });

  it(
    'ends the response when an asset read fails after headers are committed and stays healthy',
    { skip: procSelfMemAvailable ? false : 'requires Linux /proc/self/mem' },
    async () => {
      await assertHealthy(service);

      await assert.rejects(
        async () => {
          const response = await fetch(new URL('/read-error.js', service.baseUrl), {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          await response.arrayBuffer();
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.notEqual(error.name, 'TimeoutError', 'request hung instead of being ended');
          return true;
        },
      );
      await assertHealthy(service);
    },
  );
});
