# Workflow orchestration

`src/orchestrator/` connects the pure bug model (`docs/MODEL.md`), the `Tracker` (`docs/TRACKER.md`), the
Devin adapter (`docs/DEVIN.md`) and the `BugStore`. The model decides; the orchestrator gathers facts,
persists results and applies side effects. It depends only on those contracts, so every behaviour below is
exercised offline with `InMemoryTracker` and `OfflineDevin` (`test/orchestrator.test.ts`).

| File | Contents |
| --- | --- |
| `orchestrator.ts` | `Orchestrator` (polling, steps, outbox, dispatch, sessions, replies, verification, decisions), `consumesCapacity`, `TraceEvent` |
| `contracts.ts` | `Verifier`, `DecisionPolicy` (implemented later by M1.5/M1.6), unavailable stubs, actor helpers |
| `prompts.ts` | Loads and renders `prompts/*.md` strictly |
| `comments.ts` | GitHub comment bodies (question, triage summary, notices) |
| `../../prompts/` | Repository-owned prompt templates (see `prompts/README.md`) |

## Service wiring

`npm start` starts polling only when `liveSettingsProblems(settings)` is empty; otherwise it logs why and
serves the scaffold as before. Live wiring: `BugStore.open()` (`data/bugs.json`), `GitHubTracker`,
`DevinClient.fromSettings`, `Prompts.load()`, `requireLiveResults: true` (stub verifiers/policies are
refused), and the unavailable verifier and policy until M1.5/M1.6 provide real ones.

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
   the label event time). Service and bot label changes are not decisions.
6. Label snapshot → `labels-changed`.
7. Pending dispatch → reconcile (below).
8. Live session → read it: valid structured output → model event; otherwise only its live state.
9. Relay one genuine human comment to the live session.
10. `verifying` → injected `Verifier`; `triaged` with `DECISION` ≠ `person` → injected `DecisionPolicy`.
11. `queued` with a route → dispatch.

## Durable state and exact-once effects

`BugRecord.workflow` (`WorkflowState`, optional for older records, validated by `validateBugRecord`):

| Field | Purpose |
| --- | --- |
| `dispatch` | Create intent persisted **before** `createSession`: route, time, attempt tag, reconcile checks, comment IDs included in the prompt |
| `outbox` | Pending `WorkflowOperation`s, written in the same atomic store write as the transition that caused them |
| `relayedCommentIds` | Human comments already delivered to Devin (prompt or message) |
| `handledEventIds` | Label events already considered as decisions |
| `workQuestion` | Question asked by a repair/feature session (the model's questions are triage-only) |
| `notices` | One-time notices already queued |

Operations are removed from the outbox only after they succeed, so a restart re-applies at most the
operation that was in flight, and each is idempotent:

- `post-comment` uses tracker **keyed comments** (`question:<id>`, `triage:<session>`, `existing-pr:<n>`, …).
- `send-message` carries a `Reference: bug-smasher:…` marker; before sending, the session's messages are
  read and an already-delivered marker is skipped (`message-already-delivered`).
- Labels are add-before-remove and no-ops when already applied; `stop-session` tolerates ended sessions;
  `merge-pr` uses the expected head SHA. Permanent failures (`not-found`, `validation`, …) are dropped with
  `effect-dropped`, retryable ones stay queued (`effect-failed`).

## Dispatch, capacity and reconciliation

- Before starting repair the orchestrator looks for an open linked closing PR; if one exists the record is
  handed off (`handoff-requested`, reason `existing-pr`) with one comment instead of a duplicate session.
  Continuing a live investigation into repair gets the same check.
- `consumesCapacity(record)`: a pending dispatch, or a live, not-stopping session in `triaging`, `fixing`
  or `verifying` without an open work question. Sessions waiting on a person (`needs-input`, `triaged`)
  do not count. New sessions, and transitions that would wake a waiting session (a reply, continuing into
  repair), wait while `MAX_ACTIVE_SESSIONS` is reached (`waiting-for-capacity`); a waiting reply is
  delivered once capacity frees.
- Sessions go through `DevinClient.createSession`, so every request carries `max_acu_limit`, the structured
  output schema, identifying tags and empty `secret_ids` / `session_secrets`.
- An ambiguous create (timeout, reset, 5xx) keeps the intent with its attempt tag. Later cycles look the
  session up by tag (`findSessions`); the oldest match is adopted and extra matches are stopped. A new
  create is only made after `reconcileAttempts` (default 3) lookups found nothing (`create-abandoned`).
  A definite rejection clears the intent (`create-failed`).

## Sessions, questions and replies

- Only valid structured output advances a record (`structuredOutputEvents`, `fixSubmittedEvent` with the
  tracker's current head). Absent, incomplete or invalid output changes nothing (`structured-output-ignored`);
  chat text is never parsed.
- A triage session that opens a PR is refused (`unexpected-triage-pr`): no fix is recorded and one notice
  is posted.
- A triage question posts one comment; a completed investigation stores the findings and posts one summary
  with evidence, the proposed check and the recommendation, stated as **not a decision**.
- Human comments are those not written by the service (marker), by bots, or by `serviceLogins`. They are
  relayed unchanged, one per step, with the same marker/ID bookkeeping across restarts. Comments present
  at dispatch are included in the prompt instead.
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
  | { status: 'decided'; action: 'fix' | 'engineer'; rule: string; reasons: string[] }
  | { status: 'wait'; reason: string }
  | { status: 'unavailable'; reason: string };
```

`unavailable` is recorded nowhere and never implies success (`verifier-unavailable`, `policy-unavailable`).
A completed attempt must match the current head (`pre-merge`), and is recorded through
`verification-recorded`, so failed-proof (`MAX_FIX_RETRIES`) and infrastructure-error budgets stay separate
as the model defines. A failed proof with retries left sends `verification-retry` to the same session for the
same PR branch. With `requireLiveResults`, non-live verifiers and policies are not called. Policy decisions
are attributed to `policy:<rule>` and explained in one comment.

## Actors

- GitHub label decisions: `github:<login>` at the label event time.
- Interface actions (`performAction`): `interface:bug-smasher` — never an invented person.
- Policies: `policy:<rule>`.

## Trace events

`trace(event)` receives `{ cycle, at, key, type, detail }` for every decision point: `enrolled`,
`not-enrolled`, `transition` (`what`, `from`, `to`, queued `operations`), `refused`, `effect-applied`,
`effect-failed`, `effect-dropped`, `message-already-delivered`, `dispatch-intent`, `session-created`,
`create-ambiguous`, `create-failed`, `reconcile-not-found`, `create-abandoned`, `waiting-for-capacity`,
`waiting-for-session-end`, `label-conflict`, `structured-output-ignored`, `unexpected-triage-pr`,
`reply-relayed`, `question-posted`, `verifier-unavailable`, `policy-unavailable`, `cycle-*`, `error`.
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
| Unexpected session end hands off instead of restarting | `close, handoff and reopen` › hands off instead of restarting… |
| Unknown unlabelled issue untouched | `labels` › leaves an unknown unlabelled issue untouched |
| Conflicting labels start no work | `labels` › does not start work for conflicting… |
| Removed label keeps the record | `labels` › keeps tracking a live repair… |
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
| Merge commit recorded; post-merge acknowledgement once | `merge` |
| Interface actor | `interface actions` |
| Existing-PR handoff event, workflow validation | `test/transitions.test.ts` › existing pull request handoff |
| Prompt assets and strict one-pass rendering | `test/orchestrator-prompts.test.ts` |
