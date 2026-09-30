# Dashboard API

The service serves a read-only JSON API for the dashboard on localhost only. It never writes: every change
goes through GitHub labels and comments, as the workflow requires.

| Endpoint            | Returns                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/health`   | `{"status":"ok","service":"bug-smasher"}`                                  |
| `GET /api/overview` | Headline key figures, counts per overview group, status and person gate, and compact issue records (merged included) |
| `GET /api/metrics`  | The shared `MetricsReport` from `calculateMetrics`, unchanged: every figure with its window, numerator, denominator, samples, source and note |
| `GET /api/settings` | `effectiveSettings`: the effective configuration with `GITHUB_TOKEN` and `DEVIN_API_KEY` reduced to `tokenConfigured` / `apiKeyConfigured` |

Types are in `src/dashboard/types.ts`; sanitized example responses are in `test/fixtures/api/` (regenerate
with `UPDATE_API_FIXTURES=1 node --test test/dashboard-api.test.ts`).

## Live or replay data

Every response except `/api/health` has `data`:

```json
{ "mode": "live", "simulated": false, "replay": null }
```

In replay mode ([`docs/REPLAY.md`](REPLAY.md)) `mode` is `"replay"`, `simulated` is `true` and `replay` gives
the recording (`id`, `title`), `played` and `total` steps, the `simulatedTime`, the `next` step and each
scenario with its `source` (`synthetic` with a reason, or `recorded` and sanitized), expected outcome,
issue and whether it was `reached`. Each overview issue then has `replay` (`scenario`, `source`). Replay
metrics are the replay cohort: live headline figures are `null` there. The data is simulated and must not
be presented as live outcomes.

## Refresh and freshness

After every orchestrator cycle the dashboard re-reads GitHub (open workflow-labelled issues, every tracked
issue and its recorded pull request), the bug store and Devin, derives each record with `presentBug` and
`attention` (`src/model/presentation.ts`) and the figures with `calculateMetrics`. GitHub stays
authoritative: a PR merged or an issue closed on GitHub shows as such on the next refresh, even before the
orchestrator records it. Requests only serve the latest snapshot; they never call a provider.

Every response has `refresh`:

- `state: "current"`: the latest refresh read every source; `lastRefreshAt` is when.
- `state: "stale"`: the latest refresh (`lastAttemptAt`) could not read a source (`problems`); the previous
  snapshot from `lastRefreshAt` is served unchanged.
- `state: "unavailable"`: no snapshot was ever read (for example, polling is off until live settings are
  complete). `overview` and `metrics` are `null`, never empty lists or zero counts.

## Issue records

Each record has `number`, `title`, `url` (the GitHub issue), `status`, `statusLabel`, `group`, `attention`
(`gate`, `waitingOn`, next-action `text`), `recommendation` and `timestamp` (`kind` and `at`). A Devin
recommendation is advice: a `close` recommendation awaiting a person stays `needs-decision`. Provider fields
appear only when the source data has them: `pullRequest` (number, GitHub's URL, `open`/`closed`/`merged`),
`session` (Devin session link), `verification` (latest attempt) and `review` (Devin Review finding links).

## Local only

- `HOST` must be a loopback address (`127.0.0.1`, any `127.x.x.x`, `::1` or `localhost`); anything else
  stops startup. The container image sets `BUG_SMASHER_CONTAINER=true`, which also allows `0.0.0.0` or `::`
  inside the container; Compose publishes the port on the host loopback only.
- Requests whose `Host` header is not a loopback host are refused with `403` (DNS-rebinding protection).
- `POST`, `PUT`, `PATCH`, `DELETE` and every other non-GET/HEAD method on `/api` or `/api/*` return `405`
  with `Allow: GET, HEAD` and change nothing.
