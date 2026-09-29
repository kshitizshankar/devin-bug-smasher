# Bug model, persistence and settings

This document is the public contract for the shared bug model (`src/model/`), the JSON store
(`src/store/bug-store.ts`) and settings (`src/config/settings.ts`). Later adapters (GitHub, Devin,
verification), the API and the UI must use these modules rather than re-deriving state.

Nothing here calls GitHub or Devin, runs a workflow service or executes commands. The model is pure: it
takes the stored record plus the latest GitHub facts and returns a new record and a list of **effects**
for an adapter to apply.

## Source of truth

GitHub is authoritative for issue state, labels, text and comments, and pull request state. They are
never persisted; adapters pass them in as a `GitHubFacts` snapshot:

```ts
interface GitHubFacts {
  issue: { owner: string; repo: string; number: number; state: 'open' | 'closed'; labels: string[] };
  pullRequest: { number: number; state: 'open' | 'closed' | 'merged'; headSha: string } | null;
}
```

The store keeps only orchestration and evidence data (`BugRecord` in `src/model/types.ts`), keyed by
`owner/repo#number` (`parseBugKey` / `formatBugKey`).

## Record

| Field           | Contents                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `key`           | `owner/repo#number`                                                                                |
| `kind`          | `bug` or `feature`                                                                                 |
| `stage`         | One of the ten internal stages below                                                               |
| `route`         | Work queued or running: `triage`, `fix` or `null`                                                  |
| `session`       | Devin session `id`, `url`, `route`, `liveState` (`starting`/`running`/`blocked`/`ended`), timestamps, `stopRequestedAt`, `archiveFailedAt` (a stop left it unarchived) |
| `triage`        | Findings: title, summary, reproduction steps, expected/actual, suspected cause, affected files, reproduced + notes, proposed test (description, file, command — **data only, never executed** — and optional `code`, the full test file when it is not on the default branch), recommendation (`devin_fix`/`needs_engineer`/`close`), reason, confidence |
| `fix`           | PR number/URL, current head SHA, test files, summary, `mergeCommitSha`, `mergedBy` (`github:<login>`) and `mergedAt` (set by `pr-merged`) |
| `priorFixes`    | Earlier fix PRs, moved here when work is returned to investigation or repair                      |
| `verifications` | Attempts: phase (`pre-merge`/`post-merge`), base and head SHAs, `pass`/`fail`/`error`, reason, output tail, time, session ID, optional `evidence` (per-run role/step/SHA/command/times/exit/outcome/output, diff `violations` and `flags`) |
| `decisions`     | Person actions: action, outcome (`applied`/`requested`), actor, time, context                      |
| `questions`     | id, summary, asked time, answered time (`null` while outstanding)                                  |
| `stageHistory`  | One `{ stage, at }` entry per actual stage change                                                  |
| `handoff`       | Latest reason, detail and time work was handed to an engineer, and `engineerLabelSeen`             |
| `review`        | Optional Devin Review record: one round per reviewed `{prNumber, headSha}` (`pending`/`completed`/`unavailable`, detail, unresolved findings with thread ID/path/line/body/URL, `correctionSentAt`, durable `blocker`) and `resolutions` (thread, head it was found on and resolved on, `same-session` or `github`) |
| `evaluations`   | Optional Rule/Automatic policy evaluations: `kind` (`decision`/`merge`), policy, rule, subject (triage commit or PR head), outcome (`fix`/`engineer`/`merge`/`wait`), every check (`name`, `ok`, `blocking`, `detail`), reproduction evidence (`sha`, test file, `reproduced`/`not-reproduced`/`unknown`, reason, runs) |
| `insights`      | Optional session insights (`acuUsed` — `null` when unknown, never zero — and notes)                |

Display strings (status labels, groups, actions) are **not** persisted.

## Stages

`queued`, `triaging`, `needs-input`, `triaged`, `fixing`, `verifying`, `ready-to-merge`, `merged`,
`with-engineer`, `closed`.

## Labels and intake

`resolveLabels(labels, settings.labels)` (case-insensitive) returns the requested route:

1. `needs-engineer` wins over every other workflow label (route `engineer`).
2. `devin-builds-feature` together with `bug-smasher` is a **conflict**: no route, automatic dispatch refused
   with a reason.
