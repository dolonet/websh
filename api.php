<?php
/**
 * websh — PHP proxy.
 *
 * Forwards AJAX requests from the browser to the Python REST API
 * over a Unix socket. This allows all traffic to flow through
 * the hosting provider's HTTPS — no exposed ports, no WebSocket.
 *
 * Requires the curl extension, plus exec() and python3 for auto-start.
 * Run it on a PHP release that still gets security fixes — see
 * "Keep PHP patched" in docs/deployment.md.
 */

// HTTPS enforcement via reverse proxy headers.
$proto = isset($_SERVER['HTTP_X_FORWARDED_PROTO']) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : '';
if ($proto === 'http') {
    header('Location: https://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'], true, 301);
    exit;
}

// `?action[]=x` arrives as an array; PHP 8's preg_match() then throws
// a TypeError - an uncaught fatal that, with display_errors on, prints
// this file's absolute path to the client. Non-strings are simply "no
// such action" (the regex gate below turns '' into a 404).
$action  = (isset($_GET['action']) && is_string($_GET['action'])) ? $_GET['action'] : '';

// SSE stream needs a longer execution window than the JSON endpoints.
// Some shared hosts cap this hard, in which case the stream is killed
// after the cap and the browser falls back to long-poll automatically.
if ($action === 'stream') {
    @set_time_limit(0);
} else {
    @set_time_limit(55);
}

if (!extension_loaded('curl')) {
    config_error('PHP curl extension is required');
}
if (!defined('CURLOPT_UNIX_SOCKET_PATH')) {
    config_error('PHP curl lacks Unix socket support (needs PHP 7.0.7+ and libcurl 7.40+)');
}

if ($action !== 'stream') {
    header('Content-Type: application/json');
    header('Cache-Control: no-cache, no-store, must-revalidate');
}

// Path to config file (must be OUTSIDE the web root for security).
$WEBSH_CONFIG = getenv('WEBSH_CONFIG') ?: dirname(__FILE__) . '/../../websh.json';

// Action gate: lowercase identifiers only, so the action can never
// smuggle path segments or query metacharacters into the backend URL.
// /D pins $ to the very end — without it PCRE's $ matches before a
// trailing \n, letting action=config%0a smuggle a raw LF into the
// request line on old libcurl. Gate sits BEFORE ensure_backend so
// garbage requests can't trigger the ping/auto-start machinery.
if (!preg_match('/^[a-z_]{1,32}$/D', $action)) {
    header('HTTP/1.1 404 Not Found');
    echo '{"error":"unknown action"}';
    exit;
}

// CSRF gate for state-changing methods. The shim forwards no browser
// headers to the backend, so the backend's own Origin check never sees
// a cross-site request that came through here - it must be enforced at
// this hop. A browser sends Origin on every cross-site POST/DELETE; an
// Origin whose host is not the host this request was addressed to is a
// forged request. No Origin at all means a non-browser client (not a
// CSRF victim) and passes; `Origin: null` never legitimately posts here.
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
if (($method === 'POST' || $method === 'DELETE') && isset($_SERVER['HTTP_ORIGIN'])) {
    $o_host = strtolower((string) parse_url(trim($_SERVER['HTTP_ORIGIN']), PHP_URL_HOST));
    $o_port = parse_url(trim($_SERVER['HTTP_ORIGIN']), PHP_URL_PORT);
    if ($o_port) { $o_host .= ':' . $o_port; }
    $allowed = array(strtolower(isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : ''));
    if (!empty($_SERVER['HTTP_X_FORWARDED_HOST'])) {
        $fwd = explode(',', $_SERVER['HTTP_X_FORWARDED_HOST']);
        $allowed[] = strtolower(trim($fwd[0]));
    }
    if ($o_host === '' || !in_array($o_host, $allowed, true)) {
        header('HTTP/1.1 403 Forbidden');
        echo '{"error":"cross-site request refused"}';
        exit;
    }
}

