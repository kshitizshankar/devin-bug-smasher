# Architecture

Bug Smasher is one service between GitHub and Devin. People work in GitHub. Devin does the engineering. Bug
Smasher routes the work, checks the result and records what happened.

## The flow

![Take in and triage bugs, then fix the chosen ones](architecture/1-solution.svg)

Work happens in two parts: take in and triage bugs, then fix the ones chosen for a fix. Three questions decide
what moves forward. Which bugs are triaged is always a person's call. Which bugs are fixed, and which fixes are
merged, can be left to a person or handed to a rule.

## Who talks to whom

![People, GitHub, Bug Smasher and Devin](architecture/2-context.svg)

People file bugs, answer questions, decide and merge, all in GitHub. Bug Smasher reads GitHub every minute,
starts and messages Devin sessions, checks fixes in Docker and keeps one record per bug. Devin writes every
comment and opens every pull request itself, from its own GitHub account.

## Stages

![Backlog, Triage, Fix and Merged, with the labels that move a bug](architecture/3-workflow.svg)

Every bug moves through four stages, and labels move it. `needs-triage` starts triage. `bug-smasher` starts a
fix, straight away or after triage. `needs-engineer` sends the bug back to the backlog for a person. The label
names are settings.

## How a fix is proven

![Run 1 without the fix, run 2 with the fix](architecture/4-verification.svg)

Bug Smasher does not take Devin's word that a fix works. It runs Devin's new test twice in the project's own test
image: on the code before the fix, where it must fail, and on the pull request, where it must pass. The example is
the first Superset bug. If the fix silences a lint or type check, the check is flagged for review. After the merge,
the same test runs again on the merged code.

## The service

![People, GitHub, the orchestrator, Devin sessions, the verifier, the store and the results](architecture/5-architecture.svg)

The orchestrator runs one cycle a minute. It reads labelled issues and comments, starts or messages the Devin
session for each bug, sends pull requests to the verifier, and writes labels and commit statuses back to GitHub.
The store holds only what GitHub can't: each bug's stages, decisions, sessions and proofs. The API and the
results pages read from it.

## Inside the service

![Tracker, orchestrator, Devin client, verification and store](architecture/6-components.svg)

The tracker is the only part that talks to GitHub, and the Devin client the only part that talks to Devin, so
another tracker (Linear, Jira) is one more implementation of the same interface. The orchestrator holds the
workflow. Verification runs the diff checks and the two test runs. The store keeps the records the figures come
from. Two guards live here too: no second fix starts while a pull request for the bug is open, and Bug Smasher
records its own label changes so they are never mistaken for a person's decision.

## One bug, end to end

![Every step from label to merge, and who does it](architecture/7-one-bug.svg)

## One Devin session per bug

![A session from triage to merge, working and asleep](architecture/8-devin-session.svg)

A bug keeps the same Devin session from triage to fix, so what Devin learned while investigating carries into
the fix. While a person decides or answers a question, the session sleeps.

## Deployment

![One container on the host, test containers through Docker](architecture/9-deployment.svg)

Bug Smasher runs in one container and only makes outbound HTTPS calls to GitHub and Devin, so it needs no public
address. It starts each test container through the host's Docker. The check workspace has the same path inside
the container and on the host, so those containers can mount it.
