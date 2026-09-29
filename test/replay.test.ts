import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runCommand } from '../src/operator/cli.ts';
import { renderReplayResults } from '../src/operator/replay.ts';
import { loadRecording, validateRecording, type LoadedRecording, type Recording } from '../src/replay/recording.ts';
import {
  advanceReplay,
  openReplay,
  rebuild,
  replayDashboard,
  replayPaths,
  resetReplay,
  type RebuiltReplay,
} from '../src/replay/replay.ts';
import { ReplayService } from '../src/replay/service.ts';
import { replaySettings, type StepResult } from '../src/replay/world.ts';
import { BugStore, DEFAULT_BUG_STORE_PATH } from '../src/store/bug-store.ts';

const TOKEN = 'ghp_SECRETtoken1234567890';
const API_KEY = 'apk_SECRETkey0987654321';
const REQUIRED_SCENARIOS = [
  'clarification',
  'decision',
  'repair',
  'failed-verification',
  'verification-error',
  'handoff',
  'pr-checks-passed',
  'merged-with-proof',
];

let loaded: LoadedRecording;
let full: RebuiltReplay;
let steps: StepResult[];
const providerCalls: string[] = [];
const realFetch = globalThis.fetch;

function copy(recording: Recording): Recording {
  return JSON.parse(JSON.stringify(recording)) as Recording;
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bug-smasher-replay-test-'));
}

