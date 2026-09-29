import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ReviewRoundStatus, Stage, VerificationResult } from '../model/types.ts';
import type { StatusCode } from '../model/presentation.ts';

export const DEFAULT_RECORDING_PATH = fileURLToPath(new URL('../../replay/recording.json', import.meta.url));
export const RECORDING_SCHEMA_VERSION = 1;

/**
 * Where a scenario's events come from. `recorded` events were captured from a real run and sanitized;
 * `synthetic` events were written by hand and are never observed live evidence.
 */
export type ScenarioSource =
  | { kind: 'recorded'; recording: string; sanitized: true }
  | { kind: 'synthetic'; reason: string };

export interface ScenarioOutcome {
  stage: Stage;
  status: StatusCode;
  description: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Alias of the scenario's issue in the recording's events. */
  issue: string;
  source: ScenarioSource;
  /** Where the full replay leaves the scenario's issue. */
  outcome: ScenarioOutcome;
}

/** GitHub or Devin activity between orchestrator cycles, as it happened (recorded) or as written (synthetic). */
export type ReplayEvent =
  | { type: 'issue-opened'; issue: string; title: string; body: string; labels: string[]; author: string }
  | { type: 'comment'; issue: string; author: string; body: string }
  | { type: 'label'; issue: string; label: string; action: 'add' | 'remove'; actor: string }
  | { type: 'issue-closed'; issue: string; actor: string }
  | { type: 'devin-working'; issue: string }
  | { type: 'devin-asks'; issue: string; question: string; phase: 'triage' | 'fix' }
  | { type: 'devin-triage'; issue: string; output: Record<string, unknown> }
  | { type: 'devin-ends'; issue: string }
  | { type: 'pull-request-opened'; pr: string; issue: string; title: string; headSha: string; additions: number; deletions: number; file: string }
  | { type: 'devin-pr'; issue: string; pr: string; testFiles: string[]; summary: string }
  | { type: 'head-pushed'; pr: string; headSha: string }
  | { type: 'check-run'; pr: string; name: string; conclusion: 'success' | 'failure' }
  | { type: 'review-completed'; pr: string }
  | { type: 'verifier-result'; issue: string; result: VerificationResult; reason: string; output: string }
  | { type: 'merged'; pr: string; actor: string; mergeCommitSha: string };

export interface Expectation {
  issue: string;
  stage?: Stage;
  status?: StatusCode;
  /** Result of the latest verification attempt. */
  verification?: VerificationResult;
  /** Number of verification attempts recorded so far. */
  verifications?: number;
  /** Devin Review round for the current PR head. */
  review?: ReviewRoundStatus;
}

export interface ReplayStep {
  title: string;
  scenario: string;
  /** Minutes of simulated time since the previous step. */
  minutes: number;
  events: ReplayEvent[];
  /** Orchestrator cycles are run until every expectation holds, at most this many. */
  maxCycles: number;
  expect: Expectation[];
}

export interface Recording {
  schemaVersion: typeof RECORDING_SCHEMA_VERSION;
  id: string;
  title: string;
  /** Stand-in GitHub repository every replayed record belongs to. */
  repository: string;
  startAt: string;
  /** Service settings the recording was made with; they replace the environment's workflow settings. */
  settings: Record<string, string>;
  scenarios: Scenario[];
  steps: ReplayStep[];
}

export interface LoadedRecording {
  recording: Recording;
  /** SHA-256 of the file, so a replay store made from another recording is refused. */
  digest: string;
}

export class RecordingError extends Error {}

