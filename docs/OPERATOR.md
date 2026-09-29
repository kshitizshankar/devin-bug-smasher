# Operator commands

Repeatable commands for setting up and operating Bug Smasher against one target repository
(`GITHUB_REPO`). They share the service's settings (`.env.example`, [`docs/MODEL.md`](MODEL.md#settings)).

```sh
npm start                                   # run: HTTP service, plus workflow polling when live settings are complete
npm run setup -- --dry-run                  # list every change setup would make; writes nothing
npm run setup                               # configure GitHub and Devin for the target
npm run env-status                          # latest Devin environment build, step by step
npm run env-status -- <build_id>            # one build
npm run mirror -- owner/repo#N --dry-run    # show the issue mirror would create; writes nothing
npm run mirror -- owner/repo#N              # copy an issue into the target, no labels
npm run mirror -- owner/repo#N --triage     # ... and add TRIAGE_LABEL (needs-triage)
npm run mirror -- owner/repo#N --fix        # ... and add FIX_LABEL (bug-smasher)
npm run report                              # write RESULTS.md from data/bugs.json
npm run report -- --store FILE --out FILE
```

All commands are also available as `node src/operator/main.ts <command>`; `run` there is the same as
`npm start`. Exit codes: `0` success, `1` the command failed or found a problem (for `env-status`: the build
is not a clean success), `2` bad arguments or settings. Output and errors never contain `GITHUB_TOKEN`,
`DEVIN_API_KEY` or other credential-shaped values.

## run

Starts the HTTP service (dashboard and `/api/health`) first, then the orchestrator. Missing live settings
(`GITHUB_REPO`, `GITHUB_TOKEN`, `DEVIN_API_KEY`, `DEVIN_ORG_ID`, `CHECK_COMMAND`) switch workflow polling
off with a logged reason; the service still starts. With complete settings the orchestrator polls every
`POLL_SECONDS`. The dashboard stays read-only: every change goes through GitHub labels and comments, or
through these commands.

## setup

Setup reads current state, plans only what differs, and then applies the plan (or, with `--dry-run`, prints
it). Running it again with nothing changed prints `Nothing to change` and writes nothing. It never deletes
anything, and never reads or writes resources of other repositories or organization-wide resources.

In order:

1. **Devin repository access.** `GET /v3beta1/organizations/{org_id}/repositories?only_repo_paths=<target>`.
   If the target is not listed, setup stops before planning or changing anything and names the Devin web-app
   setting that grants access: **Settings > Connections > GitHub** (the Devin GitHub App's repository
   selection), or **Settings > Repositories** for enterprise accounts. The Devin API has no access-grant
   operation and setup does not try one.
2. **GitHub labels.** `TRIAGE_LABEL`, `FIX_LABEL`, `ENGINEER_LABEL` and `FEATURE_LABEL`
   (`devin-builds-feature`), each with a fixed color and description. A label is matched by name without
   regard to case; only a label whose exact name, color or description differs is updated. Other labels are
   never changed.
3. **GitHub issue form.** `.github/ISSUE_TEMPLATE/bug-smasher-bug.yml` on the default branch, committed only
   when missing or different.
4. **Devin triage Playbook** titled `Bug Smasher triage: <owner>/<repo>`, with the body of
   `prompts/investigation-playbook.md`. Playbooks are organization objects in Devin; setup only ever
   considers the one with this exact title and stops if there are several.
5. **Knowledge notes pinned to the target** (`pinned_repo`), matched by name among the target's pinned
   notes only; unpinned notes and notes pinned to other repositories are never considered:
   - `Bug Smasher: fast tests` – `CHECK_COMMAND` and `VERIFY_SETUP_COMMAND` as configured.
   - `Bug Smasher: verification image` – `VERIFY_IMAGE` and how the independent verifier runs tests
     ([`docs/VERIFICATION.md`](VERIFICATION.md)).
   - `Bug Smasher: observed pitfalls` – copied line by line from `setup/pitfalls.md` (or `--pitfalls FILE`).
     Write only pitfalls actually observed in the target; without the file the note says none are recorded.

   The notes contain nothing beyond this configuration and that file, and each ends by deferring to the
   target's `AGENTS.md`.
6. **Repository indexing**, enabled when not already enabled (`PUT …/repositories/{repo}/indexing`).
7. **Environment blueprint** for the target, from `setup/blueprint.yaml` (or `--blueprint FILE`; required).
   The current blueprint's YAML is downloaded and compared; it is created (which also adds the repository to
   the Devin environment) or updated only when different. Only a `repo` blueprint whose `repo_name` is the
   target is considered; organization and enterprise blueprints are never changed.
