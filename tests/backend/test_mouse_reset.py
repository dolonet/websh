"""Explicit mouse recovery changes only the caller's terminal output modes."""
import json
import os
import pty
import re
import select
import shutil
import shlex
import subprocess
import sys
import tempfile
import time
import unittest.mock
import uuid
from pathlib import Path

from tests.backend._base import LiveServerCase
import server


class TestMouseResetHTTP(LiveServerCase):
    def setUp(self):
        server._side_channel_rate_limits.clear()
        self.work = tempfile.TemporaryDirectory(prefix='websh-mouse-test-')
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name)
        self.master, self.slave = pty.openpty()
        self.addCleanup(os.close, self.master)
        self.addCleanup(os.close, self.slave)
        self.tty = os.ttyname(self.slave)
        self.config = self.root / 'responses.json'
        self.counter = self.root / 'calls'
        self.tmux = self.root / 'tmux'
        # A private executable at the SSH subprocess boundary. It emits
        # scripted tmux replies; the production shell command still runs
        # unchanged and writes to an actual private character terminal.
        self.tmux.write_text('#!' + sys.executable + '\n' +
            'import json,pathlib,sys\n' +
            'p=pathlib.Path(' + repr(str(self.counter)) + ')\n' +
            'n=int(p.read_text()) if p.exists() else 0\np.write_text(str(n+1))\n' +
            'rows=json.loads(pathlib.Path(' + repr(str(self.config)) + ').read_text())\n' +
            'row=rows[min(n,len(rows)-1)]\n' +
            'sys.stdout.write(row[0]);sys.exit(row[1])\n')
        self.tmux.chmod(0o700)
        self.session = server.SSHSession.__new__(server.SSHSession)
        s = self.session
        s.id = str(uuid.uuid4())
        s.persistent = True
        s.alive = True
        s.slot_id = 'private_mouse'
        s.owner = ''
        s.client_ip = '127.0.0.1'
        s.last_activity = time.time()
        s.tmux_cmd = str(self.tmux)
        s._mux_ready = lambda: True
        s._mux_argv = lambda command: ['/bin/sh', '-c', command]
        self.responses()
        patch = unittest.mock.patch.dict(server.sessions, {s.id: s})
        patch.start()
        self.addCleanup(patch.stop)

    def responses(self, lookup=None, verify=None, lookup_status=0, verify_status=0):
        self.config.write_text(json.dumps([
            [lookup if lookup is not None else '%42 ' + self.tty + '\n', lookup_status],
            [verify if verify is not None else 'websh-' + self.session.slot_id + ' ' + self.tty + '\n', verify_status],
        ]))
        self.counter.unlink(missing_ok=True)

    def request(self, body=None, headers=None):
        return self._request_json('/api/mouse_reset',
            data=json.dumps(body if body is not None else {'session_id': self.session.id}).encode(),
            headers={'Content-Type': 'application/json', **(headers or {})})

    def output(self):
        chunks = []
        while select.select([self.master], [], [], 0)[0]:
            chunks.append(os.read(self.master, 4096))
        return b''.join(chunks)

    def assert_no_output(self):
        self.assertEqual(self.output(), b'')

    def test_owned_persistent_pane_receives_only_mouse_disable_output(self):
        body, status = self.request()
        self.assertEqual((status, body), (200, {'ok': True}))
        data = self.output()
        resets = re.findall(rb'\x1b\[\?([0-9;]+)l', data)
        self.assertTrue(resets, data)
        self.assertEqual(re.sub(rb'\x1b\[\?[0-9;]+l', b'', data), b'')
        modes = {int(n) for group in resets for n in group.split(b';')}
        self.assertTrue({1000, 1002, 1003, 1006}.issubset(modes), modes)
        self.assertTrue(modes.issubset({9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016}), modes)
        self.assertFalse(select.select([self.slave], [], [], 0)[0], 'no bytes injected as shell input')

    def test_invalid_json_is_rejected_as_bad_request(self):
        body, status = self._request_json('/api/mouse_reset', data=b'{bad',
            headers={'Content-Type': 'application/json'})
        self.assertEqual(status, 400, body)
        self.assert_no_output()

    def test_unknown_or_invalid_session_is_refused(self):
        for sid in ['', 'not-a-session', str(uuid.uuid4())]:
            with self.subTest(sid=sid):
                body, status = self.request({'session_id': sid})
                self.assertEqual(status, 404, body)
        self.assert_no_output()

    def test_foreign_owner_cannot_reset_a_pane(self):
        self.session.owner = 'alice'
        with unittest.mock.patch.object(server, 'WEBSH_AUTH_HEADER', 'Remote-User'):
            body, status = self.request(headers={'Remote-User': 'mallory'})
        self.assertEqual(status, 403, body)
        self.assertFalse(self.counter.exists())
        self.assert_no_output()

    def test_cross_origin_post_is_rejected(self):
        body, status = self.request(headers={'Origin': 'https://unrelated.invalid'})
        self.assertEqual(status, 403, body)
        self.assertFalse(self.counter.exists())
        self.assert_no_output()

    def test_side_channel_rate_limit_applies_before_execution(self):
        with unittest.mock.patch.object(server, 'SIDE_CHANNEL_RATE_MAX', 0):
            body, status = self.request()
        self.assertEqual(status, 429, body)
        self.assertFalse(self.counter.exists())
        self.assert_no_output()

    def test_plain_or_dead_session_cannot_receive_remote_reset(self):
        for field in ('persistent', 'alive'):
            with self.subTest(field=field), unittest.mock.patch.object(self.session, field, False):
                body, status = self.request()
                self.assertGreaterEqual(status, 400, body)
                self.assertNotEqual(body.get('ok'), True)
        self.assertFalse(self.counter.exists())
        self.assert_no_output()

    def test_missing_control_socket_or_tmux_is_visible_failure(self):
        with unittest.mock.patch.object(self.session, '_mux_ready', return_value=False):
            body, status = self.request()
            self.assertEqual(status, 502, body)
        with unittest.mock.patch.object(self.session, 'tmux_cmd', str(self.root / 'absent')):
            body, status = self.request()
            self.assertEqual(status, 502, body)
        self.assert_no_output()

    def test_invalid_or_multiple_terminal_results_never_write(self):
        values = ['', '%42', '%42 /dev/null', '%42 /tmp/file',
                  '%42 ' + self.tty + '\n%43 ' + self.tty,
                  '%42 ' + self.tty + ';echo unsafe',
                  '%42 /dev/pts/999999999', 'wrong ' + self.tty]
        for value in values:
            with self.subTest(reply=value):
                self.responses(lookup=value)
                body, status = self.request()
                self.assertEqual(status, 502, body)
                self.assert_no_output()

    def test_pane_revalidation_rejects_another_session_or_terminal(self):
        for value in ['another-session ' + self.tty, 'websh-private_mouse /dev/pts/999999999', '']:
            with self.subTest(reply=value):
                self.responses(verify=value)
                body, status = self.request()
                self.assertEqual(status, 502, body)
                self.assert_no_output()

    def test_lookup_and_reset_command_failures_are_not_success(self):
        for kwargs in ({'lookup_status': 1}, {'verify_status': 1}):
            with self.subTest(kwargs=kwargs):
                self.responses(**kwargs)
                body, status = self.request()
                self.assertEqual(status, 502, body)
                self.assert_no_output()

    def test_session_name_cannot_inject_shell_commands(self):
        marker = self.root / 'injected'
        self.session.slot_id = "x'; touch " + shlex.quote(str(marker)) + "; #"
        self.responses()
        # Invoke the real side-channel command with hostile stored metadata.
        # Refusal or safe literal targeting is allowed; executing text is not.
        self.request()
        self.assertFalse(marker.exists())

    def test_side_channel_timeout_does_not_report_success(self):
        with unittest.mock.patch.object(server.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private lookup', 10)):
            body, status = self.request()
        self.assertEqual(status, 502, body)
        self.assert_no_output()

    def test_real_tmux_exact_session_recovers_only_its_active_pane(self):
        executable = shutil.which('tmux')
        if not executable:
            self.skipTest('tmux is not installed')
        socket_name = 'websh-mouse-' + uuid.uuid4().hex

        def tmux(*args):
            return subprocess.check_output([executable, '-L', socket_name, *args], text=True).strip()

        self.addCleanup(subprocess.run, [executable, '-L', socket_name, 'kill-server'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        name = 'websh-' + self.session.slot_id
        tmux('new-session', '-d', '-s', name)
        tmux('new-session', '-d', '-s', name + '_neighbor')
        self.tmux.write_text('#!/bin/sh\nexec ' + shlex.quote(executable) + ' -L ' +
                             shlex.quote(socket_name) + ' "$@"\n')
        target = tmux('display-message', '-p', '-t', name + ':', '#{pane_id}')
        neighbor = tmux('display-message', '-p', '-t', name + '_neighbor:', '#{pane_id}')

        def flags(pane):
            return tmux('display-message', '-p', '-t', pane, '#{mouse_any_flag} #{mouse_sgr_flag}')

        def wait_flags(pane, expected):
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                if flags(pane) == expected:
                    return True
                time.sleep(.01)
            return False

        for pane in (target, neighbor):
            tty = tmux('display-message', '-p', '-t', pane, '#{pane_tty}')
            with open(tty, 'wb', buffering=0) as stream:
                stream.write(b'\x1b[?1003h\x1b[?1006h')
            self.assertTrue(wait_flags(pane, '1 1'))
        body, status = self.request()
        self.assertEqual((status, body), (200, {'ok': True}))
        self.assertTrue(wait_flags(target, '0 0'), 'actual tmux pane must leave application mouse mode')
        self.assertEqual(flags(neighbor), '1 1', 'similar session name must not select the neighboring pane')
