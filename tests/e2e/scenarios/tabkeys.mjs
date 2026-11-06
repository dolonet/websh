// Tab keyboard shortcuts (step 4 of the tabs feature), with real key
// events from Chromium (CDP Input.dispatchKeyEvent: key, code, virtual
// key code, modifiers) typed into xterm's own textarea - the path a
// user's keys take, through xterm's key handler.
//
// Alt+1..8 go to tab N, Alt+9 to the last, Alt+Shift+[ / ] previous /
// next (wrapping), Alt+T is "+", Alt+W closes the active tab. They are
// websh's: bash must not see them. bash makes that visible: ESC+digit
// is readline's digit-argument, so a leaked Alt+2 turns the next typed
// "Y" into "YY"; and the wire is checked too (no ESC+1/2/9/t/w/{/} in
// any /api/input). Alt+B (backward-word) still reaches bash and moves
// the cursor. A Cyrillic layout (e.key 'е' on KeyT) and macOS Option
// (navigator.platform MacIntel, e.key '¡' with text '¡') work by e.code.
//
// Relies on the tab DOM: #tabNew, #tabs .tab[data-tab] (.active),
// #panes .tab-root[data-tab].
import { sleep, tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'tab shortcuts with real keys: Alt+N / Alt+9 / Alt+Shift+[ ] / Alt+T / Alt+W switch, open, close; bash never sees them; Alt+B still moves the cursor; Cyrillic and macOS Option',
  ssh: true, local: true,
};

const ALT = 1, CTRL = 2, SHIFT = 8;

