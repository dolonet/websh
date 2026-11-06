// The file browser and folders that are not plain directories (owner,
// 2026-10-23: "in the file browser I don't see mounted folders"). On
// the owner's host ~/mnt is an rclone FUSE mount (size 0, link count 1),
// and ~/выгрузка, ~/job/БЮ_ОптРеш are symlinks to directories inside it.
// What must hold, sealed mode off and on: a mounted directory is listed
// as a folder and opens; a symlink to a directory is a folder you can
// open (it is a folder to the user); a symlink to a file still
// downloads; a broken symlink is listed and breaks nothing.
//
// Builds its own fixture in a fresh directory under /tmp (a directory, a
// symlink to it, a symlink to a file, a broken symlink) and removes it.
// The target must be this machine (E2E_SSH_HOST = its address, as on the
// owner's host); the real ~/mnt and ~/job are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep, until, tagOf } from '../lib.mjs';
export const meta = { about: "file browser: a symlink to a folder is a folder you can open; rename/delete touch only the link (sealed off and on)", ssh: true, local: true };

const rows = b => b.ev(`Array.from(document.querySelectorAll('#fbList .fb-row')).map(r => ({ name: r.dataset.name, type: r.dataset.type, ic: (r.querySelector('.fb-ic use') || {getAttribute: () => ''}).getAttribute('href') }))`);
const cur = b => b.ev(`(document.getElementById('fbPath') || {getAttribute: () => ''}).getAttribute('data-path') || ''`);
const click = (b, name) => b.ev(`(() => { const r = Array.from(document.querySelectorAll('#fbList .fb-row')).find(r => r.dataset.name === ${JSON.stringify(name)}); if (!r) return false; r.click(); return true; })()`);

