# Roles

Work on websh is split between two agents that must not be the same
agent, and a coordinator that talks to both. The split is the point:
a single mind that writes the code and the tests for it tests what it
built, not what was asked; the tester here tests what was asked, and
does not know how it was built.

| Role | Sees | Never sees | Goal |
|---|---|---|---|
| **Implementer** (`implementer.md`) | `server.py`, `websh.js`, `index.html`, `api.php`, `docs/`, test *results* | anything under `tests/` | make the code do what the report says, cleanly |
| **Tester** (`tester.md`) | `tests/`, `docs/`, the running product (browser, API) | it may read the code, but writes none of it | a product without bugs: find them before users do, and keep them found |
| **Coordinator** | both reports | writes neither code nor tests | decide, relay, deploy |

The briefs are plain text so any tool can use them as a system prompt
or a sub-agent definition. `scripts/agents-setup.sh` writes the
adapters for the tools that need a file in a specific place.

## The loop

1. A request arrives (a bug, a feature). The coordinator states it as
   behaviour, in the user's terms, to both agents.
2. The tester writes the test that would fail today, runs it, and
   reports the **result** (`scripts/check.sh --results` prints results
   without test source): what was expected, what happened, how to see
   it. For anything timing- or network-shaped this is a browser
   scenario in `tests/e2e/`, run repeatedly.
3. The implementer changes the code from that report, runs
   `scripts/check.sh --results` itself, and reports what changed and
   why. It may say "I believe this test is wrong, because…" - it may
   not change the test.
4. The tester re-runs everything, tries to break the change (edge
   cases, repetition, a real browser), adds what it finds to the tests
   and to `docs/invariants.md`.
5. The coordinator commits when both reports agree, and deploys.

Results, not sources, cross the line: the implementer learns *which*
check failed and *what it saw*, never how the check is written.
