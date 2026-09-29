import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../config/settings.ts';
import type { DiffFinding, VerificationEvidence, VerificationResult, VerificationRun, VerificationRunRole } from '../model/types.ts';
import type { VerificationOutcome, VerificationRequest, Verifier } from '../orchestrator/contracts.ts';
import { checkChanges, describeFinding, type FileChange } from './diff.ts';
import { DockerRuntime, type Sandbox, type SandboxRuntime } from './docker.ts';
import { GitRepository } from './git.ts';
import { isTestPath, validateTestPaths } from './paths.ts';
import { classifySetup, classifyTests, type Classification } from './results.ts';

export const FILES_TOKEN = '{files}';
export const RESULTS_TOKEN = '{results}';
const RESULTS_FILE = 'junit.xml';
const RUN_TAIL_CHARS = 1800;
const ATTEMPT_TAIL_CHARS = 4000;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

export interface CheckedVerifierOptions {
  repository: GitRepository;
  runtime: SandboxRuntime;
  /** The target repository's test image. */
  image: string;
  /** Administrator-configured test runner; whitespace-separated arguments with `{files}` and `{results}`. */
  checkCommand: string;
  /** Optional dependency preparation, run with network access before the tests and reported separately. */
  setupCommand: string | null;
  /** Time limit for each setup and test step. */
  timeoutSeconds: number;
  /** Parent directory for disposable workspaces. */
  workDir: string;
  /** Values redacted from every recorded output (provider credentials). */
  secrets?: readonly string[];
  now?: () => Date;
}

/** Problems with a check command for this verifier; empty means usable. */
export function checkCommandProblems(command: string | null): string[] {
  if (command === null) return [`CHECK_COMMAND is required and must contain ${FILES_TOKEN} and ${RESULTS_TOKEN}`];
  const tokens = splitCommand(command);
  const problems: string[] = [];
  if (!tokens.includes(FILES_TOKEN)) problems.push(`CHECK_COMMAND must contain ${FILES_TOKEN} as a separate argument`);
  if (!tokens.some((token) => token.includes(RESULTS_TOKEN))) {
    problems.push(`CHECK_COMMAND must contain ${RESULTS_TOKEN} (where the runner writes its JUnit XML report)`);
  }
  return problems;
}

/** What is missing for live independent verification; empty means `verifierFromSettings` can build one. */
export function verifierSettingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  if (settings.github.repo === null) problems.push('GITHUB_REPO is required for verification');
  if (settings.verify.image === null) problems.push("VERIFY_IMAGE is required for verification (the target repository's test image)");
  problems.push(...checkCommandProblems(settings.checkCommand));
  return problems;
}

/** Live verifier: a mirror of `GITHUB_REPO` under `VERIFY_WORK_DIR` and Docker on this host. */
export function verifierFromSettings(settings: Settings): CheckedVerifier {
  const problems = verifierSettingsProblems(settings);
  const repo = settings.github.repo;
  if (problems.length > 0 || repo === null || settings.verify.image === null || settings.checkCommand === null) {
    throw new Error(`Verification settings are incomplete: ${problems.join('; ')}`);
  }
  const secrets = [settings.github.token, settings.devin.apiKey].filter((value): value is string => value !== null);
  return new CheckedVerifier({
    repository: new GitRepository({
      remote: `https://github.com/${repo.owner}/${repo.name}.git`,
      dir: join(settings.verify.workDir, 'repository.git'),
      token: settings.github.token,
    }),
    runtime: new DockerRuntime(),
    image: settings.verify.image,
    checkCommand: settings.checkCommand,
    setupCommand: settings.verify.setupCommand,
    timeoutSeconds: settings.verify.timeoutSeconds,
    workDir: join(settings.verify.workDir, 'runs'),
    secrets,
  });
}

