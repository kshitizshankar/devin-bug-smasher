# Bug Smasher

Bug Smasher sends bugs from GitHub to Devin and checks the fixes before anyone merges them.

Label an issue and Devin investigates it, then recommends a fix, a hand-off to an engineer, or closing it. A person
decides. For a fix, Devin opens a pull request with a test, and Bug Smasher runs that test itself: it must fail
before the fix and pass after it. Features work the same way, with their own label.

## Where it has run

- **On itself.** Devin built Bug Smasher. Later changes to it were started by Bug Smasher: an issue on this
  repository was labelled, and Devin opened the pull request. [Build results](results/building-bug-smasher.html)
- **On Apache Superset.** Open upstream bugs, copied into the fork
  [kshitizshankar/superset](https://github.com/kshitizshankar/superset). [Superset results](results/superset-run.html)

## How it works

1. A person labels a GitHub issue: the triage label to investigate it, the fix label to fix it, or the feature label
   to build it. The names are settings (defaults `needs-triage`, `bug-smasher`, `devin-builds-feature`; the Superset
   run used `devin:triage` and `devin:fix`).
2. The service polls GitHub every `POLL_SECONDS` and starts one Devin session per bug, within `MAX_ACTIVE_SESSIONS`
   and a per-session ACU cap. It never starts a second fix while a pull request for the bug is open.
3. Devin investigates in the target repository and posts its findings on the issue from its own account: what
   happens, the suspected cause, a regression test and a recommendation.
4. A person decides on GitHub: the fix label continues in the same session, `needs-engineer` hands the bug off,
   closing the issue ends it.
5. Devin opens a pull request with the fix and the test. The verifier runs that test in the target's own test image
   with the network off: it must **fail on the base commit and pass on the pull request**. Added lint or type-check
   suppressions are flagged for review. The result is the `bug-smasher/verification` commit status; a failed proof
   goes back to Devin once, then to an engineer.
6. A person merges. The verifier proves the fix again on the merge commit.
7. Every step is stored per bug in `data/bugs.json`. `GET /api/metrics` computes the figures
   ([definitions](docs/METRICS.md)) and `npm run results` turns a run into a page.

## Quick start

### Without credentials

```sh
docker compose up --build -d                              # the service on http://127.0.0.1:8080
docker compose exec bug-smasher npm run replay -- all     # play the offline replay
curl http://127.0.0.1:8080/api/overview                   # eight replayed bugs, clearly marked simulated
```

With no GitHub or Devin credentials the service runs the offline replay: the real orchestrator against stand-in
GitHub and Devin, with its own store.

### Live

```sh
cp .env.example .env
```

Set the target and the keys in `.env`:

```env
GITHUB_REPO=owner/repo
GITHUB_TOKEN=...        # reads issues and pull requests; writes labels and commit statuses on the target
DEVIN_API_KEY=...
DEVIN_ORG_ID=org-...
VERIFY_IMAGE=apache/superset:master-dev                                            # the target's test image
CHECK_COMMAND=python -m pytest -q -p no:cacheprovider --junitxml={results} {files}  # its test runner
```

```sh
docker compose up --build -d
```

The label names in `.env` are the only ones the service reads. `npm run setup` creates them on the target with
descriptions, adds an issue form that names them, and configures Devin's side (`npm run setup -- --dry-run` lists
every change first); Devin's comments name the same labels.

Devin needs its GitHub integration on the target repository so it can push branches and open pull requests. To
work on a fork, `npm run mirror -- owner/repo#N` copies an upstream issue with links and mentions neutralised.

## Architecture decisions

**Devin does the engineering; the service routes and checks.** Investigation, reproduction, the fix and its test
are Devin's, in one session that carries the findings into the fix. The service decides nothing on its own by
default (`DECISION=person`, `MERGE=person`); Rule and Automatic policies exist for teams that want them.

**The proof is ours, not Devin's.** The verifier runs only the configured `CHECK_COMMAND`, on test paths it has
validated, in sibling containers of the target's image started through the host's Docker socket, with the network
cut before the tests. A fix counts as proven only when the same test fails before it and passes after it.

**People act on GitHub only.** Labels, comments and merges are the whole interface. Devin writes every comment
from its own account; the service writes labels and commit statuses (`bug-smasher/ready`,
`bug-smasher/verification`). One personal token is enough: the service recognises its own label changes by
recording them, so a person's labels count even on the same account.

**Polling, a JSON store, one process.** Polling needs no public endpoint; the store makes restarts safe and keeps
the history each figure is computed from. The cost is GitHub API volume (see Known limitations).

**Cost from Devin's usage history.** Devin's API reports no ACUs on this plan, so spend is read from the usage
page into `DEVIN_SPEND_USD` with the time it was read, and every figure says where it came from.

## Project structure

```
src/
├── server/        HTTP service: health, read-only dashboard API, static web
├── orchestrator/  the workflow: polling, sessions, decisions, verification, merges
├── model/         the bug model and its stage transitions
├── tracker/       GitHub adapter (and an in-memory tracker for tests and replay)
├── devin/         Devin API client
├── verify/        the verifier: workspaces, sibling containers, proofs, diff checks
├── metrics/       every figure the API and the results pages show
├── store/         the bug store (data/bugs.json)
├── operator/      CLI: setup, mirror, report, verify-check
├── replay/        the offline replay
└── config/        settings from the environment
prompts/           what the service sends Devin: requests and Playbooks
results/           live results pages and their data
scripts/results/   npm run results: capture a run and render its page
web/               the dashboard frontend (a placeholder)
docs/              reference for each part
```

## Development

```sh
npm ci
npm test            # unit and integration tests
npm run typecheck
npm run build && npm start
```

Node 22. CI runs the typecheck and a build-and-smoke test on every pull request.

## Known limitations

- The web dashboard is a placeholder; the read-only API and the results pages carry the figures.
- Findings deferred rather than fixed are open issues labelled
  [`deferred`](https://github.com/kshitizshankar/devin-bug-smasher/issues?q=is%3Aissue+is%3Aopen+label%3Adeferred).
  The ones that matter most in a live run: polling cost against GitHub's API limit (#104), comments on a fork
  linking upstream issues (#103), a renamed test counted as removed (#102), writable test-container mounts (#27)
  and the Docker socket mounted by default (#72).