// The backend listens on a Unix socket, not a TCP port: on shared
// hosting 127.0.0.1 is common to every account, so any co-tenant could
// reach a TCP backend past the web server's auth (and use the
// server-side connections in websh.json), or take the port while the
// backend is down and receive what users type. server.py creates the
// socket 0600 next to websh.json, outside the web root, so only this
// account can connect to it or create it there.
$config_dir = @realpath(dirname($WEBSH_CONFIG)) ?: dirname($WEBSH_CONFIG);
$WEBSH_SOCKET = trim((string) getenv('WEBSH_SOCKET')) ?: $config_dir . '/websh.sock';
// Resolve and USE the same directory we validate. Keeping an original
// symlink alias would let its owner retarget curl after the check.
$socket_dir = @realpath(dirname($WEBSH_SOCKET));
if ($socket_dir === false) {
    config_error('cannot resolve the backend socket directory (open_basedir?); '
        . 'set WEBSH_SOCKET to an accessible directory this account owns');
}
$WEBSH_SOCKET = $socket_dir . '/' . basename($WEBSH_SOCKET);
// sun_path holds 107 bytes; past that bind() and connect() just fail.
if (strlen($WEBSH_SOCKET) > 107) {
    config_error('backend socket path is too long; set WEBSH_SOCKET to a '
        . 'shorter path in a directory only this account can write');
}
$problem = socket_path_problem($WEBSH_SOCKET);
if ($problem !== '') {
    config_error($problem);
}
// Only the Host header sees this; the connection goes to the socket.
$BACKEND = 'http://localhost';

// Auto-start: launch server.py if it's not running.
ensure_backend($BACKEND, $WEBSH_CONFIG, $WEBSH_SOCKET);

// Forward the browser's full query string (the backend ignores the
// redundant `action` parameter). Rebuilding per-action parameter lists
// here is what used to make every new endpoint require a PHP edit.
$QS  = isset($_SERVER['QUERY_STRING']) ? $_SERVER['QUERY_STRING'] : '';
$URL = $BACKEND . '/api/' . $action . ($QS !== '' ? '?' . $QS : '');

switch ($action) {
    // Transfer modes with their own curl plumbing (streaming, raw
    // bodies, delayed header commit) keep explicit cases:
    case 'stream':   proxy_stream($URL);   break;
    case 'download': proxy_download($URL); break;
    case 'upload':   proxy_upload($URL);   break;
    case 'save_delete':
        // Browsers can't issue DELETE through form posts, so the
        // client POSTs here and we translate to a real backend DELETE.
        // POST only: this is destructive, and a GET would make it
        // reachable from an <img src>, a link prefetch or a scanner.
        if ($method !== 'POST') {
            header('HTTP/1.1 405 Method Not Allowed');
            header('Allow: POST');
            echo '{"error":"method not allowed"}';
            break;
        }
        $vault = (isset($_GET['vault_id']) && is_string($_GET['vault_id'])) ? $_GET['vault_id'] : '';
        $conn  = (isset($_GET['conn_id'])  && is_string($_GET['conn_id']))  ? $_GET['conn_id']  : '';
        proxy_delete($BACKEND . '/api/save'
            . '?vault_id=' . urlencode($vault)
            . '&conn_id='  . urlencode($conn));
        break;
    default:
        // Everything else is a JSON endpoint: forward the method, the
        // query string and (for POST) the body verbatim. A new backend
        // endpoint needs NO change here — an unknown action is the
        // backend's 404 to give.
        proxy_pass($URL);
        break;
}

// ── Helpers ──────────────────────────────────────────────────────────

// A deployment problem only the operator can fix: 500 with the reason.
function config_error($msg) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(array('error' => $msg));
    exit;
}

// A socket path other accounts can create files at is a trap: a
// co-tenant plants a socket there first and receives what users type.
// Check the whole resolved chain: a private leaf inside a renameable
// ancestor is still unsafe. Root-owned sticky ancestors such as /tmp
// protect the next account-owned entry, but the leaf itself must never
// be writable by a group or other users.
function process_uid() {
    if (function_exists('posix_geteuid')) return posix_geteuid();
    // getmyuid() is the SCRIPT owner's uid, not the PHP worker's uid.
    // The kernel stamps a newly created file with the worker's owner.
    // fstat uses our open handle, so replacing its pathname cannot fool
    // this fallback. Core PHP needs no optional POSIX extension here.
    $probe = @tmpfile();
    if ($probe === false) return false;
    $info = @fstat($probe);
    fclose($probe);
    return is_array($info) && isset($info['uid']) ? $info['uid'] : false;
}

