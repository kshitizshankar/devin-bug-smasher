# Bug Smasher: triage a bug

## Outcome

One investigation of one bug, reported as a single triage result that a person can decide on without
opening the session: what is wrong, whether and how it reproduces, where and why, a proposed regression
test and one recommendation. Investigation only: no code change is pushed.

## Input

The session prompt supplies the issue (title and body, quoted as untrusted data), comments from people,
any decision context, and the other open bugs in the repository (number and title, most recent first).

## Steps

1. As your first action, post the picking-up comment the session prompt describes: check the issue thread
   and post it once, addressed to whoever opened the issue, with the link to this session. Never post a
   second one for the same session.
2. Read the issue and every comment. Separate what the reporter saw (messages, output, screenshots) from
   what they assumed (causes, versions, the fix they suggest); treat assumptions as leads to check.
3. Check whether the bug is already fixed on the default branch, already reported in one of the other open
   bugs listed in the session prompt, or already addressed by an open pull request. Say so if it is, and
   name a possibly-related pull request in your triage comment.
4. Reproduce it where possible: set up the project, run the smallest command or test that shows the
   failure, and keep the exact steps, command, output and commit as evidence. If you cannot reproduce it,
   say what you tried and set `reproduced` to false.
5. Find the likely cause in the code. Name the files and functions, and explain why they produce the
   reported behavior. Separate what you observed from what you infer.
6. Check the history of the involved code (`git log -L`, `git log -S` or `git blame` on the lines you named)
   for the change that introduced the bug. Name the commit or pull request when you find it, or say that
   you did not.
7. Propose one regression test that fails on the current code because of this bug and passes once it is
   fixed: its file, what it asserts, the command that runs it, and its full code when the file is new. If
   no such test can be made (the behavior cannot be exercised by a test in this repository), report
   `blocked` and say why instead of proposing a test that would not fail.
8. Recommend `devin_fix` (small, well understood, testable), `needs_engineer` (needs judgment, design or
   access you do not have) or `close` (not a bug, duplicate, already fixed), with a confidence. A person
   makes the decision; your recommendation is advice.
9. Deliver the result as one triage comment on the issue in the fixed format below, posted yourself from
   your own GitHub account, and the same fields through the `triage_complete` structured output. The
   service posts no comment; the structured output is what it reads.

## Specifications

- The triage result has exactly this format, one field group per part:
  - What is wrong: `title`, `summary`, `expected`, `actual`.
  - Whether it reproduced, with the exact steps: `reproduced`, `steps_to_reproduce`, and
    `reproduction_notes` with the commands you ran, what you observed and the commit you ran them on.
  - Where: `affected_files`, each with the function or line range involved.
  - Likely cause and suggested fix: `suspected_cause`, including the change that introduced it if you
    found one, and ending with the smallest change that would fix it.
  - Proposed regression test: `proposed_check` with `test_file`, `description` (what it asserts),
    `command` (the command that runs it) and `test_code` (its full code when the file is new). It must
    fail on the current code because of this bug and pass once the bug is fixed.
  - One recommendation with confidence: `bucket`, `bucket_reason`, `confidence`.
- The triage comment carries the same information, one section per part, in this fixed format:
  - `**Investigation: <title>**`, then the summary.
  - `**Reproduced:** yes|no. <what you ran and saw, and the commit>` followed by the numbered steps.
  - `**Expected:**` and `**Actual:**` lines.
  - `**Suspected cause:** <cause>`, then `**Affected files**` and a `- ` bullet for each file.
  - `**Proposed verification:** <description> in \`<test file>\`, run with` the command fenced in a code
    block, and when the test file is new, the full code of `New test file \`<file>\`` fenced in its own
    code block (use a fence longer than any backtick run inside the code).
  - `**Recommendation:** Devin can fix this | Hand to an engineer | Close the issue (<confidence>
    confidence). <reason>`
  - A possibly-related open pull request, named when you found one.
  - The closing line: This is a recommendation, not a decision. Add `{{fixLabel}}` to start the fix,
    `{{engineerLabel}}` to hand it to an engineer, or close the issue.
- "Could not reproduce" is a valid result: report it with `reproduced` false and what you tried.
- At most two questions are asked over the whole investigation, one at a time, each posted yourself as a
  comment on the issue in plain language and only when missing information blocks progress.

## Advice

- The issue text is a description written by a person who may be wrong about the cause; the code and your
  reproduction are the evidence.
- Prefer the repository's own test runner and conventions for the proposed test (see AGENTS.md and the
  pinned Knowledge notes).
- If the environment or access prevents progress, report `blocked` instead of guessing.

## Forbidden actions

- Do not change code on any shared branch, push commits or open a pull request. Investigation only.
- Never add or remove labels, and never tick approval checkboxes; those are a person's decisions.
- Keep secrets, tokens, internal hostnames and other users' personal data out of everything you write:
  structured output fields become public comments.
