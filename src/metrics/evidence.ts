import type { DevinClient } from '../devin/client.ts';
import { DevinError } from '../devin/errors.ts';
import { TAG_PREFIX } from '../devin/sessions.ts';
import { acuUsed } from '../devin/usage.ts';
import { parseBugKey } from '../model/keys.ts';
import { WORK_ROUTES, type BugRecord, type WorkRoute } from '../model/types.ts';
import { TrackerError, type Actor, type LinkedPullRequest, type RepositoryAdmin, type Tracker } from '../tracker/types.ts';
import { mergedFixes } from './calculate.ts';
import { RECENT_DAYS, DAY_MS } from './stats.ts';
import type { BaselineIssue, DevinEvidence, GitHubEvidence, IssueActivity, Person, PullRequestFacts, RevertFact, SessionFact, Sourced } from './types.ts';

export type EvidenceTracker = Pick<Tracker, 'repo' | 'getIssue' | 'listComments' | 'listIssueEvents' | 'getPullRequest' | 'findLinkedPullRequests'> &
  Partial<Pick<RepositoryAdmin, 'listAllIssues'>>;

export type EvidenceDevin = Pick<DevinClient, 'findSessions' | 'getInsights' | 'getUsageMetrics' | 'getSessionMetrics' | 'getPrMetrics'>;

function person(actor: Actor | null): Person | null {
  return actor === null ? null : { login: actor.login, bot: actor.type === 'bot' || actor.login.endsWith('[bot]') };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Comma-separated label names; a comparable issue carries all of them. */
export function baselineLabels(filter: string): string[] {
  return filter
    .split(',')
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label !== '');
}

async function readBaseline(tracker: EvidenceTracker, filter: string | null): Promise<GitHubEvidence['baseline']> {
  if (filter === null) return { status: 'unavailable', reason: 'BASELINE_FILTER is not set' };
  const labels = baselineLabels(filter);
  if (labels.length === 0) return { status: 'unavailable', reason: 'BASELINE_FILTER names no labels' };
  if (tracker.listAllIssues === undefined) return { status: 'unavailable', reason: 'The tracker cannot list closed issues' };
  const issues: BaselineIssue[] = [];
  for (const issue of await tracker.listAllIssues()) {
    if (issue.state !== 'closed' || issue.closedAt === null || (issue.stateReason !== null && issue.stateReason !== 'completed')) continue;
    const names = issue.labels.map((label) => label.toLowerCase());
    if (labels.every((label) => names.includes(label))) issues.push({ number: issue.number, createdAt: issue.createdAt, closedAt: issue.closedAt });
  }
  return { status: 'available', value: { filter, issues } };
}

/** Pull requests that cross-reference a pull request. GitHub treats pull requests as issues; a tracker that does not has none. */
async function crossReferences(tracker: EvidenceTracker, prNumber: number): Promise<LinkedPullRequest[]> {
  try {
    return await tracker.findLinkedPullRequests(prNumber);
  } catch (error) {
    if (error instanceof TrackerError && error.code === 'not-an-issue') return [];
    throw error;
  }
}

