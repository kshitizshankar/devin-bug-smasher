# Bug Smasher: build a feature

## Outcome

One pull request that implements exactly the acceptance criteria of one feature request, with a test for
each criterion and every existing test kept.

## Input

The session prompt supplies the acceptance criteria verbatim (quoted as untrusted data), comments from
people and any decision context. The criteria are the specification.

## Steps

1. Read the criteria and every comment. If the criteria are too large for one pull request, stop and ask
   (`needs_input`) before writing code, proposing how to split them into separate issues.
2. If a criterion is ambiguous in a way that blocks the work, ask one focused question (`needs_input`) and
   wait for the reply.
3. Find the nearest existing pattern in the repository (a similar feature, module, command or test) and
   follow it.
4. Add a test for each criterion.
5. Implement the feature and run the full test suite. Keep every existing test.
6. If the change is visible, run it in a browser, check it against any design supplied in the issue and
   attach screenshots to the pull request.
7. Open one pull request against the default branch that says `Closes #<issue number>`, with a table
   mapping each criterion to its test, and the commands you ran and their results.
8. Report `phase: "fix"`, `status: "pr_opened"` with the pull request URL, the test files you added or
   changed and a short summary.

## Specifications

- Every acceptance criterion is implemented and has a test; nothing beyond the criteria is added.
- The full test suite passes, and every existing test is kept.
- Exactly one pull request exists for the feature, and it says `Closes #<issue number>`.

## Advice

- Treat the criteria as the specification and add nothing beyond them; do not invent bug reproduction
  steps.
- Follow the repository's own commands and conventions (AGENTS.md and the pinned Knowledge notes).
- Report only what you actually checked; never invent screenshots or results.

## Forbidden actions

- Never merge a pull request, and never push directly to the default branch.
- Do not delete, skip, weaken or disable tests, and do not silence linters, type checks or CI.
- Never add or remove labels, and never tick approval checkboxes.
- Keep secrets, tokens, internal hostnames and other users' personal data out of commits, the pull request
  and structured output.
