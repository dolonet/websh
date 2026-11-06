# Contributing

Thanks for your interest in websh.

## Submitting PRs

- **Use a feature branch, not your fork's `main`.** Open PRs from `feat/...`, `fix/...`, `docs/...`, etc. PRs whose head branch is `main` will be asked to re-submit — when your `main` diverges from upstream the workflow gets confusing for both sides.
- **One logical change per PR.** Bug fixes, refactors, docs, and unrelated cleanups should be separate PRs. Bundling a refactor under the cover of a hot-fix makes review hard and revert all-or-nothing.
- **Keep descriptions concise.** A single-paragraph summary, a brief test plan, and links if needed. Multi-page narratives of internal review processes belong in commit messages of the relevant commits, not in the PR body.
- **Resolve review comments before merging.** Branch protection requires it.

## Code

- No build step. The frontend (`websh.js`, `index.html`) is plain JS/HTML; the backend (`server.py`) is stdlib-only Python.
- Run tests before opening a PR (CI runs the same set):
  - Backend: `python3 -m unittest discover -s tests/backend -t .`
  - Frontend: `node --check websh.js` and `cd tests/frontend && npm install && npm test` — it must end with `failed: 0`
  - PHP proxy: `php -l api.php && bash tests/php/smoke.sh`
  - Lint: `ruff check .`
- Every bug fix comes with a regression test that fails without the fix.
- Tests must not depend on timing luck: wait for a real signal (an event, a promise, a scripted fake) rather than a fixed sleep, and never touch shared state such as the user's tmux server — use a private socket (`tmux -L <unique name>`).

## Reporting bugs

Open an issue with steps to reproduce, browser/OS, and any relevant network constraints (corporate proxy, VPN, etc.).
