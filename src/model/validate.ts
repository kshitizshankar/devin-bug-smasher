import { parseBugKey } from './keys.ts';
import {
  ACTION_NAMES,
  AUTOMATIC_POLICIES,
  CONFIDENCES,
  DECISION_OUTCOMES,
  DIFF_CHECKS,
  FINDING_RESOLUTIONS,
  HANDOFF_REASONS,
  POLICY_KINDS,
  POLICY_OUTCOMES,
  READY_STATES,
  RECOMMENDATIONS,
  REPRODUCTION_OUTCOMES,
  REVIEW_ROUND_STATUSES,
  RUN_OUTCOMES,
  SESSION_LIVE_STATES,
  STAGES,
  TASK_KINDS,
  VERIFICATION_PHASES,
  VERIFICATION_RESULTS,
  VERIFICATION_RUN_ROLES,
  VERIFICATION_STEPS,
  WORK_ROUTES,
  WORKFLOW_OPERATION_TYPES,
} from './types.ts';

type Problems = string[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkObject(value: unknown, path: string, problems: Problems): value is Record<string, unknown> {
  if (isObject(value)) return true;
  problems.push(`${path} must be an object`);
  return false;
}

function checkString(value: unknown, path: string, problems: Problems, options: { nonEmpty?: boolean } = {}): void {
  if (typeof value !== 'string') problems.push(`${path} must be a string`);
  else if (options.nonEmpty && value.trim() === '') problems.push(`${path} must not be empty`);
}

function checkNullableString(value: unknown, path: string, problems: Problems): void {
  if (value !== null) checkString(value, path, problems);
}

function checkTimestamp(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    problems.push(`${path} must be an ISO 8601 timestamp`);
  }
}

function checkNullableTimestamp(value: unknown, path: string, problems: Problems): void {
  if (value !== null) checkTimestamp(value, path, problems);
}

function checkOneOf(value: unknown, allowed: readonly string[], path: string, problems: Problems): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    problems.push(`${path} must be one of ${allowed.join(', ')}`);
  }
}

function checkBoolean(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== 'boolean') problems.push(`${path} must be a boolean`);
}

