# Bug Smasher

Bug Smasher will investigate reported bugs with Devin, ask people for missing context or decisions, verify
proposed fixes, and track pull requests through merge.

**This repository is currently an unfinished scaffold.** It contains only the project foundation: a small
Node.js service that serves a placeholder React frontend and a health endpoint, plus build, typecheck,
test and CI tooling.

## Not yet implemented

None of the following exists yet:

- **Workflow** – bug intake, triage, investigation, repair and pull request tracking.
- **Integrations** – GitHub, Devin or any other provider integration.
- **Verification** – independent regression verification of proposed fixes.
- **Dashboard** – the frontend is a placeholder page only.
- **Persistence** – no data is stored. Future persistence is planned as an atomically written JSON file.
- **Docker packaging** – there is no Dockerfile or container image.

The `devin-builds-feature` label is reserved for future feature work; it does not currently trigger any
automation.

## Prerequisites

- Node.js **22.18.0 or later** (see `.nvmrc`). The service runs TypeScript directly using Node's native type
  stripping, which is enabled by default from 22.18.0.
- npm (bundled with Node.js).

No GitHub, Devin or other provider credentials are needed to build, run or test the scaffold.

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
| Frontend development server (Vite)   | `npm run dev:web`                 |
| Run all smoke tests                  | `npm test`                        |
| Run a selected test file             | `node --test test/health.test.ts` |

### Build and start

```sh
npm run build   # writes static assets to dist/web/
npm start       # serves dist/web/ and the API on http://127.0.0.1:3000
```

Then open <http://127.0.0.1:3000/> for the placeholder UI, or check health:

```sh
curl http://127.0.0.1:3000/api/health
# {"status":"ok","service":"bug-smasher","stage":"scaffold"}
```

Environment variables read by the service:

| Variable     | Default           | Purpose                                     |
| ------------ | ----------------- | ------------------------------------------- |
| `PORT`       | `3000`            | Port to listen on (`0` picks a free port)   |
| `HOST`       | `127.0.0.1`       | Interface to bind                           |
| `STATIC_DIR` | `<repo>/dist/web` | Directory of built frontend assets to serve |

### Frontend development

Run the service and the Vite dev server in two terminals:

```sh
npm start         # terminal 1: API on http://127.0.0.1:3000
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
web/             React + Vite frontend source
test/            Smoke tests (node:test)
dist/web/        Generated frontend build output (git-ignored)
.github/         GitHub Actions CI
```

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, with no provider credentials. Jobs:

- `typecheck` – `npm ci`, `npm run typecheck`
- `build-and-smoke-test` – `npm ci`, `npm run build`, `npm test`
