#!/bin/bash
# Everything that must be green before a commit. Exit status is the verdict.
#   scripts/check.sh            backend, frontend x3, lint, syntax, PHP
#   scripts/check.sh --quick    backend, frontend x1, lint, syntax
#   scripts/check.sh --full     + backend on Python 3.9 and without `cryptography` (docker)
#   scripts/check.sh --results  results only: which checks failed and what they saw,
#                               never a line of test source (the implementer's view,
#                               see agents/README.md); combinable with --quick
# The frontend suite runs several times on purpose: its failures used to
# be intermittent, and one green run proved nothing.
cd "$(dirname "$0")/.." || exit 2
MODE=""; RESULTS=
for a in "$@"; do case "$a" in --results) RESULTS=1;; *) MODE=$a;; esac; done
FRONT_RUNS=3; [ "$MODE" = --quick ] && FRONT_RUNS=1
# Failure details for the implementer: names and messages, no source.
# unittest prints the failing test line and its file; strip both.
show_backend_failures() {
  if [ -n "$RESULTS" ]; then
    grep -E '^(FAIL|ERROR): ' "$1" | sed -E 's/ \(.*//' | head -20
    grep -E '^(AssertionError|[A-Za-z]+Error|Exception)(: |$)' "$1" | grep -vE '^  File' | sort | uniq -c | sort -rn | head -20 | sed -E 's/^ *([0-9]+) /  [\1x] /'
  else
    grep -E '^(FAIL|ERROR):' "$1" | head -20
  fi
}
show_frontend_failures() {
  if [ -n "$RESULTS" ]; then
    # "=== name ===" headers of the scenarios that failed, with their
    # FAIL lines (assertion messages); stack traces are dropped.
    awk '/^=== /{h=$0; shown=0} /^  (FAIL|THREW|UNHANDLED)/{if(!shown){print h; shown=1} print}' "$1" | grep -vE '^\s+at ' | head -40
  else
    grep -E 'FAIL|THREW|UNHANDLED' "$1" | head -10; tail -5 "$1" | grep -v passed
  fi
}
LOG=$(mktemp -d)
fail=0
step() { printf '%-34s' "$1"; }
ok()   { echo "ok    $1"; }
bad()  { echo "FAIL  $1"; fail=1; }
skip() { echo "skip  $1"; }

step "js syntax"
if node --check websh.js 2>"$LOG/js"; then ok; else bad "$(head -3 "$LOG/js")"; fi

step "lint (ruff)"
if command -v ruff >/dev/null; then
  if ruff check . >"$LOG/ruff" 2>&1; then ok; else bad; tail -20 "$LOG/ruff"; fi
else skip "ruff not installed (pip install 'ruff==0.15.*')"; fi

# As a CI runner sees it: no terminal, not inside tmux. A test that
# leaned on the developer's TERM passed here and failed on every push.
step "backend"
if env -u TERM -u TMUX -u TMUX_PANE python3 -m unittest discover -s tests/backend -t . >"$LOG/be" 2>&1; then
  ok "$(grep '^Ran' "$LOG/be") $(tail -1 "$LOG/be")"
else bad "$(tail -1 "$LOG/be")"; show_backend_failures "$LOG/be"; fi

[ -d tests/frontend/node_modules ] || (cd tests/frontend && npm install --no-audit --no-fund >/dev/null 2>&1)
for i in $(seq 1 $FRONT_RUNS); do
  step "frontend (run $i/$FRONT_RUNS)"
  (cd tests/frontend && node test_connect.js >"$LOG/fe$i" 2>&1)
  line=$(grep 'passed:' "$LOG/fe$i" | tail -1)
  # No summary line = the run died; that is a failure, not "no result".
  if echo "$line" | grep -q 'failed: 0$'; then ok "$(echo $line)"
  else bad "${line:-no summary - the run crashed}"; show_frontend_failures "$LOG/fe$i"; fi
done

# Other frontend suites (one file each, same summary format).
for f in tests/frontend/test_*.js; do
  n=$(basename "$f" .js); [ "$n" = test_connect ] && continue
  step "frontend ${n#test_}"
  (cd tests/frontend && node "$n.js" >"$LOG/$n" 2>&1)
  line=$(grep 'passed:' "$LOG/$n" | tail -1)
  if echo "$line" | grep -q 'failed: 0$'; then ok "$(echo $line)"
  else bad "${line:-no summary - the run crashed}"; show_frontend_failures "$LOG/$n"; fi
done

if [ "$MODE" != --quick ]; then
  step "php proxy"
  if command -v php >/dev/null; then
    if php -l api.php >/dev/null 2>"$LOG/php" && bash tests/php/smoke.sh >"$LOG/php" 2>&1; then ok; else bad; tail -5 "$LOG/php"; fi
  elif docker image inspect websh-php-smoke:latest >/dev/null 2>&1; then
    if docker run --rm -v "$PWD":/w -w /w websh-php-smoke:latest sh -c 'php -l api.php >/dev/null && bash tests/php/smoke.sh' >"$LOG/php" 2>&1; then ok "(docker)"; else bad; tail -5 "$LOG/php"; fi
  else skip "no php; build the image: docker build -t websh-php-smoke tests/php"; fi
fi

if [ "$MODE" = --full ]; then
  for leg in "3.9 with" "3.9 without" "3.12 without"; do
    set -- $leg
    step "backend py$1 $2 crypto"
    pre=true; [ "$2" = with ] && pre="pip install -q 'cryptography>=42' >/dev/null 2>&1"
    if docker run --rm -v "$PWD":/w -w /w "python:$1-slim" sh -c "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq openssh-client >/dev/null 2>&1; $pre; python -m unittest discover -s tests/backend -t ." >"$LOG/m" 2>&1
    then ok "$(tail -1 "$LOG/m")"; else bad "$(tail -1 "$LOG/m")"; grep -E '^(FAIL|ERROR):' "$LOG/m" | head; fi
  done
  # An old tmux on the target (Debian 11: 3.1c, no terminal-features):
  # websh's attach chain must still bring the pane up. Only this machine
  # has no such tmux; CI has none either.
  step "tmux 3.1c attach chain"
  if docker run --rm -v "$PWD":/w -w /w python:3.9-slim-bullseye sh -c "apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq tmux >/dev/null 2>&1; tmux -V | grep -q '^tmux 3.1' || { echo 'not tmux 3.1'; exit 1; }; python -m unittest tests.backend.test_tmux_links" >"$LOG/m" 2>&1
  then ok "$(tail -1 "$LOG/m")"; else bad "$(tail -1 "$LOG/m")"; grep -E '^(FAIL|ERROR):' "$LOG/m" | head; fi
fi

echo
if [ $fail = 0 ]; then echo "ALL GREEN"; elif [ -n "$RESULTS" ]; then echo "RED - see the failures above; the tests themselves are the tester's (agents/README.md)"; rm -rf "$LOG"; else echo "RED - do not commit (logs: $LOG)"; fi
exit $fail
