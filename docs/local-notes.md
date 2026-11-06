# AGENTS.local.md - notes for one machine

`AGENTS.md` is for everyone and lives in git. What is true only on one
machine - or only for its owner - goes into `AGENTS.local.md` next to
it, which git ignores. Every agent and every person is expected to
read it after `AGENTS.md`, so it is the one place for such knowledge:
not a tool's private memory, not a chat.

Suggested sections; keep only the ones that apply.

## The owner
How they want to be talked to (language, length), what they care about
most, what they have pre-authorized (commits? pushes? deploys?) and
what they want to be asked about.

## Deployment
Where it runs, how it is deployed and rolled back, how to see its
health and its logs, what a deploy does to open sessions.

## Credentials
Where each secret comes from at run time (a password manager, a file,
an agent) - never the secret itself. What `tests/e2e/local.env.sh`
reads.

## What must not be touched here
Other people's processes, tmux servers, services, firewall rules;
anything a careless test could take down. Say how to tell a test's
leftovers from real work and how to remove exactly those.

## Tooling
Where the linter, the browser for `tests/e2e`, docker images and the
like are on this machine.

## History worth knowing
Incidents and what they taught, in a few lines each, newest first.
Anything that belongs to the code itself goes to `docs/invariants.md`
instead.
