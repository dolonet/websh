// Sealed mode on, a persistent pane, a 12 MB upload under way - and
// websh restarts (a deploy). The channel is gone (it lives in server
// memory), the session too. What must hold: nothing is sent in clear;
// the upload either lands byte-identical or fails visibly (never a
// "Saved" file that differs); the pane re-attaches by itself to the same
// tmux shell; the server's identity is the same after the restart (no
// key-changed modal); typing works after it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sleep, until, tagOf } from '../lib.mjs';
export const meta = { about: 'sealed on: websh restarts mid-upload with a persistent pane; re-attach, no clear text, upload whole or failed visibly', ssh: true, local: true };

export async function run({ b, t, server }) {
  const urls = [];
  const orig = b._on.bind(b);
  b._on = d => { if (d.method === 'Network.requestWillBeSent') urls.push({ url: d.params.request.url, at: Date.now() }); orig(d); };
  try {
    const i = await b.connect({ persistent: true });
    if (!(await b.ev('settings.sealed')))
      await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
    const badge = () => b.ev(`(() => { const e = document.getElementById('sealedBadge'); return !!e && !e.classList.contains('h') && !e.hidden && getComputedStyle(e).display !== 'none'; })()`);
    t.ok(await until(badge, 10000) >= 0, 'sealed channel up');
    const t0 = Date.now();
    const v = tagOf('v');
    await b.type(i, `cd ~; export WT=${v}; echo pre_$WT\r`);
    t.ok(await until(async () => (await b.lines(i)).includes('pre_' + v), 8000) >= 0, 'typing works sealed');
    const name = 'websh-e2e-sealedrestart-' + Date.now() + '.bin';
    const size = 12 * 1024 * 1024;
    const digest = await b.ev(`(async () => {
      const buf = new Uint8Array(${size}); for (let k = 0; k < buf.length; k += 65536)
        crypto.getRandomValues(buf.subarray(k, Math.min(k + 65536, buf.length)));
      window._f = new File([buf], ${JSON.stringify(name)});
      const h = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
    })()`);
    await b.network({ upload: 1500 * 1024 });
    await b.ev(`(() => { const p = Object.values(panes)[${i}]; handleUpload(p.id, { files: [window._f], value: '' }); return 1; })()`);
    const banner = () => b.ev(`(() => { const p = Object.values(panes)[${i}];
      const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`);
    t.ok(await until(async () => /\d+%/.test(await banner()), 15000) >= 0, 'upload started');
    await sleep(2500);
    const before = await banner();
    await server.restart();
    t.note(`restarted at ${JSON.stringify(before)}`);
    await b.network({});
    const done = await until(async () => /Saved to|Upload complete|Upload failed|cancel/i.test(await banner()), 150000);
    const text = await banner();
    t.note('banner: ' + JSON.stringify(text));
    t.ok(done >= 0, 'the upload came to an end the user can see (saved or failed)');
    const local = path.join(os.homedir(), name);
    if (/Saved to|Upload complete/.test(text)) {
      const ok = fs.existsSync(local) && createHash('sha256').update(fs.readFileSync(local)).digest('hex') === digest;
      t.ok(ok, 'reported saved: the file on disk is byte-identical');
    } else {
      t.ok(!/Saved/.test(text), 'reported failed, visibly');
    }
    try { fs.unlinkSync(local); } catch (e) {}
    // The pane, the shell, the identity.
    t.ok(await until(async () => { const s = (await b.state())[i]; return s.sid && !s.reconnecting; }, 40000) >= 0, 'pane back by itself');
    t.ok(!(await b.ev(`(() => { const m = document.getElementById('ovSealedMismatch'); return !!m && !m.classList.contains('h'); })()`)), 'no key-changed modal: the identity survived the restart');
    t.ok(await until(badge, 15000) >= 0, 'sealed channel up again');
    await b.type(i, 'echo post_$WT\r');
    t.ok(await until(async () => (await b.lines(i)).includes('post_' + v), 10000) >= 0, 'same tmux shell (its environment survived)');
    const w = tagOf('T') + '_after_restart';
    await b.type(i, `echo ${w}\r`);
    t.ok(await until(async () => (await b.lines(i)).includes(w), 8000) >= 0, 'typing after the restart arrives');
    const plain = urls.filter(u => u.at >= t0 && /api\.php/.test(u.url) && !/action=(seal_open|config|ping)$/.test(u.url) && !/action=sealed&c=[0-9a-f]{32}$/.test(u.url));
    t.ok(plain.length === 0, 'nothing in clear throughout' + (plain.length ? ': ' + plain.slice(0, 3).map(u => u.url).join(' | ') : ''));
    await b.ev(`(() => { for (const f of [${JSON.stringify(name)}]) {} return 1; })()`);
  } finally {
    b._on = orig;
  }
}
