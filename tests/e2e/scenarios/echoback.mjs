// "I type, but the text does not appear; after a reload it is there."
// The keys reach the shell, the browser stops showing that pane's output.
//
// Three persistent panes, as the owner works: A and B split in one tab
// (A runs something that prints all the time, like a coding agent), C in
// a second tab. Between rounds the things a user does happen - switching
// tabs inside websh, switching to another browser tab for a while (a real
// hidden document: full Chromium, --headless=new), moving a pane between
// tabs, a network reset - and after each one a command is typed into B
// and C. The typed text must show up, on screen, within a moment.
//
// When it does not, the scenario says where it stopped:
//   transport  the server has produced more output for the session than
//              the pane has received (p.outCursor behind /api/input's
//              cursor) - the output channel is not delivering;
//   rendering  the text is in xterm's buffer but not in the rows drawn
//              on the screen.
//
// Knobs (env): E2E_ECHO_ACTIONS=comma list, E2E_ECHO_ROUNDS=n.
import { sleep, tagOf, until, resetConnections, blackhole, blackholeOff } from '../lib.mjs';
export const meta = {
  about: 'typed text shows up in every pane after tab switches, hidden browser tab, moves, resets, with a busy pane',
  ssh: true, local: true, sudo: true, browser: 'full', front: 'h2',
};

const WAIT = +(process.env.E2E_ECHO_WAIT || 8000);
const ALL = ['idle', 'tabswitch', 'hide-short', 'hide-long', 'move', 'merge', 'reset', 'hide-type'];

