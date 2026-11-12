// Copy the directory the browser actually shows, never a typed or pending path.
const {mkEnv, cleanup, until, FakeWebsh} = require('./sealed_harness');
let passed=0, failed=0;
const ok=(value,message)=>{if(value)passed++;else{failed++;console.log('FAIL: '+message);}};
const reply=(data)=>({status:200,headers:{'Content-Type':'application/json'},body:new TextEncoder().encode(JSON.stringify(data))});
(async()=>{
 const srv=await new FakeWebsh().init();const pending=[];
 srv.hooks.ls=req=>new Promise(resolve=>pending.push({req,resolve}));
 const env=await mkEnv({server:srv});const {win}=env;
 try {
  const p=win.createPane(win.document.getElementById('panes'));p.sid=srv.newSession();p.cwd='/requested';
  const toasts=[],writes=[];win.showToast=(text,kind)=>toasts.push({text,kind});
  win.document.execCommand=()=>false;
  Object.defineProperty(win.navigator,'clipboard',{configurable:true,value:{writeText:async text=>writes.push(text)}});
  win.showFileBrowser(p.id);await until(()=>pending.length===1,1000);
  const button=win.document.getElementById('fbCopyPath');ok(!!button,'copy-path button exists');if(!button)return;
  // The harness deliberately disables inline HTML execution; dispatch the
  // real attribute for this control while retaining native disabled clicks.
  button.onclick=()=>win.eval(button.getAttribute('onclick'));
  ok(/copy.*path/i.test(button.getAttribute('aria-label')||''),'button has an accessible copy-path label');
  ok(button.disabled,'no committed listing means copy is disabled');button.click();ok(writes.length===0,'disabled button does not touch clipboard');
  const path='/папка/space dir';pending.shift().resolve(reply({path,entries:[]}));
  await until(()=>!button.disabled,1000);ok(writes.length===0,'listing does not automatically touch clipboard');
  win.document.getElementById('fbManual').value='/unsubmitted';button.click();await until(()=>toasts.length===1,1000);
  ok(writes[0]===path,'copies exact server-resolved Unicode path, ignoring manual text');ok(toasts.at(-1).kind==='ok','successful clipboard write reports success');
  win.loadFbDir('/pending');await until(()=>pending.length===1,1000);button.click();await until(()=>toasts.length===2,1000);
  ok(writes[1]===path,'pending navigation still copies displayed directory');
  pending.shift().resolve(reply({error:'not found'}));await until(()=>!win.document.getElementById('fbList').hasAttribute('aria-busy'),1000);
  button.click();await until(()=>toasts.length===3,1000);ok(writes[2]===path,'failed navigation retains displayed directory for copy');
  win.loadFbDir('/');await until(()=>pending.length===1,1000);pending.shift().resolve(reply({path:'/',entries:[]}));
  await until(()=>win.document.getElementById('fbPath').dataset.path==='/',1000);button.click();await until(()=>toasts.length===4,1000);ok(writes[3]==='/','root copies exactly one slash');
  const setClipboard=value=>Object.defineProperty(win.navigator,'clipboard',{configurable:true,value});
  const copyEvent=withData=>{const e=new win.Event('copy',{bubbles:true,cancelable:true});if(withData)Object.defineProperty(e,'clipboardData',{value:{setData:(type,text)=>{ok(type==='text/plain','fallback uses plain text');writes.push(text);}}});win.document.dispatchEvent(e);return true;};
  for(const mode of ['api denied with valid fallback','api denied without data','both denied','no api with valid fallback','api succeeds without fallback']) {
   setClipboard(mode==='no api with valid fallback'?undefined:{writeText:mode==='api succeeds without fallback'?async text=>writes.push(text):async()=>{throw Error('permission denied');}});
   win.document.execCommand=()=>mode.includes('valid fallback')?copyEvent(true):mode==='api denied without data'?copyEvent(false):false;
   const before=toasts.length;button.click();await until(()=>toasts.length>before,1000);
   const success=mode.includes('valid fallback')||mode==='api succeeds without fallback';
   ok(toasts.at(-1).kind===(success?'ok':'err'),mode+' reports truthful result');
  }
  win.closeFb();const q=win.createPane(win.document.getElementById('panes'));q.sid=srv.newSession();q.cwd='/other';win.showFileBrowser(q.id);
  await until(()=>pending.length===1,1000);ok(button.disabled,'opening another pane clears previous copy target');const before=writes.length;button.click();ok(writes.length===before,'no previous-pane clipboard write while new listing waits');
 }catch(e){failed++;console.log('FAIL: '+e.stack);}finally{for(const r of pending)r.resolve(reply({error:'fixture cleanup'}));cleanup(env);}
})().finally(()=>{console.log('\n===========================================\n  passed: '+passed+'   failed: '+failed);process.exitCode=failed?1:0;});
