import type { LabelSettings, Policy } from '../config/settings.ts';
import { currentHeadVerification } from '../model/presentation.ts';
import type {
  AutomaticPolicy,
  BugRecord,
  PolicyCheck,
  PolicyEvaluation,
  ReproductionCheck,
  ReviewRound,
} from '../model/types.ts';
import { hasLabel } from '../tracker/common.ts';
import type { Branch, CheckRuns, CombinedStatus, TrackerIssue, TrackerPullRequest } from '../tracker/types.ts';
import {
  READY_STATUS_CONTEXT,
  UNAVAILABLE_POLICY,
  VERIFICATION_STATUS_CONTEXT,
  type DecisionPolicy,
  type DecisionRequest,
  type PolicyOutcome,
  type Reproducer,
} from './contracts.ts';

export const DECISION_RULE = 'decision-rule';
export const DECISION_AUTO = 'decision-auto';
export const MERGE_RULE = 'merge-rule';
export const MERGE_AUTO = 'merge-auto';

export interface DecisionPolicyOptions {
  labels: LabelSettings;
  /** `DECISION_RULE_CLASSES`. */
  ruleClasses: readonly string[];
  /** Runs the proposed test on current code; `null` leaves reproduction unknown. */
  reproducer: Reproducer | null;
  /** Current default branch; its head is the "current code" reproduction runs against. */
  defaultBranch: () => Promise<Branch>;
  now?: () => Date;
}

/** The configured decision policy: Person records nothing and never decides. */
export function decisionPolicy(mode: Policy, options: DecisionPolicyOptions): DecisionPolicy {
  if (mode === 'rule') return new RuleDecision(options);
  if (mode === 'auto') return new AutomaticDecision(options.now ?? (() => new Date()));
  return UNAVAILABLE_POLICY;
}

/** Issue labels other than the four workflow labels. */
export function classLabels(labels: readonly string[], settings: LabelSettings): string[] {
  const workflow = [settings.triage, settings.fix, settings.engineer, settings.feature];
  return labels.filter((label) => !hasLabel(workflow, label));
}

function triageSubject(record: BugRecord): string {
  return `triage:${record.session?.id ?? record.key}`;
}

function evaluation(
  kind: PolicyEvaluation['kind'],
  policy: AutomaticPolicy,
  rule: string,
  subject: string,
  checks: PolicyCheck[],
  outcome: PolicyEvaluation['outcome'],
  reproduction: ReproductionCheck | null,
  now: Date,
): PolicyEvaluation {
  return { kind, policy, rule, subject, outcome, checks, reproduction, at: now.toISOString() };
}

function reasons(checks: readonly PolicyCheck[]): string[] {
  return checks.map((check) => `${check.ok ? 'Met' : check.blocking ? 'Not met' : 'Note'}: ${check.detail}`);
}

function decided(action: 'fix' | 'engineer', rule: string, evidence: PolicyEvaluation): PolicyOutcome {
  return { status: 'decided', action, rule, reasons: reasons(evidence.checks), evaluation: evidence };
}

function waiting(rule: string, evidence: PolicyEvaluation): PolicyOutcome {
  const unmet = evidence.checks.filter((check) => check.blocking && !check.ok).map((check) => check.detail);
  return { status: 'wait', reason: unmet.join('; '), rule, evaluation: evidence };
}

/**
 * Rule decision: fix only when Devin recommends a fix, the bug has class labels that are all on
 * `DECISION_RULE_CLASSES`, and the proposed test independently fails on the default branch. Anything false
 * or unknown waits for a person. Reproduction runs last and only when the other conditions hold; its
 * result is reused for the same triage and default-branch commit.
 */
class RuleDecision implements DecisionPolicy {
  readonly live = true;
  readonly #options: DecisionPolicyOptions;
  readonly #now: () => Date;

