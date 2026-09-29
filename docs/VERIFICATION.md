# Independent verification

Devin writes both the fix and its regression test, so Devin's own report that the test passes proves
nothing. `src/verify/` proves it independently: the new tests must fail on the pull request's base with a
real test failure, pass on its head, and the diff must not weaken the rules the proof runs under. The
orchestrator records the result through the model (`verification-recorded`) and publishes it as a commit
status on the exact commit that was checked.

| File | Contents |
| --- | --- |
| `verifier.ts` | `CheckedVerifier` (the `Verifier` contract), `verifierFromSettings`, `verifierSettingsProblems`, `checkCommandProblems` |
| `git.ts` | `GitRepository`: bare mirror, exact SHA resolution, changed files, `git archive` workspaces |
| `docker.ts` | `DockerRuntime`: one disposable container of the configured test image per run |
| `paths.ts` | Test-path validation and test/configuration path classification |
| `diff.ts` | Diff checks (violations and flags) |
| `results.ts` | JUnit parsing and setup/test outcome classification |
| `process.ts` | Shell-free process runner with time limit, bounded output and an explicit environment |

## Settings

| Variable | Default | Notes |
| --- | --- | --- |
| `VERIFY_IMAGE` | unset | The target repository's test image (with its toolchain). Verification is unavailable until set |
| `CHECK_COMMAND` | — | The only test runner that runs. Whitespace-separated arguments; `{files}` (a separate argument) becomes the selected test files, `{results}` the path where the runner must write a JUnit XML report |
| `VERIFY_SETUP_COMMAND` | unset | Optional dependency preparation (e.g. `npm ci`), run with network access before the tests |
| `VERIFY_TIMEOUT_SECONDS` | `600` | Time limit for each setup and test step |
| `VERIFY_WORK_DIR` | `<repo>/data/verify` | Repository mirror and disposable workspaces |

Example for a Node target: `CHECK_COMMAND=node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination={results} {files}`.
Until `GITHUB_REPO`, `VERIFY_IMAGE` and a `CHECK_COMMAND` with both placeholders are set, the service logs
why and keeps the unavailable verifier, so nothing is reported as verified.

## Procedure

For `pre-merge`, the head is the PR head and the base is the PR base; for `post-merge`, the head is the
recorded merge commit and the base is its first parent.

1. **Validate the selected test paths** before anything is fetched or run. Refused: empty selection,
   absolute or `~` paths, `..`, `.git`, leading `-` (options), globs, `::` selectors, shell
   metacharacters or whitespace, any character outside `[A-Za-z0-9._+@=-/]`; and, once the diff is known,
   files that are not tests or that the PR did not add or change. A refusal is a failed proof
   (`Rejected test path(s): …; nothing was run`).
2. **Resolve exact commits** in a local bare mirror (fetched only when a SHA is missing; the GitHub token is
   passed as an HTTP header through the environment, never stored or logged). Failure → `error`.
3. **Check the diff** (merge base → head). Every violation fails verification with its own reason, and
   nothing runs:

   | Check | Fails on |
   | --- | --- |
   | `test-removed` | A deleted test file, or a test (`it`/`test`/`describe`…, `def test_*`, `func Test*`) no longer present |
   | `test-disabled` | Added skip, expected-failure or only markers: `it.skip`, `describe.only`, `xit`, `pytest.mark.skip`/`skipif`/`xfail`, `unittest.skip`, `@Disabled`, `t.Skip`, `{ skip: … }` … |
   | `test-weakened` | A changed test file with fewer assertions than before |
   | `check-silenced` | Added suppressions: `# noqa`, `# type: ignore`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `pylint: disable`, `nolint`, coverage pragmas … |
   | `rules-changed` | Test, lint, type-check or CI configuration: `pytest.ini`, `conftest.py`, `tox.ini`, `setup.cfg`, lint and `tsconfig*.json` files, test-runner configs, `.github/workflows/`, other CI files; `package.json` `scripts` or test/lint config keys (`jest`, `mocha`, `vitest`, `eslintConfig` …) |
   | `deletion-only` (flag) | The change outside tests only deletes lines. Recorded in `evidence.flags`, noted in the status and one issue comment; never fails verification |

4. **Run head, then base**, each in a fresh workspace exported with `git archive` (no `.git`, remote or
   credential) and a fresh container. The base workspace gets the PR's test files (every added or changed
   test path, content from head) and nothing else, so the fix never reaches it. Each run: optional setup
   (network on) → network cut → `CHECK_COMMAND` (no shell; test paths are separate arguments).
5. **Classify** each step (`evidence.runs[]`: role, step, SHA, argv, start/end, exit code, outcome,
   reason, bounded redacted output):
   - Setup: anything but exit 0 → `error` (setup failures are never test results).
   - Tests → `error` when: the runner could not start, timed out, crashed (signal or exit ≥ 125), wrote no
     report or not JUnit, ran no tests or only skipped ones, a missing module/import is reported, a
     test errored, a selected file failed outside any test (load failure/crash), or the exit code
     contradicts the report. Otherwise `passed`, or `failed` for real test failures.

