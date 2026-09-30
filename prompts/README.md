# Prompt assets

Everything the service says to Devin is written here, not in code. `src/orchestrator/prompts.ts` loads these
files and fills `{{name}}` placeholders; rendering fails if a placeholder has no value or a value is unused,
so a template and its caller cannot drift apart silently. Substituted values are inserted once and never
re-scanned, so issue text containing `{{...}}` stays literal. What lives where, and how Playbooks are
attached, is described in [`docs/DEVIN-PROMPTS.md`](../docs/DEVIN-PROMPTS.md).

| File | Sent when |
| --- | --- |
| `playbook-triage.md` | Procedure for every bug investigation; synced by setup as the triage Playbook. `{{fixLabel}}`/`{{engineerLabel}}` are rendered with the configured label names. |
| `playbook-repair.md` | Procedure for every repair; synced by setup as the repair Playbook. |
| `playbook-feature.md` | Procedure for every feature; synced by setup as the feature Playbook. |
| `playbook-attached.md` | In a session prompt whose route Playbook is attached by id. |
| `playbook-inline.md` | In a session prompt whose route Playbook is not synced: the Playbook text, once. |
| `investigation-request.md` | A new investigation session is created for a `needs-triage` issue. |
| `open-bugs.md` | In the investigation request: the other open bugs, most recent first, bounded. |
| `open-bugs-none.md` | In the investigation request when there are no other open bugs. |
| `repair-new.md` | A new repair session is created (direct `bug-smasher` label, or approval after the investigation session ended). |
| `repair-continue.md` | Repair is approved while the investigation session is still live; sent to that same session. |
| `verification-retry.md` | Independent verification failed and one retry is allowed; sent to the same session for the same PR branch. |
| `verification-flags.md` | Verification passed but flagged things to look at; sent to the same session, which answers on the pull request. |
| `review-blocker.md` | Devin Review findings could not be sent back for repair while the session is live; sent to that session, which says so on the pull request. |
| `merge-refused.md` | GitHub refused the merge while the session is live; sent to that session, which answers on the pull request. |
| `reply-relay.md` | A person comments on the issue while a session is live; the comment is relayed unchanged. |
| `post-merge-ack.md` | The fix PR was merged while the session is live; sent before the session is stopped. |
| `feature.md` | A `devin-builds-feature` issue is implemented from its acceptance criteria. |
| `structured-output.md` | Shared status block: where Devin communicates and the structured-output contract; included once by every session prompt, reply and retry. |

Route procedures (evidence, fail-first tests, keeping existing tests, never merging, reporting `blocked`
honestly) live in the Playbooks; the session prompts carry the task, a short frame and the status block.
Issue bodies, acceptance criteria, comments, replies and other bugs' titles are quoted as untrusted data
between `BEGIN`/`END` lines.
