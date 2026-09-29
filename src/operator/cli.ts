import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, SettingsError, type Env, type Settings } from '../config/settings.ts';
import { redact } from '../devin/errors.ts';
import type { DevinFetch } from '../devin/http.ts';
import { DevinClient } from '../devin/client.ts';
import { DevinSetupClient } from '../devin/setup.ts';
import { calculateMetrics } from '../metrics/calculate.ts';
import { readDevinEvidence, readGitHubEvidence } from '../metrics/evidence.ts';
import type { DevinEvidence, GitHubEvidence, RecordSet, Sourced } from '../metrics/types.ts';
import { parseBugKey } from '../model/keys.ts';
import { playbookBody } from '../orchestrator/playbooks.ts';
import { Prompts } from '../orchestrator/prompts.ts';
import { BugStore, DEFAULT_BUG_STORE_PATH } from '../store/bug-store.ts';
import { GitHubTracker } from '../tracker/github.ts';
import { parsePitfalls } from './assets.ts';
import { envStatus } from './env-status.ts';
import { mirrorIssue } from './mirror.ts';
import { REPLAY_USAGE, replayCommand, ReplayUsageError } from './replay.ts';
import { verifyCheck } from './verify-check.ts';
import { DockerRuntime } from '../verify/docker.ts';
import { renderResults } from './report.ts';
import { describeChange, planSetup, SetupStopped } from './setup.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_BLUEPRINT_FILE = 'setup/blueprint.yaml';
export const DEFAULT_PITFALLS_FILE = 'setup/pitfalls.md';

export const USAGE = `Usage: node src/operator/main.ts <command> [options]

Commands:
  run                                   Start the HTTP service and, with live settings, workflow polling
  setup [--dry-run] [--blueprint FILE] [--pitfalls FILE]
                                        Configure the target repository on GitHub and Devin
  env-status [BUILD_ID]                 Show a Devin environment build (default: latest) step by step
  mirror OWNER/REPO#N [--triage | --fix] [--dry-run]
                                        Copy an issue into the target repository
  report [--store FILE] [--replay-store FILE] [--v1-store FILE] [--out FILE]
                                        Write RESULTS.md (records and metrics) from the bug stores
${REPLAY_USAGE}
  verify-check [--image IMAGE]          Prove verification runs in sibling Docker containers (VERIFY_IMAGE, VERIFY_WORK_DIR)`;

