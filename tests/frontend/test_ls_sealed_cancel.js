// Only intentional read-only listing cancellation may leave the sealed channel intact.
const {mkEnv, cleanup, until, sleep, enc, dec, envs} = require('./sealed_harness');
let passed=0,failed=0;
const ok=(value,message)=>{if(value)passed++;else{failed++;console.log('FAIL: '+message);}};
const body=()=>({status:200,headers:{'Content-Type':'application/json'},body:enc.encode(JSON.stringify({path:'/private',entries:[]}))});
function abortableFetch(win) {
 const original=win.fetch;
 win.fetch=(url,init)=>{
  const pending=original(url,init),signal=init&&init.signal;
  if(!signal)return pending;
  return new Promise((resolve,reject)=>{
   const abort=()=>reject(new win.DOMException('private read cancelled','AbortError'));
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
 };
}
const settled=promise=>Promise.race([promise.then(value=>({value}),error=>({error})),sleep(2000).then(()=>({timeout:true}))]);
async function cancelledListing(stage) {
 console.log('\n=== sealed listing cancellation: '+stage+' ===');
 const env=await mkEnv({sealed:true});const {win,srv}=env;const sid=srv.newSession();
 const controller=new win.AbortController(),messages=[];win.showToast=message=>messages.push(String(message));
 let release,arrived=false,stream;
 try {
  await win.api('tmux_capture',{query:'&session_id='+sid});const opens=srv.wire.filter(r=>r.action==='seal_open').length;
  if(stage==='before headers') {
   srv.hooks.ls=()=>new Promise(resolve=>{arrived=true;release=()=>resolve(body());});abortableFetch(win);
  } else if(stage==='body pending') {
   srv.hooks.ls=()=>body();const exchange=srv.exchange.bind(srv);
   srv.exchange=async(...args)=>{const out=await exchange(...args);if(out.innerRequest&&out.innerRequest.action==='ls'){
    const first=dec.decode(out.bytes).match(/^data: [^\n]+\n\n/)[0];
    return Object.assign({},out,{stream:new ReadableStream({start(c){stream=c;c.enqueue(enc.encode(first));}})});
   }return out;};
  } else {
   srv.hooks.ls=()=>body();const fetch=win.fetch;
   win.fetch=async(url,init)=>{const result=await fetch(url,init);if(init&&init.signal===controller.signal)controller.abort();return result;};
  }
  const pending=win.apiFetch('/api.php?action=ls&session_id='+sid+'&path=/private',{signal:controller.signal});
  let result;
  if(stage==='before headers') {
   ok(await until(()=>arrived,1000)>=0,'listing reached the private service before cancellation');controller.abort();result=await settled(pending.then(r=>r.json()));
  } else if(stage==='body pending') {
   const response=await pending;const reading=response.json();controller.abort();result=await settled(reading);
  } else result=await settled(pending.then(r=>r.json()));
  ok(!result.timeout&&result.error&&result.error.name==='AbortError','intentional GET ls cancellation remains AbortError');
  await win.api('input',{body:{session_id:sid,data:'FRESH'}});
  ok(srv.sessions[sid].input==='FRESH'&&srv.sessions[sid].inputCalls===1,'fresh input executes exactly once');
  ok(srv.wire.filter(r=>r.action==='seal_open').length===opens,'cancelled listing does not invalidate/reopen shared channel');
  ok(!messages.some(m=>/may have completed|check the result/i.test(m)),'read cancellation does not claim uncertain command delivery');
 }finally{controller.abort();if(release)release();if(stream)try{stream.close();}catch{}cleanup(env);}
}
async function invalidListing(kind) {
 console.log('\n=== sealed listing failure: '+kind+' without caller cancellation ===');
 const env=await mkEnv({sealed:true});const {win,srv}=env;const sid=srv.newSession(),controller=new win.AbortController();
 try {
  await win.api('tmux_capture',{query:'&session_id='+sid});const opens=srv.wire.filter(r=>r.action==='seal_open').length;
  srv.hooks.ls=()=>body();const exchange=srv.exchange.bind(srv);let replaced=false;
  srv.exchange=async(...args)=>{const out=await exchange(...args);if(!replaced&&out.innerRequest&&out.innerRequest.action==='ls'){
   replaced=true;if(kind==='abort-shaped transport failure')throw new win.DOMException('remote read ended','AbortError');
   return Object.assign({},out,{bytes:enc.encode('data: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n\n')});
  }return out;};
  const result=await settled(win.apiFetch('/api.php?action=ls&session_id='+sid+'&path=/private',{signal:controller.signal}).then(r=>r.json()));
  ok(replaced&&!controller.signal.aborted&&!!result.error,'unverified uncancelled listing is rejected');
  await win.api('input',{body:{session_id:sid,data:'AFTER'}});
  ok(srv.wire.filter(r=>r.action==='seal_open').length===opens+1,'unverified failure invalidates the old channel');
  ok(srv.sessions[sid].input==='AFTER'&&srv.sessions[sid].inputCalls===1,'later input uses a fresh channel exactly once');
 }finally{controller.abort();cleanup(env);}
}
async function abortedMutation() {
 console.log('\n=== sealed mutation: input abort remains delivery-unknown and never resends ===');
 const env=await mkEnv({sealed:true});const {win,srv}=env;const sid=srv.newSession(),controller=new win.AbortController();let release,arrived=false;
 try {
  await win.api('tmux_capture',{query:'&session_id='+sid});const exchange=srv.exchange.bind(srv);let held=false;
  srv.exchange=async(...args)=>{const out=await exchange(...args);if(!held&&out.innerRequest&&out.innerRequest.action==='input'){
   held=true;arrived=true;return new Promise(resolve=>{release=()=>resolve(out);});
  }return out;};abortableFetch(win);
  const pending=win.api('input',{body:{session_id:sid,data:'ONCE'},signal:controller.signal});
  ok(await until(()=>arrived,1000)>=0,'input executes before its reply is cancelled');controller.abort();const result=await settled(pending);
  ok(result.error&&result.error.sealedDeliveryUnknown===true,'input cancellation retains delivery-unknown classification');
  ok(srv.sessions[sid].input==='ONCE'&&srv.sessions[sid].inputCalls===1,'cancelled mutation is never internally replayed');
  await win.api('input',{body:{session_id:sid,data:'FRESH'}});
  ok(srv.sessions[sid].input==='ONCEFRESH'&&srv.sessions[sid].inputCalls===2,'only later fresh input executes afterward');
 }finally{controller.abort();if(release)release();cleanup(env);}
}
(async()=>{
 for(const stage of ['before headers','body pending','fetch resolution race'])try{await cancelledListing(stage);}catch(e){failed++;console.log('FAIL: '+e.stack);}
 for(const kind of ['damaged encrypted reply','abort-shaped transport failure'])try{await invalidListing(kind);}catch(e){failed++;console.log('FAIL: '+e.stack);}
 try{await abortedMutation();}catch(e){failed++;console.log('FAIL: '+e.stack);}
 for(const env of envs)try{env.dom.window.close();}catch{}
 console.log('\n===========================================\n  passed: '+passed+'   failed: '+failed);process.exit(failed?1:0);
})();
