// Real Chromium + the unpacked extension. All Douyin pages/APIs are local fixtures.
// The loopback endpoint is a fake recorder; no SMTP or real messages are sent.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..');
await mkdir(path.join(root,'test-results'),{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'douyin-extension-test-'));
let context;
const alerts=[],sends=[];
let scenario='initial',confirm555=false;
const token='fixture-only-not-a-real-secret-0123456789';
const bridge=createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');
  res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
  res.setHeader('Content-Type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(req.url==='/check' && req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/health'||req.url==='/check'){res.end('{"configured":true}');return;}
  if(req.url==='/alert'){
    let body='';for await(const chunk of req)body+=chunk;
    const payload=JSON.parse(body);assert.equal(req.headers.authorization,`Bearer ${token}`);assert.equal(typeof payload.at,'string');assert.ok(payload.incidentId.length<=160);
    alerts.push(payload);res.end('{"ok":true,"duplicate":false}');return;
  }res.writeHead(404);res.end('{}');
});
await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(17321,'127.0.0.1',resolve);});
function rawVideo(id,{tag=true,age=300,image=false}={}){
  return {aweme_id:id,aweme_type:image?68:0,video:{title:'fixture'},images:image?[{}]:[],desc:tag?'带真实话题的测试视频':'只是提到爱慕杰几个字',create_time:Math.floor(Date.now()/1000)-age,
    text_extra:tag?[{type:1,hashtag_id:'9001',hashtag_name:'爱慕杰'}]:[]};
}
// Mirrors the live share popover: two images per row (avatar + flame badge),
// a plain "搜索" box, a virtualized "分享给朋友" heading and a div[data-userid]
// share control. Only the first friend renders until the box is searched.
function videoHtml(id){
  const confirmation=id!=='555'||confirm555;
  const friends=[{uid:'700000000000000001',name:'测试好友甲'},{uid:'700000000000000002',name:'测试好友乙'}];
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><h1>测试视频 ${id}</h1>
  <div data-e2e="detail-video-info" data-e2e-aweme-id="${id}"><div data-e2e="video-share-icon-container" onmouseover="openShare()" onclick="openShare()"><span>分享</span></div></div>
  <script>
  const friends=${JSON.stringify(friends)};
  function row(field){return '<div class="row"><div class="avatar"><img src="https://fixture-avatar.test/aweme-avatar'+field.uid.slice(-1)+'.jpeg?biz_tag=aweme_im"></div><div class="meta"><span>'+field.name+'</span><div class="streak"><img src="https://lf3-static.bytednsdoc.com/obj/fixture/flame.png"><div>375</div></div><div class="status">在线</div></div><div class="send" data-userid="'+field.uid+'" onclick="sendFixture(this,'+field.uid.slice(-1)+')">分享</div></div>'}
  function openShare(){if(document.querySelector('[data-e2e="video-share-container"]'))return;const box=document.createElement('div');box.setAttribute('data-e2e','video-share-container');box.innerHTML='<div class="list"><div class="search"><input placeholder="搜索"></div><div class="virtual"><div><div>分享给朋友</div></div>'+row(friends[0])+row(friends[1])+'</div></div>';document.body.append(box);box.querySelector('input').addEventListener('input',event=>{const match=friends.find(friend=>event.target.value.includes(friend.name));if(match)box.querySelector('.virtual').innerHTML=row(match);});}
  function sendFixture(control,index){const records=JSON.parse(localStorage.getItem('fixtureSends')||'[]');records.push('${id}:'+index);localStorage.setItem('fixtureSends',JSON.stringify(records));${confirmation?"control.textContent='已发送';":""}}
  </script></body></html>`;
}
try{
  context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:process.env.BOT_TEST_CHROMIUM||undefined,headless:true,viewport:{width:1366,height:1000},
    args:[`--disable-extensions-except=${path.join(root,'extension')}`,`--load-extension=${path.join(root,'extension')}`]});
  const errors=[];
  context.on('page',page=>{
    page.on('pageerror',error=>errors.push(error.message));
  });
  const placeholderSvg={status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#d7dce3"/></svg>'};
  await context.route('https://fixture-avatar.test/**',route=>route.fulfill(placeholderSvg));
  await context.route('https://lf3-static.bytednsdoc.com/**',route=>route.fulfill(placeholderSvg));
  await context.route('https://www.douyin.com/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/fixture-send'){sends.push(`${url.searchParams.get('videoId')}:${url.searchParams.get('recipient')}`);return route.fulfill({json:{ok:true}});}
    if(url.pathname.includes('/user/profile/self/'))return route.fulfill({json:{status_code:0,user:{uid:'123456',sec_uid:'fixture-self',nickname:'联调测试账号'}}});
    if(url.pathname.includes('/search/item/')){
      const data=scenario==='initial'?[rawVideo('111'),rawVideo('222',{tag:false}),rawVideo('333',{image:true}),rawVideo('444',{age:4000})]:[rawVideo('111'),rawVideo('555')];
      return route.fulfill({json:{status_code:0,data:data.map(aweme_info=>({aweme_info})),cursor:0,has_more:0}});
    }
    const id=url.pathname.match(/^\/video\/(\d+)/)?.[1];
    return route.fulfill({contentType:'text/html; charset=utf-8',body:id?videoHtml(id):'<!doctype html><html><head><meta charset="utf-8"></head><body><h1>抖音联调页面</h1></body></html>'});
  });
  let [worker]=context.serviceWorkers();if(!worker)worker=await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  const options=await context.newPage();await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.waitForSelector('#rules .rule');
  const api=(type,fields={})=>options.evaluate(async({type,fields})=>{
    const result=await chrome.runtime.sendMessage({type,...fields});if(!result.ok)throw Error(result.error);return result.data;
  },{type,fields});
  const waitUntil=async(predicate,timeout=45000)=>{
    const end=Date.now()+timeout;
    while(Date.now()<end){const status=await api('STATUS');if(predicate(status))return status;await new Promise(r=>setTimeout(r,150));}
    throw new Error(`Fixture status timeout: ${JSON.stringify((await api('STATUS')).state)}`);
  };
  const douyin=await context.newPage();await douyin.goto('https://www.douyin.com/video/111');
  await api('BIND');await options.reload();await options.waitForSelector('#rules .rule');
  await options.locator('#load-friends').click();
  await options.waitForFunction(()=>document.querySelectorAll('.recipient-choice').length===2);
  await options.locator('.recipient-choice input').nth(0).check();await options.locator('.recipient-choice input').nth(1).check();
  await options.locator('#mail-token').fill(token);await options.locator('#save').click();
  await options.waitForFunction(()=>document.getElementById('toast').textContent.includes('设置已保存'));
  const bound=await api('STATUS');
  assert.deepEqual(bound.config.rules[0].recipients.map(r=>r.id),['uid:700000000000000001','uid:700000000000000002'],'friends must bind by numeric uid');
  const scan=await api('SCAN');assert.equal(scan.count,1,'plain-text tag, image post and old video must not match');
  assert.equal(sends.length,0,'dry-run must never send');
  await options.reload();await options.waitForSelector('#rules .rule');
  await options.screenshot({path:path.join(root,'test-results','dashboard.png'),fullPage:true});
  await options.setViewportSize({width:390,height:844});
  assert.ok(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile dashboard should not overflow');
  await options.screenshot({path:path.join(root,'test-results','dashboard-mobile.png'),fullPage:true});
  await options.setViewportSize({width:1366,height:1000});
  await api('START');
  await waitUntil(r=>r.state.deliveries.filter(d=>d.status==='sent').length===2&&!r.busy);
  await api('PAUSE');
  sends.splice(0,sends.length,...await douyin.evaluate(()=>JSON.parse(localStorage.getItem('fixtureSends')||'[]')));
  assert.equal(sends.length,2,'one native video card sent to each selected friend');
  const before=await api('STATUS');assert.equal(new Set(before.state.rate.map(r=>r.videoId)).size,1,'multi-recipient video uses one distinct-video slot');
  await api('START');
  await waitUntil(r=>!r.busy&&r.state.lastScanAt>before.state.lastScanAt);
  await api('PAUSE');assert.equal(sends.length,2,'restart monitoring cannot re-send existing deliveries');
  scenario='uncertain';
  await api('START');
  await waitUntil(r=>r.state.paused&&r.state.deliveries.some(d=>d.status==='unknown')&&r.state.incident?.notified&&!r.busy);
  assert.equal(alerts.length,1,'uncertain send should notify one incident');
  const failed=await api('STATUS');const unknown=failed.state.deliveries.find(d=>d.status==='unknown');
  await assert.rejects(()=>api('START'),/核对/);
  const backup=await api('EXPORT');assert.equal(backup.config.mailBridgeToken,'');assert.equal(backup.state.enabled,false);
  // User has inspected the fixture chat and confirmed the first send occurred.
  await api('RESOLVE',{key:unknown.key,action:'sent'});confirm555=true;
  await api('START');
  await waitUntil(r=>r.state.deliveries.length===4&&r.state.deliveries.every(d=>d.status==='sent')&&!r.busy);
  await api('PAUSE');
  sends.splice(0,sends.length,...await douyin.evaluate(()=>JSON.parse(localStorage.getItem('fixtureSends')||'[]')));
  assert.equal(sends.length,4,'resolved uncertain recipient is not resent; only remaining friend receives card');
  assert.equal(errors.length,0,errors.join('\n'));
  const report={passed:true,checks:['real unpacked extension loads','UI saves and selects friends','numeric uid friend binding','tag versus ordinary text','image/old video exclusion','dry-run sends nothing','native share fixture with two recipients','restart dedupe','single distinct-video rate slot','uncertain delivery pauses','authenticated email alert protocol','manual resolve and resume','export excludes bridge token','mobile layout no overflow'],sentFixtureCards:sends.length,alertsRecorded:alerts.length,realDouyinRequests:0,realMessagesSent:0,realEmailsSent:0};
  await writeFile(path.join(root,'test-results','extension-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  await context?.close();await new Promise(resolve=>bridge.close(resolve));
  // Verified absolute target is a task-created directory in the OS temp folder.
  if(profile.startsWith(path.join(tmpdir(),'douyin-extension-test-')))await rm(profile,{recursive:true,force:true});
}
