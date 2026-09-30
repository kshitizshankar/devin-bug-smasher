# Bug Smasher

Bug Smasher will investigate reported bugs with Devin, ask people for missing context or decisions, verify
proposed fixes, and track pull requests through merge.

**This repository is currently an unfinished scaffold.** It contains a small Node.js service that serves a
placeholder React frontend, a health endpoint and a read-only dashboard API, the workflow orchestrator (which
polls GitHub and drives Devin sessions only when live GitHub and Devin settings are complete), an offline
replay, Docker packaging, plus build, typecheck, test and CI tooling.

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
- Live results: pending. The live demonstration against a real target repository is issue #15; no live
  `RESULTS.md` exists yet and manual acceptance of a live run is still pending.

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
- **Live results** – no live run has been recorded yet (issue #15).

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
