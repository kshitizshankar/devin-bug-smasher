import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, type Env, type Settings } from '../../src/config/settings.ts';
import { DevinClient } from '../../src/devin/client.ts';
import { OfflineDevin } from '../../src/devin/offline.ts';
import type { WireSession } from '../../src/devin/wire.ts';
import type { BugRecord } from '../../src/model/types.ts';
import type { DecisionPolicy, Verifier } from '../../src/orchestrator/contracts.ts';
import { Orchestrator, type TraceEvent } from '../../src/orchestrator/orchestrator.ts';
import { Prompts } from '../../src/orchestrator/prompts.ts';
import { BugStore } from '../../src/store/bug-store.ts';
import { InMemoryTracker } from '../../src/tracker/memory.ts';
import { API_KEY, COMPLETE_TRIAGE, ORG_ID } from './devin.ts';

export { COMPLETE_TRIAGE };

export interface HarnessOptions {
  env?: Env;
  verifier?: Verifier;
  policy?: DecisionPolicy;
  requireLiveResults?: boolean;
}

/**
 * Offline world for orchestration traces: an `InMemoryTracker` (GitHub), `DevinClient` over `OfflineDevin`,
 * a `BugStore` on disk and one shared clock. `restart()` reopens the store from its file with a new
 * orchestrator, as a restarted process would.
 */
export class Harness {
  readonly tracker: InMemoryTracker;
  readonly offline: OfflineDevin;
  readonly client: DevinClient;
  readonly settings: Settings;
  /** Orchestrator trace events plus `restart` markers added by the harness. */
  readonly trace: (Omit<TraceEvent, 'type'> & { type: string })[] = [];
  store!: BugStore;
  orchestrator!: Orchestrator;
  prompts!: Prompts;
  #dir = '';
  #generation = 0;
  #time = Date.UTC(2026, 0, 1);
  readonly #options: HarnessOptions;

  private constructor(options: HarnessOptions) {
    this.#options = options;
    const clock = (): Date => new Date((this.#time += 1000));
    this.clock = clock;
    this.settings = loadSettings({ GITHUB_REPO: 'acme/widgets', ...options.env });
    this.tracker = new InMemoryTracker({ now: () => clock().toISOString() });
    this.offline = new OfflineDevin({ apiKey: API_KEY, orgId: ORG_ID, now: clock });
    let attempt = 0;
    this.client = new DevinClient({
      apiKey: API_KEY,
      orgId: ORG_ID,
      maxAcuPerSession: this.settings.devin.maxAcuPerSession,
      reviewEnabled: true,
      fetch: this.offline.fetch,
      newAttemptId: () => `attempt-${++attempt}`,
    });
  }

  readonly clock: () => Date;

  static async create(options: HarnessOptions = {}): Promise<Harness> {
    const harness = new Harness(options);
    harness.#dir = await mkdtemp(join(tmpdir(), 'bug-smasher-orchestrator-'));
    harness.prompts = await Prompts.load();
    harness.store = await BugStore.open(join(harness.#dir, 'bugs-0.json'));
    harness.orchestrator = harness.#newOrchestrator();
    return harness;
  }

  #newOrchestrator(): Orchestrator {
    return new Orchestrator({
      store: this.store,
      tracker: this.tracker,
      devin: this.client,
      settings: this.settings,
      prompts: this.prompts,
      verifier: this.#options.verifier,
      policy: this.#options.policy,
      requireLiveResults: this.#options.requireLiveResults,
      now: this.clock,
      trace: (event) => this.trace.push(event),
    });
  }

  /** Simulates a process restart: the store is reloaded from its file (a new instance), with a new orchestrator. */
  async restart(): Promise<void> {
    await this.orchestrator.stop();
    const from = this.store.path;
    this.#generation += 1;
    const to = join(this.#dir, `bugs-${this.#generation}.json`);
    await copyFile(from, to);
    this.store = await BugStore.open(to);
    this.orchestrator = this.#newOrchestrator();
    this.trace.push({ cycle: 0, at: this.clock().toISOString(), key: null, type: 'restart', detail: { generation: this.#generation } });
  }

  async cycle(count = 1): Promise<void> {
    for (let index = 0; index < count; index += 1) await this.orchestrator.runCycle();
  }

  async close(): Promise<void> {
    await this.orchestrator.stop();
    await rm(this.#dir, { recursive: true, force: true });
  }

  record(key: string): BugRecord {
    const record = this.store.get(key);
    if (record === undefined) throw new Error(`No record for ${key}`);
    return record;
  }

  sessionId(key: string): string {
    const session = this.record(key).session;
    if (session === null) throw new Error(`No session for ${key}`);
    return session.id;
  }

  session(id: string): WireSession {
    const session = this.offline.sessions.get(id);
    if (session === undefined) throw new Error(`No offline session ${id}`);
    return session;
  }

  createRequests(): { tags: string[]; prompt: string; body: Record<string, unknown> }[] {
    return this.offline.requests
      .filter((request) => request.method === 'POST' && request.path.endsWith('/sessions'))
      .map((request) => {
        const body = request.body as Record<string, unknown>;
        return { tags: body.tags as string[], prompt: body.prompt as string, body };
      });
  }

  messages(sessionId: string): string[] {
    return (this.offline.messages.get(sessionId) ?? []).map((message) => message.message);
  }

  // Devin acting in its session -------------------------------------------------------------------------------

  working(id: string): void {
    this.offline.updateSession(id, { status: 'running', status_detail: 'working' });
  }

  asks(id: string, question: string, phase: 'triage' | 'fix' = 'triage'): void {
    this.offline.updateSession(id, {
      status: 'running',
      status_detail: 'waiting_for_user',
      structured_output: { phase, status: 'needs_input', question },
    });
  }

  completesTriage(id: string, overrides: Record<string, unknown> = {}): void {
    this.offline.updateSession(id, {
      status: 'running',
      status_detail: 'finished',
      structured_output: { ...COMPLETE_TRIAGE, ...overrides },
    });
  }

  opensPr(id: string, prUrl: string): void {
    this.offline.updateSession(id, {
      status: 'running',
      status_detail: 'finished',
      pull_requests: [{ pr_url: prUrl, pr_state: 'open' }],
      structured_output: {
        phase: 'fix',
        status: 'pr_opened',
        pr_url: prUrl,
        test_files: ['test/legend.test.ts'],
        fix_summary: 'Offset the legend by the axis height',
      },
    });
  }

  ends(id: string): void {
    this.offline.updateSession(id, { status: 'exit', status_detail: null });
  }

  /** Compact, human-readable trace lines, e.g. `c2 acme/widgets#1 transition what=session-started ...`. */
  lines(types?: readonly string[]): string[] {
    return this.trace
      .filter((event) => types === undefined || types.includes(event.type))
      .map((event) => {
        const detail = Object.entries(event.detail)
          .map(([name, value]) => `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
          .join(' ');
        return [`c${event.cycle}`, event.key ?? '-', event.type, detail].filter((part) => part !== '').join(' ');
      });
  }

  types(key?: string): string[] {
    return this.trace.filter((event) => key === undefined || event.key === key).map((event) => event.type);
  }
}

/** Emits the trace as test diagnostics when `ORCHESTRATOR_TRACE=1`, for event-trace evidence. */
export function report(t: { diagnostic: (message: string) => void }, harness: Harness): void {
  if (process.env.ORCHESTRATOR_TRACE !== '1') return;
  for (const line of harness.lines().filter((line) => !line.includes('cycle-started') && !line.includes('cycle-finished'))) {
    t.diagnostic(line);
  }
}