export async function run({ b, t }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const screen = id => b.ev(`(() => { const p = ${pane(id)}; if (!p || !p.term) return '';
    const bf = p.term.buffer.active; let s = '';
    for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (l) s += l.translateToString(true) + '\\n'; }
    return s; })()`);
  const lines = async id => (await screen(id)).split('\n').map(l => l.trim());
  const tabOf = id => b.ev(`(() => { const p = ${pane(id)}; const r = p && p.el.closest('.tab-root'); return r ? r.getAttribute('data-tab') : null; })()`);
  const tabs = () => b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e => e.getAttribute('data-tab'))`);
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  const formOpen = () => b.ev(`!document.getElementById('ov').classList.contains('h')`);
  const focusInXterm = id => b.ev(`(() => { const a = document.activeElement;
    return !!a && a.classList.contains('xterm-helper-textarea') && ${pane(id)}.el.contains(a); })()`);
  const clickAt = async sel => {
    const r = await b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
      const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
    if (!r) throw new Error('no element ' + sel);
    for (const type of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
  };
  // One real key press. `text` only for keys that type a character.
  const key = async (code, k, vk, mods, text) => {
    const down = { type: text ? 'keyDown' : 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk,
                   nativeVirtualKeyCode: vk, modifiers: mods || 0 };
    if (text) { down.text = text; down.unmodifiedText = text; }
    await b.send('Input.dispatchKeyEvent', down);
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk,
                                             nativeVirtualKeyCode: vk, modifiers: mods || 0 });
  };
  const VK = c => /^Digit/.test(c) ? 48 + +c.slice(5) : /^Key/.test(c) ? c.charCodeAt(3)
    : { BracketLeft: 219, BracketRight: 221, Enter: 13, Escape: 27 }[c];
  const alt = (code, k, more) => key(code, k, VK(code), ALT | (more || 0));
  // Plain typing, as real keys.
  const typeKeys = async s => {
    for (const ch of s) {
      if (ch === '\r') { await key('Enter', 'Enter', 13, 0, '\r'); continue; }
      const up = /[A-Z]/.test(ch);
      const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /\d/.test(ch) ? 'Digit' + ch
        : { ' ': 'Space', '_': 'Minus', '$': 'Digit4', '"': 'Quote', '=': 'Equal' }[ch] || 'Space';
      const vk = /[a-z]/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : /\d/.test(ch) ? ch.charCodeAt(0)
        : { ' ': 32, '_': 189, '$': 52, '"': 222, '=': 187 }[ch] || 32;
      await key(code, ch, vk, up || '_$"'.includes(ch) ? SHIFT : 0, ch);
    }
  };
  // Everything websh sent to the shells, from the network.
  const sent = [];
  b.ws.addEventListener('message', m => {
    const d = JSON.parse(m.data);
    if (d.method === 'Network.requestWillBeSent' && /action=input/.test(d.params.request.url)) {
      try { sent.push(JSON.parse(d.params.request.postData || '{}').data || ''); } catch (e) {}
    }
  });
  const wire = () => sent.join('');
  // Show the pane's tab with a click (independent of the shortcuts),
  // then click into its terminal.
  const focusPane = async id => {
    const tb = await tabOf(id);
    if (await activeTab() !== tb) {
      await clickAt(`#tabs .tab[data-tab="${tb}"] .tab-label`);
      await until(async () => await activeTab() === tb && await b.ev(`${pane(id)}.el.offsetWidth > 0`), 3000);
    }
    await clickAt(`#panes .pane[data-pane="${id}"] .xterm-screen`);
    await until(() => focusInXterm(id), 3000);
  };

  if (!t.ok(await b.ev(`!!document.getElementById('tabNew')`), 'the "+" button (#tabNew) exists')) return;
  const iA = await b.connect({ persistent: true });
  const A = await b.ev(`Object.keys(panes)[${iA}]`);
  const newTab = async () => {
    const before = await b.ev('Object.keys(panes).length');
    await clickAt('#tabNew');
    await until(() => formOpen(), 3000);
    await b.ev(`(() => { ${b._fill(true)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };
  const B = await newTab();
  const C = await newTab();
  const [tA, tB, tC] = [await tabOf(A), await tabOf(B), await tabOf(C)];
  t.ok(J(await tabs()) === J([tA, tB, tC]) && await activeTab() === tC, 'three tabs A, B, C; C in front');
  const tag = tagOf('K');

  // 1. Alt+digit while typing a command in C: switch away and back, the
  //    command line is untouched (a leaked ESC+2 would double the Y).
  await focusPane(C);
  t.ok(await focusInXterm(C), 'keyboard focus is in C\'s xterm textarea');
  await typeKeys(`echo ${tag}X`);
  await alt('Digit1', '1');
  t.ok(await until(async () => await activeTab() === tA, 3000) >= 0, 'Alt+1 shows tab 1 (A)');
  t.ok(await until(() => focusInXterm(A), 3000) >= 0, 'and the keyboard is in A\'s terminal');
  await alt('Digit3', '3');
  t.ok(await until(async () => await activeTab() === tC, 3000) >= 0, 'Alt+3 shows tab 3 (C)');
  await until(() => focusInXterm(C), 3000);
  await alt('Digit2', '2');
  t.ok(await until(async () => await activeTab() === tB, 3000) >= 0, 'Alt+2 shows tab 2 (B)');
  await alt('Digit9', '9');
  t.ok(await until(async () => await activeTab() === tC, 3000) >= 0, 'Alt+9 shows the last tab (C)');
  await until(() => focusInXterm(C), 3000);
  await alt('Digit7', '7');                          // no tab 7
  await sleep(300);
  t.ok(await activeTab() === tC, 'Alt+7 with three tabs changes nothing');
  await typeKeys('Y\r');
  const want = `${tag}XY`;
  const got = await until(async () => (await lines(C)).some(l => l === want || (l.startsWith(tag + 'X') && !l.includes('echo'))), 8000);
  const line = (await lines(C)).find(l => l.startsWith(tag + 'X') && !l.includes('echo'));
  t.ok(got >= 0 && line === want, `C's command line came through untouched: printed ${J(line || (await lines(C)).filter(Boolean).slice(-3))} (want ${J(want)}; a leaked Alt+digit makes "YY..")`);

  // 2. Next / previous with wrap, from inside the terminal.
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const was = await activeTab();
    await alt('BracketRight', '}', SHIFT);
    await until(async () => await activeTab() !== was, 2000);
    seq.push([tA, tB, tC].indexOf(await activeTab()));
  }
  t.ok(J(seq) === J([0, 1, 2, 0]), `Alt+Shift+] x4 from C: A,B,C,A (got ${J(seq)})`);
  const back = [];
  for (let i = 0; i < 2; i++) {
    const was = await activeTab();
    await alt('BracketLeft', '{', SHIFT);
    await until(async () => await activeTab() !== was, 2000);
    back.push([tA, tB, tC].indexOf(await activeTab()));
  }
  t.ok(J(back) === J([2, 1]), `Alt+Shift+[ x2 from A: C,B (got ${J(back)})`);

  // 3. Alt+B still reaches bash: backward-word moves the cursor.
  await focusPane(B);
  await typeKeys(`echo ${tag}P QR`);
  await alt('KeyB', 'b');
  await typeKeys('Z\r');
  const wantB = `${tag}P ZQR`;
  await until(async () => (await lines(B)).includes(wantB), 8000);
  t.ok((await lines(B)).includes(wantB), `Alt+B moved bash's cursor back one word: printed ${J((await lines(B)).find(l => l.startsWith(tag + 'P') && !l.includes('echo')))} (want ${J(wantB)})`);
  t.ok(await activeTab() === tB, 'Alt+B switched nothing');


  // 5. Alt+T opens the + form; Escape dismisses it, nothing made.
  await alt('KeyT', 't');
  t.ok(await until(() => formOpen(), 3000) >= 0, 'Alt+T opens the login form');
  // Under the form the shortcuts do nothing.
  await alt('Digit1', '1');
  await sleep(300);
  t.ok(await activeTab() === tB && await formOpen(), 'Alt+1 under the form: no switch, form stays');
  await key('Escape', 'Escape', 27, 0);
  await until(async () => !(await formOpen()), 3000);
  t.ok(!(await formOpen()) && (await tabs()).length === 3, 'Escape dismissed it; still three tabs');

  // 6. Cyrillic layout: KeyT gives 'е', BracketRight with shift 'Ъ'.
  await focusPane(B);
  await key('BracketRight', 'Ъ', 221, ALT | SHIFT);
  t.ok(await until(async () => await activeTab() === tC, 3000) >= 0, 'Cyrillic Alt+Shift+] (key "Ъ") shows the next tab');
  await key('KeyT', 'е', 84, ALT);
  t.ok(await until(() => formOpen(), 3000) >= 0, 'Cyrillic Alt+T (key "е") opens the form');
  await key('Escape', 'Escape', 27, 0);
  await until(async () => !(await formOpen()), 3000);

  // 7. Alt+W closes the active tab (C, short-lived? no: persistent -> may ask; answer it).
  await focusPane(C);
  await alt('KeyW', 'w');
  const asked = await until(async () => (await tabs()).length === 2 ||
    await b.ev(`!document.getElementById('confirmOv').classList.contains('h')`), 3000);
  if (await b.ev(`!document.getElementById('confirmOv').classList.contains('h')`)) {
    t.note('Alt+W asked to terminate the tmux session (as the tab x does); confirming');
    await b.ev(`confirmTerminate(false)`);
  }
  t.ok(asked >= 0 && await until(async () => (await tabs()).length === 2, 3000) >= 0 && !(await tabs()).includes(tC),
       'Alt+W closed tab C');

  // 8. The wire: no shortcut ever reached a shell.
  await sleep(500);
  const leaked = wire().match(/\x1b[0-9tTwW{}]|[еЪ]/g);
  t.ok(!leaked, `no shortcut on the wire (ESC+digit/t/w/{/}, "е", "Ъ"); leaked: ${J(leaked)}`);
  t.ok(/\x1bb/.test(wire()), 'Alt+B did go out as ESC b');

  // 4. Ctrl+Alt+digit (AltGr) does not switch tabs (xterm may send it
  //    to the shell - that is not a websh shortcut - so after the wire check).
  const beforeCA = await activeTab();
  await focusPane(B);
  await key('Digit1', '1', 49, CTRL | ALT);
  await sleep(300);
  t.ok(await activeTab() === beforeCA, 'Ctrl+Alt+1 does not switch tabs');

  // 9. macOS: Option+1 types '¡' (no macOptionIsMeta). Reload as a Mac.
  const ua = await b.ev('navigator.userAgent');
  await b.send('Emulation.setUserAgentOverride', { userAgent: ua.replace(/X11; Linux x86_64/, 'Macintosh; Intel Mac OS X 10_15_7'), platform: 'MacIntel' });
  await b.open(b.url);
  const restored = await until(async () => (await tabs()).length >= 2 &&
    await b.ev(`Object.values(panes).length >= 2 && Object.values(panes).every(p => p.sid)`), 30000);
  t.ok(restored >= 0, 'reloaded as a Mac: the tabs are back, every pane connected');
  t.ok(await b.ev(`navigator.platform`) === 'MacIntel', 'navigator.platform is MacIntel');
  if (restored >= 0) {
    const [p1, p2] = await b.ev(`Array.from(document.querySelectorAll('#tabs .tab')).map(e =>
      document.querySelector('#panes .tab-root[data-tab="' + e.getAttribute('data-tab') + '"] .pane').getAttribute('data-pane'))`);
    const [m1, m2] = [await tabOf(p1), await tabOf(p2)];
    await sleep(1500);
    await focusPane(p1);
    const cur = await activeTab();
    const here = p1;
    sent.length = 0;
    await typeKeys(`echo ${tag}M`);
    // Option+2 on a Mac US layout: key '™', text '™'.
    const otherDigit = ['Digit2', '™', 50];
    await key(otherDigit[0], otherDigit[1], otherDigit[2], ALT, otherDigit[1]);
    const target = m2;
    t.ok(await until(async () => await activeTab() === target, 3000) >= 0, `Option+${otherDigit[0].slice(5)} (key ${J(otherDigit[1])}) switches tabs on a Mac`);
    // Option+1: key '¡'.
    await key('Digit1', '¡', 49, ALT, '¡');
    t.ok(await until(async () => await activeTab() === cur, 3000) >= 0, 'Option+1 (key "¡") switches back to tab 1');
    await key('BracketRight', '’', 221, ALT | SHIFT, '’');
    t.ok(await until(async () => await activeTab() === m2, 3000) >= 0, 'Option+Shift+] (key "’") shows the next tab');
    await key('BracketLeft', '”', 219, ALT | SHIFT, '”');
    t.ok(await until(async () => await activeTab() === cur, 3000) >= 0, 'Option+Shift+[ (key "”") shows the previous tab');
    await until(() => focusInXterm(here), 3000);
    await typeKeys('N\r');
    const wantM = `${tag}MN`;
    await until(async () => (await lines(here)).some(l => l.startsWith(tag + 'M') && !l.includes('echo')), 8000);
    const lm = (await lines(here)).find(l => l.startsWith(tag + 'M') && !l.includes('echo'));
    t.ok(lm === wantM, `no Option symbol typed into the command: printed ${J(lm)} (want ${J(wantM)})`);
    t.ok(!/[¡™’”]/.test(wire()), `no Option symbol on the wire (${J(wire().match(/[¡™’”]/g))})`);
  }
  t.ok(b.errors.length === 0, `no page errors (${J(b.errors.slice(0, 3))})`);
}
