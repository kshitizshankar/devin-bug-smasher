import { parseBugKey } from './keys.ts';
import {
  ACTION_NAMES,
  CONFIDENCES,
  DECISION_OUTCOMES,
  HANDOFF_REASONS,
  RECOMMENDATIONS,
  SESSION_LIVE_STATES,
  STAGES,
  TASK_KINDS,
  VERIFICATION_PHASES,
  VERIFICATION_RESULTS,
  WORK_ROUTES,
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
  return problems;
}

/** Validates a persisted record. Returns a list of problems; empty means valid. */
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
  }
  if (value.triage !== null) problems.push(...validateTriageFindings(value.triage, `${path}.triage`));
  if (value.fix !== null) problems.push(...validateFixInfo(value.fix, `${path}.fix`));
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
  }
  if (value.insights !== null && checkObject(value.insights, `${path}.insights`, problems)) {
    const acu = value.insights.acuUsed;
    if (acu !== null && (typeof acu !== 'number' || !Number.isFinite(acu) || acu < 0)) {
      problems.push(`${path}.insights.acuUsed must be null (unknown) or a number >= 0`);
    }
    checkNullableString(value.insights.notes, `${path}.insights.notes`, problems);
  }
  checkTimestamp(value.createdAt, `${path}.createdAt`, problems);
  checkTimestamp(value.updatedAt, `${path}.updatedAt`, problems);
  return problems;
}
