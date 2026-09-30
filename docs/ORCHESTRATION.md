# Workflow orchestration

`src/orchestrator/` connects the pure bug model (`docs/MODEL.md`), the `Tracker` (`docs/TRACKER.md`), the
Devin adapter (`docs/DEVIN.md`) and the `BugStore`. The model decides; the orchestrator gathers facts,
persists results and applies side effects. It depends only on those contracts, so every behaviour below is
exercised offline with `InMemoryTracker` and `OfflineDevin` (`test/orchestrator.test.ts`).

| File | Contents |
| --- | --- |
| `orchestrator.ts` | `Orchestrator` (polling, steps, outbox, dispatch, sessions, replies, verification, decisions), `consumesCapacity`, `TraceEvent` |
| `contracts.ts` | `Verifier` (implemented by `src/verify/`, see `docs/VERIFICATION.md`), `DecisionPolicy` (M1.6), `VERIFICATION_STATUS_CONTEXT`, `verificationStatus`, `READY_STATUS_CONTEXT`, `readyStatus`, unavailable stubs, actor helpers |
| `prompts.ts` | Loads and renders `prompts/*.md` strictly |
| `playbooks.ts` | Route Playbook titles and bodies, and which synced Playbook ids to attach (see `docs/DEVIN-PROMPTS.md`) |
| `comments.ts` | Text fragments for session messages and recorded questions (verification flags, waiting-session summaries) |
| `../../prompts/` | Repository-owned prompt templates (see `prompts/README.md`) |

## Service wiring

`npm start` (the `run` operator command, [`docs/OPERATOR.md`](OPERATOR.md)) serves the offline replay when
neither `GITHUB_TOKEN` nor `DEVIN_API_KEY` is set: the same `Orchestrator` with `InMemoryTracker`,
`OfflineDevin` behind `DevinClient`, `RecordedVerifier`, a separate replay store and simulated time
([`docs/REPLAY.md`](REPLAY.md)). Otherwise it starts polling only when `liveSettingsProblems(settings)` is
empty; if not, it logs why and serves the scaffold as before. Live wiring: `BugStore.open()` (`data/bugs.json`), `GitHubTracker`,
`DevinClient.fromSettings`, `Prompts.load()`, `requireLiveResults: true` (stub verifiers/policies are
refused), `verifierFromSettings` when `verifierSettingsProblems` is empty (otherwise the unavailable
verifier, with the reason logged), and the unavailable policy until M1.6 provides one.

The service never comments: picking-up notices, triage findings and questions are Devin's own comments
(its prompts say so), and verification flags, Review blockers and refused merges reach it as session
messages. Policy outcomes show in the commit status and the dashboard only.

## Cycle

- `start()` runs a cycle immediately, then every `POLL_SECONDS` (default 60) after the previous cycle has
  finished. `runCycle()` called during a cycle joins it (`cycle-skipped`); cycles and interface actions are
  serialized, so they never overlap.
- A cycle reads open issues carrying any workflow label (`listOpenIssues`) plus every tracked issue by
  number (so closed, unlabelled and relabelled records keep being followed), then takes **at most one
  workflow step per issue**, in issue order.
- Unknown issues without a workflow label are never enrolled, commented on or relabelled. `enrollBug`
  decides intake and routing (engineer precedence, feature/bug-fix conflict, bug-fix over triage).

### One step, in priority order

1. Enrol (unknown, eligible, open issue) — label events existing at enrolment are marked handled.
2. Drain the outbox (below); a failed operation ends the step and is retried next cycle.
3. Linked fix PR merged, closed or with a new head → `pr-merged` / `pr-closed` / `head-changed`.
4. Issue closed → `issue-closed` (running session stopped); reopened → `issue-reopened` (label routing).
   While closed, only the stopped session's live state is followed.
5. A workflow label added **by a person** since the last step → that person's action (`github:<login>`,
   the label event time). Bot label changes are not decisions, and neither are the service's own: the
   record keeps each label it added or removed (`ownLabelChanges`) and the matching event is ignored,
   so a person still counts even when the token belongs to them.
6. Label snapshot → `labels-changed`, except that a snapshot never moves a `triaged` record into repair
   (`decision-label-ignored`): only a person's label event or a policy decides. The issue is re-read
   after the outbox moved labels in this step, so the snapshot is never older than those moves.
