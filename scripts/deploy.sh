#!/bin/bash
# Deploy origin/main to a systemd installation of websh and PROVE it.
# Run as root on the websh host:
#     sudo scripts/deploy.sh             deploy
#     sudo scripts/deploy.sh rollback    back to the revision before the last deploy
#
# It deploys what is on origin/main - NOT the working tree. Push first;
# an unpushed commit restarts the old code and looks like a success.
# Layout (docs/deployment.md, "systemd"): checkout in $APP owned by user
# websh, state in /var/lib/websh, unit websh.service.
set -euo pipefail
APP=${WEBSH_APP_DIR:-/opt/websh}
STATE=${WEBSH_STATE_DIR:-/var/lib/websh}
UNIT=${WEBSH_UNIT:-websh}
PORT=${WEBSH_PORT:-8765}

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 2; }
cd "$APP"
PREV=$(git rev-parse HEAD)
echo "previous: $PREV"

if [ "${1:-}" = rollback ]; then
  TARGET=$(cat "$STATE/.deploy_prev" 2>/dev/null || true)
  [ -n "$TARGET" ] || { echo "nothing to roll back to"; exit 1; }
  sudo -u websh git reset -q --hard "$TARGET"
else
  echo "$PREV" > "$STATE/.deploy_prev"
  sudo -u websh git fetch -q origin
  sudo -u websh git checkout -q main 2>/dev/null || sudo -u websh git checkout -q -b main origin/main
  sudo -u websh git reset -q --hard origin/main
  TARGET=$(git rev-parse origin/main)
fi
NOW=$(git rev-parse HEAD)
echo "now:      $NOW  $(git log --format=%s -1 | cut -c1-60)"
[ "$NOW" = "$PREV" ] && echo "note:     same revision as before - did you push?"

# Keep the installed unit in step with the repo's; the drop-in directory
# (websh.service.d/) is left alone.
if ! diff -q "$APP/websh.service" "/etc/systemd/system/$UNIT.service" >/dev/null 2>&1; then
  cp "/etc/systemd/system/$UNIT.service" "$STATE/.$UNIT.service.prev" 2>/dev/null || true
  cp "$APP/websh.service" "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  echo "unit:     updated"
fi

SINCE=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart "$UNIT"

fail=0
up=
for i in $(seq 1 50); do
  if curl -fs --max-time 2 "http://127.0.0.1:$PORT/api/ping" >/dev/null; then up=1; break; fi
  sleep 0.2
done
[ -n "$up" ] && echo "ping:     ok" || { echo "ping:     NO ANSWER"; fail=1; }
[ "$(systemctl is-active "$UNIT")" = active ] && echo "service:  active" || { echo "service:  NOT ACTIVE"; fail=1; }
# What is being served is what is in the checkout.
if [ -n "$up" ]; then
  for f in websh.js index.html; do
    served=$(curl -fs --max-time 5 "http://127.0.0.1:$PORT/$([ $f = index.html ] || echo $f)" | sha256sum | cut -d' ' -f1)
    [ "$served" = "$(sha256sum < "$APP/$f" | cut -d' ' -f1)" ] || { echo "served:   $f DIFFERS from the checkout"; fail=1; }
  done
  [ $fail = 0 ] && echo "served:   matches the checkout"
fi
sleep 2
bad=$(journalctl -u "$UNIT" --since "$SINCE" --no-pager -o cat | grep -E '\[(WARN|ERROR)\]|Traceback' || true)
[ -z "$bad" ] && echo "log:      clean" || { echo "log:      problems since the restart:"; echo "$bad" | head -10; fail=1; }

if [ $fail = 0 ]; then echo "DEPLOYED $NOW"; else echo "DEPLOY HAS PROBLEMS - roll back with: sudo $0 rollback"; fi
exit $fail
