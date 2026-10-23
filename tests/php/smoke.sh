#!/usr/bin/env bash
# Behavioral smoke for the PHP proxy. `php -l` only catches syntax; this
# boots api.php under `php -S` against an echo backend and asserts the
# proxy contract: method/query/body passthrough, the X-Forwarded-For
# injection, the save_delete POST->DELETE translation, status
# forwarding and the streaming helpers. PHP runs with every error class
# displayed, so a stray notice or deprecation (e.g. curl_close() on
# PHP 8.5) lands in the body and fails the strict JSON check.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Private temp dir for the backend sockets; kernel-assigned ports for
# php -S, so parallel CI jobs / dev boxes can't collide.
WORK=$(mktemp -d)
STUB_OUT=$WORK/stub.out
UNKNOWN_OUT=$WORK/unknown.out
STUB_SOCK=$WORK/stub.sock
python3 tests/php/stub_backend.py "$STUB_SOCK" > "$STUB_OUT" &
STUB_PID=$!
PHP_PID=
AUTO_PID=
PLANTED_PID=
SHARED_PID=
cleanup() {
  kill $STUB_PID $PHP_PID $AUTO_PID $PLANTED_PID $SHARED_PID 2>/dev/null || true
  # The backend api.php auto-starts in step 8 runs from its own copy;
  # give its SIGTERM shutdown a moment before removing the tree.
  pkill -f "$WORK/site/www/console/server.py" 2>/dev/null || true
  for i in $(seq 1 50); do
    pgrep -f "$WORK/site/www/console/server.py" >/dev/null || break
    sleep 0.1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
for i in $(seq 1 50); do [ -s "$STUB_OUT" ] && break; sleep 0.1; done
[ -S "$STUB_SOCK" ] || { echo "stub backend never bound $STUB_SOCK"; exit 1; }
free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
PHP_PORT=$(free_port)
# NOTE: if the stub ping ever failed here, api.php's ensure_backend
# would nohup a REAL server.py; it refuses a socket the stub still
# holds, and the echo asserts below would fail loudly otherwise.
# output_buffering=0: a production php.ini buffers 4 KiB, which would
# let a stray notice slip out without breaking the status code.
WEBSH_SOCKET=$STUB_SOCK php -d display_errors=1 -d error_reporting=-1 \
  -d output_buffering=0 -S 127.0.0.1:$PHP_PORT -t . >/dev/null 2>&1 &
PHP_PID=$!

up=
for i in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=ping" >/dev/null 2>&1 && { up=1; break; }
  sleep 0.1
done
[ -n "$up" ] || { echo "SMOKE FAIL: php -S never became ready on :$PHP_PORT"; exit 1; }

fail() { echo "SMOKE FAIL: $1"; echo "  got: $2"; exit 1; }
# The stub always answers JSON, so anything PHP prints around the
# backend body shows up as a parse failure.
json_ok() {
  printf '%s' "$2" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null \
    || fail "$1: response is not clean JSON" "$2"
}

# 1. ping proxies through (and proves ensure_backend saw a live backend).
r=$(curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=ping")
echo "$r" | grep -q '"ok"' || fail "ping not proxied" "$r"
json_ok ping "$r"

# 2. POST body + Content-Type + X-Forwarded-For passthrough.
r=$(curl -fsS -X POST -H 'Content-Type: application/json' \
     -d '{"session_id":"s1","data":"x"}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=input")
echo "$r" | grep -q '"method": "POST"' || fail "input method" "$r"
echo "$r" | grep -q '"path": "/api/input"' || fail "input path" "$r"
# The stub JSON-escapes the echoed body; match the exact escaped form.
echo "$r" | grep -F -q '{\"session_id\":\"s1\",\"data\":\"x\"}' \
  || fail "input body passthrough" "$r"
echo "$r" | grep -q '"xff": "127.0.0.1"' || fail "X-Forwarded-For injection" "$r"
echo "$r" | grep -q 'application/json' || fail "content-type passthrough" "$r"
json_ok input "$r"

# 3. GET query passthrough.
r=$(curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=output&session_id=abc-123")
echo "$r" | grep -q '"path": "/api/output"' || fail "output path" "$r"
echo "$r" | grep -q 'session_id=abc-123' || fail "output query passthrough" "$r"
json_ok output "$r"

# 4. save_delete translates POST -> DELETE /api/save and forwards the
#    identifiers as query params (api.php reads $_GET, not the body).
r=$(curl -fsS -X POST \
     "http://127.0.0.1:$PHP_PORT/api.php?action=save_delete&vault_id=v1&conn_id=c1")
echo "$r" | grep -q '"method": "DELETE"' || fail "save_delete method translation" "$r"
echo "$r" | grep -q '"path": "/api/save"' || fail "save_delete path" "$r"
echo "$r" | grep -q 'vault_id=v1' || fail "save_delete vault_id query passthrough" "$r"
echo "$r" | grep -q 'conn_id=c1' || fail "save_delete conn_id query passthrough" "$r"
json_ok save_delete "$r"

# 5. Unknown action handled by api.php itself with a JSON 404.
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=nope")
[ "$code" = "404" ] || fail "unknown action status" "$code"
grep -q 'unknown action' "$UNKNOWN_OUT" || fail "unknown action body" "$(cat "$UNKNOWN_OUT")"
json_ok "unknown action" "$(cat "$UNKNOWN_OUT")"

# 6. A backend error status reaches the browser unchanged (the stub
#    answers session_id=gone with 404, like an expired session).
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=output&session_id=gone")
[ "$code" = "404" ] || fail "backend status passthrough" "$code $(cat "$UNKNOWN_OUT")"
json_ok "backend 404" "$(cat "$UNKNOWN_OUT")"

# 7. The streaming helpers (upload, download, SSE) pass the backend body
#    through with nothing added.
r=$(curl -fsS -X POST -H 'Content-Type: application/octet-stream' \
     --data-binary 'file-bytes' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=upload&session_id=s1&path=/tmp/f")
echo "$r" | grep -q '"path": "/api/upload"' || fail "upload path" "$r"
echo "$r" | grep -q '"body": "file-bytes"' || fail "upload body passthrough" "$r"
json_ok upload "$r"
r=$(curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=download&session_id=s1&path=/tmp/f")
echo "$r" | grep -q '"path": "/api/download"' || fail "download path" "$r"
json_ok download "$r"
r=$(curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=stream&session_id=s1")
echo "$r" | grep -q '"path": "/api/stream"' || fail "stream path" "$r"
json_ok stream "$r"

# 8. Auto-start, end to end: with no WEBSH_SOCKET, api.php starts the
#    real server.py on websh.sock next to websh.json (two levels up, in
#    the documented layout), owner-only, and the backend opens no TCP
#    port.
mkdir -p "$WORK/site/www/console"
cp api.php server.py "$WORK/site/www/console/"
echo '{}' > "$WORK/site/websh.json"
AUTO_PORT=$(free_port)
env -u WEBSH_SOCKET -u WEBSH_CONFIG php -d display_errors=1 -d error_reporting=-1 \
  -d output_buffering=0 -S 127.0.0.1:$AUTO_PORT -t "$WORK/site/www" >/dev/null 2>&1 &
AUTO_PID=$!
r=
for i in $(seq 1 100); do
  r=$(curl -fsS "http://127.0.0.1:$AUTO_PORT/console/api.php?action=ping" 2>/dev/null) && break
  r=
  sleep 0.1
done
echo "$r" | grep -q '"proto"' || fail "auto-started backend did not answer ping" "$r"
json_ok "auto-start ping" "$r"
[ -S "$WORK/site/websh.sock" ] || fail "no socket next to websh.json" "$(ls -la "$WORK/site")"
mode=$(stat -c %a "$WORK/site/websh.sock")
[ "$mode" = "600" ] || fail "backend socket is not owner-only" "$mode"
pid=$(pgrep -f "$WORK/site/www/console/server.py" | head -1)
[ -n "$pid" ] || fail "auto-started server.py not found" "$(ps aux | grep server.py)"
# exec() hands php -S's own listening socket down to the child; any
# other listener is one server.py opened.
command -v ss >/dev/null || fail "ss is needed for the TCP-listener check" ""
own_tcp=$(ss -Hltnp 2>/dev/null | grep "pid=$pid," | grep -v "127.0.0.1:$AUTO_PORT " || true)
[ -z "$own_tcp" ] || fail "auto-started backend listens on TCP" "$own_tcp"

# 9. A socket path in a directory other users can write is refused
#    before anything is sent: a co-tenant could have planted the socket.
mkdir -m 777 "$WORK/shared"
chmod 777 "$WORK/shared"
python3 tests/php/stub_backend.py "$WORK/shared/websh.sock" > "$WORK/planted.out" &
PLANTED_PID=$!
for i in $(seq 1 50); do [ -S "$WORK/shared/websh.sock" ] && break; sleep 0.1; done
SHARED_PORT=$(free_port)
WEBSH_SOCKET=$WORK/shared/websh.sock php -d display_errors=1 -d error_reporting=-1 \
  -d output_buffering=0 -S 127.0.0.1:$SHARED_PORT -t . >/dev/null 2>&1 &
SHARED_PID=$!
code=
for i in $(seq 1 50); do
  code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' \
       "http://127.0.0.1:$SHARED_PORT/api.php?action=ping" 2>/dev/null) && [ "$code" != "000" ] && break
  sleep 0.1
done
kill $PLANTED_PID $SHARED_PID 2>/dev/null || true
[ "$code" = "500" ] || fail "socket in a shared dir was used" "$code $(cat "$UNKNOWN_OUT")"
grep -q 'writable only by it' "$UNKNOWN_OUT" || fail "shared-dir refusal reason" "$(cat "$UNKNOWN_OUT")"
json_ok "shared-dir refusal" "$(cat "$UNKNOWN_OUT")"

echo "PHP proxy smoke: all assertions passed"