export async function run({ b, t, port, front }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const type = (id, text) => b.ev(`(() => { const p = ${pane(id)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  const tabOf = id => b.ev(`(() => { const r = ${pane(id)}.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const click = async sel => {
    const r = await b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
      e.scrollIntoView({block: 'nearest', inline: 'nearest'});
      const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    if (!r) throw new Error('no element ' + sel);
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  };
  const clickTab = id => click(`#tabs .tab[data-tab="${id}"] .tab-label`);

  // Every EventSource the page opens, to find one nobody owns any more.
  await b.ev(`(() => { if (window.__ES) return 1; const Orig = window.EventSource; window.__ES = [];
    window.EventSource = function (url, o) { const es = new Orig(url, o); __ES.push(es); return es; };
    window.EventSource.prototype = Orig.prototype; window.EventSource.CLOSED = 2; return 1; })()`);
  // Everything we can measure about one pane, without changing it: the
  // /api/input with no data is what the keepalive sends.
  await b.ev(`window.__probe = async (id, mark) => {
    const p = panes[id]; if (!p) return null;
    let srv = null;
    // Never waits more than 2 s: on a dead connection it would hang.
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 2000);
    try { const r = await api('input', {body: {session_id: p.sid, data: ''}, signal: ctl.signal}); srv = r.cursor; }
    catch (e) { srv = 'no reply'; }
    clearTimeout(tm);
    const bf = p.term.buffer.active; let buf = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) buf += l.translateToString(true) + '\\n'; }
    const rows = p.el.querySelector('.xterm-rows');
    const painted = rows ? rows.textContent.replace(/\\u00a0/g, ' ') : '';
    const rs = p.term._core._renderService;
    const es = p.eventSource;
    // Painted means visible: the text node holding the mark has a box
    // inside the terminal's screen and nothing else is on top of it.
    let seen = false, why = '';
    if (rows && painted.includes(mark)) {
      const w = document.createTreeWalker(rows, NodeFilter.SHOW_ELEMENT);
      let el = null;
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.parentNode === rows && n.textContent.replace(/\u00a0/g, ' ').includes(mark)) { el = n; break; }
      if (!el) why = 'mark split across rows';
      else {
        const r = el.getBoundingClientRect(), sc = p.el.querySelector('.xterm-screen').getBoundingClientRect();
        const cx = r.left + Math.min(r.width, 40) / 2, cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (!(r.width > 0 && r.height > 0)) why = 'row has no size ' + JSON.stringify([r.width, r.height]);
        else if (cy < sc.top || cy > sc.bottom || cx < sc.left || cx > sc.right) why = 'row outside the screen ' + JSON.stringify([Math.round(cx), Math.round(cy), Math.round(sc.left), Math.round(sc.top), Math.round(sc.right), Math.round(sc.bottom)]);
        else if (!hit || !p.el.contains(hit)) why = 'covered by ' + (hit ? hit.tagName + '.' + hit.className : 'nothing');
        else seen = true;
      }
    }
    return { srv, out: p.outCursor || 0, inBuf: buf.includes(mark), painted: painted.includes(mark) && seen, notSeen: why,
      es: es ? es.readyState : null, esSince: es ? (es.url.match(/since=(\\d+)/) || [])[1] : null,
      sseDisabled: !!p.sseDisabled, why: p.sseDisabledReason || '', probe: !!p.sseProbe,
      reconnecting: !!p.reconnecting, paused: rs ? !!rs._isPaused : null,
      vis: document.visibilityState, hiddenTab: paneHidden(p), sid: (p.sid || '').slice(0, 8),
      ydisp: bf.viewportY, ybase: bf.baseY,
      stray: __ES.filter(e => e.readyState !== 2 && e !== p.eventSource && e !== p.sseProbe &&
                              e.url.indexOf(encodeURIComponent(p.sid)) >= 0).map(e => e.readyState + '@' + (e.url.match(/since=(\d+)/) || [])[1]),
      wq: (() => { const w = p.term._core._writeBuffer; if (!w) return null;
        let n = 0; for (let i = w._bufferOffset; i < w._writeBuffer.length; i++) n += w._writeBuffer[i].length;
        return n; })() };
  };
  // Rows drawn on the screen that differ from xterm's buffer (viewport).
  window.__paintDiff = id => {
    const p = panes[id]; if (!p) return null;
    const bf = p.term.buffer.active;
    const rows = p.el.querySelectorAll('.xterm-rows > div');
    let diff = 0;
    for (let y = 0; y < p.term.rows; y++) {
      const l = bf.getLine(bf.viewportY + y);
      const want = l ? l.translateToString(true).replace(/\s+$/, '') : '';
      const got = rows[y] ? rows[y].textContent.replace(/\u00a0/g, ' ').replace(/\s+$/, '') : '';
      if (want !== got) diff++;
    }
    return diff;
  }; 1`);

  // ── setup: A | B in tab 1, C in tab 2 ─────────────────────────────
  const iA = await b.connect({ persistent: true });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const iB = await b.split({ persistent: true });
  const B = await b.ev(`Object.keys(panes)[${iB}]`);
  const before = await b.ev('Object.keys(panes).length');
  await click('#tabNew');
  await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
  await b.ev(`(() => { ${b._fill(true)} doConnect(); return 1; })()`);
  const iC = await b._ready(before);
  const C = await b.ev(`Object.keys(panes)[${iC}]`);
  const t1 = await tabOf(A), t2 = await tabOf(C);
  t.ok(t1 && t2 && t1 !== t2 && (await tabOf(B)) === t1, 'A|B in one tab, C in another');
  await clickTab(t1);
  // A prints all the time, like an agent at work.
  await type(A, `clear; while :; do for i in $(seq 1 30); do echo busy_\${i}_\$(date +%s%N)_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done; sleep 0.4; done\r`);
  await sleep(1500);
  b.startTrace();

  const actions = (process.env.E2E_ECHO_ACTIONS || ALL.join(',')).split(',');
  const rounds = +(process.env.E2E_ECHO_ROUNDS || 2);
  const tag = tagOf('E');
  let n = 0, bad = 0;
  const stats = {};
  for (let r = 0; r < rounds; r++) {
    for (const act of actions) {
      const shownTab = await b.ev('activeTabId');
      let typedHidden = null;
      if (act === 'tabswitch') {
        await clickTab(shownTab === t1 ? t2 : t1); await sleep(400); await clickTab(shownTab);
      } else if (act === 'hide-short') {
        await b.hide(); await sleep(3000); await b.show();
      } else if (act === 'hide-long') {
        await b.hide(); await sleep(15000); await b.show();
      } else if (act === 'hide-6min') {
        // Long enough for Chrome's intensive throttling of a hidden page.
        await b.hide(); await sleep(390000); await b.show();
      } else if (act === 'hide-type') {
        // Away for a while, back, and typing at once.
        await b.hide(); await sleep(12000); await b.show();
      } else if (act === 'move') {
        // B goes to C's tab and back.
        await b.ev(`movePaneToTab(${J(B)}, ${J(await tabOf(C))}); 1`); await sleep(500);
        await b.ev(`movePaneToTab(${J(B)}, tabOfPane(${pane(A)}).id); 1`); await sleep(300);
      } else if (act === 'merge') {
        // C's tab merges into A|B, then C goes to a new tab again.
        await b.ev(`mergeTabIntoTab(${J(await tabOf(C))}, tabOfPane(${pane(A)}).id); 1`); await sleep(500);
        await b.ev(`movePaneToNewTab(${J(C)}); 1`); await sleep(300);
      } else if (act === 'outage') {
        // The network goes away for a minute and comes back (the same
        // connections resume: no FIN, no RST at any point).
        const bp = front ? front.port : port;
        t.note(`outage: black-holed ${blackhole(bp)} connection(s)`);
        await sleep(+(process.env.E2E_OUTAGE_MS || 56000)); blackholeOff();
      } else if (act === 'outage-hidden') {
        const bp = front ? front.port : port;
        await b.hide();
        t.note(`outage-hidden: black-holed ${blackhole(bp)} connection(s)`);
        await sleep(+(process.env.E2E_OUTAGE_MS || 56000)); blackholeOff();
        await sleep(2000); await b.show();
      } else if (act === 'wifi') {
        // The old connections die for good (a Wi-Fi switch); new ones work.
        const bp = front ? front.port : port;
        t.note(`wifi: black-holed ${blackhole(bp)} connection(s)`);
        await sleep(3000);
      } else if (act === 'freeze') {
        // Hidden, then frozen by the browser (Page Lifecycle), as Chrome
        // does to a background tab; woken, shown again.
        await b.hide(); await sleep(2000); await b.freeze();
        await sleep(+(process.env.E2E_FREEZE_MS || 60000));
        await b.unfreeze(); await sleep(500); await b.show();
      } else if (act === 'wifi-late') {
        const bp = front ? front.port : port;
        t.note(`wifi-late: black-holed ${blackhole(bp)} connection(s)`);
        await sleep(+(process.env.E2E_WIFI_LATE_MS || 12000));
      } else if (act === 'reset') {
        resetConnections(front ? front.port : port); await sleep(300);
      }
      if (act === 'burst-wifi' || act === 'burst') {
        // Fast typing across a silently dead connection (burst-wifi) or a
        // healthy one (burst): the shell must get every key exactly once,
        // in order. The command prints Q<payload>Z0; its echo on the
        // command line reads Q<payload>Z$((0)), so only the output matches.
        const id = B;
        const tid = await tabOf(id);
        if ((await b.ev('activeTabId')) !== tid) { await clickTab(tid); await sleep(200); }
        const abc = 'abcdefghijklmnopqrstuvwxyz';
        let payload = '';
        for (let k = 0; k < 60; k++) payload += abc[(k * 7 + r * 3 + n) % 26];
        const want = 'Q' + payload + 'Z0';
        const bp = front ? front.port : port;
        if (act === 'burst-wifi') t.note(`burst-wifi: black-holed ${blackhole(bp)} connection(s)`);
        const parts = ['echo Q'].concat(payload.match(/.{1,6}/g)).concat(['Z$((0))\r']);
        for (const part of parts) { await type(id, part); await sleep(150); }
        const t0 = Date.now();
        const got = await until(async () => (await b.ev(`(() => { const bf = ${pane(id)}.term.buffer.active; let s = '';
          for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; } return s; })()`))
          .split('\n').some(l => /Q[a-z]*Z0\s*$/.test(l.trim()) && !l.includes('$')), 60000, 250);
        if (act === 'burst-wifi') blackholeOff();
        await sleep(1500);
        const lines = (await b.ev(`(() => { const bf = ${pane(id)}.term.buffer.active; let s = '';
          for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; } return s; })()`))
          .split('\n').map(l => l.trim());
        const outs = lines.filter(l => /^Q[a-z]*Z0$/.test(l) || (/Q[a-z]*Z0$/.test(l) && !l.includes('$')));
        const exact = outs.filter(l => l.endsWith(want));
        const k2 = act + ':B';
        stats[k2] = stats[k2] || { n: 0, slow: 0, never: 0, max: 0 };
        stats[k2].n++;
        const okB = got >= 0 && exact.length === 1 && outs.length === 1;
        t.note(`round ${r} ${act}: output after ${got < 0 ? 'never' : (Date.now() - t0 - 1500) + ' ms'}; lines ${JSON.stringify(outs)}; want ${want}`);
        if (!okB) { bad++; if (got < 0) stats[k2].never++; else stats[k2].slow++; }
        await type(id, 'clear\r'); await sleep(500);
        continue;
      }
      // Every pane on screen draws what its buffer holds (a frame may lag:
      // stuck only if it differs three times in a row, 300 ms apart).
      for (const id of [A, B, C]) {
        if ((await tabOf(id)) !== (await b.ev('activeTabId'))) continue;
        let d = [];
        for (let k = 0; k < 3; k++) { d.push(await b.ev(`__paintDiff(${J(id)})`)); await sleep(300); }
        if (d.every(x => x > 2)) {
          bad++;
          t.note(`round ${r} ${act}: pane ${id === A ? 'A' : id === B ? 'B' : 'C'} paints rows that are not its buffer: ${J(d)} ` +
                 J(await b.ev(`__probe(${J(id)}, 'zz')`)));
        }
      }
      for (const id of [A, B, C]) {
        const st = (await b.ev(`__probe(${J(id)}, 'zz')`)).stray;
        if (st.length) { bad++; t.note(`round ${r} ${act}: pane ${id === A ? 'A' : id === B ? 'B' : 'C'} has EventSource(s) nobody owns: ${J(st)}`); }
      }
      // Type into B and C, each shown in turn as a user would.
      for (const id of [B, C]) {
        const tid = await tabOf(id);
        if ((await b.ev('activeTabId')) !== tid) { await clickTab(tid); await sleep(200); }
        const mark = `${tag}k${++n}`;
        const t0 = Date.now();
        const traceAt = (b.trace || []).length;
        await type(id, `echo ${mark}\r`);
        let firstBad = null;
        const got = await until(async () => {
          const s = await b.ev(`__probe(${J(id)}, ${J(mark)})`);
          if (!firstBad && Date.now() - t0 > 1500 && !(s.inBuf && s.painted)) firstBad = s;
          return s.inBuf && s.painted;
        }, WAIT, 250);
        const k = act + ':' + (id === B ? 'B' : 'C');
        stats[k] = stats[k] || { n: 0, slow: 0, never: 0, max: 0 };
        stats[k].n++;
        if (got < 0 || got > (act === 'reset' || act.startsWith('wifi') ? 6000 : 1500)) {
          bad++;
          if (got < 0) stats[k].never++; else stats[k].slow++;
          const s = await b.ev(`__probe(${J(id)}, ${J(mark)})`);
          const kind = s.out < (s.srv || 0) ? 'transport' : (s.inBuf && !s.painted ? 'rendering' : 'other');
          t.note(`round ${r} ${k}: ${got < 0 ? 'NOT shown in ' + WAIT / 1000 + ' s' : 'shown after ' + got + ' ms'}`);
          t.note(`   at 1.5 s: ${J(firstBad)}`);
          t.note(`   at end:   ${J(s)} => ${kind}`);
          const a = await b.ev(`__probe(${J(A)}, 'zz')`);
          const sid8 = s.sid;
          for (const l of (b.trace || []).slice(traceAt).filter(l => (l.includes(sid8) || !l.includes('sid=')) &&
                                                                   !/data=$/.test(l) && !/<< input 200$/.test(l)).slice(-60))
            t.note('     ' + l);
          t.note(`   pane A:   srv ${a.srv} out ${a.out} es ${a.es} since ${a.esSince} polling ${a.sseDisabled} wq ${a.wq}`);
        }
        stats[k].max = Math.max(stats[k].max, got < 0 ? WAIT : got);
      }
      if (act === 'wifi' || act === 'wifi-late') blackholeOff();
    }
  }
  for (const [k, v] of Object.entries(stats))
    t.note(`${k.padEnd(16)} typed ${v.n}, slow ${v.slow}, never ${v.never}, worst ${v.max} ms`);
  if (bad) { t.note('trace (last 60):'); for (const l of (b.trace || []).slice(-60)) t.note('  ' + l); }
  t.ok(bad === 0, `typed text showed up within 1.5 s every time (${n - bad}/${n})`);
  await type(A, '\x03');
}
