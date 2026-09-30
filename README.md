# Bug Smasher

Bug Smasher hands bugs to Devin from GitHub and proves the fixes. A person adds a label to an issue; the
service starts a Devin session that investigates the bug and posts its findings with a recommendation: fix it,
hand it to an engineer, or close it. When a person approves a fix, Devin opens a pull request with a test, and
Bug Smasher's own verifier runs that test in the project's test image: it must fail on the code before the fix
and pass on the fix. People make every decision and every merge on GitHub; the service tracks each bug from
label to merge and reports what happened.

It has run live on [kshitizshankar/superset](https://github.com/kshitizshankar/superset), a fork of
apache/superset, on open upstream bugs ([results](results/superset-run.html)). Devin also wrote Bug Smasher
itself; the later changes were dispatched by Bug Smasher on its own repository
([results](results/building-bug-smasher.html)).

The repository contains the Node.js service (orchestrator, GitHub and Devin adapters, verifier, decision and
merge policies, metrics and a read-only API), an offline replay that runs without credentials, Docker
packaging, and build, typecheck, test and CI tooling. The web dashboard is still a placeholder: see
[Not yet implemented](#not-yet-implemented) and [Known limitations](#known-limitations).

## Quick start without credentials

```sh
docker compose up --build -d                              # one service on http://127.0.0.1:8080
docker compose exec bug-smasher npm run replay -- all     # play the offline replay
curl http://127.0.0.1:8080/api/overview                   # "data": {"mode": "replay", "simulated": true, ...}
```

or without Docker: `npm ci && npm run build && npm start`, then `npm run replay -- next` in another terminal.
With neither `GITHUB_TOKEN` nor `DEVIN_API_KEY` set, the service serves the offline replay: the real
orchestrator against stand-in GitHub and Devin providers, with simulated, clearly labelled data and a store
separate from live data. See [`docs/REPLAY.md`](docs/REPLAY.md) and [`docs/DOCKER.md`](docs/DOCKER.md).

## Evidence

- [`replay/RESULTS.md`](replay/RESULTS.md): results of the full offline replay. **Simulated**, from a
  synthetic recording; not live outcomes.
- [`results/`](results/README.md): live results. [`superset-run.html`](results/superset-run.html) is the run on
  [kshitizshankar/superset](https://github.com/kshitizshankar/superset) (five upstream bugs: four fixed and
  proven, one handed to an engineer); [`building-bug-smasher.html`](results/building-bug-smasher.html) is how
  Devin built Bug Smasher itself.

## Architecture

```
GitHub issues/labels/comments ──> GitHubTracker ─┐
                                                 ├─> Orchestrator (src/orchestrator) ─> BugStore (data/bugs.json)
Devin API v3 ───────────────────> DevinClient ───┘        │                                   │
                                                          ├─> CheckedVerifier ─> Docker (sibling containers)
                                                          └─> policies        Dashboard (read-only API + web)
Replay: InMemoryTracker + OfflineDevin + RecordedVerifier ─> same Orchestrator ─> data/replay/bugs.json
```

People act only on GitHub (labels, comments, merges); the dashboard and API never write.

## Who posts what

- **Devin writes every comment**, from its own GitHub account and in its own voice: the picking-up
  comment on the issue (once per session, with its session link), the triage findings, its questions,
  and the Ready for review comment on its pull request.
- **The service posts no comments.** It adds and removes labels, publishes commit statuses
  (`bug-smasher/ready`, `bug-smasher/verification`) and keeps the dashboard. Anything Devin needs to
  know — verification flags, review blockers, a refused merge — goes to its session as a message.

One personal GitHub token is all an operator needs: no second account or GitHub App. A person's labels
and replies still count as theirs even when the token belongs to them — the service tells its own label
changes apart by what it did, not by the account, and a comment by Devin's bot account is never relayed
back to Devin.

## Verification

Fixes are verified independently in Docker against exact base and head commits; see
[`docs/VERIFICATION.md`](docs/VERIFICATION.md). Without `VERIFY_IMAGE`, nothing is reported as verified.

## Decision and merge policies

`DECISION` and `MERGE` choose who decides: `person` (the default: nothing happens automatically), `rule`
(narrow, evidence-backed conditions such as `DECISION_RULE_CLASSES` and `MERGE_MAX_LINES`) or `auto`.
Every automatic decision records its checks and evidence, merges only the exact verified head, and never
closes an issue. See [`docs/ORCHESTRATION.md`](docs/ORCHESTRATION.md#decision-and-merge-policies).

## Operator commands

`npm run setup` configures the target repository's labels and bug issue form on GitHub and its route Playbooks,
Knowledge notes, indexing, blueprint and build on Devin, changing only what differs; `env-status`, `mirror`
and `report` inspect builds, copy issues in and write `RESULTS.md`; `replay` plays the offline replay and
`verify-check` proves a throwaway fixture with the real verifier and Docker runtime. Every command that writes to GitHub or
Devin supports `--dry-run`; `report` is the exception, as it only writes a local `RESULTS.md`. See
[`docs/OPERATOR.md`](docs/OPERATOR.md).

## Not yet implemented

None of the following exists yet:

- **Dashboard** – the frontend is a placeholder page only.

## Known limitations

Findings from Devin Review, our own reviews and the live runs that were deferred rather than fixed before
submission. Each is an open issue labelled `deferred`, with what happens and what is expected.

<!-- known-limitations:start (regenerate: gh issue list --label deferred --state open --json number,title,url) -->
- [#21](https://github.com/kshitizshankar/devin-bug-smasher/issues/21) Service comment marker can be forged to hide a commenter's own reply
- [#22](https://github.com/kshitizshankar/devin-bug-smasher/issues/22) Repeated identical repair question is not re-posted after it was answered
- [#25](https://github.com/kshitizshankar/devin-bug-smasher/issues/25) Post-merge verification rejects working rebase merges
- [#26](https://github.com/kshitizshankar/devin-bug-smasher/issues/26) Verification does not prove the selected test files actually ran
- [#27](https://github.com/kshitizshankar/devin-bug-smasher/issues/27) Test containers keep writable host mounts
- [#28](https://github.com/kshitizshankar/devin-bug-smasher/issues/28) Decide whether fix PRs should close the issue on merge
- [#30](https://github.com/kshitizshankar/devin-bug-smasher/issues/30) Decision-point comments end with an explicit Ask
- [#49](https://github.com/kshitizshankar/devin-bug-smasher/issues/49) `report` has no dry-run or print-to-screen option
- [#50](https://github.com/kshitizshankar/devin-bug-smasher/issues/50) A build and a blueprint update in the same second can leave the update unbuilt
- [#52](https://github.com/kshitizshankar/devin-bug-smasher/issues/52) Spend and Knowledge figures show Unavailable once more than 2,000 sessions are tagged
- [#53](https://github.com/kshitizshankar/devin-bug-smasher/issues/53) A merge by a person is credited to the policy if a policy merge was requested earlier
- [#58](https://github.com/kshitizshankar/devin-bug-smasher/issues/58) A test that fails to load on the base commit is retried and handed to an engineer, not sent back to Devin
- [#59](https://github.com/kshitizshankar/devin-bug-smasher/issues/59) The Rule decision cannot reproduce a test Devin adds to an existing test file
- [#60](https://github.com/kshitizshankar/devin-bug-smasher/issues/60) A question Devin asks during a repair is not shown as waiting for a reply
- [#61](https://github.com/kshitizshankar/devin-bug-smasher/issues/61) Person gates are shown for decisions and merges under automatic policies without policy context
- [#62](https://github.com/kshitizshankar/devin-bug-smasher/issues/62) The API accepts a Host header from any loopback port
- [#65](https://github.com/kshitizshankar/devin-bug-smasher/issues/65) mirror: raw HTML links, indented code blocks and titles are not neutralised
- [#71](https://github.com/kshitizshankar/devin-bug-smasher/issues/71) The container's API is reachable from other containers on the Compose network
- [#72](https://github.com/kshitizshankar/devin-bug-smasher/issues/72) The Docker socket is mounted by default, even for replay-only runs
- [#73](https://github.com/kshitizshankar/devin-bug-smasher/issues/73) Concurrent replay commands in one process can lose their lock
- [#74](https://github.com/kshitizshankar/devin-bug-smasher/issues/74) A finished replay fails on a read-only directory instead of reporting completion
- [#76](https://github.com/kshitizshankar/devin-bug-smasher/issues/76) Fields the service posts on GitHub are not checked for secrets before posting
- [#77](https://github.com/kshitizshankar/devin-bug-smasher/issues/77) The duplicate list pages through closed issues on every triage cycle
- [#80](https://github.com/kshitizshankar/devin-bug-smasher/issues/80) A failing queued effect delays stopping a fix when its work labels are removed
- [#81](https://github.com/kshitizshankar/devin-bug-smasher/issues/81) The archive-by-hand warning stays on a bug after the session has been archived
- [#84](https://github.com/kshitizshankar/devin-bug-smasher/issues/84) A waiting investigation approved in Devin is recorded late when all session slots are taken
- [#87](https://github.com/kshitizshankar/devin-bug-smasher/issues/87) Reading a merged PR's merge commit fails for PRs with more than 5,000 events
- [#89](https://github.com/kshitizshankar/devin-bug-smasher/issues/89) Follow-ups to a suspended session can stall a bug, and verifier-budget handoff is inconsistent (left open on #83)
- [#96](https://github.com/kshitizshankar/devin-bug-smasher/issues/96) No test covers the serviceLogins startup wiring in main.ts
- [#102](https://github.com/kshitizshankar/devin-bug-smasher/issues/102) The verifier counts a renamed test as a removed test
- [#103](https://github.com/kshitizshankar/devin-bug-smasher/issues/103) On a fork, Devin's comments link upstream issues, which adds 'mentioned this' entries upstream
- [#104](https://github.com/kshitizshankar/devin-bug-smasher/issues/104) Polling re-reads every bug and pull request each minute and can use up the GitHub API limit
<!-- known-limitations:end -->

## Prerequisites

- Node.js **22.18.0 or later** (see `.nvmrc`). The service runs TypeScript directly using Node's native type
  stripping, which is enabled by default from 22.18.0.
- npm (bundled with Node.js).

No GitHub, Devin or other provider credentials are needed to build, run or test the scaffold. Docker (with
Compose v2) is needed only for the container and for verification. Live mode needs a GitHub token and a Devin
service-user API key with the permissions in [`docs/OPERATOR.md`](docs/OPERATOR.md#permissions).

## Installation

```sh
npm ci
```

## Commands

| Task                                 | Command                           |
| ------------------------------------ | --------------------------------- |
| Install dependencies from lockfile   | `npm ci`                          |
| Typecheck service, tests and web app | `npm run typecheck`               |
| Production build of the frontend     | `npm run build`                   |
| Start the service                    | `npm start`                       |
| Offline replay (status, next, all, reset, report) | `npm run replay -- <command>` ([`docs/REPLAY.md`](docs/REPLAY.md)) |
| Verifier and Docker check            | `npm run verify-check -- --image node:22.18.0-bookworm-slim` |
| Run in Docker                        | `docker compose up --build -d` ([`docs/DOCKER.md`](docs/DOCKER.md)) |
| Operator commands (setup, env-status, mirror, report) | see [`docs/OPERATOR.md`](docs/OPERATOR.md) |
| Frontend development server (Vite)   | `npm run dev:web`                 |
| Run all smoke tests                  | `npm test`                        |
| Run a selected test file             | `node --test test/health.test.ts` |

### Build and start

```sh
npm run build   # writes static assets to dist/web/
npm start       # serves dist/web/ and the API on http://127.0.0.1:8080
```

Then open <http://127.0.0.1:8080/> for the placeholder UI, or check health:

```sh
curl http://127.0.0.1:8080/api/health
# {"status":"ok","service":"bug-smasher","stage":"scaffold"}
```

The read-only dashboard API (`/api/overview`, `/api/metrics`, `/api/settings`) is described in
[`docs/API.md`](docs/API.md).

Environment variables used by the scaffold service (all settings, including the future live-mode ones, are
listed in [`docs/MODEL.md`](docs/MODEL.md#settings) and `.env.example`; invalid values stop startup with
a clear error):

| Variable     | Default           | Purpose                                     |
| ------------ | ----------------- | ------------------------------------------- |
| `PORT`       | `8080`            | Port to listen on (`0` picks a free port)   |
| `HOST`       | `127.0.0.1`       | Loopback interface to bind (non-loopback values are refused, except `0.0.0.0`/`::` with `BUG_SMASHER_CONTAINER=true`) |
| `STATIC_DIR` | `<repo>/dist/web` | Directory of built frontend assets to serve |
| `REPLAY_DIR` | `<repo>/data/replay` | Replay state and store (never the live `data/bugs.json`) |
| `BUG_SMASHER_CONTAINER` | unset     | Set by the image; allows the in-container `0.0.0.0` listener |
| `BUG_SMASHER_PORT` | `8080`      | Compose only: host loopback port to publish |

### Frontend development

Run the service and the Vite dev server in two terminals:

```sh
npm start         # terminal 1: API on http://127.0.0.1:8080
npm run dev:web   # terminal 2: Vite on http://localhost:5173, proxies /api to the service
```

If the service uses a non-default port, start Vite with the same `PORT` value so the proxy targets it.

### Tests

Tests use Node's built-in test runner and start the real service entrypoint on an OS-assigned free local
port. The frontend smoke test requires built assets, so build first:

```sh
npm run build
npm test
```

Run a single test file with `node --test <file>`, for example:

```sh
node --test test/health.test.ts     # health endpoint only; does not need a build
node --test test/frontend.test.ts   # built asset serving; run `npm run build` first
```

See [`docs/TESTING.md`](docs/TESTING.md) for testing and browser-check instructions.

## Project layout

```
src/server/      Node.js service (TypeScript, standard library only)
src/model/       Shared bug model: types, labels, transitions, presentation, validation
src/store/       Atomic JSON bug store (data/bugs.json)
src/config/      Typed environment settings
src/devin/       Devin API v3 adapter and offline stand-in (see docs/DEVIN.md)
src/tracker/     GitHub tracker interface, REST adapter and in-memory stand-in
src/orchestrator/ Polling workflow: dispatch, questions, repair, prompts (see docs/ORCHESTRATION.md)
src/operator/    Operator commands: run, setup, env-status, mirror, report, replay, verify-check (see docs/OPERATOR.md)
src/replay/      Offline replay: recording schema, stand-in world, replay store and service (see docs/REPLAY.md)
src/verify/      Independent verifier and Docker runtime (see docs/VERIFICATION.md)
src/metrics/     Shared metrics calculation and evidence readers (see docs/METRICS.md)
src/dashboard/   Read-only dashboard API projection (see docs/API.md)
replay/          Replay recording and its RESULTS.md (simulated)
Dockerfile, compose.yaml  One image, one service (see docs/DOCKER.md)
prompts/         Repository-owned Devin prompt templates and route Playbooks (see docs/DEVIN-PROMPTS.md)
web/             React + Vite frontend source
test/            Smoke and behaviour tests (node:test)
dist/web/        Generated frontend build output (git-ignored)
.github/         GitHub Actions CI
```

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, with no provider credentials. Jobs:

- `typecheck` – `npm ci`, `npm run typecheck`
- `build-and-smoke-test` – `npm ci`, `npm run build`, `npm test`
