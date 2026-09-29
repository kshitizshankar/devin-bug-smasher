import type { LabelSettings } from '../config/settings.ts';
import { formatBugKey } from './keys.ts';
import { resolveLabels, type LabelResolution } from './labels.ts';
import type {
  ActionName,
  BugRecord,
  GitHubFacts,
  Handoff,
  PolicyCheck,
  PolicyEvaluation,
  Question,
  Recommendation,
  ReviewRound,
  TaskKind,
  VerificationAttempt,
} from './types.ts';

export const OVERVIEW_GROUPS = ['Backlog', 'Triage', 'Fix', 'Merged'] as const;
export type OverviewGroup = (typeof OVERVIEW_GROUPS)[number];

export const STATUS_CODES = [
  'not-started',
  'label-conflict',
  'queued-triage',
  'queued-fix',
  'investigating',
  'waiting-for-reply',
  'needs-decision',
  'fixing',
  'verifying',
  'ready-to-merge',
  'merged',
  'needs-engineer',
  'closed',
] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

/** Each status belongs to exactly one overview group; this is the only place groups are defined. */
const STATUS_GROUP: Record<StatusCode, OverviewGroup> = {
  'not-started': 'Backlog',
  'label-conflict': 'Backlog',
  'needs-engineer': 'Backlog',
  closed: 'Backlog',
  'queued-triage': 'Triage',
  investigating: 'Triage',
  'waiting-for-reply': 'Triage',
  'needs-decision': 'Triage',
  'queued-fix': 'Fix',
  fixing: 'Fix',
  verifying: 'Fix',
  'ready-to-merge': 'Fix',
  merged: 'Merged',
};

const STATUS_LABEL: Record<StatusCode, string> = {
  'not-started': 'Not started',
  'label-conflict': 'Label conflict',
  'queued-triage': 'Queued for investigation',
  'queued-fix': 'Queued for repair',
  investigating: 'Investigating',
  'waiting-for-reply': 'Waiting for a reply',
  'needs-decision': 'Needs a decision',
  fixing: 'Fixing',
  verifying: 'Verifying',
  'ready-to-merge': 'Ready to merge',
  merged: 'Merged',
  'needs-engineer': 'Needs an engineer',
  closed: 'Closed',
};

export interface Presentation {
  key: string;
  kind: TaskKind;
  status: StatusCode;
  statusLabel: string;
  group: OverviewGroup;
  /** Actions a person may take now, in a stable order. */
  actions: ActionName[];
  labels: LabelResolution;
  /** Historical outcomes, kept visible even when no action is offered. */
  history: {
    recommendation: Recommendation | null;
    latestVerification: VerificationAttempt | null;
    /** True only when a pre-merge verification passed for the head the PR has now. */
    currentHeadVerified: boolean;
    /** `null` until a post-merge verification is recorded for the current fix's merge commit. */
    postMergeVerified: boolean | null;
    handoff: Handoff | null;
    outstandingQuestion: Question | null;
    wasMerged: boolean;
  };
  /** Read-only policy, Review and merge-readiness evidence recorded by the service. */
  automation: Automation;
}

export interface Automation {
  /** Latest recorded decision evaluation (Rule or Automatic), with its checks and reproduction. */
  decision: PolicyEvaluation | null;
  /** Latest Devin Review round for the current PR head. */
  review: ReviewRound | null;
  /** Findings resolved across every reviewed head. */
  resolvedFindings: number;
  /** Latest merge evaluation for the current PR head; its checks carry CI and branch-protection state. */
  merge: PolicyEvaluation | null;
  ci: PolicyCheck | null;
  /** Whether branch protection requires the verification status (`branch-protection` check). */
  requiredVerification: PolicyCheck | null;
  /** Why the workflow is waiting for a person now; empty when nothing is blocking. */
  blockers: string[];
}

