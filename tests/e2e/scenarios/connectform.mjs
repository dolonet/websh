// Trusted pointer events reproduce Chromium retargeting a selection-release
// click to the backdrop. Synthetic click-only tests miss this sequence.
import { until } from '../lib.mjs';
export const meta = {about:'connection form survives selection across its edge, clipboard actions and focus changes; explicit cancellation still works', ssh:true, local:true, browser:'full'};
export async function run({b,t}) {
  const J=JSON.stringify;
  const visible=()=>b.ev("!document.getElementById('ov').classList.contains('h')");
  const point=sel=>b.ev(`(()=>{const r=document.querySelector(${J(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,left:r.left,right:r.right};})()`);
  const mouse=(type,p,button='left',buttons=0)=>b.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button,buttons,clickCount:1});
  const click=async sel=>{const p=await point(sel);await mouse('mousePressed',p,'left',1);await mouse('mouseReleased',p);};
  const key=async(key,code,vk,modifiers=0,commands)=>{await b.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk,modifiers,...(commands?{commands}:{})});await b.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk,modifiers});};
  await mouse('mousePressed',{x:10,y:100},'left',1);await mouse('mouseReleased',{x:10,y:100});
  await key('Escape','Escape',27);
  t.ok(await visible(),'initial form without a pane remains non-dismissible');
  await b.connect({persistent:false});
  await b.ev(`window.formTrace=[];for(const kind of ['mousedown','mouseup','click','contextmenu','paste','copy','blur','focus'])document.addEventListener(kind,e=>{formTrace.push({kind,target:e.target.id||e.target.className,trusted:e.isTrusted})},true)`);
  const open=async()=>{if(!await visible())await click('#tabNew');await click('#iH');await key('a','KeyA',65,2);await b.send('Input.insertText',{text:'copy-host.example'});await click('#iU');await key('a','KeyA',65,2);await b.send('Input.insertText',{text:'copy-user'});await b.ev('formTrace=[]');};
  await open();
  await click('#iH');await key('a','KeyA',65,2);await key('c','KeyC',67,2);await click('#iU');await key('a','KeyA',65,2);await key('v','KeyV',86,2);
  t.ok(await visible(),'Ctrl+C/V keeps form visible');
  t.ok(await b.ev('iU.value===iH.value&&iH.value==="copy-host.example"'),'real Ctrl+C/V copies the selected host into Username');
  await click('#iH');await key('a','KeyA',65,4,['selectAll']);await key('c','KeyC',67,4,['copy']);
  await click('#iU');await key('a','KeyA',65,4,['selectAll']);await key('v','KeyV',86,4,['paste']);
  t.ok(await visible()&&await b.ev('iU.value===iH.value'),'Meta clipboard editing commands preserve form and values');
  await b.hide();await until(()=>b.ev('document.hidden'),3000);await b.show();await until(()=>b.ev('!document.hidden'),3000);
  t.ok(await visible(),'browser tab switch preserves form');
  await click('#iH');const context=await point('#iH');await mouse('mousePressed',context,'right',2);await mouse('mouseReleased',context,'right');
  t.ok(await visible(),'right-click input preserves form');
  // Dismiss native context menu by clicking within the field, not Escape.
  await click('#iH');
  await b.type(0,"printf 'BACKGROUND_%s\\n' FORM_UPDATE\r");await until(async()=>(await b.screen(0)).includes('BACKGROUND_FORM_UPDATE'),3000);
  t.ok(await visible(),'background terminal output preserves form');
  for(const field of ['#iH','#iU']) for(const side of ['left','right']) {
    await open();const p=await point(field);
    const finish={x:side==='left'?10:await b.ev('innerWidth-10'),y:p.y};
    await mouse('mouseMoved',p);await mouse('mousePressed',p,'left',1);
    await mouse('mouseMoved',{x:side==='left'?p.left-8:p.right+8,y:p.y},'left',1);
    await mouse('mouseMoved',finish,'left',1);await mouse('mouseReleased',finish);
    const trace=await b.ev('formTrace');
    t.ok(trace.some(e=>e.kind==='mousedown'&&e.target===field.slice(1)&&e.trusted)&&trace.some(e=>e.kind==='mouseup'&&e.target==='ov'&&e.trusted),field+' '+side+': native press inside and release outside occurred');
    t.ok(await visible(),field+' '+side+': selection released on backdrop keeps form visible');
    t.ok(await b.ev('iH.value==="copy-host.example"&&iU.value==="copy-user"'),'selection preserves both entered values');
  }
  await open();const inside=await point('#iH');const outside={x:10,y:inside.y};
  await mouse('mousePressed',outside,'left',1);await mouse('mouseMoved',inside,'left',1);await mouse('mouseReleased',inside);
  t.ok(await visible(),'gesture beginning on backdrop and ending in a field preserves form');
  await open();await mouse('mousePressed',outside,'right',2);await mouse('mouseReleased',outside,'right');
  t.ok(await visible(),'secondary-button backdrop gesture does not cancel');
  await click('#iH');
  await mouse('mousePressed',outside,'left',1);await mouse('mouseReleased',outside);
  t.ok(!await visible(),'intentional primary click entirely on backdrop closes form');
  await open();await key('Escape','Escape',27);
  t.ok(!await visible(),'Escape still closes the add-session form');
  await open();await click('#btnCancel');
  t.ok(!await visible(),'Cancel button still closes the add-session form');
  await open();await mouse('mousePressed',outside,'left',1);
  await b.hide();await until(()=>b.ev('document.hidden'),3000);await b.show();await until(()=>b.ev('!document.hidden'),3000);
  await mouse('mouseReleased',outside);
  t.ok(await visible(),'release after browser focus loss does not reuse stale cancellation intent');
  await b.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const touch=(type,p)=>b.send('Input.dispatchTouchEvent',{type,touchPoints:p?[{x:p.x,y:p.y,id:1,radiusX:1,radiusY:1,force:1}]:[]});
  await open();await touch('touchStart',outside);await touch('touchCancel');
  t.ok(await visible(),'cancelled touch does not close the form');
  await open();const field=await point('#iU');await touch('touchStart',field);await touch('touchMove',outside);await touch('touchEnd');
  t.ok(await visible(),'touch gesture from a field onto backdrop preserves form');
  await open();await touch('touchStart',outside);await touch('touchEnd');
  t.ok(await until(async()=>!await visible(),1500)>=0,'fresh intentional backdrop tap still closes after cancelled touch');
  await b.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  t.ok(await b.ev('Object.keys(panes).length===1&&tabs.length===1'),'dismissal creates no phantom panes or tabs');
}
