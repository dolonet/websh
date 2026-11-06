# Working on websh

For anyone changing this code - a person or a coding agent of any
kind. Short on purpose: it says where things are and what not to break;
the details live in `docs/`. This file is the only agent instruction
file; `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`
just point here.

## Starting a session

1. Read this file. If `AGENTS.local.md` exists, read it next: it holds
   what is specific to that machine and its owner (where a deployment
   lives, how tests get credentials, what must not be touched there).
   It is git-ignored; create it on a new machine from the section list
   in `docs/local-notes.md`.
2. `git status`, `git log --oneline -10`, and whether anything is
   unpushed: `git rev-list --left-right --count origin/main...main`.
3. Before touching transport, input, reconnect or session code:
   `docs/invariants.md`.
4. Navigate with `scripts/codemap.py`, not by reading the big files whole.
5. Whatever you learn that the code and docs do not record goes into
   the repository (a comment at the code, `docs/invariants.md`, a doc)
   or, if it is machine-specific, into `AGENTS.local.md` - not into a
   tool's private memory, where the next tool cannot see it.

## What it is

A browser SSH terminal. `server.py` (Python, stdlib only) runs each SSH
connection as a PTY child and serves the API and the frontend;
`websh.js` + `index.html` (plain JS, xterm.js from a CDN) are the client;
`api.php` is an optional proxy for shared hosting. Output goes to the
browser over SSE with a long-poll fallback, keys come back as POSTs.
Persistent panes wrap the shell in tmux on the target.

## Hard constraints

- **No build step, no dependencies.** The backend runs on the standard
  library (`cryptography` is optional, for the vault). The frontend is
  one script file. Deployment is "copy four files".
- **`server.py` and `websh.js` stay single files.** They are large; use
  the code map (below) instead of splitting them.
- **Python 3.9** must work: no `match`, no `X | Y` annotations, no
  3.10+ stdlib. CI runs 3.9 and 3.12, each with and without
  `cryptography`.
- **The wire protocol is versioned** (`proto` in `/api/ping`,
  `/api/config`; `docs/protocol.md`). Old cached clients keep talking to
  a new server for hours: additions must be ignorable, removals need a
  version bump.

## Two agents, not one

Code and tests are written by different agents, and the one that
writes the code never sees the tests - only their results
(`scripts/check.sh --results`). The tester's goal is a product without
bugs, not a green suite; the implementer's goal is the behaviour in
the report it was given, nothing more. A coordinator relays reports
between them and is the only one who commits and deploys. The briefs
are in `agents/` (`README.md` has the loop; `implementer.md` and
`tester.md` are the roles, usable as system prompts by any tool;
`scripts/agents-setup.sh` writes tool-specific adapters). A session
that has only one agent still keeps the order: test first, from the
request, then the code, then try to break it.

## Finding your way

    scripts/codemap.py            sections of server.py and websh.js, with line numbers
    scripts/codemap.py server     every class, function and method
    scripts/codemap.py client     every top-level function
    scripts/codemap.py tests      every test class and scenario
    scripts/codemap.py kick       anything whose name contains "kick" - code and tests

Read the map, then the part you need. Both files carry long comments
explaining *why* at the point of the code; trust them over guesses, and
keep them true when you change the code under them.

| Topic | Read |
|---|---|
| What must never break, and what guards it | `docs/invariants.md` |
| Output transport, reconnects, stalls, input | `docs/sse-transport.md` |
| HTTP API | `docs/protocol.md` |
| tmux sessions, re-attach, held keys | `docs/persistent-sessions.md` |
| Threat model, deny-list, rate limits, logs | `docs/security.md` |
| Auth-failure detection | `docs/auth-fail-detection.md` |
| Vault | `docs/encryption.md` |
| Env vars and `websh.json` | `docs/configuration.md`, `docs/server-side-connections.md` |
| Installing, systemd, nginx, Docker | `docs/deployment.md` |

## Commands

    python3 server.py                       run locally (PORT=8765 HOST=127.0.0.1 by env, not flags)
    scripts/check.sh                        everything that must be green; exit status is the verdict
    scripts/check.sh --quick                while iterating
    scripts/check.sh --full                 + the CI matrix in docker (3.9, no cryptography)
    scripts/check.sh --results              failures as results only, no test source (the implementer's view)
    python3 -m unittest tests.backend.test_transport.TestStreamEdges     one backend class
    (cd tests/frontend && node test_connect.js | grep -A8 "=== name")    one frontend test's output
    scripts/e2e.sh                          browser scenarios, private instance (tests/e2e/README.md)
    scripts/e2e.sh --repeat 10 away         hunt a race
    scripts/e2e.sh --url https://host/      the scenarios that are safe against a deployment

## How a change is done

1. **Reproduce first** - the tester writes the failing test, or the
   failing browser scenario for anything that depends on timing or the
   network, from the request, not from the code. If it cannot be
   reproduced, say so; do not fix a guess.
2. The implementer fixes the cause from the tester's report. One
   logical change per commit.
3. **Prove the test guards the fix** (tester): put the old code back
   (`git stash -- file`), watch the test go red, restore. Then try to
   break the fix: edge cases, repetition, a real browser.
4. `scripts/check.sh` - green means `failed: 0` on every run. For
   transport, input, reconnect or session-lifecycle changes also
   `scripts/e2e.sh`.
5. Update the docs the change makes untrue, and `docs/invariants.md`
   when a new "must never happen again" appears.
6. Commit and push, then **look at CI** - it runs what your machine
   cannot (Python 3.9, no `cryptography`, no terminal):
   `gh run list -R <owner>/websh -L 3`. In a checkout with an `upstream`
   remote `gh` may be looking at the wrong repository; pin it once with
   `gh repo set-default`.
7. Deploying is a separate, deliberate step (`scripts/deploy.sh`, which
   deploys `origin/main`, not your tree).

## Rules learned the hard way

- **A green unit suite is not proof for timing.** Four ways of losing
  typed keys passed every unit test and failed one browser run in three.
  Races are proven gone by repetition in a real browser.
- **Report what you measured, not what you expect.** "Deployed" means
  the served file matches the commit; "fixed" means the reproduction
  now passes. If something was not checked, say that.
- **Never restart, kill or reconfigure what you did not start.** Tests
  use a private server instance and a private tmux socket
  (`tmux -L <unique>`). No `tmux kill-server`, no `pkill -f` by pattern
  (it matches your own shell), no restarting a deployment to test.
  Clean up what you started: processes, tmux sessions, firewall rules.
- **Read logs as they are written.** nginx logs a request when it ends,
  so a long stream shows up late; column 10 is the size, not the status.
- **Do not widen a fix into a rewrite.** The comments record why the
  code is the way it is; most "simplifications" reintroduce a bug that
  has a test and an entry in `docs/invariants.md`.
- **Secrets never enter the repository, a commit message or a log.**
  The repository is public. Test credentials come from the environment
  (`tests/e2e/local.env.sh`, not in git).

## Commits

    fix(scope): what the user now sees, as a sentence

    What was wrong and how it showed. What caused it. What the change
    does. How it was verified.

Scopes in use: `input`, `transport`, `stream`, `server`, `auth`, `tmux`,
`vault`, `config`, `upload`, `download`, `file browser`, `docs`,
`test(frontend)`, `test(backend)`. The subject describes behaviour, not
code ("typed text reaches the shell in the order it was typed"). No
co-author or "generated with" trailers.
