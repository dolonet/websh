// Browser connection starvation is observable only with real HTTP/1.1.
// Four SSH panes keep output active. Hold one speculative listing and a
// second listing opened in another pane, then close the dialog and type.
// The input must reach the SSH shell while both response gates stay shut.
// Local files/proxy exist only inside the explicitly verified container.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {cfg,until,tagOf} from '../lib.mjs';
export const meta={about:'private HTTP/1.1 held background listings cannot starve terminal input',ssh:true,local:true,isolatedSsh:true};
export async function run({b,t,port}){
 if(cfg.host!=='127.0.0.1'||!process.env.WEBSH_HOST_NETNS||fs.readlinkSync('/proc/self/ns/net')===process.env.WEBSH_HOST_NETNS)throw Error('isolated fixture required');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'websh-h1-prefetch-'));
 fs.writeFileSync(path.join(dir,'synthetic-file'),'fixture');
 let gate=true,seen=0,inputSeen=0;const held=[];
 const proxy=http.createServer((req,res)=>{
  if(/[?&]action=input\b/.test(req.url))inputSeen++;
  const forward=()=>{
   if(res.destroyed)return;
   const upstream=http.request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:req.headers,agent:false},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
   upstream.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end();}});
   res.on('close',()=>upstream.destroy());req.pipe(upstream);
  };
  if(gate&&/[?&]action=ls\b/.test(req.url)){seen++;held.push(forward);}else forward();
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 try{
  await b.open('http://127.0.0.1:'+proxy.address().port+'/');
  if(await b.ev('settings.sealed'))await b.ev("(()=>{openOptions();document.getElementById('optSealed').click();closeOptions();return 1;})()");
  const pane=await b.connect({persistent:false});for(let i=0;i<3;i++)await b.split({persistent:false});const J=JSON.stringify;
  await b.ev(`(()=>{const p=Object.values(panes)[${pane}];p.cwd=${J(dir)};window.__perfClones=[];for(let i=0;i<4;i++){const q=createPane(document.getElementById('panes'));q.sid=p.sid;q.host=p.host;q.cwd=${J(dir)};window.__perfClones.push(q.id);}for(const q of Object.values(panes)){q.cwd=${J(dir)};const el=q.el.querySelector('[data-download-btn]');el.disabled=false;for(const type of ['pointerover','mouseover','pointerenter','mouseenter'])el.dispatchEvent(new MouseEvent(type,{bubbles:true}));}return 1;})()`);
  t.ok(await until(()=>seen>0,3000,10)>=0,'one background ls reaches the actual HTTP/1.1 proxy gate');
  const state=await b.state();t.ok(state.filter(p=>p.sse).length>=3,'multiple real SSH panes keep their output streams live');
  t.ok(seen===1,`eight eligible panes started only one speculative request (${seen})`);
  await b.ev(`(()=>{const q=Object.values(panes)[1];q.cwd=${J(dir)};showFileBrowser(q.id);return 1;})()`);
  t.ok(await until(()=>seen===2,3000,10)>=0,'explicit different-pane open reaches a second held listing');
  await b.ev('closeFb()');
  const inputBefore=inputSeen;const word=tagOf('PREFETCHINPUT');const start=Date.now();await b.type(pane,`printf '${word}' > '${dir}/input-complete'\r`);
  const received=await until(()=>fs.existsSync(path.join(dir,'input-complete'))&&fs.readFileSync(path.join(dir,'input-complete'),'utf8')===word,1500,10);
  t.ok(received>=0,`terminal command executes on the SSH target while ls HTTP response is withheld (${Date.now()-start} ms)`);
  t.ok(inputSeen-inputBefore===1,'input reaches the HTTP/1.1 proxy exactly once while listing gates remain held');
  gate=false;for(const release of held)release();
  await b.ev(`showFileBrowser(Object.keys(panes)[${pane}])`);
  t.ok(await until(()=>b.ev(`document.getElementById('fbPath').dataset.path===${J(dir)}&&!document.getElementById('fbList').hasAttribute('aria-busy')`),5000,10)>=0,'explicit open recovers after input invalidates held preload');
  await b.ev("(()=>{closeFb();for(const id of window.__perfClones){if(panes[id]){panes[id].sid=null;_destroyPane(id,false);}}return 1;})()");
 }finally{gate=false;for(const release of held)release();try{const end=await b.endAll();t.note('ended private sessions: '+end.ended);await b.ev('Object.values(panes).forEach(p=>{p.sid=null;p.persistent=false;})');}catch(e){t.ok(false,'private session cleanup: '+e.message);}proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
}
