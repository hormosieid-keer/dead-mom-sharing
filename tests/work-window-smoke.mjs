// Exercise real Chrome windows/tabs APIs in an isolated headless profile.
// Page actions use a stub adapter: no real account, sharing or SMTP is possible.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, cp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState, enqueue } from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const refreshCase = process.env.BOT_TEST_SEND_REFRESH === '1' || process.env.BOT_TEST_FIRST_REFRESH === '1';
const manualPauseCase=process.env.BOT_TEST_MANUAL_PAUSE==='1';
const noMailCase=process.env.BOT_TEST_NO_MAIL==='1';
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
const temp = await mkdtemp(path.join(results, 'worker-window-v9-temp-'));
const extension = path.join(temp, 'extension');
await mkdir(extension);
let context;
const requests = [];
const bridge = createServer((req, res) => {
  requests.push(req.url);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/check') res.end('{"configured":true}');
  else { res.writeHead(500); res.end('{}'); }
});
try {
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
  const mail = `http://127.0.0.1:${bridge.address().port}`;
  const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
  manifest.host_permissions = ['https://www.douyin.com/*', 'http://127.0.0.1/*'];
  manifest.content_security_policy.extension_pages = `script-src 'self'; object-src 'self'; connect-src 'self' ${mail}`;
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  for (const name of ['core.js', 'pointer.js', 'network-tap.js']) await copyFile(path.join(root, 'extension', name), path.join(extension, name));
  for(const asset of ['browser-alerts.js','alert-player.js','alert-player.html','audio','icons']) await cp(path.join(root,'extension',asset),path.join(extension,asset),{recursive:true});
  const source = await readFile(path.join(root, 'extension/background.js'), 'utf8');
  assert.ok(source.includes("const MAIL = 'http://127.0.0.1:17321';"));
  await writeFile(path.join(extension, 'background.js'), source.replace("const MAIL = 'http://127.0.0.1:17321';", `const MAIL = '${mail}';`));
  await writeFile(path.join(extension, 'adapter.js'), `export async function browserTask(input) {
    if(input.action==='videoStatus')return {unavailable:false,videoId:input.videoId};
    if(input.action==='probe') return {id:'123',name:'fixture'};
    if(input.action==='openShare') {
      if(${refreshCase}) {
        const marker='fixture-share-documents';
        const documents=JSON.parse(sessionStorage.getItem(marker)||'[]');
        if(!documents.includes(performance.timeOrigin)) documents.push(performance.timeOrigin);
        sessionStorage.setItem(marker,JSON.stringify(documents));
        if(documents.length<=2)
          return {error:'Local fixture: share entry not mounted',code:'SHARE_ENTRY_MISSING'};
      }
      return {opened:true};
    }
    if(input.action==='share'&&input.mode==='probe') return ${manualPauseCase}?{prepared:true,x:5,y:6}:{sent:true,alreadySent:true};
    if(input.action==='share'&&input.mode==='arm')return {armed:true,receiptToken:'fixture-pause-token'};
    throw new Error('Unexpected test action: '+input.action);
  }`);
  for(const name of ['options.html','options.css','options.js']) await copyFile(path.join(root,'extension',name),path.join(extension,name));
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    // Exercise native window bounds; Playwright's default per-page viewport
    // emulation would resize a freshly attached page back to a normal window.
    executablePath: process.env.BOT_TEST_CHROMIUM || undefined, channel: 'chromium', headless: true,viewport:null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  await context.route('https://www.douyin.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local video fixture</title>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(manualPauseCase=>{
    globalThis.fixtureSurfaceEvents=[];
    globalThis.fixtureAwaitingPause=false;
    globalThis.fixturePresses=0;
    if(manualPauseCase){
      const execute=chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript=async options=>{
        const result=await execute(options);
        if(options.args?.[0]?.mode==='arm'){
          fixtureAwaitingPause=true;
          await new Promise(resolve=>{globalThis.fixtureReleaseArm=resolve;});
        }
        return result;
      };
      const dispatch=chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand=async(target,method,params)=>{
        if(method==='Input.dispatchMouseEvent'&&params?.type==='mousePressed')fixturePresses++;
        return dispatch(target,method,params);
      };
    }
    const update=chrome.tabs.update.bind(chrome.tabs);
    chrome.tabs.update=async(tabId,options)=>{
      if(options.url){
        const tab=await chrome.tabs.get(tabId);
        fixtureSurfaceEvents.push({kind:'navigate',muted:tab.mutedInfo?.muted===true,url:options.url});
      }
      return update(tabId,options);
    };
    const create=chrome.windows.create.bind(chrome.windows);
    chrome.windows.create=async(options)=>{
      const muted=options.tabId!=null?(await chrome.tabs.get(options.tabId)).mutedInfo?.muted===true:null;
      fixtureSurfaceEvents.push({kind:'create',options,muted});
      return create(options);
    };
  },manualPauseCase);
  const id = new URL(worker.url()).hostname;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }));
  const old = await worker.evaluate(async () => {
    const current = await chrome.tabs.query({ active: true });
    const win = current.find(t => t.url?.startsWith('chrome-extension://')).windowId;
    const tab = await chrome.tabs.create({ windowId: win, url: 'https://www.douyin.com/video/739000000000000001', active: false });
    return { tabId: tab.id, windowId: win };
  });
  let loaded = false;
  for (let round = 0; round < 100; round++) {
    const tab = await worker.evaluate(tabId => chrome.tabs.get(tabId), old.tabId);
    if (tab.status === 'complete' && tab.url?.startsWith('https://www.douyin.com/')) { loaded = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(loaded, true, 'legacy fixture tab must finish loading before it is reused');
  const config = { schemaVersion: 1, maxPages: 1, mailAlertsEnabled:!noMailCase,mailBridgeToken:noMailCase?'':'x'.repeat(40), account: { id: '123', name: 'fixture' },
    rules: [{ id: 'r', tags: ['测试话题'], keywords: [], recipients: [{ id: 'uid:7000000000000000001', uid: '7000000000000000001', name: 'fixture friend' }] }] };
  const state = { ...defaultState(), workerTabId: old.tabId, workerWindowId: old.windowId };
  state.friendReadReport = { at: 1, error: 'old share-prepare-v5 fixture' };
  enqueue(state, [{ id: '739000000000000001', type: 'video', publishedAt: Date.now() - 1000,
    title: '', description: '', tags: [{ id: 'tag-1', name: '测试话题' }] }], config);
  await worker.evaluate(data => chrome.storage.local.set(data), { state, config });
  const started = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SEND_PENDING' }));
  assert.equal(started.ok, true, JSON.stringify(started));
  if(manualPauseCase){
    let armed=false;
    for(let index=0;index<200;index++){
      if(await worker.evaluate(()=>fixtureAwaitingPause)){armed=true;break;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.equal(armed,true,'must reach the held arm callback before pressing');
    const paused=await options.evaluate(()=>chrome.runtime.sendMessage({type:'PAUSE'}));
    assert.equal(paused.ok,true);
    await worker.evaluate(()=>fixtureReleaseArm());
  }
  // This Playwright build treats a Promise as a truthy waitForFunction result;
  // poll awaited status messages in Node rather than an async page predicate.
  let finished = false;
  for (let round = 0; round < 200; round++) {
    const reply = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }));
    if (!reply.data.busy && reply.data.state.logs.some(entry => entry.message.includes('本次待发直发已结束'))) { finished = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(finished, true, 'queue worker must finish within the fixture budget');
  const after = await options.evaluate(async () => {
    const { data: { state } } = await chrome.runtime.sendMessage({ type: 'STATUS' });
    return { state, window: await chrome.windows.get(state.workerWindowId, { populate: true }) };
  });
  if(manualPauseCase){
    assert.equal(after.state.deliveries[0].status,'pending');
    assert.equal(after.state.enabled,false);assert.equal(after.state.paused,false);
    assert.equal(after.state.incident,null);assert.equal(after.state.round.status,'paused');
    assert.equal(after.state.friendReadReport.error,undefined);assert.equal(after.state.friendReadReport.stopReason,'manual-pause');
    assert.equal(await worker.evaluate(()=>fixturePresses),0);
    assert.deepEqual(requests,noMailCase?[]:['/check'],'manual cancellation must not call the alert endpoint');
    const report='PASS: actual isolated extension pauses while the arm response is held, cancels before real pointer press, retains pending delivery and paused round, creates no incident or alert. Synthetic account/page only; no real send or mail.';
    await writeFile(path.join(results,'manual-pause-smoke.txt'),report+'\n');console.log(report);
  }else{
  assert.equal(after.state.deliveries[0].status, 'sent', JSON.stringify({ incident: after.state.incident, logs: after.state.logs }));
  assert.equal(after.state.friendReadReport.phase, 'done');
  assert.equal(after.state.friendReadReport.build, '0.2.5（告警红点增强）');
  assert.equal(after.state.friendReadReport.sent, 0, 'already-sent fixture performs no new send');
  assert.equal(after.state.round.source,'queue');
  assert.equal(after.state.round.status,'done');
  assert.equal(after.state.round.foundCount,1);
  assert.equal(after.state.round.videos[0].id,'739000000000000001');
  assert.equal(after.state.deliveries[0].attemptRoundId,null);
  await options.waitForFunction(()=>document.getElementById('round-summary').textContent.includes('待发直发'));
  assert.equal(await options.locator('#sent-count').textContent(),'0');
  assert.match(await options.locator('#preview').textContent(),/此前已发送 1 张/);
  assert.equal(after.state.friendReadReport.error, undefined);
  assert.ok(after.state.friendReadReport.seq >= 2);
  assert.notEqual(after.window.id, old.windowId);
  assert.equal(after.window.focused, false, 'the work window must remain unfocused');
  assert.equal(after.window.state,'maximized','the work window must occupy the display work area');
  assert.equal(after.window.tabs[0].mutedInfo.muted,true,'browser-level tab muting must be enabled');
  assert.equal(after.window.tabs.length, 1);
  assert.equal(after.window.tabs[0].id, old.tabId);
  assert.equal(after.window.tabs[0].active, true);
  const settingsStayed = await options.evaluate(async oldWindow => {
    const [tab] = await chrome.tabs.query({ windowId: oldWindow, active: true });
    return tab.url === location.href;
  }, old.windowId);
  assert.equal(settingsStayed, true);
  assert.deepEqual(requests, noMailCase?[]:['/check']);
  if(refreshCase) {
    assert.equal(after.state.logs.filter(entry=>entry.message.includes('自动刷新当前视频')).length,2);
    const navigation = await worker.evaluate(async tabId => {
      const [{ result }] = await chrome.scripting.executeScript({target:{tabId},func:()=>performance.getEntriesByType('navigation')[0]?.type});
      return result;
    }, old.tabId);
    assert.equal(navigation, 'reload', 'real tabs.reload must replace the old video document');
    const documents=await worker.evaluate(async tabId=>{
      const [{result}]=await chrome.scripting.executeScript({target:{tabId},func:()=>JSON.parse(sessionStorage.getItem('fixture-share-documents'))});
      return result;
    },old.tabId);
    assert.equal(documents.length,3,'two failed documents followed by the third successful document');
  }
  if(!refreshCase){
    const initialDocument=await worker.evaluate(async tabId=>(await chrome.scripting.executeScript({target:{tabId},func:()=>performance.timeOrigin}))[0].result,old.tabId);
    const queueFixture=async(videoId,recipientId)=>worker.evaluate(async({videoId,recipientId})=>{
      const {state}=await chrome.storage.local.get('state');
      const delivery=structuredClone(state.deliveries[0]);
      delivery.video.id=videoId;delivery.video.url='https://www.douyin.com/video/'+videoId;
      delivery.recipient.id=recipientId;delete delivery.recipient.uid;delivery.recipient.avatarKey='fixture';
      delivery.key=JSON.stringify([delivery.accountId,videoId,recipientId]);delivery.status='pending';delivery.error=null;
      delete delivery.attemptRoundId;state.deliveries.push(delivery);
      await chrome.storage.local.set({state});
    },{videoId,recipientId});
    const drain=async()=>{
      const reply=await options.evaluate(()=>chrome.runtime.sendMessage({type:'SEND_PENDING'}));
      assert.equal(reply.ok,true,JSON.stringify(reply));
      for(let index=0;index<200;index++){
        const status=(await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}))).data;
        assert.equal(status.state.paused,false,JSON.stringify(status.state.incident));
        if(!status.busy&&!status.state.enabled)return status.state;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      throw new Error('Work surface fixture did not finish');
    };
    // Restore/unmute the owned worker; continuing the same video must repair
    // its window without refreshing or replacing the document.
    await worker.evaluate(async({windowId,tabId})=>{
      await chrome.windows.update(windowId,{state:'normal'});
      await chrome.tabs.update(tabId,{muted:false});
    },{windowId:after.window.id,tabId:old.tabId});
    await queueFixture('739000000000000001','fixture-second');
    const reused=await drain();
    const reusedWindow=await worker.evaluate(id=>chrome.windows.get(id,{populate:true}),reused.workerWindowId);
    assert.equal(reusedWindow.id,after.window.id);assert.equal(reusedWindow.state,'maximized');
    assert.equal(reusedWindow.focused,false);assert.equal(reusedWindow.tabs[0].mutedInfo.muted,true);
    assert.equal(await worker.evaluate(async tabId=>(await chrome.scripting.executeScript({target:{tabId},func:()=>performance.timeOrigin}))[0].result,old.tabId),initialDocument);
    // Close only the isolated fixture work window, then require a fresh blank
    // window to be muted before navigating to an autoplay-capable video URL.
    await worker.evaluate(id=>chrome.windows.remove(id),reused.workerWindowId);
    await queueFixture('739000000000000002','fixture-third');
    const fresh=await drain();
    const freshWindow=await worker.evaluate(id=>chrome.windows.get(id,{populate:true}),fresh.workerWindowId);
    assert.notEqual(freshWindow.id,after.window.id);assert.equal(freshWindow.state,'maximized');
    assert.equal(freshWindow.focused,false);assert.equal(freshWindow.tabs[0].mutedInfo.muted,true);
    const events=await worker.evaluate(()=>fixtureSurfaceEvents);
    assert.equal(events.filter(event=>event.kind==='create'&&event.options.tabId!=null).every(event=>event.muted),true);
    assert.equal(events.filter(event=>event.kind==='create'&&event.options.tabId==null).every(event=>event.options.url==='about:blank'&&event.options.focused===false),true);
    assert.equal(events.filter(event=>event.kind==='navigate').every(event=>event.muted),true);
    assert.deepEqual(requests,noMailCase?[]:['/check','/check','/check']);
  }
  const report = 'PASS: real extension keeps settings selected; isolated worker is maximized, unfocused and muted. No real search, send or mail.' +(noMailCase?' Optional mail disabled: no token and zero mail-service requests.':' Fake health endpoint only.')+
    (refreshCase ? ' Missing share entry triggers exactly two real tab reloads; the third document prepares successfully.' : ' Restored/unmuted worker is repaired without reloading the same video; a closed worker is recreated blank and muted before navigation.');
  await writeFile(path.join(results, noMailCase?'optional-mail-smoke.txt':refreshCase?'send-refresh-v17-smoke.txt':'worker-surface-v23-smoke.txt'), report + '\n');
  console.log(report);
  }
} finally {
  await context?.close();
  await new Promise(resolve => bridge.close(resolve));
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== results || !path.basename(resolved).startsWith('worker-window-v9-temp-')) throw new Error('Unsafe cleanup path');
  await rm(resolved, { recursive: true, force: true });
}
