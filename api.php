<?php
/**
 * websh — PHP proxy.
 *
 * Forwards AJAX requests from the browser to the Python REST API
 * running on 127.0.0.1. This allows all traffic to flow through
 * the hosting provider's HTTPS — no exposed ports, no WebSocket.
 *
 * Compatible with PHP 5.3+ and requires only the curl extension.
 */

// HTTPS enforcement via reverse proxy headers.
$proto = isset($_SERVER['HTTP_X_FORWARDED_PROTO']) ? $_SERVER['HTTP_X_FORWARDED_PROTO'] : '';
if ($proto === 'http') {
    header('Location: https://' . $_SERVER['HTTP_HOST'] . $_SERVER['REQUEST_URI'], true, 301);
    exit;
}

$action  = isset($_GET['action']) ? $_GET['action'] : '';

// SSE stream needs a longer execution window than the JSON endpoints.
// Some shared hosts cap this hard, in which case the stream is killed
// after the cap and the browser falls back to long-poll automatically.
if ($action === 'stream') {
    @set_time_limit(0);
} else {
    @set_time_limit(55);
}

if (!extension_loaded('curl')) {
    header('HTTP/1.1 500 Internal Server Error');
    echo '{"error":"PHP curl extension is required"}';
    exit;
}

if ($action !== 'stream') {
    header('Content-Type: application/json');
    header('Cache-Control: no-cache, no-store, must-revalidate');
}

$BACKEND = 'http://127.0.0.1:' . (getenv('WEBSH_PORT') ?: '8765');

// Path to config file (must be OUTSIDE the web root for security).
$WEBSH_CONFIG = getenv('WEBSH_CONFIG') ?: dirname(__FILE__) . '/../../websh.json';

// Auto-start: launch server.py if it's not running.
ensure_backend($BACKEND, $WEBSH_CONFIG);

switch ($action) {
    case 'config':     proxy_get($BACKEND . '/api/config');     break;
    case 'connect':    proxy_post($BACKEND . '/api/connect');    break;
    case 'input':      proxy_post($BACKEND . '/api/input');      break;
    case 'resize':     proxy_post($BACKEND . '/api/resize');     break;
    case 'disconnect': proxy_post($BACKEND . '/api/disconnect'); break;
    case 'save':       proxy_post($BACKEND . '/api/save');       break;
    case 'tmux_options':
        proxy_post($BACKEND . '/api/tmux_options');
        break;
    case 'upload_finalize':
        proxy_post($BACKEND . '/api/upload_finalize');
        break;
    case 'upload_cancel':
        proxy_post($BACKEND . '/api/upload_cancel');
        break;
    case 'save_delete':
        // Browsers can't issue DELETE through form posts, so the
        // client POSTs here and we translate to a real backend DELETE.
        $vault = isset($_GET['vault_id']) ? $_GET['vault_id'] : '';
        $conn  = isset($_GET['conn_id'])  ? $_GET['conn_id']  : '';
        proxy_delete($BACKEND . '/api/save'
            . '?vault_id=' . urlencode($vault)
            . '&conn_id='  . urlencode($conn));
        break;
    case 'output':
        $sid = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        proxy_get($BACKEND . '/api/output?session_id=' . urlencode($sid));
        break;
    case 'stream':
        $sid = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        proxy_stream($BACKEND . '/api/stream?session_id=' . urlencode($sid));
        break;
    case 'ping':
        proxy_get($BACKEND . '/api/ping');
        break;
    case 'tmux_capture':
        $sid = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        proxy_get($BACKEND . '/api/tmux_capture?session_id=' . urlencode($sid));
        break;
    case 'ls':
        $sid  = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        $path = isset($_GET['path']) ? $_GET['path'] : '~';
        proxy_get($BACKEND . '/api/ls?session_id=' . urlencode($sid)
            . '&path=' . urlencode($path));
        break;
    case 'download':
        $sid  = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        $path = isset($_GET['path']) ? $_GET['path'] : '';
        proxy_download($BACKEND . '/api/download?session_id=' . urlencode($sid)
            . '&path=' . urlencode($path));
        break;
    case 'upload':
        $sid  = isset($_GET['session_id']) ? $_GET['session_id'] : '';
        $path = isset($_GET['path']) ? $_GET['path'] : '';
        proxy_upload($BACKEND . '/api/upload?session_id=' . urlencode($sid)
            . '&path=' . urlencode($path));
        break;
    default:
        header('HTTP/1.1 404 Not Found');
        echo '{"error":"unknown action"}';
        break;
}