export interface OperatorIO {
  env: Env;
  /** Relative option paths resolve here. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  githubBaseUrl?: string;
  devinBaseUrl?: string;
  devinFetch?: DevinFetch;
}

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(args: readonly string[], booleans: readonly string[], valued: readonly string[]): Parsed {
  const parsed: Parsed = { positionals: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (booleans.includes(arg)) parsed.flags.add(arg);
    else if (valued.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      parsed.values.set(arg, value);
      i += 1;
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}`);
    else parsed.positionals.push(arg);
  }
  return parsed;
}

function need(settings: Settings, command: string, required: readonly ('repo' | 'token' | 'devin')[]): void {
  const missing: string[] = [];
  if (required.includes('repo') && settings.github.repo === null) missing.push('GITHUB_REPO');
  if (required.includes('token') && settings.github.token === null) missing.push('GITHUB_TOKEN');
  if (required.includes('devin') && settings.devin.apiKey === null) missing.push('DEVIN_API_KEY');
  if (required.includes('devin') && settings.devin.orgId === null) missing.push('DEVIN_ORG_ID');
  if (missing.length > 0) throw new UsageError(`${command} needs ${missing.join(', ')}`);
}

function target(settings: Settings, io: OperatorIO): GitHubTracker {
  return new GitHubTracker({
    repo: settings.github.repo as NonNullable<Settings['github']['repo']>,
    token: settings.github.token as string,
    ...(io.githubBaseUrl === undefined ? {} : { baseUrl: io.githubBaseUrl }),
  });
}

function devin(settings: Settings, io: OperatorIO): DevinSetupClient {
  return new DevinSetupClient({
    apiKey: settings.devin.apiKey as string,
    orgId: settings.devin.orgId as string,
    ...(io.devinBaseUrl === undefined ? {} : { baseUrl: io.devinBaseUrl }),
    ...(io.devinFetch === undefined ? {} : { fetch: io.devinFetch }),
  });
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function setupCommand(args: readonly string[], settings: Settings, io: OperatorIO): Promise<number> {
  const parsed = parseArgs(args, ['--dry-run'], ['--blueprint', '--pitfalls']);
  if (parsed.positionals.length > 0) throw new UsageError(`setup takes no arguments (got ${parsed.positionals.join(' ')})`);
  need(settings, 'setup', ['repo', 'token', 'devin']);
  const dryRun = parsed.flags.has('--dry-run');
  const blueprintPath = resolve(io.cwd, parsed.values.get('--blueprint') ?? DEFAULT_BLUEPRINT_FILE);
  const pitfallsOption = parsed.values.get('--pitfalls') ?? DEFAULT_PITFALLS_FILE;
  const pitfallsPath = resolve(io.cwd, pitfallsOption);
  const blueprint = await optionalFile(blueprintPath);
  if (blueprint === null || blueprint.trim() === '') {
    throw new UsageError(`No environment blueprint at ${relative(io.cwd, blueprintPath)}; write the target's blueprint YAML there or pass --blueprint FILE`);
  }
  const pitfalls = await optionalFile(pitfallsPath);
  if (pitfalls === null && parsed.values.has('--pitfalls')) throw new UsageError(`No pitfalls file at ${pitfallsOption}`);
  const prompts = await Prompts.load();
  const github = target(settings, io);
  const plan = await planSetup({
    settings,
    github,
    devin: devin(settings, io),
    playbookBodies: { triage: playbookBody(prompts, 'triage'), repair: playbookBody(prompts, 'repair'), feature: playbookBody(prompts, 'feature') },
    blueprint,
    pitfalls: parsePitfalls(pitfalls ?? ''),
    pitfallsFile: relative(io.cwd, pitfallsPath) || pitfallsOption,
  });
  io.out(`Setup for ${plan.target}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
  for (const item of plan.unchanged) io.out(`  unchanged ${item}`);
  if (plan.changes.length === 0) {
    io.out(`Nothing to change: ${plan.target} is already set up.`);
    return 0;
  }
  if (dryRun) {
    io.out(`Would make ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'}:`);
    for (const change of plan.changes) io.out(`  would ${describeChange(change)}`);
    return 0;
  }
  for (const change of plan.changes) {
    const note = await change.apply();
    io.out(`  done: ${describeChange(change)}`);
    if (note !== null) io.out(`    ${note}`);
  }
  io.out(`Made ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'} to ${plan.target}.`);
  return 0;
}

async function envStatusCommand(args: readonly string[], settings: Settings, io: OperatorIO): Promise<number> {
  const parsed = parseArgs(args, [], []);
  if (parsed.positionals.length > 1) throw new UsageError('env-status takes at most one build id');
  need(settings, 'env-status', ['devin']);
  const status = await envStatus(devin(settings, io), parsed.positionals[0] ?? null);
  if (status === null) {
    io.out('No environment builds exist yet; run setup first.');
    return 1;
  }
  for (const line of status.lines) io.out(line);
  return status.healthy ? 0 : 1;
}

async function mirrorCommand(args: readonly string[], settings: Settings, io: OperatorIO): Promise<number> {
  const parsed = parseArgs(args, ['--triage', '--fix', '--dry-run'], []);
  const [reference, ...rest] = parsed.positionals;
  const source = reference === undefined ? null : parseBugKey(reference);
  if (source === null || rest.length > 0) throw new UsageError('mirror needs exactly one source issue, OWNER/REPO#N');
  if (parsed.flags.has('--triage') && parsed.flags.has('--fix')) throw new UsageError('mirror takes --triage or --fix, not both');
  need(settings, 'mirror', ['repo', 'token']);
  const labels = parsed.flags.has('--triage') ? [settings.labels.triage] : parsed.flags.has('--fix') ? [settings.labels.fix] : [];
  const result = await mirrorIssue({
    source: { repo: { owner: source.owner, name: source.repo }, number: source.number },
    sourceReader: new GitHubTracker({
      repo: { owner: source.owner, name: source.repo },
      token: settings.github.token as string,
      ...(io.githubBaseUrl === undefined ? {} : { baseUrl: io.githubBaseUrl }),
    }),
    target: target(settings, io),
    labels,
    dryRun: parsed.flags.has('--dry-run'),
  });
  const shownLabels = labels.length === 0 ? 'none' : labels.join(', ');
  if (result.kind === 'duplicate') {
    io.out(
      `Duplicate: ${result.recordedSource} is already mirrored as ${result.existing.key} (${result.existing.url}). ` +
        'Nothing was created and no labels were changed.',
    );
  } else if (result.kind === 'planned') {
    io.out(`Dry run: would create an issue in the target from ${result.source.key}, titled ${JSON.stringify(result.title)}, labels: ${shownLabels}`);
    io.out('Body:');
    io.out(result.body);
  } else {
    io.out(`Created ${result.issue.key} (${result.issue.url}) from ${result.source.key}, labels: ${shownLabels}`);
  }
  return 0;
}

async function reportCommand(args: readonly string[], io: OperatorIO): Promise<number> {
  const parsed = parseArgs(args, [], ['--store', '--replay-store', '--v1-store', '--out']);
  if (parsed.positionals.length > 0) throw new UsageError('report takes no arguments');
  const settings = loadSettings(io.env);
  const storeOption = parsed.values.get('--store');
  const storePath = storeOption === undefined ? DEFAULT_BUG_STORE_PATH : resolve(io.cwd, storeOption);
  const outPath = resolve(io.cwd, parsed.values.get('--out') ?? 'RESULTS.md');
  const store = await BugStore.open(storePath);
  const storeLabel = relative(REPO_ROOT, storePath).startsWith('..') ? storePath : relative(REPO_ROOT, storePath);
  const recordSets: RecordSet[] = [{ mode: 'live', engine: 'current', records: store.list() }];
  for (const [option, mode, engine] of [['--replay-store', 'replay', 'current'], ['--v1-store', 'live', 'v1']] as const) {
    const path = parsed.values.get(option);
    if (path !== undefined) recordSets.push({ mode, engine, records: (await BugStore.open(resolve(io.cwd, path))).list() });
  }
  const records = recordSets.filter((set) => set.mode === 'live').flatMap((set) => set.records);
  const now = new Date();
  const github: Sourced<GitHubEvidence> =
    settings.github.repo === null || settings.github.token === null
      ? { status: 'unavailable', reason: 'GITHUB_REPO and GITHUB_TOKEN are not both set' }
      : await readGitHubEvidence(target(settings, io), records, settings.baselineFilter, now);
  const devinEvidence: Sourced<DevinEvidence> =
    settings.devin.apiKey === null || settings.devin.orgId === null
      ? { status: 'unavailable', reason: 'DEVIN_API_KEY and DEVIN_ORG_ID are not both set' }
      : await readDevinEvidence(
          DevinClient.fromSettings(settings, {
            ...(io.devinBaseUrl === undefined ? {} : { baseUrl: io.devinBaseUrl }),
            ...(io.devinFetch === undefined ? {} : { fetch: io.devinFetch }),
          }),
          now,
        );
  const report = calculateMetrics({
    now,
    target: settings.github.repo === null ? null : `${settings.github.repo.owner}/${settings.github.repo.name}`,
    recordSets,
    settings: {
      ...settings.cost,
      maxAcuPerSession: settings.devin.maxAcuPerSession,
      baselineFilter: settings.baselineFilter,
    },
    evidence: {
      github,
      devin: devinEvidence,
      orchestrator: { status: 'unavailable', reason: 'report runs outside the service; only the running service knows its last cycle' },
    },
  });
  const secrets = [settings.github.token, settings.devin.apiKey].filter((value): value is string => value !== null);
  await writeFile(outPath, redact(renderResults(report, storeLabel), secrets), 'utf8');
  io.out(`Wrote ${relative(io.cwd, outPath) || outPath} from ${storeLabel}`);
  return 0;
}

async function verifyCheckCommand(args: readonly string[], io: OperatorIO): Promise<number> {
  const parsed = parseArgs(args, [], ['--image']);
  if (parsed.positionals.length > 0) throw new UsageError('verify-check takes no arguments');
  const settings = loadSettings(io.env);
  const image = parsed.values.get('--image') ?? settings.verify.image;
  if (image === null) throw new UsageError('verify-check needs --image or VERIFY_IMAGE (an image with node, for example node:22.18.0-bookworm-slim)');
  io.out(`Verifying a throwaway fixture in sibling containers of ${image}; workspaces under ${settings.verify.workDir}`);
  const result = await verifyCheck({ runtime: new DockerRuntime(), image, workDir: settings.verify.workDir, timeoutSeconds: settings.verify.timeoutSeconds });
  if (result.outcome.status !== 'completed') {
    io.err(`verify-check: the verifier was unavailable: ${result.outcome.reason}`);
    return 1;
  }
  const { attempt } = result.outcome;
  for (const run of attempt.evidence?.runs ?? []) {
    io.out(`  ${run.role} ${run.sha.slice(0, 12)} ${run.step}: ${run.outcome} (exit ${run.exitCode ?? 'none'})`);
  }
  io.out(`verify-check: ${attempt.result} - ${attempt.reason}`);
  return attempt.result === 'pass' ? 0 : 1;
}

/** Replaces terminal control characters (other than tab and newline), which provider data may contain. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '\uFFFD');
}

/**
 * Runs one operator command and returns its exit code, or null for `run`, which keeps the process serving.
 * Everything written to `out`/`err` is redacted of the configured credentials and credential-shaped values.
 */
export async function runCommand(argv: readonly string[], io: OperatorIO): Promise<number | null> {
  const secrets = [io.env.GITHUB_TOKEN, io.env.DEVIN_API_KEY].map((value) => value?.trim() ?? '').filter((value) => value !== '');
  const safe: OperatorIO = {
    ...io,
    out: (line) => io.out(printable(redact(line, secrets))),
    err: (line) => io.err(printable(redact(line, secrets))),
  };
  const [command, ...args] = argv;
  try {
    if (command === 'run') {
      if (args.length > 0) throw new UsageError('run takes no arguments');
      await import('../server/main.ts');
      return null;
    }
    if (command === 'report') return await reportCommand(args, safe);
    if (command === 'replay') return await replayCommand(args, safe);
    if (command === 'verify-check') return await verifyCheckCommand(args, safe);
    if (command !== 'setup' && command !== 'env-status' && command !== 'mirror') {
      throw new UsageError(command === undefined ? 'No command given' : `Unknown command ${command}`);
    }
    const settings = loadSettings(io.env);
    if (command === 'setup') return await setupCommand(args, settings, safe);
    if (command === 'env-status') return await envStatusCommand(args, settings, safe);
    return await mirrorCommand(args, settings, safe);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ReplayUsageError) {
      safe.err(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof SettingsError) {
      safe.err(error.message);
      return 2;
    }
    if (error instanceof SetupStopped) {
      safe.err(`Setup stopped: ${error.message}`);
      return 1;
    }
    safe.err(`${command ?? 'command'} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
