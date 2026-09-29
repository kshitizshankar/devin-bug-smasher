# Bug Smasher replay results

**Simulated data.** Recording `bug-smasher-replay-v1` (Bug Smasher offline replay: eight workflow scenarios), 33 of 33 steps played through the real orchestrator against stand-in GitHub and Devin providers. No live repository, Devin session or paid provider was contacted, and none of these figures are live outcomes.

| Scenario | Issue | Source | Expected | Reached |
| --- | --- | --- | --- | --- |
| Devin asks the reporter a question; the reply is relayed and a person closes the issue | bug-smasher-replay/widgets#1 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | closed / closed | yes |
| Triage recommends a fix and the issue waits for a person to decide | bug-smasher-replay/widgets#2 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | triaged / needs-decision | yes |
| A person approves repair after triage; the same session opens a verified PR | bug-smasher-replay/widgets#3 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | ready-to-merge / ready-to-merge | yes |
| Verification fails, the fix goes back to the same session, and the retry passes | bug-smasher-replay/widgets#5 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | ready-to-merge / ready-to-merge | yes |
| Verification errors on infrastructure, then the retry passes | bug-smasher-replay/widgets#7 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | ready-to-merge / ready-to-merge | yes |
| The repair session ends without a pull request and the issue is handed to an engineer | bug-smasher-replay/widgets#9 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | with-engineer / needs-engineer | yes |
| A pull request passes verification, CI and Devin Review and waits for a person to merge | bug-smasher-replay/widgets#10 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | ready-to-merge / ready-to-merge | yes |
| A person merges the fix on GitHub and post-merge verification proves the merge commit | bug-smasher-replay/widgets#12 | synthetic: No sanitized recording of a live run exists yet; the live demonstration is issue #15. Events were written by hand to exercise this path. | merged / merged | yes |

Written by `report` from the bug store (replay of bug-smasher-replay-v1, step 33 of 33) at 2026-03-03T03:43:06.000Z. Times are UTC; weeks start on Monday 00:00. Every figure comes from the shared metrics calculation the dashboard API reads.

Sources: GitHub bug-smasher-replay/widgets, read 2026-03-03T03:43:06.000Z. Devin API, read 2026-03-03T03:43:06.000Z. running orchestrator.

## Bugs

| Issue | Cohort | Kind | Path | Decision | Pull request | Verification | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bug-smasher-replay/widgets#1 | bug-smasher-replay/widgets (replay) | bug | queued → triaging → needs-input → triaging → triaged → closed | none yet (Devin recommends close) | none | none | closed |
| bug-smasher-replay/widgets#10 | bug-smasher-replay/widgets (replay) | bug | queued → fixing → verifying → ready-to-merge | none | https://github.com/bug-smasher-replay/widgets/pull/11 | pre-merge pass at d1d1d1d | open (ready-to-merge) |
| bug-smasher-replay/widgets#12 | bug-smasher-replay/widgets (replay) | bug | queued → fixing → verifying → ready-to-merge → merged | none | https://github.com/bug-smasher-replay/widgets/pull/13 | pre-merge pass at e1e1e1e; post-merge pass at e9e9e9e | fixed and proven |
| bug-smasher-replay/widgets#2 | bug-smasher-replay/widgets (replay) | bug | queued → triaging → triaged | none yet (Devin recommends devin_fix) | none | none | open (triaged) |
| bug-smasher-replay/widgets#3 | bug-smasher-replay/widgets (replay) | bug | queued → triaging → triaged → fixing → verifying → ready-to-merge | fix by github:maintainer | https://github.com/bug-smasher-replay/widgets/pull/4 | pre-merge pass at a1a1a1a | open (ready-to-merge) |
| bug-smasher-replay/widgets#5 | bug-smasher-replay/widgets (replay) | bug | queued → fixing → verifying → fixing → verifying → ready-to-merge | none | https://github.com/bug-smasher-replay/widgets/pull/6 | pre-merge pass at b2b2b2b | open (ready-to-merge) |
| bug-smasher-replay/widgets#7 | bug-smasher-replay/widgets (replay) | bug | queued → fixing → verifying → ready-to-merge | none | https://github.com/bug-smasher-replay/widgets/pull/8 | pre-merge pass at c1c1c1c | open (ready-to-merge) |
| bug-smasher-replay/widgets#9 | bug-smasher-replay/widgets (replay) | bug | queued → fixing → with-engineer | none | none | none | with engineer (session-ended) |

