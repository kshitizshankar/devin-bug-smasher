import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import type { Env } from '../config/settings.ts';
import type { MetricsReport } from '../metrics/types.ts';
import { DEFAULT_RECORDING_PATH, loadRecording, type LoadedRecording } from '../replay/recording.ts';
import { advanceReplay, openReplay, rebuild, replayDashboard, replayInfo, replayPaths, resetReplay, type ReplayPaths } from '../replay/replay.ts';
import { replaySettings, type ReplayWorld, type StepResult } from '../replay/world.ts';
import { renderResults } from './report.ts';

export const REPLAY_USAGE = `  replay [status | next [N] | all | reset | report [--full] [--out FILE]]
                                        Credential-free replay: show, advance, reset or report it (REPLAY_DIR, default data/replay)`;

export class ReplayUsageError extends Error {}

interface ReplayIO {
  env: Env;
  cwd: string;
  out: (line: string) => void;
}

function describeStep(result: StepResult): string {
  const states = result.states.map((state) => {
    const extra = [state.verification === null ? null : `verification ${state.verification}`, state.review === null ? null : `review ${state.review}`]
      .filter((part) => part !== null)
      .join(', ');
    return `${state.key} ${state.stage} (${state.status}${extra === '' ? '' : `; ${extra}`})`;
  });
  return `Step ${result.number} [${result.step.scenario}] ${result.step.title} -> ${states.join('; ')} after ${result.cycles} cycle(s)`;
}

async function printStatus(world: ReplayWorld, paths: ReplayPaths, io: ReplayIO): Promise<void> {
  const info = await replayInfo(world);
  io.out(`Replay ${info.recording.id} (simulated; stand-in GitHub and Devin, no provider is contacted)`);
  io.out(`Store: ${paths.store}`);
  io.out(`Played ${info.played} of ${info.total} steps; simulated time ${info.simulatedTime}`);
  io.out(info.next === null ? 'Next: nothing, every step has been played' : `Next: step ${info.next.step} [${info.next.scenario}] ${info.next.title}`);
  for (const scenario of info.scenarios) {
    const current = scenario.current === null ? 'not started' : `${scenario.current.stage} (${scenario.current.status})`;
    const source = scenario.source.kind === 'synthetic' ? 'synthetic' : `recorded from ${scenario.source.recording}`;
    io.out(`  ${scenario.reached ? 'reached' : 'pending'}  ${scenario.id}: ${current}; expected ${scenario.expected.stage} (${scenario.expected.status}); ${source}; ${scenario.issue ?? 'no issue yet'}`);
  }
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** RESULTS.md for a replay: provenance, the scenario outcomes, then the shared metrics report. */
export async function renderReplayResults(world: ReplayWorld, metrics: MetricsReport, storeLabel: string): Promise<string> {
  const info = await replayInfo(world);
  const lines = [
    '# Bug Smasher replay results',
    '',
    `**Simulated data.** Recording \`${info.recording.id}\` (${cell(info.recording.title)}), ${info.played} of ${info.total} steps played through the real orchestrator against stand-in GitHub and Devin providers. No live repository, Devin session or paid provider was contacted, and none of these figures are live outcomes.`,
    '',
    '| Scenario | Issue | Source | Expected | Reached |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const scenario of info.scenarios) {
    const source = scenario.source.kind === 'synthetic' ? `synthetic: ${scenario.source.reason}` : `recorded (sanitized): ${scenario.source.recording}`;
    const current = scenario.current === null ? 'not started' : `${scenario.current.stage} / ${scenario.current.status}`;
    lines.push(`| ${cell(scenario.title)} | ${scenario.issue ?? ''} | ${cell(source)} | ${scenario.expected.stage} / ${scenario.expected.status} | ${scenario.reached ? 'yes' : `no (${current})`} |`);
  }
  lines.push('', renderResults(metrics, storeLabel).replace(/^# Bug Smasher results\n\n/, ''));
  return lines.join('\n');
}

async function reportReplay(world: ReplayWorld, storeLabel: string, outPath: string, io: ReplayIO): Promise<void> {
  const dashboard = await replayDashboard(world);
  const { metrics, refresh } = dashboard.metrics();
  if (metrics === null) throw new Error(`the replay metrics could not be calculated: ${JSON.stringify(refresh.problems)}`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${await renderReplayResults(world, metrics, storeLabel)}\n`, 'utf8');
  io.out(`Wrote ${relative(io.cwd, outPath) || outPath} from ${storeLabel} (simulated replay data)`);
}

/**
 * `replay` operator command. Only the replay directory is read or written; there are no credentials,
 * provider clients or network access on this path.
 */
export async function replayCommand(args: readonly string[], io: ReplayIO, loaded?: LoadedRecording): Promise<number> {
  const [action = 'status', ...rest] = args;
  const recording = loaded ?? (await loadRecording(DEFAULT_RECORDING_PATH));
  const settings = replaySettings(recording.recording, io.env);
  const paths = replayPaths(io.env.REPLAY_DIR === undefined || io.env.REPLAY_DIR === '' ? undefined : resolve(io.cwd, io.env.REPLAY_DIR));
  if (action === 'status') {
    if (rest.length > 0) throw new ReplayUsageError('replay status takes no arguments');
    const replay = await openReplay(paths, recording, settings);
    try {
      await printStatus(replay.world, paths, io);
    } finally {
      await replay.close();
    }
    return 0;
  }
  if (action === 'next' || action === 'all') {
    let count = recording.recording.steps.length;
    if (action === 'next') {
      if (rest.length > 1) throw new ReplayUsageError('replay next takes at most one count');
      count = rest[0] === undefined ? 1 : Number(rest[0]);
      if (!Number.isInteger(count) || count < 1) throw new ReplayUsageError(`replay next needs a positive whole number of steps, not ${rest[0]}`);
    } else if (rest.length > 0) throw new ReplayUsageError('replay all takes no arguments');
    const results = await advanceReplay(paths, recording, settings, count);
    if (results.length === 0) io.out('Every step has already been played; run "npm run replay -- reset" to start again');
    for (const result of results) io.out(describeStep(result));
    const played = results.at(-1)?.number;
    if (played !== undefined) io.out(`Played ${played} of ${recording.recording.steps.length} steps; saved to ${paths.store}`);
    return 0;
  }
  if (action === 'reset') {
    if (rest.length > 0) throw new ReplayUsageError('replay reset takes no arguments');
    await resetReplay(paths);
    io.out(`Reset the replay in ${paths.dir}; the live store was not touched`);
    return 0;
  }
  if (action === 'report') {
    let full = false;
    let out: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '--full') full = true;
      else if (rest[index] === '--out' && rest[index + 1] !== undefined && !rest[index + 1]?.startsWith('--')) out = rest[++index];
      else throw new ReplayUsageError(`Unknown replay report option ${rest[index]}`);
    }
    const outPath = resolve(io.cwd, out ?? `${paths.dir}/RESULTS.md`);
    const replay = full ? await rebuild(recording, settings, recording.recording.steps.length) : await openReplay(paths, recording, settings);
    try {
      const label = `replay of ${recording.recording.id}, step ${replay.world.played} of ${recording.recording.steps.length}`;
      await reportReplay(replay.world, label, outPath, io);
    } finally {
      await replay.close();
    }
    return 0;
  }
  throw new ReplayUsageError(`Unknown replay action ${action}`);
}