3. `bug-smasher` (repair) wins over `needs-triage`.
4. `devin-builds-feature` routes to Fix with kind `feature`.
5. `needs-triage` routes to investigation.

`intakeEligibility(record, labels, settings)`: an issue without a stored record and without any workflow
label is not enrolled (it may still be shown as Backlog / Not started). A stored record stays eligible
when its labels are removed. `enrollBug` refuses closed issues.

## Presentation

`presentBug(record | undefined, facts, settings.labels)` is the single server-side derivation of
`status`, `statusLabel`, `group`, `actions` and `history` (recommendation, latest verification,
`currentHeadVerified`, `postMergeVerified`, handoff, outstanding question, `wasMerged`) and `automation`:
the latest decision evaluation, the Review round and merge evaluation for the current head only, the
number of resolved findings, the merge evaluation's `ci` and `branch-protection` (required verification
status) checks, and `blockers` — why a person is needed now. It is read-only and derived from the record.

### State/action table

Tested row by row in `test/presentation.test.ts`, which also checks that `applyAction` accepts exactly the
listed actions and refuses the rest without changing the record.

| Situation                                        | Status (`statusLabel`)                   | Group   | Permitted actions               |
| ------------------------------------------------ | ---------------------------------------- | ------- | ------------------------------- |
| Unknown open issue, no workflow label            | `not-started` (Not started)              | Backlog | triage, fix, engineer, close    |
| Queued for investigation                         | `queued-triage`                          | Triage  | fix, engineer, close            |
| Queued for repair (bug)                          | `queued-fix` (Queued for repair)         | Fix     | triage, engineer, close         |
| Queued feature                                   | `queued-fix` (Queued for implementation) | Fix     | engineer, close                 |
| Feature + bug-fix label conflict                 | `label-conflict`                         | Backlog | engineer, close                 |
| `triaging`                                       | `investigating`                          | Triage  | engineer, close                 |
| `needs-input` with an outstanding question       | `waiting-for-reply`                      | Triage  | reply, engineer, close          |
| `triaged`                                        | `needs-decision`                         | Triage  | fix, engineer, close            |
| `fixing`                                         | `fixing`                                 | Fix     | engineer, close                 |
| `verifying`, or ready without a current-head pass | `verifying`                             | Fix     | engineer, close                 |
| Open PR whose current head passed pre-merge proof | `ready-to-merge`                        | Fix     | merge, engineer, close          |
| PR actually merged, issue open                   | `merged`                                 | Merged  | close                           |
| PR actually merged, issue closed                 | `merged`                                 | Merged  | —                               |
| `with-engineer`, engineer label, or PR closed unmerged | `needs-engineer`                   | Backlog | triage, fix, close              |
| Merged fix handed off by post-merge verification, issue closed | `needs-engineer`           | Backlog | — (until the issue is reopened) |
| Issue closed (not merged)                        | `closed`                                 | Backlog | —                               |

Rules behind the table:

- `reply` requires an outstanding question.
- `merge` requires the linked PR to be open, its head to equal the stored fix head, and the latest
  pre-merge verification for that head to be `pass`. An open PR is never presented as fixed.
- `Merged` means GitHub reports the PR merged. A merged record keeps its history (verifications,
  handoff, `postMergeVerified`) while stale actions are no longer offered.

## Transitions and effects

```ts
enrollBug(facts, options, now): ModelResult
applyEvent(record, event, options, now): ModelResult   // facts observed by adapters
applyAction(record | undefined, facts, request, options, now): ModelResult   // person actions
type ModelResult = { ok: true; record; changed; effects: Effect[] } | { ok: false; error: { code; message } };
interface ModelOptions { labels; maxFixRetries /* MAX_FIX_RETRIES */; maxVerificationErrors /* 3 */ }
```

Invalid events/actions return `ok: false` and never modify the input record. Stage history and decisions
are appended once per actual change; repeated identical events return `changed: false`.

