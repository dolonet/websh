# Contributing

Thanks for your interest in websh.

## Submitting PRs

- **Use a feature branch, not your fork's `main`.** Open PRs from `feat/...`, `fix/...`, `docs/...`, etc. PRs whose head branch is `main` will be asked to re-submit — when your `main` diverges from upstream the workflow gets confusing for both sides.
- **One logical change per PR.** Bug fixes, refactors, docs, and unrelated cleanups should be separate PRs. Bundling a refactor under the cover of a hot-fix makes review hard and revert all-or-nothing.
- **Keep descriptions concise.** A single-paragraph summary, a brief test plan, and links if needed. Multi-page narratives of internal review processes belong in commit messages of the relevant commits, not in the PR body.
- **Resolve review comments before merging.** Branch protection requires it.

## Code

- No build step. The frontend (`websh.js`, `index.html`) is plain JS/HTML; the backend (`server.py`) is stdlib-only Python.
- Start with [`AGENTS.md`](AGENTS.md): where things are, the constraints, how a change is done. `scripts/codemap.py` shows where things are in the two big files.
- Before opening a PR run `scripts/check.sh` - it must end with `ALL GREEN`. For changes to the transport, input, reconnects or the session lifecycle also run the browser scenarios, `scripts/e2e.sh` ([`tests/e2e/README.md`](tests/e2e/README.md)).
- Every bug fix comes with a regression test that fails without the fix.
- Tests must not depend on timing luck: wait for a real signal (an event, a promise, a scripted fake) rather than a fixed sleep, and never touch shared state such as the user's tmux server - use a private socket (`tmux -L <unique name>`).
- [`docs/invariants.md`](docs/invariants.md) lists behaviour that was broken once and must not break again.

## Reporting bugs

Open an issue with steps to reproduce, browser/OS, and any relevant network constraints (corporate proxy, VPN, etc.).
