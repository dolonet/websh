// A 12 MB upload while the connection is reset under it, twice. The file
// must arrive whole and identical; before pieces, one cut POST was the
// end of the upload (the owner switched networks to upload anything).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sleep, until, resetConnections, cfg } from '../lib.mjs';
export const meta = { about: '12 MB upload survives two connection resets, arrives identical', ssh: true, local: true, sudo: true };

export async function run({ b, t, port }) {
  const i = await b.connect({ persistent: true });
  const name = 'websh-e2e-' + Date.now() + '.bin';
  const size = 12 * 1024 * 1024;
  await b.type(i, 'cd ~\r');
  await sleep(500);
  // Build the file in the page (random bytes, so a duplicated or lost
  // piece changes the hash) and hand it to the upload path a drop uses.
  const digest = await b.ev(`(async () => {
    const buf = new Uint8Array(${size}); for (let k = 0; k < buf.length; k += 65536)
      crypto.getRandomValues(buf.subarray(k, Math.min(k + 65536, buf.length)));
    window._f = new File([buf], ${JSON.stringify(name)});
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join('');
  })()`);
  await b.network({ upload: 1500 * 1024 });     // ~8 s for 12 MB: room for the cuts
  await b.ev(`(() => { const p = Object.values(panes)[${i}]; handleUpload(p.id, { files: [window._f], value: '' }); return 1; })()`);
  const banner = () => b.ev(`(() => { const p = Object.values(panes)[${i}];
    const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`);
  // Cut the connections twice while it is going.
  let cuts = 0;
  const started = await until(async () => /\d+%/.test(await banner()), 10000);
  t.ok(started >= 0, 'upload started');
  for (let k = 0; k < 2; k++) { await sleep(1500); cuts += resetConnections(port) > 0 ? 1 : 0; }
  await b.network({});
  const done = await until(async () => /Saved to|Upload complete|Upload failed/.test(await banner()), 120000);
  const text = await banner();
  t.note(`banner: ${JSON.stringify(text)}; connections reset during the upload: ${cuts}`);
  t.ok(done >= 0 && /Saved to/.test(text), 'upload finished after the resets');
  // The target is this machine when E2E_SSH_HOST is it: compare on disk.
  const local = path.join(os.homedir(), name);
  const isLocal = fs.existsSync(local);
  if (isLocal) {
    const got = createHash('sha256').update(fs.readFileSync(local)).digest('hex');
    t.ok(fs.statSync(local).size === size, `size on disk ${fs.statSync(local).size} = ${size}`);
    t.ok(got === digest, 'sha256 on disk equals the file in the browser');
    fs.unlinkSync(local);
  } else {
    t.note(`target ${cfg.host} is not this machine: checked the banner only`);
    await b.type(i, `rm -f ~/${name}\r`);
  }
  t.ok(cuts === 2, `the connection was really cut twice (${cuts})`);
  t.ok(b.requests.upload >= 3 + cuts, `sent in pieces, cut pieces retried: ${b.requests.upload} upload requests`);
}
