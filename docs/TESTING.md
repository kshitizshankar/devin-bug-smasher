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
| `test/operator.test.ts` | Operator commands against the fake GitHub server and an offline Devin setup API: setup creates everything then no-ops, only a differing label/note is updated, missing Devin access stops with the web-app setting and no writes, other repositories and organization resources untouched, dry-run setup/mirror write nothing, credential redaction, Knowledge note content; `env-status` nested failure under a succeeded build, unknown logs, presigned downloads without the key; mirror provenance, no labels, `--triage`/`--fix`, duplicates; report lists only record values; `run` starts without credentials | No |
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

   The service logs `Bug Smasher scaffold listening on http://127.0.0.1:8080`.

2. Open <http://127.0.0.1:8080/> in a browser and confirm:
   - The page title is **Bug Smasher (scaffold)** and the heading reads **Bug Smasher**.
   - An **Unfinished scaffold** notice explains that workflows, integrations, verification, the dashboard
     and persistence are not implemented.
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
