# Offline replay

Replay runs Bug Smasher end to end without GitHub, Devin or any paid provider. It drives the real
`Orchestrator` and state machine against stand-ins: `InMemoryTracker` for GitHub, `OfflineDevin` (reached
through the normal `DevinClient` with the offline fetch transport) for Devin, and `RecordedVerifier` for the
verification results written in the recording. Time is the recording's simulated clock.

**Replay data is simulated.** Every API response and report produced from it says so, and replay records
never count as live outcomes.

## When it runs

`npm start` (and the container) serves replay when both `GITHUB_TOKEN` and `DEVIN_API_KEY` are unset. With
either credential set, the service runs in live mode exactly as before (polling when live settings are
complete). Replay never falls back to live data and live mode never serves replay data.

## Commands

```sh
npm run replay -- status             # position, next step, each scenario's source, expected and current state
npm run replay -- next [N]           # play the next step (or N steps) and save it
npm run replay -- all                # play every remaining step
npm run replay -- reset              # back to step 0 (removes only the replay state and store)
npm run replay -- report [--full] [--out FILE]  # replay results; --full plays the whole recording in memory
```

In Docker Compose: `docker compose exec bug-smasher npm run replay -- next`. A running service picks up the
new position within a second; the dashboard stays read-only.

## Storage and isolation

| Path | Contents |
| --- | --- |
| `REPLAY_DIR` (default `data/replay/`, `/app/data/replay` in the container) | `bugs.json` (replay store), `state.json` (recording id, digest, steps played), `replay.lock` |
| `data/bugs.json` | Live store; replay never opens it, and a `REPLAY_DIR` that would resolve to it is refused |

Each command rebuilds the stand-in world to the saved step, checks that the saved store matches it exactly
(a store from another recording or edited by hand is refused), then plays further and replaces the files
atomically. Positions survive restarts of the service or container. Metrics come from the shared
`calculateMetrics` with the records in the `replay` cohort: the live headline figures stay `null`.

## Recording

`replay/recording.json` (schema in `src/replay/recording.ts`) lists scenarios and steps. Each step applies
GitHub and Devin events to the stand-ins, runs orchestrator cycles and checks the documented state. Each
scenario has a `source`:

- `{"kind": "recorded", "recording": "<source>", "sanitized": true}` for events copied from a sanitized live
  run; unsanitized recordings are refused;
- `{"kind": "synthetic", "reason": "..."}` for hand-written fixtures.

The checked-in recording is **synthetic**: no sanitized live recording exists yet; the live demonstration is
issue #15. It covers eight scenario families:

| Scenario | Path |
| --- | --- |
| `clarification` | Devin asks, the reporter replies, the reply is relayed to the same session, a person closes the issue |
| `decision` | Triage recommends a fix; the issue waits for a person (`needs-decision`) |
| `repair` | A person approves repair; the same session opens a PR that passes verification |
| `failed-verification` | The proof fails (`fixing`, verification `fail`), the same session is told, the retry passes |
| `verification-error` | Infrastructure error (`verifying`, verification `error`), then the retry passes |
| `handoff` | The repair session ends without a PR; the issue goes to an engineer |
| `pr-checks-passed` | Verification, CI and Devin Review pass; waiting for a person to merge |
| `merged-with-proof` | A person merges; post-merge verification proves the merge commit |

[`replay/RESULTS.md`](../replay/RESULTS.md) is the full replay's report
(`npm run replay -- report --full --out replay/RESULTS.md`); `test/replay.test.ts` fails if it drifts.

## Limitations

- Replay proves the workflow logic, not provider behaviour: GitHub and Devin responses come from stand-ins.
- Verification results are scripted; `npm run verify-check` exercises the real verifier and Docker runtime.
- One recording at a time; changing `replay/recording.json` requires `replay reset`.
