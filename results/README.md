# Results

Two static pages of the Bug Smasher dashboard, linked by tabs, each with the data file it was rendered from.
They are published with GitHub Pages (the links below). A local copy also opens directly in a browser, since the
data is embedded. Both have a light and dark theme switch.

| Page | What it shows | Data |
| --- | --- | --- |
| [`superset-run.html`](https://kshitizshankar.github.io/devin-bug-smasher/results/superset-run.html) | The dashboard for the live run on [kshitizshankar/superset](https://github.com/kshitizshankar/superset), a fork of apache/superset: how fast bugs were investigated, whether the fixes are real, how fast a fix was ready, and what it cost; then where every bug is in the workflow and how many took each path; then every bug with its pull request and proof. | [`superset-run.json`](superset-run.json) |
| [`building-bug-smasher.html`](https://kshitizshankar.github.io/devin-bug-smasher/results/building-bug-smasher.html) | The dashboard for how Bug Smasher itself was built by Devin: how the build's issues moved through the workflow, then every merged pull request, how it was started, checked, how long it took and what it cost. | [`building-bug-smasher.json`](building-bug-smasher.json) |

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

## Capturing a new run

Each page has a run file (`<run>.run.json`) that says where the data is and holds every word on the page as a
template with `{figure}` placeholders. With Bug Smasher running against the target repository:

```sh
npm run results -- results/superset-run.run.json     # writes results/superset-run.json and .html
```

It reads the service's own figures (`GET /api/overview`, `GET /api/metrics`) and store (`data/bugs.json`), and,
for per-bug cost, a usage file copied from Devin's usage history (`results/superset-run.usage.json`). Copy the
run file to start a new run's page; edit its words there, not in code.
`node scripts/results/render.mjs results/<run>.json` re-renders a page from its data file alone.

The build page is a snapshot: its data came from GitHub and the build's own logs, so it is re-rendered from
`building-bug-smasher.json` rather than captured again.
