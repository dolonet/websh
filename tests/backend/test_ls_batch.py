"""Directory listings must not spawn one metadata process per entry.

Run the actual remote shell against private files. Count external stat calls,
not wall time, so load on the CI worker cannot turn the performance guard red.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import server


class TestListingMetadataBudget(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='websh-list-batch-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.files = self.root / 'directory with spaces\n'
        self.files.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.calls = self.root / 'calls'
        self.stat = shutil.which('stat')
        if not self.stat:
            self.skipTest('stat unavailable')
        self._wrapper('gnu')

    def _wrapper(self, mode):
        if mode == 'lossy-printf':
            # uutils accepts GNU's printf option but renders invalid bytes
            # in %n as U+FFFD. Exercise that public behavior on GNU hosts
            # too, instead of relying on the CI image to find it again.
            (self.bin / 'stat').write_text(
                '#!' + sys.executable + '\n'
                'import os, subprocess, sys\n'
                'with open(os.environ["LIST_CALLS"], "a") as f: f.write("call %d\\n" % (len(sys.argv)-1))\n'
                'if sys.argv[1:] == ["--version"]:\n'
                ' print("stat (uutils coreutils) 0.10.0"); sys.exit(0)\n'
                'r = subprocess.run([os.environ["REAL_STAT"]] + sys.argv[1:], capture_output=True)\n'
                'out = r.stdout\n'
                'if any(a.startswith("--printf") for a in sys.argv[1:]): out = out.decode("utf-8", "replace").encode("utf-8")\n'
                'sys.stdout.buffer.write(out); sys.stderr.buffer.write(r.stderr); sys.exit(r.returncode)\n')
            (self.bin / 'stat').chmod(0o700)
            return
        # Test doubles expose the supported public stat dialects. Metadata
        # still comes from real private files, including symlinks and names.
        pre = ''
        if mode != 'gnu':
            pre += 'case "$1" in --printf*|--version) exit 1;; esac\n'
        if mode == 'none':
            pre = 'exit 1\n'
        if mode == 'bsd':
            pre += 'if [ "$1" = -c ]; then exit 1; fi\n'
            pre += 'if [ "$1" = -f ]; then shift 2; set -- -c "%s %Y" "$@"; fi\n'
        (self.bin / 'stat').write_text(
            '#!/bin/sh\nprintf "call %s\\n" "$#" >> "$LIST_CALLS"\n' + pre +
            'exec "$REAL_STAT" "$@"\n')
        (self.bin / 'stat').chmod(0o700)

    def _list(self, raw=False):
        s = server.SSHSession.__new__(server.SSHSession)
        s._mux_ready = lambda: True
        env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'],
                   LIST_CALLS=str(self.calls), REAL_STAT=self.stat)
        def run(cmd, timeout, msg, err_prefix=None):
            return subprocess.run(['sh', '-c', cmd], env=env,
                                  capture_output=True, timeout=timeout), None
        s._mux_run = run
        entries, path, err = s.list_dir(str(self.files))
        self.assertIsNone(err)
        self.assertEqual(path, str(self.files))
        return entries if raw else {e['name']: e for e in entries}

    def test_large_listing_uses_bounded_metadata_processes(self):
        version = subprocess.run([self.stat, '--version'], capture_output=True).stdout
        if not version.startswith(b'stat (GNU coreutils)'):
            self.skipTest('bounded batch fast path requires actual GNU stat; non-GNU fallback is checked separately')
        for i in range(300):
            (self.files / ('entry-%04d' % i)).write_bytes(b'x' * (i % 17))
        entries = self._list()
        self.assertEqual(len(entries), 300)
        for i in range(300):
            self.assertEqual(entries['entry-%04d' % i]['size'], i % 17)
        calls = self.calls.read_text().splitlines()
        count = len(calls)
        self.assertLessEqual(max(int(x.split()[1]) for x in calls), 260,
                             'metadata calls must have a bounded argument batch')
        self.assertLessEqual(count, 20,
                             '300 entries must not require a metadata process per entry')

    def test_names_and_metadata_survive_every_supported_stat_dialect(self):
        names = ['tab\tname', 'line\nname\n', ' leading trailing ', '-dash',
                 '.hidden', 'quote\'"$`;', 'Русский файл', 'zero']
        for i, name in enumerate(names):
            p = self.files / name
            p.write_bytes(b'x' * i)
            os.utime(p, (1700000000 + i, 1700000000 + i))
        (self.files / 'folder').mkdir()
        (self.files / 'dir-link').symlink_to('folder')
        (self.files / 'file-link').symlink_to(names[0])
        (self.files / 'broken').symlink_to('missing')
        for mode in ['gnu', 'busybox', 'bsd', 'none']:
            with self.subTest(mode=mode):
                self._wrapper(mode)
                entries = self._list()
                self.assertEqual(set(entries), set(os.listdir(self.files)))
                for name, e in entries.items():
                    st = (self.files / name).lstat()
                    self.assertEqual(e['size'], 0 if mode == 'none' else st.st_size, name)
                    self.assertEqual(e['mtime'], 0 if mode == 'none' else int(st.st_mtime), name)
                self.assertEqual(entries['folder']['type'], 'd')
                self.assertEqual(entries['dir-link']['type'], 'l')
                self.assertTrue(entries['dir-link']['dir'])
                self.assertFalse(entries['file-link'].get('dir'))
                self.assertFalse(entries['broken'].get('dir'))

    def test_distinct_non_utf8_names_keep_their_own_metadata(self):
        for name, size in [(b'bad-\xff', 17), (b'bad-\xfe', 23)]:
            with open(os.fsencode(self.files) + b'/' + name, 'wb') as f:
                f.write(b'x' * size)
        entries = self._list(raw=True)
        self.assertEqual(len(entries), 2)
        self.assertEqual(sorted(e['size'] for e in entries), [17, 23])

    def test_non_gnu_printf_preserves_invalid_filename_metadata(self):
        self._wrapper('lossy-printf')
        self.test_distinct_non_utf8_names_keep_their_own_metadata()