async function cli(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(args, { env, cwd: process.cwd(), out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

before(async () => {
  // Any real network call during replay is recorded and fails.
  globalThis.fetch = async (input) => {
    providerCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error('replay must not use the network');
  };
  loaded = await loadRecording();
  full = await rebuild(loaded, replaySettings(loaded.recording, {}), 0);
  steps = [];
  while (full.world.remaining > 0) steps.push(await full.world.next());
});

after(async () => {
  globalThis.fetch = realFetch;
  await full?.close();
});

describe('replay recording', () => {
  it('covers every required scenario family, each with explicit provenance', () => {
    assert.deepEqual(loaded.recording.scenarios.map((scenario) => scenario.id), REQUIRED_SCENARIOS);
    for (const scenario of loaded.recording.scenarios) {
      assert.ok(scenario.source.kind === 'synthetic' || scenario.source.kind === 'recorded');
      if (scenario.source.kind === 'synthetic') assert.match(scenario.source.reason, /\S/);
    }
  });

  it('rejects a scenario without a source and accepts a sanitized recorded source', () => {
    const missing = copy(loaded.recording) as unknown as { scenarios: Record<string, unknown>[] };
    delete missing.scenarios[0]?.source;
    assert.throws(() => validateRecording(missing), /source/);
    const recorded = copy(loaded.recording);
    recorded.scenarios[0]!.source = { kind: 'recorded', recording: 'https://github.com/acme/widgets/issues/1', sanitized: true };
    assert.equal(validateRecording(recorded).scenarios[0]?.source.kind, 'recorded');
    const unsanitized = copy(loaded.recording) as unknown as { scenarios: { source: unknown }[] };
    unsanitized.scenarios[0]!.source = { kind: 'recorded', recording: 'x', sanitized: false };
    assert.throws(() => validateRecording(unsanitized), /sanitized/);
  });

  it('contains no credential-shaped value, and ignores credentials in the environment', async () => {
    const text = await readFile(new URL('../replay/recording.json', import.meta.url), 'utf8');
    for (const pattern of [/gh[pousr]_[A-Za-z0-9]{10,}/, /github_pat_/, /apk_[A-Za-z0-9]/, /cog_[A-Za-z0-9]/, /Bearer /i]) {
      assert.doesNotMatch(text, pattern);
    }
    const settings = replaySettings(loaded.recording, { GITHUB_TOKEN: TOKEN, DEVIN_API_KEY: API_KEY, GITHUB_REPO: 'acme/live', HOST: '127.0.0.1' });
    assert.equal(settings.github.token, null);
    assert.equal(settings.devin.apiKey, null);
    assert.equal(`${settings.github.repo?.owner}/${settings.github.repo?.name}`, loaded.recording.repository);
  });
});

describe('replay through the real orchestrator', () => {
  it('reaches every scenario’s documented outcome', async () => {
    for (const scenario of loaded.recording.scenarios) {
      const state = await full.world.stateOf(scenario.issue);
      assert.ok(state, `${scenario.id} enrolled`);
      assert.deepEqual([state.stage, state.status], [scenario.outcome.stage, scenario.outcome.status], scenario.id);
    }
  });

  it('shows the failed proof as fixing with a failed verification before the retry passes', () => {
    const scenario = steps.filter((step) => step.step.scenario === 'failed-verification');
    const failed = scenario.findIndex((step) => step.states[0]?.verification === 'fail');
    assert.ok(failed >= 0);
    assert.deepEqual([scenario[failed]?.states[0]?.stage, scenario[failed]?.states[0]?.status], ['fixing', 'fixing']);
    const last = scenario.at(-1)?.states[0];
    assert.deepEqual([last?.stage, last?.verification, last?.verifications], ['ready-to-merge', 'pass', 2]);
    assert.ok(scenario.findIndex((step) => step.states[0]?.verification === 'pass') > failed);
  });

  it('shows the infrastructure error as verifying with an error before the retry passes', () => {
    const scenario = steps.filter((step) => step.step.scenario === 'verification-error');
    const errored = scenario.findIndex((step) => step.states[0]?.verification === 'error');
    assert.ok(errored >= 0);
    assert.equal(scenario[errored]?.states[0]?.stage, 'verifying', 'an error does not send the fix back');
    const last = scenario.at(-1)?.states[0];
    assert.deepEqual([last?.stage, last?.verification, last?.verifications], ['ready-to-merge', 'pass', 2]);
  });

  it('asks, relays the reply to the same session and records the merge commit with a post-merge proof', async () => {
    const key = full.world.keyOf('export-safari') as string;
    const clarified = full.world.store.get(key);
    assert.ok(clarified?.stageHistory.some((entry) => entry.stage === 'needs-input'));
    const messages = full.world.offline.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/messages'));
    assert.ok(messages.some((request) => JSON.stringify(request.body).includes('Safari 16.3')), 'reply relayed to Devin');
    const merged = full.world.store.get(full.world.keyOf('tz-offset') as string);
    assert.equal(merged?.fix?.mergeCommitSha, 'e9'.repeat(20));
    assert.deepEqual(merged?.verifications.map((attempt) => [attempt.phase, attempt.result]), [['pre-merge', 'pass'], ['post-merge', 'pass']]);
    const handed = full.world.store.get(full.world.keyOf('sso-timeout') as string);
    assert.equal(handed?.stage, 'with-engineer');
  });

  it('never calls a real provider: only the stand-ins receive requests', () => {
    assert.deepEqual(providerCalls, []);
    assert.ok(full.world.offline.requests.length > 0);
    assert.ok(full.world.offline.requests.every((request) => request.authorized));
  });

  it('is deterministic: a second replay produces identical records', async () => {
    const again = await rebuild(loaded, replaySettings(loaded.recording, {}), loaded.recording.steps.length);
    try {
      assert.deepEqual(again.world.store.list(), full.world.store.list());
    } finally {
      await again.close();
    }
  });
});

describe('replay dashboard and results', () => {
  it('marks every API response simulated and each issue with its scenario and source', async () => {
    const dashboard = await replayDashboard(full.world);
    for (const response of [dashboard.overview(), dashboard.metrics(), dashboard.settings()]) {
      assert.equal(response.data.mode, 'replay');
      assert.equal(response.data.simulated, true);
      assert.equal(response.data.replay?.played, loaded.recording.steps.length);
    }
    const overview = dashboard.overview();
    assert.equal(overview.refresh.state, 'current');
    assert.equal(overview.overview?.issues.length, REQUIRED_SCENARIOS.length);
    for (const issue of overview.overview?.issues ?? []) {
      assert.ok(issue.replay, `${issue.key} has provenance`);
      assert.equal(issue.replay.source.kind, 'synthetic');
    }
    assert.ok(overview.data.replay?.scenarios.every((scenario) => scenario.reached && scenario.synthetic));
  });

  it('reports replay records only in the replay cohort, never as live outcomes', async () => {
    const { metrics } = (await replayDashboard(full.world)).metrics();
    assert.ok(metrics);
    assert.equal(metrics.live, null);
    assert.deepEqual(metrics.otherCohorts.map((cohort) => [cohort.mode, cohort.live]), [['replay', false]]);
    assert.ok(metrics.rows.every((row) => row.cohort.endsWith('(replay)')));
  });

  it('matches the committed replay/RESULTS.md, which is written from the same metrics the API serves', async () => {
    const { metrics } = (await replayDashboard(full.world)).metrics();
    assert.ok(metrics);
    const label = `replay of ${loaded.recording.id}, step ${loaded.recording.steps.length} of ${loaded.recording.steps.length}`;
    const expected = `${await renderReplayResults(full.world, metrics, label)}\n`;
    const committed = await readFile(new URL('../replay/RESULTS.md', import.meta.url), 'utf8');
    assert.equal(committed, expected, 'regenerate with: npm run replay -- report --full --out replay/RESULTS.md');
    assert.match(committed, /\*\*Simulated data\.\*\*/);
    for (const row of metrics.rows) assert.ok(committed.includes(`| ${row.key} |`));
  });
});

describe('replay persistence and isolation', () => {
  it('persists each step, survives a reopen (restart), and refuses a store the recording did not produce', async () => {
    const dir = await tempDir();
    try {
      const paths = replayPaths(dir);
      const settings = replaySettings(loaded.recording, {});
      assert.equal((await advanceReplay(paths, loaded, settings, 2)).length, 2);
      const reopened = await openReplay(paths, loaded, settings);
      try {
        assert.equal(reopened.world.played, 2);
        assert.deepEqual((await BugStore.open(paths.store)).list(), reopened.world.store.list());
      } finally {
        await reopened.close();
      }
      await writeFile(paths.store, '{"schemaVersion":1,"bugs":{}}\n');
      await assert.rejects(openReplay(paths, loaded, settings), /does not match step 2/);
      const changed = { ...loaded, digest: 'different' };
      await assert.rejects(openReplay(paths, changed, settings), /different recording/);
      await resetReplay(paths);
      const fresh = await openReplay(paths, loaded, settings);
      assert.equal(fresh.world.played, 0);
      await fresh.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers a write stopped between the store and the position, and keeps a live lock', async () => {
    const dir = await tempDir();
    try {
      const paths = replayPaths(dir);
      const settings = replaySettings(loaded.recording, {});
      await advanceReplay(paths, loaded, settings, 3);
      const state = await readFile(paths.state, 'utf8');
      await advanceReplay(paths, loaded, settings, 1);
      await writeFile(paths.state, state);
      const recovered = await openReplay(paths, loaded, settings);
      assert.equal(recovered.world.played, 4, 'the store written at step 4 is accepted');
      await recovered.close();
      assert.equal((await advanceReplay(paths, loaded, settings, 1))[0]?.number, 5);

      await writeFile(paths.lock, String(process.pid));
      await assert.rejects(advanceReplay(paths, loaded, settings, 1), /Another replay command/);
      await writeFile(paths.lock, '2147483646');
      assert.equal((await advanceReplay(paths, loaded, settings, 1))[0]?.number, 6, 'a lock left by an exited process is replaced');
      await assert.rejects(readFile(paths.lock), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the service retries after a failed load and serves the replay once it is valid again', async () => {
    const dir = await tempDir();
    try {
      const paths = replayPaths(dir);
      const service = new ReplayService(paths, loaded, replaySettings(loaded.recording, {}));
      await advanceReplay(paths, loaded, replaySettings(loaded.recording, {}), 2);
      await writeFile(paths.store, '{"schemaVersion":1,"bugs":{}}\n');
      await service.reload();
      assert.equal(service.overview().refresh.state, 'unavailable');
      assert.equal(service.overview().data.simulated, true);
      await resetReplay(paths);
      await service.reload();
      assert.equal(service.overview().refresh.state, 'current');
      assert.equal(service.overview().data.replay?.played, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never resolves the replay store to the live store', () => {
    assert.notEqual(replayPaths().store, DEFAULT_BUG_STORE_PATH);
    assert.throws(() => replayPaths(join(DEFAULT_BUG_STORE_PATH, '..')), /live store/);
  });

  it('advances, reports and resets through the operator command without touching a live store', async () => {
    const dir = await tempDir();
    try {
      const live = join(dir, 'live-bugs.json');
      await (await BugStore.open(live)).update('acme/widgets#1', () => ({ ...(full.world.store.list()[0] as NonNullable<ReturnType<BugStore['get']>>), key: 'acme/widgets#1' }));
      const before = await readFile(live, 'utf8');
      const env = { REPLAY_DIR: join(dir, 'replay'), GITHUB_TOKEN: TOKEN, DEVIN_API_KEY: API_KEY };
      const next = await cli(['replay', 'next', '3'], env);
      assert.equal(next.code, 0, next.err);
      assert.match(next.out, /Step 3 \[clarification\]/);
      const status = await cli(['replay', 'status'], env);
      assert.match(status.out, /Played 3 of \d+ steps/);
      assert.match(status.out, /simulated/);
      const report = await cli(['replay', 'report', '--out', join(dir, 'RESULTS.md')], env);
      assert.equal(report.code, 0, report.err);
      assert.match(await readFile(join(dir, 'RESULTS.md'), 'utf8'), /Simulated data/);
      for (const text of [next.out, status.out, report.out]) assert.ok(!text.includes(TOKEN) && !text.includes(API_KEY));
      assert.equal((await cli(['replay', 'reset'], env)).code, 0);
      assert.match((await cli(['replay', 'status'], env)).out, /Played 0 of/);
      assert.equal((await cli(['replay', 'next', 'zero'], env)).code, 2);
      assert.equal(await readFile(live, 'utf8'), before);
      assert.deepEqual(providerCalls, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
