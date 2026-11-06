#!/usr/bin/env node
// Browser scenarios for websh: a real Chromium, a real ssh session, real
// network faults. See tests/e2e/README.md.
//
//   node tests/e2e/run.mjs                      every scenario, private instance
//   node tests/e2e/run.mjs silent away          some of them
//   node tests/e2e/run.mjs --url https://host/  the ones that are safe against
//                                               a deployment (no faults, no restarts)
//   node tests/e2e/run.mjs --repeat 10 away     hunt a race
//   node tests/e2e/run.mjs --list
import fs from 'node:fs';
import path from 'node:path';
import { HERE, cfg, Browser, LocalServer, Report, haveSudo, blackholeOff } from './lib.mjs';

const args = process.argv.slice(2);
const take = flag => { const i = args.indexOf(flag); if (i < 0) return null; return args.splice(i, 2)[1]; };
const has = flag => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
const url = take('--url');
const repeat = +(take('--repeat') || 1);
const list = has('--list');

const ORDER = ['smoke', 'typing', 'offline', 'drop', 'silent', 'restart', 'away', 'upload'];
const all = {};
for (const f of fs.readdirSync(path.join(HERE, 'scenarios')).filter(f => f.endsWith('.mjs')))
  all[f.replace(/\.mjs$/, '')] = await import('./scenarios/' + f);
const names = Object.keys(all).sort((a, b) => (ORDER.indexOf(a) + 99) % 99 - (ORDER.indexOf(b) + 99) % 99);

if (list) {
  for (const n of names) {
    const m = all[n].meta;
    console.log(n.padEnd(9), [m.ssh && 'ssh', m.local && 'private instance', m.sudo && 'sudo'].filter(Boolean).join(', ').padEnd(30), m.about);
  }
  process.exit(0);
}
for (const n of args) if (!all[n]) { console.error(`unknown scenario "${n}" (try --list)`); process.exit(2); }

const sudoOk = haveSudo();
let failed = 0, ran = 0, skipped = [], leftovers = [];
const started = Date.now();
process.on('exit', () => { if (sudoOk) blackholeOff(); });

for (const name of (args.length ? args : names)) {
  const { meta, run } = all[name];
  let why = '';
  if (meta.ssh && !cfg.password) why = 'E2E_SSH_PASSWORD is not set';
  else if (meta.local && url) why = 'injects faults / restarts: private instance only';
  else if (meta.sudo && !sudoOk) why = 'needs sudo (set E2E_SUDO_PASSWORD, or passwordless sudo)';
  if (why) { skipped.push(name); console.log(`\n--- ${name}: SKIPPED - ${why}`); continue; }

  for (let n = 1; n <= repeat; n++) {
    console.log(`\n=== ${name}${repeat > 1 ? ` (${n}/${repeat})` : ''}: ${meta.about}`);
    const t = new Report();
    const server = url ? null : new LocalServer(cfg.port, meta.env);
    let b = null;
    try {
      if (server) await server.start();
      b = await Browser.launch();
      await b.open(url || server.url);
      await run({ b, t, server, port: cfg.port });
      t.ok(b.errors.length === 0, 'no script errors' + (b.errors.length ? ': ' + b.errors.slice(0, 3).join(' | ') : ''));
    } catch (e) {
      t.ok(false, 'scenario aborted: ' + (e && e.message || e));
    } finally {
      if (sudoOk) blackholeOff();
      if (b) {
        const end = await b.endAll();
        if (end.ended) t.note(`ended ${end.ended} test session(s)`);
        if (end.left.length) { leftovers.push(...end.left); t.note('NOT cleaned up: ' + end.left.join(', ')); }
        await b.close();
      }
      if (server) await server.stop();
    }
    ran++;
    if (t.failed) { failed++; console.log(`    => ${name} FAILED`); }
  }
}
console.log(`\n===========================================`);
console.log(`  scenarios run: ${ran}   failed: ${failed}   skipped: ${skipped.length}${skipped.length ? ' (' + skipped.join(', ') + ')' : ''}   ${Math.round((Date.now() - started) / 1000)} s`);
if (leftovers.length) {
  console.log('  tmux sessions left on the target - remove each by its exact name:');
  for (const l of leftovers) console.log(`    tmux kill-session -t '=${l}'`);
}
process.exit(failed ? 1 : 0);