| Head | Base | Result |
| --- | --- | --- |
| `passed` | `failed` | `pass` |
| `passed` | `passed` | `fail` — the tests do not detect the bug |
| `failed` | not run | `fail` — the fix does not make them pass |
| `error` (either) | — | `error` |

## Safety

- Only `CHECK_COMMAND` and `VERIFY_SETUP_COMMAND` run. Commands in Devin's output, issue or PR comments, or
  files in the PR are data (a PR that changes `package.json` scripts fails `rules-changed`); paths are passed as arguments without a shell.
- The Docker CLI gets only `PATH`, `HOME` and `DOCKER_*` variables; `docker run` gets no `--env`, so no
  service variable (GitHub token, Devin key) reaches the container. The GitHub token and Devin key are also
  redacted from every recorded reason, command and output.
- Containers run with `no-new-privileges`, a PID limit, no network during tests, and are removed afterwards
  (also on timeout). Workspaces are deleted after each attempt.
- The workspace and results mounts are writable (tests and setup need to write) but are disposable
  directories under `VERIFY_WORK_DIR`. The host never follows links there: the base copy replaces a link
  at a test path instead of writing through it (with the file mode the test has on head), and the report is read only as a regular file (no link,
  at most 16 MiB).

## Orchestration

- `verifying`: the orchestrator calls the verifier for the recorded head. A result for another phase or head
  is refused. The attempt is recorded (with `sessionId`) and, in the same durable outbox transaction, a
  `set-commit-status` operation publishes it on the checked SHA with context
  **`bug-smasher/verification`** (`pass` → `success`, `fail` → `failure`, `error` → `error`).
- Budgets are the model's: the first failed proof returns to `fixing` and sends `verification-retry`
  (PR URL, head SHA, actual reason and output) to the same session for the same branch; the next failed
  proof hands off (`verification-failed`). Errors retry without spending fix attempts; the third hands off
  (`verification-error`).
- A new PR head moves the record back to `verifying`; earlier proof no longer counts.
- `merged`: the merge commit is verified (`post-merge`) until it has a `pass` or `fail`, or three errors.
  A failure hands off (`post-merge-verification-failed`); an error never counts as success.

## Requirement to test

| Requirement | Test |
| --- | --- |
| V1: base fails with a real assertion, head passes → `pass`; exact SHAs, commands, timestamps, outputs for both runs | `test/verify.test.ts` › V1 |
| V2: passes on both → `fail` | `test/verify.test.ts` › V2 |
| V3: fails on head → `fail` | `test/verify.test.ts` › V3 |
| V4: each diff violation fails on its own reason, nothing runs | `test/verify.test.ts` › V4 › rejects … (9 cases) |
| V4: deletion-only is a flag, not a failure; flag comment | `test/verify.test.ts` › V4 flags…; `test/orchestrator-verification.test.ts` › comments the deletion-only flag… |
| V5: setup failure, missing module, timeout, crashed test file, crashed runner, missing/unreadable/linked results, unfetchable commits → `error` | `test/verify.test.ts` › V5 (7 tests) |
| Base test copy never writes through a link in the base tree, and keeps the head's file mode | `test/verify.test.ts` › V5 › replaces a link in the base tree…, gives the copied test on base the mode… |
| Reordering `package.json` scripts is not a rule change | `test/verify.test.ts` › accepts reordered package.json scripts… |
| V6: unsafe paths, non-test and unchanged files, empty selection refused before anything runs | `test/verify.test.ts` › V6 |
| G7: proposed commands (PR files, issue comments) never run; only the configured runner; changed package scripts rejected | `test/verify.test.ts` › G7; `test/orchestrator-verification.test.ts` › G7 |
| G9: no credentials in Docker CLI/container environment or records; network cut before tests | `test/verify.test.ts` › G9 (2 tests); real Docker with `VERIFY_DOCKER_IMAGE` |
| Commit status on the exact checked SHA with the stable context | `test/orchestrator-verification.test.ts` (every test) |
| Changed head invalidates proof and is verified afresh | `test/orchestrator-verification.test.ts` › publishes a passing proof… |
| First failed proof: actual reason and output to the same session, same branch; second: engineer handoff | `test/orchestrator-verification.test.ts` › sends the first failed proof back… |
| Three infrastructure errors hand off without spending fix attempts | `test/orchestrator-verification.test.ts` › retries infrastructure errors… |
| Post-merge verification of the actual merge commit; failure hands off; pass recorded once | `test/orchestrator-verification.test.ts` › verifies the actual merge commit…, records a passing post-merge proof… |
| Evidence validated on load | `test/verify.test.ts` › V1 (`validateVerificationAttempt`) |
| Settings: `VERIFY_*` defaults/overrides; live verifier only when configured | `test/settings.test.ts` › loads verification defaults…; `test/verify.test.ts` › keeps the live verifier off… |

Run the real-Docker test locally with
`VERIFY_DOCKER_IMAGE=node:22.18.0-alpine node --test test/verify.test.ts`; CI runs the fixture tests with a
local stand-in runtime and never contacts a provider.
