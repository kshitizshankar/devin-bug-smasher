# GitHub tracker

`src/tracker/` is the only place that talks to GitHub. The orchestrator depends on the provider-neutral
`Tracker` interface (`src/tracker/types.ts`) and receives normalized data; raw GitHub JSON never leaves the
adapter. Nothing in the running service uses the tracker yet: the orchestrator task wires it in.

| File                     | Contents                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `src/tracker/types.ts`   | `Tracker`, normalized types (`TrackerIssue`, `TrackerComment`, `IssueEvent`, `TrackerPullRequest`, ...), `TrackerError` |
| `src/tracker/github.ts`  | `GitHubTracker` (REST, Node `fetch` only) and `githubTrackerFromSettings(settings)`          |
| `src/tracker/memory.ts`  | `InMemoryTracker`: offline stand-in with the same contract plus a simulation API             |
| `src/tracker/common.ts`  | Comment service marker, exact closing-reference matching, `toGitHubFacts` for the model      |

## Creating a tracker

```ts
import { loadSettings } from './config/settings.ts';
import { githubTrackerFromSettings } from './tracker/github.ts';
import { InMemoryTracker } from './tracker/memory.ts';

const tracker = githubTrackerFromSettings(loadSettings()); // requires GITHUB_REPO and GITHUB_TOKEN
const offline = new InMemoryTracker({ repo: { owner: 'acme', name: 'widgets' } });
```

`GitHubTracker` options: `baseUrl` (default `https://api.github.com`), `timeoutMs` (30 000), `perPage` (100),
`maxPages` (50), and injectable `fetch` / `now` for tests. Requests send `Authorization: Bearer <token>`,
`Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`.

## Operations

All methods are async and either return complete normalized data or throw `TrackerError`.

