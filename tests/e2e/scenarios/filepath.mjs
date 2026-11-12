// The copy action uses the committed breadcrumb directory and works at narrow widths.
import {until} from '../lib.mjs';
export const meta={about:'copy current file-browser directory through real clipboard; accessible control and narrow header',ssh:true,local:true,browser:'full'};
export async function run({b,t}) {
 await b.connect({persistent:false});const id=await b.ev('Object.keys(panes)[0]');
 await b.send('Browser.grantPermissions',{origin:new URL(b.url).origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
 await b.ev(`showFileBrowser(${JSON.stringify(id)})`);
 await until(()=>b.ev("!!document.getElementById('fbPath').dataset.path&&!document.getElementById('fbList').hasAttribute('aria-busy')"),10000);
 if(!t.ok(await b.ev("!!document.getElementById('fbCopyPath')"),'copy-path button exists'))return;
 const click=async selector=>{const p=await b.ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mousePressed','mouseReleased'])await b.send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});};
 for(const width of [1200,560,360]) {
  await b.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
  await b.ev('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  const layout=await b.ev(`(()=>{const e=document.getElementById('fbCopyPath'),n=document.getElementById('fbPath'),r=e.getBoundingClientRect(),p=n.getBoundingClientRect(),panel=document.querySelector('.fb-panel').getBoundingClientRect(),header=document.querySelector('.fb-hd');return{panelLeft:panel.left,panelRight:panel.right,width:innerWidth,pathWidth:p.width,headerFits:header.scrollWidth<=header.clientWidth,label:e.getAttribute('aria-label'),left:r.left,right:r.right,pathLeft:p.left,hit:!!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#fbCopyPath')};})()`);
  t.ok(/copy.*path/i.test(layout.label)&&layout.hit&&layout.left>=0&&layout.right<=layout.pathLeft+1&&layout.panelLeft>=0&&layout.panelRight<=width&&layout.pathWidth>=40&&layout.headerFits,`${width}px: accessible, clickable copy button left of path inside an unclipped header with a usable breadcrumb`);
  const expected=await b.ev("document.getElementById('fbPath').dataset.path");
  await b.ev("document.getElementById('fbManual').value='/not-submitted'");await click('#fbCopyPath');
  t.ok(await until(()=>b.ev(`navigator.clipboard.readText().then(s=>s===${JSON.stringify(expected)})`),2000)>=0,`${width}px: clipboard contains exact displayed directory`);
 }
 await b.ev("loadFbDir('/')");await until(()=>b.ev("document.getElementById('fbPath').dataset.path==='/'&&!document.getElementById('fbList').hasAttribute('aria-busy')"),10000);
 await click('#fbCopyPath');t.ok(await until(()=>b.ev("navigator.clipboard.readText().then(s=>s==='/')"),2000)>=0,'root copies exactly /');
}
