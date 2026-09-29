import { createHash } from 'node:crypto';
import type { GitHubRepo, Settings } from '../config/settings.ts';
import type { DevinClient } from '../devin/client.ts';
import { DevinError } from '../devin/errors.ts';
import {
  bugTag,
  fixSubmittedEvent,
  sessionStatusEvent,
  sessionTags,
  structuredOutputEvents,
  type DevinSession,
} from '../devin/sessions.ts';
import type { StructuredSignal } from '../devin/structured-output.ts';
import { parseBugKey } from '../model/keys.ts';
import { resolveLabels } from '../model/labels.ts';
import { outstandingQuestion } from '../model/presentation.ts';
import {
  applyAction,
  applyEvent,
  DEFAULT_MAX_VERIFICATION_ERRORS,
  enrollBug,
  type ActionRequest,
  type Effect,
  type ModelEvent,
  type ModelOptions,
  type ModelResult,
} from '../model/transitions.ts';
import type { ActionName, BugRecord, Stage, WorkflowOperation, WorkflowState, WorkRoute } from '../model/types.ts';
import type { BugStore } from '../store/bug-store.ts';
import { hasLabel, toGitHubFacts } from '../tracker/common.ts';
import {
  TrackerError,
  type Actor,
  type IssueEvent,
  type Tracker,
  type TrackerComment,
  type TrackerIssue,
  type TrackerPullRequest,
} from '../tracker/types.ts';
import {
  existingPullRequestComment,
  policyDecisionComment,
  questionComment,
  triageComment,
  triagePullRequestNotice,
} from './comments.ts';
import {
  githubActor,
  INTERFACE_ACTOR,
  policyActor,
  UNAVAILABLE_POLICY,
  UNAVAILABLE_VERIFIER,
  type DecisionPolicy,
  type Verifier,
} from './contracts.ts';
import type { HumanComment, IssueContext, Prompts } from './prompts.ts';

/** The Devin operations the orchestrator uses. `DevinClient` satisfies it; so does `DevinClient` over `OfflineDevin`. */
export type OrchestratorDevin = Pick<
  DevinClient,
  'createSession' | 'getSession' | 'findSessions' | 'sendMessage' | 'listMessages' | 'terminateSession'
>;

export type TraceType =
  | 'cycle-started'
  | 'cycle-finished'
  | 'cycle-skipped'
  | 'enrolled'
  | 'not-enrolled'
  | 'transition'
  | 'refused'
  | 'effect-applied'
  | 'effect-failed'
  | 'effect-dropped'
  | 'message-already-delivered'
  | 'dispatch-intent'
  | 'session-created'
  | 'create-ambiguous'
  | 'create-failed'
  | 'reconcile-not-found'
  | 'create-abandoned'
  | 'waiting-for-capacity'
  | 'waiting-for-session-end'
  | 'label-conflict'
  | 'decision-label-ignored'
  | 'structured-output-ignored'
  | 'unexpected-triage-pr'
  | 'reply-relayed'
  | 'comment-ignored'
  | 'question-posted'
  | 'verifier-unavailable'
  | 'policy-unavailable'
  | 'error';

export interface TraceEvent {
  cycle: number;
  at: string;
  key: string | null;
  type: TraceType;
  detail: Record<string, unknown>;
}

export interface OrchestratorOptions {
  store: BugStore;
  tracker: Tracker;
  devin: OrchestratorDevin;
  settings: Settings;
  prompts: Prompts;
  verifier?: Verifier;
  policy?: DecisionPolicy;
  /** When true, results from dependencies that are not live (stubs, fixtures) are refused as unavailable. */
  requireLiveResults?: boolean;
  /** Logins whose comments and label changes are the service's own, besides bots and marked comments. */
  serviceLogins?: readonly string[];
  playbookId?: string | null;
  /** Reconciliation lookups without a match before an unconfirmed create is abandoned (default 3). */
  reconcileAttempts?: number;
  now?: () => Date;
  trace?: (event: TraceEvent) => void;
}

export type ActionOutcome =
  | { status: 'applied'; record: BugRecord }
  | { status: 'deferred'; reason: string }
  | { status: 'refused'; code: string; message: string };

type CommitStatus = 'applied' | 'unchanged' | 'refused' | 'deferred';

const WORKING_STAGES: readonly Stage[] = ['triaging', 'fixing', 'verifying'];
const RELAY_STAGES: readonly Stage[] = ['triaging', 'needs-input', 'fixing'];
const HANDOFF_STAGES: readonly Stage[] = ['queued', 'triaging', 'needs-input', 'triaged', 'fixing'];
const OUTPUT_TAIL_CHARS = 4000;
const RECONCILE_WINDOW_MS = 5 * 60_000;

export function emptyWorkflow(): WorkflowState {
  return { dispatch: null, outbox: [], relayedCommentIds: [], handledEventIds: [], workQuestion: null, notices: [] };
}

function workflowOf(record: BugRecord): WorkflowState {
  return structuredClone(record.workflow ?? emptyWorkflow());
}

/**
 * Whether a record occupies one of `MAX_ACTIVE_SESSIONS`: a session being created, or a live session doing
 * work. Sessions waiting on a person (an open question, a triaged record awaiting a decision) do not count.
 */
export function consumesCapacity(record: BugRecord): boolean {
  if (record.workflow?.dispatch) return true;
  const session = record.session;
  if (session === null || session.liveState === 'ended' || session.stopRequestedAt !== null) return false;
  if (!WORKING_STAGES.includes(record.stage)) return false;
  return record.workflow?.workQuestion?.sessionId !== session.id;
}

function commentKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._:/-]/g, '-').slice(0, 100);
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameOperation(a: WorkflowOperation, b: WorkflowOperation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Errors that will not succeed on retry, so the operation is dropped instead of blocking the outbox. */
function permanentFailure(error: unknown): boolean {
  if (error instanceof TrackerError) return !error.retryable && !error.ambiguous;
  if (error instanceof DevinError) return ['forbidden', 'not-found', 'conflict', 'invalid-request'].includes(error.kind);
  return false;
}

/**
 * Durable workflow loop: reads GitHub and Devin facts, feeds them to the pure model, persists the result
 * together with its side effects (an outbox), then applies the effects. Each issue moves at most one
 * workflow step per cycle, cycles never overlap, and a restart resumes from the store without repeating
 * applied effects.
 */
export class Orchestrator {
  readonly #store: BugStore;
  readonly #tracker: Tracker;
  readonly #devin: OrchestratorDevin;
  readonly #settings: Settings;
  readonly #prompts: Prompts;
  readonly #verifier: Verifier;
  readonly #policy: DecisionPolicy;
  readonly #requireLive: boolean;
  readonly #serviceLogins: ReadonlySet<string>;
  readonly #playbookId: string | null;
  readonly #reconcileAttempts: number;
  readonly #now: () => Date;
  readonly #trace: (event: TraceEvent) => void;
  readonly #model: ModelOptions;
  readonly #repo: GitHubRepo;
  #cycle = 0;
  #inFlight: Promise<void> | null = null;
  #lock: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #stopped = true;

  constructor(options: OrchestratorOptions) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#devin = options.devin;
    this.#settings = options.settings;
    this.#prompts = options.prompts;
    this.#verifier = options.verifier ?? UNAVAILABLE_VERIFIER;
    this.#policy = options.policy ?? UNAVAILABLE_POLICY;
    this.#requireLive = options.requireLiveResults ?? false;
    this.#serviceLogins = new Set((options.serviceLogins ?? []).map((login) => login.toLowerCase()));
    this.#playbookId = options.playbookId ?? null;
    this.#reconcileAttempts = options.reconcileAttempts ?? 3;
    this.#now = options.now ?? (() => new Date());
    this.#trace = options.trace ?? (() => {});
    this.#model = {
      labels: options.settings.labels,
      maxFixRetries: options.settings.maxFixRetries,
      maxVerificationErrors: DEFAULT_MAX_VERIFICATION_ERRORS,
    };
    this.#repo = options.tracker.repo;
  }

  /** Polls every `POLL_SECONDS`; the next cycle is scheduled only after the previous one finished. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    const tick = async (): Promise<void> => {
      this.#timer = null;
      if (this.#stopped) return;
      await this.runCycle().catch((error: unknown) => this.#emit(null, 'error', { during: 'cycle', message: describe(error) }));
      if (this.#stopped) return;
      this.#timer = setTimeout(() => void tick(), this.#settings.pollSeconds * 1000);
      this.#timer.unref();
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#inFlight?.catch(() => {});
  }

  /** Runs one cycle. A call while a cycle is running joins it instead of starting an overlapping one. */
  runCycle(): Promise<void> {
    if (this.#inFlight !== null) {
      this.#emit(null, 'cycle-skipped', { reason: 'previous cycle still running' });
      return this.#inFlight;
    }
    const run = this.#exclusive(() => this.#runCycle());
    this.#inFlight = run.finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Applies a person's action taken through the service interface, attributed to `INTERFACE_ACTOR`. */
  performAction(
    key: string,
    request: { name: ActionName; context?: string; answer?: string },
  ): Promise<ActionOutcome> {
    return this.#exclusive(() => this.#performAction(key, request));
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(work);
    this.#lock = run.catch(() => {});
    return run;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #emit(key: string | null, type: TraceType, detail: Record<string, unknown> = {}): void {
    this.#trace({ cycle: this.#cycle, at: this.#nowIso(), key, type, detail });
  }

  // Cycle ----------------------------------------------------------------------------------------------------

  async #runCycle(): Promise<void> {
    this.#cycle += 1;
    this.#emit(null, 'cycle-started');
    const labels = [
      this.#settings.labels.triage,
      this.#settings.labels.fix,
      this.#settings.labels.engineer,
      this.#settings.labels.feature,
    ];
    let open: TrackerIssue[];
    try {
      open = await this.#tracker.listOpenIssues(labels);
    } catch (error) {
      this.#emit(null, 'error', { during: 'listOpenIssues', message: describe(error) });
      this.#emit(null, 'cycle-finished');
      return;
    }
    const issues = new Map(open.map((issue) => [issue.number, issue]));
    for (const record of this.#store.list()) {
      const parts = parseBugKey(record.key);
      if (parts === null || parts.owner !== this.#repo.owner || parts.repo !== this.#repo.name) continue;
      if (issues.has(parts.number)) continue;
      try {
        issues.set(parts.number, await this.#tracker.getIssue(parts.number));
      } catch (error) {
        this.#emit(record.key, 'error', { during: 'getIssue', message: describe(error) });
      }
    }
    for (const issue of [...issues.values()].sort((a, b) => a.number - b.number)) {
      try {
        await this.#step(issue);
      } catch (error) {
        this.#emit(issue.key, 'error', { during: 'step', message: describe(error) });
      }
    }
    this.#emit(null, 'cycle-finished');
  }

  /** Takes at most one workflow step for the issue; each branch returns once it has persisted a change. */
  async #step(issue: TrackerIssue): Promise<void> {
    const key = issue.key;
    let record = this.#store.get(key);
    if (record === undefined) {
      await this.#enroll(issue);
      return;
    }
    if ((record.workflow?.outbox.length ?? 0) > 0) {
      if (!(await this.#drain(key))) return;
      record = this.#store.get(key) as BugRecord;
    }

    if (record.fix !== null && record.fix.mergeCommitSha === null) {
      if (await this.#observePullRequest(issue, record)) return;
    }

    if (issue.state === 'closed') {
      const closed = this.#event(record, { type: 'issue-closed' });
      const clearQuestion = (state: WorkflowState): void => {
        state.workQuestion = null;
      };
      if ((await this.#commit(issue, record, closed, 'issue-closed', { mutate: clearQuestion })) === 'applied') {
        return;
      }
    } else if (record.stage === 'closed') {
      await this.#commit(issue, record, this.#event(record, { type: 'issue-reopened', labels: issue.labels }), 'issue-reopened');
      return;
    }
    if (issue.state === 'closed') {
      await this.#observeStoppedSession(issue, this.#store.get(key) as BugRecord);
      return;
    }

    if (await this.#personLabelDecision(issue, record)) return;
    record = this.#store.get(key) as BugRecord;

    const snapshot = this.#event(record, { type: 'labels-changed', labels: issue.labels });
    if (record.stage === 'triaged' && snapshot.ok && snapshot.changed && snapshot.record.stage !== 'with-engineer') {
      this.#emit(key, 'decision-label-ignored', { reason: 'repair label was not added by a person' });
    } else {
      const labels = await this.#commit(issue, record, snapshot, 'labels-changed');
      if (labels === 'applied' || labels === 'deferred') return;
    }

    if (record.workflow?.dispatch) {
      await this.#reconcileDispatch(issue, record);
      return;
    }
    if (record.session !== null && record.session.liveState !== 'ended') {
      if (await this.#observeSession(issue, record)) return;
      record = this.#store.get(key) as BugRecord;
    }
    if (await this.#relayReply(issue, record)) return;
    if (record.stage === 'verifying') {
      await this.#verify(issue, record);
      return;
    }
    if (record.stage === 'triaged' && this.#settings.decision !== 'person') {
      await this.#decide(issue, record);
      return;
    }
    if (record.stage === 'queued' && record.route !== null) await this.#dispatch(issue, record);
  }

  #event(record: BugRecord, event: ModelEvent, at?: string): ModelResult {
    return applyEvent(record, event, this.#model, at ?? this.#nowIso());
  }

  async #enroll(issue: TrackerIssue): Promise<void> {
    if (issue.state !== 'open') return;
    const result = enrollBug(toGitHubFacts(this.#repo, issue, null), this.#model, this.#nowIso());
    if (!result.ok) {
      this.#emit(issue.key, 'not-enrolled', { code: result.error.code, message: result.error.message });
      return;
    }
    const events = await this.#tracker.listIssueEvents(issue.number);
    const workflow = emptyWorkflow();
    workflow.handledEventIds = events.filter((event) => this.#workflowLabelEvent(event)).map((event) => event.id);
    const record = result.record;
    record.workflow = workflow;
    await this.#store.update(issue.key, () => record);
    this.#emit(issue.key, 'enrolled', { stage: record.stage, route: record.route, kind: record.kind });
  }

  // Persistence and effects ------------------------------------------------------------------------------------

  /**
   * Persists a model result with its effects as outbox operations in one atomic write, then applies them.
   * A transition that would make a record consume capacity waits while `MAX_ACTIVE_SESSIONS` is reached,
   * and continuing into repair is refused in favour of a handoff when an open PR already addresses the issue.
   */
  async #commit(
    issue: TrackerIssue,
    before: BugRecord,
    result: ModelResult,
    what: string,
    extra: {
      /** Applied before the model's effects. */
      first?: WorkflowOperation[];
      ops?: WorkflowOperation[];
      mutate?: (workflow: WorkflowState) => void;
      quiet?: boolean;
    } = {},
  ): Promise<CommitStatus> {
    if (!result.ok) {
      if (extra.quiet !== true) {
        this.#emit(before.key, 'refused', { what, code: result.error.code, message: result.error.message });
      }
      return 'refused';
    }
    if (!result.changed) return 'unchanged';
    const next = result.record;
    if (result.effects.some((effect) => effect.type === 'continue-session')) {
      const existing = await this.#existingPullRequest(issue);
      if (existing !== null) return this.#handOffExistingPr(issue, before, existing);
    }
    const workflow = workflowOf(next);
    extra.mutate?.(workflow);
    next.workflow = workflow;
    if (!consumesCapacity(before) && consumesCapacity(next) && this.#activeElsewhere(before.key) >= this.#maxActive()) {
      this.#emit(before.key, 'waiting-for-capacity', { what, active: this.#activeElsewhere(before.key) });
      return 'deferred';
    }
    workflow.outbox.push(...(extra.first ?? []));
    for (const effect of result.effects) workflow.outbox.push(await this.#operation(issue, next, workflow, effect));
    workflow.outbox.push(...(extra.ops ?? []));
    await this.#store.update(before.key, () => next);
    this.#emit(before.key, 'transition', {
      what,
      from: before.stage,
      to: next.stage,
      operations: workflow.outbox.map((op) => op.type),
    });
    await this.#drain(before.key);
    return 'applied';
  }

  /** Persists orchestrator bookkeeping that is not a model transition, then applies any queued operations. */
  async #persistWorkflow(
    record: BugRecord,
    mutate: (workflow: WorkflowState) => void,
    ops: WorkflowOperation[] = [],
  ): Promise<void> {
    const next = structuredClone(record);
    const workflow = workflowOf(next);
    mutate(workflow);
    workflow.outbox.push(...ops);
    next.workflow = workflow;
    await this.#store.update(record.key, () => next);
    if (ops.length > 0) await this.#drain(record.key);
  }

  async #operation(
    issue: TrackerIssue,
    record: BugRecord,
    workflow: WorkflowState,
    effect: Effect,
  ): Promise<WorkflowOperation> {
    switch (effect.type) {
      case 'continue-session': {
        const comments = await this.#freshHumanComments(issue, workflow);
        workflow.relayedCommentIds.push(...comments.all);
        const marker = `bug-smasher:continue:${effect.sessionId}:${record.stageHistory.length}`;
        const message = this.#prompts.repairContinue(
          this.#issueContext(issue),
          record.triage,
          comments.included,
          this.#decisionContext(record),
          marker,
        );
        return { type: 'send-message', sessionId: effect.sessionId, marker, message };
      }
      case 'post-comment':
        return {
          type: 'post-comment',
          key: commentKey(`model-comment:${hash(`${record.key}\n${record.updatedAt}\n${effect.body}`)}`),
          body: effect.body,
        };
      default:
        return effect;
    }
  }

  /** Applies queued operations in order. Returns false when one is still pending (it is retried next cycle). */
  async #drain(key: string): Promise<boolean> {
    for (;;) {
      const record = this.#store.get(key);
      const op = record?.workflow?.outbox[0];
      if (record === undefined || op === undefined) return true;
      let dropped = false;
      try {
        await this.#applyOperation(record, op);
      } catch (error) {
        if (!permanentFailure(error)) {
          this.#emit(key, 'effect-failed', { operation: op.type, message: describe(error) });
          return false;
        }
        dropped = true;
        this.#emit(key, 'effect-dropped', { operation: op.type, message: describe(error) });
      }
      await this.#store.update(key, (current) => {
        if (current?.workflow === undefined) return undefined;
        const first = current.workflow.outbox[0];
        if (first === undefined || !sameOperation(first, op)) return undefined;
        current.workflow.outbox.shift();
        return current;
      });
      if (!dropped) this.#emit(key, 'effect-applied', { operation: op.type, ...this.#operationDetail(op) });
    }
  }

  #operationDetail(op: WorkflowOperation): Record<string, unknown> {
    switch (op.type) {
      case 'add-label':
      case 'remove-label':
        return { label: op.label };
      case 'stop-session':
        return { sessionId: op.sessionId };
      case 'post-comment':
        return { commentKey: op.key };
      case 'send-message':
        return { sessionId: op.sessionId, marker: op.marker };
      case 'merge-pr':
        return { prNumber: op.prNumber };
      case 'close-issue':
        return {};
    }
  }

  async #applyOperation(record: BugRecord, op: WorkflowOperation): Promise<void> {
    const number = (parseBugKey(record.key) as { number: number }).number;
    switch (op.type) {
      case 'add-label':
        await this.#tracker.addLabels(number, [op.label]);
        return;
      case 'remove-label':
        await this.#tracker.removeLabel(number, op.label);
        return;
      case 'close-issue':
        await this.#tracker.closeIssue(number);
        return;
      case 'stop-session':
        try {
          await this.#devin.terminateSession(op.sessionId);
        } catch (error) {
          if (!(error instanceof DevinError && error.kind === 'not-found')) throw error;
        }
        return;
      case 'post-comment':
        await this.#tracker.postComment(number, op.body, { key: op.key });
        return;
      case 'send-message': {
        const messages = await this.#devin.listMessages(op.sessionId);
        if (messages.some((message) => message.source === 'user' && message.text.includes(op.marker))) {
          this.#emit(record.key, 'message-already-delivered', { sessionId: op.sessionId, marker: op.marker });
          return;
        }
        await this.#devin.sendMessage(op.sessionId, op.message);
        return;
      }
      case 'merge-pr':
        await this.#tracker.mergePullRequest(op.prNumber, { expectedHeadSha: op.expectedHeadSha });
        return;
    }
  }

  // Capacity -----------------------------------------------------------------------------------------------------

  #maxActive(): number {
    return this.#settings.devin.maxActiveSessions;
  }

  #activeElsewhere(key: string): number {
    return this.#store.list().filter((record) => record.key !== key && consumesCapacity(record)).length;
  }

  // People and comments ----------------------------------------------------------------------------------------

  #isPerson(actor: Actor | null): actor is Actor {
    return actor !== null && actor.type === 'user' && !this.#serviceLogins.has(actor.login.toLowerCase());
  }

  #isHumanComment(comment: TrackerComment): boolean {
    return !comment.fromService && this.#isPerson(comment.author) && comment.body.trim() !== '';
  }

  #workflowLabelEvent(event: IssueEvent): boolean {
    return event.type === 'labeled' && event.label !== null && this.#labelAction(event.label) !== null;
  }

  #labelAction(label: string): ActionName | null {
    const labels = this.#settings.labels;
    const is = (name: string): boolean => name.toLowerCase() === label.toLowerCase();
    if (is(labels.engineer)) return 'engineer';
    if (is(labels.fix) || is(labels.feature)) return 'fix';
    if (is(labels.triage)) return 'triage';
    return null;
  }

  #toHumanComment(comment: TrackerComment): HumanComment {
    return {
      id: comment.id,
      author: `@${(comment.author as Actor).login}`,
      url: comment.url,
      body: comment.body,
      createdAt: comment.createdAt,
    };
  }

  /** Human comments not yet delivered to Devin, all included in full. */
  async #freshHumanComments(
    issue: TrackerIssue,
    workflow: WorkflowState,
  ): Promise<{ included: HumanComment[]; all: string[] }> {
    const comments = await this.#tracker.listComments(issue.number);
    const fresh = comments.filter(
      (comment) => this.#isHumanComment(comment) && !workflow.relayedCommentIds.includes(comment.id),
    );
    return {
      included: fresh.map((comment) => this.#toHumanComment(comment)),
      all: fresh.map((comment) => comment.id),
    };
  }

  #decisionContext(record: BugRecord): string | null {
    const decision = record.decisions.at(-1);
    return decision?.context ? `${decision.context} (${decision.actor})` : null;
  }

  #issueContext(issue: TrackerIssue): IssueContext {
    return {
      repo: `${this.#repo.owner}/${this.#repo.name}`,
      issueNumber: issue.number,
      issueUrl: issue.url,
      title: issue.title,
      body: issue.body,
    };
  }

  /**
   * A workflow label added by a person since enrollment is that person's decision, recorded with their
   * GitHub login and the label event time. Labels changed by the service or bots are not decisions.
   */
  async #personLabelDecision(issue: TrackerIssue, record: BugRecord): Promise<boolean> {
    const workflow = workflowOf(record);
    const events = await this.#tracker.listIssueEvents(issue.number);
    const event = events.find(
      (candidate) => this.#workflowLabelEvent(candidate) && !workflow.handledEventIds.includes(candidate.id),
    );
    if (event === undefined) return false;
    const markHandled = (state: WorkflowState): void => {
      state.handledEventIds.push(event.id);
    };
    const label = event.label as string;
    if (!this.#isPerson(event.actor) || !hasLabel(issue.labels, label)) {
      await this.#persistWorkflow(record, markHandled);
      return false;
    }
    const facts = toGitHubFacts(this.#repo, issue, null);
    facts.issue.labels = facts.issue.labels.filter((name) => name.toLowerCase() !== label.toLowerCase());
    const at = event.at > record.updatedAt ? event.at : record.updatedAt;
    const request: ActionRequest = {
      name: this.#labelAction(label) as ActionName,
      actor: githubActor(event.actor.login),
      context: `Added the ${label} label on GitHub`,
    };
    const result = applyAction(record, facts, request, this.#model, at);
    if (!result.ok) {
      await this.#persistWorkflow(record, markHandled);
      return false;
    }
    const status = await this.#commit(issue, record, result, `person-${request.name}`, { mutate: markHandled });
    return status === 'applied' || status === 'deferred';
  }

  // Pull requests ----------------------------------------------------------------------------------------------

  async #observePullRequest(issue: TrackerIssue, record: BugRecord): Promise<boolean> {
    const fix = record.fix;
    if (fix === null) return false;
    const pr = await this.#tracker.getPullRequest(fix.prNumber);
    let event: ModelEvent | null = null;
    if (pr.state === 'merged' && pr.mergeCommitSha !== null) {
      event = { type: 'pr-merged', prNumber: pr.number, mergeCommitSha: pr.mergeCommitSha };
    } else if (pr.state === 'closed') {
      event = { type: 'pr-closed', prNumber: pr.number };
    } else if (pr.state === 'open' && pr.headSha !== fix.headSha) {
      event = { type: 'head-changed', prNumber: pr.number, headSha: pr.headSha };
    }
    if (event === null) return false;
    const ops: WorkflowOperation[] = [];
    const session = record.session;
    // Sent before the model's stop-session effect so the session hears about the merge first.
    if (event.type === 'pr-merged' && session !== null && session.liveState !== 'ended' && session.stopRequestedAt === null) {
      const marker = `bug-smasher:merged:${event.mergeCommitSha}`;
      ops.push({
        type: 'send-message',
        sessionId: session.id,
        marker,
        message: this.#prompts.postMergeAck({ issueRef: `#${issue.number}`, prUrl: fix.prUrl, mergeCommitSha: event.mergeCommitSha, marker }),
      });
    }
    const quiet = record.stage === 'closed' || record.stage === 'with-engineer';
    return (await this.#commit(issue, record, this.#event(record, event), event.type, { first: ops, quiet })) === 'applied';
  }

  async #existingPullRequest(issue: TrackerIssue): Promise<TrackerPullRequest | null> {
    const linked = await this.#tracker.findLinkedPullRequests(issue.number);
    const open = linked.find((link) => link.relation === 'closing' && link.pullRequest.state === 'open');
    return open?.pullRequest ?? null;
  }

  async #handOffExistingPr(issue: TrackerIssue, record: BugRecord, pr: TrackerPullRequest): Promise<CommitStatus> {
    if (!HANDOFF_STAGES.includes(record.stage)) return 'refused';
    const result = this.#event(record, {
      type: 'handoff-requested',
      reason: 'existing-pr',
      detail: `Open pull request #${pr.number} already addresses this issue: ${pr.url}`,
    });
    const body = existingPullRequestComment(pr.number, pr.url, this.#settings.labels.engineer);
    return this.#commit(issue, record, result, 'existing-pr', {
      ops: [{ type: 'post-comment', key: commentKey(`existing-pr:${pr.number}`), body }],
    });
  }

  // Sessions -----------------------------------------------------------------------------------------------------

  async #dispatch(issue: TrackerIssue, record: BugRecord): Promise<void> {
    const route = record.route as WorkRoute;
    if (record.session !== null && record.session.liveState !== 'ended') {
      this.#emit(record.key, 'waiting-for-session-end', { sessionId: record.session.id });
      return;
    }
    const labels = resolveLabels(issue.labels, this.#settings.labels);
    if (labels.conflict !== null) {
      this.#emit(record.key, 'label-conflict', { message: labels.conflict });
      return;
    }
    if (route === 'fix') {
      const existing = await this.#existingPullRequest(issue);
      if (existing !== null) {
        await this.#handOffExistingPr(issue, record, existing);
        return;
      }
    }
    const active = this.#activeElsewhere(record.key);
    if (active >= this.#maxActive()) {
      this.#emit(record.key, 'waiting-for-capacity', { what: `dispatch-${route}`, active });
      return;
    }

    const workflow = workflowOf(record);
    const comments = await this.#freshHumanComments(issue, workflow);
    const context = this.#issueContext(issue);
    const decision = this.#decisionContext(record);
    const prompt =
      route === 'triage'
        ? this.#prompts.investigation(context, comments.included, decision)
        : record.kind === 'feature'
          ? this.#prompts.feature(context, comments.included, decision)
          : this.#prompts.repairNew(context, record.triage, comments.included, decision);

    await this.#persistWorkflow(record, (state) => {
      state.dispatch = { route, requestedAt: this.#nowIso(), attemptTag: null, checks: 0, commentIds: comments.all };
    });
    this.#emit(record.key, 'dispatch-intent', { route, kind: record.kind });
    const pending = this.#store.get(record.key) as BugRecord;

    let result;
    try {
      result = await this.#devin.createSession({
        bugKey: record.key,
        route,
        prompt,
        title: `${route === 'triage' ? 'Investigate' : record.kind === 'feature' ? 'Build' : 'Fix'} ${record.key}: ${issue.title}`,
        repos: [`${this.#repo.owner}/${this.#repo.name}`],
        playbookId: this.#playbookId,
      });
    } catch (error) {
      if (error instanceof DevinError && !error.ambiguous) {
        await this.#persistWorkflow(pending, (state) => {
          state.dispatch = null;
        });
        this.#emit(record.key, 'create-failed', { kind: error.kind, message: error.message });
        return;
      }
      this.#emit(record.key, 'create-ambiguous', { message: describe(error), attemptTag: null });
      return;
    }
    if (result.outcome === 'ambiguous') {
      await this.#persistWorkflow(pending, (state) => {
        if (state.dispatch !== null) state.dispatch.attemptTag = result.tags.attempt;
      });
      this.#emit(record.key, 'create-ambiguous', { attemptTag: result.tags.attempt, message: result.error.message });
      return;
    }
    this.#emit(record.key, 'session-created', { sessionId: result.session.id, route });
    await this.#sessionStarted(issue, pending, result.session, [], 'session-started');
  }

  /** Resolves a persisted create intent by its attempt tag (or bug and route tags) instead of creating again. */
  async #reconcileDispatch(issue: TrackerIssue, record: BugRecord): Promise<void> {
    const dispatch = (record.workflow as WorkflowState).dispatch;
    if (dispatch === null) return;
    const found =
      dispatch.attemptTag !== null
        ? await this.#devin.findSessions([dispatch.attemptTag])
        : await this.#devin.findSessions([bugTag(record.key), sessionTags(record.key, dispatch.route, 'any').route], {
            createdAfter: new Date(Date.parse(dispatch.requestedAt) - RECONCILE_WINDOW_MS),
          });
    const sessions = found
      .filter((session) => session.id !== record.session?.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const [keep, ...duplicates] = sessions;
    if (keep === undefined) {
      const checks = dispatch.checks + 1;
      if (checks >= this.#reconcileAttempts) {
        await this.#persistWorkflow(record, (state) => {
          state.dispatch = null;
        });
        this.#emit(record.key, 'create-abandoned', { attemptTag: dispatch.attemptTag, checks });
        return;
      }
      await this.#persistWorkflow(record, (state) => {
        if (state.dispatch !== null) state.dispatch.checks = checks;
      });
      this.#emit(record.key, 'reconcile-not-found', { attemptTag: dispatch.attemptTag, checks });
      return;
    }
    const stops: WorkflowOperation[] = duplicates.map((session) => ({ type: 'stop-session', sessionId: session.id }));
    this.#emit(record.key, 'session-created', {
      sessionId: keep.id,
      route: dispatch.route,
      reconciled: true,
      duplicates: duplicates.map((session) => session.id),
    });
    await this.#sessionStarted(issue, record, keep, stops, 'session-reconciled');
  }

  async #sessionStarted(
    issue: TrackerIssue,
    record: BugRecord,
    session: DevinSession,
    extraOps: WorkflowOperation[],
    what: string,
  ): Promise<void> {
    const result = this.#event(record, {
      type: 'session-started',
      session: { id: session.id, url: session.url },
      issueState: issue.state,
      labels: issue.labels,
    });
    if (!result.ok) {
      this.#emit(record.key, 'refused', { what, code: result.error.code, message: result.error.message });
      await this.#persistWorkflow(
        record,
        (state) => {
          state.dispatch = null;
        },
        [{ type: 'stop-session', sessionId: session.id }, ...extraOps],
      );
      return;
    }
    const delivered = record.workflow?.dispatch?.commentIds ?? [];
    await this.#commit(issue, record, result, what, {
      ops: extraOps,
      mutate: (state) => {
        state.dispatch = null;
        state.relayedCommentIds.push(...delivered);
      },
    });
  }

  /**
   * Reads the live session. Only valid structured output and GitHub facts advance the record; provider
   * status alone only updates the session's live state (and an unexpected end hands off).
   */
  async #observeSession(issue: TrackerIssue, record: BugRecord): Promise<boolean> {
    const current = record.session;
    if (current === null) return false;
    let session: DevinSession | null;
    try {
      session = await this.#devin.getSession(current.id);
    } catch (error) {
      if (!(error instanceof DevinError && error.kind === 'not-found')) throw error;
      session = null;
    }
    if (session === null) {
      const gone: ModelEvent = { type: 'session-status', sessionId: current.id, liveState: 'ended' };
      return (await this.#commit(issue, record, this.#event(record, gone), 'session-status')) === 'applied';
    }
    const workflow = workflowOf(record);
    const output = session.structuredOutput;
    const signal: StructuredSignal | null = output.status === 'valid' ? output.signal : null;

    if (record.stage === 'triaging' || record.stage === 'needs-input') {
      if (current.route === 'triage' && (session.pullRequests.length > 0 || signal?.type === 'pr-opened')) {
        const notice = `triage-pr:${session.id}`;
        const urls = session.pullRequests.map((pr) => pr.url);
        if (signal?.type === 'pr-opened' && !urls.includes(signal.pullRequest.url)) urls.push(signal.pullRequest.url);
        this.#emit(record.key, 'unexpected-triage-pr', { sessionId: session.id, pullRequests: urls });
        if (!workflow.notices.includes(notice)) {
          await this.#persistWorkflow(
            record,
            (state) => {
              state.notices.push(notice);
            },
            [{ type: 'post-comment', key: commentKey(notice), body: triagePullRequestNotice(urls) }],
          );
          return true;
        }
        return this.#applyStatus(issue, record, session);
      }
      if (record.stage === 'triaging') {
        for (const event of structuredOutputEvents(session)) {
          const result = this.#event(record, event);
          if (!result.ok || !result.changed) continue;
          const ops: WorkflowOperation[] = [];
          if (event.type === 'question-asked') {
            ops.push({
              type: 'post-comment',
              key: commentKey(`question:${event.question.id}`),
              body: questionComment(event.question.summary),
            });
          } else if (event.type === 'triage-completed') {
            ops.push({
              type: 'post-comment',
              key: commentKey(`triage:${session.id}`),
              body: triageComment(event.findings, this.#settings.labels),
            });
          }
          return (await this.#commit(issue, record, result, event.type, { ops })) === 'applied';
        }
        this.#noteIgnoredOutput(record, session);
      }
    } else if (record.stage === 'fixing') {
      if (signal?.type === 'pr-opened') {
        if (await this.#submitFix(issue, record, session, signal)) return true;
      } else if ((signal?.type === 'needs-input' || signal?.type === 'blocked') && signal.phase === 'fix') {
        const notice = `work-question:${signal.questionId}`;
        if (!workflow.notices.includes(notice)) {
          await this.#persistWorkflow(
            record,
            (state) => {
              state.notices.push(notice);
              state.workQuestion = {
                id: signal.questionId,
                sessionId: session.id,
                summary: signal.question,
                askedAt: this.#nowIso(),
              };
            },
            [{ type: 'post-comment', key: commentKey(`question:${signal.questionId}`), body: questionComment(signal.question) }],
          );
          this.#emit(record.key, 'question-posted', { questionId: signal.questionId, phase: 'fix' });
          return true;
        }
      } else {
        this.#noteIgnoredOutput(record, session);
      }
    }
    return this.#applyStatus(issue, record, session);
  }

  /** On a closed issue only the stopped session's live state is followed, so a reopen can start new work. */
  async #observeStoppedSession(issue: TrackerIssue, record: BugRecord): Promise<void> {
    const current = record.session;
    if (current === null || current.liveState === 'ended') return;
    let session: DevinSession | null;
    try {
      session = await this.#devin.getSession(current.id);
    } catch (error) {
      if (!(error instanceof DevinError && error.kind === 'not-found')) throw error;
      session = null;
    }
    if (session === null) {
      const gone: ModelEvent = { type: 'session-status', sessionId: current.id, liveState: 'ended' };
      await this.#commit(issue, record, this.#event(record, gone), 'session-status', { quiet: true });
      return;
    }
    await this.#applyStatus(issue, record, session);
  }

  #noteIgnoredOutput(record: BugRecord, session: DevinSession): void {
    const output = session.structuredOutput;
    if (output.status === 'invalid') {
      this.#emit(record.key, 'structured-output-ignored', { sessionId: session.id, status: output.status, problems: output.problems });
    } else if (output.status === 'incomplete') {
      this.#emit(record.key, 'structured-output-ignored', { sessionId: session.id, status: output.status, missing: output.missing });
    }
  }

  async #applyStatus(issue: TrackerIssue, record: BugRecord, session: DevinSession): Promise<boolean> {
    const event = sessionStatusEvent(session);
    if (event === null) return false;
    return (await this.#commit(issue, record, this.#event(record, event), 'session-status', { quiet: true })) === 'applied';
  }

  async #submitFix(
    issue: TrackerIssue,
    record: BugRecord,
    session: DevinSession,
    signal: Extract<StructuredSignal, { type: 'pr-opened' }>,
  ): Promise<boolean> {
    const ref = signal.pullRequest;
    if (
      ref.owner.toLowerCase() !== this.#repo.owner.toLowerCase() ||
      ref.repo.toLowerCase() !== this.#repo.name.toLowerCase()
    ) {
      this.#emit(record.key, 'structured-output-ignored', { sessionId: session.id, reason: `PR ${ref.url} is in another repository` });
      return false;
    }
    if (record.fix?.prNumber === ref.number) return false;
    if (record.priorFixes.some((fix) => fix.prNumber === ref.number)) {
      this.#emit(record.key, 'structured-output-ignored', { sessionId: session.id, reason: `PR #${ref.number} was replaced earlier` });
      return false;
    }
    const pr = await this.#tracker.getPullRequest(ref.number);
    if (pr.state !== 'open') {
      this.#emit(record.key, 'structured-output-ignored', { sessionId: session.id, reason: `PR #${ref.number} is ${pr.state}` });
      return false;
    }
    const linked = await this.#tracker.findLinkedPullRequests(issue.number);
    if (!linked.some((link) => link.relation === 'closing' && link.pullRequest.number === ref.number)) {
      this.#emit(record.key, 'structured-output-ignored', {
        sessionId: session.id,
        reason: `PR #${ref.number} does not close #${issue.number}`,
      });
      return false;
    }
    const event = fixSubmittedEvent(session, pr.headSha);
    if (event === null) return false;
    return (await this.#commit(issue, record, this.#event(record, event), 'fix-submitted')) === 'applied';
  }

  /**
   * Relays one genuine human comment per cycle, unchanged, to the live session. The comment ID is recorded in
   * the same write that queues the message, and the message carries a marker, so a restart neither drops nor
   * repeats it. Answering a question wakes the session, which waits for capacity like any other work.
   */
  async #relayReply(issue: TrackerIssue, record: BugRecord): Promise<boolean> {
    const session = record.session;
    if (session === null || session.liveState === 'ended' || session.stopRequestedAt !== null) return false;
    if (!RELAY_STAGES.includes(record.stage)) return false;
    const workflow = workflowOf(record);
    const comments = await this.#tracker.listComments(issue.number);
    const comment = comments.find(
      (candidate) => !workflow.relayedCommentIds.includes(candidate.id) && this.#isHumanComment(candidate),
    );
    if (comment === undefined) return false;
    const question = outstandingQuestion(record);
    const waking = question !== null || workflow.workQuestion?.sessionId === session.id;
    if (waking && this.#activeElsewhere(record.key) >= this.#maxActive()) {
      this.#emit(record.key, 'waiting-for-capacity', { what: 'reply', commentId: comment.id });
      return true;
    }
    const marker = `bug-smasher:relay:${comment.id}`;
    const op: WorkflowOperation = {
      type: 'send-message',
      sessionId: session.id,
      marker,
      message: this.#prompts.replyRelay({
        author: `@${(comment.author as Actor).login}`,
        commentUrl: comment.url,
        reply: comment.body,
        marker,
      }),
    };
    const mark = (state: WorkflowState): void => {
      state.relayedCommentIds.push(comment.id);
      state.workQuestion = null;
    };
    this.#emit(record.key, 'reply-relayed', { commentId: comment.id, sessionId: session.id, questionId: question?.id ?? workflow.workQuestion?.id ?? null });
    if (question !== null) {
      await this.#commit(issue, record, this.#event(record, { type: 'reply-received', questionId: question.id }), 'reply-received', {
        ops: [op],
        mutate: mark,
      });
      return true;
    }
    await this.#persistWorkflow(record, mark, [op]);
    return true;
  }

  // Verification and decisions ----------------------------------------------------------------------------------

  async #verify(issue: TrackerIssue, record: BugRecord): Promise<void> {
    const fix = record.fix;
    if (fix === null) return;
    if (this.#requireLive && !this.#verifier.live) {
      this.#emit(record.key, 'verifier-unavailable', { reason: 'The configured verifier is not live' });
      return;
    }
    const pr = await this.#tracker.getPullRequest(fix.prNumber);
    const outcome = await this.#verifier.verify({
      bugKey: record.key,
      phase: 'pre-merge',
      prNumber: fix.prNumber,
      prUrl: fix.prUrl,
      headSha: fix.headSha,
      baseSha: pr.baseSha,
      testFiles: [...fix.testFiles],
    });
    if (outcome.status === 'unavailable') {
      this.#emit(record.key, 'verifier-unavailable', { reason: outcome.reason });
      return;
    }
    const attempt = outcome.attempt;
    if (attempt.phase !== 'pre-merge' || attempt.headSha !== fix.headSha) {
      this.#emit(record.key, 'refused', { what: 'verification-recorded', code: 'stale-verification', message: `Result for ${attempt.phase} ${attempt.headSha} does not match head ${fix.headSha}` });
      return;
    }
    const result = this.#event(record, { type: 'verification-recorded', attempt });
    const ops: WorkflowOperation[] = [];
    if (result.ok && result.record.stage === 'fixing' && attempt.result === 'fail') {
      const session = result.record.session;
      if (session !== null && session.liveState !== 'ended' && session.stopRequestedAt === null) {
        const marker = `bug-smasher:retry:${fix.headSha}`;
        ops.push({
          type: 'send-message',
          sessionId: session.id,
          marker,
          message: this.#prompts.verificationRetry({
            prUrl: fix.prUrl,
            headSha: fix.headSha,
            reason: attempt.reason,
            output: attempt.outputTail.slice(-OUTPUT_TAIL_CHARS),
            marker,
          }),
        });
      }
    }
    await this.#commit(issue, record, result, `verification-${attempt.result}`, { ops });
  }

  async #decide(issue: TrackerIssue, record: BugRecord): Promise<void> {
    if (this.#requireLive && !this.#policy.live) {
      this.#emit(record.key, 'policy-unavailable', { reason: 'The configured decision policy is not live' });
      return;
    }
    const outcome = await this.#policy.decide({ record, issue });
    if (outcome.status === 'unavailable') {
      this.#emit(record.key, 'policy-unavailable', { reason: outcome.reason });
      return;
    }
    if (outcome.status === 'wait') return;
    const result = applyAction(
      record,
      toGitHubFacts(this.#repo, issue, null),
      { name: outcome.action, actor: policyActor(outcome.rule), context: outcome.reasons.join('; ') },
      this.#model,
      this.#nowIso(),
    );
    await this.#commit(issue, record, result, `policy-${outcome.action}`, {
      ops: [
        {
          type: 'post-comment',
          key: commentKey(`decision:${record.key}:${record.decisions.length}`),
          body: policyDecisionComment(outcome.action, outcome.rule, outcome.reasons),
        },
      ],
    });
  }

  // Interface actions --------------------------------------------------------------------------------------------

  async #performAction(
    key: string,
    request: { name: ActionName; context?: string; answer?: string },
  ): Promise<ActionOutcome> {
    const record = this.#store.get(key);
    const parts = parseBugKey(key);
    if (record === undefined || parts === null) {
      return { status: 'refused', code: 'not-tracked', message: `${key} is not tracked` };
    }
    const issue = await this.#tracker.getIssue(parts.number);
    const pr = record.fix === null ? null : await this.#tracker.getPullRequest(record.fix.prNumber);
    const facts = toGitHubFacts(this.#repo, issue, pr);
    const result = applyAction(record, facts, { ...request, actor: INTERFACE_ACTOR }, this.#model, this.#nowIso());
    if (!result.ok) return { status: 'refused', code: result.error.code, message: result.error.message };
    const ops: WorkflowOperation[] = [];
    const session = record.session;
    if (request.name === 'reply' && session !== null && session.liveState !== 'ended') {
      const answer = (request.answer ?? '').trim();
      const marker = `bug-smasher:answer:${hash(`${key}\n${this.#nowIso()}\n${answer}`)}`;
      ops.push({
        type: 'send-message',
        sessionId: session.id,
        marker,
        message: this.#prompts.replyRelay({
          author: 'A person using the Bug Smasher interface',
          commentUrl: issue.url,
          reply: answer,
          marker,
        }),
      });
    }
    const status = await this.#commit(issue, record, result, `interface-${request.name}`, { ops });
    if (status === 'deferred') return { status: 'deferred', reason: 'Waiting for session capacity' };
    return { status: 'applied', record: this.#store.get(key) as BugRecord };
  }
}
