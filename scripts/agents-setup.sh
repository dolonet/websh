#!/bin/bash
# Write the tool-specific adapters for the two roles in agents/ (the
# briefs there are the source; edit those, then re-run this).
#   scripts/agents-setup.sh            Claude Code sub-agents (.claude/agents/, not in git)
# Other tools: use agents/implementer.md and agents/tester.md as the
# system prompt of a sub-agent; nothing else is needed.
cd "$(dirname "$0")/.." || exit 2
mkdir -p .claude/agents
{
  printf -- '---\nname: implementer\ndescription: Changes product code (server.py, websh.js, index.html, api.php, docs) from a behaviour report. Never reads tests/. Use for every code change.\n---\n\n'
  cat agents/implementer.md
} > .claude/agents/implementer.md
{
  printf -- '---\nname: tester\ndescription: Owns tests/ and the browser scenarios; writes the failing test first, tries to break fixes, reports results without test source. Use for every test change and every verification.\n---\n\n'
  cat agents/tester.md
} > .claude/agents/tester.md
echo "wrote .claude/agents/implementer.md and .claude/agents/tester.md"
