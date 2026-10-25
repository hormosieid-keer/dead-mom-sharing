// Isolated extension + real storage, navigation and alarm events. Every page
// action is a synthetic adapter; no Douyin account, messages or SMTP are used.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState } from '../extension/core.js';

const root=path.resolve(import.meta.dirname,'..');
const autoLoop=process.env.BOT_TEST_AUTO_LOOP==='1';
const results=path.join(root,'test-results');
await mkdir(results,{recursive:true});
const temp=await mkdtemp(path.join(results,'search-continuation-v18-temp-'));
const extension=path.join(temp,'extension');
await mkdir(extension);
let context;
const requests=[];
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
  const source=await readFile(path.join(root,'extension/background.js'),'utf8');
  await writeFile(path.join(extension,'background.js'),source.replace("const MAIL = 'http://127.0.0.1:17321';",`const MAIL = '${mail}';`));
  await writeFile(path.join(extension,'adapter.js'),`export async function browserTask(input){
    if(input.action==='videoStatus')return {unavailable:false,videoId:input.videoId};
    if(input.action==='probe')return {id:'123',name:'fixture'};
    if(input.action==='search'){
      if(${autoLoop}){
        const count=Number(sessionStorage.getItem('fixture-search-count')||0)+1;
        sessionStorage.setItem('fixture-search-count',String(count));
        return {payloads:count===1?['739000000000000001','739000000000000002'].map(id=>({id,type:'video',publishedAt:Date.now()-1000,description:'自动查询',tags:[]})):[],truncated:false};
      }
      return {payloads:[{id:input.query==='第一查询'?'739000000000000001':'739000000000000002',
        type:'video',publishedAt:Date.now()-1000,description:'第一查询 第二查询',tags:[]}],truncated:false};
    }
    if(input.action==='openShare')return {opened:true};
    if(input.action==='share'&&input.mode==='probe')return ${autoLoop}?{fallback:true}:{sent:true,alreadySent:true};
    if(${autoLoop}&&input.action==='share'&&!input.mode)return {sent:true};
    throw new Error('Unexpected fixture action: '+input.action);
  }`);
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
    executablePath:process.env.BOT_TEST_CHROMIUM||undefined,channel:'chromium',headless:true,viewport:null,
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]
  });
  await context.route('https://www.douyin.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local search fixture</title>'}));
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname;
  const options=await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}));
  const config={schemaVersion:1,maxPages:1,maxVideosPerWindow:autoLoop?1:5,mailBridgeToken:'x'.repeat(40),account:{id:'123',name:'fixture'},
    rules:[{id:'r',tags:[],keywords:autoLoop?['自动查询']:['第一查询','第二查询'],recipients:[{id:'friend',name:'fixture friend',avatarKey:'fixture-avatar'}]}]};
  await worker.evaluate(async ({autoLoop,...data})=>{
    await chrome.storage.local.set(data);
    const realNow=Date.now;
    globalThis.fixtureRealNow=realNow;
    let advance=0;
    Date.now=()=>realNow()+advance;
    globalThis.fixtureAdvanceTo=at=>{advance=Math.max(advance,at-realNow());};
    globalThis.fixtureQueries=[];
    const execute=chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript=async options=>{
      const result=await execute(options);
      if(options.args?.[0]?.action==='search'){
        fixtureQueries.push(options.args[0].query);
        if(fixtureQueries.length===1&&!autoLoop)advance=185000;
      }
      return result;
    };
  },{state:defaultState(),config,autoLoop});
  if(autoLoop)await options.locator('#auto-loop').click();
  else {
    const started=await options.evaluate(()=>chrome.runtime.sendMessage({type:'START'}));
    assert.equal(started.ok,true,JSON.stringify(started));
  }
  const status=async()=> (await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}))).data;
  const wait=async predicate=>{
    for(let step=0;step<300;step++){
      const data=await status();
      assert.equal(data.state.paused,false,JSON.stringify(data.state.incident));
      if(predicate(data))return data;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    const latest=await status();
    throw new Error('Segmented extension fixture did not settle: '+JSON.stringify({busy:latest.busy,
      enabled:latest.state.enabled,paused:latest.state.paused,stage:latest.state.round?.stage,
      plan:latest.state.resumePlan,statuses:latest.state.deliveries.map(d=>d.status),logs:latest.state.logs.slice(0,5)}));
  };
  const kick=()=>worker.evaluate(async()=>{
    const {state}=await chrome.storage.local.get('state');
    fixtureAdvanceTo(state.resumePlan.at+1);
    await chrome.alarms.create('douyin-continue',{when:fixtureRealNow()-1});
  });
  if(autoLoop){
    const first=await wait(data=>!data.busy&&data.state.resumePlan?.reason==='rate-limit');
    const round=first.state.round.id;
    assert.equal(first.state.enabled,true);
    assert.equal(first.state.runMode,'auto-loop');
    assert.deepEqual(first.state.deliveries.map(d=>d.status),['sent','pending']);
    await options.waitForFunction(()=>document.querySelector('#status').textContent==='等待限速');
    assert.equal(await options.locator('#sent-count').textContent(),'1');
    await options.screenshot({path:path.join(results,'auto-loop-v20-wait.png'),fullPage:true});
    await options.setViewportSize({width:390,height:844});
    assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await options.locator('.control').screenshot({path:path.join(results,'auto-loop-v20-wait-390.png')});
    await kick();
    const sent=await wait(data=>!data.busy&&data.state.resumePlan?.reason==='next-round');
    assert.equal(sent.state.round.id,round);
    assert.deepEqual(sent.state.deliveries.map(d=>d.status),['sent','sent']);
    assert.equal(sent.state.friendReadReport.sent,2);
    assert.deepEqual(await worker.evaluate(()=>fixtureQueries),['自动查询']);
    await kick();
    const second=await wait(data=>!data.busy&&data.state.round?.id!==round&&data.state.resumePlan?.reason==='next-round');
    assert.equal(second.state.deliveries.length,2,'repeat search must not resend confirmed cards');
    assert.deepEqual(await worker.evaluate(()=>fixtureQueries),['自动查询','自动查询']);
    await options.locator('#pause').click();
    await wait(data=>!data.busy&&!data.state.enabled);
    await worker.evaluate(()=>chrome.alarms.create('douyin-continue',{when:fixtureRealNow()-1}));
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.deepEqual(await worker.evaluate(()=>fixtureQueries),['自动查询','自动查询']);
    assert.equal((await status()).state.resumePlan,null);
    assert.deepEqual(requests,['/check']);
    const report='PASS: actual AUTO_LOOP button starts query/send batches, rate waiting stays enabled, a real Chrome alarm finishes the queue before the next query, confirmations do not repeat, and Pause cancels further work. Desktop/390px checked. Synthetic adapter only; no real cards or mail.';
    await writeFile(path.join(results,'auto-loop-v20-smoke.txt'),report+'\n');console.log(report);
  }else{
  const first=await wait(data=>!data.busy&&data.state.round?.stage==='waiting-search');
  assert.equal(first.state.searchCheckpoint.nextIndex,1);
  assert.equal(first.state.deliveries[0].status,'sent');
  assert.equal(first.state.round.queriesDone,1);
  const round=first.state.round.id;
  const scheduled=await worker.evaluate(()=>chrome.alarms.get('douyin-continue'));
  assert.ok(scheduled,'continuation must persist in real Chrome alarms');
  await options.waitForFunction(()=>document.querySelector('#round-summary').textContent.includes('队列已发完，将自动继续剩余查询'));
  await options.screenshot({path:path.join(results,'segmented-search-v18-waiting.png'),fullPage:true});
  await options.setViewportSize({width:390,height:844});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'narrow layout must not overflow');
  await options.screenshot({path:path.join(results,'segmented-search-v18-waiting-390.png'),fullPage:true});
  // Move only this fixture's alarm to the real present: the artificial worker
  // clock would otherwise leave a three-minute wall-clock wait in the test.
  await kick();
  const finished=await wait(data=>!data.busy&&data.state.round?.status==='done'&&data.state.round.queriesDone===2);
  assert.equal(finished.state.round.id,round);
  assert.equal(finished.state.searchCheckpoint,null);
  assert.deepEqual(finished.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.deepEqual(await worker.evaluate(()=>fixtureQueries),['第一查询','第二查询']);
  assert.deepEqual(requests,['/check']);
  const report='PASS: real extension yields its query budget, drains discovered fixture cards, persists a continuation alarm and automatically resumes only the second query in the same round. No real messages or email.';
  await writeFile(path.join(results,'segmented-search-v18-smoke.txt'),report+'\n');
  console.log(report);
  }
} finally {
  await context?.close();
  await new Promise(resolve=>bridge.close(resolve));
  const resolved=path.resolve(temp);
  if(path.dirname(resolved)!==results||!path.basename(resolved).startsWith('search-continuation-v18-temp-'))throw new Error('Unsafe fixture cleanup');
  await rm(resolved,{recursive:true,force:true});
}
