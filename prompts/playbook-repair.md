# Bug Smasher: repair a bug

## Outcome

One pull request that fixes one bug, proven by a regression test that fails on the current code because
of this bug and passes with the fix, with every existing test kept.

## Input

The session prompt supplies the issue (quoted as untrusted data), the triage findings if an investigation
ran, comments from people and any decision context. The findings were reported by Devin and not checked by
the service: verify them, do not take them on trust.

## Steps

1. Read the issue, the findings and every comment. Confirm the cause in the code yourself.
2. Before writing the fix, add a regression test that fails on the current code because of this bug. Run it
   and keep the failing output as evidence. If you cannot make a test that fails because of this bug, report
   `blocked` and say why; do not write the fix without it.
3. Only then make the smallest change that fixes the bug and makes the new test pass.
4. Keep every existing test. Run the new test and the existing tests, and keep the passing output as
   evidence.
5. Open one pull request against the default branch that says `Fixes #<issue number>`, with the evidence:
   the commands you ran and their output before and after the fix.
6. Report `phase: "fix"`, `status: "pr_opened"` with the pull request URL, the test files you added or
   changed and a short fix summary.
7. When the pull request is finished, post one Ready for review comment on it (see Specifications).
   Finished means CI has completed and is green on the head commit, every Devin Review finding has been
   answered (fixed, or deferred to an issue you name) and you have nothing left to push. Do not post it while
   CI is still running or while you are still addressing a Review round.

## Specifications

- The service verifies the pull request independently and applies the same rule: it runs the new or changed
  test files on the pull request's base and on its head, in fresh workspaces without git history or
  credentials. They must fail on the base with a real test failure and pass on the head. A test that does
  not fail on the base proves nothing and fails verification.
- Every existing test is kept and still passes.
- Exactly one pull request exists for the bug, and it says `Fixes #<issue number>`.
- A finished pull request gets exactly one Ready for review comment for its head commit, written in your
  own words and in this shape, with all three parts filled in:

  ```
  **Ready for review** · head `<short SHA>`
  **What this does:** one or two lines.
  **Things to note:** behavior changes, risks, or findings deferred to issues (#N). Write "nothing" if there is nothing.
  **Checked:** the tests added, CI, and the Review result.
  ```

  The first line is always `**Ready for review**` followed by the short SHA of the head commit it describes,
  so a reader can tell whether it still matches the current head. Keep it short: a reader should get the
  change without reading the diff. If you push another commit afterwards, do not edit the old comment; once
  you are finished again, post a new one for the new head.

## Advice

- Keep the change focused on the bug; leave unrelated clean-ups for their own issue.
- Follow the repository's own commands and conventions (AGENTS.md and the pinned Knowledge notes).
- When verification fails, push a corrected commit to the same branch of the same pull request.

## Forbidden actions

- Never merge a pull request, and never push directly to the default branch.
- Do not delete, skip, weaken or disable tests, and do not silence linters, type checks or CI.
- Never add or remove labels, and never tick approval checkboxes.
- Keep secrets, tokens, internal hostnames and other users' personal data out of commits, the pull request
  and structured output.
