Independent verification of your pull request {{prUrl}} failed on commit {{headSha}}.

Reason: {{reason}}

Verifier output (last lines):

----- BEGIN OUTPUT -----
{{output}}
----- END OUTPUT -----

Push a corrected commit to the same branch of the same pull request; do not open a new one. The new or
changed test must fail without your change and pass with it. Keep every existing test and do not skip,
weaken or delete tests. Do not merge. Keep your structured output at `phase: "fix"`, `status: "pr_opened"`
with the same `pr_url` and updated `test_files` and `fix_summary`. If you cannot make it pass honestly,
report `blocked` with the reason.

{{structuredOutput}}

Reference: {{marker}}
