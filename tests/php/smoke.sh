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

# Kernel-assigned ports: parallel CI jobs / dev boxes can't collide.
STUB_OUT=$(mktemp)
UNKNOWN_OUT=$(mktemp)
python3 tests/php/stub_backend.py > "$STUB_OUT" &
STUB_PID=$!
PHP_PID=
trap 'kill $STUB_PID $PHP_PID 2>/dev/null || true; rm -f "$STUB_OUT" "$UNKNOWN_OUT"' EXIT
for i in $(seq 1 50); do [ -s "$STUB_OUT" ] && break; sleep 0.1; done
STUB_PORT=$(head -1 "$STUB_OUT")
[ -n "$STUB_PORT" ] || { echo "stub backend never reported its port"; exit 1; }
PHP_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
# NOTE: if the stub ping ever failed here, api.php's ensure_backend
# would nohup a REAL server.py outside our trap. The echo asserts below
# would all fail loudly in that case, so it can't false-pass — accepted.
# output_buffering=0: a production php.ini buffers 4 KiB, which would
# let a stray notice slip out without breaking the status code.
WEBSH_PORT=$STUB_PORT php -d display_errors=1 -d error_reporting=-1 \
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

echo "PHP proxy smoke: all assertions passed"
