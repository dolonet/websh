import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {cfg,until} from '../lib.mjs';
export const meta={about:'private SSH directory listing: large directories and safe hover prefetch',ssh:true,local:true,isolatedSsh:true};
export async function run({b,t}) {
 if(cfg.host!=='127.0.0.1'||!process.env.WEBSH_HOST_NETNS||fs.readlinkSync('/proc/self/ns/net')===process.env.WEBSH_HOST_NETNS)throw Error('private network fixture required');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'websh-file-startup-'));
 try {
  await b.connect({persistent:false});
  const id=await b.ev('Object.keys(panes)[0]');const J=JSON.stringify;
  for(const n of [10,1000,2500]) {
   const sub=path.join(dir,String(n));fs.mkdirSync(sub);
   for(let i=0;i<n;i++)fs.writeFileSync(path.join(sub,'file-'+String(i).padStart(5,'0')),'fixture');
   await b.type(0,`cd '${sub}'; printf '\\033]7;file://localhost${sub}\\007'\r`);
   await until(()=>b.ev(`panes[${J(id)}].cwd===${J(sub)}`),3000);
   for(let round=1;round<=2;round++) {
    const start=Date.now();await b.ev(`showFileBrowser(${J(id)})`);
    const done=await until(()=>b.ev(`document.getElementById('fbPath').dataset.path===${J(sub)}&&!document.getElementById('fbList').hasAttribute('aria-busy')`),20000,25);
    const elapsed=Date.now()-start;
    const count=await b.ev("[...document.querySelectorAll('#fbList .fb-row')].filter(e=>e.dataset.name!=='..').length");
    t.ok(done>=0&&count===n,`${n} files open${round}: ${elapsed} ms, rows=${count}`);
    if(n===2500)t.ok(elapsed<3000, '2500 entries are usable within 3 seconds on the private local SSH fixture');
    await b.ev('closeFb()');
   }
  }
  // Observe network completion, not an implementation's cache fields. A new
  // cwd has never been opened, so its first render must use background work.
  const warm=path.join(dir,'prefetch');fs.mkdirSync(warm);
  for(let i=0;i<1000;i++)fs.writeFileSync(path.join(warm,'warm-'+String(i).padStart(5,'0')),'fixture');
  await b.ev(`(() => { window.__perfLs=[]; const original=apiFetch; apiFetch=function(url,opts){const r=original(url,opts);if(String(url).includes('action=ls'))r.then(x=>x.clone().json()).then(x=>window.__perfLs.push(x),()=>{});return r;};return 1;})()`);
  await b.type(0,`cd '${warm}'; printf '\\033]7;file://localhost${warm}\\007'\r`);
  await until(()=>b.ev(`panes[${J(id)}].cwd===${J(warm)}`),3000);
  const target=await b.ev(`(() => {const el=document.querySelector('#paneTools [data-act="download"]');const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:r.width>0&&r.height>0&&!el.disabled};})()`);
  t.ok(target.visible,'lone-pane Download control is visible and enabled');
  await b.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});
  const prefetched=await until(()=>b.ev(`window.__perfLs.some(x=>x.path===${J(warm)}&&x.entries.length===1000)`),8000);
  t.ok(prefetched>=0,'unopened cwd is prefetched without opening the file browser');
  const before=b.requests.ls||0,start=Date.now();await b.ev(`showFileBrowser(${J(id)})`);
  const done=await until(()=>b.ev(`document.getElementById('fbPath').dataset.path===${J(warm)}&&!document.getElementById('fbList').hasAttribute('aria-busy')`),15000,10);
  const elapsed=Date.now()-start;
  t.ok(done>=0,`prefetched first open: ${elapsed} ms`);
  t.ok((b.requests.ls||0)===before,'first open reuses background result without another SSH listing');
  // DOM rendering competes with the full test matrix on shared workers.
  // Pinned-browser controls measured 434-811 ms here, versus 2.2-3.5 s
  // before the fix; request reuse above is the deterministic cache guard.
  t.ok(elapsed<1200,'prefetched 1000-entry first open is usable within 1200 ms');
  await b.ev('closeFb()');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
