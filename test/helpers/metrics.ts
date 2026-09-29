import assert from 'node:assert/strict';
import type { MetricsEvidence, MetricsInput, MetricsSettings, RecordSet } from '../../src/metrics/types.ts';
import { applyAction, applyEvent, enrollBug, type ActionRequest, type ModelEvent } from '../../src/model/transitions.ts';
import type { BugRecord, GitHubFacts, TriageFindings, VerificationAttempt } from '../../src/model/types.ts';
import { findings, LABEL, options } from './model.ts';

export const REPO = 'acme/widgets';
/** Wednesday 18 March 2026, 12:00 UTC; the current week starts Monday 16 March. */
export const NOW = new Date('2026-03-18T12:00:00.000Z');

export function sha(char: string): string {
  return char.repeat(40);
}

export function headSha(number: number): string {
  return String(number).padEnd(40, 'a');
}

export function mergeSha(number: number): string {
  return String(number).padEnd(40, 'f');
}

/** Drives one record through the real shared model with explicit timestamps. */
export class Bug {
  record: BugRecord;
  readonly number: number;
  readonly repo: string;
  labels: string[];

  constructor(number: number, labels: string[], at: string, repo = REPO) {
    this.number = number;
    this.repo = repo;
    this.labels = labels;
    const result = enrollBug(this.facts(), options, at);
    if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
    this.record = result.record;
  }

  get key(): string {
    return `${this.repo}#${this.number}`;
  }

  facts(): GitHubFacts {
    const [owner, repo] = this.repo.split('/') as [string, string];
    return { issue: { owner, repo, number: this.number, state: 'open', labels: this.labels }, pullRequest: null };
  }

  event(event: ModelEvent, at: string): this {
    const result = applyEvent(this.record, event, options, at);
    if (!result.ok) assert.fail(`${this.key} ${event.type}: ${result.error.code}: ${result.error.message}`);
    this.record = result.record;
    return this;
  }

  act(request: ActionRequest, at: string): this {
    const result = applyAction(this.record, this.facts(), request, options, at);
    if (!result.ok) assert.fail(`${this.key} ${request.name}: ${result.error.code}: ${result.error.message}`);
    this.record = result.record;
    return this;
  }

  session(id: string, at: string): this {
    return this.event({ type: 'session-started', session: { id, url: `https://app.devin.ai/sessions/${id}` }, issueState: 'open', labels: this.labels }, at);
  }

  ended(at: string): this {
    const id = this.record.session?.id as string;
    return this.event({ type: 'session-status', sessionId: id, liveState: 'ended' }, at);
  }

  triaged(at: string, overrides: Partial<TriageFindings> = {}): this {
    return this.event({ type: 'triage-completed', findings: findings(overrides) }, at);
  }

  submit(prNumber: number, headSha: string, at: string): this {
    return this.event(
      {
        type: 'fix-submitted',
        fix: { prNumber, prUrl: `https://github.com/${this.repo}/pull/${prNumber}`, headSha, testFiles: ['test/fix.test.ts'], summary: 'Fix' },
      },
      at,
    );
  }

  verify(result: VerificationAttempt['result'], headSha: string, at: string, phase: VerificationAttempt['phase'] = 'pre-merge'): this {
    return this.event({ type: 'verification-recorded', attempt: { phase, baseSha: sha('c'), headSha, result, reason: `verification ${result}`, outputTail: '', at } }, at);
  }

  merge(prNumber: number, mergeSha: string, at: string, mergedBy: string | null = 'github:maria'): this {
    return this.event({ type: 'pr-merged', prNumber, mergeCommitSha: mergeSha, mergedBy, mergedAt: at }, at);
  }
}

export interface ProvenOptions {
  enrolledAt: string;
  mergedAt: string;
  prNumber: number;
  head?: string;
  merge?: string;
  repo?: string;
  labels?: string[];
  postMerge?: VerificationAttempt['result'] | null;
}

/** Straight to a fix: session, PR, pre-merge pass, merge, then post-merge verification (pass by default). */
export function mergedBug(number: number, options: ProvenOptions): Bug {
  const head = options.head ?? headSha(number);
  const merge = options.merge ?? mergeSha(number);
  const enrolled = Date.parse(options.enrolledAt);
  const merged = Date.parse(options.mergedAt);
  const step = (fraction: number): string => new Date(enrolled + (merged - enrolled) * fraction).toISOString();
  const bug = new Bug(number, options.labels ?? [LABEL.fix], options.enrolledAt, options.repo)
    .session(`session-fix-${number}`, step(0.1))
    .submit(options.prNumber, head, step(0.5))
    .verify('pass', head, step(0.75))
    .merge(options.prNumber, merge, options.mergedAt);
  const post = options.postMerge === undefined ? 'pass' : options.postMerge;
  if (post !== null) bug.verify(post, merge, new Date(merged + 60_000).toISOString(), 'post-merge');
  return bug;
}

export const NO_COST: MetricsSettings = {
  acuPriceUsd: null,
  spendUsd: null,
  spendReadAt: null,
  budgetUsd: null,
  maxAcuPerSession: 5,
  baselineFilter: null,
};

export function unavailableEvidence(): MetricsEvidence {
  return {
    github: { status: 'unavailable', reason: 'not configured in this test' },
    devin: { status: 'unavailable', reason: 'not configured in this test' },
    orchestrator: { status: 'unavailable', reason: 'not running in this test' },
  };
}

export function input(recordSets: RecordSet[], overrides: Partial<MetricsInput> = {}): MetricsInput {
  return { now: NOW, target: REPO, recordSets, settings: NO_COST, evidence: unavailableEvidence(), ...overrides };
}

export function live(...bugs: Bug[]): RecordSet {
  return { mode: 'live', engine: 'current', records: bugs.map((bug) => bug.record) };
}