const EVENT_TYPES = new Set<string>([
  'issue-opened',
  'comment',
  'label',
  'issue-closed',
  'devin-working',
  'devin-asks',
  'devin-triage',
  'devin-ends',
  'pull-request-opened',
  'devin-pr',
  'head-pushed',
  'check-run',
  'review-completed',
  'verifier-result',
  'merged',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural checks and cross-references; throws `RecordingError` listing every problem. */
export function validateRecording(data: unknown): Recording {
  const problems: string[] = [];
  if (!isObject(data)) throw new RecordingError('Recording must be a JSON object');
  if (data.schemaVersion !== RECORDING_SCHEMA_VERSION) problems.push(`schemaVersion must be ${RECORDING_SCHEMA_VERSION}`);
  for (const field of ['id', 'title', 'repository', 'startAt']) {
    if (typeof data[field] !== 'string' || data[field] === '') problems.push(`${field} must be a non-empty string`);
  }
  if (typeof data.startAt === 'string' && Number.isNaN(Date.parse(data.startAt))) problems.push('startAt must be an ISO timestamp');
  if (!isObject(data.settings)) problems.push('settings must be an object of strings');
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  const steps = Array.isArray(data.steps) ? data.steps : [];
  if (scenarios.length === 0) problems.push('scenarios must be a non-empty array');
  if (steps.length === 0) problems.push('steps must be a non-empty array');
  const scenarioIds = new Set<string>();
  const issues = new Set<string>();
  scenarios.forEach((scenario: unknown, index) => {
    const at = `scenarios[${index}]`;
    if (!isObject(scenario) || typeof scenario.id !== 'string' || typeof scenario.issue !== 'string' || typeof scenario.title !== 'string') {
      problems.push(`${at} needs id, title and issue`);
      return;
    }
    if (scenarioIds.has(scenario.id)) problems.push(`${at}.id ${scenario.id} is duplicated`);
    scenarioIds.add(scenario.id);
    const source = scenario.source;
    if (!isObject(source)) problems.push(`${at}.source is required`);
    else if (source.kind === 'recorded') {
      if (typeof source.recording !== 'string' || source.recording === '') problems.push(`${at}.source.recording must name the original recording`);
      if (source.sanitized !== true) problems.push(`${at}.source.sanitized must be true`);
    } else if (source.kind === 'synthetic') {
      if (typeof source.reason !== 'string' || source.reason === '') problems.push(`${at}.source.reason must say why it is synthetic`);
    } else problems.push(`${at}.source.kind must be recorded or synthetic`);
    const outcome = scenario.outcome;
    if (!isObject(outcome) || typeof outcome.stage !== 'string' || typeof outcome.status !== 'string' || typeof outcome.description !== 'string') {
      problems.push(`${at}.outcome needs stage, status and description`);
    }
  });
  steps.forEach((step: unknown, index) => {
    const at = `steps[${index}]`;
    if (!isObject(step)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (typeof step.title !== 'string' || step.title === '') problems.push(`${at}.title is required`);
    if (typeof step.scenario !== 'string' || !scenarioIds.has(step.scenario)) problems.push(`${at}.scenario must name a scenario`);
    if (typeof step.minutes !== 'number' || !Number.isInteger(step.minutes) || step.minutes < 0) problems.push(`${at}.minutes must be an integer >= 0`);
    if (typeof step.maxCycles !== 'number' || !Number.isInteger(step.maxCycles) || step.maxCycles < 0) problems.push(`${at}.maxCycles must be an integer >= 0`);
    const events = Array.isArray(step.events) ? step.events : null;
    if (events === null) problems.push(`${at}.events must be an array`);
    events?.forEach((event: unknown, eventIndex) => {
      if (!isObject(event) || typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) {
        problems.push(`${at}.events[${eventIndex}] has an unknown type`);
        return;
      }
      if (event.type === 'issue-opened' && typeof event.issue === 'string') issues.add(event.issue);
      else if (typeof event.issue === 'string' && !issues.has(event.issue)) problems.push(`${at}.events[${eventIndex}] refers to issue ${event.issue} before it is opened`);
    });
    const expect = Array.isArray(step.expect) ? step.expect : null;
    if (expect === null || expect.length === 0) problems.push(`${at}.expect must list the documented outcome of the step`);
    expect?.forEach((expectation: unknown, expectIndex) => {
      if (!isObject(expectation) || typeof expectation.issue !== 'string' || !issues.has(expectation.issue)) {
        problems.push(`${at}.expect[${expectIndex}] must name an opened issue`);
      }
    });
  });
  for (const scenario of scenarios as { issue?: unknown; id?: unknown }[]) {
    if (typeof scenario?.issue === 'string' && !issues.has(scenario.issue)) problems.push(`scenario ${String(scenario.id)} names issue ${scenario.issue}, which no step opens`);
  }
  if (problems.length > 0) throw new RecordingError(`Invalid replay recording:\n- ${problems.join('\n- ')}`);
  return data as unknown as Recording;
}

export async function loadRecording(path: string = DEFAULT_RECORDING_PATH): Promise<LoadedRecording> {
  const text = await readFile(path, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new RecordingError(`Replay recording ${path} is not valid JSON`, { cause: error });
  }
  return { recording: validateRecording(data), digest: createHash('sha256').update(text).digest('hex') };
}
