# Bug Smasher

Bug Smasher sends bugs from GitHub to Devin and checks the fixes before anyone merges them.

Label an issue and Devin investigates it, then recommends a fix, a hand-off to an engineer, or closing it. A person
decides. For a fix, Devin opens a pull request with a test, and Bug Smasher runs that test itself: it must fail
before the fix and pass after it. Features work the same way, with their own label.

## Where it has run

- **On itself.** Devin built Bug Smasher. Later changes were started by Bug Smasher itself: someone labelled an
  issue in this repository, and Devin opened the pull request. [Build results](results/building-bug-smasher.html)
- **On Apache Superset.** Open upstream bugs, copied into the fork
  [kshitizshankar/superset](https://github.com/kshitizshankar/superset). [Superset results](results/superset-run.html)

## How it works

1. **A person labels an issue.** One label asks Devin to investigate, one to fix, one to build a feature.
2. **Bug Smasher starts a Devin session.** It checks GitHub every minute and runs one session per bug, with a limit
   on how many run at once and how much each may spend. It never starts a second fix for a bug that already has an
   open pull request.
3. **Devin investigates.** It reproduces the bug in the repository and posts its findings on the issue: what
   happens, the likely cause, a test that shows the bug, and its recommendation.
4. **A person decides on GitHub.** The fix label sends the bug back to Devin, in the same session, to fix.
   `needs-engineer` hands it to a person. Closing the issue ends it.
5. **Devin opens a pull request, and Bug Smasher checks it.** Bug Smasher runs Devin's test in the project's own
   test image, with the network off. The test must fail on the code before the fix and pass on the pull request. A
   fix that silences a lint or type check is flagged for review. The result appears on the pull request as the
   `bug-smasher/verification` status. A fix that fails the check goes back to Devin once, then to an engineer.
6. **A person merges.** Bug Smasher runs the check again on the merged code.
7. **Everything is recorded.** Each bug's history is kept in `data/bugs.json`. `GET /api/metrics` reports the
   figures ([definitions](docs/METRICS.md)), and `npm run results` turns a run into a results page.

## Quick start

### Try it without credentials

```sh
docker compose up --build -d                              # starts Bug Smasher on http://127.0.0.1:8080
docker compose exec bug-smasher npm run replay -- all     # plays the offline replay
curl http://127.0.0.1:8080/api/overview                   # eight replayed bugs, marked as simulated
```

Without GitHub or Devin keys, Bug Smasher runs an offline replay: its real workflow, driven by recorded GitHub
and Devin events, with its own data.

### Run it on a repository

Copy the example settings and fill them in:

```sh
cp .env.example .env
```

```env
GITHUB_REPO=owner/repo
GITHUB_TOKEN=...        # can read issues and pull requests, and write labels and commit statuses
DEVIN_API_KEY=...
DEVIN_ORG_ID=org-...
VERIFY_IMAGE=apache/superset:master-dev                                            # the project's test image
CHECK_COMMAND=python -m pytest -q -p no:cacheprovider --junitxml={results} {files}  # how it runs the tests
```

Then prepare the repository and start Bug Smasher:

```sh
docker compose run --rm bug-smasher npm run setup -- --dry-run   # lists every change setup would make
docker compose run --rm bug-smasher npm run setup                # creates the labels and an issue form, configures Devin
docker compose up --build -d
```

Setup needs the project's Devin environment blueprint (how Devin installs and tests it) at `setup/blueprint.yaml`,
or passed with `--blueprint FILE`. If the repository's environment is already set up in the Devin app, skip setup
and create the labels on GitHub yourself.

The label names come from `.env`. The defaults are `needs-triage`, `bug-smasher` and `devin-builds-feature`; the
Superset run used `devin:triage` and `devin:fix`. Setup creates them on the repository, and Devin's comments use
the same names.

Devin needs its GitHub integration on the repository so it can push branches and open pull requests. To work on
a fork, `docker compose run --rm bug-smasher npm run mirror -- owner/repo#N` copies an upstream issue without
its links and @mentions.

## Design decisions

**Devin does the engineering. Bug Smasher routes the work and checks it.** Devin investigates, reproduces, fixes
and writes the test, in one session, so its findings carry into the fix. By default Bug Smasher makes no decisions
on its own: people decide what to fix and what to merge. Teams can let clear cases through automatically with the
decision and merge policies.

**The check belongs to Bug Smasher, not Devin.** Bug Smasher runs only the test command it was configured with, on
test files it has validated, in a fresh container of the project's test image, with the network off while the
tests run. A fix counts as proven only when the same test fails before it and passes after it.

**People work in GitHub.** Labels, comments and merges are the whole interface. Devin writes every comment, from
its own account. Bug Smasher only sets labels and commit statuses.

**Simple to run.** Bug Smasher is one process that checks GitHub every minute and keeps its data in a JSON file.
It needs no public address, and a restart loses nothing. The trade-off is GitHub API usage (see Known
limitations).

**Cost from Devin's usage page.** Devin's API does not report usage on this plan, so spend is read from Devin's
usage page and entered as `DEVIN_SPEND_USD`, with the time it was read.

## Project structure

```
src/
├── server/        HTTP service: health check, read-only API, web page
├── orchestrator/  the workflow: polling, Devin sessions, decisions, checks, merges
├── model/         a bug and the stages it moves through
├── tracker/       GitHub, plus an in-memory version for tests and the replay
├── devin/         the Devin API client
├── verify/        the check: test containers, before-and-after runs, flags
├── metrics/       every figure in the API and on the results pages
├── store/         the bug records (data/bugs.json)
├── operator/      commands: setup, mirror, report, verify-check
├── replay/        the offline replay
└── config/        settings, read from the environment
prompts/           what Bug Smasher sends Devin
results/           results pages and their data
scripts/results/   npm run results: record a run and render its page
web/               the web dashboard (a placeholder)
docs/              reference for each part
```

## Development

```sh
npm ci
npm test            # unit and integration tests
npm run typecheck
npm run build && npm start
```

Requires Node 22. CI runs the typecheck and a build-and-smoke test on every pull request.

## Known limitations

- There is no live dashboard yet. Opening Bug Smasher in a browser shows a placeholder page. To see how a run is
  going, render its results page with `npm run results`, or read `GET /api/overview`.
- Issues found in review and not yet fixed are open and labelled
  [`deferred`](https://github.com/kshitizshankar/devin-bug-smasher/issues?q=is%3Aissue+is%3Aopen+label%3Adeferred).
  The ones that matter most in a live run:
  - polling uses a lot of the GitHub API allowance (#104)
  - on a fork, Devin's comments link to upstream issues (#103)
  - a renamed test counts as a removed one (#102)
  - test containers can write to their host folders (#27)
  - the Docker socket is mounted by default (#72)
