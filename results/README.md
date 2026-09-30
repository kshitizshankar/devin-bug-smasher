# Results

Two static pages, each with the data file it was rendered from. Open the HTML directly in a browser; the data is
embedded, so no server is needed. Both have a light and dark theme switch.

| Page | What it shows | Data |
| --- | --- | --- |
| [`superset-run.html`](superset-run.html) | The live run on [kshitizshankar/superset](https://github.com/kshitizshankar/superset), a fork of apache/superset: how fast bugs were investigated, whether the fixes are real, how fast a fix was ready, and what it cost; then every bug with its pull request and proof. | [`superset-run.json`](superset-run.json) |
| [`building-bug-smasher.html`](building-bug-smasher.html) | How Bug Smasher itself was built by Devin: every merged pull request, how it was started, checked, how long it took and what it cost. | [`building-bug-smasher.json`](building-bug-smasher.json) |

## Where the numbers come from

- **Bugs, stages, decisions and proofs:** Bug Smasher's own store and its metrics report (`GET /api/metrics`,
  defined in [`docs/METRICS.md`](../docs/METRICS.md)).
- **Pull requests, lines changed and checks:** GitHub.
- **Cost:** Devin's usage history. Devin's API reports no ACUs on this plan, so spend is read from the usage
  page and given to the service as `DEVIN_SPEND_USD` with the time it was read.
- **Superset comparisons** (70 hours to a maintainer's first label, 12.9 days to close an `ai-candidate`
  issue): measured on apache/superset on 28 Sep 2026.

A fix counts as **proven** when Bug Smasher's verifier runs Devin's test in Superset's own test image and it
fails on the code before the fix and passes on the fix. Merging in a fork is the fork owner's call, so merges
are shown in the table, not in the headline figures.

Each data file holds the figures, the rows and the page's wording. Re-running the freeze step on new data
rewrites both files.
