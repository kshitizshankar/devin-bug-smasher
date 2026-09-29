import type { GitHubRepo } from '../config/settings.ts';
import type { GitHubFacts } from '../model/types.ts';
import type { PullRequestRelation, TrackerIssue, TrackerPullRequest } from './types.ts';

const MARKER_PATTERN = /<!-- bug-smasher(?: key=([A-Za-z0-9._:/-]{1,100}))? -->/;
const KEY_PATTERN = /^[A-Za-z0-9._:/-]{1,100}$/;

export const COMMIT_STATUS_DESCRIPTION_LIMIT = 140;

export function isValidCommentKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Appends the hidden service marker (and idempotency key) to a comment body. */
export function withServiceMarker(body: string, key: string | undefined): string {
  const marker = key === undefined ? '<!-- bug-smasher -->' : `<!-- bug-smasher key=${key} -->`;
  return `${body}\n\n${marker}`;
}

export function readServiceMarker(body: string): { fromService: boolean; serviceKey: string | null } {
  const match = MARKER_PATTERN.exec(body);
  return { fromService: match !== null, serviceKey: match?.[1] ?? null };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Whether PR text uses a GitHub closing keyword for this exact issue: `#N`, `owner/repo#N` or the issue URL.
 * The number must end at a non-word character, so `#12` does not match `#123`, and a reference to another
 * repository's `#N` does not match.
 */
export function closesIssue(text: string, repo: GitHubRepo, issueNumber: number): boolean {
  const owner = escapeRegExp(repo.owner);
  const name = escapeRegExp(repo.name);
  const reference =
    `(?:(?<![\\w/.-])#|(?<![\\w.-])${owner}/${name}#|https?://github\\.com/${owner}/${name}/issues/)` +
    `${issueNumber}(?![\\w])`;
  const pattern = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+${reference}`, 'i');
  return pattern.test(text);
}

export function pullRequestRelation(pr: TrackerPullRequest, repo: GitHubRepo, issueNumber: number): PullRequestRelation {
  return closesIssue(`${pr.title}\n${pr.body}`, repo, issueNumber) ? 'closing' : 'mention';
}

export function truncateDescription(description: string): string {
  if (description.length <= COMMIT_STATUS_DESCRIPTION_LIMIT) return description;
  return `${description.slice(0, COMMIT_STATUS_DESCRIPTION_LIMIT - 1)}…`;
}

/** Builds the model's `GitHubFacts` snapshot from tracker reads. */
export function toGitHubFacts(repo: GitHubRepo, issue: TrackerIssue, pullRequest: TrackerPullRequest | null): GitHubFacts {
  return {
    issue: { owner: repo.owner, repo: repo.name, number: issue.number, state: issue.state, labels: [...issue.labels] },
    pullRequest:
      pullRequest === null
        ? null
        : { number: pullRequest.number, state: pullRequest.state, headSha: pullRequest.headSha },
  };
}

export function hasLabel(labels: readonly string[], label: string): boolean {
  const wanted = label.toLowerCase();
  return labels.some((candidate) => candidate.toLowerCase() === wanted);
}
