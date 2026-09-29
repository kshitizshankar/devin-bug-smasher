import { loadSettings, type Env, type Settings } from '../config/settings.ts';
import { DevinClient } from '../devin/client.ts';
import { OfflineDevin } from '../devin/offline.ts';
import { formatBugKey } from '../model/keys.ts';
import { presentBug, type StatusCode } from '../model/presentation.ts';
import type { BugRecord, ReviewRoundStatus, Stage, VerificationAttempt, VerificationResult } from '../model/types.ts';
import type { VerificationOutcome, VerificationRequest, Verifier } from '../orchestrator/contracts.ts';
import { Orchestrator } from '../orchestrator/orchestrator.ts';
import { Prompts } from '../orchestrator/prompts.ts';
import type { BugStore } from '../store/bug-store.ts';
import { toGitHubFacts } from '../tracker/common.ts';
import { InMemoryTracker } from '../tracker/memory.ts';
import type { TrackerPullRequest } from '../tracker/types.ts';
import type { Expectation, Recording, ReplayEvent, ReplayStep } from './recording.ts';

/** Placeholder provider identity for the offline stand-ins; never a credential. */
const OFFLINE_KEY = 'replay-offline';
const SETTING_NAMES_FROM_ENV = ['HOST', 'PORT', 'STATIC_DIR', 'BUG_SMASHER_CONTAINER'] as const;

/**
 * Service settings for a replay: the recording's workflow settings and stand-in repository, plus only the
 * environment's server settings. Credentials and live targets from the environment are never used.
 */
export function replaySettings(recording: Recording, env: Env = process.env): Settings {
  const server: Record<string, string> = {};
  for (const name of SETTING_NAMES_FROM_ENV) {
    const value = env[name];
    if (value !== undefined) server[name] = value;
  }
  return loadSettings({ ...recording.settings, ...server, GITHUB_REPO: recording.repository });
}

/**
 * Verification stand-in: returns the results the recording gives for each issue, in order. It runs nothing
 * and is not live; with no recorded result left it reports `unavailable`, which is never a pass.
 */
export class RecordedVerifier implements Verifier {
  readonly live = false;
  readonly #queues = new Map<string, { result: VerificationResult; reason: string; output: string }[]>();
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  queue(bugKey: string, result: VerificationResult, reason: string, output: string): void {
    const queue = this.#queues.get(bugKey) ?? [];
    queue.push({ result, reason, output });
    this.#queues.set(bugKey, queue);
  }

  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    const next = this.#queues.get(request.bugKey)?.shift();
    if (next === undefined) return { status: 'unavailable', reason: 'The replay recording has no verification result for this step' };
    const attempt: Omit<VerificationAttempt, 'sessionId'> = {
      phase: request.phase,
      baseSha: request.baseSha,
      headSha: request.headSha,
      result: next.result,
      reason: next.reason,
      outputTail: next.output,
      at: this.#now().toISOString(),
    };
    return { status: 'completed', attempt };
  }
}

export interface IssueState {
  key: string;
  stage: Stage;
  status: StatusCode;
  verification: VerificationResult | null;
  verifications: number;
  /** Devin Review round for the current PR head; `null` when none was requested. */
  review: ReviewRoundStatus | null;
}

export interface StepResult {
  /** 1-based position of the step in the recording. */
  number: number;
  step: ReplayStep;
  cycles: number;
  /** Issue states after the step, for the issues it names. */
  states: IssueState[];
}

export class ReplayStepError extends Error {}

/**
 * The replay world: stand-in GitHub (`InMemoryTracker`) and Devin (`OfflineDevin` behind the real
 * `DevinClient`), a recorded verifier, and the real `Orchestrator` writing to `store`. Steps apply the
 * recording's events and then run orchestrator cycles, so every record is produced by the workflow itself.
 * Time is simulated: the clock starts at the recording's `startAt` and advances one second per reading.
 */
export class ReplayWorld {
  readonly recording: Recording;
  readonly settings: Settings;
  readonly tracker: InMemoryTracker;
  readonly offline: OfflineDevin;
  readonly client: DevinClient;
  readonly verifier: RecordedVerifier;
  readonly store: BugStore;
  readonly orchestrator: Orchestrator;
  played = 0;
  #time: number;
  readonly #issues = new Map<string, number>();
  readonly #pulls = new Map<string, TrackerPullRequest>();

