import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { OverviewResponse, SettingsResponse } from '../src/dashboard/types.ts';
import { runCommand } from '../src/operator/cli.ts';
import { startService } from './helpers/service.ts';

const NO_CREDENTIALS = { GITHUB_TOKEN: '', DEVIN_API_KEY: '', GITHUB_REPO: '', DEVIN_ORG_ID: '' };

async function overview(baseUrl: string): Promise<OverviewResponse> {
  return (await (await fetch(new URL('/api/overview', baseUrl))).json()) as OverviewResponse;
}

async function until(baseUrl: string, done: (body: OverviewResponse) => boolean): Promise<OverviewResponse> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await overview(baseUrl);
    if (done(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail('the service did not reach the expected replay position');
}

describe('service replay mode', () => {
  it('serves simulated replay data without credentials, follows replay commands and keeps them across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bug-smasher-replay-service-'));
    const env = { ...NO_CREDENTIALS, REPLAY_DIR: join(dir, 'replay') };
    let service = await startService(env);
    try {
      const empty = await until(service.baseUrl, (body) => body.data.replay !== null);
      assert.match(service.output(), /Replay mode/);
      assert.deepEqual([empty.data.mode, empty.data.simulated, empty.data.replay?.played], ['replay', true, 0]);
      assert.equal(empty.refresh.state, 'current');
      assert.equal(empty.overview?.issues.length, 0);

      const lines: string[] = [];
      const code = await runCommand(['replay', 'next', '4'], { env, cwd: process.cwd(), out: (line) => lines.push(line), err: (line) => lines.push(line) });
      assert.equal(code, 0, lines.join('\n'));
      const advanced = await until(service.baseUrl, (body) => body.data.replay?.played === 4);
      assert.equal(advanced.overview?.issues[0]?.status, 'needs-decision');
      assert.equal(advanced.overview?.issues[0]?.replay?.scenario, 'clarification');
      const settings = (await (await fetch(new URL('/api/settings', service.baseUrl))).json()) as SettingsResponse;
      assert.equal(settings.data.simulated, true);
      assert.equal((await fetch(new URL('/api/overview', service.baseUrl), { method: 'POST' })).status, 405);

      await service.stop();
      service = await startService(env);
      const restarted = await until(service.baseUrl, (body) => body.data.replay !== null);
      assert.equal(restarted.data.replay?.played, 4, 'the replay position and records survive a restart');
      assert.deepEqual(restarted.overview?.issues, advanced.overview?.issues);
    } finally {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('marks live-configured responses as live, not simulated', async () => {
    const service = await startService({ GITHUB_TOKEN: 'ghp_SECRETtoken1234567890', DEVIN_API_KEY: '', GITHUB_REPO: 'acme/widgets', DEVIN_ORG_ID: '' });
    try {
      const body = await overview(service.baseUrl);
      assert.deepEqual(body.data, { mode: 'live', simulated: false, replay: null });
      assert.doesNotMatch(service.output(), /Replay mode/);
    } finally {
      await service.stop();
    }
  });
});