/** Policy, Review and merge evidence for the current head, derived from the record only. */
export function automation(record: BugRecord | undefined): Automation {
  const evaluations = record?.evaluations ?? [];
  const fix = record?.fix ?? null;
  const head = fix?.headSha ?? null;
  const decision = evaluations.findLast((evaluation) => evaluation.kind === 'decision') ?? null;
  const merge = head === null ? null : (evaluations.findLast((evaluation) => evaluation.kind === 'merge' && evaluation.subject === head) ?? null);
  const review = fix === null ? null : (record?.review?.rounds.findLast((round) => round.prNumber === fix.prNumber && round.headSha === fix.headSha) ?? null);
  const blockers: string[] = [];
  if (record?.stage === 'triaged' && decision?.outcome === 'wait') {
    blockers.push(...decision.checks.filter((check) => check.blocking && !check.ok).map((check) => check.detail));
  }
  if (review?.blocker !== null && review?.blocker !== undefined) blockers.push(review.blocker);
  if (record?.stage === 'ready-to-merge' && merge?.outcome === 'wait') {
    blockers.push(...merge.checks.filter((check) => check.blocking && !check.ok).map((check) => check.detail));
  }
  return {
    decision,
    review,
    resolvedFindings: record?.review?.resolutions.length ?? 0,
    merge,
    ci: merge?.checks.find((check) => check.name === 'ci') ?? null,
    requiredVerification: merge?.checks.find((check) => check.name === 'branch-protection') ?? null,
    blockers,
  };
}

export function outstandingQuestion(record: BugRecord): Question | null {
  return record.questions.find((question) => question.answeredAt === null) ?? null;
}

/** Latest pre-merge verification attempt for the fix's current head, if any. */
export function currentHeadVerification(record: BugRecord): VerificationAttempt | null {
  if (record.fix === null) return null;
  const head = record.fix.headSha;
  const attempts = record.verifications.filter(
    (attempt) => attempt.phase === 'pre-merge' && attempt.headSha === head,
  );
  return attempts.at(-1) ?? null;
}

export function wasMerged(record: BugRecord): boolean {
  return record.stageHistory.some((entry) => entry.stage === 'merged');
}

/** True when the current fix was merged and then handed to an engineer (post-merge verification). */
export function mergedFixHandedOff(record: BugRecord): boolean {
  return record.stage === 'with-engineer' && record.fix !== null && record.fix.mergeCommitSha !== null;
}

/** Post-merge attempts for the current fix's merge commit; attempts for archived PRs never count. */
export function currentMergeVerifications(record: BugRecord): VerificationAttempt[] {
  const mergeCommit = record.fix?.mergeCommitSha ?? null;
  if (mergeCommit === null) return [];
  return record.verifications.filter((attempt) => attempt.phase === 'post-merge' && attempt.headSha === mergeCommit);
}

function linkedPullRequest(record: BugRecord | undefined, facts: GitHubFacts): GitHubFacts['pullRequest'] {
  if (record?.fix == null || facts.pullRequest === null) return null;
  return facts.pullRequest.number === record.fix.prNumber ? facts.pullRequest : null;
}

function mergeAllowed(record: BugRecord, facts: GitHubFacts): boolean {
  const pr = linkedPullRequest(record, facts);
  if (record.fix === null || pr === null || pr.state !== 'open') return false;
  if (pr.headSha !== record.fix.headSha) return false;
  return currentHeadVerification(record)?.result === 'pass';
}

