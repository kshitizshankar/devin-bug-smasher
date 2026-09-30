# How the service talks to Devin

Every session the service starts gets its task from the issue, its procedure from one Playbook per route,
and its repository rules from `AGENTS.md`. Each kind of guidance has one home:

| Guidance | Lives in | Change it by |
| --- | --- | --- |
| Requirements and acceptance criteria | The GitHub issue | Editing the issue |
| How to triage, repair or build: steps, what "done" looks like, forbidden actions | One Playbook per route: `prompts/playbook-triage.md`, `prompts/playbook-repair.md`, `prompts/playbook-feature.md` | Editing the file, then `npm run setup` and restarting the service |
| Repository conventions, commands and boundaries | `AGENTS.md` (critical rules first; Devin loads the first 16 KiB automatically, and `test/agents-md.test.ts` keeps it under 16,384 bytes) | Editing `AGENTS.md` |
| Stable working agreement | The Knowledge notes pinned to the target (written by `npm run setup`, see [`OPERATOR.md`](OPERATOR.md)) | Changing the settings or pitfalls file, then `npm run setup` |
| The task and the status protocol | The session prompt: the issue text, a short frame and the structured-output block | Editing the templates in `prompts/` (see [`prompts/README.md`](../prompts/README.md)) |

## Session prompts

| Route | Template | Supplies |
| --- | --- | --- |
| Triage | `investigation-request.md` | The issue, people's comments, the other open bugs (`open-bugs.md`, or `open-bugs-none.md` when there are none) |
| Repair | `repair-new.md`, or `repair-continue.md` in the investigation session | The issue, the triage findings (to verify, not to trust) and people's comments |
| Feature | `feature.md` | The acceptance criteria verbatim and people's comments |
| Replies | `reply-relay.md` | A person's comment, unchanged |
| Verification retry | `verification-retry.md` | Why independent verification failed |
| Verification flags | `verification-flags.md` | The findings the verifier flagged on a passing head |
| Review blocker | `review-blocker.md` | Why remaining Devin Review findings could not go back as work |
| Merge refused | `merge-refused.md` | Why GitHub refused a merge the policy decided |
| Session waiting | `session-waiting.md` | Tells a session stopped without a question to ask on the issue itself |

The last four are messages to the bug's session: it acts on them and says so on the pull request, or asks
on the issue what it is waiting for.
Devin writes every comment itself: each route prompt tells it to post its picking-up comment (once per
session), its findings and questions on the issue and the Ready for review comment on its pull request,
from its own GitHub account. The service posts no comments anywhere.

The other open bugs for the duplicate check are every open issue in the repository, labelled or not, other
than feature requests and the bug being triaged, most recent first, at most 20 (`MAX_OTHER_OPEN_BUGS`). The
issues are listed once per cycle, and only when that cycle starts a triage session. If the listing fails, the
list falls back to the issues the cycle already has (those with a workflow label, and tracked bugs).

Shared rules:

- **Where Devin communicates** is written once, in the shared status block `prompts/structured-output.md`,
  and every rendered prompt above includes that block exactly once. The service reads only structured
  output.
- **Untrusted data.** Issue text, acceptance criteria, comments, replies and other bugs' titles are quoted
  between `----- BEGIN … -----` and `----- END … -----` lines and are never treated as instructions.
  Substitution is one pass, so `{{...}}` in issue text stays literal; a template with an unfilled or unused
  placeholder fails to render.

## Playbooks

`npm run setup` syncs one Devin Playbook per route, titled `Bug Smasher <route>: <owner>/<repo>` with
`<route>` one of `triage`, `repair` and `feature`, from the files above. It creates a missing Playbook,
updates one whose body differs, and a second run changes nothing.

When the service starts, it lists the organization's Playbooks and treats a route's Playbook as synced when
exactly one has the route's title and its body matches the file. Then:

- **Synced:** the session is created with that Playbook's `playbook_id`, and the prompt only says that the
  procedure is in the attached Playbook (`playbook-attached.md`). The Playbook text is not inlined.
- **Not synced** (missing, outdated or duplicated, or the list call failed): the session is created without
  a Playbook id, and the prompt contains the Playbook text exactly once (`playbook-inline.md`), so a session
  never starts without its procedure.

A session never receives both. Repair continued in the investigation session is a message, not a new
session, so it always carries the repair Playbook text inline. The service reads Playbook ids once at
startup: after `npm run setup` changes a Playbook, restart the service.