  constructor(options: DecisionPolicyOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async decide({ record, issue }: DecisionRequest): Promise<PolicyOutcome> {
    const triage = record.triage;
    const subject = triageSubject(record);
    const checks: PolicyCheck[] = [];
    const recommended = triage?.recommendation === 'devin_fix';
    checks.push({
      name: 'recommendation',
      ok: recommended,
      blocking: true,
      detail: recommended ? 'Devin recommends a fix' : `Devin recommends ${triage?.recommendation ?? 'nothing'}, not a fix`,
    });
    checks.push(this.#classCheck(issue));

    let reproduction: ReproductionCheck | null = null;
    if (triage !== null && checks.every((check) => check.ok)) {
      reproduction = await this.#reproduce(record, subject);
      checks.push(reproductionCheck(reproduction));
    } else {
      checks.push({ name: 'reproduction', ok: false, blocking: true, detail: 'The proposed test was not run because another condition is not met' });
    }
    const allMet = checks.every((check) => check.ok || !check.blocking);
    const evidence = evaluation('decision', 'rule', DECISION_RULE, subject, checks, allMet ? 'fix' : 'wait', reproduction, this.#now());
    return allMet ? decided('fix', DECISION_RULE, evidence) : waiting(DECISION_RULE, evidence);
  }

  #classCheck(issue: TrackerIssue): PolicyCheck {
    const allowed = this.#options.ruleClasses;
    const classes = classLabels(issue.labels, this.#options.labels);
    if (allowed.length === 0) {
      return { name: 'classes', ok: false, blocking: true, detail: 'DECISION_RULE_CLASSES is empty, so no class may be fixed by the rule' };
    }
    if (classes.length === 0) return { name: 'classes', ok: false, blocking: true, detail: 'The issue has no class label' };
    const outside = classes.filter((label) => !hasLabel(allowed, label));
    if (outside.length > 0) {
      return { name: 'classes', ok: false, blocking: true, detail: `Labels not in DECISION_RULE_CLASSES: ${outside.join(', ')}` };
    }
    return { name: 'classes', ok: true, blocking: true, detail: `Every class label is allowed: ${classes.join(', ')}` };
  }

  async #reproduce(record: BugRecord, subject: string): Promise<ReproductionCheck> {
    const triage = record.triage;
    const file = triage?.proposedTest.file ?? '';
    const unknown = (sha: string, reason: string): ReproductionCheck => ({
      sha,
      testFile: file,
      outcome: 'unknown',
      reason,
      at: this.#now().toISOString(),
      runs: [],
    });
    const zero = '0'.repeat(40);
    const reproducer = this.#options.reproducer;
    if (reproducer === null) return unknown(zero, 'No independent verifier is configured to run the proposed test');
    let branch: Branch;
    try {
      branch = await this.#options.defaultBranch();
    } catch (error) {
      return unknown(zero, `The default branch could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    const earlier = (record.evaluations ?? []).findLast(
      (candidate) => candidate.kind === 'decision' && candidate.subject === subject && candidate.reproduction?.sha === branch.sha,
    );
    if (earlier?.reproduction != null && earlier.reproduction.testFile === file) return earlier.reproduction;
    const result = await reproducer.reproduce({
      bugKey: record.key,
      sha: branch.sha,
      testFile: file,
      testCode: triage?.proposedTest.code ?? null,
    });
    return result.status === 'completed' ? result.check : unknown(branch.sha, result.reason);
  }
}

function reproductionCheck(reproduction: ReproductionCheck): PolicyCheck {
  const ok = reproduction.outcome === 'reproduced';
  const prefix =
    reproduction.outcome === 'reproduced'
      ? 'Reproduced independently'
      : reproduction.outcome === 'not-reproduced'
        ? 'Not reproduced'
        : 'Reproduction unknown';
  return { name: 'reproduction', ok, blocking: true, detail: `${prefix}: ${reproduction.reason}` };
}

/** Automatic decision: applies a fix or engineer recommendation; a close recommendation waits for a person. */
class AutomaticDecision implements DecisionPolicy {
  readonly live = true;
  readonly #now: () => Date;

  constructor(now: () => Date) {
    this.#now = now;
  }

  async decide({ record }: DecisionRequest): Promise<PolicyOutcome> {
    const recommendation = record.triage?.recommendation ?? null;
    const subject = triageSubject(record);
    const action = recommendation === 'devin_fix' ? 'fix' : recommendation === 'needs_engineer' ? 'engineer' : null;
    const check: PolicyCheck = {
      name: 'recommendation',
      ok: action !== null,
      blocking: true,
      detail:
        action === null
          ? `Devin recommends ${recommendation ?? 'nothing'}; closing is always a person's decision`
          : `Devin recommends ${recommendation}${record.triage === null ? '' : `: ${record.triage.reason}`}`,
    };
    const evidence = evaluation('decision', 'auto', DECISION_AUTO, subject, [check], action ?? 'wait', null, this.#now());
    return action === null ? waiting(DECISION_AUTO, evidence) : decided(action, DECISION_AUTO, evidence);
  }
}

// Merge ------------------------------------------------------------------------------------------------------

export const CI_STATES = ['green', 'pending', 'failing', 'missing', 'unknown'] as const;
export type CiState = (typeof CI_STATES)[number];

export interface CiSummary {
  state: CiState;
  detail: string;
}

const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/** The service's own commit statuses; they never count as CI. */
const OWN_STATUS_CONTEXTS = new Set([VERIFICATION_STATUS_CONTEXT, READY_STATUS_CONTEXT]);

/**
 * CI for one commit from check runs and commit statuses. The service's own statuses are excluded,
 * so they never count as CI. Green needs at least one check and every check finished successfully.
 */
export function evaluateCi(runs: CheckRuns, combined: CombinedStatus): CiSummary {
  if (!runs.complete || !combined.complete) return { state: 'unknown', detail: 'CI could not be read completely' };
  const statuses = combined.statuses.filter((status) => !OWN_STATUS_CONTEXTS.has(status.context));
  const failing = [
    ...runs.runs.filter((run) => run.status === 'completed' && !PASSING_CONCLUSIONS.has(run.conclusion ?? '')).map((run) => `${run.name} (${run.conclusion ?? 'no conclusion'})`),
    ...statuses.filter((status) => status.state === 'failure' || status.state === 'error').map((status) => `${status.context} (${status.state})`),
  ];
  const pending = [
    ...runs.runs.filter((run) => run.status !== 'completed').map((run) => `${run.name} (${run.status})`),
    ...statuses.filter((status) => status.state === 'pending').map((status) => `${status.context} (pending)`),
  ];
  if (failing.length > 0) return { state: 'failing', detail: `CI is failing: ${failing.join(', ')}` };
  if (pending.length > 0) return { state: 'pending', detail: `CI is pending: ${pending.join(', ')}` };
  const total = runs.runs.length + statuses.length;
  if (total === 0) return { state: 'missing', detail: 'No CI check or status was reported for this commit' };
  return { state: 'green', detail: `CI is green (${total} check(s))` };
}

export interface RequiredStatus {
  state: 'required' | 'missing' | 'unknown';
  detail: string;
}

/** Whether the target branch's protection requires the verification status (`VERIFICATION_STATUS_CONTEXT`). */
export function requiredStatus(branch: Branch | null): RequiredStatus {
  if (branch === null || branch.requiredChecks === null) {
    return { state: 'unknown', detail: `Could not read whether branch protection requires ${VERIFICATION_STATUS_CONTEXT}` };
  }
  if (branch.requiredChecks.includes(VERIFICATION_STATUS_CONTEXT)) {
    return { state: 'required', detail: `Branch protection on ${branch.name} requires ${VERIFICATION_STATUS_CONTEXT}` };
  }
  return {
    state: 'missing',
    detail: `Branch protection on ${branch.name} does not require ${VERIFICATION_STATUS_CONTEXT}; only this service's own check stops an unverified merge`,
  };
}

export interface ReviewGate {
  /** The Review round for the current head, or `null` if none was requested. */
  round: ReviewRound | null;
  /** Unresolved Devin Review threads on GitHub now; `null` when they could not be read. */
  unresolved: number | null;
  enabled: boolean;
}

export interface MergeFacts {
  record: BugRecord;
  /** Read immediately before evaluating. */
  pr: TrackerPullRequest;
  ci: CiSummary;
  review: ReviewGate;
  protection: RequiredStatus;
  maxLines: number;
}

/**
 * Merge readiness for the current head. Rule: verification passed on this head with no flags, CI green,
 * every Devin Review finding resolved and at most `MERGE_MAX_LINES` changed lines. Automatic: verification
 * passed on this head and CI green. Both also wait for `bug-smasher/ready` to say Devin is done with the
 * current head. Branch protection is reported but not enforced here; GitHub enforces it.
 */
export function evaluateMerge(policy: AutomaticPolicy, facts: MergeFacts, now: Date): PolicyEvaluation {
  const { record, pr } = facts;
  const checks: PolicyCheck[] = [];
  const attempt = currentHeadVerification(record);
  const head = record.fix?.headSha ?? null;
  const onHead = head !== null && pr.state === 'open' && pr.headSha === head;
  const verified = onHead && attempt?.result === 'pass';
  checks.push({
    name: 'verification',
    ok: verified,
    blocking: true,
    detail: !onHead
      ? `The PR head ${pr.headSha.slice(0, 12)} is not the recorded head${pr.state === 'open' ? '' : ` (PR is ${pr.state})`}`
      : verified
        ? `Verification passed on the current head ${pr.headSha.slice(0, 12)}`
        : `No passing verification for the current head ${pr.headSha.slice(0, 12)}`,
  });
  checks.push({ name: 'ci', ok: facts.ci.state === 'green', blocking: true, detail: facts.ci.detail });

  const published = record.workflow?.ready;
  const done = published !== undefined && published.headSha === pr.headSha && published.state === 'success';
  checks.push({
    name: 'ready',
    ok: done,
    blocking: true,
    detail: done
      ? `${READY_STATUS_CONTEXT} says Devin is done working on the pull request`
      : published !== undefined && published.headSha === pr.headSha
        ? `Devin is still working on the pull request: ${published.detail}`
        : `${READY_STATUS_CONTEXT} has not been published for the current head ${pr.headSha.slice(0, 12)} yet`,
  });

  const flags = verified ? (attempt?.evidence?.flags ?? []) : [];
  const violations = verified ? (attempt?.evidence?.violations ?? []) : [];
  const findings = [...violations, ...flags].map((finding) => `${finding.check}${finding.file === '' ? '' : ` in ${finding.file}`}`);
  if (policy === 'rule') {
    checks.push({
      name: 'diff-checks',
      ok: verified && findings.length === 0,
      blocking: true,
      detail: findings.length === 0 ? 'Verification reported no diff-check flag' : `Verification flagged: ${findings.join(', ')}`,
    });
    checks.push(reviewCheck(facts.review, pr.headSha));
    const lines = pr.additions + pr.deletions;
    checks.push({
      name: 'size',
      ok: lines <= facts.maxLines,
      blocking: true,
      detail: `${lines} changed line(s); MERGE_MAX_LINES is ${facts.maxLines}`,
    });
  } else if (findings.length > 0) {
    checks.push({ name: 'diff-checks', ok: true, blocking: false, detail: `Verification flagged (allowed by the automatic policy): ${findings.join(', ')}` });
  }
  checks.push({ name: 'branch-protection', ok: facts.protection.state === 'required', blocking: false, detail: facts.protection.detail });

  const ready = checks.every((check) => check.ok || !check.blocking);
  return evaluation('merge', policy, policy === 'rule' ? MERGE_RULE : MERGE_AUTO, pr.headSha, checks, ready ? 'merge' : 'wait', null, now);
}

function reviewCheck(review: ReviewGate, headSha: string): PolicyCheck {
  const fail = (detail: string): PolicyCheck => ({ name: 'review', ok: false, blocking: true, detail });
  if (!review.enabled) return fail('Devin Review is off (DEVIN_REVIEW=false), so its findings cannot be confirmed resolved');
  const round = review.round;
  if (round === null) return fail(`Devin Review has not been requested for ${headSha.slice(0, 12)}`);
  if (round.status === 'pending') return fail(`Devin Review of ${headSha.slice(0, 12)} has not finished`);
  if (round.status === 'unavailable') return fail(`Devin Review is unavailable: ${round.detail ?? 'no detail'}`);
  if (review.unresolved === null) return fail('Devin Review threads could not be read');
  if (review.unresolved > 0) return fail(`${review.unresolved} Devin Review comment(s) are unresolved`);
  return { name: 'review', ok: true, blocking: true, detail: `Devin Review of ${headSha.slice(0, 12)} finished and every comment is resolved` };
}

/** True when two evaluations reached the same result for the same subject, ignoring when they ran. */
export function sameEvaluation(a: PolicyEvaluation | undefined, b: PolicyEvaluation): boolean {
  if (a === undefined) return false;
  const strip = (value: PolicyEvaluation): string =>
    JSON.stringify({ ...value, at: '', reproduction: value.reproduction === null ? null : { ...value.reproduction, at: '' } });
  return strip(a) === strip(b);
}
