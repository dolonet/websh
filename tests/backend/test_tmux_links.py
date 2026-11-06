"""OSC 8 hyperlinks survive websh's tmux wrapping.

Programs (Claude Code, `ls --hyperlink`, gcc, systemd) print
ESC ] 8 ; ; URL ESC \\ text ESC ] 8 ; ; ESC \\. tmux re-draws its panes
for the outer terminal and only forwards a hyperlink when it believes
that terminal supports them; websh's outer terminal is xterm.js
(TERM=xterm-256color), which does. If tmux drops the sequence, the
browser never learns there was a link: the owner's report "Claude Code
prints words that are hyperlinks, clicking them does nothing".

These run the real command websh sends over ssh
(`_build_remote_command`) in a PTY, as the ssh child would, against a
private tmux server (own TMUX_TMPDIR, own HOME for the watchdog files),
type a printf into the shell inside tmux and read what tmux writes to
the outer terminal. Nothing waits a fixed time: every step waits for a
marker in the output. Skipped where tmux is not installed.
"""

import os
import pty
import select
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

from tests.backend._base import server

TMUX = shutil.which("tmux")


def _tmux_version():
    if not TMUX:
        return (0, 0)
    out = subprocess.run([TMUX, "-V"], stdout=subprocess.PIPE,
                         universal_newlines=True).stdout
    num = "".join(c if (c.isdigit() or c == ".") else " " for c in out).split()
    try:
        parts = num[0].split(".")
        return (int(parts[0]), int(parts[1] if len(parts) > 1 else 0))
    except (IndexError, ValueError):
        return (0, 0)


def _oct(s):
    return "".join("\\%03o" % b for b in s.encode("utf-8"))


