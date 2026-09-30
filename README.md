# Bug Smasher

Bug Smasher sends bugs from GitHub to Devin and checks the fixes before anyone merges them.

Label an issue and Devin investigates it, then recommends a fix, a hand-off to an engineer, or closing it. A person
decides. For a fix, Devin opens a pull request with a test, and Bug Smasher runs that test itself: it must fail
before the fix and pass after it. Features work the same way, with their own label.

## Where it has run

- **On itself.** Devin built Bug Smasher, and Bug Smasher ran the last part of its own build (below).
  [Build dashboard](https://kshitizshankar.github.io/devin-bug-smasher/results/building-bug-smasher.html)
- **On Apache Superset.** Open upstream bugs, copied into the fork
  [kshitizshankar/superset](https://github.com/kshitizshankar/superset). [Superset dashboard](https://kshitizshankar.github.io/devin-bug-smasher/results/superset-run.html)

## Bug Smasher built itself

Devin wrote Bug Smasher from GitHub issues, and a person reviewed and merged every pull request. Once the workflow
ran, the rest of the build went through it, on this repository: 9 of the 25 merged pull requests were started by a
label. Three examples, each with its full trail on GitHub:

- **Fix.** [#97](https://github.com/kshitizshankar/devin-bug-smasher/issues/97): a helper file listed as a test crashed verification. A person added
  `devin:fix`. Five minutes later Devin opened [#98](https://github.com/kshitizshankar/devin-bug-smasher/pull/98) with a summary for the reviewer. Bug Smasher ran
  Devin's new tests: 3 failed on the code before the fix and passed on the fix. Devin Review passed, and a person
  merged it about 15 minutes after the label.
- **Feature.** [#92](https://github.com/kshitizshankar/devin-bug-smasher/issues/92): Devin should post a "Ready for review" summary when a pull request is
  finished. A person added `devin-builds-feature`. Devin built it in [#94](https://github.com/kshitizshankar/devin-bug-smasher/pull/94), proven the same way (3 of
  13 tests failed before and passed after), and a person merged it 19 minutes after the label.
- **Triage.** [#36](https://github.com/kshitizshankar/devin-bug-smasher/issues/36): a security finding from an earlier review. Six minutes after `devin:triage`,
  Devin posted what it found and recommended a fix. It is waiting for a person to decide.

The issue comments here show as kshitizshankar: until [#100](https://github.com/kshitizshankar/devin-bug-smasher/pull/100), Bug Smasher posted them with the
repository owner's token. Devin now posts them from its own account, as on the Superset fork.

## How it works

1. **A person labels an issue.** One label asks Devin to investigate, one to fix, one to build a feature.
2. **Bug Smasher starts a Devin session.** It checks GitHub every minute and starts one Devin session per bug
   through the Devin API, with the matching Playbook, a spending cap and a limit on how many run at once. It never
   starts a second fix for a bug that already has an open pull request.
3. **Devin investigates.** It reproduces the bug in the repository and posts its findings on the issue: what
   happens, the likely cause, a test that shows the bug, and its recommendation. Bug Smasher reads the same
   findings as structured output and acts only on those fields.
4. **A person decides on GitHub.** The fix label sends the bug back to Devin, in the same session, to fix.
   `needs-engineer` hands it to a person. Closing the issue ends it.
5. **Devin opens a pull request, and two checks run on it.**
   - **Devin Review.** Bug Smasher requests a Devin Review of the pull request and sends its findings back to the
     same session to fix. After two rounds, a person decides what to do with any findings left.
   - **Bug Smasher's own check.** It runs Devin's test in the project's own test image, with the network off. The
     test must fail on the code before the fix and pass on the pull request. A fix that silences a lint or type
     check is flagged for review. The result appears on the pull request as the `bug-smasher/verification`
     status. A fix that fails the check goes back to Devin once, then to an engineer.

   A second status, `bug-smasher/ready`, turns green when Devin has finished with the latest commit.
6. **A person merges.** Bug Smasher runs its check again on the merged code.
7. **Everything is recorded.** Each bug's history is kept in `data/bugs.json`. `GET /api/metrics` reports the
   figures ([definitions](docs/METRICS.md)), and `npm run results` turns a run into a dashboard page.

**Devin features it uses:** sessions through the Devin API (one per bug, with structured output, a spending cap and
tags), Playbooks for triage, fixes and features, messages into a running session (a person's reply, a failed check,
review findings), Devin Review, and Devin's GitHub integration for branches, pull requests and comments.
`npm run setup` also creates the Playbooks, Knowledge notes and the repository's Devin environment.

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

The diagrams are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
├── metrics/       every figure in the API and on the dashboard pages
├── store/         the bug records (data/bugs.json)
├── operator/      commands: setup, mirror, report, verify-check
├── replay/        the offline replay
└── config/        settings, read from the environment
prompts/           what Bug Smasher sends Devin
results/           dashboard pages and their data
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

- There is no live web dashboard yet. Opening Bug Smasher in a browser shows a placeholder page. The dashboard
  pages in `results/` are generated with `npm run results`; `GET /api/overview` shows a run as it goes.
- Issues found in review and not yet fixed are open and labelled
  [`deferred`](https://github.com/kshitizshankar/devin-bug-smasher/issues?q=is%3Aissue+is%3Aopen+label%3Adeferred).
  The ones that matter most in a live run:
  - polling uses a lot of the GitHub API allowance (#104)
  - on a fork, Devin's comments link to upstream issues (#103)
  - a renamed test counts as a removed one (#102)
  - test containers can write to their host folders (#27)
  - the Docker socket is mounted by default (#72)
