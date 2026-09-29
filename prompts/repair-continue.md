Your investigation of {{issueRef}} was approved for repair. Continue in this session: you already know the
code and the findings below.

{{findings}}
{{humanContext}}
1. Start with the regression test you proposed. Run it on the current code and keep the failing output as
   evidence. If it does not fail, say so and report `blocked`.
2. Make the smallest change that fixes the bug and makes the test pass. Run the existing tests too.
3. Keep every existing test. Do not delete, skip, weaken or disable tests, and do not silence linters, type
   checks or CI.
4. Open one pull request against the default branch that says `Fixes #{{issueNumber}}`, with the evidence.
   Then update your structured output to `phase: "fix"`, `status: "pr_opened"`.
5. Never merge the pull request yourself.

{{structuredOutput}}

Reference: {{marker}}