// Returns the problem, or '' when the path is safe.
function socket_path_problem($socket) {
    $uid = process_uid();
    if ($uid === false) {
        return 'cannot determine the PHP worker uid; enable posix_geteuid '
            . 'or allow PHP to create a temporary file';
    }
    $directory = @realpath(dirname($socket));
    $dir = $directory === false ? false : @stat($directory);
    if (!$dir) {
        return 'cannot access the backend socket directory (open_basedir?); '
            . 'set WEBSH_SOCKET to a path in a directory this account owns';
    }
    if ($dir['uid'] !== $uid || ($dir['mode'] & 0022)) {
        return 'the backend socket directory must belong to this account '
            . 'and be writable only by it; set WEBSH_SOCKET';
    }
    for ($current = $directory; ; $current = dirname($current)) {
        $info = @stat($current);
        if (!$info || ($info['uid'] !== 0 && $info['uid'] !== $uid)
                || (($info['mode'] & 0022)
                    && !($info['uid'] === 0 && ($info['mode'] & 01000)))) {
            return 'the backend socket directory has an unsafe ancestor; '
                . 'use a path owned by this account or root, without group '
                . 'or other-user writes (root-owned sticky ancestors are allowed)';
        }
        if (dirname($current) === $current) break;
    }
    $node = @lstat($socket);
    if ($node !== false) {
        if (($node['mode'] & 0170000) !== 0140000) {
            return 'the backend socket path exists and is not a socket';
        }
        if ($node['uid'] !== $uid) {
            return 'the backend socket belongs to another user';
        }
    }
    return '';
}

// Headers every proxied backend request must carry. The X-Forwarded-For
// is the load-bearing one: all backend calls come from this PHP process
// over the socket, so without it the server sees every browser client
// as the loopback address and the entire per-IP defense layer collapses
// to a single shared bucket — one client exhausts RATE_LIMIT_MAX for
// everyone, MAX_SESSIONS_PER_IP caps all users combined, and the access
// log records 127.0.0.1 for every connect. The backend trusts only the
// FIRST token of X-Forwarded-For from a trusted proxy (any client of
// its socket), so we send exactly one token and OVERWRITE rather than
// append. REMOTE_ADDR is the real client on the typical shared-hosting
// layout where PHP faces the browser directly; if PHP itself sits behind
// another proxy, configure that proxy to populate REMOTE_ADDR.
function backend_headers($extra = array()) {
    $h = $extra;
    if (!empty($_SERVER['REMOTE_ADDR'])) {
        $h[] = 'X-Forwarded-For: ' . $_SERVER['REMOTE_ADDR'];
    }
    return $h;
}

// Every backend request goes over the socket.
function backend_curl($url) {
    global $WEBSH_SOCKET;
    $ch = curl_init($url);
    if (!curl_setopt($ch, CURLOPT_UNIX_SOCKET_PATH, $WEBSH_SOCKET)) {
        // libcurl built without Unix sockets: never fall back to TCP.
        config_error('PHP curl cannot connect to Unix sockets');
    }
    return $ch;
}

// curl_close() only frees the handle before PHP 8.0; since then handles
// are objects freed when they go out of scope, and 8.5 deprecates the
// call. Hosts with display_errors on would print that notice into the
// JSON body — and with output buffering off also lose the status code
// to "headers already sent".
function release_curl($ch) {
    if (PHP_VERSION_ID < 80000) curl_close($ch);
}

function ping_backend($backend) {
    $ch = backend_curl($backend . '/api/ping');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 2);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 1);
    $ok = curl_exec($ch) !== false;
    release_curl($ch);
    return $ok;
}

// Generic JSON-endpoint passthrough. Forwards REQUEST_METHOD, the full
// query string (already in $url) and, for POST, the raw body. Timeouts
// match the old per-mode helpers: GET 50s (the /api/output long-poll
// parks up to ~10s and proxies may add latency), POST 30s, DELETE 10s.
function proxy_pass($url) {
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    if ($method !== 'GET' && $method !== 'POST' && $method !== 'DELETE') {
        // Old proxy_post silently coerced e.g. PUT into a backend POST;
        // answer 405 instead of guessing.
        header('HTTP/1.1 405 Method Not Allowed');
        echo '{"error":"method not allowed"}';
        return;
    }
    $ch = backend_curl($url);
    $extra = array();
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input'));
        $extra[] = 'Content-Type: application/json';
        $timeout = 30;
    } elseif ($method === 'DELETE') {
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'DELETE');
        $timeout = 10;
    } else {
        $timeout = 50;
    }
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers($extra));
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err  = curl_error($ch);
    release_curl($ch);
    if ($resp === false) {
        header('HTTP/1.1 502 Bad Gateway');
        echo json_encode(array('error' => 'backend unavailable: ' . $err));
        return;
    }
    if ($code) http_response_code($code);
    echo $resp;
}

