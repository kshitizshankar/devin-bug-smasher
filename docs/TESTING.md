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

   The service logs `Bug Smasher scaffold listening on http://127.0.0.1:3000`.

2. Open <http://127.0.0.1:3000/> in a browser and confirm:
   - The page title is **Bug Smasher (scaffold)** and the heading reads **Bug Smasher**.
   - An **Unfinished scaffold** notice explains that workflows, integrations, verification, the dashboard
     and persistence are not implemented.
   - The status line reads **Service health endpoint responded: ok**. This is fetched live from
     `/api/health`; if the service is unreachable it shows **Service health endpoint unavailable** instead.
   - The browser devtools console shows no errors.

3. Optionally confirm the health endpoint directly: `curl http://127.0.0.1:3000/api/health`.

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
- `npm start` then `curl http://127.0.0.1:3000/api/health` returned HTTP 200 with
  `{"status":"ok","service":"bug-smasher","stage":"scaffold"}`.
- Opened <http://127.0.0.1:3000/> in Chrome (driven through Playwright over CDP): title
  "Bug Smasher (scaffold)", heading "Bug Smasher", the "Unfinished scaffold" notice, the status line
  "Service health endpoint responded: ok", three Lucide icons rendered, and no console errors.
- With `npm start` and `npm run dev:web` running, <http://localhost:5173/> showed the same content and
  `/api/health` was proxied to the service.
