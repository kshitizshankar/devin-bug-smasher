# Devin provider adapter

`src/devin/` holds the Devin API v3 adapter: typed operations for sessions, structured output, Devin
Review, Session Insights, usage and metrics, plus an offline stand-in. It depends only on the shared model
(`src/model/`) and settings (`src/config/settings.ts`), never on the GitHub adapter. Environment setup
operations (including the v3beta1 endpoints) are a separate client in `src/devin/setup.ts`.

| File | Contents |
| --- | --- |
| `client.ts` | `DevinClient`: sessions, tag lookup/reconciliation, messages, Review, Insights, usage, metrics |
| `sessions.ts` | Identifying tags, status classification, `DevinSession` parsing, model-event helpers |
| `structured-output.ts` | Appendix B schema (`STRUCTURED_OUTPUT_SCHEMA`) and `interpretStructuredOutput` |
| `review.ts` | Review states, unresolved findings from PR threads, corrective message, Auto-Fix note |
| `insights.ts` | Insights interpretation and projection onto the model's `SessionInsights` |
| `usage.ts` | ACU readings, cost estimation, metric time windows |
| `errors.ts`, `http.ts` | `DevinError` kinds, redaction, authenticated JSON transport |
| `offline.ts` | `OfflineDevin`: in-memory, doc-shaped stand-in for the endpoints above |
| `setup.ts` | `DevinSetupClient`: Playbooks, Knowledge notes, repository indexing, blueprints, builds |
| `wire.ts` | Provider wire shapes (snake_case, as documented) |

## Endpoints

