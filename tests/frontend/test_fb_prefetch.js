// Observe file requests and displayed targets through public pane actions.
const {mkEnv, cleanup, until, FakeWebsh, connect} = require('./sealed_harness');
let passed=0, failed=0;
const ok=(v,m)=>{if(v)passed++;else{failed++;console.log('FAIL: '+m);}};
const reply=data=>({status:200,headers:{'Content-Type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))});
const listing=(path,name='file')=>({path,entries:[{name,type:'f',size:7,mtime:1700000000}]});
function captureOsc(w){
 const Base=w.Terminal;
 w.Terminal=class extends Base {
  get parser(){return {registerOscHandler:(id,fn)=>{(this.osc||(this.osc={}))[id]=fn;return {dispose(){}};},registerCsiHandler(){return {dispose(){}};}};}
 };
}
const cwd=(p,path)=>p.term.osc[7]('file://one.example'+path);
async function fixture(fn){
 const srv=await new FakeWebsh().init(), pending=[], requests=[];
 srv.hooks.ls=req=>{requests.push(req);return new Promise(resolve=>pending.push({req,resolve}));};
 const e=await mkEnv({server:srv,beforeBoot:captureOsc}),w=e.win;
 const p=w.createPane(w.document.getElementById('panes'));p.sid=srv.newSession();p.cwd='/one';p.host='one.example';
 const hover=()=>{const el=p.el.querySelector('[data-download-btn]');el.disabled=false;for(const type of ['pointerover','mouseover','pointerenter','mouseenter'])el.dispatchEvent(new w.MouseEvent(type,{bubbles:true}));};
 const paint=path=>until(()=>w.document.getElementById('fbPath').dataset.path===path&&!w.document.getElementById('fbList').hasAttribute('aria-busy'),1000);
 try{await fn({w,p,srv,pending,requests,hover,paint});}
 catch(err){ok(false,err.stack);}
 finally{for(const x of pending)x.resolve(reply({error:'fixture cleanup'}));cleanup(e);}
}
(async()=>{
 {
  const srv=await new FakeWebsh().init(),pending=[];
  srv.hooks.ls=req=>new Promise(resolve=>pending.push({req,resolve}));
  const e=await mkEnv({server:srv,eventSource:'live',beforeBoot:captureOsc});
  try {
   const p=await connect(e);cwd(p,'/one');
   ok(await until(()=>pending.length===1,3000),'usable connection schedules one idle listing before any file-browser gesture');
   ok(e.win.document.getElementById('fbOv').classList.contains('h'),'idle prefetch does not open the file browser');
   if(pending.length){e.win.queueInput(p,'idle-input');ok(await until(()=>srv.sessions[p.sid].input==='idle-input',1000),'idle prefetch does not delay terminal input');}
  }finally{for(const x of pending)x.resolve(reply({error:'fixture cleanup'}));cleanup(e);}
 }
 await fixture(async({w,p,srv,pending,requests,hover,paint})=>{
  hover();ok(await until(()=>pending.length===1,1500),'hover starts one bounded background listing before open');
  if(!pending.length)return;
  hover();w.showFileBrowser(p.id);await Promise.resolve();await Promise.resolve();
  ok(requests.length===1,'opening reuses the in-flight hover listing');
  pending.shift().resolve(reply(listing('/one')));ok(await paint('/one'),'resolved prefetch paints the matching directory');
  w.closeFb();w.showFileBrowser(p.id);ok(await paint('/one'),'fresh successful listing opens immediately');
  ok(requests.length===1,'fresh reopen sends no duplicate listing');
  w.closeFb();cwd(p,'/two');w.showFileBrowser(p.id);ok(await until(()=>pending.length===1,1000),'changed cwd requests a new listing');
  ok(!w.document.querySelector('#fbList [data-name="file"]'),'changed cwd never exposes cached destructive rows');
  pending.shift().resolve(reply(listing('/two','second')));ok(await paint('/two'),'changed cwd uses its resolved path');
  w.closeFb();cwd(p,'/one');w.showFileBrowser(p.id);ok(await until(()=>pending.length===1,1000),'only one directory is retained per pane');
  pending.shift().resolve(reply(listing('/one')));await paint('/one');w.closeFb();
  const realNow=w.Date.now;w.Date.now=()=>realNow()+60000;
  w.showFileBrowser(p.id);ok(await until(()=>pending.length===1,1000),'old listing expires instead of remaining a permanent snapshot');
 });
 await fixture(async({w,p,srv,pending,requests,hover,paint})=>{
  hover();ok(await until(()=>pending.length===1,1500),'error control starts background listing');if(!pending.length)return;
  pending.shift().resolve(reply({error:'permission denied'}));
  await until(()=>srv.wire.some(r=>r.action==='ls'&&r.status===200),1000);
  w.showFileBrowser(p.id);ok(await until(()=>pending.length===1,1000),'background errors are not cached');
  const old=pending.shift();w.closeFb();p.sid=srv.newSession();p.host='two.example';
  w.showFileBrowser(p.id);ok(await until(()=>pending.length===1,1000),'new session does not reuse old session request');
  old.resolve(reply(listing('/one','old-host-secret')));
  pending.shift().resolve(reply(listing('/one','new-host-file')));ok(await paint('/one'),'new session listing resolves');
  ok(!w.document.querySelector('#fbList [data-name="old-host-secret"]'),'late old-host response cannot supply destructive targets');
  ok(!!w.document.querySelector('#fbList [data-name="new-host-file"]'),'new host owns displayed rows');
  ok(requests.length===3,'error then reconnect creates only the requested retries');
 });
 for(const closed of [true,false]) await fixture(async({w,p,pending,requests,hover,paint})=>{
  hover();await until(()=>pending.length===1,1500);if(!pending.length){ok(false,'stale foreground control starts preload');return;}
  const old=pending.shift();w.showFileBrowser(p.id);
  if(closed)w.closeFb();else{w.loadFbDir('/different');await until(()=>pending.length===1,1000);}
  old.resolve(reply({error:'preload failed'}));
  await until(()=>requests.length>(closed?1:2),300);
  ok(requests.length===(closed?1:2),(closed?'closed':'superseded')+' foreground does not refill network slots after preload failure');
  if(!closed&&pending.length){pending.shift().resolve(reply(listing('/different','new-directory')));await paint('/different');}
 });
 for(const held of [false,true]) await fixture(async({w,p,srv,pending,requests,hover,paint})=>{
  hover();ok(await until(()=>pending.length===1,1500),'input invalidation control starts prefetch');if(!pending.length)return;
  const old=pending.shift();
  if(!held){old.resolve(reply(listing('/one','before-command')));await until(()=>srv.wire.some(r=>r.action==='ls'&&r.status===200),1000);}
  const count=requests.length;
  w.queueInput(p,'touch new-file\r');
  ok(await until(()=>srv.sessions[p.sid].input==='touch new-file\r',1000),'input executes while '+(held?'in-flight':'completed')+' preload exists');
  ok(requests.length===count,'input invalidation itself starts no background API request');
  if(held){old.resolve(reply(listing('/one','before-command')));await until(()=>srv.wire.some(r=>r.action==='ls'&&r.status===200),1000);}
  w.showFileBrowser(p.id);const fresh=await until(()=>pending.length===1,1000);
  ok(fresh,'accepted terminal input forces a fresh listing at the same cwd');if(!fresh)return;
  pending.shift().resolve(reply(listing('/one','new-file')));await paint('/one');
  ok(!!w.document.querySelector('#fbList [data-name="new-file"]'),'listing includes command-created file');
  ok(!w.document.querySelector('#fbList [data-name="before-command"]'),'late preload cannot repopulate after terminal input');
 });
 await fixture(async({w,p,srv,pending,requests,hover,paint})=>{
  hover();ok(await until(()=>pending.length===1,1500),'shared foreground invalidation control starts prefetch');if(!pending.length)return;
  const old=pending.shift();w.showFileBrowser(p.id);w.queueInput(p,'touch while-opening\r');
  ok(await until(()=>srv.sessions[p.sid].input==='touch while-opening\r',1000),'input remains prompt after foreground shares prefetch');
  old.resolve(reply(listing('/one','stale-shared')));
  const fresh=await until(()=>pending.length===1,1000);
  ok(fresh,'foreground sharing invalidated prefetch obtains a fresh listing');if(!fresh)return;
  ok(!w.document.querySelector('#fbList [data-name="stale-shared"]'),'invalid shared reply is never exposed as destructive rows');
  pending.shift().resolve(reply(listing('/one','fresh-shared')));ok(await paint('/one'),'fresh shared-replacement listing paints');
  ok(requests.length===2,'one shared request and one fresh replacement only');
 });
 await fixture(async({w,p,srv,pending,requests,hover})=>{
  hover();const others=[];
  for(let i=0;i<7;i++){
   const q=w.createPane(w.document.getElementById('panes'));q.sid=srv.newSession();q.cwd='/many-'+i;q.host='other.example';others.push(q);
   const el=q.el.querySelector('[data-download-btn]');el.disabled=false;
   for(const type of ['pointerover','mouseover','pointerenter','mouseenter'])el.dispatchEvent(new w.MouseEvent(type,{bubbles:true}));
  }
  ok(await until(()=>pending.length>0,1500),'many-pane control starts background work');
  await new Promise(resolve=>setImmediate(resolve));
  ok(requests.length===1,'many eligible panes cannot fill HTTP connection slots with speculative requests');
  const q=others.at(-1);w.queueInput(q,'other-pane-input');
  ok(await until(()=>srv.sessions[q.sid].input==='other-pane-input',1000),'another pane types promptly while speculative listing waits');
 });
 // With no OSC 7, cwd can change on the SSH target without a client
 // event. An earlier remote-cwd result is not authority for today's open.
 for(const held of [false,true]) await fixture(async({w,p,pending,hover,paint})=>{
  p.cwd='';hover();await until(()=>pending.length>0,500);
  const old=pending.shift();
  if(old&&!held){old.resolve(reply(listing('/before-cd','old-directory')));await new Promise(resolve=>setImmediate(resolve));}
  w.showFileBrowser(p.id);
  const fresh=await until(()=>pending.length===1,1000);
  ok(fresh,'unknown cwd requests current remote directory on open ('+(held?'in-flight':'completed')+' prefetch)');
  if(!fresh){if(old&&held)old.resolve(reply(listing('/before-cd','old-directory')));return;}
  const now=pending.shift();
  if(old&&held)old.resolve(reply(listing('/before-cd','old-directory')));
  now.resolve(reply(listing('/after-cd','current-directory')));ok(await paint('/after-cd'),'remote cd without OSC 7 determines opening target');
  ok(!w.document.querySelector('#fbList [data-name="old-directory"]'),'old unknown-cwd prefetch cannot expose stale destructive targets');
 });
 for(const mutation of ['rm','mv','mkdir','upload']) await fixture(async({w,p,srv,pending,paint})=>{
  const sibling=w.createPane(w.document.getElementById('panes'));sibling.sid=srv.newSession();sibling.cwd='/one';sibling.host=p.host;
  const button=sibling.el.querySelector('[data-download-btn]');button.disabled=false;button.dispatchEvent(new w.MouseEvent('pointerover',{bubbles:true}));
  await until(()=>pending.length===1,1000);
  if(!pending.length){ok(false,'sibling prefetch starts for mutation control');return;}
  pending.shift().resolve(reply(listing('/one','sibling-old')));
  await new Promise(resolve=>setImmediate(resolve));
  for(const action of ['rm','mv','mkdir'])srv.hooks[action]=()=>reply({ok:true});
  w.showFileBrowser(p.id);await until(()=>pending.length===1,1000);
  pending.shift().resolve(reply(listing('/one')));await paint('/one');
  const row=w.document.querySelector('#fbList [data-name="file"]');
  if(mutation==='rm'){row.querySelector('[data-fb-del]').click();row.querySelector('.fb-cf-yes').click();}
  if(mutation==='mv'){row.querySelector('[data-fb-ren]').click();const inp=row.querySelector('.fb-ed-inp');inp.value='renamed';inp.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}
  if(mutation==='mkdir'){w.fbNewFolder();const inp=w.document.querySelector('#fbList .fb-ed-inp');inp.value='created';inp.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}
  if(mutation==='upload'){
   // The transfer completing while the panel is closed must invalidate
   // its retained result too; no foreground reload exists to hide a bug.
   w.closeFb();srv.files['synthetic-tmp']=new Uint8Array([1]);p.upload={destDir:'/one',currentTmp:'synthetic-tmp',currentFile:'uploaded',staged:[],placed:[]};await w.finalizeUploadedFile(p);w.finishUpload(p,true);w.showFileBrowser(p.id);
  }
  const fresh=await until(()=>pending.length===1,1000);
  ok(fresh,mutation+' invalidates the successful listing');if(!fresh)return;
  pending.shift().resolve(reply(listing('/one','updated')));await paint('/one');
  ok(!!w.document.querySelector('#fbList [data-name="updated"]'),mutation+' displays the new listing');
  ok(!w.document.querySelector('#fbList [data-name="file"]'),mutation+' never resurrects old cached rows');
  w.closeFb();w.showFileBrowser(sibling.id);
  const siblingFresh=await until(()=>pending.length===1,1000);
  ok(siblingFresh,mutation+' invalidates another session viewing the same remote directory');
  if(siblingFresh){pending.shift().resolve(reply(listing('/one','sibling-updated')));await paint('/one');ok(!w.document.querySelector('#fbList [data-name="sibling-old"]'),mutation+' cannot resurrect another pane snapshot');}
 });
})().finally(()=>{console.log('\n===========================================\n  passed: '+passed+'   failed: '+failed);process.exitCode=failed?1:0;});