  private constructor(recording: Recording, settings: Settings, store: BugStore, prompts: Prompts) {
    this.recording = recording;
    this.settings = settings;
    this.store = store;
    this.#time = Date.parse(recording.startAt);
    const clock = (): Date => new Date((this.#time += 1000));
    const [owner = '', name = ''] = recording.repository.split('/');
    this.tracker = new InMemoryTracker({ repo: { owner, name }, now: () => clock().toISOString() });
    this.offline = new OfflineDevin({ apiKey: OFFLINE_KEY, orgId: OFFLINE_KEY, now: clock });
    let attempt = 0;
    this.client = new DevinClient({
      apiKey: OFFLINE_KEY,
      orgId: OFFLINE_KEY,
      maxAcuPerSession: settings.devin.maxAcuPerSession,
      reviewEnabled: settings.devin.review,
      fetch: this.offline.fetch,
      newAttemptId: () => `replay-attempt-${++attempt}`,
    });
    this.verifier = new RecordedVerifier(clock);
    this.orchestrator = new Orchestrator({
      store,
      tracker: this.tracker,
      devin: this.client,
      settings,
      prompts,
      verifier: this.verifier,
      requireLiveResults: false,
      now: clock,
    });
  }

  static async create(recording: Recording, settings: Settings, store: BugStore): Promise<ReplayWorld> {
    return new ReplayWorld(recording, settings, store, await Prompts.load());
  }

  /** The simulated time, without advancing the clock. */
  get time(): Date {
    return new Date(this.#time);
  }

  get lastCycleAt(): string | null {
    return this.orchestrator.lastCycleAt;
  }

  get remaining(): number {
    return this.recording.steps.length - this.played;
  }

  /** Bug key of an issue alias, or `null` before the step that opens it has been played. */
  keyOf(alias: string): string | null {
    const number = this.#issues.get(alias);
    if (number === undefined) return null;
    const { owner, name } = this.tracker.repo;
    return formatBugKey({ owner, repo: name, number });
  }

  /** Plays the next step; throws `ReplayStepError` when it does not reach its documented outcome. */
  async next(): Promise<StepResult> {
    const step = this.recording.steps[this.played];
    if (step === undefined) throw new ReplayStepError('Every step of the recording has been played');
    const number = this.played + 1;
    this.#time += step.minutes * 60_000;
    for (const event of step.events) this.#apply(event);
    let cycles = 0;
    while (cycles < step.maxCycles) {
      await this.orchestrator.runCycle();
      cycles += 1;
      if (await this.#holds(step.expect)) break;
    }
    const states = await Promise.all([...new Set(step.expect.map((expectation) => expectation.issue))].map((alias) => this.stateOf(alias)));
    if (!(await this.#holds(step.expect))) {
      const shown = states.map((state) => (state === null ? 'not enrolled' : `${state.key} ${state.stage}/${state.status}/${state.verification ?? 'unverified'}`));
      throw new ReplayStepError(`Step ${number} (${step.title}) did not reach its documented outcome after ${cycles} cycles: ${shown.join(', ')}`);
    }
    this.played = number;
    return { number, step, cycles, states: states.filter((state): state is IssueState => state !== null) };
  }

  /** Current stage, status and verification of an issue alias; `null` when it has no record. */
  async stateOf(alias: string): Promise<IssueState | null> {
    const key = this.keyOf(alias);
    const record = key === null ? undefined : this.store.get(key);
    if (key === null || record === undefined) return null;
    return this.stateOfRecord(record);
  }

  async stateOfRecord(record: BugRecord): Promise<IssueState> {
    const number = Number(record.key.split('#')[1]);
    const issue = await this.tracker.getIssue(number);
    const pr = record.fix === null ? null : await this.tracker.getPullRequest(record.fix.prNumber);
    const presentation = presentBug(record, toGitHubFacts(this.tracker.repo, issue, pr), this.settings.labels);
    return {
      key: record.key,
      stage: record.stage,
      status: presentation.status,
      verification: record.verifications.at(-1)?.result ?? null,
      verifications: record.verifications.length,
      review: presentation.automation.review?.status ?? null,
    };
  }

  async #holds(expectations: readonly Expectation[]): Promise<boolean> {
    for (const expectation of expectations) {
      const state = await this.stateOf(expectation.issue);
      if (state === null) return false;
      if (expectation.stage !== undefined && state.stage !== expectation.stage) return false;
      if (expectation.status !== undefined && state.status !== expectation.status) return false;
      if (expectation.verification !== undefined && state.verification !== expectation.verification) return false;
      if (expectation.verifications !== undefined && state.verifications !== expectation.verifications) return false;
      if (expectation.review !== undefined && state.review !== expectation.review) return false;
    }
    return true;
  }

  #issue(alias: string): number {
    const number = this.#issues.get(alias);
    if (number === undefined) throw new ReplayStepError(`Issue ${alias} has not been opened`);
    return number;
  }

  #pull(alias: string): TrackerPullRequest {
    const pr = this.#pulls.get(alias);
    if (pr === undefined) throw new ReplayStepError(`Pull request ${alias} has not been opened`);
    return pr;
  }

  #session(alias: string): string {
    const key = this.keyOf(alias);
    const session = key === null ? null : this.store.get(key)?.session ?? null;
    if (session === null) throw new ReplayStepError(`Issue ${alias} has no Devin session`);
    return session.id;
  }

  #apply(event: ReplayEvent): void {
    switch (event.type) {
      case 'issue-opened': {
        const issue = this.tracker.seedIssue({ title: event.title, body: event.body, labels: event.labels, author: event.author });
        this.#issues.set(event.issue, issue.number);
        return;
      }
      case 'comment':
        this.tracker.externalComment(this.#issue(event.issue), event.author, event.body);
        return;
      case 'label':
        this.tracker.externalLabel(this.#issue(event.issue), event.label, event.action, event.actor);
        return;
      case 'issue-closed':
        this.tracker.externalCloseIssue(this.#issue(event.issue), event.actor);
        return;
      case 'devin-working':
        this.offline.updateSession(this.#session(event.issue), { status: 'running', status_detail: 'working' });
        return;
      case 'devin-asks':
        this.offline.updateSession(this.#session(event.issue), {
          status: 'running',
          status_detail: 'waiting_for_user',
          structured_output: { phase: event.phase, status: 'needs_input', question: event.question },
        });
        return;
      case 'devin-triage':
        this.offline.updateSession(this.#session(event.issue), { status: 'running', status_detail: 'finished', structured_output: event.output });
        return;
      case 'devin-ends':
        this.offline.updateSession(this.#session(event.issue), { status: 'exit', status_detail: null });
        return;
      case 'pull-request-opened': {
        const number = this.#issue(event.issue);
        const pr = this.tracker.seedPullRequest({
          title: event.title,
          body: `Fixes #${number}`,
          headSha: event.headSha,
          author: 'devin-ai-integration[bot]',
          files: [{ filename: event.file, previousFilename: null, status: 'modified', additions: event.additions, deletions: event.deletions, changes: event.additions + event.deletions, patch: null }],
          references: [number],
        });
        this.#pulls.set(event.pr, pr);
        this.offline.pullRequestHeads.set(pr.url, event.headSha);
        return;
      }
      case 'devin-pr': {
        const pr = this.#pull(event.pr);
        this.offline.updateSession(this.#session(event.issue), {
          status: 'running',
          status_detail: 'finished',
          pull_requests: [{ pr_url: pr.url, pr_state: 'open' }],
          structured_output: { phase: 'fix', status: 'pr_opened', pr_url: pr.url, test_files: event.testFiles, fix_summary: event.summary },
        });
        return;
      }
      case 'head-pushed': {
        const pr = this.#pull(event.pr);
        this.tracker.pushHead(pr.number, event.headSha);
        this.offline.pullRequestHeads.set(pr.url, event.headSha);
        return;
      }
      case 'check-run': {
        const pr = this.#pull(event.pr);
        const head = this.offline.pullRequestHeads.get(pr.url) ?? pr.headSha;
        this.tracker.addCheckRun(head, { name: event.name, status: 'completed', conclusion: event.conclusion });
        return;
      }
      case 'review-completed': {
        const pr = this.#pull(event.pr);
        const review = this.offline.reviews.get(pr.url);
        if (review === undefined) throw new ReplayStepError(`No Devin Review was requested for ${event.pr}`);
        review.status = 'completed';
        return;
      }
      case 'verifier-result': {
        const key = this.keyOf(event.issue);
        if (key === null) throw new ReplayStepError(`Issue ${event.issue} has not been opened`);
        this.verifier.queue(key, event.result, event.reason, event.output);
        return;
      }
      case 'merged': {
        const pr = this.#pull(event.pr);
        this.tracker.externalMerge(pr.number, event.actor, event.mergeCommitSha);
        return;
      }
    }
  }
}
