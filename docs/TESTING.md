# Testing Bug Smasher

All checks run locally without GitHub, Devin or other provider credentials.

## Automated checks

```sh
npm ci              # install exactly what package-lock.json specifies
npm run typecheck   # tsc for the service/tests (tsconfig.json) and the web app (web/tsconfig.json)
npm run build       # Vite production build into dist/web/
npm test            # node --test "test/**/*.test.ts"
```

The smoke tests in `test/` spawn the real service entrypoint (`src/server/main.ts`) with `PORT=0`, wait for
it to log the URL it is listening on, make HTTP requests against it, and send `SIGTERM` to stop it when the
suite finishes.

| File                    | What it checks                                                                                      | Needs `npm run build` |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------- |
| `test/health.test.ts`   | `GET /api/health` returns `200` with the ok payload; non-GET is `405`; unknown API route is `404`   | No                    |
| `test/frontend.test.ts` | `/` serves the built `index.html`; every referenced JS/CSS asset is served byte-for-byte; SPA fallback; missing asset `404`; path traversal blocked | Yes |
| `test/static-read-failure.test.ts` | An asset that cannot be opened (mode `000`) returns `500`; a read that fails after headers are committed (Linux `/proc/self/mem` symlink) ends the response; `/api/health` still returns `200` after each | No |
| `test/dashboard-api.test.ts` | `/api/overview`, `/api/metrics`, `/api/settings` against the sanitized fixtures in `test/fixtures/api/`; shared status/gate/next-action derivation, recommendation vs. decision, open PR vs. merged, provider fields only when present, GitHub replies/labels/closure/merge reflected, stale and unavailable snapshots, writes rejected without side effects, local `Host` and loopback `HOST` only, running service without credentials | No |
| `test/service-settings.test.ts` | Service starts without provider credentials; an invalid setting stops startup with a clear, secret-free error | No |
| `test/labels-intake.test.ts` | Label precedence (engineer, repair over triage, feature/bug conflict), case-insensitivity, custom labels, known vs. unknown unlabelled intake | No |
| `test/transitions.test.ts` | Pure transitions: questions/replies, decisions and repair, verification retry vs. infrastructure-error counters, changed-head invalidation, merge vs. merged, post-merge proof, close, handoff/return, reopen, stage timestamps, invalid input leaves records unchanged | No |
| `test/presentation.test.ts` | The documented state/action table in `docs/MODEL.md`: status, group and permitted actions per row, and that `applyAction` accepts exactly those actions | No |
| `test/bug-store.test.ts` | JSON store: missing file, restart read-back in a separate process, overlapping updates, corrupt/invalid data refused, failed write preserves prior file and state | No |
| `test/settings.test.ts` | Defaults, `PORT=0`, invalid inputs rejected, distinct labels, live-mode credentials and `CHECK_COMMAND`, `VERIFY_*` settings, secret redaction, unknown costs stay `null` | No |
| `test/devin-client.test.ts` | Devin adapter against `OfflineDevin`: create request (cap, tags, schema, no secrets), working/waiting/idle/suspended/ended/unknown states, messages, terminate/archive, ambiguous create and tag reconciliation, auth/permission/rate-limit/provider errors, key redaction, zero/unavailable ACUs, metrics | No |
| `test/devin-structured-output.test.ts` | Absent, malformed, partial and complete structured output; only complete output yields model events, which the shared model accepts | No |
| `test/devin-review-insights.test.ts` | Devin Review pending/completed/error/unavailable, unresolved findings, corrective messages, Auto-Fix not assumed; Insights unavailable/pending/failed/available and model projection | No |
| `test/devin-setup.test.ts` | Setup client paths for Playbooks, Knowledge notes, repository indexing, blueprints and builds; redacted errors | No |
| `test/tracker-github.test.ts` | `GitHubTracker` against an offline fake GitHub REST server: the shared tracker contract, headers, Link pagination, page-limit and foreign-link refusal, drift deduplication, timeline filtering, merge `sha` precondition, label ordering, rate-limit/auth/validation/server/network/timeout/malformed-response errors, token redaction | No |
| `test/verify.test.ts` | Independent verifier against fixture git repositories with a local stand-in runtime: pass/fail/error outcomes, each diff check, path validation, no proposed commands, no credentials (fake Docker CLI); real Docker only with `VERIFY_DOCKER_IMAGE` | No |
| `test/orchestrator-verification.test.ts` | Orchestrator with the real verifier: commit statuses on exact SHAs, changed head, retry message, handoffs after two failed proofs and three errors, post-merge verification | No |
| `test/policies.test.ts` | Rule decision (each condition alone, empty class list, reproduction reuse, test code), Automatic decision, CI states, required verification status, Rule/Automatic merge checks including the exact `MERGE_MAX_LINES` boundary and deletion-only exception | No |
| `test/orchestrator-policies.test.ts` | Orchestrator with scripted verifier/reproducer: Person/Rule/Automatic decisions and comments across restarts, session-start comment once per session, Review request/completion/findings/same-session repair/unavailable/cap, Rule and Automatic merges, CI and Review blockers, expected-head race, direct merge evidence, post-merge failure handoff, one thank-you | No |
| `test/metrics.test.ts` | Exact values of every metric on a known history: UTC Monday windows, median/P90, proof rules (unmerged, different head, post-merge failure, revert, reopen), eight-week trend, time to fix and baseline, first-time pass, escaped fixes, flow, people, response times, agreement, automation, fix size, ACU/manual/no cost, liveness, Knowledge, cross-check isolation, cohorts, unavailable never zero | No |
| `test/metrics-evidence.test.ts` | GitHub and Devin evidence readers: target-only reads, reverts, `BASELINE_FILTER`, failures become unavailable, ACUs and Knowledge from Insights; orchestrator last-cycle time | No |
| `test/operator.test.ts` | Operator commands against the fake GitHub server and an offline Devin setup API: setup creates everything then no-ops, only a differing label/note is updated, missing Devin access stops with the web-app setting and no writes, other repositories and organization resources untouched, dry-run setup/mirror write nothing, credential redaction, Knowledge note content; `env-status` nested failure under a succeeded build, unknown logs, presigned downloads without the key; mirror provenance without links or author, neutralised mentions, issue URLs and references, dry-run body equal to the created body, no labels, `--triage`/`--fix`, duplicates; report rows, section order, `No data`/`Unavailable` without sources, every shared figure rendered unchanged, read-only GitHub, no token; `run` starts without credentials | No |
| `test/orchestrator-playbooks.test.ts` | Each route's session gets its own synced Playbook id without the inlined text, or the text exactly once without an id; synced-Playbook resolution; other open bugs in the triage prompt (listed, none, bounded, unlabelled and lost-label bugs from one full listing per cycle, fallback when the listing fails) | No |
| `test/agents-md.test.ts` | `AGENTS.md` stays under 16,384 bytes with its critical rules, without the stale feature-label sentence; the "How the service talks to Devin" page covers every prompt file and Playbook | No |
| `test/replay.test.ts` | Recording provenance (synthetic reason, sanitized recorded source, missing source refused), no credential-shaped values; all eight scenarios reach their documented outcome through the real orchestrator; failed verification visible as `fixing`/`fail` and error as `verifying`/`error` before the passing retry; relayed reply, handoff, merge commit and post-merge proof; no network call (global `fetch` trapped); deterministic rebuild; simulated API data and provenance; replay cohort only; committed `replay/RESULTS.md` equal to the report; persistence across reopen, mismatched store and recording refused, reset; replay store never the live store; operator `replay` commands leave a live store unchanged and print no credentials | No |
| `test/replay-service.test.ts` | Service without credentials serves replay (`simulated: true`), follows `replay next`, stays read-only and keeps its position across a restart; with a credential it reports `mode: "live"` | No |
| `test/docker.test.ts` | `compose.yaml`: one service, loopback-only port, data volume, Docker socket, same-path `VERIFY_WORK_DIR`; `Dockerfile`: separate build stage, Node 22.18+, git and Docker CLI, no build leftovers or credential `ARG`/`ENV`; `.dockerignore`; container-only `0.0.0.0`; `verify-check` with the real verifier and absolute workspaces (real Docker with `VERIFY_DOCKER_IMAGE`) | No |
| `test/tracker-memory.test.ts` | `InMemoryTracker` against the same shared tracker contract, plus copy isolation | No |

