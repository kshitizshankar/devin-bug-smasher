# Metrics

Every figure Bug Smasher shows comes from one calculation, `calculateMetrics` in `src/metrics/calculate.ts`.
`RESULTS.md` (`npm run report`) renders its output unchanged, and the dashboard API (`GET /api/metrics`) serves the
same `MetricsReport`. Nothing is estimated from activity counts, session size classes or Devin's own view of
success.

## Figures

Each figure (`Figure` in `src/metrics/types.ts`) carries:

| Field | Meaning |
| --- | --- |
| `status` | `available` (a value), `no-data` (the sample is empty) or `unavailable` (a source was not read or does not report it) |
| `value`, `display` | Number in `unit` (count, ratio, hours, lines, files, usd, timestamp) and the text every view shows |
| `numerator`, `denominator` | For rates and counts; `null` where they do not apply |
| `samples` | How many observations the value is based on |
| `window` | UTC `start`/`end` and a label |
| `source` | Where the evidence came from, including why a source was not read |
| `note` | Why the figure has no value, or extra context |

An empty sample is `No data` and a missing source is `Unavailable`; neither is ever shown as zero. When no
spend source exists at all the spend figures read `Not reported by Devin on this plan`.

## Time and statistics

- All times are UTC. Weeks start Monday 00:00 UTC; the current week runs to the report time.
- Trends cover the current week and the seven before it (eight weeks). "Recent" is the 30 days before the
  report time and the previous period is the 30 days before that.
- A timestamp belongs to a window when `start <= t < end` (a Monday 00:00:00.000 merge is in the new week).
- Median: sort, take the middle value, or the mean of the two middle values for an even sample.
- 90th percentile: nearest rank, the sorted value at position `ceil(0.9 × n)`.
- Durations are in hours.

## Cohorts

Records arrive in `RecordSet`s tagged with `mode` (`live` or `replay`) and `engine` (`current` or `v1`); the
report reads the main store as live/current, `--replay-store` as replay and `--v1-store` as v1. Records are
grouped by repository, mode and engine. Only the target repository (`GITHUB_REPO`) in live mode with the
current engine forms the live cohort behind the headline numbers; replay runs, v1 runs and any repository
other than the target are reported separately under "Other cohorts". Feature requests are
counted per cohort but never in bug outcomes.

## Proof of a fix

A merged fix is **fixed and proven** only when all of these hold:

1. A pre-merge verification passed at the fix's recorded head SHA.
2. GitHub (when read) reports the pull request merged, at that same head, with the recorded merge commit.
3. Post-merge verification on the merge commit passed.
4. The merge time is known.

A verified but unmerged pull request never counts. A failed post-merge verification, a later merged revert
of the fix pull request, or a reopen of the issue after the merge makes the fix **escaped**.

## Headline numbers (live cohort)

| Figure | Definition |
| --- | --- |
| Fix throughput | Fixes merged in the week that are fixed and proven (numerator) over fixes merged that week (denominator); eight-week trend and the previous week as reference; excluded fixes are listed with the reason |
| Time to fix | Median and P90 hours from the GitHub issue's creation to the merge, for fixes proven in the recent window. Reference: median time to close of closed-as-completed issues carrying every `BASELINE_FILTER` label (comma-separated, case-insensitive), excluding tracked bugs; fewer than 5 is "Insufficient history" |
| First-time pass rate | Per bug and fix session, whether the first pre-merge verification (errors are not attempts) passed; by first attempt time, recent and previous period |
| Escaped-fix rate | Escaped fixes over fixes merged in the window, recent and previous period |

## Flow, adoption and liveness

| Figure | Definition |
| --- | --- |
| Bugs in | Bugs enrolled per week |
| Open bugs by stage | Current open bugs per stage |
| Longest wait | Longest current wait for an answer to Devin, a fix/engineer/close decision, or a merge decision |
| Resolution rate | Bugs enrolled in the window that are fixed and proven or closed |
| Failure rate | Bugs first sent to a fix in the window now with an engineer for verification failure, verification error, session end or a pull request closed unmerged; also per reason |
| Fix size | Smallest, median and largest changed lines and files of fixes merged in the window (GitHub) |
| People | Distinct people who filed (GitHub issue author, bots excluded), answered Devin (last person's comment before the answer), decided (label decisions) or merged (not by a policy), per week and per action |
| Response times | Median time to answer Devin; median time from triage finished to a person's fix/engineer/close decision, and from ready-to-merge to a person's merge |
| Unanswered questions | Open questions older than two days, of all open questions |
| Agreement | Per Devin recommendation, how often the first person's decision after triage matched it |
| Automation | Share of fix, engineer and merge decisions made by the Rule and Automatic policies |
| Liveness | Orchestrator's last finished cycle (only known to the running service), sessions working now, verification runs that errored, sessions with no progress for two hours |
| Knowledge used | Per Knowledge note, sessions whose Session Insights report using it, of sessions with Insights |

## Cost

Cost covers every Bug Smasher session of the target repository (found by the `bug-smasher` tag), successful
or not. Sources, in order:

1. **ACUs**: when Devin reports ACUs for every session and `DEVIN_ACU_PRICE_USD` is set, cost is
   ACUs × price, with per-session, per-route (triage, fix) and per-fixed-bug figures and the largest sessions.
2. **Manual**: otherwise `DEVIN_SPEND_USD` read at `DEVIN_SPEND_READ_AT`, divided by sessions created and
   bugs fixed and proven by that time; no split by phase.
3. **None**: `Not reported by Devin on this plan` (or `Unavailable` when Devin was not read).

The source and read time are always shown. Budget remaining needs `DEVIN_BUDGET_USD`. Sessions stopped at
the cap are those Devin reports as `usage_limit_exceeded` or with ACUs at `MAX_ACU_PER_SESSION`.

## Devin cross-check

Devin's organisation metrics (merged PRs, sessions with merged PRs, sessions created) are shown beside the
local figures for the same window. They never change a local figure.

## Evidence

`src/metrics/evidence.ts` reads GitHub (issues, comments, events, merged fix PRs, reverts cross-referencing
them, `BASELINE_FILTER` history) and Devin (tagged sessions, Session Insights, metrics endpoints). Both only
read. A failed read makes the whole source unavailable with its reason instead of partial figures. The
report redacts configured credentials from its output.
