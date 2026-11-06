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

python3 tests/php/test_socket_security.py

# Private temp dir for the backend sockets; kernel-assigned ports for
# php -S, so parallel CI jobs / dev boxes can't collide.
WORK=$(mktemp -d)
STUB_OUT=$WORK/stub.out
UNKNOWN_OUT=$WORK/unknown.out
STUB_SOCK=$WORK/stub.sock
STUB_MARK=$WORK/stream.closed
export STUB_MARK
python3 tests/php/stub_backend.py "$STUB_SOCK" > "$STUB_OUT" &
STUB_PID=$!
PHP_PID=
AUTO_PID=
PLANTED_PID=
SHARED_PID=
BACKEND_PID_FILE=$WORK/backend.pid
cleanup() {
  kill $STUB_PID $PHP_PID $AUTO_PID $PLANTED_PID $SHARED_PID 2>/dev/null || true
  # The private launcher records the exact PID before loading the backend, including
  # when auto-start fails before its first response. Never kill by pattern.
  if [ -s "$BACKEND_PID_FILE" ]; then
    backend_pid=$(cat "$BACKEND_PID_FILE")
    if [[ "$backend_pid" =~ ^[0-9]+$ ]]; then
      kill "$backend_pid" 2>/dev/null || true
      for i in $(seq 1 50); do
        kill -0 "$backend_pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
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


# 5. A well-formed but UNKNOWN action forwards to the backend (this is
#    the zero-PHP-edits contract for new endpoints — the backend owns
#    the 404). The echo stub answers 200 with the request description.
r=$(curl -fsS "http://127.0.0.1:$PHP_PORT/api.php?action=brand_new_endpoint&x=1")
echo "$r" | grep -q '"path": "/api/brand_new_endpoint"' \
  || fail "unknown action not forwarded generically" "$r"
echo "$r" | grep -q 'x=1' || fail "unknown action query passthrough" "$r"

# 6. A MALFORMED action (regex gate) is rejected locally with JSON 404.
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=No.Such%2FAction")
[ "$code" = "404" ] || fail "malformed action status" "$code"
grep -q 'unknown action' "$UNKNOWN_OUT" || fail "malformed action body" "$(cat "$UNKNOWN_OUT")"

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
cp api.php "$WORK/site/www/console/"
cp server.py "$WORK/site/www/console/backend.py"
echo '{}' > "$WORK/site/websh.json"
cat > "$WORK/site/www/console/server.py" <<'LAUNCHER'
import os
from pathlib import Path
import runpy

Path(os.environ['WEBSH_SMOKE_PIDFILE']).write_text(str(os.getpid()))
runpy.run_path(str(Path(__file__).with_name('backend.py')), run_name='__main__')
LAUNCHER
AUTO_PORT=$(free_port)
env -u WEBSH_SOCKET -u WEBSH_CONFIG WEBSH_SMOKE_PIDFILE="$BACKEND_PID_FILE" \
  php -d display_errors=1 -d error_reporting=-1 \
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
pid=$(cat "$BACKEND_PID_FILE")
[[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null \
  || fail "auto-started server.py not found" "no live recorded PID"
# exec() hands php -S's own listening socket down to the child; any
# other listener is one server.py opened.
own_tcp=$(python3 - "$pid" "$AUTO_PORT" <<'PY'
import os
from pathlib import Path
import sys

pid, php_port = sys.argv[1], int(sys.argv[2])
inodes = set()
for fd in Path('/proc', pid, 'fd').iterdir():
    try:
        target = os.readlink(fd)
    except FileNotFoundError:
        continue
    if target.startswith('socket:['):
        inodes.add(target[8:-1])
for protocol in ('tcp', 'tcp6'):
    for line in Path('/proc/net', protocol).read_text().splitlines()[1:]:
        fields = line.split()
        if fields[3] == '0A' and fields[9] in inodes:
            if int(fields[1].split(':')[1], 16) != php_port:
                print(protocol, fields[1])
PY
)
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
PLANTED_PID=
SHARED_PID=
[ "$code" = "500" ] || fail "socket in a shared dir was used" "$code $(cat "$UNKNOWN_OUT")"
grep -q 'writable only by it' "$UNKNOWN_OUT" || fail "shared-dir refusal reason" "$(cat "$UNKNOWN_OUT")"
json_ok "shared-dir refusal" "$(cat "$UNKNOWN_OUT")"
# 7. CSRF gate: a POST whose Origin host differs from the Host header
#    is refused at the shim (the backend never sees browser headers
#    through here). Same-origin and no-Origin (curl) both pass.
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' -X POST \
     -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
     -d '{"session_id":"s1","data":"x"}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=input")
[ "$code" = "403" ] || fail "cross-site POST not refused" "$code $(cat "$UNKNOWN_OUT")"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
     -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PHP_PORT" \
     -d '{"session_id":"s1","data":"x"}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=input")
[ "$code" = "200" ] || fail "same-origin POST refused" "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
     -H 'Content-Type: application/json' -H 'Origin: null' \
     -d '{}' "http://127.0.0.1:$PHP_PORT/api.php?action=input")
[ "$code" = "403" ] || fail "Origin: null not refused" "$code"

# 8. save_delete is POST-only (destructive; a GET is <img>/prefetch bait),
#    and array-shaped query params never reach preg_match/urlencode.
code=$(curl -s -o /dev/null -w '%{http_code}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=save_delete&vault_id=v1&conn_id=c1")
[ "$code" = "405" ] || fail "GET save_delete not refused" "$code"
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' \
     "http://127.0.0.1:$PHP_PORT/api.php?action[]=ping")
[ "$code" = "404" ] || fail "array action status" "$code $(cat "$UNKNOWN_OUT")"
grep -q 'unknown action' "$UNKNOWN_OUT" || fail "array action body" "$(cat "$UNKNOWN_OUT")"
code=$(curl -s -o "$UNKNOWN_OUT" -w '%{http_code}' -X POST \
     "http://127.0.0.1:$PHP_PORT/api.php?action=save_delete&vault_id[]=v1&conn_id=c1")
[ "$code" != "500" ] || fail "array vault_id fatals" "$(cat "$UNKNOWN_OUT")"
grep -q 'Fatal' "$UNKNOWN_OUT" && fail "array vault_id leaks a fatal" "$(cat "$UNKNOWN_OUT")"

# 9. A browser that drops an SSE stream must make the proxy close its
#    backend connection (it used to stay open in the worker forever:
#    409 on every reconnect, terminal output lost into a dead socket).
#    The stub records EPIPE on its side in $STUB_MARK.
rm -f "$STUB_MARK"
curl -s --max-time 1 -o /dev/null "http://127.0.0.1:$PHP_PORT/api.php?action=stream&session_id=stream_probe" || true
closed=
for i in $(seq 1 40); do [ -f "$STUB_MARK" ] && { closed=1; break; }; sleep 0.1; done
[ -n "$closed" ] || fail "backend stream connection not closed after client abort" "no EPIPE seen by the stub within 4s"

# 10. Last-Event-ID (EventSource auto-reconnect cursor) reaches the
#     backend; a non-numeric one is dropped.
r=$(curl -s --max-time 1 -H 'Last-Event-ID: 12345' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=stream&session_id=stream_probe" || true)
echo "$r" | grep -q 'last-event-id=12345' || fail "Last-Event-ID not forwarded" "$r"
r=$(curl -s --max-time 1 -H 'Last-Event-ID: 1; rm' \
     "http://127.0.0.1:$PHP_PORT/api.php?action=stream&session_id=stream_probe" || true)
echo "$r" | grep -q 'last-event-id=-' || fail "junk Last-Event-ID forwarded" "$r"

echo "PHP proxy smoke: all assertions passed"
