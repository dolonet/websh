// OSC 8 hyperlinks (ESC ] 8 ; ; URL ESC \ text ESC ] 8 ; ; ESC \), as
// Claude Code, `ls --hyperlink`, gcc and systemd print them. The owner
// reported: "words that are hyperlinks, clicking does nothing". A user
// must see that the text is a link and where it goes (the visible text
// is not the target), and a click - plain, Ctrl or Cmd - opens the
// target in a new browser tab, once, with no confirm() in the way. Only
// http(s) open; javascript:, data:, file: never do. In a persistent
// pane the link has to survive tmux, also after the page is reloaded
// and the pane re-attaches to the session that already exists. Plain
// URLs in the output keep opening as before.
//
// Everything printed is octal-escaped in the printf command, so the
// command's own echo contains neither the link text nor the URL: the
// row found is the output, and a URL on screen in a tooltip is not the
// echo. New tabs are counted from Chromium's own target list (a real
// popup, not a spied window.open); dialogs are caught via CDP and
// dismissed.
import fs from 'node:fs';
import path from 'node:path';
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'OSC 8 links in a plain and a tmux pane: shown as links with their target, a click opens a tab; unsafe schemes never',
  ssh: true, local: true,
};

const oct = s => Array.from(Buffer.from(s, 'utf8')).map(c => '\\' + c.toString(8).padStart(3, '0')).join('');