function proxy_upload($url) {
    $len = isset($_SERVER['CONTENT_LENGTH']) ? intval($_SERVER['CONTENT_LENGTH']) : 0;
    $in = fopen('php://input', 'rb');
    if (!$in) {
        header('HTTP/1.1 500 Internal Server Error');
        echo '{"error":"cannot read request body"}';
        return;
    }

    $ch = backend_curl($url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'POST');
    curl_setopt($ch, CURLOPT_UPLOAD, true);
    curl_setopt($ch, CURLOPT_INFILE, $in);
    curl_setopt($ch, CURLOPT_INFILESIZE, $len);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers(array(
        'Content-Type: application/octet-stream',
        'Content-Length: ' . $len,
    )));
    curl_setopt($ch, CURLOPT_TIMEOUT, 0);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err  = curl_error($ch);
    release_curl($ch);
    fclose($in);
    if ($resp === false) {
        header('HTTP/1.1 502 Bad Gateway');
        echo json_encode(array('error' => 'backend unavailable: ' . $err));
        return;
    }
    if ($code) http_response_code($code);
    echo $resp;
}

function proxy_download($url) {
    ignore_user_abort(true);   // see proxy_stream
    while (ob_get_level() > 0) { ob_end_clean(); }
    @ob_implicit_flush(true);

    $sent_headers = false;
    $ch = backend_curl($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers());
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 0);
    curl_setopt($ch, CURLOPT_HEADERFUNCTION,
        function ($ch, $header) use (&$sent_headers) {
            $len = strlen($header);
            $h = trim($header);
            if (!$sent_headers
                    && preg_match('#^HTTP/\S+\s+(\d+)\b#', $h, $m)) {
                http_response_code(intval($m[1]));
                $sent_headers = true;
                return $len;
            }
            if (preg_match('#^(Content-Type|Content-Length|Content-Disposition|Cache-Control):#i', $h)) {
                header($h);
            }
            return $len;
        });
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) {
        echo $data;
        @flush();
        if (connection_aborted()) return 0;
        return strlen($data);
    });
    $ok = curl_exec($ch);
    $err = curl_error($ch);
    release_curl($ch);
    if (!$sent_headers) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode(array('error' => 'backend unavailable: ' . $err));
    } elseif ($ok === false && !connection_aborted()) {
        // Response headers may already be committed, so only append a
        // JSON error when the backend failed before the body reached the
        // browser. Mid-stream failures naturally surface as truncated
        // downloads.
        @flush();
    }
}

// DELETE helper for /api/save. Mirrors proxy_post/proxy_get by
// forwarding the backend's status code, including 204 No Content.
function proxy_delete($url) {
    $ch = backend_curl($url);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, 'DELETE');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers());
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err  = curl_error($ch);
    release_curl($ch);
    if ($resp === false) {
        header('HTTP/1.1 502 Bad Gateway');
        echo json_encode(array('error' => 'backend unavailable: ' . $err));
        return;
    }
    if ($code) http_response_code($code);
    echo $resp;
}