/** Reads the GitHub facts the metrics need for records of the tracker's repository. Never writes. */
export async function readGitHubEvidence(
  tracker: EvidenceTracker,
  records: readonly BugRecord[],
  baselineFilter: string | null,
  now: Date,
): Promise<Sourced<GitHubEvidence>> {
  const repository = `${tracker.repo.owner}/${tracker.repo.name}`;
  try {
    const issues: IssueActivity[] = [];
    const pullRequests: PullRequestFacts[] = [];
    const reverts: RevertFact[] = [];
    const seenPulls = new Set<number>();
    for (const record of records) {
      const parts = parseBugKey(record.key);
      if (parts === null || `${parts.owner}/${parts.repo}` !== repository) continue;
      const issue = await tracker.getIssue(parts.number);
      const comments = await tracker.listComments(parts.number);
      const events = await tracker.listIssueEvents(parts.number);
      issues.push({
        key: record.key,
        createdAt: issue.createdAt,
        author: person(issue.author),
        comments: comments.map((comment) => ({ author: person(comment.author), at: comment.createdAt, fromService: comment.fromService })),
        events: events.map((event) => ({ type: event.type, label: event.label, actor: person(event.actor), at: event.at })),
      });
      for (const fix of mergedFixes(record)) {
        if (seenPulls.has(fix.prNumber)) continue;
        seenPulls.add(fix.prNumber);
        const pr = await tracker.getPullRequest(fix.prNumber);
        pullRequests.push({
          key: `${repository}#${pr.number}`,
          state: pr.state,
          headSha: pr.headSha,
          mergeCommitSha: pr.mergeCommitSha,
          mergedAt: pr.mergedAt,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
        });
        for (const linked of await crossReferences(tracker, fix.prNumber)) {
          const candidate = linked.pullRequest;
          const mentions = candidate.body.includes(`#${fix.prNumber}`) || candidate.body.includes(pr.url);
          if (candidate.state === 'merged' && candidate.mergedAt !== null && /^revert\b/i.test(candidate.title) && mentions) {
            reverts.push({ fixKey: `${repository}#${fix.prNumber}`, revertUrl: candidate.url, mergedAt: candidate.mergedAt });
          }
        }
      }
    }
    const baseline = await readBaseline(tracker, baselineFilter);
    return { status: 'available', value: { repository, readAt: now.toISOString(), issues, pullRequests, reverts, baseline } };
  } catch (error) {
    if (error instanceof TrackerError) return { status: 'unavailable', reason: describe(error) };
    throw error;
  }
}

function tagValue(tags: readonly string[], name: string): string | null {
  const prefix = `${TAG_PREFIX}:${name}=`;
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** Reads every Bug Smasher session, its Insights and Devin's metrics for the cross-check. Never writes. */
export async function readDevinEvidence(client: EvidenceDevin, now: Date): Promise<Sourced<DevinEvidence>> {
  try {
    const sessions: SessionFact[] = [];
    for (const session of await client.findSessions([TAG_PREFIX])) {
      const route = tagValue(session.tags, 'route');
      const insights = await client.getInsights(session.id);
      let knowledge: string[] | null = null;
      if (insights.status === 'available' && insights.insights.knowledgeUsed !== null) {
        const used = insights.insights.knowledgeUsed;
        knowledge = [...new Set([...used.helpful, ...used.unhelpful].map((note) => note.noteId))].sort();
      }
      sessions.push({
        id: session.id,
        bugKey: tagValue(session.tags, 'bug'),
        route: (WORK_ROUTES as readonly string[]).includes(route ?? '') ? (route as WorkRoute) : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: session.status,
        statusDetail: session.statusDetail,
        working: session.activity.kind === 'starting' || session.activity.kind === 'working',
        ended: session.activity.kind === 'ended',
        acus: acuUsed(session.acus),
        knowledge,
      });
    }
    const window = { after: new Date(now.getTime() - RECENT_DAYS * DAY_MS), before: now };
    const sourced = <T>(result: { status: 'available'; value: T } | { status: 'unavailable'; detail: string }): Sourced<T> =>
      result.status === 'available' ? { status: 'available', value: result.value } : { status: 'unavailable', reason: result.detail };
    return {
      status: 'available',
      value: {
        readAt: now.toISOString(),
        sessions,
        crossCheck: {
          window: { start: window.after.toISOString(), end: window.before.toISOString() },
          usage: sourced(await client.getUsageMetrics(window)),
          sessions: sourced(await client.getSessionMetrics(window)),
          prs: sourced(await client.getPrMetrics(window)),
        },
      },
    };
  } catch (error) {
    if (error instanceof DevinError) return { status: 'unavailable', reason: describe(error) };
    throw error;
  }
}
