// Trying to break the OSC 8 link tooltip (the hover box that shows a
// link's real target, websh.js showLinkTip). The tooltip exists so the
// user can see where a link goes when its text says something else; so
// it must (1) show the host the browser would actually open, even when
// the target is long, (2) never render markup from the target, (3) not
// stay on screen over a terminal that is no longer under the pointer -
// a tab switched by a key, a pane closed, output that scrolls the link
// away. Real mouse moves (CDP) over a real xterm; keys as real key
// events.
import { tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'link tooltip under attack: long and spoofing targets, markup, tab switch / pane close / scroll while hovering',
  ssh: true, local: true,
};

const oct = s => Array.from(Buffer.from(s, 'utf8')).map(c => '\\' + c.toString(8).padStart(3, '0')).join('');
const ALT = 1;

export async function run({ b, t }) {
  const J = JSON.stringify;
  const pane = id => `panes[${J(id)}]`;
  const type = (id, text) => b.ev(`(() => { const p = ${pane(id)};
    for (const c of ${J(text)}) p.term._core.coreService.triggerDataEvent(c, true); return 1; })()`);
  const mouse = (type, pt) => b.send('Input.dispatchMouseEvent',
    { type, x: pt.x, y: pt.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const key = async (code, k, vk, mods) => {
    await b.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods || 0 });
  };
  const centre = async sel => b.ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null;
    const q = e.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
  const newTab = async () => {
    const before = await b.ev('Object.keys(panes).length');
    const r = await centre('#tabNew');
    for (const ty of ['mousePressed', 'mouseReleased'])
      await b.send('Input.dispatchMouseEvent', { type: ty, x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await until(() => b.ev(`!document.getElementById('ov').classList.contains('h')`), 3000);
    await b.ev(`(() => { ${b._fill(false)} doConnect(); return 1; })()`);
    const i = await b._ready(before);
    return b.ev(`Object.keys(panes)[${i}]`);
  };
  const activeTab = () => b.ev(`(() => { const e = document.querySelector('#tabs .tab.active'); return e ? e.getAttribute('data-tab') : null; })()`);
  const tabOf = id => b.ev(`${pane(id)}.el.closest('.tab-root').getAttribute('data-tab')`);
  // Where `text` is in pane id's output (not the printf line).
  const where = (id, text) => b.ev(`(() => { const p = ${pane(id)}; const bf = p.term.buffer.active;
    const scr = p.el.querySelector('.xterm-screen'); const r = scr.getBoundingClientRect();
    const cw = r.width / p.term.cols, ch = r.height / p.term.rows;
    for (let y = bf.length - 1; y >= 0; y--) {
      const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
      const x = s.indexOf(${J(text)}); if (x < 0 || s.includes('printf')) continue;
      const vy = y - bf.viewportY; if (vy < 0 || vy >= p.term.rows) return null;
      return { x: r.left + (x + 2.5) * cw, y: r.top + (vy + 0.5) * ch };
    }
    return null; })()`);
  // The tooltip as the user sees it: on screen, its text, and the part
  // of `needle` that is actually painted inside its box (not cut by the
  // ellipsis or the window edge).
  const tip = needle => b.ev(`(() => {
    const els = Array.from(document.querySelectorAll('.link-tip'));
    const e = els.find(x => getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().width > 0);
    if (!e) return { shown: false, n: els.length };
    const r = e.getBoundingClientRect();
    const out = { shown: true, n: els.length, text: e.textContent,       kids: e.children.length, bad: e.querySelectorAll('img, script, [onerror]').length, w: r.width, vw: innerWidth, inWin: r.left >= 0 && r.right <= innerWidth + 1 };
    const nd = ${J(needle || '')};
    if (nd) {
      // Any text node inside the box (it may have parts: host, full URL).
      out.needleVisible = false;
      const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
      for (let tn = w.nextNode(); tn; tn = w.nextNode()) {
        const i = tn.data.indexOf(nd); if (i < 0) continue;
        let hid = false; for (let n = tn.parentElement; n && n !== e.parentElement; n = n.parentElement) if (getComputedStyle(n).display === 'none') hid = true;
        if (hid) continue;
        const g = document.createRange(); g.setStart(tn, i); g.setEnd(tn, i + nd.length);
        const q = g.getBoundingClientRect(); const pr = tn.parentElement.getBoundingClientRect();
        if (q.width > 0 && q.left >= Math.max(r.left, pr.left) - 1 && q.right <= Math.min(r.right, pr.right) + 1 && q.right <= innerWidth) { out.needleVisible = true; break; }
      }
    }
    return out; })()`);
  const hover = async (id, text) => {
    const pt = await where(id, text);
    if (!pt) return null;
    await mouse('mouseMoved', { x: pt.x - 3, y: pt.y });
    await mouse('mouseMoved', pt);
    await until(async () => (await tip()).shown, 2000, 50);
    return pt;
  };
  const printLink = async (id, url, text, mark) => {
    await type(id, `printf '\\n${oct('\x1b]8;;' + url + '\x1b\\' + text + '\x1b]8;;\x1b\\')}\\n${oct(mark)}\\n'\r`);
    // Until the prompt after the output is there the screen may still
    // scroll a row, and a hover aimed at the text lands on the row below.
    return until(async () => {
      const pt = await where(id, text);
      if (!pt || !(await where(id, mark))) return false;
      const prompt = await b.ev(`(() => { const bf = ${pane(id)}.term.buffer.active; let seen = false;
        for (let y = 0; y < bf.length; y++) { const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
          if (s.includes(${J(mark)}) && !s.includes('printf')) seen = true;
          else if (seen && /[$#] *$/.test(s)) return true; }
        return false; })()`);
      return prompt && J(await where(id, text)) === J(pt);
    }, 6000, 100);
  };

  const tag = tagOf('L');
  const A = await b.ev(`Object.keys(panes)[${await b.connect({ persistent: false })}]`);
  await type(A, 'clear\r');

  // 1. A target whose start looks like a trusted host and whose real
  //    host comes after a long userinfo: https://github.com:<pad>@evil.
  //    The tooltip must show the host that would open.
  const pad = 'x'.repeat(220);
  const lt = tag.toLowerCase();   // a host is shown lowercased
  const spoof = `https://github.com:${pad}@evil-${lt}.example/`;
  await printLink(A, spoof, 'SPOOF' + tag, 'E1' + tag);
  await hover(A, 'SPOOF' + tag);
  let s = await tip(`evil-${lt}.example`);
  t.note('spoof tooltip: ' + J({ shown: s.shown, w: Math.round(s.w), vw: s.vw, needleVisible: s.needleVisible, text: (s.text || '').slice(0, 40) + '...' }));
  t.ok(s.shown, 'hovering a link shows the tooltip');
  t.ok(s.needleVisible === true, `the host that would open (evil-${lt}.example) is visible in the tooltip, not cut off behind "https://github.com:xxx..."`);

  // 2. A very long ordinary target: the box stays inside the window and
  //    the page does not scroll sideways.
  const long = `https://example.com/${'a'.repeat(3000)}?end=LONG${tag}`;
  await printLink(A, long, 'LONG' + tag, 'E2' + tag);
  await hover(A, 'LONG' + tag);
  s = await tip('https://example.com/');
  t.ok(s.shown && s.inWin, `a 3000-char target: tooltip inside the window (${Math.round(s.w)} of ${s.vw}px)`);
  t.ok(s.needleVisible === true, 'and its host is visible');
  t.ok(await b.ev('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), 'the page does not scroll sideways');

  // 3. Markup in the target: shown as text, never parsed.
  await b.ev('window.__pwn = 0');
  const markup = `https://example.com/<img src=x onerror="window.__pwn=1"><b>B${tag}</b>`;
  await printLink(A, markup, 'MARKUP' + tag, 'E3' + tag);
  await hover(A, 'MARKUP' + tag);
  s = await tip();
  t.note('markup tooltip: ' + J({ text: (s.text || '').slice(0, 90), bad: s.bad }));
  t.ok(s.shown && s.bad === 0 && (s.text || '').includes('<b>B' + tag), 'markup in the target is text in the tooltip, no elements made from it');
  t.ok(await b.ev('window.__pwn') === 0, 'and nothing in it ran');

  // 4. Hovering a link, the tab is switched by a key: the tooltip must
  //    not stay over the other tab's terminal.
  const B = await newTab();
  const tA = await tabOf(A), tB = await tabOf(B);
  await key('Digit1', '1', 49, ALT);
  await until(async () => (await activeTab()) === tA, 3000);
  await b.ev(`${pane(A)}.term.focus()`);
  await printLink(A, `https://example.com/tab${tag}`, 'TABSW' + tag, 'E4' + tag);
  await hover(A, 'TABSW' + tag);
  t.ok((await tip()).shown, 'tooltip shown before the switch');
  await key('Digit2', '2', 50, ALT);
  await until(async () => (await activeTab()) === tB, 3000);
  t.ok((await activeTab()) === tB, 'Alt+2 switched to the other tab');
  // Settle: one frame for any leave handler.
  await b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  s = await tip();
  t.ok(!s.shown, `after the tab switch no tooltip is left on screen${s.shown ? ' (still shows ' + J(s.text) + ')' : ''}`);
  await key('Digit1', '1', 49, ALT);
  await until(async () => (await activeTab()) === tA, 3000);

  // 5. Hovering a link, output scrolls it away (the pointer did not move).
  await printLink(A, `https://example.com/scroll${tag}`, 'SCROLL' + tag, 'E5' + tag);
  await hover(A, 'SCROLL' + tag);
  t.ok((await tip()).shown, 'tooltip shown before the output scrolls');
  await type(A, `seq 1 200; echo DONE${tag}\r`);
  await until(async () => !!(await where(A, 'DONE' + tag)), 6000, 100);
  await b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  s = await tip();
  t.ok(!s.shown || (s.text || '').indexOf('scroll' + tag) < 0 || !!(await where(A, 'SCROLL' + tag)),
    `the link scrolled away: its tooltip is not left over unrelated text${s.shown ? ' (shows ' + J(s.text) + ')' : ''}`);

  // 6. Hovering a link in a pane that is then closed.
  await printLink(B, `https://example.com/close${tag}`, 'CLOSE' + tag, 'E6' + tag).catch(() => {});
  await key('Digit2', '2', 50, ALT);
  await until(async () => (await activeTab()) === tB, 3000);
  await printLink(B, `https://example.com/close${tag}`, 'CLOSE' + tag, 'E6' + tag);
  await hover(B, 'CLOSE' + tag);
  t.ok((await tip()).shown, 'tooltip shown in the pane about to close');
  await b.ev(`closePane(${J(B)})`);
  await until(async () => !(await b.ev(`!!${pane(B)}`)), 4000);
  // A tmux-less pane closes without a confirm; a dialog would block here.
  await b.ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  s = await tip();
  t.ok(!s.shown, `after the pane closed no tooltip is left on screen${s.shown ? ' (still shows ' + J(s.text) + ')' : ''}`);
  t.ok((await tip()).n <= 1, 'one tooltip element at most');
}