function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter((token) => token !== '');
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-(chars - 1))}`;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

interface StepOutcome {
  classification: Classification;
}

/**
 * Independent verification: runs the pull request's selected tests against the exact base and head commits in
 * disposable workspaces inside the configured test image. Passes only when the tests fail on base with real
 * test failures, pass on head, and the diff has no violation. Commands proposed by Devin or found in the pull
 * request are never executed; only `checkCommand` (and `setupCommand`) run, with test paths as plain arguments.
 */
export class CheckedVerifier implements Verifier {
  readonly live: boolean;
  readonly #options: CheckedVerifierOptions;
  readonly #now: () => Date;
  readonly #check: string[];
  readonly #setup: string[] | null;
  readonly #secrets: string[];

  constructor(options: CheckedVerifierOptions) {
    const problems = checkCommandProblems(options.checkCommand);
    if (problems.length > 0) throw new Error(problems.join('; '));
    this.#options = options;
    this.live = options.runtime.live;
    this.#now = options.now ?? (() => new Date());
    this.#check = splitCommand(options.checkCommand);
    this.#setup = options.setupCommand === null ? null : splitCommand(options.setupCommand);
    this.#secrets = (options.secrets ?? []).filter((secret) => secret.length >= 4);
  }

  #redact(text: string): string {
    let result = text;
    for (const secret of this.#secrets) result = result.split(secret).join('[redacted]');
    return result;
  }

  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    const evidence: VerificationEvidence = { runs: [], violations: [], flags: [] };
    let baseSha = request.baseSha;
    const headSha = request.headSha;
    const finish = (result: VerificationResult, reason: string): VerificationOutcome => ({
      status: 'completed',
      attempt: {
        phase: request.phase,
        baseSha,
        headSha,
        result,
        reason: this.#redact(reason),
        outputTail: this.#attemptTail(evidence.runs),
        at: this.#now().toISOString(),
        evidence,
      },
    });

    const files = [...new Set(request.testFiles)];
    if (files.length === 0) return finish('fail', 'No test files were selected; nothing was run');
    const rejected = validateTestPaths(files);
    if (rejected.length > 0) {
      const list = rejected.map((entry) => `${JSON.stringify(entry.path)} ${entry.problem}`).join('; ');
      return finish('fail', `Rejected test path(s): ${list}; nothing was run`);
    }

    const repo = this.#options.repository;
    let changes: FileChange[];
    try {
      await repo.ensure(request.phase === 'post-merge' ? [headSha] : [baseSha, headSha]);
      if (request.phase === 'post-merge') baseSha = await repo.firstParent(headSha);
      const mergeBase = request.phase === 'post-merge' ? baseSha : await repo.mergeBase(baseSha, headSha);
      changes = await Promise.all(
        (await repo.changes(mergeBase, headSha)).map(async (change) => ({
          ...change,
          base: change.status === 'added' ? null : await repo.show(mergeBase, change.path),
          head: change.status === 'deleted' ? null : await repo.show(headSha, change.path),
        })),
      );
    } catch (error) {
      return finish('error', `Could not prepare the commits: ${error instanceof Error ? error.message : String(error)}`);
    }

    const unusable = files.flatMap((file) => {
      if (!isTestPath(file)) return [`${JSON.stringify(file)} is not a test file`];
      const change = changes.find((candidate) => candidate.path === file);
      if (change === undefined || change.status === 'deleted') return [`${JSON.stringify(file)} is not added or changed by the pull request`];
      return [];
    });
    if (unusable.length > 0) return finish('fail', `Rejected test path(s): ${unusable.join('; ')}; nothing was run`);

    const report = checkChanges(changes);
    evidence.violations = report.violations;
    evidence.flags = report.flags;
    if (report.violations.length > 0) {
      return finish('fail', `Diff checks failed: ${report.violations.map(describeFinding).join('; ')}; nothing was run`);
    }

    const testChanges = changes.filter((change) => change.status !== 'deleted' && isTestPath(change.path));
    let root: string | null = null;
    try {
      await mkdir(this.#options.workDir, { recursive: true });
      root = await mkdtemp(join(this.#options.workDir, 'run-'));

      const head = await this.#runRole('head', headSha, root, files, async (workspace) => {
        await repo.exportTree(headSha, workspace);
      }, evidence.runs);
      if (head.classification.outcome === 'error') return finish('error', `Head ${short(headSha)}: ${head.classification.reason}`);
      if (head.classification.outcome === 'failed') {
        return finish('fail', `The selected tests fail on head ${short(headSha)}: ${head.classification.reason}`);
      }

      const base = await this.#runRole('base', baseSha, root, files, async (workspace) => {
        await repo.exportTree(baseSha, workspace);
        for (const change of testChanges) {
          const mode = (await repo.executable(headSha, change.path)) ? 0o755 : 0o644;
          await writeInside(workspace, change.path, change.head ?? '', mode);
        }
      }, evidence.runs);
      if (base.classification.outcome === 'error') return finish('error', `Base ${short(baseSha)}: ${base.classification.reason}`);
      if (base.classification.outcome === 'passed') {
        return finish(
          'fail',
          `The selected tests pass on both base ${short(baseSha)} and head ${short(headSha)}, so they do not detect the bug`,
        );
      }
      return finish(
        'pass',
        `The selected tests fail on base ${short(baseSha)} (${base.classification.reason}) and pass on head ${short(headSha)}` +
          flagSuffix(report.flags),
      );
    } catch (error) {
      return finish('error', `Verification could not run: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (root !== null) await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #runRole(
    role: VerificationRunRole,
    sha: string,
    root: string,
    files: readonly string[],
    prepare: (workspace: string) => Promise<void>,
    runs: VerificationRun[],
  ): Promise<StepOutcome> {
    const workspace = join(root, role);
    const results = join(root, `${role}-results`);
    await mkdir(workspace);
    await mkdir(results);
    await prepare(workspace);
    const timeoutSeconds = this.#options.timeoutSeconds;
    const timeoutMs = timeoutSeconds * 1000;
    const startedAt = this.#now().toISOString();
    let sandbox: Sandbox;
    try {
      sandbox = await this.#options.runtime.start({
        image: this.#options.image,
        workspace,
        results,
        network: this.#setup !== null,
        lifetimeSeconds: timeoutSeconds * 2 + 120,
        startTimeoutMs: Math.max(timeoutMs, 300_000),
      });
    } catch (error) {
      const reason = `the test container could not start: ${error instanceof Error ? error.message : String(error)}`;
      runs.push(this.#record(role, 'setup', sha, [this.#options.image], startedAt, null, 'error', reason, ''));
      return { classification: { outcome: 'error', reason } };
    }
    try {
      if (this.#setup !== null) {
        const setup = await sandbox.exec(this.#setup, timeoutMs);
        const classification = classifySetup(setup, timeoutSeconds);
        runs.push(this.#record(role, 'setup', sha, this.#setup, setup.startedAt, setup.exitCode, classification.outcome, classification.reason, setup.output, setup.endedAt));
        if (classification.outcome === 'error') return { classification };
        await sandbox.isolate();
      }
      const reportPath = `${sandbox.results}/${RESULTS_FILE}`;
      const argv = this.#check.flatMap((token) =>
        token === FILES_TOKEN ? [...files] : [token.split(RESULTS_TOKEN).join(reportPath)],
      );
      const executed = await sandbox.exec(argv, timeoutMs);
      const report = await readReport(join(results, RESULTS_FILE));
      const classification = classifyTests(executed, report, files, timeoutSeconds);
      runs.push(this.#record(role, 'test', sha, argv, executed.startedAt, executed.exitCode, classification.outcome, classification.reason, executed.output, executed.endedAt));
      return { classification };
    } catch (error) {
      const reason = `the sandbox failed: ${error instanceof Error ? error.message : String(error)}`;
      runs.push(this.#record(role, 'test', sha, [], startedAt, null, 'error', reason, ''));
      return { classification: { outcome: 'error', reason } };
    } finally {
      await sandbox.dispose().catch(() => {});
    }
  }

  #record(
    role: VerificationRunRole,
    step: VerificationRun['step'],
    sha: string,
    command: readonly string[],
    startedAt: string,
    exitCode: number | null,
    outcome: VerificationRun['outcome'],
    reason: string,
    output: string,
    endedAt: string = this.#now().toISOString(),
  ): VerificationRun {
    return {
      role,
      step,
      sha,
      command: command.map((part) => this.#redact(part)),
      startedAt,
      endedAt,
      exitCode,
      outcome,
      reason: this.#redact(reason),
      outputTail: tail(this.#redact(output), RUN_TAIL_CHARS),
    };
  }

  #attemptTail(runs: readonly VerificationRun[]): string {
    const parts = runs
      .filter((run) => run.step === 'test' || run.outcome === 'error')
      .map((run) => `--- ${run.role} ${run.step} ${short(run.sha)}: ${run.reason} ---\n${run.outputTail}`);
    return tail(parts.join('\n'), ATTEMPT_TAIL_CHARS);
  }
}

/** Writes `path` under `root` without following links the exported tree may contain. */
async function writeInside(root: string, path: string, content: string, mode: number): Promise<void> {
  const parts = path.split('/');
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const entry = await lstat(current).catch(() => null);
    if (entry === null) await mkdir(current);
    else if (!entry.isDirectory()) throw new Error(`${path} cannot be written: ${part} is not a directory in the base tree`);
  }
  const target = join(current, parts.at(-1) ?? '');
  const existing = await lstat(target).catch(() => null);
  if (existing !== null) {
    if (existing.isDirectory()) throw new Error(`${path} cannot be written: it is a directory in the base tree`);
    await rm(target);
  }
  await writeFile(target, content, { flag: 'wx', mode });
  await chmod(target, mode);
}

/** Reads the runner's report only if it is a regular file (never a link planted by the tests) of bounded size. */
async function readReport(path: string): Promise<string | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_REPORT_BYTES) return null;
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function flagSuffix(flags: readonly DiffFinding[]): string {
  return flags.length === 0 ? '' : `; flagged for review: ${flags.map(describeFinding).join('; ')}`;
}