export async function run({ b, t }) {
  const J = JSON.stringify;
  const devPort = +fs.readFileSync(path.join(b.dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = async () => (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).filter(x => x.type === 'page');
  const closeTarget = id => fetch(`http://127.0.0.1:${devPort}/json/close/${id}`).catch(() => {});

  // Dialogs (xterm's default OSC 8 handler asks confirm()): record, dismiss.
  const dialogs = [];
  const origOn = b._on.bind(b);
  b._on = d => {
    if (d.method === 'Page.javascriptDialogOpening') {
      dialogs.push(d.params.type + ': ' + d.params.message.replace(/\s+/g, ' ').slice(0, 90));
      b.send('Page.handleJavaScriptDialog', { accept: false });
    }
    origOn(d);
  };

  // A target must not boot another websh page: restoring its saved panes
  // can attach to the same tmux slot and detach the terminal under test.
  // /api/ping is inert JSON, while real popup and exact-URL checks remain.
  const origin = await b.ev('location.origin');
  // Diagnostics only: was window.open called at all (a blocked popup
  // would show up as a call with no new tab)?
  const countActs = () => b.ev(`(() => { if (typeof TERM_LINK_HANDLER === 'object' && !TERM_LINK_HANDLER.__wrapped) {
    const a = TERM_LINK_HANDLER.activate; TERM_LINK_HANDLER.activate = function () { window.__acts = (window.__acts || 0) + 1; return a.apply(this, arguments); };
    TERM_LINK_HANDLER.__wrapped = true; } return 1; })()`);
  await countActs();
  await b.ev(`(() => { window.__opens = []; const o = window.open;
    window.open = function () { window.__opens.push(String(arguments[0] === undefined ? '(none)' : arguments[0])); return o.apply(this, arguments); };
    return 1; })()`);

  const pv = i => `Object.values(panes)[${i}]`;
  // Record every OSC 8 that reaches xterm's parser (does not consume it).
  const hookOsc = i => b.ev(`(() => { const p = ${pv(i)}; window.__osc8 = window.__osc8 || {};
    const k = p.id; window.__osc8[k] = window.__osc8[k] || [];
    p.term.parser.registerOscHandler(8, d => { window.__osc8[k].push(d); return false; }); return 1; })()`);
  const oscSeen = (i, url) => b.ev(`(() => { const p = ${pv(i)}; return ((window.__osc8 || {})[p.id] || []).some(d => d.includes(${J(url)})); })()`);
  const type = (i, text) => b.ev(`(() => { const p = ${pv(i)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);

  // Where `text` is on screen in pane i (not on the printf echo line):
  // the centre of its third character, in page pixels.
  const where = (i, text) => b.ev(`(() => { const p = ${pv(i)}; const bf = p.term.buffer.active;
    const scr = p.el.querySelector('.xterm-screen'); const r = scr.getBoundingClientRect();
    const cw = r.width / p.term.cols, ch = r.height / p.term.rows;
    for (let y = bf.length - 1; y >= 0; y--) {
      const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
      const x = s.indexOf(${J(text)}); if (x < 0 || s.includes('printf')) continue;
      const vy = y - bf.viewportY; if (vy < 0 || vy >= p.term.rows) return null;
      return { x: r.left + (x + 2.5) * cw, y: r.top + (vy + 0.5) * ch };
    }
    return null; })()`);

  // Diagnostics: the OSC 8 target xterm holds for the cells of `text`
  // right now (null = the cell is not part of any OSC 8 link).
  const cellLinks = (i, text) => b.ev(`(() => { const p = ${pv(i)}; const core = p.term._core; const bf = p.term.buffer.active;
    for (let y = bf.length - 1; y >= 0; y--) {
      const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
      const x = s.indexOf(${J(text)}); if (x < 0 || s.includes('printf')) continue;
      const line = core.buffer.lines.get(y); const ids = [];
      // A fresh cell: getNullCell() is xterm's shared fill cell, and loading
      // into it would paint that character into every later erase.
      const cell = new (core.buffer.getNullCell().constructor)();
      for (let c = x; c < x + ${J(text)}.length; c += 4) { line.loadCell(c, cell);
        const id = cell.hasExtendedAttrs() && cell.extended.urlId; const d = id && core._oscLinkService.getLinkData(id);
        ids.push(d ? d.uri.slice(-24) : null); }
      return ids;
    }
    return 'text not found'; })()`);

  const mouse = (type, pt, mods, buttons) => b.send('Input.dispatchMouseEvent',
    { type, x: pt.x, y: pt.y, modifiers: mods || 0, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: buttons || 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const away = async i => { const r = await b.ev(`(() => { const q = ${pv(i)}.el.querySelector('.xterm-screen').getBoundingClientRect(); return {x: q.right - 5, y: q.bottom - 5}; })()`); await mouse('mouseMoved', r);
    // Until xterm has dropped the link, its pointer cursor stays; the
    // next click's wait for the pointer would pass on the old one.
    await until(() => b.ev(`!${pv(i)}.el.querySelector('.xterm-cursor-pointer') && !(${pv(i)}.el.querySelector('.xterm') || {classList: {contains() {}}}).classList.contains('xterm-cursor-pointer')`), 1000, 20); };

  // Hover: does the user see a link, and its target?
  const hover = async (i, pt, url) => {
    await mouse('mouseMoved', { x: pt.x - 3, y: pt.y });
    await mouse('mouseMoved', pt);
    let seen = null;
    await until(async () => {
      seen = await b.ev(`(() => { const p = ${pv(i)};
        const pointer = !!p.el.querySelector('.xterm-cursor-pointer') || (p.el.querySelector('.xterm') || {classList:{contains(){}}}).classList.contains('xterm-cursor-pointer');
        const under = document.elementFromPoint(${pt.x}, ${pt.y});
        let titled = false; for (let e = under; e; e = e.parentElement) if ((e.title || '').includes(${J(url)})) titled = true;
        const shown = document.body.innerText.includes(${J(url)});
        return { pointer, titled, shown }; })()`);
      return seen.pointer && (seen.titled || seen.shown);
    }, 2000, 100);
    return seen;
  };

  // Click at pt with modifiers; what opened within `ms`.
  const click = async (pt, mods, ms) => {
    const before = new Set((await targets()).map(x => x.id));
    const d0 = dialogs.length;
    const o0 = await b.ev('window.__opens.length');
    // A real mouse arrives in several moves; one synthetic jump onto
    // the link right after output scrolled left xterm on its previous
    // link (pointer already shown, the press activated nothing: 1 run in
    // 15, plain and BEL cases). Approach from the side, as hover() does.
    await mouse('mouseMoved', { x: pt.x - 3, y: pt.y }, mods);
    await mouse('mouseMoved', pt, mods);
    // xterm resolves the link under the pointer asynchronously after a
    // move and activates only a resolved link: a press in the same
    // millisecond as the move (no person is that fast) clicks plain
    // text. That was the 1-in-10 "opens nothing" of the BEL and the
    // URL-looking cases. Wait for the pointer cursor; an unsafe link
    // never gets one, and the wait just runs out.
    const a0 = await b.ev('window.__acts || 0');
    const pointerMs = await until(() => b.ev(`(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y});
      const x = e && e.closest && e.closest('.xterm'); return !!x && (x.classList.contains('xterm-cursor-pointer') || !!x.querySelector('.xterm-cursor-pointer')); })()`), 1000, 20);
    await mouse('mousePressed', pt, mods, 1);
    await mouse('mouseReleased', pt, mods, 0);
    let fresh = [];
    await until(async () => {
      fresh = (await targets()).filter(x => !before.has(x.id));
      return fresh.length > 0 && fresh.every(x => x.url && x.url !== 'about:blank');
    }, ms || 3000, 100);
    if (!fresh.length) await sleep(300);   // a late second tab still counts
    fresh = (await targets()).filter(x => !before.has(x.id));
    const urls = fresh.map(x => x.url);
    for (const x of fresh) await closeTarget(x.id);
    const opens = (await b.ev('window.__opens')).slice(o0);
    const acts = (await b.ev('window.__acts || 0')) - a0;
    return { urls, dialogs: dialogs.slice(d0), opens, pointerMs, acts };
  };
  const desc = r => `tabs=${J(r.urls)} dialogs=${J(r.dialogs)} window.open=${J(r.opens)}` +
    (r.urls.length ? '' : ` (pointer after ${r.pointerMs} ms, link handler activations ${r.acts})`);
  const MODS = [['plain click', 0], ['Ctrl+click', 2], ['Cmd+click', 4]];

  const print = async (i, url, text, bel) => {
    const st = bel ? '\\007' : '\\033\\\\';
    await type(i, `printf '\\033]8;;${oct(url)}${st}${oct(text)}\\033]8;;${st}\\n'\r`);
    // Wait for the prompt after the output too: until it comes, the
    // screen may still scroll a row and a click aimed at the text lands
    // on the row below (no link there, nothing opens).
    return (await until(async () => {
      const pt = await where(i, text);
      if (!pt) return false;
      const after = await b.ev(`(() => { const bf = ${pv(i)}.term.buffer.active; let seen = false;
        for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
          if (s.includes(${J(text)}) && !s.includes('printf')) seen = true;
          else if (seen && /[$#] *$/.test(s)) return true; }
        return false; })()`);
      return after && J(await where(i, text)) === J(pt);
    }, 8000)) >= 0;
  };

  const linkChecks = async (i, kind) => {
    const tag = tagOf('');
    // 1. ST-terminated link, visible text differs from the target.
    const url = `${origin}/api/ping?osc8=${kind}_${tag}&q=1#frag`;
    const text = `LNK${kind}${tag}`;
    t.ok(await print(i, url, text), `${kind}: the link text is printed`);
    t.ok(await until(() => oscSeen(i, url), 3000) >= 0, `${kind}: the OSC 8 sequence reaches xterm (not stripped on the way)`);
    let pt = await where(i, text);
    const h = await hover(i, pt, url);
    t.ok(h && h.pointer, `${kind}: hovering the link text shows it is a link (pointer cursor): ${J(h)}`);
    t.ok(h && (h.titled || h.shown), `${kind}: hovering shows the target URL to the user (tooltip/status): ${J(h)}`);
    for (const [what, m] of MODS) {
      const r = await click(pt, m);
      t.ok(r.dialogs.length === 0, `${kind}: OSC 8 link, ${what}: no dialog - ${desc(r)}`);
      t.ok(r.urls.length === 1 && r.urls[0] === url, `${kind}: OSC 8 link, ${what}: exactly one new tab at the target - ${desc(r)}`);
      await away(i);
    }

    // 2. BEL-terminated.
    const urlB = `${origin}/api/ping?osc8bel=${kind}_${tag}`;
    const textB = `BEL${kind}${tag}`;
    await print(i, urlB, textB, true);
    pt = await where(i, textB);
    if (pt) {
      const r = await click(pt, 0);
      const okB = r.dialogs.length === 0 && r.urls.length === 1 && r.urls[0] === urlB;
      t.ok(okB, `${kind}: BEL-terminated OSC 8 link opens its target - ${desc(r)}`);
      if (!okB) t.note(`  aimed at ${J(pt)}, text now at ${J(await where(i, textB))}, OSC 8 target of its cells: ${J(await cellLinks(i, textB))}`);
    } else t.ok(false, `${kind}: BEL-terminated link text not found on screen`);
    await away(i);

    // 3. The visible text is itself a URL, different from the target:
    // the click goes to the target, and only there.
    const urlT = `${origin}/api/ping?osc8real=${kind}_${tag}`;
    const textT = `http://shown.invalid/${kind}${tag}`;
    await print(i, urlT, textT);
    pt = await where(i, textT);
    if (pt) {
      const before = await cellLinks(i, textT);
      const r = await click(pt, 0);
      const ok3 = r.urls.length === 1 && r.urls[0] === urlT && r.dialogs.length === 0;
      t.ok(ok3, `${kind}: a link whose text looks like another URL opens its real target, once - ${desc(r)}`);
      if (!ok3) t.note(`  OSC 8 target of the link cells before the click: ${J(before)}, after: ${J(await cellLinks(i, textT))}`);
    } else t.ok(false, `${kind}: URL-looking link text not found on screen`);
    await away(i);

    // 4. Unsafe schemes never open, whatever the modifier.
    const bad = [['javascript', 'javascript:window.__pwned=1'], ['JaVaScRiPt', 'JaVaScRiPt:window.__pwned=2'],
                 ['data', 'data:text/html,<script>opener&&(opener.__pwned=3)</script>'], ['file', 'file:///etc/passwd']];
    for (const [n, u] of bad) {
      const tx = `BAD${n}${kind}${tag}`;
      await print(i, u, tx);
      pt = await where(i, tx);
      if (!pt) { t.ok(false, `${kind}: ${n} link text not found`); continue; }
      for (const [what, m] of [['plain click', 0], ['Ctrl+click', 2]]) {
        const r = await click(pt, m, 1500);
        const pwned = await b.ev('window.__pwned || 0');
        t.ok(r.urls.length === 0 && r.dialogs.length === 0 && !pwned, `${kind}: ${n}: link, ${what}: nothing opens, nothing runs - ${desc(r)} pwned=${pwned}`);
      }
      await away(i);
    }

    // 5. Plain URL in the output (no OSC 8): opens as before.
    const urlP = `${origin}/api/ping?plain=${kind}_${tag}`;
    await type(i, `printf '${oct(urlP)}\\n'\r`);
    await until(async () => !!(await where(i, urlP)), 8000);
    pt = await where(i, urlP);
    if (pt) {
      for (const [what, m] of MODS) {
        const r = await click(pt, m);
        t.note(`${kind}: plain URL, ${what}: ${desc(r)}`);
        const okP = r.urls.length === 1 && r.urls[0] === urlP && r.dialogs.length === 0;
        t.ok(okP, `${kind}: plain URL, ${what}: one tab at the URL, no dialog - ${desc(r)}`);
        if (!okP && m === 0) t.note(`  screen rows around it: ${J((await b.lines(i)).filter(l => l).slice(-6))}`);
        await away(i);
      }
    } else t.ok(false, `${kind}: plain URL not found on screen`);
  };

  const a = await b.connect({ persistent: false });
  await hookOsc(a);
  await linkChecks(a, 'plain');

  const p = await b.split({ persistent: true });
  await hookOsc(p);
  t.ok(await b.ev(`${pv(p)}.persistent === true`), 'second pane is persistent (tmux)');
  const mouseOn = await b.ev(`${pv(p)}.term.modes.mouseTrackingMode`);
  t.note(`tmux pane mouse tracking mode: ${mouseOn}`);
  await linkChecks(p, 'tmux');

  // Reload: the persistent pane re-attaches to the tmux session that
  // already exists; links must still come through.
  const sidBefore = await b.ev(`${pv(p)}.slotId`);
  await b.open(b.url);
  await countActs();
  await b.ev(`(() => { window.__opens = []; const o = window.open;
    window.open = function () { window.__opens.push(String(arguments[0] === undefined ? '(none)' : arguments[0])); return o.apply(this, arguments); };
    return 1; })()`);
  const back = await until(() => b.ev(`Object.values(panes).some(p => p.persistent && p.sid && p.slotId === ${J(sidBefore)})`), 30000);
  t.ok(back >= 0, 'after reload: the persistent pane is back on its tmux session');
  if (back >= 0) {
    const r = await b.ev(`Object.values(panes).findIndex(p => p.persistent && p.slotId === ${J(sidBefore)})`);
    await sleep(1500);
    await hookOsc(r);
    const tag = tagOf('');
    const url = `${origin}/api/ping?osc8re=${tag}`, text = `REATT${tag}`;
    t.ok(await print(r, url, text), 're-attached: link text printed');
    t.ok(await until(() => oscSeen(r, url), 3000) >= 0, 're-attached tmux pane: the OSC 8 sequence reaches xterm');
    const pt = await where(r, text);
    if (pt) {
      const c = await click(pt, 0);
      t.ok(c.urls.length === 1 && c.urls[0] === url && c.dialogs.length === 0, `re-attached tmux pane: a click opens the target - ${desc(c)}`);
    }
  }
}