Run a selected file:

```sh
node --test test/health.test.ts
node --test test/frontend.test.ts
```

Filter by test name with `--test-name-pattern`, e.g.
`node --test --test-name-pattern="health" test/health.test.ts`.

If `dist/web/index.html` is missing, `test/frontend.test.ts` fails with a message telling you to run
`npm run build`.

## Checking the frontend in a browser

1. Build and start the service:

   ```sh
   npm run build
   npm start
   ```

   The service logs `Bug Smasher listening on http://127.0.0.1:8080`.

2. Open <http://127.0.0.1:8080/> in a browser and confirm:
   - The page title and the heading read **Bug Smasher**.
   - A **No web dashboard yet** notice says Bug Smasher works in GitHub and points to `/api/overview`,
     `/api/metrics` and the dashboard pages in `results/`.
   - The status line reads **Service health endpoint responded: ok**. This is fetched live from
     `/api/health`; if the service is unreachable it shows **Service health endpoint unavailable** instead.
   - The browser devtools console shows no errors.

3. Optionally confirm the health endpoint directly: `curl http://127.0.0.1:8080/api/health`.

To check the development build instead, run `npm start` and `npm run dev:web` in two terminals and open
<http://localhost:5173/>; the same content should appear, with `/api` proxied to the service.

Stop the service with `Ctrl+C`.

## Recording results

When reporting verification (on an issue or pull request), state exactly which commands you ran, their
results, the URL you opened, and what you observed. Do not invent screenshots or results; attach only
screenshots you actually captured.

## Bootstrap verification record

Checked by Devin while preparing the initial scaffold commit, on Linux with Node.js 22.18.0 and npm 10.9.3:

- In a fresh checkout of the committed files, `npm ci`, `npm run typecheck`, `npm run build` and `npm test`
  completed successfully (8 tests in 2 suites passed, 0 failed).
- `node --test test/health.test.ts` ran only the health suite (3 tests passed).
- With `dist/` removed, `node --test test/frontend.test.ts` exited non-zero with the "Run `npm run build`"
  message.
- `npm start` then `curl http://127.0.0.1:8080/api/health` returned HTTP 200 with
  `{"status":"ok","service":"bug-smasher","stage":"scaffold"}`.
- Opened <http://127.0.0.1:8080/> in Chrome (driven through Playwright over CDP): title
  "Bug Smasher (scaffold)", heading "Bug Smasher", the "Unfinished scaffold" notice, the status line
  "Service health endpoint responded: ok", three Lucide icons rendered, and no console errors.
- With `npm start` and `npm run dev:web` running, <http://localhost:5173/> showed the same content and
  `/api/health` was proxied to the service.