function status(record: BugRecord | undefined, facts: GitHubFacts, labels: LabelResolution): StatusCode {
  const pr = linkedPullRequest(record, facts);
  const merged = record?.stage === 'merged' || (record?.stage !== 'with-engineer' && pr?.state === 'merged');

  if (merged) return 'merged';
  // A failed post-merge check stays visible even though merging usually closed the issue.
  if (record !== undefined && mergedFixHandedOff(record)) return 'needs-engineer';
  if (facts.issue.state === 'closed' || record?.stage === 'closed') return 'closed';
  if (labels.route === 'engineer' || record?.stage === 'with-engineer') return 'needs-engineer';
  if (pr?.state === 'closed' && record?.stage !== 'triaged' && record?.stage !== 'queued') {
    return 'needs-engineer';
  }

  if (record === undefined || record.stage === 'queued') {
    if (labels.conflict !== null) return 'label-conflict';
    const route = record === undefined ? labels.route : record.route;
    if (route === 'triage') return 'queued-triage';
    if (route === 'fix' || route === 'feature') return 'queued-fix';
    return 'not-started';
  }

  switch (record.stage) {
    case 'triaging':
      return 'investigating';
    case 'needs-input':
      return 'waiting-for-reply';
    case 'triaged':
      return 'needs-decision';
    case 'fixing':
      return 'fixing';
    case 'verifying':
      return 'verifying';
    case 'ready-to-merge':
      return mergeAllowed(record, facts) ? 'ready-to-merge' : 'verifying';
    case 'merged':
      return 'merged';
  }
}

function actionsFor(
  code: StatusCode,
  record: BugRecord | undefined,
  facts: GitHubFacts,
  kind: TaskKind,
): ActionName[] {
  const issueOpen = facts.issue.state === 'open';
  switch (code) {
    case 'closed':
      return [];
    case 'merged':
      return issueOpen ? ['close'] : [];
    case 'not-started':
      return ['triage', 'fix', 'engineer', 'close'];
    case 'label-conflict':
      return ['engineer', 'close'];
    case 'queued-triage':
      return ['fix', 'engineer', 'close'];
    case 'queued-fix':
      return kind === 'feature' ? ['engineer', 'close'] : ['triage', 'engineer', 'close'];
    case 'needs-engineer':
      return issueOpen ? ['triage', 'fix', 'close'] : [];
    case 'waiting-for-reply':
      return record !== undefined && outstandingQuestion(record) !== null
        ? ['reply', 'engineer', 'close']
        : ['engineer', 'close'];
    case 'needs-decision':
      return ['fix', 'engineer', 'close'];
    case 'ready-to-merge':
      return ['merge', 'engineer', 'close'];
    case 'investigating':
    case 'fixing':
    case 'verifying':
      return ['engineer', 'close'];
  }
}

/**
 * Derives status, overview group and permitted actions from the stored record (if any) and the latest
 * GitHub facts. This is the single presentation contract for APIs and UI; nothing here is persisted.
 */
export function presentBug(
  record: BugRecord | undefined,
  facts: GitHubFacts,
  labelSettings: LabelSettings,
): Presentation {
  const labels = resolveLabels(facts.issue.labels, labelSettings);
  const kind: TaskKind = record?.kind ?? (labels.route === 'feature' ? 'feature' : 'bug');
  const code = status(record, facts, labels);
  const latestVerification = record?.verifications.at(-1) ?? null;
  const postMerge = record === undefined ? undefined : currentMergeVerifications(record).at(-1);

  return {
    key: record?.key ?? formatBugKey({ owner: facts.issue.owner, repo: facts.issue.repo, number: facts.issue.number }),
    kind,
    status: code,
    statusLabel: code === 'queued-fix' && kind === 'feature' ? 'Queued for implementation' : STATUS_LABEL[code],
    group: STATUS_GROUP[code],
    actions: actionsFor(code, record, facts, kind),
    labels,
    history: {
      recommendation: record?.triage?.recommendation ?? null,
      latestVerification,
      currentHeadVerified: record !== undefined && mergeAllowed(record, facts),
      postMergeVerified: postMerge === undefined ? null : postMerge.result === 'pass',
      handoff: record?.handoff ?? null,
      outstandingQuestion: record === undefined ? null : outstandingQuestion(record),
      wasMerged: record !== undefined && wasMerged(record),
    },
    automation: automation(record),
  };
}
