import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { defaultState } from '../extension/core.js';

const html = await readFile(new URL('../extension/options.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../extension/options.js', import.meta.url), 'utf8');
const result = () => ({ friends: [{ id: 'uid:7000000000000000991', uid: '7000000000000000991', name: '匿名好友' }],
  diagnostics: { revision: 'friends-v2', firstScreen: { controls: 4, recognized: 2, rejected: 2 },
    observed: 10, recognized: 8, unrecognized: 2, stop: 'bottom', rejectionCounts: { 'name-ambiguous': 2 },
    samples: [{ reason: 'name-ambiguous', shape: [{ tag: 'DIV', children: 3, nameCandidates: 2 }] }] } });
async function until(predicate) {
  for (let round = 0; round < 100; round++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Options UI did not settle');
}
const build = '0.2.3（浏览器声光告警）';
async function fixture({ saved, error, persistedError, workerBuild = build, clipboardError = false, manualSend = false, autoLoop = false, initialState = {},configOverrides = {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://extension-fixture.test/options.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.structuredClone = structuredClone;
  const state = { ...defaultState(), friendReadReport: saved, ...initialState };
  const config = { account: { id: '123', name: '测试账号' }, rules: [], mailBridgeToken: 'secret-must-not-be-copied',...configOverrides };
  const calls = [], copies = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { async writeText(text) {
    if (clipboardError) throw new Error('clipboard unavailable');
    copies.push(text);
  } } });
  let storageChanged;
  window.chrome = { storage: { onChanged: { addListener: fn => {storageChanged=fn;} } }, runtime: { async sendMessage({ type,...fields }) {
    calls.push(type);
    if (type === 'STATUS') return { ok: true, data: structuredClone({ state, config, busy: false, workerBuild }) };
    if(type==='SAVE'){Object.assign(config,structuredClone(fields.config));return {ok:true,data:{saved:true}};}
    if(type==='BROWSER_ALERT_TEST')return {ok:true,data:{played:true}};
    if(type==='AUTO_LOOP'&&autoLoop){state.enabled=true;state.runMode='auto-loop';return {ok:true,data:{started:true,autoLoop:true}};}
    if(type==='PAUSE'){state.enabled=false;state.resumePlan=null;return {ok:true,data:{}};}
    if (type === 'SEND_PENDING' && manualSend) {
      state.enabled = true; state.runMode = 'queue-only';
      return { ok: true, data: { started: true, queueOnly: true } };
    }
    if (type === 'FRIENDS' || type === 'DIAGNOSE') {
      if (error) {
        if (persistedError) state.friendReadReport = { at: Date.now(), seq: (saved?.seq || 0) + 1, build, kind: 'friends', error: persistedError };
        return { ok: false, error };
      }
      const value = result();
      state.friendReadReport = { at: Date.now(), seq: (saved?.seq || 0) + 1, build, total: value.friends.length, diagnostics: value.diagnostics };
      return { ok: true, data: type === 'FRIENDS' ? value : { report: [{ ok: true, text: '读取完成' }] } };
    }
    throw new Error('Unexpected UI action: ' + type);
  } } };
  window.eval(source);
  await until(() => window.document.getElementById('account-name').textContent === '测试账号');
  const $ = id => window.document.getElementById(id);
  return { window, $, state, calls, copies, storageChanged:(...args)=>storageChanged(...args), close: () => window.close() };
}

test('friend read shows first-screen counts next to its button and copies only diagnostic text', async () => {
  const f = await fixture();
  try {
    assert.ok(f.$('friend-diagnostic').previousElementSibling.contains(f.$('load-friends')));
    f.$('load-friends').click();
    await until(() => !f.$('load-friends').disabled);
    assert.equal(f.$('friend-first-observed').textContent, '4');
    assert.equal(f.$('friend-first-recognized').textContent, '2');
    assert.equal(f.$('friend-first-rejected').textContent, '2');
    assert.equal(f.$('friend-diagnostic').dataset.state, 'error');
    assert.match(f.$('friend-diagnostic-output').value, /昵称文本不唯一 2/u);
    f.$('copy-friend-diagnostic').click();
    await until(() => f.copies.length === 1 && !f.$('copy-friend-diagnostic').disabled);
    assert.match(f.copies[0], /首屏发现 4/u);
    assert.doesNotMatch(f.copies[0], /7000000000000000991|匿名好友|secret-must-not-be-copied/u);
    assert.deepEqual(f.calls.filter(call => call !== 'STATUS'), ['FRIENDS']);
  } finally { f.close(); }
});

test('a failed read stays visible despite a status refresh containing an older successful report', async () => {
  const f = await fixture({ saved: { at: Date.now() - 2000, total: 1, diagnostics: result().diagnostics }, error: '抖音要求安全验证' });
  try {
    f.$('load-friends').click();
    await until(() => !f.$('load-friends').disabled);
    await f.window.refresh();
    assert.match(f.$('friend-diagnostic-output').value, /读取失败：抖音要求安全验证/u);
    assert.equal(f.$('friend-diagnostic').dataset.state, 'error');
    assert.equal(f.$('friend-first-observed').textContent, '—');
  } finally { f.close(); }
});

test('a saved diagnostic is visible on opening the page and supports manual copy fallback', async () => {
  const f = await fixture({ saved: { at: Date.now() - 1000, total: 1, diagnostics: result().diagnostics }, clipboardError: true });
  try {
    assert.equal(f.$('friend-first-rejected').textContent, '2');
    f.$('copy-friend-diagnostic').click();
    await until(() => f.$('toast').textContent.includes('Ctrl+C'));
    const output = f.$('friend-diagnostic-output');
    assert.equal(output.selectionEnd - output.selectionStart, output.value.length);
    assert.deepEqual(f.calls.filter(call => call !== 'STATUS'), []);
  } finally { f.close(); }
});

test('the diagnose button shows the latest detailed report in the same prominent panel', async () => {
  const f = await fixture();
  try {
    f.$('diagnose').click();
    await until(() => !f.$('diagnose').disabled);
    assert.match(f.$('friend-diagnostic-output').value, /好友行脱敏结构/u);
    assert.equal(f.$('friend-first-observed').textContent, '4');
    assert.deepEqual(f.calls.filter(call => call !== 'STATUS'), ['DIAGNOSE']);
  } finally { f.close(); }
});

test('the visible manual send button sends cached results without issuing a scan or starting monitoring', async () => {
  const f = await fixture({ manualSend: true });
  try {
    assert.ok(f.$('send-pending').closest('.control'));
    assert.match(f.$('send-pending').textContent, /发送待发视频（不查询）/);
    f.$('send-pending').click();
    await until(() => f.$('status').textContent === '发送待发视频');
    assert.deepEqual(f.calls.filter(call => call !== 'STATUS'), ['SEND_PENDING']);
    assert.match(f.$('run-description').textContent, /不重新查询/);
    assert.equal(f.$('send-pending').disabled, true);
    f.state.enabled = false; f.state.runMode = null;
    await f.window.refresh();
    assert.equal(f.$('send-pending').disabled, false);
  } finally { f.close(); }
});

test('manual send is unavailable until normal monitoring has been paused', async () => {
  const f = await fixture();
  try {
    f.state.enabled = true;
    await f.window.refresh();
    assert.equal(f.$('send-pending').disabled, true);
    f.$('send-pending').click();
    assert.deepEqual(f.calls.filter(call => call !== 'STATUS'), []);
    f.state.enabled = false;
    await f.window.refresh();
    assert.equal(f.$('send-pending').disabled, false);
  } finally { f.close(); }
});

test('a higher report sequence replaces a local error even if its clock timestamp is older', async () => {
  const f = await fixture({ saved: { at: Date.now(), seq: 7, build, error: '旧报告' }, error: '本地请求失败' });
  try {
    f.$('load-friends').click();
    await until(() => !f.$('load-friends').disabled);
    assert.match(f.$('friend-diagnostic-output').value, /本地请求失败/);
    f.state.friendReadReport = { at: 1000, seq: 8, build, kind: 'run', phase: 'done', message: '本轮结束，确认发送 1 张卡片。' };
    await f.window.refresh();
    assert.match(f.$('friend-diagnostic-output').value, /确认发送 1 张卡片/);
    assert.doesNotMatch(f.$('friend-diagnostic-output').value, /本地请求失败/);
    f.state.friendReadReport = { at: Date.now() + 60000, seq: 7, error: '过时报告' };
    await f.window.refresh();
    assert.doesNotMatch(f.$('friend-diagnostic-output').value, /过时报告/);
  } finally { f.close(); }
});

test('UI shows persisted progress, terminal success and actual background build', async () => {
  const f = await fixture({ saved: { at: Date.now(), seq: 1, build, kind: 'run', phase: 'running', message: '正在发送待发视频。' } });
  try {
    assert.equal(f.$('runtime-version').textContent, '后台 ' + build);
    assert.equal(f.$('friend-diagnostic').dataset.state, 'loading');
    assert.match(f.$('friend-diagnostic-output').value, /状态：进行中/);
    f.state.friendReadReport = { at: Date.now(), seq: 2, build, kind: 'run', phase: 'done', message: '本轮结束，剩余 0 项待发。' };
    await f.window.refresh();
    assert.equal(f.$('friend-diagnostic').dataset.state, 'ready');
    assert.match(f.$('friend-diagnostic-output').value, /状态：已结束/);
    assert.match(f.$('friend-diagnostic-output').value, /报告版本：0.2.3（浏览器声光告警）/);
  } finally { f.close(); }
});

test('an old running background is called out separately from the report version', async () => {
  const f = await fixture({ workerBuild: '0.1.0（点击前重定位 12）', saved: { at: 1, build, seq: 1, message: '历史结果' } });
  try {
    assert.match(f.$('runtime-version').textContent, /点击前重定位 12.*请重新加载扩展/);
    assert.match(f.$('friend-diagnostic-output').value, /当前后台：0.1.0（点击前重定位 12）/);
  } finally { f.close(); }
});

test('a detailed persisted failure is not replaced by the short request error', async () => {
  const f = await fixture({ saved: { at: 1, seq: 3, error: '旧错误' }, error: '请求失败', persistedError: '分享检查失败\n完整诊断：UID 控件 0 个，视口 2040×974' });
  try {
    f.$('load-friends').click();
    await until(() => !f.$('load-friends').disabled);
    assert.match(f.$('friend-diagnostic-output').value, /完整诊断：UID 控件 0 个/);
    await f.window.refresh();
    assert.match(f.$('friend-diagnostic-output').value, /完整诊断：UID 控件 0 个/);
    assert.doesNotMatch(f.$('friend-diagnostic-output').value, /读取失败：请求失败/);
  } finally { f.close(); }
});


const sampleVideo={id:'739000000000000001',type:'video',publishedAt:1000,description:'本轮视频',tags:[]};
const sentRecord=(roundId,status='sent')=>({accountId:'123',status,attemptRoundId:roundId,video:sampleVideo,recipient:{name:'演示好友'}});
const sampleRound=(id,extra={})=>({id,kind:'monitor',source:'search',status:'done',startedAt:1000,foundCount:1,queriesDone:1,queriesTotal:1,videos:[sampleVideo],...extra});

test('sent card counter includes only confirmations attributable to the current round',async()=>{
 const f=await fixture({initialState:{round:sampleRound('now'),deliveries:[sentRecord('old'),sentRecord('now'),sentRecord('now','unknown'),sentRecord('now','pending')]}});
 try{
  assert.equal(f.$('sent-count').textContent,'1');
  assert.equal(f.$('pending-count').textContent,'1');
  assert.match(f.$('preview').textContent,/本轮已发送 1 张.*待核对 1 张.*此前已发送 1 张/);
  f.state.deliveries[2].status='sent';await f.window.refresh();
  assert.equal(f.$('sent-count').textContent,'2','manual confirmation of this round is reflected');
  f.state.round=sampleRound('next',{videos:[],foundCount:0});await f.window.refresh();
  assert.equal(f.$('sent-count').textContent,'0');
  assert.equal(f.state.deliveries.filter(d=>d.status==='sent').length,3);
 }finally{f.close();}
});

test('legacy history is not labeled current; an empty new scan visibly clears previous discoveries',async()=>{
 const f=await fixture({initialState:{preview:[sampleVideo],deliveries:[sentRecord(undefined)]}});
 try{
  assert.equal(f.$('sent-count').textContent,'0');
  assert.doesNotMatch(f.$('preview').textContent,/本轮视频/);
  f.state.round=sampleRound('new');await f.window.refresh();
  assert.match(f.$('preview').textContent,/本轮视频/);
  f.state.round=sampleRound('empty',{videos:[],foundCount:0});await f.window.refresh();
  assert.match(f.$('preview').textContent,/本轮未发现/);
  assert.doesNotMatch(f.$('preview').textContent,/本轮视频/);
 }finally{f.close();}
});

test('unavailable skips have a separate preview count and never inflate sent or pending totals',async()=>{
 const f=await fixture({initialState:{round:sampleRound('new'),deliveries:[
  {...sentRecord('new'),status:'skipped',skipReason:'video-unavailable'},sentRecord('new')
 ]}});
 try{
  assert.equal(f.$('sent-count').textContent,'1');assert.equal(f.$('pending-count').textContent,'0');
  assert.match(f.$('preview').textContent,/本轮已发送 1 张 · 待发 0 张 · 失效跳过 1 项/);
 }finally{f.close();}
});

test('storage updates repaint round progress without waiting for the fallback poll',async()=>{
 const f=await fixture();
 try{
  f.state.round=sampleRound('live',{status:'running',scanStatus:'running',queriesDone:1,queriesTotal:3});
  f.storageChanged({state:{}},'local');
  await until(()=>f.$('round-summary').textContent.includes('查询 1/3'));
  assert.match(f.$('preview').textContent,/本轮视频/);
  f.state.round.status='failed';f.state.round.scanStatus='incomplete';f.state.round.error='查询超时';
  f.storageChanged({state:{}},'local');
  await until(()=>f.$('round-summary').textContent.includes('查询未完成'));
  assert.match(f.$('round-summary').textContent,/查询超时/);
  assert.match(f.$('preview').textContent,/本轮视频/);
 }finally{f.close();}
});

test('a delayed older STATUS response cannot restore stale discoveries or counters',async()=>{
 const f=await fixture({initialState:{statusRevision:1,round:sampleRound('old')}});
 try{
  const previous={state:structuredClone(f.state),config:{account:{id:'123',name:'测试账号'},rules:[]},busy:false,workerBuild:build};
  let release;const held=new Promise(resolve=>{release=resolve;});let requests=0;
  const original=f.window.chrome.runtime.sendMessage;
  f.window.chrome.runtime.sendMessage=message=>message.type==='STATUS'&&++requests===1?held:original(message);
  const slow=f.window.refresh();
  f.state.statusRevision=2;f.state.round=sampleRound('fresh',{videos:[],foundCount:0});await f.window.refresh();
  release({ok:true,data:previous});await slow;
  assert.match(f.$('preview').textContent,/本轮未发现/);
  assert.match(f.$('round-summary').textContent,/发现 0 个视频/);
 }finally{f.close();}
});


test('segmented search displays drain and resume stages without resetting current-round sent counts',async()=>{
  const video={id:'1',type:'video',publishedAt:Date.now(),tags:[]};
  const f=await fixture({initialState:{enabled:true,round:{id:'round-segments',source:'search',status:'running',stage:'waiting-send',
    startedAt:Date.now(),foundCount:1,queriesDone:1,queriesTotal:3,videos:[video]},
    deliveries:[{accountId:'123',status:'sent',attemptRoundId:'round-segments',video,recipient:{name:'好友'}}]}});
  try {
    assert.match(f.$('round-summary').textContent,/查询 1\/3.*等待自动续发剩余队列/);
    assert.equal(f.$('sent-count').textContent,'1');
    f.state.round.stage='waiting-search';
    f.state.statusRevision=1;
    f.storageChanged({state:{newValue:f.state}},'local');
    await until(()=>f.$('round-summary').textContent.includes('队列已发完，将自动继续剩余查询'));
    assert.equal(f.$('sent-count').textContent,'1');
    assert.equal(f.$('incident').hidden,true);
  } finally {f.close();}
});

test('ended queue runs show the concrete stop reason in both summary and copied report',async()=>{
  const reason='达到本段任务时限（3 分 45 秒）';
  const f=await fixture({saved:{at:Date.now(),seq:1,kind:'run',phase:'done',build,
    message:`待发直发（不查询）本段已结束。停止原因：${reason}。剩余 179 项待发。`},
    initialState:{round:{id:'queue-round',source:'queue',status:'done',startedAt:Date.now(),
      foundCount:0,videos:[],stopReason:'time-budget',stopReasonText:reason}}});
  try {
    assert.match(f.$('round-summary').textContent,/结束原因：达到本段任务时限/);
    assert.match(f.$('friend-diagnostic-output').value,/停止原因：达到本段任务时限/);
    f.$('copy-friend-diagnostic').click();
    await until(()=>f.copies.length===1&&!f.$('copy-friend-diagnostic').disabled);
    assert.match(f.copies[0],/剩余 179 项待发/);
    assert.equal(f.$('incident').hidden,true,'normal segment completion must not be shown as a failure');
  } finally {f.close();}
});


test('visible automatic loop button starts AUTO_LOOP and leaves scan and queue-only actions alone',async()=>{
  const f=await fixture({autoLoop:true});
  try{
    f.$('auto-loop').click();
    await until(()=>f.calls.includes('AUTO_LOOP')&&f.$('status').textContent==='全自动循环');
    assert.deepEqual(f.calls.filter(type=>type!=='STATUS'),['AUTO_LOOP']);
    assert.match(f.$('run-description').textContent,/发完再抓取/);
    assert.equal(f.$('auto-loop').disabled,true);
    assert.equal(f.$('send-pending').disabled,true);
    assert.equal(f.$('pause').disabled,false);
  }finally{f.close();}
});

test('rate waits are visibly running with an automatic resume time and can be paused',async()=>{
  const f=await fixture({initialState:{enabled:true,runMode:'queue-only',
    resumePlan:{mode:'queue-only',roundId:'waiting',reason:'rate-limit',at:Date.now()+45000},
    round:{id:'waiting',source:'queue',status:'running',stage:'waiting-rate',startedAt:Date.now(),videos:[],foundCount:0}}});
  try{
    assert.equal(f.$('status').textContent,'等待限速');
    assert.match(f.$('run-description').textContent,/任务仍在运行.*自动继续/);
    assert.match(f.$('round-summary').textContent,/限速解除.*自动续发/);
    assert.equal(f.$('incident').hidden,true);
    assert.equal(f.$('send-pending').disabled,true);
    f.$('pause').click();
    await until(()=>f.$('status').textContent==='已暂停'&&!f.$('pause').disabled);
    assert.equal(f.state.resumePlan,null);
  }finally{f.close();}
});

test('optional mail switch keeps unsaved intent through polling and persists both enable and disable choices',async()=>{
  const f=await fixture({configOverrides:{mailAlertsEnabled:false}});
  try{
    assert.equal(f.$('mail-alerts-enabled').checked,false);assert.equal(f.$('mail-token').disabled,true);
    assert.equal(f.$('mail-test').disabled,true);assert.match(f.$('mail-status').textContent,/无需配置/);
    f.$('mail-alerts-enabled').click();await f.window.refresh();
    assert.equal(f.$('mail-alerts-enabled').checked,true);assert.equal(f.$('mail-token').disabled,false);
    assert.match(f.$('mail-status').textContent,/保存/);
    f.$('save').click();await until(()=>!f.$('save').disabled);
    assert.equal(f.calls.includes('SAVE'),true);assert.equal(f.$('mail-alerts-enabled').checked,true);
    assert.match(f.$('mail-status').textContent,/尚未检查/);
    f.$('mail-alerts-enabled').click();f.$('save').click();await until(()=>!f.$('save').disabled);
    await f.window.refresh(true);
    assert.equal(f.$('mail-alerts-enabled').checked,false);assert.equal(f.$('mail-health').disabled,true);
    assert.equal(f.calls.some(type=>['MAIL_TEST','MAIL_HEALTH'].includes(type)),false);
  }finally{f.close();}
});

test('disabled mail hides stale mail-retry guidance while keeping the real on-page incident visible',async()=>{
  const f=await fixture({configOverrides:{mailAlertsEnabled:false},initialState:{paused:true,incident:{reason:'需要核对发送',mailError:'邮件未能送达，服务恢复后重试'}}});
  try{
    assert.equal(f.$('incident').hidden,false);assert.match(f.$('incident-reason').textContent,/需要核对/);
    assert.match(f.$('mail-error').textContent,/已关闭/);assert.doesNotMatch(f.$('mail-error').textContent,/恢复后重试/);
    assert.equal(f.$('mail-alerts-enabled').checked,false);
  }finally{f.close();}
});

test('a real incident blinks a top-right-dot favicon and clears on recovery without replaying audio in each page',async()=>{
  const f=await fixture({configOverrides:{mailAlertsEnabled:false}});
  try {
    const original=f.window.setInterval;
    let blink;
    f.window.setInterval=(callback,ms)=>{if(ms===900)blink=callback;return original(callback,ms);};
    f.state.paused=true;f.state.incident={id:'ui-incident',reason:'需要处理'};
    await f.window.refresh();
    assert.match(f.window.document.title,/待处理/u);
    assert.ok(f.$('tab-icon').href.endsWith('icons/tab-alert.svg'));
    blink();assert.ok(f.$('tab-icon').href.endsWith('icons/tab.svg'));
    await f.window.refresh();assert.ok(f.$('tab-icon').href.endsWith('icons/tab.svg'),'polling must not restart the blink');
    f.state.paused=false;f.state.incident=null;await f.window.refresh();
    assert.doesNotMatch(f.window.document.title,/待处理/u);assert.ok(f.$('tab-icon').href.endsWith('icons/tab.svg'));
    assert.deepEqual(f.calls.filter(type=>type!=='STATUS'),[],'the UI never creates duplicate playback');
  } finally {f.close();}
});

test('manual pause does not set a favicon warning and a blocked sound keeps visible recovery guidance',async()=>{
  const f=await fixture({initialState:{paused:true}});
  try {
    assert.doesNotMatch(f.window.document.title,/待处理/u);
    f.state.incident={id:'blocked'};f.state.browserAlert={incidentId:'blocked',status:'blocked',error:'请点击试听提示音检查声音'};
    await f.window.refresh();assert.match(f.$('browser-alert-error').textContent,/试听/u);
    f.state.incident=null;await f.window.refresh();assert.equal(f.$('browser-alert-error').textContent,'');
  } finally {f.close();}
});

test('the explicit sound preview sends only a local preview request',async()=>{
  const f=await fixture();
  try {
    f.$('preview-alert').click();await until(()=>f.$('toast').textContent.includes('未发送视频或邮件'));
    assert.deepEqual(f.calls.filter(type=>type!=='STATUS'),['BROWSER_ALERT_TEST']);
    assert.equal(f.state.incident,null);
  } finally {f.close();}
});
