import { copyFile, link, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../config/settings.ts';
import { Dashboard } from '../dashboard/dashboard.ts';
import type { DataSource, ReplayInfo, ReplayProvenance } from '../dashboard/types.ts';
import type { BugRecord } from '../model/types.ts';
import { BugStore, DEFAULT_BUG_STORE_PATH, readBugRecords } from '../store/bug-store.ts';
import type { LoadedRecording } from './recording.ts';
import { ReplayWorld, type StepResult } from './world.ts';

export const DEFAULT_REPLAY_DIR = fileURLToPath(new URL('../../data/replay', import.meta.url));
export const REPLAY_STATE_VERSION = 1;

/** Replay persistence, apart from the live store (`data/bugs.json`). */
export interface ReplayPaths {
  dir: string;
  store: string;
  state: string;
  lock: string;
}

export interface ReplayState {
  schemaVersion: typeof REPLAY_STATE_VERSION;
  recording: { id: string; digest: string };
  /** Steps played so far; the store holds exactly the records those steps produce. */
  played: number;
}

export class ReplayError extends Error {}

export function replayPaths(dir: string = DEFAULT_REPLAY_DIR): ReplayPaths {
  const absolute = resolve(dir);
  const paths = { dir: absolute, store: join(absolute, 'bugs.json'), state: join(absolute, 'state.json'), lock: join(absolute, 'replay.lock') };
  if (paths.store === resolve(DEFAULT_BUG_STORE_PATH)) throw new ReplayError(`REPLAY_DIR ${absolute} would put replay records in the live store`);
  return paths;
}

export async function readReplayState(paths: ReplayPaths, loaded: LoadedRecording): Promise<ReplayState> {
  let text: string;
  try {
    text = await readFile(paths.state, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: REPLAY_STATE_VERSION, recording: { id: loaded.recording.id, digest: loaded.digest }, played: 0 };
    throw error;
  }
  const state = JSON.parse(text) as ReplayState;
  if (state.schemaVersion !== REPLAY_STATE_VERSION || typeof state.played !== 'number') throw new ReplayError(`${paths.state} is not a replay state file`);
  if (state.recording?.id !== loaded.recording.id || state.recording.digest !== loaded.digest) {
    throw new ReplayError(`${paths.dir} was played from a different recording; run "npm run replay -- reset"`);
  }
  if (state.played > loaded.recording.steps.length) throw new ReplayError(`${paths.state} is past the end of the recording; run "npm run replay -- reset"`);
  return state;
}

async function writeAtomically(path: string, write: (tmp: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await write(tmp);
  const handle = await open(tmp, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

function canonical(records: readonly BugRecord[]): string {
  return JSON.stringify([...records].sort((a, b) => a.key.localeCompare(b.key)));
}

/** A replay world rebuilt from the recording, on a scratch store. */
export interface RebuiltReplay {
  world: ReplayWorld;
  results: StepResult[];
  close(): Promise<void>;
}

/**
 * Rebuilds the world by playing the first `played` steps on a scratch store. The stand-in providers live in
 * memory, so this is how any process gets them back; the persisted store must match what it produces.
 */
export async function rebuild(loaded: LoadedRecording, settings: Settings, played: number): Promise<RebuiltReplay> {
  const scratch = await mkdtemp(join(tmpdir(), 'bug-smasher-replay-'));
  const world = await ReplayWorld.create(loaded.recording, settings, await BugStore.open(join(scratch, 'bugs.json')));
  const results: StepResult[] = [];
  try {
    for (let index = 0; index < played; index += 1) results.push(await world.next());
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return { world, results, close: () => rm(scratch, { recursive: true, force: true }) };
}

/**
 * Opens the persisted replay: rebuilds it to the saved position and checks the persisted records are
 * exactly what the recording produces, so a changed or hand-edited store is refused rather than shown.
 * The store is written before the position, so a store that matches a later step (a write stopped
 * between the two files) is accepted at that step.
 */
export async function openReplay(paths: ReplayPaths, loaded: LoadedRecording, settings: Settings): Promise<RebuiltReplay> {
  const state = await readReplayState(paths, loaded);
  const persisted = canonical(await readBugRecords(paths.store));
  const replay = await rebuild(loaded, settings, state.played);
  try {
    while (persisted !== canonical(replay.world.store.list())) {
      if (replay.world.remaining === 0) {
        throw new ReplayError(`${paths.store} does not match step ${state.played} of recording ${loaded.recording.id}; run "npm run replay -- reset"`);
      }
      await replay.world.next();
    }
  } catch (error) {
    await replay.close();
    throw error;
  }
  return replay;
}

async function withLock<T>(paths: ReplayPaths, run: () => Promise<T>): Promise<T> {
  await mkdir(paths.dir, { recursive: true });
  // The lock appears with its owner's pid already in it (hard link of a complete file), so it is never
  // seen empty; only a lock whose owner has exited is removed.
  const pending = `${paths.lock}.${process.pid}`;
  await writeFile(pending, String(process.pid), 'utf8');
  try {
    try {
      await link(pending, paths.lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number((await readFile(paths.lock, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) throw new ReplayError(`Another replay command (pid ${owner}) is running`);
      await rm(paths.lock, { force: true });
      await link(pending, paths.lock);
    }
  } finally {
    await rm(pending, { force: true });
  }
  try {
    return await run();
  } finally {
    await rm(paths.lock, { force: true });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Plays up to `count` more steps and persists the records and position. The store file is replaced
 * atomically before the position is written; the live store is never opened.
 */
export async function advanceReplay(paths: ReplayPaths, loaded: LoadedRecording, settings: Settings, count: number): Promise<StepResult[]> {
  return withLock(paths, async () => {
    const replay = await openReplay(paths, loaded, settings);
    try {
      const results: StepResult[] = [];
      while (results.length < count && replay.world.remaining > 0) results.push(await replay.world.next());
      await writeAtomically(paths.store, (tmp) => copyFile(replay.world.store.path, tmp));
      const state: ReplayState = { schemaVersion: REPLAY_STATE_VERSION, recording: { id: loaded.recording.id, digest: loaded.digest }, played: replay.world.played };
      await writeAtomically(paths.state, (tmp) => writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8'));
      return results;
    } finally {
      await replay.close();
    }
  });
}

/** Removes the replay store and position only; nothing outside `paths.dir` is touched. */
export async function resetReplay(paths: ReplayPaths): Promise<void> {
  await withLock(paths, async () => {
    await rm(paths.state, { force: true });
    await rm(paths.store, { force: true });
  });
}

export function provenanceOf(world: ReplayWorld): (key: string) => ReplayProvenance | null {
  const byKey = new Map<string, ReplayProvenance>();
  for (const scenario of world.recording.scenarios) {
    const key = world.keyOf(scenario.issue);
    if (key !== null) byKey.set(key, { scenario: scenario.id, source: scenario.source });
  }
  return (key) => byKey.get(key) ?? null;
}

/** Replay position and every scenario's documented and current outcome. */
export async function replayInfo(world: ReplayWorld): Promise<ReplayInfo> {
  const { recording } = world;
  const next = recording.steps[world.played];
  const scenarios = await Promise.all(
    recording.scenarios.map(async (scenario) => {
      const state = await world.stateOf(scenario.issue);
      return {
        id: scenario.id,
        title: scenario.title,
        issue: world.keyOf(scenario.issue),
        source: scenario.source,
        synthetic: scenario.source.kind === 'synthetic',
        expected: scenario.outcome,
        current: state === null ? null : { stage: state.stage, status: state.status },
        reached: state !== null && state.stage === scenario.outcome.stage && state.status === scenario.outcome.status,
      };
    }),
  );
  return {
    recording: { id: recording.id, title: recording.title },
    played: world.played,
    total: recording.steps.length,
    simulatedTime: world.time.toISOString(),
    next: next === undefined ? null : { step: world.played + 1, title: next.title, scenario: next.scenario },
    scenarios,
  };
}

/**
 * The dashboard over a replay world: the same read-only `Dashboard` the live service uses, reading the
 * stand-ins, with records in the `replay` cohort and every response marked simulated.
 */
export async function replayDashboard(world: ReplayWorld, records: () => BugRecord[] = () => world.store.list()): Promise<Dashboard> {
  const at = world.time;
  const info = await replayInfo(world);
  const data: DataSource = { mode: 'replay', simulated: true, replay: info };
  const dashboard = new Dashboard({ settings: world.settings, now: () => at, mode: 'replay', data: () => data, provenance: provenanceOf(world) });
  dashboard.connect({ store: { list: records }, tracker: world.tracker, devin: world.client, lastCycleAt: () => world.lastCycleAt });
  await dashboard.refresh();
  return dashboard;
}