Events (`ModelEvent`): `labels-changed`, `session-started`, `session-status`, `question-asked`,
`reply-received`, `triage-completed`, `fix-submitted`, `head-changed`, `verification-recorded`,
`pr-merged` (with optional `mergedBy`/`mergedAt`), `pr-closed`, `issue-closed`, `issue-reopened`,
`insights-recorded`, `review-recorded { review }` (replaces the Review record) and
`policy-evaluated { evaluation }` (appends one evaluation). Neither of the last two changes the stage. An event whose resulting
record would fail `validateBugRecord` (e.g. negative usage, a malformed SHA, an empty session ID) is refused
with `invalid-data`, so every accepted event can be persisted.

Stale events are ignored (`changed: false`): `head-changed`, `pr-merged` and `pr-closed` carry `prNumber`,
and events for an earlier fix PR in `priorFixes` change nothing (a PR number that was never recorded is
refused with `unknown-pr`). `session-status` for any session other than the current one, or after the
current session reported `ended` (which is final), changes nothing.

Effects (`Effect`), to be applied in order by an adapter: `add-label`, `remove-label` (a no-op when the
label is absent), `close-issue`, `stop-session` (emitted once per session; recorded as `stopRequestedAt`),
`continue-session { sessionId, route }` (instruct a live session to continue with new work), `post-comment`, `merge-pr { prNumber, expectedHeadSha }`. The `merge` action records a `requested` decision and emits
`merge-pr`; the record only becomes `merged` on a later `pr-merged { mergeCommitSha }` event, which is
also accepted after `issue-closed` (GitHub may close the issue before reporting the merge).

A new session is refused (`session-active`) until the previous session has reported `ended`, even when a
stop was requested, so a stopping session and its replacement never overlap.

Main flows:

- `queued` → `triaging` (session started; labels must match the queued route; closed issues refused) →
  `needs-input` ⇄ `triaging` (questions / replies) → `triaged` (findings) → person `fix` (or a repair
  label) → `fixing` → `verifying` (fix submitted) → `ready-to-merge` (current-head pass) → `merged`.
  If the investigation session is still live, repair continues in that same session (`continue-session`,
  no stop); otherwise the record is `queued` for a new session.
- Session ended while `triaging`/`needs-input`/`fixing`, PR closed unmerged, failed or errored
  verification, or the engineer label/action → `with-engineer`, with reason and time recorded and any
  running session stopped. Automatic handoffs also emit `add-label` engineer and `remove-label` for the
  work labels. Work labels in label snapshots are ignored until a snapshot has shown the engineer label
  (`engineerLabelSeen`), so a snapshot taken before the label effects applied cannot requeue the work.
- `triage`/`fix` actions from `with-engineer` (or replacing the engineer label with a work label) return the
  work to `queued` with the person's context. The previous fix PR moves to `priorFixes`, so its closed or
  merged state no longer affects the new work.
- Issue closed → `closed` (running session stopped). Reopened → routed by the current labels with engineer
  precedence: the engineer label → `with-engineer`; a bug with findings → `triaged`, upgraded to repair by a
  repair or feature label; otherwise label routing.
- A merged fix handed to an engineer by post-merge verification stays `with-engineer` when the issue is
  (or already was) closed, so the failure remains visible as `needs-engineer`. No actions are offered until
  the issue is reopened; reopening applies the labels as a label snapshot would.

### Verification accounting

Counts are per fix session, so a new session after a handoff starts with fresh budgets.

| Outcome                         | Effect                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `pass` for the current head     | `ready-to-merge`                                                                          |
| `fail` (failed proof)           | Back to `fixing` for a retry while fails ≤ `MAX_FIX_RETRIES` (default 1); the next fail hands off (`verification-failed`) |
| `error` (infrastructure)        | Separate counter; stays `verifying` to retry; the 3rd error hands off (`verification-error`). Never counts as a failed-fix attempt |
| PR head changes                 | Back to `verifying`; earlier proof no longer applies; attempts for an old head are refused (`stale-head`) |
| Post-merge attempt              | Must target `fix.mergeCommitSha`; any other commit is refused (`stale-head`)             |
| Post-merge `fail`               | Hands off (`post-merge-verification-failed`); the record stays merged but `postMergeVerified` is `false` |
| Post-merge accounting           | `postMergeVerified` and the post-merge error counter use only attempts for the current fix's merge commit; attempts for archived PRs never count |

## Persistence

