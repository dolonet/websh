#!/usr/bin/env python3
"""Symlinks to directories in the file browser (owner, 2026-10-23: "in
the file browser I don't see mounted folders"). ~/job/БЮ_ОптРеш is a
symlink to a directory inside an rclone FUSE mount; it was listed as
type "l", sorted among 128 files, and a click downloaded instead of
opening it.

Wire (additive): an entry of type "l" whose target is a directory gains
`"dir": true`; a link to a file and a dangling link do not. Delete and
rename act on the link itself, never on its target.

The real list_dir / remove_path / rename_entry snippets run in local
POSIX shells against a temp dir (as TestSideChannelSnippetsExecuted
does), and /api/ls through the real HTTP handler.
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
import unittest.mock
import uuid
from urllib.parse import quote

from tests.backend._base import LiveServerCase
import server

SHELLS = [sh for sh in ("dash", "bash", "busybox") if shutil.which(sh)]


def _session(shell, home=None):
    s = server.SSHSession.__new__(server.SSHSession)
    s.id = "links"
    s.persistent = False
    s.slot_id = None
    s.alive = True
    s.auth_failed = False
    s.owner = ""
    s.client_ip = "127.0.0.1"
    s.is_background = False
    s.last_activity = time.time()
    s._control_path = "/tmp/fake.sock"
    s._host = "h.example"
    s._port = 22
    s._username = "u"
    s._mux_ready = lambda: True
    argv = ["busybox", "sh", "-c"] if shell == "busybox" else [shell, "-c"]
    env = ["env", "HOME=" + home] if home else []

    def run(remote_cmd, timeout, msg, err_prefix=None):
        return subprocess.run(env + argv + [remote_cmd], capture_output=True,
                              timeout=timeout), None
    s._mux_run = run
    s._mux_argv = lambda cmd: env + argv + [cmd]
    s.is_expired = lambda: False
    s.close = lambda: None
    return s


def _fixture(root):
    """real-dir/ (with a file), plain.txt, link-to-dir -> real-dir,
    link-to-file -> plain.txt, dangling -> nowhere, chain -> link-to-dir,
    abs-link-to-dir -> <abs real-dir>."""
    os.makedirs(os.path.join(root, "real-dir"))
    with open(os.path.join(root, "real-dir", "inside.txt"), "w") as f:
        f.write("inside")
    with open(os.path.join(root, "plain.txt"), "w") as f:
        f.write("plain")
    os.symlink("real-dir", os.path.join(root, "link-to-dir"))
    os.symlink("plain.txt", os.path.join(root, "link-to-file"))
    os.symlink("does-not-exist", os.path.join(root, "dangling"))
    os.symlink("link-to-dir", os.path.join(root, "chain"))
    os.symlink(os.path.join(root, "real-dir"), os.path.join(root, "abs-link-to-dir"))
    os.symlink("БЮ_ОптРеш-target", os.path.join(root, "БЮ_ОптРеш"))
    os.makedirs(os.path.join(root, "БЮ_ОптРеш-target"))


@unittest.skipUnless(SHELLS, "no POSIX shell")
class TestListDirMarksLinksToFolders(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websh-fblinks-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        _fixture(self.tmp)

    def _entries(self, sh):
        entries, path, err = _session(sh).list_dir(self.tmp)
        self.assertIsNone(err, sh)
        return {e["name"]: e for e in entries}

    def test_a_link_to_a_folder_is_type_l_with_dir_true(self):
        for sh in SHELLS:
            e = self._entries(sh)
            for n in ("link-to-dir", "chain", "abs-link-to-dir", "БЮ_ОптРеш"):
                self.assertEqual(e[n]["type"], "l", (sh, n, e[n]))
                self.assertIs(e[n].get("dir"), True, (sh, n, e[n]))

    def test_a_link_to_a_file_and_a_dangling_link_are_not_folders(self):
        for sh in SHELLS:
            e = self._entries(sh)
            for n in ("link-to-file", "dangling"):
                self.assertEqual(e[n]["type"], "l", (sh, n))
                self.assertFalse(e[n].get("dir"), (sh, n, e[n]))

    def test_plain_entries_are_unchanged(self):
        for sh in SHELLS:
            e = self._entries(sh)
            self.assertEqual(e["real-dir"]["type"], "d", sh)
            self.assertEqual(e["plain.txt"]["type"], "f", sh)
            self.assertEqual(e["plain.txt"]["size"], 5, sh)
            self.assertEqual(sorted(e), sorted(os.listdir(self.tmp)), sh + ": every entry, once")

    def test_listing_through_the_link_shows_the_target_contents_at_the_link_path(self):
        for sh in SHELLS:
            link = os.path.join(self.tmp, "link-to-dir")
            entries, path, err = _session(sh).list_dir(link)
            self.assertIsNone(err, sh)
            self.assertEqual(path, link, sh + ": the browser stays at the link's path")
            self.assertEqual([x["name"] for x in entries], ["inside.txt"], sh)


@unittest.skipUnless(SHELLS, "no POSIX shell")
class TestLinkActionsTouchOnlyTheLink(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="websh-fblinks-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_delete_on_a_link_to_a_folder_removes_the_link_only(self):
        for sh in SHELLS:
            shutil.rmtree(self.tmp)
            os.makedirs(self.tmp)
            _fixture(self.tmp)
            ok, err = _session(sh).remove_path(os.path.join(self.tmp, "link-to-dir"))
            self.assertTrue(ok, (sh, err))
            self.assertFalse(os.path.lexists(os.path.join(self.tmp, "link-to-dir")), sh)
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, "real-dir", "inside.txt")),
                            sh + ": the target and its contents are untouched")
            ok, err = _session(sh).remove_path(os.path.join(self.tmp, "abs-link-to-dir"))
            self.assertTrue(ok, (sh, err))
            self.assertTrue(os.path.isfile(os.path.join(self.tmp, "real-dir", "inside.txt")), sh)

    def test_rename_on_a_link_to_a_folder_renames_the_link_only(self):
        for sh in SHELLS:
            shutil.rmtree(self.tmp)
            os.makedirs(self.tmp)
            _fixture(self.tmp)
            ok, err = _session(sh).rename_entry(os.path.join(self.tmp, "link-to-dir"), "renamed-link")
            self.assertTrue(ok, (sh, err))
            new = os.path.join(self.tmp, "renamed-link")
            self.assertTrue(os.path.islink(new), sh + ": still a link")
            self.assertEqual(os.readlink(new), "real-dir", sh)
            self.assertTrue(os.path.isdir(os.path.join(self.tmp, "real-dir")), sh + ": the target keeps its name")
            self.assertFalse(os.path.lexists(os.path.join(self.tmp, "link-to-dir")), sh)


@unittest.skipUnless(SHELLS, "no POSIX shell")
class TestLsHttpCarriesTheDirFlag(LiveServerCase):

    def setUp(self):
        server._side_channel_rate_limits.clear()
        self.tmp = tempfile.mkdtemp(prefix="websh-fblinks-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        _fixture(self.tmp)
        self.sid = str(uuid.uuid4())
        p = unittest.mock.patch.dict(server.sessions, {self.sid: _session(SHELLS[0], self.tmp)})
        p.start()
        self.addCleanup(p.stop)

    def test_api_ls_reports_dir_true_for_a_link_to_a_folder(self):
        body, code = self._get("/api/ls?session_id={}&path={}".format(self.sid, quote(self.tmp)))
        self.assertEqual(code, 200, body)
        e = {x["name"]: x for x in body["entries"]}
        self.assertIs(e["link-to-dir"].get("dir"), True, e["link-to-dir"])
        self.assertIs(e["БЮ_ОптРеш"].get("dir"), True)
        self.assertFalse(e["link-to-file"].get("dir"))
        self.assertFalse(e["dangling"].get("dir"))


if __name__ == "__main__":
    unittest.main()