7. `bug-smasher/ready` commit status → published on the fix PR's current head (below).
8. Pending dispatch → reconcile (below).
9. Live session → read it: valid structured output → model event; otherwise only its live state.
10. Relay one genuine human comment to the live session.
11. `merged` without a settled post-merge proof → `Verifier` (`post-merge`, merge commit); `verifying` → injected `Verifier`; `triaged` with `DECISION` ≠ `person` → injected `DecisionPolicy`.
12. `queued` with a route → dispatch.

## Durable state and exact-once effects

`BugRecord.workflow` (`WorkflowState`, optional for older records, validated by `validateBugRecord`):

| Field | Purpose |
| --- | --- |
| `dispatch` | Create intent persisted **before** `createSession`: route, time, attempt tag, reconcile checks, comment IDs included in the prompt |
| `outbox` | Pending `WorkflowOperation`s, written in the same atomic store write as the transition that caused them |
| `relayedCommentIds` | Human comments already delivered to Devin (prompt or message) |
| `handledEventIds` | Label events already considered as decisions |
| `ownLabelChanges` | Each label the service added or removed, with the time it applied it — matched against labeled events so its own changes are never read as a person's |
| `ready` | Last published `bug-smasher/ready` evaluation: head, `pending`/`success`, detail and time |
| `workQuestion` | Question asked by a repair/feature session (the model's questions are triage-only) |
| `notices` | One-time notices already queued |

Operations are removed from the outbox only after they succeed, so a restart re-applies at most the
operation that was in flight, and each is idempotent:

- `send-message` carries a `Reference: bug-smasher:…` marker; before sending, the session's messages are
  read and an already-delivered marker is skipped (`message-already-delivered`).
- Labels are add-before-remove and no-ops when already applied; `stop-session` terminates
  and archives the session (so a later pull request comment cannot wake it); a 409 (already ended) falls back
  to `archiveSession`, and a 409 there is accepted only if `getSession` reports it archived. Not-found (404)
  counts as stopped. A session left unarchived is added to `unarchivedSessions`, is logged
  (`session-not-archived`), shown in the bug's next-action text and the stop is dropped, not applied;
  `merge-pr` uses the expected head SHA. Permanent failures (`not-found`, `validation`, …) are dropped with
  `effect-dropped`, retryable ones stay queued (`effect-failed`).

## Dispatch, capacity and reconciliation

- Before starting repair the orchestrator looks for an open linked closing PR; if one exists the record is
  handed off (`handoff-requested`, reason `existing-pr`) instead of starting a duplicate session.
  Continuing a live investigation into repair gets the same check.
- `consumesCapacity(record)`: a pending dispatch, or a live, not-stopping session in `triaging`, `fixing`
  or `verifying` without an open work question. Sessions waiting on a person (`needs-input`, `triaged`)
  do not count, and neither does a `verifying` record when its verification can never run (live results
  required but no live verifier): the fix waits for the verifier, not for a session. New sessions, and
  transitions that would wake a waiting session (a reply, continuing into repair), wait while
  `MAX_ACTIVE_SESSIONS` is reached (`waiting-for-capacity`); a waiting reply is delivered once capacity
  frees. A session suspended in a way a message cannot resume (provider limits, provider errors) is handed
  off (`handoff-requested`, reason `session-suspended`) so it cannot hold a slot forever. A verifier run
  that produces no result (`verifier-unavailable`) records no attempt, so consecutive unavailabilities for
  one head count toward the same error budget; at the cap the record hands off as `verification-error`.
  Review corrections due on `ready-to-merge` records whose session cannot take a message are recorded as a
  round `blocker` instead of being sent to a session that can never receive them.
- Sessions go through `DevinClient.createSession`, so every request carries `max_acu_limit`, the structured
  output schema, identifying tags and empty `secret_ids` / `session_secrets`.
- An ambiguous create (timeout, reset, 5xx) keeps the intent with its attempt tag. Later cycles look the
  session up by tag (`findSessions`); the oldest match is adopted and extra matches are stopped. A new
  create is only made after `reconcileAttempts` (default 3) lookups found nothing (`create-abandoned`).
  A definite rejection clears the intent (`create-failed`).

## Sessions, questions and replies

- Only valid structured output advances a record (`structuredOutputEvents`, `fixSubmittedEvent` with the
  tracker's current head). A reported fix PR must be open, in this repository and a closing PR for the issue. Absent, incomplete or invalid output changes nothing (`structured-output-ignored`);
  chat text is never parsed.
- A triage session that opens a PR is refused (`unexpected-triage-pr`): no fix is recorded.
- A triage question is recorded for the dashboard; Devin asks it on the issue itself. A completed
  investigation stores the findings; Devin posts the triage comment itself, with the evidence, the
  proposed check and the recommendation, stated as **not a decision**.
- Human comments are those not written by a bot. They are relayed unchanged, one per step, with the same
  marker/ID bookkeeping across restarts. Comments present at dispatch are included in the prompt instead.
- Repair approved while the investigation session is live → `repair-continue` message to that session;
  after it ended → a new session with saved findings and human context. A session that ends unexpectedly
  hands off (model rule); it is never silently restarted.
- On merge the live session receives the post-merge acknowledgement before the model stops it.

## Verifier and policy contracts

```ts
interface Verifier { live: boolean; verify(request: VerificationRequest): Promise<VerificationOutcome> }
type VerificationOutcome =
  | { status: 'completed'; attempt: Omit<VerificationAttempt, 'sessionId'> }
  | { status: 'unavailable'; reason: string };

interface DecisionPolicy { live: boolean; decide(request: DecisionRequest): Promise<PolicyOutcome> }
type PolicyOutcome =
  | { status: 'decided'; action: 'fix' | 'engineer'; rule: string; reasons: string[]; evaluation: PolicyEvaluation | null }
  | { status: 'wait'; reason: string; rule: string | null; evaluation: PolicyEvaluation | null }
  | { status: 'unavailable'; reason: string };

interface Reproducer { live: boolean; reproduce(request: ReproductionRequest): Promise<ReproductionResult> }
// request: { bugKey, sha (default-branch head), testFile, testCode: string | null }
type ReproductionResult = { status: 'completed'; check: ReproductionCheck } | { status: 'unavailable'; reason: string };
```

The service wires `CheckedVerifier` as both verifier and reproducer, and builds the decision policy from
`DECISION` (`decisionPolicy` in `src/orchestrator/policies.ts`) unless one is injected.

`unavailable` is recorded nowhere and never implies success (`verifier-unavailable`, `policy-unavailable`).
A completed attempt must match the requested phase and SHA (the current head for `pre-merge`, the merge
commit for `post-merge`), and is recorded through `verification-recorded` together with a durable
`set-commit-status` operation (context `bug-smasher/verification`) on that SHA, so failed-proof (`MAX_FIX_RETRIES`) and infrastructure-error budgets stay separate
as the model defines. A failed proof with retries left sends `verification-retry` to the same session for the
same PR branch. With `requireLiveResults`, non-live verifiers and policies are not called. Policy decisions
are attributed to `policy:<rule>` and recorded in the evaluation.

## Whether Devin is still working (`bug-smasher/ready`)

While an issue's fix PR is open, each step publishes the `bug-smasher/ready` commit status on the PR's
current head through a `set-commit-status` outbox operation, persisted as `workflow.ready` so a head's
evaluation is never computed or published twice:

- **pending** ("Devin is still working on this") while the session behind the PR is still working
  (a fresh `getSession` read, so a session that resumed is caught), Devin's autofix review comment says it
  is addressing findings, or the newest commit is under about 90 seconds old (the fix may still be running
  its own checks).
- **success** ("Devin is done") when none of those holds.
- If the session or the review comment cannot be read, the status stays pending and the detail says why —
  it never turns green on missing information.

While pending, the bug's next-action text waits on Devin rather than asking anyone to merge, and both
merge policies refuse (the `ready` check above). A green `ready` says nothing about whether the fix is
correct — `bug-smasher/verification` still decides that. Owners who want the merge button itself held can
add `bug-smasher/ready` as a required status check in the base branch's branch protection; the service
never touches branch protection.

## Decision and merge policies

Policies act only through the model's actions (`fix`, `engineer`, `merge`) with actor `policy:<rule>`,
and every Rule/Automatic evaluation is persisted (`policy-evaluated`) with each check, its detail and any
reproduction evidence. An evaluation equal to the latest one for the same subject is not recorded again,
so restarts and repeated cycles change nothing twice. No policy ever closes an issue.

| `DECISION` | Behaviour for a `triaged` bug |
| --- | --- |
| `person` (default) | Nothing automatic; a person labels the issue on GitHub (or uses an interface action) |
| `rule` (`decision-rule`) | Fix only when **all** hold: Devin recommends `devin_fix`; the issue has at least one class label (a label other than the four workflow labels) and every class label is in `DECISION_RULE_CLASSES`; the proposed test **fails** when run independently on the current default-branch head. Otherwise wait for a person, with the failing checks in the evaluation |
| `auto` (`decision-auto`) | Apply `devin_fix` (repair) and `needs_engineer` (handoff); `close` always waits for a person |

Reproduction (Rule only, and only when the other checks pass): the reproducer checks out the default
branch's head, uses `proposed_check.test_code` when triage supplied it (written at `test_file`),
otherwise the committed `test_file`, and runs only the configured `CHECK_COMMAND` in the verification
sandbox — never Devin's proposed command. A failing test is `reproduced`; a passing one `not-reproduced`;
a missing file without test code, an unsafe or non-test path, a setup error or no result is `unknown`.
Anything but `reproduced` waits. A result is reused for the same default-branch commit.

Once a head is `ready-to-merge`:

1. **Devin Review** (`DEVIN_REVIEW=true`): request a Review once per `{PR, head}`, poll until it
   completes, then record the unresolved threads `devin-ai-integration[bot]` started on that commit. With
   findings, the correction is sent once to the same live session (`bug-smasher:review:<head>` marker);
   the new head is verified afresh and reviewed again. After `maxReviewRepairs` (default 2) correction
   rounds per PR, or when the session has ended, the round gets a durable `blocker`, sent to the live
   session as one message when there is one.
   While polling a requested Review, `not-requested` or an earlier commit's Review keeps the round
   `pending` for up to 30 minutes after the request, then the round is `unavailable`. An error, `forbidden`, `not-requested` (when requesting), `cancelled`, `skipped` or disabled Review is recorded as
   `unavailable` and never counts as passed. Auto-Fix is never assumed. Resolved or removed finding threads
   are recorded as `resolutions` (`same-session` when fixed on a later head after a correction).
2. **Merge policy** (`MERGE`), evaluated on a fresh read of the PR, check runs, commit statuses, Review
   threads and the base branch:

| Check | `rule` (`merge-rule`) | `auto` (`merge-auto`) |
| --- | --- | --- |
| Latest pre-merge verification of the **current** head passed | required | required |
| No verification violations or flags (`deletion-only`, `check-silenced`) | required | flags allowed |
| CI green (check runs and commit statuses other than `bug-smasher/verification` and `bug-smasher/ready`) — `pending`, `failing`, `missing` or `unknown` (incomplete listing) refuse | required | required |
| `bug-smasher/ready` on the current head is `success` (Devin is done) | required | required |
| Devin Review completed for this head and no unresolved Devin Review thread | required | not checked |
| Additions + deletions `<= MERGE_MAX_LINES` | required | not checked |
| Base branch requires `bug-smasher/verification` (`required`/`missing`/`unknown`) | reported, not blocking | reported, not blocking |

`person` never merges automatically. A passing evaluation requests `merge-pr` with the evaluated head as
`expectedHeadSha`; GitHub refuses the merge if the head moved (the model then sees `head-changed` and
verifies the new head afresh) and branch protection is never bypassed. If GitHub refuses the
request for a reason other than a moved head (for example a required approval is missing), the next
cycle re-evaluates the same head and, if it still passes, asks GitHub again (`merge-retried`) without
recording another decision. A refusal for a reason other than a moved head reaches the live session once
per head as a `merge-refused` message. Direct merges by a person are detected the same way and record
`mergedBy`/`mergedAt`/merge commit. After any merge the merge commit is verified (`post-merge`); a
failure hands off to an engineer. The merge outcome lives in the commit status and the dashboard only —
no comment is posted, and the issue stays open unless GitHub closed it through a closing keyword.

When a session starts, Devin itself posts the picking-up comment addressed to the issue author with its
session link (its prompt tells it to post once per session and check the thread first). The service posts
nothing.

## Actors

- GitHub label decisions: `github:<login>` at the label event time.
- Interface actions (`performAction`): `interface:bug-smasher` — never an invented person.
- Policies: `policy:<rule>`.

## Trace events

`trace(event)` receives `{ cycle, at, key, type, detail }` for every decision point: `enrolled`,
`not-enrolled`, `transition` (`what`, `from`, `to`, queued `operations`), `refused`, `effect-applied`,
`effect-failed`, `effect-dropped`, `message-already-delivered`, `dispatch-intent`, `session-created`,
`create-ambiguous`, `create-failed`, `reconcile-not-found`, `create-abandoned`, `waiting-for-capacity`,
`waiting-for-session-end`, `label-conflict`, `decision-label-ignored`, `structured-output-ignored`, `unexpected-triage-pr`,
`reply-relayed`, `question-posted`, `verifier-unavailable`, `policy-unavailable`, `policy-waiting`,
`review-requested`, `review-unavailable`, `merge-waiting`, `merge-already-requested`, `merge-retried`, `cycle-*`, `error`.
Run the traces with `ORCHESTRATOR_TRACE=1 node --test test/orchestrator.test.ts`; each test prints its
trace as diagnostics.

## Requirement to test

Tests are in `test/orchestrator.test.ts` unless noted.

| Requirement | Test |
| --- | --- |
| Direct repair: capped session, ACU cap, schema, empty secrets, one step per cycle, PR from structured output | `direct repair` › enrolls a bug-smasher issue… |
| Investigation → question → reply → triage → approval → repair; recommendation is not a decision; GitHub actor | `investigation, question, reply, approval, repair` |
| Same-session continuation while live | same test (session ID unchanged, one create) |
| Exact-once question/reply delivery across restart; bot comments not relayed; reply unchanged | same test (restart before every step) |
| New session after the investigation session ended, with findings and human context | `repair after the investigation session ended` |
| Close stops work, reopen reroutes, engineer label hands off, service never closes issues | `close, handoff and reopen` › stops active work… |
| Stopping a session archives it; 404 counts as stopped; a 409 completes only if the session is archived, otherwise it is recorded and surfaced | `close, handoff and reopen` › archives the session it stops… |
| Unexpected session end hands off instead of restarting | `close, handoff and reopen` › hands off instead of restarting… |
| Unknown unlabelled issue untouched | `labels` › leaves an unknown unlabelled issue untouched |
| Conflicting labels start no work | `labels` › does not start work for conflicting… |
| Removed label or relabel to triage stops a running fix | `labels` › stops a live repair… |
| Removed label stops a fix waiting to merge; Automatic does not merge it | `merge policies` › Automatic does not merge a verified fix whose work label… |
| Repair → triage | `labels` › routes queued repair back to investigation… |
| Existing PR prevents duplicate repair (new and continued) | `existing pull requests` (both tests) |
| Capacity; waiting sessions free capacity; blocked replies wait | `capacity` › queues work at MAX_ACTIVE_SESSIONS… |
| No overlapping cycles | `capacity` › never runs two cycles at once |
| Lost write answers: no duplicate comment or message after restart | `exact-once effects` |
| Ambiguous create reconciliation across restart | `ambiguous session creation` (both tests) |
| Malformed/incomplete structured output refused | `structured output` › refuses malformed… |
| Unexpected triage PR refused | `structured output` › refuses a PR opened by an investigation session… |
| Feature intake by acceptance criteria | `features` |
| Separate failed-proof and infrastructure-error budgets; retry on the same PR branch | `verification contract` › keeps failed-proof… |
| Unavailable dependencies never imply success | `verification contract` (all three tests), `direct repair` |
| Independent verifier integration (statuses, retries, handoffs, post-merge) | `test/orchestrator-verification.test.ts`; see `docs/VERIFICATION.md` |
| Merge commit recorded; post-merge acknowledgement once | `merge` |
| Interface actor | `interface actions` |
| Bot labels never approve repair; all undelivered comments reach Devin; stale repair questions do not free capacity; fix PRs must close the issue | `review hardening` |
| Existing-PR handoff event, workflow validation | `test/transitions.test.ts` › existing pull request handoff |
| Prompt assets and strict one-pass rendering | `test/orchestrator-prompts.test.ts` |
| Decision and merge policies, Devin Review, reproduction, session-start behaviour | `test/orchestrator-policies.test.ts`, `test/policies.test.ts`; see the M1.6 table in the PR and `docs/TESTING.md` |
