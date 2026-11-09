// A foreground program can leave DEC 1003/1006 enabled after returning
// to the shell. Recover only on an explicit per-pane action. Real mouse
// events and private PTYs guard against clearing history or typing a
// repair command into a partly entered shell command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {until, sleep, cfg} from '../lib.mjs';
export const meta = {about: 'explicit mouse recovery preserves history, partial input and neighboring mouse applications', ssh: true, local: true, isolatedSsh: true};

export async function run({b, t}) {
  // This scenario reads the SSH target's private files and queries its
  // tmux locally. It must never run against a normal host/remote target.
  if (cfg.host !== '127.0.0.1' || !process.env.WEBSH_HOST_NETNS ||
      fs.readlinkSync('/proc/self/ns/net') === process.env.WEBSH_HOST_NETNS)
    throw new Error('mouse requires the isolated same-container SSH/tmux fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'websh-mouse-'));
  const app = path.join(dir, 'app.py');
  fs.writeFileSync(app, `import os,sys,tty,termios\np=sys.argv[1]\nold=termios.tcgetattr(0)\ntry:\n tty.setraw(0)\n os.write(1,b'\\x1b[?1049h\\x1b[?1003h\\x1b[?1006hMOUSE_READY')\n with open(p,'wb',buffering=0) as f:\n  while True:\n   d=os.read(0,1024);f.write(d)\n   if b'q' in d:break\nfinally:\n os.write(1,b'\\x1b[?1049l')\n termios.tcsetattr(0,termios.TCSANOW,old)\n print('MOUSE_APP_DONE',flush=True)\n open(p+'.done','w').close()\n`);
  const inputs = [];
  b.onInput(data => inputs.push(data));
  const pv = i => `Object.values(panes)[${i}]`;
  const idle = () => until(() => b.ev('Object.values(panes).every(p => !p.inputInFlight && !p.inputQueue.length && !p.inputGate)'), 5000);
  const mode = i => b.ev(`${pv(i)}.term.modes.mouseTrackingMode`);
  const mouse = async i => {
    await idle();
    const pos = await b.ev(`(() => { const r = ${pv(i)}.el.querySelector('.xterm-screen').getBoundingClientRect(); return {x:r.x+35,y:r.y+35}; })()`);
    const start = inputs.length;
    for (let k = 0; k < 4; k++) await b.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:pos.x+15*k, y:pos.y+15*k, button:'none', buttons:0});
    await idle();
    await sleep(150); // allow already-dispatched browser mouse events to reach the network
    return inputs.slice(start).join('');
  };
  const reset = async i => {
    // A lone pane uses the visible shared top bar; its own pane bar is
    // hidden. Split panes expose the same action in their individual bar.
    const findButton = `(() => { const p = ${pv(i)}; const roots = [p.el]; if (activeId === p.id) roots.push(document.getElementById('paneTools')); return roots.filter(Boolean).flatMap(root => [...root.querySelectorAll('button,[role="button"]')]).find(e => { const r=e.getBoundingClientRect(); return r.width && r.height && /Reset mouse reporting/i.test((e.getAttribute('aria-label')||'')+' '+(e.title||'')+' '+e.textContent); }); })()`;
    const button = await b.ev(`(() => { const e = ${findButton}; if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    t.ok(!!button, `pane ${i}: explicit Reset mouse reporting action is visible`);
    if (!button) return false;
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', {type, x:button.x, y:button.y, button:'left', buttons:type==='mousePressed'?1:0, clickCount:1});
    await until(() => b.ev(`(() => { const e = ${findButton}; return e && !e.disabled; })()`), 5000);
    return true;
  };
  let tmuxCommand = 'tmux';
  const tmux = (...args) => execFileSync(tmuxCommand, args, {encoding:'utf8'});
  let neighbor;
  try {
    const plain = await b.connect();
    await reset(plain);
    t.ok(await mode(plain) === 'none', 'lone pane exposes mouse-only recovery without enabling reporting');
    const persistent = await b.split({persistent:true});
    tmuxCommand = await b.ev(`${pv(persistent)}.tmuxCmd`);
    neighbor = await b.split({persistent:true});
    await b.ev('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const nlog = path.join(dir, 'neighbor');
    await b.type(neighbor, `python3 ${app} ${nlog}\r`);
    t.ok(await until(async () => await mode(neighbor)==='any', 5000)>=0, 'neighbor runs a genuine mouse-enabled program');
    const originalNeighbor = (await b.state())[neighbor].sid;
    for (const i of [plain, persistent]) {
      const out = path.join(dir, 'app-'+i), result = path.join(dir, 'command-'+i), pidFile = path.join(dir, 'pid-'+i);
      await b.type(i, `echo $$ > ${pidFile}; for i in $(seq 1 100); do echo MOUSE_HISTORY_$i; done; python3 ${app} ${out}\r`);
      t.ok(await until(async () => await mode(i)==='any', 5000)>=0, `pane ${i}: foreground program enables motion reporting`);
      const active = await mouse(i);
      t.ok(/\x1b\[<\d+;\d+;\d+M/.test(active), `pane ${i}: actual pointer motion produces SGR reports`);
      t.ok(await until(async () => fs.existsSync(out) && fs.readFileSync(out, 'utf8')===active, 2000)>=0, `pane ${i}: foreground app receives the exact mouse bytes`);
      await b.type(i, 'q');
      t.ok(await until(async () => fs.existsSync(out+'.done'), 5000)>=0, `pane ${i}: program has returned to the shell`);
      const leaked = await mouse(i);
      t.note(`pane ${i}: stale mouse trace ${JSON.stringify(leaked)}`);
      t.ok(/\x1b\[<\d+;\d+;\d+M/.test(leaked), `pane ${i}: stale reporting symptom reproduced before explicit recovery`);
      t.ok(await until(async () => /35;\d+;\d+M/.test(await b.screen(i)), 2000)>=0, `pane ${i}: shell shows the reported coordinate garbage`);
      // Discard only the synthetic garbage, then leave a real command
      // half-entered. The recovery action must neither run nor erase it.
      await b.type(i, '\x15' + `printf retained > ${result}`);
      await idle();
      const shellPid = fs.readFileSync(pidFile, 'utf8');
      const slot = await b.ev(`${pv(i)}.slotId`), session = slot && 'websh-'+slot;
      const capture = () => session ? tmux('capture-pane','-p','-J','-S','-','-t',session) : b.screen(i);
      const before = await capture();
      const bracketed = await b.ev(`${pv(i)}.term.modes.bracketedPasteMode`);
      const beforeInput = inputs.length, beforeCalls = b.requests.mouse_reset || 0;
      if (!(await reset(i))) continue;
      t.ok(await until(async () => await mode(i)===(session?'drag':'none'), 5000)>=0, `pane ${i}: mouse recovery restores ${session?'normal tmux drag':'no reporting'}`);
      t.ok(before===await capture(), `pane ${i}: entire history and partially typed command preserved byte-for-byte`);
      t.ok(inputs.length===beforeInput, `pane ${i}: recovery injected no shell input`);
      t.ok(!fs.existsSync(result), `pane ${i}: partial command was not executed by recovery`);
      t.ok(bracketed===await b.ev(`${pv(i)}.term.modes.bracketedPasteMode`), `pane ${i}: bracketed-paste state unchanged`);
      t.ok((b.requests.mouse_reset||0)-beforeCalls===(session?1:0), `pane ${i}: ${session?'one remote recovery':'local-only recovery'}`);
      t.ok(await mouse(i)==='', `pane ${i}: pointer motion no longer produces input`);
      t.ok(before===await capture(), `pane ${i}: pointer motion leaves shell content unchanged`);
      if (session) {
        t.ok(tmux('display-message','-p','-t',session,'#{mouse_any_flag} #{mouse_sgr_flag}').trim()==='0 0', 'tmux itself no longer requests application mouse reports');
        t.ok(tmux('display-message','-p','-t',session,'#{pane_pid}').trim()===shellPid.trim(), 'persistent shell PID unchanged');
        const alreadyClean = await capture();
        await reset(i);
        t.ok(await until(async () => await mode(i)==='drag', 3000)>=0, 'repeating recovery on clean tmux keeps drag reporting');
        t.ok(alreadyClean===await capture(), 'repeating recovery leaves the clean tmux history intact');
      }
      const nBefore = fs.statSync(nlog).size, nMotion = await mouse(neighbor);
      t.ok(nMotion.length>0 && await until(async () => fs.statSync(nlog).size===nBefore+Buffer.byteLength(nMotion), 2000)>=0, 'neighbor mouse application still receives every report');
      t.ok((await b.state())[neighbor].sid===originalNeighbor, 'neighbor session unchanged');
      await b.type(i, `\r`);
      t.ok(await until(async () => fs.existsSync(result) && fs.readFileSync(result,'utf8')==='retained', 3000)>=0, `pane ${i}: the preserved partial command executes only on Enter`);
      await b.type(i, `echo $$ > ${pidFile}\r`);await idle();
      t.ok(fs.readFileSync(pidFile,'utf8')===shellPid, `pane ${i}: same shell after recovery`);
      if (session) {
        const sid=(await b.state())[i].sid;
        await b.ev(`reconnectPane(${pv(i)}.id); 1`);
        t.ok(await until(async () => {const s=(await b.state())[i];return s.sid && s.sid!==sid && !s.reconnecting;},10000)>=0,'persistent pane reattached');
        await idle();
        t.ok(await mode(i)==='drag' && await mouse(i)==='', 'reconnect retains recovered mouse state');
      }
    }
    await b.type(neighbor,'q');
    await until(async () => fs.existsSync(nlog+'.done'),5000);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