8. **Environment build**, triggered only when the blueprint was created or updated (updating a blueprint
   does not start a build by itself). Check it with `env-status`.

If a step fails part-way, the steps already printed as `done` stay applied; fix the cause and run setup
again: it continues from the current state.

## env-status

Reads a build (`GET …/snapshot-setup/builds/{id}`, or the most recent from `GET …/snapshot-setup/builds`)
and its log (`GET …/builds/{id}/logs`, a short-lived presigned link that is downloaded without the Devin
key). The log is read step by step (`src/operator/build-log.ts`) and every recognised step is printed with
its outcome, nesting and exit code. A nested step that failed is reported even when Devin reports the build
as `succeeded`, because a build can produce a usable snapshot while repository setup steps fail. The command
exits `0` only for a succeeded build whose log shows recognised steps and none failed; a log with no
recognised steps is reported as unknown, never as clean.

## mirror

Reads `owner/repo#N` from any repository the token can read and creates one issue in the target with the
same title and body, a provenance line (source link, author, date) and a
`<!-- bug-smasher mirror-of=owner/repo#N -->` marker. Plain mirroring adds no labels; `--triage` or `--fix`
add exactly that label at creation. Before creating, every target issue (open and closed) is checked for the
marker: a repeat reports the existing mirror as a duplicate and creates or changes nothing. The source is
only read; the target is the only repository written.

## report

Writes `RESULTS.md` from the bug store records: one row per record with its key, kind, stage, route, fix
pull request, verification results and last update. It calculates no metrics and prints no figures that are
not in a record; an empty store says there is nothing to report.

## Permissions

GitHub token (`GITHUB_TOKEN`; a fine-grained token limited to the target repository is enough for setup):

| Command | Target repository | Other repositories |
| --- | --- | --- |
| `setup` | Issues: read and write (labels); Contents: read and write (issue form commit); Metadata: read | none |
| `mirror` | Issues: read and write | Issues: read on the source (public issues need no extra grant) |
| `run` | As in [`docs/TRACKER.md`](TRACKER.md) and [`docs/ORCHESTRATION.md`](ORCHESTRATION.md) | none |

Devin API key (`DEVIN_API_KEY`, a service user in `DEVIN_ORG_ID`), per the Devin API reference:

| Operation | Permission |
| --- | --- |
| List repositories (access check), indexing status | `Read` on the organization |
| Enable indexing | `Read` plus the repository indexing grant |
| List Playbooks / Knowledge notes | `UseDevinSessions` |
| Create or update Playbooks | `ManageOrgPlaybooks` |
| Create or update Knowledge notes | `ManageOrgKnowledge` |
| Blueprints, their contents, builds and build logs | `ManageRepoBlueprints` |

`env-status` needs only the blueprint/build read permission; `report` needs no credentials.

## Live setup checks

CI never runs setup against live providers. After configuring credentials, an operator checks:

1. `npm run setup -- --dry-run` lists the expected changes for the target and nothing else.
2. `npm run setup` finishes; if it stops on repository access, grant it in the Devin web app as printed and
   rerun.
3. `npm run setup` again prints `Nothing to change`.
4. `npm run env-status` until the build finishes; it must exit `0`. Investigate any failed step it lists,
   even when Devin reports success, by reading the full log in the Devin web app.
5. In GitHub, the four labels exist and **New issue** offers the Bug Smasher bug form.
6. In the Devin web app, the Playbook, the three pinned Knowledge notes and the target's blueprint appear,
   and no other Playbook, note or blueprint changed.
7. `npm run mirror -- <a public issue> --dry-run`, then without `--dry-run`, then once more to see the
   duplicate report.

## Unsupported operations and limitations

- **Repository access** is granted only in the Devin web app (Settings > Connections > GitHub, or Settings >
  Repositories); the API has no grant operation.
- **Build log format** is not documented: the API returns a presigned link to a file. `env-status`
  recognises JSON Lines step records and `step <name>: <outcome>` text lines; if Devin's log uses neither,
  the steps are reported as unknown (exit `1`) and the log must be read in the web app.
- **Builds are organization-wide.** The build endpoint takes no repository, so a triggered build rebuilds
  the organization's environment snapshot. Setup triggers one only when the target's blueprint changed.
- **Blueprint listing filter.** Whether `repo_name` filters the list is not documented, so setup filters the
  result itself.
- **Nothing is deleted.** Renamed labels, notes or Playbooks created under other names are left in place.
- **Playbook macros** are kept as they are; setup does not set one.
