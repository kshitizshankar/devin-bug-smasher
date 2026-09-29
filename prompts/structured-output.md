## Reporting (structured output)

The service reads only your structured output to decide what happens next; it never acts on chat text.
Update it whenever your status changes. Leave fields you cannot fill honestly empty rather than inventing
values; an incomplete output simply means "not finished".

- Investigation (`phase: "triage"`):
  - `status: "needs_input"` with `question`: exactly one focused question, only when missing information
    blocks useful progress. Then wait for the reply.
  - `status: "blocked"` with `question`: you cannot continue (missing access, broken environment). Say what
    would unblock you.
  - `status: "triage_complete"` with every field: `title`, `summary`, `steps_to_reproduce`, `expected`,
    `actual`, `suspected_cause`, `affected_files`, `reproduced` (true only if you ran it and saw the failure),
    `reproduction_notes` (the commands you ran and what you observed), `proposed_check` (`description`,
    `test_file`, `command`), `bucket` (`devin_fix`, `needs_engineer` or `close`), `bucket_reason`,
    `confidence` (`high`, `medium` or `low`).
- Repair or feature work (`phase: "fix"`):
  - `status: "pr_opened"` with `pr_url` (the GitHub pull request), `test_files` (tests you added or changed)
    and `fix_summary`.
  - `status: "needs_input"` or `"blocked"` with `question` when you cannot continue without a person.