class _TmuxPty(unittest.TestCase):
    """websh's remote command in a PTY against a private tmux server."""

    def setUp(self):
        # Short path: tmux's socket path must fit in sun_path.
        self.dir = tempfile.mkdtemp(prefix="wsl")
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("TMUX", "TMUX_PANE")}
        self.env.update(TMUX_TMPDIR=self.dir, HOME=self.dir,
                        SHELL="/bin/sh", TERM="xterm-256color",
                        PS1="$ ", ENV="")
        self.pid = None
        self.fd = None
        self.out = b""

    def tearDown(self):
        # The private server only: TMUX_TMPDIR points at our own dir.
        subprocess.run([TMUX, "kill-server"], env=self.env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except OSError:
                pass
        if self.fd is not None:
            try:
                os.close(self.fd)
            except OSError:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def _start(self, cmd):
        pid, fd = pty.fork()
        if pid == 0:
            try:
                os.execve("/bin/sh", ["sh", "-c", cmd], self.env)
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd
        # 120x40, as a browser pane would be.
        import fcntl
        import struct
        import termios
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    def _read_until(self, needle, timeout=10.0):
        end = time.time() + timeout
        while needle not in self.out:
            left = end - time.time()
            if left <= 0:
                return False
            r, _, _ = select.select([self.fd], [], [], min(left, 0.2))
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return needle in self.out
                if not data:
                    return needle in self.out
                self.out += data
        return True

    def _shell_ready(self):
        # `echo RE''ADY` prints READY; the typed echo shows RE''ADY.
        # Keys typed before the tmux client has set up its terminal can
        # be flushed away (tcsetattr TCSAFLUSH), so repeat the probe
        # until the shell inside answers - up to 10 s.
        for _ in range(20):
            os.write(self.fd, b"echo RE''ADY_1\r")
            if self._read_until(b"READY_1", 0.5):
                break
        self.assertTrue(self._read_until(b"READY_1", 0.1),
                        "the shell inside tmux never answered; output: %r"
                        % self.out[-400:])

    def _print_link(self, url, text, bel=False):
        st = "\\007" if bel else "\\033\\\\"
        end = "END_" + text
        line = ("printf '\\033]8;;" + _oct(url) + st + _oct(text)
                + "\\033]8;;" + st + "\\n" + _oct(end) + "\\n'\r")
        start = len(self.out)
        os.write(self.fd, line.encode())
        # tmux draws in order: once the line after the link is out, the
        # link's own bytes (with or without its OSC 8) are out too.
        self.assertTrue(self._read_until(end.encode()),
                        "the printf output never came back; output: %r"
                        % self.out[-400:])
        return self.out[start:]

    def _assert_link(self, chunk, url, how):
        self.assertIn(b"LINK", chunk,
                      "%s: link text not drawn at all: %r" % (how, chunk[-300:]))
        self.assertIn(
            b"\x1b]8;", chunk,
            "%s: tmux drew the link text but dropped the OSC 8 hyperlink - "
            "the browser cannot know it is a link. Outer terminal got: %r"
            % (how, chunk[-300:]))
        self.assertIn(url.encode(), chunk,
                      "%s: OSC 8 reached the outer terminal without the "
                      "target URL: %r" % (how, chunk[-300:]))

    def _attach(self, slot, ttl=0, tmux_options=None):
        cmd = server._build_remote_command(slot, "tmux", ttl,
                                           tmux_options=tmux_options,
                                           poll_seconds=1)
        self._start(cmd)
        self._shell_ready()



@unittest.skipUnless(TMUX, "tmux not installed")
@unittest.skipUnless(_tmux_version() >= (3, 4),
                     "tmux < 3.4 cannot forward OSC 8 at all")
class TestTmuxForwardsHyperlinks(_TmuxPty):

    def _detach(self):
        # The browser pane goes away: the tmux client dies, the session
        # stays (as when websh's ssh child is killed).
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)
        os.close(self.fd)
        self.pid, self.fd, self.out = None, None, b""

    def test_reconnects_forward_links_and_do_not_pile_up_options(self):
        """Every reconnect re-attaches the same session and links keep
        coming through - and the server-wide options websh sets are not
        appended again on each connect (a long-lived tmux server sees
        thousands of reconnects; a list that grows by one entry each
        time is a leak in the user's own tmux)."""
        for n in range(4):
            self._attach("lnk_7")
            url = "https://example.com/re%d" % n
            chunk = self._print_link(url, "LINKre%d" % n)
            self._assert_link(chunk, url, "connect #%d" % (n + 1))
            self._detach()
        r = subprocess.run([TMUX, "show-options", "-s"], env=self.env,
                           stdout=subprocess.PIPE, universal_newlines=True)
        lines = [ln.split(" ", 1)[1] for ln in r.stdout.splitlines()
                 if ln.startswith("terminal-features[")]
        self.assertEqual(len(lines), len(set(lines)),
                         "terminal-features grew with every connect: %r" % lines)

    def test_new_session_forwards_osc8_st(self):
        """A new persistent session: an ST-terminated OSC 8 link printed
        inside reaches the outer terminal with its URL."""
        self._attach("lnk_1")
        url = "https://example.com/new?a=1#f"
        chunk = self._print_link(url, "LINKnew")
        self._assert_link(chunk, url, "new session, ST")

    def test_new_session_forwards_osc8_bel(self):
        """The BEL-terminated form (printed by many tools) as well."""
        self._attach("lnk_2")
        url = "https://example.com/bel"
        chunk = self._print_link(url, "LINKbel", bel=True)
        self._assert_link(chunk, url, "new session, BEL")

    def test_existing_session_forwards_osc8(self):
        """Re-attaching to a session that existed before (made by an
        older websh, or before this server's tmux options changed):
        links come through too."""
        subprocess.run([TMUX, "new-session", "-d", "-s", "websh-lnk_3",
                        "-x", "120", "-y", "40", "/bin/sh"],
                       env=self.env, check=True)
        self._attach("lnk_3")
        url = "https://example.com/existing"
        chunk = self._print_link(url, "LINKold")
        self._assert_link(chunk, url, "pre-existing session")

    def test_existing_server_other_session_forwards_osc8(self):
        """The target's tmux server is already running (the user's own
        sessions, started without websh): a new websh session on it
        forwards links."""
        subprocess.run([TMUX, "new-session", "-d", "-s", "users-own",
                        "/bin/sh"], env=self.env, check=True)
        self._attach("lnk_4")
        url = "https://example.com/server"
        chunk = self._print_link(url, "LINKsrv")
        self._assert_link(chunk, url, "existing server")

    def test_watchdog_command_forwards_osc8(self):
        """The idle-TTL variant of the command (the production default)."""
        self._attach("lnk_5", ttl=3600)
        url = "https://example.com/ttl"
        chunk = self._print_link(url, "LINKttl")
        self._assert_link(chunk, url, "ttl command")

    def test_with_tmux_options_forwards_osc8(self):
        """Per-connect options (Scrollback setting, clipboard) do not
        get in the way."""
        self._attach("lnk_6", tmux_options=[("history-limit", "5000"),
                                            ("set-clipboard", "on")])
        url = "https://example.com/opts"
        chunk = self._print_link(url, "LINKopt")
        self._assert_link(chunk, url, "with tmux options")


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(TMUX, "tmux not installed")
class TestTmuxAttachOnAnyVersion(_TmuxPty):
    """Whatever websh adds to the tmux command for links must not stop
    a persistent pane from coming up on a target whose tmux predates
    the option (tmux < 3.2 has no terminal-features; an unknown option
    in a `\\;` chain aborts the rest of it, new-session included).
    CI has a current tmux; run this file against an old one with
        docker run --rm -v "$PWD":/w -w /w python:3.9-slim-bullseye sh -c \\
          'apt-get update -qq; apt-get install -y -qq tmux; \\
           python -m unittest tests.backend.test_tmux_links -v'
    (bullseye ships tmux 3.1c)."""

    def test_new_session_comes_up(self):
        self._attach("old_1")

    def test_new_session_with_ttl_and_options_comes_up(self):
        self._attach("old_2", ttl=3600,
                     tmux_options=[("history-limit", "5000")])

    def test_existing_session_comes_up(self):
        subprocess.run([TMUX, "new-session", "-d", "-s", "websh-old_3",
                        "/bin/sh"], env=self.env, check=True)
        self._attach("old_3")
        os.write(self.fd, b"echo SA''ME_$TMUX_PANE\r")
        self.assertTrue(self._read_until(b"SAME_%"),
                        "re-attached shell did not answer: %r" % self.out[-300:])