// ── Helpers ──────────────────────────────────────────────────────────

// Headers every proxied backend request must carry. The X-Forwarded-For
// is the load-bearing one: all backend calls originate from 127.0.0.1
// (this PHP process), so without it the server sees every browser client
// as the loopback address and the entire per-IP defense layer collapses
// to a single shared bucket — one client exhausts RATE_LIMIT_MAX for
// everyone, MAX_SESSIONS_PER_IP caps all users combined, and the access
// log records 127.0.0.1 for every connect. The backend trusts only the
// FIRST token of X-Forwarded-For from a trusted proxy (loopback by
// default), so we send exactly one token and OVERWRITE rather than
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

// curl_close() only frees the handle before PHP 8.0; since then handles
// are objects freed when they go out of scope, and 8.5 deprecates the
// call. Hosts with display_errors on would print that notice into the
// JSON body — and with output buffering off also lose the status code
// to "headers already sent".
function release_curl($ch) {
    if (PHP_VERSION_ID < 80000) curl_close($ch);
}

function ping_backend($backend) {
    $ch = curl_init($backend . '/api/ping');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 2);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 1);
    $ok = curl_exec($ch) !== false;
    release_curl($ch);
    return $ok;
}

function proxy_post($url) {
    $body = file_get_contents('php://input');
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers(array('Content-Type: application/json')));
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
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

function proxy_get($url) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers());
    curl_setopt($ch, CURLOPT_TIMEOUT, 50);
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

    $ch = curl_init($url);
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
    while (ob_get_level() > 0) { ob_end_clean(); }
    @ob_implicit_flush(true);

    $sent_headers = false;
    $ch = curl_init($url);
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
    $ch = curl_init($url);
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
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    @ini_set('implicit_flush', '1');
    while (ob_get_level() > 0) { ob_end_clean(); }
    @ob_implicit_flush(true);

    $sent_headers = false;
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    // Bound stream lifetime so a hung backend doesn't tie up a PHP-FPM
    // worker forever. 1 hour is generous for a real interactive session
    // and short enough to bail on a deadlocked backend before the worker
    // pool exhausts. The browser's EventSource auto-reconnects on EOF so
    // a long-lived session reconnects through the timeout boundary.
    curl_setopt($ch, CURLOPT_TIMEOUT, 3600);
    curl_setopt($ch, CURLOPT_HTTPHEADER, backend_headers(array('Accept: text/event-stream')));
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

function ensure_backend($backend, $config_path) {
    if (ping_backend($backend)) return;

    // Lock to prevent double-start.
    $lock = fopen(sys_get_temp_dir() . '/websh_start.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
        if ($lock) fclose($lock);
        usleep(1500000);
        ping_backend($backend);
        return;
    }

    // Re-check after acquiring lock.
    if (ping_backend($backend)) { flock($lock, LOCK_UN); fclose($lock); return; }

    $script = dirname(__FILE__) . '/server.py';
    if (file_exists($script)) {
        // Pass PORT so the spawned server.py binds the SAME port this proxy
        // pings ($BACKEND uses WEBSH_PORT). Without it the backend always
        // binds its own default 8765, so on a non-default WEBSH_PORT the
        // ping never succeeds, every request re-execs python3, and the
        // browser sees permanent 502s.
        $cmd = sprintf(
            'WEBSH_CONFIG=%s PORT=%s nohup python3 %s </dev/null >/dev/null 2>&1 &',
            escapeshellarg($config_path),
            escapeshellarg(getenv('WEBSH_PORT') ?: '8765'),
            escapeshellarg($script)
        );
        exec($cmd);
        usleep(800000);
    }

    flock($lock, LOCK_UN);
    fclose($lock);
}
