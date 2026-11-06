// What a link looks like at rest. The owner asked: "remove the
// underline under hyperlinks; their colour is enough". Measured source
// (2026-10-05, xterm.js 5.5, DOM renderer - websh loads no canvas/webgl
// addon): xterm itself gives EVERY OSC 8 cell an underline - its
// ExtendedAttrs.underlineStyle answers 5 (dashed) whenever the cell has
// a urlId, and isUnderline() is true for any cell whose extended
// underlineStyle is non-zero, so the row factory adds
// `xterm-underline-5` (text-decoration: dashed underline) to link text
// the program never underlined. Claude Code prints its links as
// ESC]8;;URL BEL + SGR 94 (blueBright) text + SGR 39 + ESC]8;; BEL -
// colour only, no SGR 4 (its bundle, function building the link) - so
// the dashed line users see is xterm's, not the program's.
//
// Decided behaviour:
//   at rest: OSC 8 link text and plain-text URLs show no underline,
//            only what the program set (its colour);
//   hover:   pointer cursor, the target tooltip, and the solid hover
//            underline (it is a hover cue, not visible at rest);
//   a program's own underline (SGR 4, 4:3 wavy, 4:4 dotted, 4:5 dashed)
//            is drawn as the program asked, on a link or not;
//   a click still opens the link.
//
// Two kinds of evidence. Pixels: the lowest inked pixel row of the text
// cells in a real screenshot, against the same uppercase-only text (no
// descenders) printed without the link in the same colour - an
// underline is ink below the baseline; this holds whatever renderer
// draws the terminal. DOM: the computed text-decoration of the spans
// that render the text (DOM renderer), for the underline STYLE.
// Everything is printed by the real shell, octal-escaped, so the
// command's echo contains none of the text.
import fs from 'node:fs';
import path from 'node:path';
import { tagOf, until } from '../lib.mjs';
export const meta = {
  about: 'links at rest: no underline on OSC 8 / plain URLs, colour kept; hover underline + tooltip; a program\'s own SGR 4 kept',
  ssh: true, local: true,
};

const oct = s => Array.from(Buffer.from(s, 'utf8')).map(c => '\\' + c.toString(8).padStart(3, '0')).join('');
const E = '\x1b';

