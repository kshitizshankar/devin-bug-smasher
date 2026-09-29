# Agent instructions for Bug Smasher

## Scope

- Work only on the issue you were assigned. Do not start other features, refactors or clean-ups outside it.
- If you are blocked by missing access, or a requirement would change the issue's scope, ask one focused
  question through the channel your session prompt names, and wait.
- The `devin-builds-feature` label starts a feature session: the service implements the issue's acceptance
  criteria and opens one pull request (see `docs/DEVIN-PROMPTS.md`).

## Change process

- The initial bootstrap commit was the only change pushed directly to `main`.
- **All subsequent changes must go through a pull request.** Devin must never merge a pull request itself,
  and must not push directly to `main`, change repository permissions or configure branch protection.

## Technical choices

- **Service:** TypeScript on Node.js 22.18 or later, run with Node's native type stripping
  (`node src/server/main.ts`) and the Node standard library only. The service has no runtime dependencies;
  `package.json` has no `dependencies`, only `devDependencies`.
  - Type stripping only supports erasable syntax: no `enum`, `namespace`, parameter properties or other
    TypeScript features that emit code (`erasableSyntaxOnly` enforces this). Relative imports must include
    the `.ts` extension, and type-only imports must use `import type`.
- **Frontend:** React, Vite, TypeScript and Lucide icons (`lucide-react`). No component kit. Vite builds
  static assets into `dist/web/`, which the Node service serves.
- **Tests:** Node's built-in test runner (`node:test`). Tests must run without GitHub or Devin credentials.
  Smoke tests start the real service and exercise it over HTTP; do not write tests that only check constants
  or duplicate implementation logic.
- **Dependencies:** npm with the committed `package-lock.json`; install with `npm ci`. Pin exact versions.
- **Persistence (future):** an atomically written JSON file. Do not add a database.

## Verification commands

Run these from the repository root before opening or updating a pull request:

```sh
npm ci
npm run typecheck
npm run build
npm test
```

Run a selected test file with `node --test <file>`, e.g. `node --test test/health.test.ts`.

CI (`.github/workflows/ci.yml`) runs the same commands in the jobs `typecheck` and `build-and-smoke-test`.

For browser checks of the frontend, follow [`docs/TESTING.md`](docs/TESTING.md). Report only what you
actually checked; never invent screenshots or results.

## Repository hygiene

Never commit credentials, `.env` files, runtime logs, generated build output (`dist/`) or `node_modules/`.
These are covered by `.gitignore`.