`BugStore.open(path = 'data/bugs.json')` loads `{ schemaVersion: 1, bugs: { [key]: BugRecord } }`.

- A missing file is an empty store; the directory and file are created on first write.
- Malformed JSON, unknown schema versions and invalid records throw `BugStoreError`
  (`corrupt`, `unsupported-schema`, `invalid-record`, `read-failed`); the file is never reset.
- `update(key, updater)` validates the new record, writes a unique temporary file, `fsync`s it and renames
  it over the store. Updates are serialized in-process; in-memory state changes only after a successful
  write. A failed write throws `write-failed` and leaves the previous file and state intact.
- `get` / `list` return copies.
- Within one process, `open` of the same resolved path returns the same instance (one snapshot, one write
  queue); a store that failed to open is not cached. Access from several processes is not supported.

## Settings

`loadSettings(env = process.env)` parses and validates all variables without requiring credentials;
`assertLiveSettings(settings)` / `liveSettingsProblems(settings)` enforce live-mode requirements;
`effectiveSettings(settings)` is the secret-free projection (tokens become `tokenConfigured` /
`apiKeyConfigured` booleans). Errors never include token or key values. See `.env.example`.

| Variable               | Default                 | Notes                                                    |
| ---------------------- | ----------------------- | -------------------------------------------------------- |
| `GITHUB_REPO`          | —                       | Live: required, `owner/repo`                             |
| `GITHUB_TOKEN`         | —                       | Live: required; secret                                   |
| `DEVIN_API_KEY`        | —                       | Live: required; secret                                   |
| `DEVIN_ORG_ID`         | —                       | Live: required                                           |
| `CHECK_COMMAND`        | —                       | Live: required, must contain `{files}`; verification also needs `{results}` (`docs/VERIFICATION.md`) |
| `VERIFY_IMAGE`, `VERIFY_SETUP_COMMAND` | unset | Verification test image and optional setup (`docs/VERIFICATION.md`) |
| `VERIFY_TIMEOUT_SECONDS` | `600`                 | Positive integer, per setup/test step                    |
| `VERIFY_WORK_DIR`      | `<repo>/data/verify`    | Mirror and disposable workspaces                         |
| `TRIAGE_LABEL`         | `needs-triage`          | Workflow labels must be distinct (case-insensitive)      |
| `FIX_LABEL`            | `bug-smasher`           |                                                          |
| `ENGINEER_LABEL`       | `needs-engineer`        |                                                          |
| `FEATURE_LABEL`        | `devin-builds-feature`  |                                                          |
| `DECISION`, `MERGE`    | `person`                | `person`, `rule` or `auto` (`docs/ORCHESTRATION.md`)     |
| `DECISION_RULE_CLASSES` | empty                  | Comma-separated class labels the Rule decision may fix; trimmed, no blanks or case-insensitive duplicates, at most 50 characters each; empty → Rule always waits |
| `MERGE_MAX_LINES`      | `200`                   | Positive integer; Rule merge accepts additions + deletions up to and including it |
| `MAX_ACTIVE_SESSIONS`  | `3`                     | Positive integer                                         |
| `MAX_ACU_PER_SESSION`  | `5`                     | Positive integer                                         |
| `MAX_FIX_RETRIES`      | `1`                     | Non-negative integer                                     |
| `DEVIN_REVIEW`         | `true`                  | `true` or `false`                                        |
| `POLL_SECONDS`         | `60`                    | Positive integer                                         |
| `HOST`                 | `127.0.0.1`             | Loopback only (`127.x.x.x`, `::1`, `localhost`)          |
| `PORT`                 | `8080`                  | `0` picks a free port (used by tests)                    |
| `STATIC_DIR`           | `<repo>/dist/web`       |                                                          |
| `BASELINE_FILTER`      | unset                   | Optional                                                 |
| `DEVIN_ACU_PRICE_USD`  | unset → `null`          | Positive decimal; unknown is never zero                  |
| `DEVIN_SPEND_USD`, `DEVIN_BUDGET_USD` | unset → `null` | Non-negative decimals; unknown is never zero |
| `DEVIN_SPEND_READ_AT`  | unset → `null`          | ISO 8601 timestamp                                       |