All requests use `Authorization: Bearer <DEVIN_API_KEY>` against `https://api.devin.ai`
([authentication](https://docs.devin.ai/api-reference/authentication)). Lists use `first`/`after` cursor
pagination and return `items`, `has_next_page`, `end_cursor` (a next page without a cursor is an
`invalid-response`, never a silently shorter list)
([pagination](https://docs.devin.ai/api-reference/concepts/pagination)). Errors are ProblemDetail bodies.

| Operation | Method and path | Documentation |
| --- | --- | --- |
| `createSession` | `POST /v3/organizations/{org_id}/sessions` | [Create session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions) |
| `getSession` | `GET /v3/organizations/{org_id}/sessions/{devin_id}` | [Get session](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session) |
| `findSessions`, `findBugSessions`, `reconcileCreate` | `GET /v3/organizations/{org_id}/sessions?tags=…&first&after` | [List sessions](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions) |
| `sendMessage`, `sendReviewCorrections` | `POST /v3/organizations/{org_id}/sessions/{devin_id}/messages` | [Send message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages) |
| `listMessages` | `GET /v3/organizations/{org_id}/sessions/{devin_id}/messages` | [List messages](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages) |
| `terminateSession` | `DELETE /v3/organizations/{org_id}/sessions/{devin_id}?archive=true` | [Terminate session](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions) |
| `archiveSession` | `POST /v3/organizations/{org_id}/sessions/{devin_id}/archive` | [Archive session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive) |
| `getInsights` | `GET /v3/organizations/{org_id}/sessions/{devin_id}/insights` | [Get insights](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-insights) |
| `generateInsights` | `POST /v3/organizations/{org_id}/sessions/{devin_id}/insights/generate` | [Generate insights](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-session-insights-generate) |
| `requestReview` | `POST /v3/organizations/{org_id}/pr-reviews` (`pr_url`) | [Trigger review](https://docs.devin.ai/api-reference/v3/pr-reviews/post-organizations-pr-reviews) |
| `getReview` | `GET /v3/organizations/{org_id}/pr-reviews?pr_url&commit_sha` | [Get review status](https://docs.devin.ai/api-reference/v3/pr-reviews/get-organizations-pr-reviews) |
| `getSessionUsage` | `GET /v3/organizations/{org_id}/consumption/daily/sessions/{session_id}` | [Session consumption](https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily-sessions) |
| `getUsageMetrics` | `GET /v3/organizations/{org_id}/metrics/usage` | [Usage metrics](https://docs.devin.ai/api-reference/v3/metrics/organizations-metrics-usage-org) |
| `getSessionMetrics` | `GET /v3/organizations/{org_id}/metrics/sessions` | [Session metrics](https://docs.devin.ai/api-reference/v3/metrics/organizations-metrics-sessions) |
| `getPrMetrics` | `GET /v3/organizations/{org_id}/metrics/prs` | [PR metrics](https://docs.devin.ai/api-reference/v3/metrics/organizations-metrics-prs) |

Setup (`DevinSetupClient`):

| Operation | Method and path | Documentation |
| --- | --- | --- |
| `listPlaybooks`, `createPlaybook`, `updatePlaybook` | `GET`/`POST /v3/organizations/{org_id}/playbooks`, `PUT …/playbooks/{playbook_id}` | [List](https://docs.devin.ai/api-reference/v3/playbooks/organizations-playbooks), [create](https://docs.devin.ai/api-reference/v3/playbooks/post-organizations-playbooks), [update](https://docs.devin.ai/api-reference/v3/playbooks/put-organizations-playbooks-playbook-id) |
| `listKnowledgeNotes`, `createKnowledgeNote`, `updateKnowledgeNote` | `GET`/`POST /v3/organizations/{org_id}/knowledge/notes`, `PUT …/notes/{note_id}` | [List](https://docs.devin.ai/api-reference/v3/notes/organizations-knowledge-notes), [create](https://docs.devin.ai/api-reference/v3/notes/post-organizations-knowledge-notes), [update](https://docs.devin.ai/api-reference/v3/notes/put-organizations-knowledge-notes-note-id) |
| `indexRepository`, `getRepositoryIndexing` | `PUT`/`GET /v3beta1/organizations/{org_id}/repositories/{repository_path}/indexing` | [Index](https://docs.devin.ai/api-reference/v3/repositories/put-organizations-index-repository), [status](https://docs.devin.ai/api-reference/v3/repositories/get-organizations-repository-indexing-status) |
| `listBlueprints`, `createBlueprint`, `updateBlueprint` | `GET`/`POST /v3beta1/organizations/{org_id}/snapshot-setup/blueprints`, `PATCH …/{blueprint_id}` | [List](https://docs.devin.ai/api-reference/v3/snapshot-setup/list-organizations-blueprints), [create](https://docs.devin.ai/api-reference/v3/snapshot-setup/post-organizations-blueprints), [update](https://docs.devin.ai/api-reference/v3/snapshot-setup/patch-organizations-blueprint) |
| `triggerBuild`, `getBuild` | `POST /v3beta1/organizations/{org_id}/snapshot-setup/builds`, `GET …/builds/{build_id}` | [Trigger](https://docs.devin.ai/api-reference/v3/snapshot-setup/post-organizations-builds), [get](https://docs.devin.ai/api-reference/v3/snapshot-setup/get-organizations-build) |

## Contracts for the orchestrator

### Creating sessions

```ts
const devin = DevinClient.fromSettings(settings);
const result = await devin.createSession({ bugKey: 'acme/widgets#42', route: 'triage', prompt, repos: ['acme/widgets'], playbookId });
// result.outcome === 'created'   -> result.session (DevinSession), result.tags
// result.outcome === 'ambiguous' -> persist result.tags, then later:
const reconciled = await devin.reconcileCreate(result);
// 'found' (use reconciled.session) | 'not-found' (may still be in flight; check again before a new attempt)
// | 'duplicates' (stop all but one)
```

Every create sends `max_acu_limit` (`MAX_ACU_PER_SESSION`), four tags, the Appendix B schema,
`structured_output_required: false`, `secret_ids: []` and `session_secrets: []`:

```json
{
  "prompt": "…",
  "tags": ["bug-smasher", "bug-smasher:bug=acme/widgets#42", "bug-smasher:route=triage", "bug-smasher:attempt=<uuid>"],
  "max_acu_limit": 5,
  "structured_output_schema": { "type": "object", "properties": { "phase": {}, "status": {} }, "required": ["phase", "status"] },
  "structured_output_required": false,
  "secret_ids": [],
  "session_secrets": [],
  "repos": ["acme/widgets"],
  "playbook_id": null,
  "knowledge_ids": null,
  "title": null
}
```

A create is `ambiguous` on timeout, network failure, any 5xx, or a 2xx body that is not a valid session.
Any other 4xx throws a `DevinError` (nothing was created).

### Monitoring

`getSession` returns a `DevinSession`:

```ts
{
  id, url, title, tags, status, statusDetail,
  activity,     // starting | working | waiting(on user|approval) | idle | suspended(reason, resumable) | ended(exit|error) | unknown
  liveState,    // shared-model SessionLiveState, or null for unknown statuses
  createdAt, updatedAt, isArchived,
  acus,         // AcuReading
  pullRequests, // [{ url, state }] as reported by Devin
  structuredOutput, // absent | invalid(problems) | incomplete(output, missing) | valid(output, signal)
}
```

| Devin `status` / `status_detail` | `activity` | `liveState` |
| --- | --- | --- |
| `new`, `claimed`, `resuming` | `starting` | `starting` |
| `running` / `working` or null | `working` | `running` |
| `running` / `waiting_for_user`, `waiting_for_approval` | `waiting` | `blocked` |
| `running` / `finished` | `idle` | `blocked` |
| `suspended` / `inactivity`, `user_request` | `suspended`, `resumable: true` | `blocked` |
| `suspended` / credit, quota, payment, limit or contract details | `suspended`, `reason: 'provider-limit'`, `resumable: false` | `blocked` |
| `suspended` / `error` | `suspended`, `reason: 'provider-error'` | `blocked` |
| `exit`, `error` | `ended` | `ended` |
| anything else | `unknown` | `null` (emit nothing) |

No state implies completion. Model events:

```ts
sessionStatusEvent(session)        // { type: 'session-status', sessionId, liveState } | null
structuredOutputEvents(session)    // [] unless structuredOutput is valid:
                                   //   triage needs_input/blocked -> question-asked { id: questionId(sessionId, question), summary }
                                   //   (fix-phase questions emit nothing: the model accepts questions only while triaging)
                                   //   triage_complete     -> triage-completed { findings: TriageFindings }
fixSubmittedEvent(session, headSha) // pr_opened + GitHub head SHA -> fix-submitted | null
```

`interpretStructuredOutput` is `valid` only when the types match the schema and the fields a status needs
are present: `question` for `needs_input`/`blocked`; every triage field (including all three
`proposed_check` fields) for `triage_complete`; a `https://github.com/<owner>/<repo>/pull/<n>` `pr_url`
and `fix_summary` for `pr_opened`. `triage_complete` must be phase `triage` and `pr_opened` phase `fix`.

### Devin Review

```ts
await devin.requestReview(prUrl, headSha); // ReviewState
await devin.getReview(prUrl, headSha);     // ReviewState
// pending(pending|running) | completed | error | unavailable(disabled | not-requested | forbidden | cancelled | skipped | different-commit | unknown-status)
reviewFindings(review, threads);           // known { unresolved, earlier: ReviewFinding[] } | unavailable(review-not-completed | threads-not-supplied)
await devin.sendReviewCorrections(sessionId, findings.unresolved); // same-session correction message
```

The Review API reports status per commit only. Findings are the PR review threads that
`devin-ai-integration[bot]` started on the reviewed commit and nobody resolved; the orchestrator passes
those threads in (`ReviewThreadInput`, including the thread's `commitSha`, GitHub `originalCommit.oid`)
from the GitHub adapter. Open bot threads from other or unknown commits are returned as `earlier` and do
not count against the review. `REVIEW_AUTO_FIX` records that Auto-Fix is an admin-only web
app setting (Devin Review sidebar "Enable auto-fix", or Settings > Devin > Pull requests > Responding to
bots) with no API; the adapter never assumes it is on.

### Insights, usage and metrics

```ts
await devin.getInsights(id);      // available { insights } | pending | unavailable(not-generated | failed | forbidden | not-found)
await devin.generateInsights(id); // started | already-exists | unknown
toModelInsights(insights);        // shared SessionInsights { acuUsed, notes }
```

`DevinInsights` keeps `issues`, `actionItems`, `suggestedPrompt`, `knowledgeUsed` (helpful/unhelpful note
ids) and `skillsUsed`.

`AcuReading` is `reported { acus }` only for a positive number; zero is `unavailable: zero-reported` and a
missing value `unavailable: not-reported`. `estimateCostUsd(reading, settings.cost.acuPriceUsd)` returns
null unless both are known. Metrics and consumption return `Availability<T>`, `unavailable` on 403/404.

### Errors

Failures throw `DevinError` with `kind` (`not-configured`, `auth`, `forbidden`, `not-found`, `conflict`,
`invalid-request`, `rate-limited`, `provider`, `network`, `timeout`, `invalid-response`), `status`,
`retryAfterSeconds` (numeric `Retry-After` on 429) and `ambiguous`. The API key is held in private fields
and removed (with anything shaped like `Bearer …`, `cog_…` or `apk_…`) from every message.

### Offline stand-in

```ts
const offline = new OfflineDevin({ apiKey, orgId });
const devin = new DevinClient({ apiKey, orgId, maxAcuPerSession: 5, reviewEnabled: true, fetch: offline.fetch });
```

`OfflineDevin` serves the documented shapes from memory and records requests (without the token). It
never advances anything by itself: sessions stay `new`, reviews stay `pending`, insights are not
generated, ACUs are zero and metrics are forbidden until a test sets them (`updateSession`, `reviews`,
`pullRequestHeads`, `insights`, `metrics`). `failNext` injects HTTP errors, timeouts and resets, optionally
after applying the request (`applyFirst`) to model a lost create answer.

## Limitations and open points

- **Tag filter semantics.** The list endpoint accepts `tags` but does not document whether several tags
  match all or any; the client sends them repeated (`tags=a&tags=b`) and re-filters locally for all.
  Tag character limits are not documented; tags contain `:`, `=`, `/` and `#`.
- **Review findings are not in the API.** `PrReviewResponse` has no findings, so findings require the PR's
  review threads from GitHub. Resolution state is the only signal used; comment text is not parsed.
- **Structured output finality.** The API returns the latest `structured_output` with no `is_final` flag.
  After an answer, the previous `needs_input` output remains until Devin replaces it; the stable
  `questionId` lets the orchestrator ignore a question it already recorded.
- **Timestamps.** `created_at`/`updated_at` are documented as Unix timestamps; they are read as seconds
  (values above 10^12 as milliseconds). Values outside the `Date` range make the response invalid.
- **Fix-phase questions.** The shared model accepts `question-asked` only in `triaging`, so a fix session's
  `needs_input`/`blocked` output produces no model event; the orchestrator sees it as
  `structuredOutput.signal` and decides (e.g. hand off). Supporting fix-phase questions would need a
  shared-model change.
- **Model insights.** The shared `SessionInsights` has only `acuUsed` and `notes`; `toModelInsights`
  renders issues, action items, the suggested prompt and Knowledge used into `notes`. Storing them as
  structured fields would need a shared-model change for the orchestrator task.
- **Repository indexing path.** `repository_path` is sent as `owner/repo` (segments encoded, slash kept);
  the docs do not show an example.
- **Setup scope.** `DevinSetupClient` covers only the operations the setup task is expected to need; it is
  not used by `DevinClient`.