// SSE passthrough: must NOT buffer. Each chunk from the backend is
// flushed to the browser immediately. On hosts that buffer responses
// regardless (mod_deflate, fastcgi_buffering on, etc.) the stream may
// arrive in clumps — the frontend detects this via the first-message
// timer and falls back to /api/output long-polling.
//
// Status forwarding: do NOT commit response headers up front. We delay
// emitting Content-Type / status until the backend's response status
// line arrives, so a 404 from /api/stream (invalid sid, server restart)
// surfaces as 404 application/json — not as 200 text/event-stream with
// a JSON error baked in, which EventSource sees as a healthy stream
// with zero events.
function proxy_stream($url) {
    // With the default ignore_user_abort=0 PHP terminates the script the
    // moment an echo hits a closed browser connection - INSIDE curl's
    // write callback, before the `connection_aborted()` check below can
    // return 0. libcurl never gets to close the backend socket, which
    // then stays open in this worker for the rest of its life: the
    // backend keeps the session's stream slot (409 on every reconnect),
    // drains terminal output into the dead socket, and holds a worker
    // thread. Keep running so the callback returns 0 and curl tears the
    // connection down cleanly.
    ignore_user_abort(true);
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) { ob_end_clean(); }
    @ob_implicit_flush(true);

    $sent_headers = false;
    $ch = backend_curl($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    // Bound stream lifetime so a hung backend doesn't tie up a PHP-FPM
    // worker forever. 1 hour is generous for a real interactive session
    // and short enough to bail on a deadlocked backend before the worker
    // pool exhausts. The browser's EventSource auto-reconnects on EOF so
    // a long-lived session reconnects through the timeout boundary.
    curl_setopt($ch, CURLOPT_TIMEOUT, 3600);
    // EventSource's automatic reconnect carries the id of the last event
    // it received in Last-Event-ID; the backend resumes output from that
    // cursor. The shim forwards no other browser headers, so pass this
    // one through explicitly (digits only).
    $extra = array('Accept: text/event-stream');
    if (isset($_SERVER['HTTP_LAST_EVENT_ID']) && is_string($_SERVER['HTTP_LAST_EVENT_ID'])
            && preg_match('/^[0-9]{1,20}$/D', $_SERVER['HTTP_LAST_EVENT_ID'])) {
        $extra[] = 'Last-Event-ID: ' . $_SERVER['HTTP_LAST_EVENT_ID'];
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers($extra));
    curl_setopt($ch, CURLOPT_HEADERFUNCTION,
        function ($ch, $header) use (&$sent_headers) {
            $len = strlen($header);
            if (!$sent_headers
                    && preg_match('#^HTTP/\S+\s+(\d+)\b#', trim($header), $m)) {
                $code = intval($m[1]);
                // http_response_code() emits a proper status line on
                // every SAPI (apache mod_php, fpm, cli-server). The bare
                // header('HTTP/1.1 NNN') form silently drops on some
                // FPM+nginx configs that expect a reason phrase.
                http_response_code($code);
                header('Cache-Control: no-cache, no-store');
                if ($code === 200) {
                    header('Content-Type: text/event-stream');
                    header('X-Accel-Buffering: no');
                    header('Connection: keep-alive');
                } else {
                    header('Content-Type: application/json');
                }
                $sent_headers = true;
            }
            return $len;
        });
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) {
        echo $data;
        @flush();
        // Stop early if the browser has gone away.
        if (connection_aborted()) return 0;
        return strlen($data);
    });
    $ok = curl_exec($ch);
    $err = curl_error($ch);
    release_curl($ch);
    if (!$sent_headers) {
        // curl never received a response status line — treat as gateway
        // failure rather than letting PHP emit its default text/html.
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode(array('error' => 'backend unavailable: ' . $err));
    }
}

function ensure_backend($backend, $config_path, $socket) {
    if (ping_backend($backend)) return;

    // Lock to prevent double-start. It sits next to the socket, not in
    // the system temp dir: with a shared /tmp every account on the host
    // would contend for one lock file owned by whoever created it.
    $lock = @fopen($socket . '.lock', 'c');
    if (!$lock) {
        config_error('cannot create the auto-start lock next to the backend '
            . 'socket; its directory must be writable by this account');
    }
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        usleep(1500000);
        ping_backend($backend);
        return;
    }

    // Re-check after acquiring lock.
    if (ping_backend($backend)) { flock($lock, LOCK_UN); fclose($lock); return; }

    $script = dirname(__FILE__) . '/server.py';
    if (file_exists($script)) {
        // WEBSH_SOCKET makes the spawned server.py listen on the socket
        // this proxy connects to instead of a loopback TCP port.
        $cmd = sprintf(
            'WEBSH_CONFIG=%s WEBSH_SOCKET=%s nohup python3 %s </dev/null >/dev/null 2>&1 &',
            escapeshellarg($config_path),
            escapeshellarg($socket),
            escapeshellarg($script)
        );
        exec($cmd);
        usleep(800000);
    }

    flock($lock, LOCK_UN);
    fclose($lock);
}