## Headline numbers

No live records for bug-smasher-replay/widgets, so there are no live outcomes yet.

### Liveness

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orchestrator's last cycle | 2026-03-03T03:43:05.000Z |  |  |  | 1 | now (to 2026-03-03T03:43:06.000Z) | running orchestrator |  |
| Sessions working now | No data |  |  |  | 0 | now (to 2026-03-03T03:43:06.000Z) | bug store records (session state last observed by the orchestrator) | No Bug Smasher sessions |
| Verification runs that errored | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (verification attempts) | No verification ran in the window |
| Sessions with no progress for two hours | No data |  |  |  | 0 | now (to 2026-03-03T03:43:06.000Z) | bug store records and Devin session list (Bug Smasher tags) (last update) | No session is open |
| Knowledge used | No data |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | Devin Session Insights | No session has Session Insights |

## Spend

Source: Not reported by Devin on this plan

Read at: not read

Scope: Every Bug Smasher session for bug-smasher-replay/widgets, successful or not

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Total spend | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Budget remaining | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Cost per fixed bug | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Cost per session | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Cost per triage session | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Cost per fix session | Not reported by Devin on this plan |  |  |  | 0 | to date (to 2026-03-03T03:43:06.000Z) | none | Devin reports no ACUs for 8 of 8 sessions and no manual reading (DEVIN_SPEND_USD, DEVIN_SPEND_READ_AT) is configured |
| Sessions stopped at the cap | 0 |  | 0 | 8 | 8 | to date (to 2026-03-03T03:43:06.000Z) | Devin session list (Bug Smasher tags) (status detail usage_limit_exceeded, or reported ACUs at MAX_ACU_PER_SESSION) |  |

## Devin cross-check

Devin's organisation-wide figures, shown only as a cross-check; they never change the local counts.

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Devin: pull requests merged | Unavailable |  |  |  | 0 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | Devin's organisation metrics endpoints | Devin get-pr-metrics failed: forbidden (HTTP 403): Forbidden: Metrics are not available offline |
| Local: bug fixes merged | No data |  |  |  | 0 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store merge records and independent verification attempts | No bug fix was merged in the window |
| Devin: sessions with merged pull requests | Unavailable |  |  |  | 0 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | Devin's organisation metrics endpoints | Devin get-session-metrics failed: forbidden (HTTP 403): Forbidden: Metrics are not available offline |
| Local: bugs fixed and proven | No data |  |  |  | 0 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store merge records and independent verification attempts | No bug fix was merged in the window |
| Devin: sessions created | Unavailable |  |  |  | 0 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | Devin's organisation metrics endpoints | Devin get-session-metrics failed: forbidden (HTTP 403): Forbidden: Metrics are not available offline |
| Local: Bug Smasher sessions | 8 |  | 8 | 8 | 8 | cross-check window (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | Devin session list (Bug Smasher tags) |  |

## Other cohorts

Reported separately; none of these count in live outcomes.

### bug-smasher-replay/widgets (replay)

8 bugs, 0 feature requests.

#### Four keys

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fix throughput (bugs fixed and proven this week) | 1 | Previous week: No data (samples 0; source: bug store merge records and independent verification attempts, checked against GitHub issues and pull requests) | 1 | 1 | 1 | week of 2026-03-02 (to date) (2026-03-02T00:00:00.000Z to 2026-03-03T03:43:06.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests |  |
| Time to fix (median) | 3.4 h | Repository median for comparable closed issues: Insufficient history: BASELINE_FILTER is not set (samples 0; source: GitHub issues and pull requests closed issues matching BASELINE_FILTER) |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue filed) and bug store merge records and independent verification attempts (merge) |  |
| Time to fix (90th percentile) | 3.4 h |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue filed) and bug store merge records and independent verification attempts (merge) |  |
| First-time pass rate | 80% (4 of 5) | Previous 30 days: No data (samples 0; source: bug store records (pre-merge verification attempts per fix session; errors are not attempts)) | 4 | 5 | 5 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (pre-merge verification attempts per fix session; errors are not attempts) |  |
| Escaped-fix rate | 0% (0 of 1) | Previous 30 days: No data (samples 0; source: bug store merge records and independent verification attempts, GitHub issues and pull requests (reverts, reopens)) | 0 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store merge records and independent verification attempts, GitHub issues and pull requests (reverts, reopens) |  |