function checkPositiveInteger(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${path} must be a positive integer`);
  }
}

function checkSha(value: unknown, path: string, problems: Problems): void {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/.test(value)) {
    problems.push(`${path} must be a hexadecimal commit SHA`);
  }
}

function checkArray(
  value: unknown,
  path: string,
  problems: Problems,
  each: (item: unknown, path: string, problems: Problems) => void,
): void {
  if (!Array.isArray(value)) {
    problems.push(`${path} must be an array`);
    return;
  }
  value.forEach((item, index) => each(item, `${path}[${index}]`, problems));
}

function checkStringItem(item: unknown, path: string, problems: Problems): void {
  checkString(item, path, problems);
}

export function validateTriageFindings(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkString(value.title, `${path}.title`, problems, { nonEmpty: true });
  checkString(value.summary, `${path}.summary`, problems);
  checkArray(value.reproductionSteps, `${path}.reproductionSteps`, problems, checkStringItem);
  checkString(value.expectedBehavior, `${path}.expectedBehavior`, problems);
  checkString(value.actualBehavior, `${path}.actualBehavior`, problems);
  checkString(value.suspectedCause, `${path}.suspectedCause`, problems);
  checkArray(value.affectedFiles, `${path}.affectedFiles`, problems, checkStringItem);
  checkBoolean(value.reproduced, `${path}.reproduced`, problems);
  checkString(value.reproductionNotes, `${path}.reproductionNotes`, problems);
  if (checkObject(value.proposedTest, `${path}.proposedTest`, problems)) {
    checkString(value.proposedTest.description, `${path}.proposedTest.description`, problems);
    checkString(value.proposedTest.file, `${path}.proposedTest.file`, problems);
    checkString(value.proposedTest.command, `${path}.proposedTest.command`, problems);
    if (value.proposedTest.code !== undefined) checkString(value.proposedTest.code, `${path}.proposedTest.code`, problems);
  }
  checkOneOf(value.recommendation, RECOMMENDATIONS, `${path}.recommendation`, problems);
  checkString(value.reason, `${path}.reason`, problems);
  checkOneOf(value.confidence, CONFIDENCES, `${path}.confidence`, problems);
  return problems;
}

export function validateFixInfo(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkPositiveInteger(value.prNumber, `${path}.prNumber`, problems);
  checkString(value.prUrl, `${path}.prUrl`, problems, { nonEmpty: true });
  checkSha(value.headSha, `${path}.headSha`, problems);
  checkArray(value.testFiles, `${path}.testFiles`, problems, checkStringItem);
  checkString(value.summary, `${path}.summary`, problems);
  if (value.mergeCommitSha !== null) checkSha(value.mergeCommitSha, `${path}.mergeCommitSha`, problems);
  if (value.mergedBy !== undefined) checkNullableString(value.mergedBy, `${path}.mergedBy`, problems);
  if (value.mergedAt !== undefined) checkNullableTimestamp(value.mergedAt, `${path}.mergedAt`, problems);
  return problems;
}

export function validateVerificationAttempt(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkOneOf(value.phase, VERIFICATION_PHASES, `${path}.phase`, problems);
  checkSha(value.baseSha, `${path}.baseSha`, problems);
  checkSha(value.headSha, `${path}.headSha`, problems);
  checkOneOf(value.result, VERIFICATION_RESULTS, `${path}.result`, problems);
  checkString(value.reason, `${path}.reason`, problems);
  checkString(value.outputTail, `${path}.outputTail`, problems);
  checkTimestamp(value.at, `${path}.at`, problems);
  checkNullableString(value.sessionId, `${path}.sessionId`, problems);
  if (value.evidence !== undefined) problems.push(...validateVerificationEvidence(value.evidence, `${path}.evidence`));
  return problems;
}

function checkFinding(item: unknown, path: string, problems: Problems): void {
  if (!checkObject(item, path, problems)) return;
  checkOneOf(item.check, DIFF_CHECKS, `${path}.check`, problems);
  checkString(item.file, `${path}.file`, problems);
  checkString(item.detail, `${path}.detail`, problems);
}

function checkRun(item: unknown, itemPath: string, list: Problems): void {
  if (!checkObject(item, itemPath, list)) return;
  checkOneOf(item.role, VERIFICATION_RUN_ROLES, `${itemPath}.role`, list);
  checkOneOf(item.step, VERIFICATION_STEPS, `${itemPath}.step`, list);
  checkSha(item.sha, `${itemPath}.sha`, list);
  checkArray(item.command, `${itemPath}.command`, list, checkStringItem);
  checkTimestamp(item.startedAt, `${itemPath}.startedAt`, list);
  checkTimestamp(item.endedAt, `${itemPath}.endedAt`, list);
  if (item.exitCode !== null && (typeof item.exitCode !== 'number' || !Number.isSafeInteger(item.exitCode))) {
    list.push(`${itemPath}.exitCode must be null or an integer`);
  }
  checkOneOf(item.outcome, RUN_OUTCOMES, `${itemPath}.outcome`, list);
  checkString(item.reason, `${itemPath}.reason`, list);
  checkString(item.outputTail, `${itemPath}.outputTail`, list);
}

function checkNullableLine(value: unknown, path: string, problems: Problems): void {
  if (value !== null) checkPositiveInteger(value, path, problems);
}

export function validateReviewRecord(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkArray(value.rounds, `${path}.rounds`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkPositiveInteger(item.prNumber, `${itemPath}.prNumber`, list);
    checkSha(item.headSha, `${itemPath}.headSha`, list);
    checkOneOf(item.status, REVIEW_ROUND_STATUSES, `${itemPath}.status`, list);
    checkTimestamp(item.requestedAt, `${itemPath}.requestedAt`, list);
    checkNullableTimestamp(item.completedAt, `${itemPath}.completedAt`, list);
    checkNullableString(item.detail, `${itemPath}.detail`, list);
    checkArray(item.findings, `${itemPath}.findings`, list, (finding, findingPath, findingList) => {
      if (!checkObject(finding, findingPath, findingList)) return;
      checkString(finding.threadId, `${findingPath}.threadId`, findingList, { nonEmpty: true });
      checkNullableString(finding.path, `${findingPath}.path`, findingList);
      checkNullableLine(finding.line, `${findingPath}.line`, findingList);
      checkString(finding.body, `${findingPath}.body`, findingList);
      checkString(finding.url, `${findingPath}.url`, findingList);
      checkBoolean(finding.outdated, `${findingPath}.outdated`, findingList);
    });
    checkNullableTimestamp(item.correctionSentAt, `${itemPath}.correctionSentAt`, list);
    checkNullableString(item.blocker, `${itemPath}.blocker`, list);
  });
  checkArray(value.resolutions, `${path}.resolutions`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkString(item.threadId, `${itemPath}.threadId`, list, { nonEmpty: true });
    checkString(item.url, `${itemPath}.url`, list);
    checkSha(item.foundOnHead, `${itemPath}.foundOnHead`, list);
    checkSha(item.resolvedOnHead, `${itemPath}.resolvedOnHead`, list);
    checkOneOf(item.via, FINDING_RESOLUTIONS, `${itemPath}.via`, list);
    checkTimestamp(item.at, `${itemPath}.at`, list);
  });
  return problems;
}

export function validatePolicyEvaluation(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkOneOf(value.kind, POLICY_KINDS, `${path}.kind`, problems);
  checkOneOf(value.policy, AUTOMATIC_POLICIES, `${path}.policy`, problems);
  checkString(value.rule, `${path}.rule`, problems, { nonEmpty: true });
  checkString(value.subject, `${path}.subject`, problems, { nonEmpty: true });
  checkOneOf(value.outcome, POLICY_OUTCOMES, `${path}.outcome`, problems);
  checkArray(value.checks, `${path}.checks`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkString(item.name, `${itemPath}.name`, list, { nonEmpty: true });
    checkBoolean(item.ok, `${itemPath}.ok`, list);
    checkBoolean(item.blocking, `${itemPath}.blocking`, list);
    checkString(item.detail, `${itemPath}.detail`, list);
  });
  if (value.reproduction !== null && checkObject(value.reproduction, `${path}.reproduction`, problems)) {
    const reproduction = value.reproduction;
    checkSha(reproduction.sha, `${path}.reproduction.sha`, problems);
    checkString(reproduction.testFile, `${path}.reproduction.testFile`, problems);
    checkOneOf(reproduction.outcome, REPRODUCTION_OUTCOMES, `${path}.reproduction.outcome`, problems);
    checkString(reproduction.reason, `${path}.reproduction.reason`, problems);
    checkTimestamp(reproduction.at, `${path}.reproduction.at`, problems);
    checkArray(reproduction.runs, `${path}.reproduction.runs`, problems, checkRun);
  }
  checkTimestamp(value.at, `${path}.at`, problems);
  return problems;
}

export function validateVerificationEvidence(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  checkArray(value.runs, `${path}.runs`, problems, checkRun);
  checkArray(value.violations, `${path}.violations`, problems, checkFinding);
  checkArray(value.flags, `${path}.flags`, problems, checkFinding);
  return problems;
}

/** Validates a persisted record. Returns a list of problems; empty means valid. */
export function validateSessionInsights(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  const acu = value.acuUsed;
  if (acu !== null && (typeof acu !== 'number' || !Number.isFinite(acu) || acu < 0)) {
    problems.push(`${path}.acuUsed must be null (unknown) or a number >= 0`);
  }
  checkNullableString(value.notes, `${path}.notes`, problems);
  return problems;
}

export function validateWorkflowState(value: unknown, path: string): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;
  if (value.dispatch !== null && checkObject(value.dispatch, `${path}.dispatch`, problems)) {
    checkOneOf(value.dispatch.route, WORK_ROUTES, `${path}.dispatch.route`, problems);
    checkTimestamp(value.dispatch.requestedAt, `${path}.dispatch.requestedAt`, problems);
    checkNullableString(value.dispatch.attemptTag, `${path}.dispatch.attemptTag`, problems);
    const checks = value.dispatch.checks;
    if (typeof checks !== 'number' || !Number.isSafeInteger(checks) || checks < 0) {
      problems.push(`${path}.dispatch.checks must be an integer >= 0`);
    }
    checkArray(value.dispatch.commentIds, `${path}.dispatch.commentIds`, problems, checkStringItem);
  }
  checkArray(value.outbox, `${path}.outbox`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkOneOf(item.type, WORKFLOW_OPERATION_TYPES, `${itemPath}.type`, list);
    switch (item.type) {
      case 'add-label':
      case 'remove-label':
        checkString(item.label, `${itemPath}.label`, list, { nonEmpty: true });
        break;
      case 'stop-session':
        checkString(item.sessionId, `${itemPath}.sessionId`, list, { nonEmpty: true });
        break;
      case 'post-comment':
        checkString(item.key, `${itemPath}.key`, list, { nonEmpty: true });
        checkString(item.body, `${itemPath}.body`, list, { nonEmpty: true });
        break;
      case 'send-message':
        checkString(item.sessionId, `${itemPath}.sessionId`, list, { nonEmpty: true });
        checkString(item.marker, `${itemPath}.marker`, list, { nonEmpty: true });
        checkString(item.message, `${itemPath}.message`, list, { nonEmpty: true });
        if (typeof item.message === 'string' && typeof item.marker === 'string' && !item.message.includes(item.marker)) {
          list.push(`${itemPath}.message must contain its marker`);
        }
        break;
      case 'merge-pr':
        checkPositiveInteger(item.prNumber, `${itemPath}.prNumber`, list);
        checkSha(item.expectedHeadSha, `${itemPath}.expectedHeadSha`, list);
        break;
      case 'set-commit-status':
        checkSha(item.sha, `${itemPath}.sha`, list);
        checkOneOf(item.state, ['success', 'failure', 'error', 'pending'], `${itemPath}.state`, list);
        checkString(item.context, `${itemPath}.context`, list, { nonEmpty: true });
        checkString(item.description, `${itemPath}.description`, list);
        break;
    }
  });
  checkArray(value.relayedCommentIds, `${path}.relayedCommentIds`, problems, checkStringItem);
  checkArray(value.handledEventIds, `${path}.handledEventIds`, problems, checkStringItem);
  if (value.workQuestion !== null && checkObject(value.workQuestion, `${path}.workQuestion`, problems)) {
    checkString(value.workQuestion.id, `${path}.workQuestion.id`, problems, { nonEmpty: true });
    checkString(value.workQuestion.sessionId, `${path}.workQuestion.sessionId`, problems, { nonEmpty: true });
    checkString(value.workQuestion.summary, `${path}.workQuestion.summary`, problems);
    checkTimestamp(value.workQuestion.askedAt, `${path}.workQuestion.askedAt`, problems);
  }
  checkArray(value.notices, `${path}.notices`, problems, checkStringItem);
  if (value.ready !== undefined && checkObject(value.ready, `${path}.ready`, problems)) {
    checkSha(value.ready.headSha, `${path}.ready.headSha`, problems);
    checkOneOf(value.ready.state, READY_STATES, `${path}.ready.state`, problems);
    checkString(value.ready.detail, `${path}.ready.detail`, problems);
    checkTimestamp(value.ready.at, `${path}.ready.at`, problems);
  }
  return problems;
}

export function validateBugRecord(value: unknown, path = 'record'): Problems {
  const problems: Problems = [];
  if (!checkObject(value, path, problems)) return problems;

  if (typeof value.key !== 'string' || parseBugKey(value.key) === null) {
    problems.push(`${path}.key must be owner/repo#number`);
  }
  checkOneOf(value.kind, TASK_KINDS, `${path}.kind`, problems);
  checkOneOf(value.stage, STAGES, `${path}.stage`, problems);
  if (value.route !== null) checkOneOf(value.route, WORK_ROUTES, `${path}.route`, problems);

  if (value.session !== null && checkObject(value.session, `${path}.session`, problems)) {
    const session = value.session;
    checkString(session.id, `${path}.session.id`, problems, { nonEmpty: true });
    checkString(session.url, `${path}.session.url`, problems);
    checkOneOf(session.route, WORK_ROUTES, `${path}.session.route`, problems);
    checkOneOf(session.liveState, SESSION_LIVE_STATES, `${path}.session.liveState`, problems);
    checkTimestamp(session.startedAt, `${path}.session.startedAt`, problems);
    checkTimestamp(session.updatedAt, `${path}.session.updatedAt`, problems);
    checkNullableTimestamp(session.stopRequestedAt, `${path}.session.stopRequestedAt`, problems);
    if (session.stopReason !== undefined && session.stopReason !== null) {
      checkString(session.stopReason, `${path}.session.stopReason`, problems, { nonEmpty: true });
    }
  }
  if (value.triage !== null) problems.push(...validateTriageFindings(value.triage, `${path}.triage`));
  if (value.fix !== null) problems.push(...validateFixInfo(value.fix, `${path}.fix`));
  checkArray(value.priorFixes, `${path}.priorFixes`, problems, (item, itemPath, list) => {
    list.push(...validateFixInfo(item, itemPath));
  });
  checkArray(value.verifications, `${path}.verifications`, problems, (item, itemPath, list) => {
    list.push(...validateVerificationAttempt(item, itemPath));
  });
  checkArray(value.decisions, `${path}.decisions`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkOneOf(item.action, ACTION_NAMES, `${itemPath}.action`, list);
    checkOneOf(item.outcome, DECISION_OUTCOMES, `${itemPath}.outcome`, list);
    checkString(item.actor, `${itemPath}.actor`, list, { nonEmpty: true });
    checkTimestamp(item.at, `${itemPath}.at`, list);
    checkNullableString(item.context, `${itemPath}.context`, list);
  });
  checkArray(value.questions, `${path}.questions`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkString(item.id, `${itemPath}.id`, list, { nonEmpty: true });
    checkString(item.summary, `${itemPath}.summary`, list);
    checkTimestamp(item.askedAt, `${itemPath}.askedAt`, list);
    checkNullableTimestamp(item.answeredAt, `${itemPath}.answeredAt`, list);
  });
  checkArray(value.stageHistory, `${path}.stageHistory`, problems, (item, itemPath, list) => {
    if (!checkObject(item, itemPath, list)) return;
    checkOneOf(item.stage, STAGES, `${itemPath}.stage`, list);
    checkTimestamp(item.at, `${itemPath}.at`, list);
  });
  if (Array.isArray(value.stageHistory) && value.stageHistory.length > 0) {
    const last: unknown = value.stageHistory.at(-1);
    if (isObject(last) && last.stage !== value.stage) {
      problems.push(`${path}.stageHistory must end with the current stage`);
    }
  } else if (Array.isArray(value.stageHistory)) {
    problems.push(`${path}.stageHistory must not be empty`);
  }
  if (value.handoff !== null && checkObject(value.handoff, `${path}.handoff`, problems)) {
    checkOneOf(value.handoff.reason, HANDOFF_REASONS, `${path}.handoff.reason`, problems);
    checkNullableString(value.handoff.detail, `${path}.handoff.detail`, problems);
    checkTimestamp(value.handoff.at, `${path}.handoff.at`, problems);
    checkBoolean(value.handoff.engineerLabelSeen, `${path}.handoff.engineerLabelSeen`, problems);
  }
  if (value.insights !== null) problems.push(...validateSessionInsights(value.insights, `${path}.insights`));
  if (value.review !== undefined) problems.push(...validateReviewRecord(value.review, `${path}.review`));
  if (value.unarchivedSessions !== undefined) checkArray(value.unarchivedSessions, `${path}.unarchivedSessions`, problems, checkStringItem);
  if (value.evaluations !== undefined) {
    checkArray(value.evaluations, `${path}.evaluations`, problems, (item, itemPath, list) => {
      list.push(...validatePolicyEvaluation(item, itemPath));
    });
  }
  if (value.workflow !== undefined) problems.push(...validateWorkflowState(value.workflow, `${path}.workflow`));
  checkTimestamp(value.createdAt, `${path}.createdAt`, problems);
  checkTimestamp(value.updatedAt, `${path}.updatedAt`, problems);
  return problems;
}
