# Bug Smasher

Bug Smasher sends bugs from GitHub to Devin and checks the fixes before anyone merges them.

Label an issue and Devin investigates it, then recommends a fix, a hand-off to an engineer, or closing it. A person
decides. For a fix, Devin opens a pull request with a test, and Bug Smasher runs that test itself: it must fail
before the fix and pass after it. Features skip the investigation: their own label sends them straight to Devin to
build, and they are checked the same way.

## The problem

Most of a bug's cost comes before anyone writes a fix: someone has to reproduce it, trace it to a cause and decide
what to do. Apache Superset shows the scale. In the twelve months to 28 Sep 2026 it received 1,032 issues, 665 of
them from people who had never contributed. Its maintainers take a median of 70 hours to put a first label on an
issue. They mark bugs an agent could take as `ai-candidate`; those take a median of 12.9 days to close, and 78 are
open today. The bottleneck is investigation, not typing the fix.

## Where it has run

- **On itself.** Devin built Bug Smasher, and Bug Smasher ran the last part of its own build (below).
  [Build dashboard](https://kshitizshankar.github.io/devin-bug-smasher/results/building-bug-smasher.html)
- **On Apache Superset.** Open upstream bugs, copied into the fork
  [kshitizshankar/superset](https://github.com/kshitizshankar/superset). [Superset dashboard](https://kshitizshankar.github.io/devin-bug-smasher/results/superset-run.html)

## Is it working?

On Superset, 5 upstream bugs went through Bug Smasher. Devin investigated all 5 (median 7 minutes) and recommended
a fix for 4 and an engineer for 1. All 4 fixes were proven by Bug Smasher's check, 3 on the first try, for $17.89
of Devin usage across 11 sessions. The [Superset dashboard](https://kshitizshankar.github.io/devin-bug-smasher/results/superset-run.html) has every bug, and
[results/README.md](results/README.md) says how each number is measured.

On a live repository, `GET /api/metrics` gives four headline figures ([definitions](docs/METRICS.md)): fixes merged
and proven each week, hours from issue to proven merge, how often a fix passes the check the first time, and how
many merged fixes later failed. A figure with no data says so; it is never shown as zero.

## Bug Smasher built itself

Devin wrote Bug Smasher from GitHub issues, and a person reviewed and merged every pull request. Once the workflow
ran, new pull requests went through it: 9 of the 25 merged pull requests were started by a label on this
repository. Docs, the dashboard pages and a few small fixes were committed directly. Three examples, each with its
full trail on GitHub:

- **Fix.** [#97](https://github.com/kshitizshankar/devin-bug-smasher/issues/97): a helper file listed as a test crashed verification. A person added the fix
  label. Five minutes later Devin opened [#98](https://github.com/kshitizshankar/devin-bug-smasher/pull/98) with a summary for the reviewer. Bug Smasher ran
  Devin's new tests: 3 failed on the code before the fix and passed on the fix. Devin Review passed, and a person
  merged it about 15 minutes after the label.
- **Feature.** [#92](https://github.com/kshitizshankar/devin-bug-smasher/issues/92): Devin should post a "Ready for review" summary when a pull request is
  finished. A person added `devin-builds-feature`. Devin built it in [#94](https://github.com/kshitizshankar/devin-bug-smasher/pull/94), proven the same way (3 of
  13 tests failed before and passed after), and a person merged it about 19 minutes after the label.
- **Triage.** [#36](https://github.com/kshitizshankar/devin-bug-smasher/issues/36): a security finding from an earlier review. Six minutes after the triage label,
  Devin posted what it found and recommended a fix. It is waiting for a person to decide.

The issue comments here show as kshitizshankar: until [#100](https://github.com/kshitizshankar/devin-bug-smasher/pull/100), Bug Smasher posted them with the
repository owner's token. Devin now posts them from its own account, as on the Superset fork. This repository's
labels were renamed afterwards, so its older events and comments say `bug-smasher` and `needs-triage` where the
labels now read `devin:fix` and `devin:triage`.

## How it works

1. **A person labels an issue.** One label asks Devin to investigate, one to fix, one to build a feature.
2. **Bug Smasher starts a Devin session.** It checks GitHub every minute and starts one Devin session per bug
   through the Devin API, with the matching Playbook, an ACU cap per session and a limit on how many run at once.
   It never starts a second fix for a bug that already has an open pull request.
3. **Devin investigates.** It reproduces the bug in the repository and posts its findings on the issue: what
   happens, the likely cause, a test that shows the bug, and its recommendation. Bug Smasher reads the same
   findings as structured output and acts only on those fields.
4. **A person decides on GitHub.** The fix label sends the bug back to Devin to fix, in the same session while it
   is open. `needs-engineer` hands it to a person. Closing the issue ends it. A session that ends without a pull
   request hands the bug to an engineer; it is never restarted silently.
5. **Devin opens a pull request, and two checks run on it.**
   - **Bug Smasher's own check.** It runs Devin's test in the project's own test image, with the network off. The
     test must fail on the code before the fix and pass on the pull request. A fix that silences a lint or type
     check is flagged for review. The result appears on the pull request as the `bug-smasher/verification`
     status. A fix that fails the check goes back to Devin once, then to an engineer.
   - **Devin Review.** Once the check passes, Bug Smasher requests a Devin Review and sends its findings back to
     the same session to fix. After two rounds, a person decides what to do with any findings left.

   A second status, `bug-smasher/ready`, turns green when Devin has finished with the latest commit.
6. **A person merges.** Bug Smasher runs its check again on the merged code. If that fails, the bug goes to an
   engineer and counts as an escaped fix.
7. **Everything is recorded.** Each bug's history is kept in `data/bugs.json` (in the `bug-smasher-data` volume
   under Docker). `GET /api/metrics` reports the figures, and `npm run results -- results/<run>.run.json` turns a
   run into a dashboard page ([how](results/README.md#capturing-a-new-run)).

**Devin features it uses:** sessions through the Devin API (one per bug, with structured output, an ACU cap and
tags), Playbooks for triage, fixes and features, messages into a running session (a person's reply, a failed check,
review findings), Devin Review, and Devin's GitHub integration for branches, pull requests and comments.
`npm run setup` also creates the Playbooks, Knowledge notes and the repository's Devin environment.

## Quick start

### Try it without credentials

```sh
docker compose up --build -d                              # starts Bug Smasher on http://127.0.0.1:8080
docker compose exec bug-smasher npm run replay -- all     # plays the offline replay
curl http://127.0.0.1:8080/api/overview                   # eight replayed bugs, marked "simulated": true
```

Without GitHub or Devin keys, Bug Smasher serves an offline replay: its real workflow code, driven by eight
hand-written GitHub and Devin scenarios, with its own store. Every API response is marked `"simulated": true`, and
replayed bugs never count in live figures. The replay's check results are scripted. `npm run replay -- next` plays
one step at a time, `status` shows where it is and `reset` starts over.

### Run it on a repository

Copy the example settings and fill them in:

```sh
cp .env.example .env
```

```env
GITHUB_REPO=owner/repo
GITHUB_TOKEN=...        # this repository: issues, pull requests, statuses and checks; contents write for setup and merges
DEVIN_API_KEY=...
DEVIN_ORG_ID=org-...
VERIFY_IMAGE=apache/superset:master-dev                                            # the project's test image; without it nothing is verified
CHECK_COMMAND=python -m pytest -q -p no:cacheprovider --junitxml={results} {files}  # the only command the check runs
```

Every other setting is in `.env.example` with its default: at most 3 Devin sessions at once, 5 ACUs per session,
one retry after a failed check, Devin Review on, a GitHub check every 60 seconds, and people decide and merge
(`DECISION` and `MERGE` are `person`).

Then prepare the repository and start Bug Smasher:

```sh
docker compose run --rm -v "$PWD/setup:/app/setup:ro" bug-smasher npm run setup -- --dry-run   # lists every change setup would make
docker compose run --rm -v "$PWD/setup:/app/setup:ro" bug-smasher npm run setup                # creates the labels and an issue form, configures Devin
docker compose up --build -d
```

Setup needs the project's Devin environment blueprint (how Devin installs and tests it) in `setup/blueprint.yaml`;
none is included. If the repository's environment is already set up in the Devin app, skip setup and create the
labels on GitHub yourself.

The label names come from `.env`. The defaults are `needs-triage`, `bug-smasher`, `needs-engineer` and
`devin-builds-feature`; both live runs used `devin:triage` and `devin:fix`. Setup creates them on the repository,
and Devin's comments use the same names.

Devin needs its GitHub integration on the repository so it can push branches and open pull requests. To work on
a fork, `docker compose run --rm bug-smasher npm run mirror -- owner/repo#N` copies an upstream issue with its
links and @mentions made inert, so nothing upstream is notified or linked.

## Design decisions

The diagrams are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Devin does the engineering. Bug Smasher routes the work and checks it.** Devin investigates, reproduces, fixes
and writes the test, in one session, so its findings carry into the fix. By default Bug Smasher makes no decisions
on its own: people decide what to fix and what to merge. Setting `DECISION` or `MERGE` to `rule` or `auto` lets
clear cases through; no policy closes an issue or bypasses branch protection.

**The check belongs to Bug Smasher, not Devin.** Bug Smasher runs only the test command it was configured with, on
test files it has validated, in a fresh container of the project's test image, with the network off while the
tests run. A fix counts as proven only when the same test fails before it and passes after it, on the exact commits
named in the status; a new commit is checked again. The check refuses, without running anything, a fix that
deletes, skips or weakens a test, or changes test, lint, type-check or CI configuration. A test that errors or
cannot import on the old code does not count as failing. The GitHub token and Devin key never enter the test
container.

**People work in GitHub.** Labels, comments and merges are the whole interface. Devin writes every comment, from
its own account. The running service sets labels and commit statuses, and merges only when a merge policy allows
it.

**Simple to run.** Bug Smasher is one process that checks GitHub every minute and keeps its data in a JSON file.
It needs no public address, and a restart loses nothing. The trade-off is GitHub API usage (see Known
limitations).

**Cost from Devin's usage page.** Devin's API does not report usage on this plan, so spend is read from Devin's
usage page and entered as `DEVIN_SPEND_USD`, with the time it was read as `DEVIN_SPEND_READ_AT`.

## Why Devin

The work Bug Smasher hands off needs an agent, not a script or a single model call. On bug [#1](https://github.com/kshitizshankar/superset/issues/1)
of the Superset run, Devin cloned the repository, got its tests running, reproduced the failure against the real
code, traced the cause and wrote a test that fails on the current code, then fixed it in the same session. A script
cannot reproduce a bug. A single model call has no repository, shell or test runner. A coding assistant needs an
engineer to drive each step. Devin does the whole job, and a check it cannot influence decides whether the job
counts.

Devin's own features are what keep Bug Smasher small: sessions with structured output give the service fields to
act on, Playbooks keep the instructions in the repository, messages carry replies and failed checks into the same
session, and Devin Review adds a second look at every pull request. Bug Smasher itself was built the same way.

## Next steps

In a real engagement, the next month would look like this:

1. **Trigger.** Replace polling with a Devin Automation or webhooks, which also removes the GitHub API cost
   ([#104](https://github.com/kshitizshankar/devin-bug-smasher/issues/104)).
2. **Intake.** A nightly run takes new bugs from the team's queues, such as Superset's `ai-candidate` label, and
   from Slack, Linear or Jira through the same tracker interface.
3. **Autonomy by class of bug.** Triage, fix and merge move from a person, to a rule, to automatic, one class of bug
   at a time, as that class's record earns it. The `DECISION` and `MERGE` policies already support this.
4. **A pilot rule.** Run four weeks on one queue, and widen the scope if at least 3 in 4 fixes pass the check the
   first time and none is reverted.
5. **A live web dashboard**, in place of today's snapshot pages.

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
├── dashboard/     the read-only API's view of bugs and figures
├── store/         the bug records (data/bugs.json)
├── operator/      commands: setup, mirror, replay, report, verify-check
├── replay/        the offline replay
└── config/        settings, read from the environment
prompts/           what Bug Smasher sends Devin
replay/            the replay's eight scenarios
results/           dashboard pages and their data
scripts/results/   npm run results: record a run and render its page
web/               the web page (a placeholder)
docs/              architecture and metric definitions
```

## Development

```sh
npm ci
npm run typecheck
npm run build       # the smoke tests need the built page
npm test            # unit, integration and smoke tests; no credentials needed
npm start           # settings come from the environment; node --env-file=.env src/server/main.ts reads .env
```

Requires Node 22.18 or later (see `.nvmrc`). CI runs the typecheck, the build and the tests on every pull request.

## Known limitations

- There is no live web dashboard yet. Opening Bug Smasher in a browser shows a placeholder page. The dashboard
  pages in `results/` are static snapshots ([how they are made](results/README.md)); `GET /api/overview` shows a
  run as it goes.
- Issues found in review and not yet fixed are open and labelled
  [`deferred`](https://github.com/kshitizshankar/devin-bug-smasher/issues?q=is%3Aissue+is%3Aopen+label%3Adeferred).
  The ones that matter most in a live run:
  - polling uses a lot of the GitHub API allowance ([#104](https://github.com/kshitizshankar/devin-bug-smasher/issues/104))
  - on a fork, Devin's comments link to upstream issues ([#103](https://github.com/kshitizshankar/devin-bug-smasher/issues/103))
  - a renamed test counts as a removed one ([#102](https://github.com/kshitizshankar/devin-bug-smasher/issues/102))
  - the check does not confirm each selected test file ran, so `CHECK_COMMAND` must run exactly `{files}`
    ([#26](https://github.com/kshitizshankar/devin-bug-smasher/issues/26))
  - the re-check after a merge fails for rebase merges; use merge or squash ([#25](https://github.com/kshitizshankar/devin-bug-smasher/issues/25))
  - test containers can write to their host folders ([#27](https://github.com/kshitizshankar/devin-bug-smasher/issues/27))
  - the Docker socket is mounted by default, which gives the container root-level access to the host; run it only
    on a machine you trust ([#72](https://github.com/kshitizshankar/devin-bug-smasher/issues/72))
