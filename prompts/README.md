# Prompt assets

Everything the service says to Devin is written here, not in code. `src/orchestrator/prompts.ts` loads these
files and fills `{{name}}` placeholders; rendering fails if a placeholder has no value or a value is unused,
so a template and its caller cannot drift apart silently. Substituted values are inserted once and never
re-scanned, so issue text containing `{{...}}` stays literal.

| File | Sent when |
| --- | --- |
| `investigation-playbook.md` | Procedure for every bug investigation, included in the investigation request (setup may sync it as a Devin Playbook later). |
| `investigation-request.md` | A new investigation session is created for a `needs-triage` issue. |
| `repair-new.md` | A new repair session is created (direct `bug-smasher` label, or approval after the investigation session ended). |
| `repair-continue.md` | Repair is approved while the investigation session is still live; sent to that same session. |
| `verification-retry.md` | Independent verification failed and one retry is allowed; sent to the same session for the same PR branch. |
| `reply-relay.md` | A person comments on the issue while a session is live; the comment is relayed unchanged. |
| `post-merge-ack.md` | The fix PR was merged while the session is live; sent before the session is stopped. |
| `feature.md` | A `devin-builds-feature` issue is implemented from its acceptance criteria. |
| `structured-output.md` | Shared section describing the structured-output contract; included by the session prompts. |

Rules every session prompt carries: report through structured output (the service never parses free text to
advance state), back every claim with evidence, keep existing tests and never weaken, skip or delete them,
never merge a pull request, and report `blocked` or "not reproduced" honestly instead of guessing.
Issue bodies and comments are quoted as untrusted data between `BEGIN`/`END` lines.