#### Fix throughput, eight weeks

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-01-12 (2026-01-12T00:00:00.000Z to 2026-01-19T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-01-19 (2026-01-19T00:00:00.000Z to 2026-01-26T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-01-26 (2026-01-26T00:00:00.000Z to 2026-02-02T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-02-02 (2026-02-02T00:00:00.000Z to 2026-02-09T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-02-09 (2026-02-09T00:00:00.000Z to 2026-02-16T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-02-16 (2026-02-16T00:00:00.000Z to 2026-02-23T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | No data |  |  |  | 0 | week of 2026-02-23 (2026-02-23T00:00:00.000Z to 2026-03-02T00:00:00.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests | No bug fix was merged in this week |
| Bugs fixed and proven | 1 |  | 1 | 1 | 1 | week of 2026-03-02 (to date) (2026-03-02T00:00:00.000Z to 2026-03-03T03:43:06.000Z) | bug store merge records and independent verification attempts, checked against GitHub issues and pull requests |  |

#### Flow and health

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bugs in | No data |  |  |  | 0 | week of 2026-01-12 (2026-01-12T00:00:00.000Z to 2026-01-19T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-01-19 (2026-01-19T00:00:00.000Z to 2026-01-26T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-01-26 (2026-01-26T00:00:00.000Z to 2026-02-02T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-02-02 (2026-02-02T00:00:00.000Z to 2026-02-09T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-02-09 (2026-02-09T00:00:00.000Z to 2026-02-16T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-02-16 (2026-02-16T00:00:00.000Z to 2026-02-23T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | No data |  |  |  | 0 | week of 2026-02-23 (2026-02-23T00:00:00.000Z to 2026-03-02T00:00:00.000Z) | bug store records (enrolment time) | No bug was sent on in this week |
| Bugs in | 8 |  | 8 | 8 | 8 | week of 2026-03-02 (to date) (2026-03-02T00:00:00.000Z to 2026-03-03T03:43:06.000Z) | bug store records (enrolment time) |  |
| Open bugs: queued | 0 |  | 0 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: triaging | 0 |  | 0 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: needs-input | 0 |  | 0 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: triaged | 1 |  | 1 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: fixing | 0 |  | 0 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: verifying | 0 |  | 0 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: ready-to-merge | 4 |  | 4 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Open bugs: with-engineer | 1 |  | 1 | 6 | 6 | now (to 2026-03-03T03:43:06.000Z) | bug store records |  |
| Longest wait for answer to Devin | No data |  |  |  | 0 | now (to 2026-03-03T03:43:06.000Z) | bug store records (stage history) | No bug is waiting for answer to Devin |
| Longest wait for fix, engineer or close decision | 14.9 h |  |  |  | 1 | now (to 2026-03-03T03:43:06.000Z) | bug store records (stage history) |  |
| Longest wait for merge decision | 12.4 h |  |  |  | 4 | now (to 2026-03-03T03:43:06.000Z) | bug store records (stage history) |  |
| Resolution rate | 25% (2 of 8) |  | 2 | 8 | 8 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (enrolment time, fixed and proven or closed) |  |
| Failure rate | 16.7% (1 of 6) |  | 1 | 6 | 6 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (first sent to a fix in the window; current handoff reason) |  |
| Failure rate: verification failed twice | 0% (0 of 6) |  | 0 | 6 | 6 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (first sent to a fix in the window; current handoff reason) |  |
| Failure rate: verification could not run | 0% (0 of 6) |  | 0 | 6 | 6 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (first sent to a fix in the window; current handoff reason) |  |
| Failure rate: the session ended | 16.7% (1 of 6) |  | 1 | 6 | 6 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (first sent to a fix in the window; current handoff reason) |  |
| Failure rate: the pull request was closed unmerged | 0% (0 of 6) |  | 0 | 6 | 6 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (first sent to a fix in the window; current handoff reason) |  |
| Fix size in lines (smallest) | 8 lines |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |
| Fix size in lines (median) | 8 lines |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |
| Fix size in lines (largest) | 8 lines |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |
| Fix size in files (smallest) | 1 files |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |
| Fix size in files (median) | 1 files |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |
| Fix size in files (largest) | 1 files |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (pull request additions, deletions and changed files) |  |

#### Adoption and trust

| Figure | Value | Reference | Numerator | Denominator | Samples | Window | Source | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| People involved | No data |  |  |  | 0 | week of 2026-01-12 (2026-01-12T00:00:00.000Z to 2026-01-19T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-01-19 (2026-01-19T00:00:00.000Z to 2026-01-26T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-01-26 (2026-01-26T00:00:00.000Z to 2026-02-02T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-02-02 (2026-02-02T00:00:00.000Z to 2026-02-09T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-02-09 (2026-02-09T00:00:00.000Z to 2026-02-16T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-02-16 (2026-02-16T00:00:00.000Z to 2026-02-23T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | No data |  |  |  | 0 | week of 2026-02-23 (2026-02-23T00:00:00.000Z to 2026-03-02T00:00:00.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) | No person acted in the window |
| People involved | 2 |  | 2 | 11 | 11 | week of 2026-03-02 (to date) (2026-03-02T00:00:00.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) |  |
| People who filed a bug | 2 |  | 2 | 8 | 8 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) |  |
| People who answered Devin | 1 |  | 1 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) |  |
| People who made a decision | 1 |  | 1 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) |  |
| People who merged a fix | 1 |  | 1 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | GitHub issues and pull requests (issue authors, replies to Devin) and bug store records (label decisions, merges) |  |
| Median time to answer Devin | 0.8 h |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (question asked and answered times) |  |
| Median time to decide fix | 0.4 h |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (investigation finished until the decision) |  |
| Median time to decide engineer | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (investigation finished until the decision) | No person decided engineer in the window |
| Median time to decide close | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (investigation finished until the decision) | No person decided close in the window |
| Median time to decide merge | 2.3 h |  |  |  | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (ready to merge until merged) |  |
| Questions unanswered after two days | No data |  |  |  | 0 | now (to 2026-03-03T03:43:06.000Z) | bug store records (open questions) | No open questions |
| Agreement when Devin recommends devin_fix | 100% (1 of 1) |  | 1 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (Devin's recommendation and the person's decision) |  |
| Agreement when Devin recommends needs_engineer | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (Devin's recommendation and the person's decision) | No person decided on a needs_engineer recommendation in the window |
| Agreement when Devin recommends close | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (Devin's recommendation and the person's decision) | No person decided on a close recommendation in the window |
| fix decisions made by the Rule policy | 0% (0 of 1) |  | 0 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) |  |
| fix decisions made by the Automatic policy | 0% (0 of 1) |  | 0 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) |  |
| engineer decisions made by the Rule policy | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) | No engineer decision was made in the window |
| engineer decisions made by the Automatic policy | No data |  |  |  | 0 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) | No engineer decision was made in the window |
| merge decisions made by the Rule policy | 0% (0 of 1) |  | 0 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) |  |
| merge decisions made by the Automatic policy | 0% (0 of 1) |  | 0 | 1 | 1 | last 30 days (2026-02-01T03:43:06.000Z to 2026-03-03T03:43:06.000Z) | bug store records (decision actors) |  |

