// Real extension storage/navigation + the serialized real availability adapter.
// All pages, account probes, send results and mail health are local fixtures.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState, enqueue } from '../extension/core.js';
import { browserTask } from '../extension/adapter.js';

const root=path.resolve(import.meta.dirname,'..'),results=path.join(root,'test-results');
await mkdir(results,{recursive:true});
const temp=await mkdtemp(path.join(results,'unavailable-v21-temp-')),extension=path.join(temp,'extension');
await mkdir(extension);
const requests=[],pages=[];
let context;
const bridge=createServer((req,res)=>{
  requests.push(req.url);res.setHeader('Content-Type','application/json');
  if(req.url==='/check')res.end('{"configured":true}');
  else {res.writeHead(500);res.end('{}');}
});
try {
  await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(0,'127.0.0.1',resolve);});
  const mail=`http://127.0.0.1:${bridge.address().port}`;
  const manifest=JSON.parse(await readFile(path.join(root,'extension/manifest.json'),'utf8'));
  manifest.host_permissions=['https://www.douyin.com/*','http://127.0.0.1/*'];
  manifest.content_security_policy.extension_pages=`script-src 'self'; object-src 'self'; connect-src 'self' ${mail}`;
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  for(const name of ['core.js','pointer.js','network-tap.js','options.html','options.css','options.js'])
    await copyFile(path.join(root,'extension',name),path.join(extension,name));
  for(const asset of ['browser-alerts.js','alert-player.js','alert-player.html','audio','icons']) await cp(path.join(root,'extension',asset),path.join(extension,asset),{recursive:true});
  const source=await readFile(path.join(root,'extension/background.js'),'utf8');
  await writeFile(path.join(extension,'background.js'),source.replace("const MAIL = 'http://127.0.0.1:17321';",`const MAIL = '${mail}';`));
  await writeFile(path.join(extension,'adapter.js'),`export async function browserTask(input){
    if(input.action==='videoStatus')return (${browserTask.toString()})(input);
    if(input.action==='probe')return {id:'123',name:'fixture'};
    if(input.action==='openShare')return {opened:true};
    if(input.action==='share'&&input.mode==='probe')return {fallback:true};
    if(input.action==='share'&&!input.mode)return {sent:true};
    throw new Error('Unexpected fixture action: '+input.action);
  }`);
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
    executablePath:process.env.BOT_TEST_CHROMIUM||undefined,channel:'chromium',headless:true,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
  });
  const dead='739000000000000001',good='739000000000000002';
  await context.route('https://www.douyin.com/**',route=>{
    pages.push(route.request().url());
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><title>Local availability fixture</title>${route.request().url().endsWith(dead)?'<main><div class="error-page"><p>你要观看的视频不存在</p></div></main>':'<video></video><p>正常视频模拟页</p>'}`});
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname,options=await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}));
  const config={schemaVersion:1,maxPages:1,mailBridgeToken:'x'.repeat(40),account:{id:'123',name:'演示账号'},
    rules:[{id:'r',tags:['司凤'],recipients:['A','B','C'].map(name=>({id:name,name:'演示好友'+name,avatarKey:name}))}]};
  const state=defaultState();
  enqueue(state,[dead,good].map(id=>({id,type:'video',publishedAt:Date.now()-1000,
    description:id===dead?'已失效视频（演示）':'正常视频（演示）',tags:[{id:'tag',name:'司凤'}]})),config);
  await worker.evaluate(data=>chrome.storage.local.set(data),{state,config});
  const started=await options.evaluate(()=>chrome.runtime.sendMessage({type:'SEND_PENDING'}));
  assert.equal(started.ok,true,JSON.stringify(started));
  let after;
  for(let attempt=0;attempt<300;attempt++) {
    after=(await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}))).data;
    assert.equal(after.state.paused,false,JSON.stringify(after.state.incident));
    if(!after.busy&&after.state.round?.status==='done')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(after.state.round.status,'done');
  assert.deepEqual(after.state.deliveries.map(d=>d.status),['skipped','skipped','skipped','sent','sent','sent']);
  assert.equal(after.state.friendReadReport.skipped,3);assert.equal(after.state.friendReadReport.sent,3);
  assert.equal(after.state.unavailableVideos[0].videoId,dead);
  assert.deepEqual(pages.map(url=>new URL(url).pathname),['/video/'+dead,'/video/'+good]);
  assert.deepEqual(requests,['/check'],'no incident or mail for a clearly unavailable video');
  await options.waitForFunction(()=>document.querySelector('#preview').textContent.includes('失效跳过 3 项'));
  assert.equal(await options.locator('#sent-count').textContent(),'3');
  await options.locator('#preview').locator('..').screenshot({path:path.join(results,'unavailable-v21-preview.png')});
  await options.setViewportSize({width:390,height:844});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await options.locator('#preview').locator('..').screenshot({path:path.join(results,'unavailable-v21-preview-390.png')});
  const report='PASS: real serialized adapter recognizes “你要观看的视频不存在”; real worker skips all 3 pending recipients, navigates once to the next video, confirms 3 synthetic sends, and reports separate skip/sent counts. No reload, incident, real account, message or email. Desktop/390px layout checked.';
  await writeFile(path.join(results,'unavailable-v21-smoke.txt'),report+'\n');console.log(report);
} finally {
  await context?.close();await new Promise(resolve=>bridge.close(resolve));
  const resolved=path.resolve(temp);
  if(path.dirname(resolved)!==results||!path.basename(resolved).startsWith('unavailable-v21-temp-'))throw new Error('Unsafe cleanup path');
  await rm(resolved,{recursive:true,force:true});
}
