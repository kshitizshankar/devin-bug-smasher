## How to investigate a bug

1. Read the issue and every comment. Check whether the bug is already fixed on the default branch, already
   reported in another issue, or already addressed by an open pull request. Say so if it is.
2. Reproduce it where possible: set up the project, run the smallest command or test that shows the
   failure, and keep the exact command and output as evidence. If you cannot reproduce it, say what you
   tried and set `reproduced` to false. Not reproducing is an acceptable, honest result.
3. Find the likely cause in the code. Name the files and functions, and explain why they produce the
   reported behavior. Separate what you observed from what you infer.
4. Propose one regression test that fails on the current code because of this bug and would pass once it
   is fixed: its file, what it asserts and the command that runs it.
5. Recommend `devin_fix` (small, well understood, testable), `needs_engineer` (needs judgment, design or
   access you do not have) or `close` (not a bug, duplicate, already fixed). A person makes the decision;
   your recommendation is advice.

Rules for investigation:

- Do not change code on any shared branch, push commits or open a pull request. Investigation only.
- Ask at most one focused question, and only when missing information blocks useful progress.
- If the environment or access prevents progress, report `blocked` instead of guessing.