export async function run({ b, t }) {
  const J = JSON.stringify;
  const devPort = +fs.readFileSync(path.join(b.dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = async () => (await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()).filter(x => x.type === 'page');
  const closeTarget = id => fetch(`http://127.0.0.1:${devPort}/json/close/${id}`).catch(() => {});
  const dialogs = [];
  const origOn = b._on.bind(b);
  b._on = d => {
    if (d.method === 'Page.javascriptDialogOpening') {
      dialogs.push(d.params.message.slice(0, 80));
      b.send('Page.handleJavaScriptDialog', { accept: false });
    }
    origOn(d);
  };

  // A target must not boot another websh page: restoring its saved panes
  // can attach to the same tmux slot and detach the terminal under test.
  // /api/ping is inert JSON, while real popup and exact-URL checks remain.
  const origin = await b.ev('location.origin');
  const i = await b.connect({ persistent: false });
  const pv = `Object.values(panes)[${i}]`;
  const renderer = await b.ev(`(() => { const p = ${pv}; return { canvases: p.el.querySelectorAll('.xterm-screen canvas').length,
    domRows: !!p.el.querySelector('.xterm-rows'), dpr: devicePixelRatio }; })()`);
  t.note(`renderer: ${J(renderer)} (no canvas + .xterm-rows = DOM renderer)`);

  const tag = tagOf('');
  const link = (url, body, bel) => {
    const st = bel ? '\x07' : E + '\\';
    return `${E}]8;;${url}${st}${body}${E}]8;;${st}`;
  };
  const U = s => `${origin}/api/ping?linkstyle=${s}_${tag}`;
  // Uppercase letters without descenders and digits only (no Q, J), so
  // ink below the control's lowest row can only be an underline.
  const S = {
    cc:     { text: `LINKCC${tag}`,  out: t_ => link(U('cc'), `${E}[94m${t_}${E}[39m`, true) },        // Claude Code's exact form
    cc0:    { text: `PLAINCC${tag}`, out: t_ => `${E}[94m${t_}${E}[39m` },                              // its control: same colour, no link
    st:     { text: `LINKST${tag}`,  out: t_ => link(U('st'), t_) },                                     // ST form, default colour
    st0:    { text: `PLAINST${tag}`, out: t_ => t_ },                                                    // control
    sgr4:   { text: `ULINE${tag}`,   out: t_ => `${E}[4m${t_}${E}[24m` },
    wavy:   { text: `CURLY${tag}`,    out: t_ => `${E}[4:3m${t_}${E}[4:0m` },
    dotted: { text: `DOTTED${tag}`,  out: t_ => `${E}[4:4m${t_}${E}[4:0m` },
    dashed: { text: `DASHED${tag}`,  out: t_ => `${E}[4:5m${t_}${E}[4:0m` },
    lsgr4:  { text: `LINKUL${tag}`, out: t_ => link(U('lsgr4'), `${E}[4m${t_}${E}[24m`) },
    lwavy:  { text: `LINKCURL${tag}`,  out: t_ => link(U('lwavy'), `${E}[4:3m${t_}${E}[4:0m`) },
    url:    { text: `https://plain.invalid/URL${tag}`, out: t_ => t_ },
  };
  const END = `ENDMARK${tag}`;
  let payload = '\n';
  for (const k of Object.keys(S)) payload += '  ' + S[k].out(S[k].text) + '\n\n';
  payload += END + '\n';
  await b.type(i, `clear; printf '${oct(payload)}'\r`);
  const printed = await until(() => b.ev(`(() => { const bf = ${pv}.term.buffer.active; let seen = false;
    for (let y = 0; y < bf.length; y++) { const s = (bf.getLine(y) || {translateToString() { return ''; }}).translateToString(true);
      if (s.includes(${J(END)})) seen = true; else if (seen && /[$#] *$/.test(s)) return true; }
    return false; })()`), 10000);
  t.ok(printed >= 0, 'the samples are printed and the prompt is back');
  if (printed < 0) return;
  // A late webfont changes glyph baselines and cell height. Measure both
  // the reference and hovered text only after fonts and layout have settled;
  // otherwise fallback-font row 11 is compared with webfont row 14.
  await b.ev(`document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))`);
  // Mouse off the terminal.
  const mouse = (type, pt, mods, buttons) => b.send('Input.dispatchMouseEvent',
    { type, x: pt.x, y: pt.y, modifiers: mods || 0, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: buttons || 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const offTerm = async () => { const r = await b.ev(`(() => { const q = ${pv}.el.querySelector('.xterm-screen').getBoundingClientRect(); return {x: q.right - 4, y: q.bottom - 4}; })()`); await mouse('mouseMoved', r); };
  await offTerm();

  // Geometry of a text on screen: its cells' box in page pixels, and its viewport row.
  const box = text => b.ev(`(() => { const p = ${pv}; const bf = p.term.buffer.active;
    const r = p.el.querySelector('.xterm-screen').getBoundingClientRect();
    const cw = r.width / p.term.cols, ch = r.height / p.term.rows;
    for (let y = bf.length - 1; y >= 0; y--) { const l = bf.getLine(y); if (!l) continue; const s = l.translateToString(true);
      const x = s.indexOf(${J(text)}); if (x < 0 || s.includes('printf')) continue;
      const vy = y - bf.viewportY; if (vy < 0 || vy >= p.term.rows) return null;
      return { x: r.left + x * cw, y: r.top + vy * ch, w: ${J(text)}.length * cw, h: ch, vy, cw }; }
    return null; })()`);

  // Lowest row (from the cell top) holding ink, i.e. a pixel that is
  // not the background (the most frequent colour of the clip).
  const lowestInk = async text => {
    const g = await box(text);
    if (!g) return null;
    const clip = { x: Math.ceil(g.x) + 1, y: Math.ceil(g.y), width: Math.floor(g.w) - 2, height: Math.floor(g.h) - 1, scale: 1 };
    const shot = await b.send('Page.captureScreenshot', { format: 'png', clip });
    const data = shot.result && shot.result.data;
    if (!data) return null;
    return b.ev(`(async () => { const raw = atob('${data}'); const u8 = new Uint8Array(raw.length); for (let q = 0; q < raw.length; q++) u8[q] = raw.charCodeAt(q); const bl = new Blob([u8], { type: 'image/png' });
      const bm = await createImageBitmap(bl); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d');
      x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, bm.width, bm.height).data;
      const freq = new Map(); for (let k = 0; k < d.length; k += 4) { const v = (d[k] << 16) | (d[k+1] << 8) | d[k+2]; freq.set(v, (freq.get(v) || 0) + 1); }
      let bg = 0, n = -1; for (const [v, c2] of freq) if (c2 > n) { n = c2; bg = v; }
      const br = bg >> 16, bgg = (bg >> 8) & 255, bb = bg & 255; let low = -1;
      for (let yy = 0; yy < bm.height; yy++) for (let xx = 0; xx < bm.width; xx++) { const k = (yy * bm.width + xx) * 4;
        if (Math.abs(d[k] - br) + Math.abs(d[k+1] - bgg) + Math.abs(d[k+2] - bb) > 90) { low = yy; break; } }
      return { low, h: bm.height }; })()`);
  };
  // Computed decoration of the DOM renderer's spans for the text.
  const deco = text => b.ev(`(() => { const p = ${pv}; const bf = p.term.buffer.active; let vy = -1;
    for (let y = bf.length - 1; y >= 0; y--) { const s = (bf.getLine(y) || {translateToString() { return ''; }}).translateToString(true);
      if (s.includes(${J(text)}) && !s.includes('printf')) { vy = y - bf.viewportY; break; } }
    const rows = p.el.querySelector('.xterm-rows'); if (!rows || vy < 0) return null;
    const row = rows.children[vy]; if (!row) return null;
    const spans = Array.from(row.childNodes); let off = 0; const all = spans.map(n => n.textContent).join('');
    const at = all.indexOf(${J(text)}); if (at < 0) return { err: 'not in DOM row', row: all.slice(0, 80) };
    const out = [];
    for (const n of spans) { const a = off, z = off + n.textContent.length; off = z;
      if (z <= at || a >= at + ${J(text)}.length || n.nodeType !== 1) continue;
      const cs = getComputedStyle(n);
      out.push({ line: cs.textDecorationLine, style: cs.textDecorationStyle, color: cs.color, cls: n.className }); }
    return out; })()`);
  const lineOf = d => !d || d.err ? 'n/a' : [...new Set(d.map(s => s.line + (s.line === 'none' ? '' : ' ' + s.style)))].join(' | ');
  const underlined = d => !!d && !d.err && d.length > 0 && d.every(s => s.line.includes('underline'));
  const notUnderlined = d => !!d && !d.err && d.length > 0 && d.every(s => !s.line.includes('underline'));

  const ink = {};
  for (const k of ['cc', 'cc0', 'st', 'st0', 'sgr4', 'lsgr4']) ink[k] = await lowestInk(S[k].text);
  t.note(`lowest ink row at rest (cell top = 0): ${J(Object.fromEntries(Object.entries(ink).map(([k, v]) => [k, v && v.low])))}`);
  const below = (a, c) => !!a && !!c && a.low > c.low;
  const sameAs = (a, c) => !!a && !!c && a.low >= 0 && a.low <= c.low;
  t.ok(below(ink.sgr4, ink.st0), `measure works: SGR 4 text has ink below the plain text (an underline): ${ink.sgr4 && ink.sgr4.low} > ${ink.st0 && ink.st0.low}`);

  // ── at rest ──
  let d = await deco(S.cc.text);
  t.ok(sameAs(ink.cc, ink.cc0), `Claude Code link (OSC 8 BEL + blue) at rest: no ink below the same text unlinked (no underline): link ${ink.cc && ink.cc.low}, plain ${ink.cc0 && ink.cc0.low}; DOM ${lineOf(d)}`);
  t.ok(notUnderlined(d), `Claude Code link at rest: its text is not decorated (computed text-decoration: ${lineOf(d)})`);
  const d0 = await deco(S.cc0.text);
  t.ok(d && d0 && !d.err && !d0.err && d.length && d0.length && d.every(s => s.color === d0[0].color),
    `Claude Code link keeps the program's colour (same as the unlinked blue text): ${J(d && d.map && d.map(s => s.color))} vs ${J(d0 && d0.map && d0.map(s => s.color))}`);
  d = await deco(S.st.text);
  t.ok(sameAs(ink.st, ink.st0), `OSC 8 link (ST form, default colour) at rest: no underline: link ${ink.st && ink.st.low}, plain ${ink.st0 && ink.st0.low}; DOM ${lineOf(d)}`);
  t.ok(notUnderlined(d), `OSC 8 link (ST form) at rest: computed text-decoration: ${lineOf(d)}`);
  d = await deco(S.url.text);
  t.ok(notUnderlined(d), `plain-text URL at rest: no underline (computed: ${lineOf(d)})`);

  // ── the program's own underline is kept, in its own style ──
  d = await deco(S.sgr4.text);
  t.ok(underlined(d) && d.every(s => s.style === 'solid'), `SGR 4 text: solid underline (computed: ${lineOf(d)})`);
  for (const [k, st] of [['wavy', 'wavy'], ['dotted', 'dotted'], ['dashed', 'dashed']]) {
    d = await deco(S[k].text);
    t.ok(underlined(d) && d.every(s => s.style === st), `SGR 4:${{ wavy: 3, dotted: 4, dashed: 5 }[k]} text: ${st} underline (computed: ${lineOf(d)})`);
  }
  d = await deco(S.lsgr4.text);
  t.ok(below(ink.lsgr4, ink.st0), `OSC 8 link the program underlined (SGR 4): underline drawn at rest: ${ink.lsgr4 && ink.lsgr4.low} > ${ink.st0 && ink.st0.low}; DOM ${lineOf(d)}`);
  t.ok(underlined(d) && d.every(s => s.style === 'solid'), `OSC 8 link + SGR 4: the program's solid underline, not another style (computed: ${lineOf(d)})`);
  d = await deco(S.lwavy.text);
  t.ok(underlined(d) && d.every(s => s.style === 'wavy'), `OSC 8 link + SGR 4:3: the program's wavy underline (computed: ${lineOf(d)})`);

  // ── hover ──
  const hoverOn = async text => {
    const g = await box(text);
    const pt = { x: g.x + 2.5 * g.cw, y: g.y + g.h / 2 };
    await mouse('mouseMoved', { x: pt.x - 3, y: pt.y });
    await mouse('mouseMoved', pt);
    const ms = await until(() => b.ev(`(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y});
      const x = e && e.closest && e.closest('.xterm'); return !!x && (x.classList.contains('xterm-cursor-pointer') || !!x.querySelector('.xterm-cursor-pointer')); })()`), 2000, 20);
    return { pt, pointer: ms >= 0 };
  };
  let h = await hoverOn(S.cc.text);
  t.ok(h.pointer, 'hover on the Claude Code link: pointer cursor');
  const tipOk = await until(() => b.ev(`(() => { const e = document.querySelector('.link-tip'); return !!e && e.style.display !== 'none' && e.textContent.includes(${J(U('cc'))}); })()`), 2000, 50);
  t.ok(tipOk >= 0, 'hover on the Claude Code link: the tooltip shows its target');
  let hv = null;
  await until(async () => { hv = await lowestInk(S.cc.text); return below(hv, ink.cc0); }, 2000, 100);
  d = await deco(S.cc.text);
  t.ok(below(hv, ink.cc0), `hover on the Claude Code link: the hover underline is drawn: ${hv && hv.low} > ${ink.cc0 && ink.cc0.low}; DOM ${lineOf(d)}`);
  await offTerm();
  await until(() => b.ev(`!${pv}.el.querySelector('.xterm-cursor-pointer') && !${pv}.el.querySelector('.xterm').classList.contains('xterm-cursor-pointer')`), 2000, 20);
  let back = null;
  await until(async () => { back = await lowestInk(S.cc.text); return sameAs(back, ink.cc0); }, 2000, 100);
  t.ok(sameAs(back, ink.cc0), `pointer gone from the Claude Code link: no underline again: ${back && back.low} vs ${ink.cc0 && ink.cc0.low}`);
  const tipGone = await until(() => b.ev(`(() => { const e = document.querySelector('.link-tip'); return !e || e.style.display === 'none'; })()`), 2000, 50);
  t.ok(tipGone >= 0, 'pointer gone: the tooltip is gone');

  h = await hoverOn(S.url.text);
  t.ok(h.pointer, 'hover on a plain URL: pointer cursor');
  let du = null;
  await until(async () => { du = await deco(S.url.text); return underlined(du); }, 2000, 50);
  t.ok(underlined(du), `hover on a plain URL: hover underline drawn (computed: ${lineOf(du)})`);
  await offTerm();
  await until(async () => notUnderlined(await deco(S.url.text)), 2000, 50);
  t.ok(notUnderlined(await deco(S.url.text)), `pointer gone from the plain URL: no underline again (computed: ${lineOf(await deco(S.url.text))})`);

  // The program's underlined link keeps its underline after a hover too.
  await hoverOn(S.lsgr4.text);
  await offTerm();
  const after = await until(async () => underlined(await deco(S.lsgr4.text)) && !(await b.ev(`!!${pv}.el.querySelector('.xterm').classList.contains('xterm-cursor-pointer')`)), 2000, 50);
  d = await deco(S.lsgr4.text);
  t.ok(after >= 0 && d.every(s => s.style === 'solid'), `link + SGR 4 after a hover and leave: still the program's solid underline (computed: ${lineOf(d)})`);

  // ── a click still opens ──
  const before = new Set((await targets()).map(x => x.id));
  h = await hoverOn(S.cc.text);
  await mouse('mousePressed', h.pt, 0, 1);
  await mouse('mouseReleased', h.pt, 0, 0);
  let fresh = [];
  await until(async () => { fresh = (await targets()).filter(x => !before.has(x.id)); return fresh.length > 0 && fresh.every(x => x.url && x.url !== 'about:blank'); }, 3000, 100);
  const urls = fresh.map(x => x.url);
  for (const x of fresh) await closeTarget(x.id);
  t.ok(urls.length === 1 && urls[0] === U('cc') && dialogs.length === 0, `click on the Claude Code link opens one tab at its target: ${J(urls)} dialogs=${J(dialogs)}`);
  await offTerm();
}