| Method | GitHub REST call(s) | Notes |
| --- | --- | --- |
| `listOpenIssues(labels)` | `GET /issues?state=open&labels=<l>` per label | All pages; PRs (items with `pull_request`) dropped; deduplicated; sorted by number |
| `getIssue(n)` | `GET /issues/{n}` | Any state or labels; a PR number throws `not-an-issue` |
| `createIssue({ title, body, labels? })` | `POST /issues` | |
| `listComments(n)` | `GET /issues/{n}/comments` | All pages, deduplicated by comment ID |
| `postComment(n, body, { key? })` | `GET` then `POST /issues/{n}/comments` | Appends `<!-- bug-smasher key=... -->`; an existing comment with the same key is returned instead of posting; concurrent posts with the same key in one tracker run one at a time |
| `listIssueEvents(n)` | `GET /issues/{n}/events` | `labeled`, `unlabeled`, `closed`, `reopened` only, with actor and time |
| `addLabels(n, labels)` | `POST /issues/{n}/labels` | Returns resulting labels |
| `removeLabel(n, label)` | `DELETE /issues/{n}/labels/{label}` | Absent label is a no-op (GitHub's `Label does not exist` 404) |
| `moveLabel(n, { from, to })` | add, then remove | If adding fails, `from` stays. If removing fails, both labels remain and the error is thrown |
| `closeIssue(n, { reason? })`, `reopenIssue(n)` | `PATCH /issues/{n}` | |
| `findLinkedPullRequests(n)` | `GET /issues/{n}/timeline`, `GET /pulls/{m}` | `cross-referenced` events from PRs in this repository only; `relation` is `closing` or `mention` |
| `getPullRequest(n)` | `GET /pulls/{n}` | `state` is `merged` only when GitHub reports it; `mergeCommitSha` is `null` until merged |
| `listPullRequestFiles(n)` | `GET /pulls/{n}`, `GET /pulls/{n}/files` | `complete: false` when fewer files than `changed_files` (GitHub lists at most 3000) |
| `getPullRequestDiff(n)` | `GET /pulls/{n}` with `Accept: application/vnd.github.diff` | `{ complete: false, reason }` when GitHub refuses a too-large diff (406/422) |
| `listReviews(n)` | `GET /pulls/{n}/reviews` | Includes `commitId` so stale approvals can be spotted |
| `listCheckRuns(ref)` | `GET /commits/{ref}/check-runs` | `totalCount`, `complete` |
| `getCombinedStatus(ref)` | `GET /commits/{ref}/status` | Latest status per context; `totalCount`, `complete` |
| `createCommitStatus(sha, status)` | `POST /statuses/{sha}` | Description truncated to 140 characters |
| `listReviewThreads(n)` | `POST /graphql` (`pullRequest.reviewThreads`, 100 per page) | All pages; `id`, `isResolved`, `isOutdated`, `path`, `line`, `commitSha` (first comment's `originalCommit.oid`), comments (author, body, URL, time) |
| `getBranch(name)` | `GET /branches/{name}`, `GET /rules/branches/{name}` | `requiredChecks` merges classic protection contexts and ruleset `required_status_checks`; `null` when either could not be read (a protected branch without readable protection, or rules 403/404), never "none required" |
| `getDefaultBranch()` | `GET /repos/{owner}/{repo}`, then `getBranch` | |
| `mergePullRequest(n, { expectedHeadSha, method?, commitTitle? })` | `GET /pulls/{n}`, `PUT /pulls/{n}/merge` with `sha` | See below |

Paths above are relative to `/repos/{owner}/{repo}`.

`GitHubTracker` also implements `RepositoryAdmin` (`src/tracker/types.ts`), used only by the operator
commands ([`docs/OPERATOR.md`](OPERATOR.md)), never by the orchestrator. It is bound to the same repository:

| Method | GitHub REST call(s) | Notes |
| --- | --- | --- |
| `listLabels()` | `GET /labels` | All pages; color lower-cased, missing description is `''` |
| `createLabel(label)`, `updateLabel(name, label)` | `POST /labels`, `PATCH /labels/{name}` (`new_name`) | Color is six lower-case hex digits |
| `getFile(path)`, `putFile(path, { content, message, sha })` | `GET`/`PUT /contents/{path}` | Default branch; `null` when missing; a stale `sha` is `conflict` |
| `listAllIssues()` | `GET /issues?state=all` | All pages, open and closed, PRs dropped |

`mirror` reads its source with a second `GitHubTracker` bound to the source repository and only calls
`getIssue` on it.

### Pagination and completeness

Listings follow `Link: rel="next"` until the last page. A listing needing more than `maxPages` pages throws
`incomplete` rather than returning partial data, and pagination links to another origin are refused
(`invalid-response`), as are redirects to another origin (same-origin redirects, such as a renamed
repository, are followed), so the token is never sent elsewhere. Items are deduplicated by stable ID, so an item
that shifts between pages while paging is returned once.

### Linked pull requests

Links come from the issue timeline, not from searching text, so an unrelated PR mentioning `#12` somewhere is
not reported unless GitHub recorded a cross-reference. `relation` is `closing` only when the PR title or body
uses a closing keyword (`close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`,
`resolved`) with `#12`, `owner/repo#12` or `https://github.com/owner/repo/issues/12` for this exact issue:
`Fixes #123`, `Refs #12` and `fixes other/repo#12` do not count as closing issue 12.

### Merging

`mergePullRequest` reads the PR first and throws `head-mismatch` without calling the merge endpoint when the
head is not `expectedHeadSha`. It then sends `PUT /pulls/{n}/merge` with `sha: expectedHeadSha`, so a head that
moves between the read and the merge is also refused (GitHub 409 → `head-mismatch`). Branch protection is never
bypassed: GitHub's 405 (required reviews, checks, conflicts) becomes `not-mergeable` with GitHub's message.
A PR already merged at the expected head returns `{ alreadyMerged: true, mergeCommitSha }`; a closed unmerged
PR throws `not-open`. `merge_method` is sent only when `method` is given, otherwise the repository default
applies.

Example:

```ts
const result = await tracker.mergePullRequest(42, { expectedHeadSha: 'a1b2…40 hex', method: 'squash' });
// → { mergeCommitSha: '9f8e…', alreadyMerged: false }
```

```http
PUT /repos/acme/widgets/pulls/42/merge
{"sha":"a1b2…","merge_method":"squash"}

HTTP/1.1 405
{"message":"At least 1 approving review is required by reviewers with write access."}
→ TrackerError { code: 'not-mergeable', status: 405, retryable: false, ambiguous: false }
```

## Normalized data examples

```jsonc
// TrackerIssue
{ "number": 12, "key": "acme/widgets#12", "title": "Crash on save", "body": "...", "state": "open",
  "stateReason": null, "labels": ["bug-smasher"], "author": { "login": "reporter", "type": "user" },
  "url": "https://github.com/acme/widgets/issues/12", "createdAt": "...", "updatedAt": "...", "closedAt": null }

// TrackerComment — reply attribution and idempotency
{ "id": "1001", "issueNumber": 12, "author": { "login": "reporter", "type": "user" },
  "authorAssociation": "NONE", "body": "Firefox 130", "url": "...#issuecomment-1001",
  "createdAt": "...", "updatedAt": "...", "fromService": false, "serviceKey": null }

// IssueEvent
{ "id": "2001", "type": "unlabeled", "label": "needs-triage", "actor": { "login": "maintainer", "type": "user" },
  "at": "...", "commitId": null }

// LinkedPullRequest
{ "relation": "closing", "pullRequest": { "number": 42, "state": "merged", "headSha": "...",
  "mergeCommitSha": "...", "mergedBy": { "login": "maintainer", "type": "user" }, ... } }
```

`toGitHubFacts(repo, issue, pullRequest)` converts tracker reads into the model's `GitHubFacts` for
`presentBug` and transitions.

## Errors

`TrackerError` has `code`, `operation`, `status`, `retryable`, `retryAfterSeconds`, `rateLimit`
(`limit`, `remaining`, `resetAt`, `resource`), `requestId` and `ambiguous`, and serializes safely with
`JSON.stringify`.

| Code | When | `retryable` |
| --- | --- | --- |
| `unauthorized` | 401 | no |
| `forbidden` | 403 that is not a rate limit | no |
| `not-found` | 404 | no |
| `not-an-issue` | an issue call on a PR number | no |
| `rate-limited` | 429, or 403 with `x-ratelimit-remaining: 0`, `retry-after` or a rate-limit message | yes; `retryAfterSeconds` from `retry-after`, else the primary reset, else 60 |
| `validation` | 422 / other 4xx, or invalid input rejected before any request | no |
| `head-mismatch` | PR head differs from `expectedHeadSha` (local check or merge 409) | no |
| `not-open` | merging a closed PR | no |
| `not-mergeable` | merge 405 (branch protection, conflicts) | no |
| `conflict` | other 409 | no |
| `server-error` | 5xx | yes |
| `network`, `timeout` | request failed or exceeded `timeoutMs` | yes |
| `invalid-response` | unparseable or unexpectedly shaped response, or a foreign pagination link | no |
| `incomplete` | listing exceeds `maxPages` | no |

`ambiguous: true` means a write may have been applied (5xx, network failure or timeout on a non-GET):
re-read before retrying, and use `postComment(..., { key })` so a retried comment is not duplicated.
Messages include GitHub's message but never the token: the configured token and token-like strings
(`ghp_…`, `github_pat_…`, `Bearer …`, `token …`) are replaced with `[redacted]`.

## In-memory tracker

`InMemoryTracker` implements the same contract; `test/helpers/tracker-contract.ts` runs one suite against it
and against `GitHubTracker` talking to the offline fake GitHub server (`test/helpers/fake-github.ts`). Its
simulation API models people and GitHub acting outside the service:

| Method | Simulates |
| --- | --- |
| `seedIssue`, `seedPullRequest({ headSha, files?, changedFiles?, diff?, references?, labels? })` | existing issues and PRs (`references` makes the PR appear on those issues' timelines) |
| `externalComment`, `externalLabel`, `externalCloseIssue`, `externalReopenIssue` | replies and changes by people |
| `externalMerge`, `externalClosePullRequest` | a person merging (closing issues the PR closes) or closing a PR |
| `pushHead`, `blockMerge`, `addReview`, `addCheckRun` | new commits, branch protection, reviews, checks |
| `failNext(point, failure)` | the next call to a provider operation fails; `{ applied: true }` applies the write first (lost response) |

Differences from GitHub: comments, events and labels on PR numbers are refused with `not-an-issue`, and a
simulated rate limit defaults to a 60-second wait.

## GitHub documentation used

- Issues, issue comments, labels, issue events and timeline events REST endpoints (listing includes PRs via
  `pull_request`; timeline `cross-referenced` events).
- Pull requests REST endpoints: get, list files (at most 3000), reviews, merge (`sha` precondition; 405/409).
- Commit statuses and check runs REST endpoints.
- "Using pagination in the REST API" (`Link` header), "Rate limits for the REST API" (`retry-after`,
  `x-ratelimit-*`, 403/429), "API versions" (`X-GitHub-Api-Version`), and linking a pull request to an issue
  with closing keywords.