export async function run({ b, t }) {
  const tag = tagOf('L');
  const base = path.join(os.tmpdir(), `websh-e2e-fb-${tag}`);
  const local = fs.existsSync(os.homedir());
  // The fixture is made on this machine; the target is this machine
  // when E2E_SSH_HOST points at it (as on the owner's host).
  fs.mkdirSync(path.join(base, 'real-dir'), { recursive: true });
  fs.writeFileSync(path.join(base, 'real-dir', 'inside.txt'), 'inside ' + tag + '\n');
  fs.writeFileSync(path.join(base, 'plain.txt'), 'plain\n');
  fs.symlinkSync('real-dir', path.join(base, 'link-to-dir'));
  fs.symlinkSync('plain.txt', path.join(base, 'link-to-file'));
  fs.symlinkSync('does-not-exist', path.join(base, 'broken-link'));
  try {
    const i = await b.connect();
    for (const mode of ['off', 'on']) {
      if ((await b.ev('settings.sealed')) !== (mode === 'on'))
        await b.ev(`(() => { openOptions(); document.getElementById('optSealed').click(); closeOptions(); return 1; })()`);
      t.note(`--- sealed mode ${mode}`);
      await b.ev(`(() => { showFileBrowser(Object.keys(panes)[${i}]); return 1; })()`);
      await sleep(300);
      await b.ev(`loadFbDir(${JSON.stringify(base)})`);
      t.ok(await until(async () => (await rows(b)).some(r => r.name === 'real-dir'), 8000) >= 0, `${mode}: the fixture directory is listed`);
      const list = await rows(b);
      const by = n => list.find(r => r.name === n);
      for (const n of ['real-dir', 'plain.txt', 'link-to-dir', 'link-to-file', 'broken-link'])
        t.ok(!!by(n), `${mode}: "${n}" is listed`);
      t.note(`${mode}: rows ` + JSON.stringify(list.filter(r => r.name !== '..').map(r => [r.name, r.type, r.ic])));
      const names = list.filter(r => r.name !== '..').map(r => r.name);
      t.ok(names.indexOf('link-to-dir') < names.indexOf('plain.txt'), `${mode}: the folder link is listed with the folders, before the files`);
      t.ok(/folder/.test((by('link-to-dir') || {}).ic || ''), `${mode}: with a folder icon`);
      // A symlink to a directory is a folder to the user: it opens.
      t.ok(await click(b, 'link-to-dir'), `${mode}: clicked "link-to-dir"`);
      const entered = await until(async () => (await cur(b)).endsWith('/link-to-dir') && (await rows(b)).some(r => r.name === 'inside.txt'), 5000);
      t.ok(entered >= 0, `${mode}: a symlink to a folder opens like a folder (now at ${JSON.stringify(await cur(b))})`);
      const downloads = await b.ev(`(Object.values(panes)[${i}].download ? 1 : 0)`);
      t.ok(downloads === 0, `${mode}: clicking the folder link started no download`);
      // Back to the fixture; a link to a file still downloads.
      await b.ev(`(() => { showFileBrowser(Object.keys(panes)[${i}]); return 1; })()`);
      await sleep(300);
      await b.ev(`loadFbDir(${JSON.stringify(base)})`);
      await until(async () => (await rows(b)).some(r => r.name === 'link-to-file'), 5000);
      await click(b, 'link-to-file');
      const dl = await until(async () => /Download|Saved|complete|plain/i.test(await b.ev(`(() => { const p = Object.values(panes)[${i}]; const e = p.el.querySelector('[data-upload-progress] .upload-progress-text'); return e ? e.textContent : ''; })()`)), 5000);
      t.ok(dl >= 0, `${mode}: a symlink to a file still downloads`);
      await until(async () => !(await b.ev(`!!Object.values(panes)[${i}].download`)), 8000);
      // Rename and delete act on the link, never on the folder it points to.
      const ln = `ln-${mode}`;
      fs.symlinkSync('real-dir', path.join(base, ln));
      await b.ev(`(() => { showFileBrowser(Object.keys(panes)[${i}]); return 1; })()`);
      await sleep(300);
      await b.ev(`loadFbDir(${JSON.stringify(base)})`);
      t.ok(await until(async () => (await rows(b)).some(r => r.name === ln), 5000) >= 0, `${mode}: the new link "${ln}" is listed`);
      await b.ev(`(() => { const r = Array.from(document.querySelectorAll('#fbList .fb-row')).find(r => r.dataset.name === ${JSON.stringify(ln)});
        if (!r) return 0; r.querySelector('[data-fb-ren]').click(); const inp = r.querySelector('.fb-ed-inp'); inp.value = ${JSON.stringify(ln + '-renamed')};
        inp.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); return 1; })()`);
      const renamed = await until(() => fs.existsSync(path.join(base, ln + '-renamed')) || (() => { try { fs.lstatSync(path.join(base, ln + '-renamed')); return true; } catch (e) { return false; } })(), 5000);
      t.ok(renamed >= 0 && fs.lstatSync(path.join(base, ln + '-renamed')).isSymbolicLink(), `${mode}: rename moved the link (still a link)`);
      t.ok(fs.existsSync(path.join(base, 'real-dir', 'inside.txt')), `${mode}: the folder it points to keeps its name and contents`);
      await until(async () => (await rows(b)).some(r => r.name === ln + '-renamed'), 5000);
      await b.ev(`(() => { const r = Array.from(document.querySelectorAll('#fbList .fb-row')).find(r => r.dataset.name === ${JSON.stringify(ln + '-renamed')});
        if (!r) return 0; r.querySelector('[data-fb-del]').click(); r.querySelector('.fb-cf-yes').click(); return 1; })()`);
      const gone = await until(() => { try { fs.lstatSync(path.join(base, ln + '-renamed')); return false; } catch (e) { return true; } }, 5000);
      t.ok(gone >= 0, `${mode}: delete removed the link`);
      t.ok(fs.existsSync(path.join(base, 'real-dir', 'inside.txt')), `${mode}: and nothing it pointed to`);
      await b.ev(`(() => { try { closeFb(); } catch (e) {} return 1; })()`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
