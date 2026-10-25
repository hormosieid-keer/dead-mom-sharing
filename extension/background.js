import { defaultState, validateConfig, collectVideos, matchRules, enqueue, nextDelivery, nextDeliveryAt,
  reserveDelivery, completeDelivery, failDelivery, abortDelivery, recoverState, resolveDelivery, makeKey,
  beginRound, updateRoundResults, finishRound, skipUnavailableVideo, UNAVAILABLE_REASONS } from './core.js';
import { browserTask } from './adapter.js';
import { Pointer } from './pointer.js';

const ALARM = 'douyin-minute';
const CONTINUE_ALARM = 'douyin-continue';
const MAIL = 'http://127.0.0.1:17321';
const BUILD = '0.2.0（自动续发与后台体验更新）';
const MAX_SEND_REFRESHES = 2;
const SEND_STOP_TEXT = {
  'queue-empty':'待发队列已处理完毕',
  'time-budget':'达到本段任务时限（3 分 45 秒）',
  'rate-limit':'达到发送限速，需要等待后再发送',
  'card-budget':'达到本段卡片数量上限',
  'manual-pause':'收到手动暂停指令',
  'segment-end':'本段任务已结束'
};
const initialConfig = () => ({schemaVersion:1,account:null,maxPages:3,mailBridgeToken:'',rules:[
  {id:crypto.randomUUID(),name:'司凤视频转发',tags:['司凤'],keywords:['司凤视频'],recipients:[]}
]});
let busy = false;
let commandEpoch = 0;
let serial = Promise.resolve();
const change = (fn) => {
  const job = serial.then(async () => {
    const data = await chrome.storage.local.get(['state','config']);
    data.state ||= defaultState(); data.config ||= initialConfig();
    const previousRevision = Number(data.state.statusRevision) || 0;
    const result = await fn(data);
    data.state.statusRevision = Math.max(previousRevision, Number(data.state.statusRevision) || 0) + 1;
    await chrome.storage.local.set(data);
    return result;
  });
  serial = job.catch(() => {});
  return job;
};
function log(state, level, message) {
  state.logs ||= [];
  state.logs.unshift({at:Date.now(),level,message:String(message).slice(0,600)});
  state.logs = state.logs.slice(0,200);
}
function setFriendReport(state, report) {
  const seq=Math.max(Number(state.friendReportSeq)||0,Number(state.friendReadReport?.seq)||0)+1;
  state.friendReportSeq=seq;
  state.friendReadReport={...report,phase:report.error?'error':report.phase||'done',at:Date.now(),seq,build:BUILD};
  return state.friendReadReport;
}
// The check interval is a user setting, so the alarm is (re)created from it
// instead of being fixed at one minute.
async function scheduleAlarm() {
  const {config} = await chrome.storage.local.get('config');
  const seconds = Number(config?.checkIntervalSeconds) || 60;
  const periodInMinutes = Math.max(0.5, Math.round((seconds / 60) * 1000) / 1000);
  const existing = await chrome.alarms.get(ALARM).catch(() => null);
  if (existing && existing.periodInMinutes === periodInMinutes) return periodInMinutes;
  try { await chrome.alarms.clear(ALARM); } catch {}
  await chrome.alarms.create(ALARM, { periodInMinutes });
  return periodInMinutes;
}
function activeResumePlan(state) {
  const plan=state?.resumePlan;
  return state?.enabled&&!state.paused&&plan&&Number.isFinite(plan.at)&&
    plan.mode===(state.runMode||'monitor')&&typeof plan.roundId==='string';
}
const ready = change(data => {
  const saved=data.state;
  const waiting=activeResumePlan(saved)&&saved.round?.status==='running'&&saved.round.id===saved.resumePlan.roundId&&
    !saved.deliveries.some(d=>['sending','unknown'].includes(d.status));
  const round=waiting?structuredClone(saved.round):null;
  data.state = recoverState(saved, Date.now());
  // A safe wait is a running job, not an interrupted send. Never turn a queue
  // job into monitoring when the MV3 worker sleeps or the browser reopens.
  if(round&&!data.state.paused)data.state.round=round;
  if(data.state.paused){
    data.state.resumePlan=null;
    if(['queue-only','auto-loop'].includes(data.state.runMode))data.state.enabled=false;
  }
  data.state.preview ||= [];
}).then(async () => {
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  await scheduleAlarm();
  const {state}=await chrome.storage.local.get('state');
  if(activeResumePlan(state))await chrome.alarms.create(CONTINUE_ALARM,{when:Math.max(Date.now()+500,state.resumePlan.at)});
});

async function execute(tabId, action, args = {}) {
  const [entry] = await chrome.scripting.executeScript({
    target:{tabId}, world:['probe','search'].includes(action)?'MAIN':'ISOLATED',
    func:browserTask,args:[{action,...args,captureErrors:true}]
  });
  const {result}=entry||{};
  if(entry?.error) throw new Error(String(entry.error.message||entry.error));
  if (!result || result.error) {
    const error = new Error(result?.error || '页面没有返回可确认的结果，请检查登录或验证码。');
    if (typeof result?.code === 'string') error.code = result.code;
    error.retryable=result?.retryable===true;
    if(result?.details&&typeof result.details==='object') error.details=result.details;
    throw error;
  }
  return result;
}
const delay = ms => new Promise(r => setTimeout(r,ms));
async function readFriendPanel(tabId) {
  try {
  const result = await execute(tabId, 'friends', { diagnostics: true });
  const friends = Array.isArray(result) ? result : result.friends;
  if (!Array.isArray(friends)) throw new Error('好友读取结果无效，请重新加载扩展后重试。');
  const info = result.diagnostics;
  await change(({state})=>setFriendReport(state,{kind:'friends',total:friends.length,diagnostics:info||null}));
  if (info) {
    const first = info.firstScreen || {};
    const stops = { bottom: '已到列表底部', 'single-screen': '未发现滚动区', 'scan-limit': '达到扫描上限', 'scroll-box-lost': '滚动区中途消失' };
    const reasons = { 'invalid-uid': 'UID 格式无效', 'name-missing': '未找到昵称', 'name-ambiguous': '昵称文本不唯一' };
    const detail = Object.entries(info.rejectionCounts || {}).map(([reason, count]) => `${reasons[reason] || reason} ${count}`).join('、');
    await change(({ state }) => {
      log(state, info.unrecognized || ['scan-limit', 'scroll-box-lost'].includes(info.stop) ? 'error' : 'info',
        `好友读取诊断 ${info.revision}：首屏发现 ${first.controls || 0} 个 UID，识别 ${first.recognized || 0}，跳过 ${first.rejected || 0}；累计发现 ${info.observed}，识别 ${info.recognized}，未识别 ${info.unrecognized}；${stops[info.stop] || info.stop}${detail ? '；' + detail : ''}。`);
      if (info.samples?.length) log(state, 'info', '好友行脱敏结构：' + JSON.stringify(info.samples));
    });
  }
  return result;
  } catch(error) {
    await change(({state})=>setFriendReport(state,{kind:'friends',error:String(error?.message||error).slice(0,1000)}));
    throw error;
  }
}
// The live share popover only follows real hover state, so it is opened and
// clicked through the browser's own input pipeline. The injected script can
// only read what that pointer made visible.
let pointer = null;
async function pointerFor(tabId) {
  if (pointer?.tabId === tabId && pointer.connected) return pointer;
  if (pointer) await pointer.close();
  const next = new Pointer(tabId);
  await next.connect();
  pointer = next;
  return next;
}
async function releasePointer() {
  if (!pointer) return;
  const current = pointer; pointer = null;
  await current.close();
}
async function shareSnapshot(tabId, point, revision) {
  const info = await execute(tabId, 'shareDebug', point ? { point } : {});
  let browser = {};
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId, { populate: true });
    browser = { tabActive: tab.active, windowFocused: win.focused, windowState: win.state,
      tabsInWindow: win.tabs?.length, ownWindow: win.tabs?.length === 1 && win.tabs[0].id === tabId };
  } catch { browser.unavailable = true; }
  // Rebuild the object: Chrome may reorder returned keys. Never truncate away
  // the visibility facts, and omit URLs, class names and friend identities.
  return JSON.stringify({ revision, visibility: info.visibility, viewport: info.viewport,
    focused: info.focused, browser, dpr: info.dpr, scrollY: info.scrollY,
    point: info.point, hit: info.hit ? { tag: info.hit.tag, e2e: info.hit.e2e } : null,
    panel: info.panel, rows: info.rows, userids: info.userids,
    popover: info.popover, arrow: info.arrow, icon: info.icon });
}
async function openPanel(tabId, { reopen = false, videoId } = {}) {
  let trusted = true;
  try { await pointerFor(tabId); } catch { trusted = false; }
  const terminal = error => /安全验证|验证码|HTTP 429|操作频繁|账号不一致/u.test(String(error.message)) ||
    (/_AMBIGUOUS$/u.test(error.code || '') || error.code==='VIDEO_UNAVAILABLE');
  const ask = async () => {
    try { return { ok: true, value: await execute(tabId, 'openShare', trusted ? { pointer: true, videoId, ...(reopen ? { reopen: true } : {}) } : {videoId}) }; }
    catch (error) { return { ok: false, error }; }
  };
  let attempt = await ask();
  // Wait for background rendering without ever activating the user's window.
  for (let round = 0; round < 2 && !attempt.ok && !terminal(attempt.error); round++) {
    await delay(900);
    attempt = await ask();
  }
  if (!attempt.ok) throw attempt.error;
  const first = attempt.value;
  if (first?.opened) return trusted;
  if (!first?.needsPointer) throw Object.assign(new Error('未能展开原生分享面板，请确认该视频页面可以正常分享。'),{code:'SHARE_PANEL_UNAVAILABLE'});
  if (!trusted) throw new Error('分享面板由真实鼠标悬停控制，需要扩展的调试权限；请在扩展管理页重新加载扩展后重试。');
  const pollPanel = async (rounds) => {
    for (let i = 0; i < rounds; i++) {
      await delay(250);
      try { const next = await execute(tabId, 'openShare', { pointer: true, videoId }); if (next?.opened) return true; }
      catch (error) { if (terminal(error)) throw error; }
    }
    return false;
  };
  // Try hover first: the working tab lives in its own unfocused window, so the
  // page stays visible without pulling the browser in front of the user.
  await pointer.hover(first.x, first.y, { leaveFirst: true });
  if (await pollPanel(8)) return true;
  // Leave the icon before entering again; do not activate the window.
  await delay(300);
  await pointer.hover(first.x, first.y, { leaveFirst: true });
  if (await pollPanel(8)) return true;
  // Some page versions toggle the popover on click instead of hover.
  await pointer.click(first.x, first.y);
  if (await pollPanel(8)) return true;
  let snapshot = '';
  try {
    snapshot = await shareSnapshot(tabId, { x: first.x, y: first.y }, 'share-hover-v7');
  } catch { /* diagnostics never block the pause */ }
  await change(({ state }) => {
    setFriendReport(state,{kind:'share-panel',error:'后台分享面板展开失败（share-hover-v7）；尚未点击好友发送。\n'+(snapshot||'未取得页面诊断。')});
    if (snapshot) log(state, 'error', '悬停诊断：' + snapshot);
  });
  throw Object.assign(new Error('后台未能展开原生分享面板，已停止本次操作；请在“好友读取诊断”框点击“复制诊断结果”反馈。'),{code:'SHARE_PANEL_UNAVAILABLE'});
}
async function loaded(tabId) {
  const end = Date.now()+35000;
  while (Date.now()<end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      if (!tab.url?.startsWith('https://www.douyin.com/')) throw new Error('页面离开了抖音，已停止操作。');
      await delay(1200); return tab;
    }
    await delay(350);
  }
  throw new Error('抖音页面加载超时，请检查网络。');
}
async function taskTab(url, { reuseVideo = false } = {}) {
  const {state} = await chrome.storage.local.get('state');
  let tab;
  if (state.workerTabId) {
    try { tab = await chrome.tabs.get(state.workerTabId); } catch {}
    if(!tab?.url?.startsWith('https://www.douyin.com/')) tab=null;
  }
  if (tab) {
    // Browser-level tab muting survives navigation and reloads. Do this before
    // moving an old worker or opening a new video so audio cannot leak first.
    await muteWorkTab(tab.id);
    let sameVideo = false;
    try {
      const target = url.match(/^https:\/\/www\.douyin\.com\/video\/(\d+)$/u);
      const actual = new URL(tab.url);
      sameVideo = reuseVideo && target && actual.origin === 'https://www.douyin.com' &&
        actual.pathname.replace(/\/$/u,'') === '/video/' + target[1] &&
        (!actual.searchParams.has('modal_id') || actual.searchParams.get('modal_id') === target[1]) &&
        tab.status === 'complete' && !tab.discarded && !tab.frozen;
    } catch { /* Navigate normally if the existing document cannot be verified. */ }
    let moved = false;
    let work;
    try { work = await chrome.windows.get(tab.windowId, { populate: true }); } catch {}
    const onlyTab = work?.tabs?.length === 1 && work.tabs[0].id === tab.id && work.tabs[0].active === true;
    // Legacy workers and a settings tab opened in the work window can hide
    // Douyin. Isolate the existing tab instead of activating it in that window.
    if (work?.id !== state.workerWindowId || !onlyTab || work.state === 'minimized') {
      await releasePointer();
      const created = await createWorkWindow({ tabId: tab.id });
      tab = created.tabs.find(item => item.id === tab.id);
      await change(({state}) => {state.workerWindowId=created.id;log(state,'info','已将抖音工作标签移入独立后台窗口，无需切离设置页。');});
      moved = true;
    } else if(work.state !== 'maximized') {
      await releasePointer();
      await maximizeWorkWindow(work.id);
      moved = true; // Wait for the resized layout before reusing this document.
    }
    if (sameVideo) {
      if (moved) await loaded(tab.id);
      return tab.id;
    }
    // A debugger session must not survive an actual page navigation. Reusing
    // the same video for another recipient keeps both the document and pointer.
    await releasePointer();
    await chrome.tabs.update(tab.id,{url});
  } else {
    // A dedicated, unfocused window keeps the working tab visible for rendering
    // without ever pulling the browser in front of whatever the user is doing.
    await releasePointer();
    // Start blank: never load an autoplaying page before tab muting succeeds.
    const created = await createWorkWindow();
    tab = created.tabs[0];
    await change(({state}) => { state.workerWindowId = created.id;state.workerTabId=tab.id; });
    await muteWorkTab(tab.id);
    await chrome.tabs.update(tab.id,{url});
  }
  await change(({state}) => {state.workerTabId = tab.id;});
  await loaded(tab.id); return tab.id;
}
async function muteWorkTab(tabId) {
  try {
    const tab=await chrome.tabs.update(tabId,{muted:true});
    if(tab?.mutedInfo?.muted===true)return;
  } catch { /* Stop before page work if the browser cannot confirm muting. */ }
  throw new Error('无法将抖音工作标签页静音，已停止且尚未发送；请检查浏览器后重试。');
}
async function maximizeWorkWindow(windowId) {
  try {
    // Chrome rejects focused:false combined with state:maximized. Omitting
    // focus preserves the unfocused state established at window creation.
    const win=await chrome.windows.update(windowId,{state:'maximized'});
    if(win?.state==='maximized')return;
  } catch { /* Never fall back to focusing the user's browser. */ }
  throw new Error('无法在后台最大化抖音工作窗口，已停止且尚未发送；请检查浏览器后重试。');
}
async function createWorkWindow(options = {}) {
  let created;
  try { created = await chrome.windows.create({ ...(options.tabId != null?{tabId:options.tabId}:{url:'about:blank'}), focused:false, type:'normal' }); } catch {}
  if (!Number.isInteger(created?.id) || created.tabs?.length !== 1 || created.tabs[0].active !== true ||
      (options.tabId != null && created.tabs[0].id !== options.tabId)) {
    throw new Error('无法创建独立的抖音工作窗口，已停止且尚未发送；请检查浏览器后重试。');
  }
  if(created.state!=='maximized')await maximizeWorkWindow(created.id);
  return created;
}
// A video can be open as /video/<id> or as a modal on the recommend feed, so
// the tab is chosen by shape instead of one exact path. The bot's own worker tab
// is the last resort so a user-opened video always wins.
function pickDouyinTab(tabs, workerTabId) {
  const scored = tabs.map((tab) => {
    const url = String(tab.url || '');
    let value = url.startsWith('https://www.douyin.com/') ? 1 : 0;
    if (/[?&]modal_id=\d+/u.test(url)) value += 3;
    if (/\/video\/\d+/u.test(url)) value += 5;
    if (tab.active) value += 1;
    if (workerTabId && tab.id === workerTabId) value -= 10;
    return { tab, url, value };
  }).filter((item) => item.url.startsWith('https://www.douyin.com/')).sort((a, b) => b.value - a.value);
  return scored[0] || null;
}
async function assertAccount(tabId, config) {
  const account = await execute(tabId,'probe');
  if (String(account.id)!==String(config.account?.id)) throw new Error('当前登录账号与绑定的 bot 账号不一致，请重新登录绑定账号。');
  return account;
}
async function mailHealth() {
  const {config}=await chrome.storage.local.get('config');
  let response;
  try {
    response = await fetch(`${MAIL}/check`,{headers:{Authorization:`Bearer ${config?.mailBridgeToken||''}`},signal:AbortSignal.timeout(5000)});
  } catch {
    throw new Error('无法连接本地邮件服务（127.0.0.1:17321）。请先启动配套邮件服务，再点击“检查邮件服务”。');
  }
  if (response.status===401) throw new Error('邮件服务连接令牌不匹配，请检查插件中填写的连接令牌。');
  if (!response.ok) throw new Error(`邮件服务检查失败（HTTP ${response.status}），请检查本地邮件服务。`);
  const result = await response.json();
  if (!result.configured) throw new Error('请先配置并启动邮件服务，才能启用自动转发。');
  return result;
}
async function reportIncident() {
  const {state,config} = await chrome.storage.local.get(['state','config']);
  const incident = state?.incident;
  if (!incident || incident.notified || !config?.mailBridgeToken) return;
  const incidentId = incident.id || incident.incidentId;
  if (!incidentId) return;
  try {
    const response = await fetch(`${MAIL}/alert`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.mailBridgeToken}`},
      body:JSON.stringify({incidentId,reason:String(incident.reason || '任务异常，等待人工核对。').slice(0,2000),at:new Date(incident.at || Date.now()).toISOString(),accountName:String(config.account?.name || 'bot').slice(0,200)}),
      signal:AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`邮件服务返回 ${response.status}`);
    await change(({state})=>{if (state.incident?.id===incidentId) {state.incident.notified=true;state.incident.mailError=null;}});
  } catch {
    await change(({state})=>{if(state.incident?.id===incidentId) state.incident.mailError='邮件未能送达；已暂停，服务恢复后每分钟重试。';});
  }
}
async function pauseError(reason) {
  await change(({state})=>{
    state.paused=true;
    state.incident ||= {id:crypto.randomUUID(),reason:String(reason).slice(0,600),at:Date.now(),notified:false};
    log(state,'error',reason);
  });
  await reportIncident();
}
async function allowed() {
  const {state} = await chrome.storage.local.get('state');
  return state.enabled && !state.paused;
}
function searchSignature(config) {
  return JSON.stringify({accountId:config.account?.id,rules:config.rules,
    maxPages:config.maxPages||3,windowMinutes:config.videoWindowMinutes||60});
}
function validCheckpoint(value,signature,queries) {
  return value?.version===1&&value.signature===signature&&
    JSON.stringify(value.queries)===JSON.stringify(queries)&&Number.isInteger(value.nextIndex)&&
    value.nextIndex>=0&&value.nextIndex<=queries.length&&['query','drain'].includes(value.phase)&&
    Array.isArray(value.videos)&&value.videos.every(v=>typeof v?.id==='string'&&Array.isArray(v.tags)&&Number.isFinite(v.publishedAt));
}
async function cycle(dryRun = false, { queueOnly = false } = {}) {
  await ready;
  if (busy) {if(dryRun) throw new Error('任务执行中，请等待当前任务结束。'); return;}
  busy=true;
  const heartbeat=setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  let sendingKey=null;
  let attemptedClick=false;
  let currentTabId=null;
  let sends=0, reportStarted=false, runFailed=false, scanCount=null;
  let runStartSeq=0;
  let roundId=null, failureMessage=null, sendStopReason=null, end=0, mode='monitor';
  const epoch=commandEpoch;
  try {
    const {config,state} = await chrome.storage.local.get(['config','state']);
    queueOnly ||= state.runMode === 'queue-only';
    mode=queueOnly?'queue-only':state.runMode==='auto-loop'?'auto-loop':'monitor';
    if (!dryRun && (!state.enabled || state.paused)) {await reportIncident();return;}
    if(!dryRun&&activeResumePlan(state)&&state.resumePlan.at>Date.now())return;
    const autoLoop=mode==='auto-loop';
    const queries = [...new Set((config.rules||[]).filter(r=>r.enabled!==false).flatMap(r=>[...(r.tags||[]).map(t=>typeof t==='string'?t:t.name),...(r.keywords||[])]).filter(Boolean))];
    const checkpointField=dryRun?'scanCheckpoint':'searchCheckpoint';
    const signature=searchSignature(config);
    let checkpoint=state[checkpointField];
    if(!validCheckpoint(checkpoint,signature,queries)) checkpoint=null;
    const pending=state.deliveries.some(d=>d.status==='pending');
    const draining=!dryRun&&checkpoint&&pending;
    const visible=checkpoint?.videos.filter(v=>matchRules(v,config.rules).length&&
      v.publishedAt>=Date.now()-(Number(config.videoWindowMinutes)||60)*60000&&v.publishedAt<=Date.now())||[];
    const resumeVideoId = !dryRun && (!autoLoop||checkpoint) && typeof state.activeVideoId === 'string' &&
      state.deliveries.some(d=>d.status==='pending'&&d.video.id===state.activeVideoId) ? state.activeVideoId : null;
    await change(({state})=>{
      state.scanWarning=!queueOnly&&checkpoint?(checkpoint.truncated?'已达到本轮分页上限，结果可能不完整。':
        checkpoint.nextIndex<queries.length?'查询已分段：先发送已发现的视频，发完后自动继续剩余查询。':''):'';
      const reuse=state.round?.status==='running'&&((!queueOnly&&checkpoint?.roundId===state.round.id)||
        (!dryRun&&activeResumePlan(state)&&state.resumePlan.roundId===state.round.id));
      state.resumePlan=null;
      roundId=reuse?state.round.id:beginRound(state,{kind:dryRun?'scan':mode,
        source:queueOnly?'queue':checkpoint?'search':resumeVideoId?'resume':'search',
        queriesTotal:!queueOnly&&(checkpoint||!resumeVideoId)?queries.length:0,
        videos:!queueOnly&&checkpoint?visible:queueOnly||resumeVideoId?state.deliveries.filter(d=>d.status==='pending'&&d.accountId===config.account?.id).map(d=>d.video):[]});
      if(!queueOnly&&checkpoint) {
        checkpoint.roundId=roundId;
        checkpoint.phase=draining?'drain':'query';
        state[checkpointField]=checkpoint;
        updateRoundResults(state,roundId,visible,
          {queriesDone:checkpoint.nextIndex,queriesTotal:queries.length,done:checkpoint.nextIndex===queries.length});
        if(checkpoint.completedAt)state.lastScanAt=Math.max(Number(state.lastScanAt)||0,checkpoint.completedAt);
      }
    });
    runStartSeq=await change(({state})=>setFriendReport(state,{kind:dryRun?'scan':'run',phase:'running',message:dryRun?'正在试检索，不发送视频。':queueOnly?'正在发送待发视频，不重新查询。':draining?'先发送已发现的队列，发完后继续剩余查询。':'正在查询或转发视频。'}).seq);
    reportStarted=true;
    validateConfig(config,{ready:!dryRun});
    if (!config.account) throw new Error('请先识别并绑定 bot 账号。');
    end = Date.now()+225000;
    if (resumeVideoId) await change(({state})=>log(state,'info','继续当前视频的剩余好友，跳过重新查询。'));
    if (!queueOnly && !draining && (checkpoint || !resumeVideoId)) {
      checkpoint ||= {version:1,signature,queries,nextIndex:0,phase:'query',videos:[],truncated:false,roundId};
      checkpoint.roundId=roundId;
      await change(({state})=>{state[checkpointField]=checkpoint;state.round.stage='searching';});
      let videos=[...checkpoint.videos], truncated=checkpoint.truncated;
      const publishSearch=async(done,queriesDone)=>{
        const byId=new Map();
        for(const video of videos){
          const previous=byId.get(video.id);
          byId.set(video.id,previous?{...video,tags:[...new Map([...previous.tags,...video.tags].map(t=>[t.id,t])).values()]}:video);
        }
        const all=[...byId.values()],matched=all.filter(v=>matchRules(v,config.rules).length);
        const now=Date.now(),windowMs=(Number(config.videoWindowMinutes)||60)*60000;
        const found=matched.filter(v=>v.publishedAt>=now-windowMs&&v.publishedAt<=now);
        checkpoint={...checkpoint,videos:all,nextIndex:queriesDone,truncated,
          ...(queriesDone===queries.length?{completedAt:checkpoint.completedAt||now}:{})};
        await change(({state})=>{
          if(epoch!==commandEpoch||!updateRoundResults(state,roundId,found,{queriesDone,queriesTotal:queries.length,done})) return;
          state[checkpointField]=checkpoint;
          state.preview=found.slice(0,100);
          state.scanWarning=truncated?'已达到本轮分页上限，结果可能不完整。':'';
          // Persist each completed query and its queue before moving forward.
          // Budget yields are scheduling events, never delivery incidents.
          if(!dryRun&&state.enabled&&!state.paused) enqueue(state,found,config,now);
          if(checkpoint.completedAt)state.lastScanAt=Math.max(Number(state.lastScanAt)||0,checkpoint.completedAt);
          if(done){
            log(state,'info',`${dryRun?'试检索':'本轮检索'}读取 ${all.length} 条视频，符合规则 ${matched.length} 条，窗口 ${Math.round(windowMs/60000)} 分钟内 ${found.length} 条${truncated?'（分页达到上限）':''}。`);
          }
        });
        return found;
      };
      for (let index=checkpoint.nextIndex;index<queries.length;index++) {
        if(epoch!==commandEpoch) return {cancelled:true,count:scanCount||0};
        if (!dryRun && !await allowed()) return;
        if (Date.now()>end-45000) break;
        const query=queries[index];
        const tabId = await taskTab(`https://www.douyin.com/search/${encodeURIComponent(query)}?type=video`);
        currentTabId=tabId;
        await assertAccount(tabId,config);
        const found = await execute(tabId,'search',{query,maxPages:config.maxPages||3,windowMinutes:config.videoWindowMinutes||60});
        if(epoch!==commandEpoch) return {cancelled:true,count:scanCount||0};
        for(const payload of found.payloads||[]) videos.push(...collectVideos(payload));
        truncated ||= !!found.truncated;
        scanCount=(await publishSearch(false,index+1)).length;
      }
      const complete=checkpoint.nextIndex===queries.length;
      checkpoint.phase=dryRun?'query':'drain';
      videos=await publishSearch(complete,checkpoint.nextIndex);
      if(!complete) await change(({state})=>{
        log(state,'info',`本段查询预算已用完，进度 ${checkpoint.nextIndex}/${queries.length}；${dryRun?'保留结果，下次试检索接着查询，不发送。':'先发送已发现的视频，队列发完后自动接着查询。'}`);
        state.scanWarning=dryRun?'本段试检索已结束，进度已保存；再次点击试检索继续，不会发送。':'查询已分段：先发送已发现的视频，发完后自动继续剩余查询。';
        if(dryRun) state.round.scanStatus='incomplete';
      });
      if(dryRun) {
        if(complete) await change(({state})=>{state.scanCheckpoint=null;});
        scanCount=videos.length;return {count:videos.length,truncated,partial:!complete,queriesDone:checkpoint.nextIndex,queriesTotal:queries.length};
      }
    }
    if(!dryRun) await change(({state})=>{if(state.round?.id===roundId)state.round.stage='sending';});
    let activeVideoId=resumeVideoId;
    while(Date.now()<end && await allowed()) {
      let delivery;
      await change(({state})=>{
        delivery=nextDelivery(state,Date.now(),config,activeVideoId);
        if(!delivery)sendStopReason=state.deliveries.some(d=>d.status==='pending')?'rate-limit':'queue-empty';
      });
      if(!delivery) break;
      // Apply the card-count budget between videos rather than splitting one
      // video's recipients. The existing time budget and rate limit still hold.
      if(sends>=50 && delivery.video.id!==activeVideoId) {sendStopReason='card-budget';break;}
      if(String(delivery.accountId)!==String(config.account.id)) throw new Error('队列包含其他账号的待发送记录，请核对备份与账号。');
      const tabId = await taskTab(delivery.video.url,{reuseVideo:true});
      currentTabId=tabId;
      if (activeVideoId !== delivery.video.id) await change(({state})=>{
        state.activeVideoId=delivery.video.id;
        const recipients=state.deliveries.filter(d=>d.status==='pending'&&d.video.id===delivery.video.id).length;
        log(state,'info',`视频 ${delivery.video.id}：同页连续发送给 ${recipients} 位待发好友，不逐人刷新页面。`);
      });
      activeVideoId=delivery.video.id;
      const stopIfPaused=async()=>{
        if(await allowed()) return false;
        if(sendingKey) await change(({state})=>abortDelivery(state,delivery.key,'已暂停，发送尚未执行',Date.now()));
        sendingKey=null;return true;
      };
      let result, deliverySkipped=false;
      for(let pageAttempt=0;pageAttempt<=MAX_SEND_REFRESHES;pageAttempt++) {
        try {
          if(await stopIfPaused()) return;
          if(pageAttempt>0) {
            await releasePointer();
            if(await stopIfPaused()) return;
            await chrome.tabs.reload(tabId);
            if(await stopIfPaused()) return;
            try { await loaded(tabId); }
            catch(error) {
              if(error.message==='抖音页面加载超时，请检查网络。') error.code='SHARE_RELOAD_TIMEOUT';
              throw error;
            }
            if(await stopIfPaused()) return;
          }
          await assertAccount(tabId,config);
          await execute(tabId,'videoStatus',{videoId:delivery.video.id});
          const trusted = await openPanel(tabId,{videoId:delivery.video.id});
          if(await stopIfPaused()) return;
          if(!sendingKey) await change(({state})=>{
            if(!state.enabled || state.paused) return;
            reserveDelivery(state,delivery.key,Date.now(),config,activeVideoId); sendingKey=delivery.key;
          });
          if(!sendingKey) return;
          if(!trusted) {
            // Classify missing UI before entering the conservative script-send
            // boundary, which must remain unknown on any subsequent failure.
            const target=await execute(tabId,'share',{recipient:delivery.recipient,videoId:delivery.video.id,mode:'probe'});
            if(target?.sent&&target.alreadySent) result=target;
          }
          if (trusted) {
            let emptyRecoveryUsed=false;
            for (let positioning=0;positioning<3;positioning++) {
              let target;
              for (let preparation=0;preparation<2;preparation++) {
                try {
                  target=await execute(tabId,'share',{recipient:delivery.recipient,videoId:delivery.video.id,mode:'probe'});
                  break;
                } catch(error) {
                  if(error.code!=='SHARE_PANEL_EMPTY'||emptyRecoveryUsed) throw error;
                  emptyRecoveryUsed=true;
                  await change(({state})=>log(state,'info','发送前未读到好友行，重新展开分享面板后再检查一次；尚未点击发送。'));
                  if(!await allowed()) {
                    await change(({state})=>abortDelivery(state,delivery.key,'已暂停，发送尚未执行',Date.now()));
                    sendingKey=null;return;
                  }
                  await releasePointer();
                  if(!await openPanel(tabId,{reopen:true,videoId:delivery.video.id})) throw new Error('重新展开分享面板后无法建立可信指针；尚未点击发送');
                }
              }
              if(!await allowed()) {
                await change(({state})=>abortDelivery(state,delivery.key,'已暂停，发送尚未执行',Date.now()));
                sendingKey=null;return;
              }
              if(target?.sent&&target.alreadySent) {result=target;break;}
              if(!target?.prepared) break;
              let receiptToken;
              try {
                await pointer.click(target.x,target.y,{beforePress:async()=>{
                  if(!await allowed()) throw new Error('已暂停，尚未点击发送');
                  const armed=await execute(tabId,'share',{recipient:delivery.recipient,videoId:delivery.video.id,mode:'arm',point:{x:target.x,y:target.y}});
                  if(armed?.armed!==true||typeof armed.receiptToken!=='string') throw new Error('未建立发送回执监听，尚未点击发送；请重新加载扩展后重试');
                  receiptToken=armed.receiptToken;
                  if(!await allowed()) throw new Error('已暂停，尚未点击发送');
                  attemptedClick=true;
                }});
              } catch(error) {
                // This recovery is strictly before the first submitting input. A
                // lost press/release acknowledgement must NEVER enter this branch.
                if(attemptedClick||error.code!=='SHARE_TARGET_CHANGED'||!error.retryable) throw error;
                if(!await allowed()) {
                  await change(({state})=>abortDelivery(state,delivery.key,'已暂停，发送尚未执行',Date.now()));
                  sendingKey=null;return;
                }
                if(positioning===2) {
                  error.message='重新定位两次后分享控件仍有变化，尚未点击发送。';
                  throw error;
                }
                await change(({state})=>log(state,'info',`点击前落点变化，重新展开并定位同一好友（${positioning+1}/2）；尚未点击发送。`));
                if(!await openPanel(tabId,{reopen:true,videoId:delivery.video.id})) throw new Error('重新定位时无法建立可信指针，尚未点击发送');
                await delay(250);
                continue;
              }
              result=await execute(tabId,'share',{recipient:delivery.recipient,videoId:delivery.video.id,mode:'confirm',receiptToken});
              break;
            }
          }
          if (!result) {
            attemptedClick=true;
            result = await execute(tabId,'share',{recipient:delivery.recipient,videoId:delivery.video.id});
          }
          if(result.sent!==true) throw new Error('未能确认视频卡片发送成功，请人工核对。');
          break;
        } catch(error) {
          // Each delivery has at most three page attempts. Reservations and
          // already confirmed recipients survive reloads; a possible send never
          // retries. Finish this bounded group even near the cycle time limit.
          const blocked=/安全验证|验证码|HTTP 429|操作频繁|账号不一致/u.test(String(error.message));
          const refreshable=!blocked&&(['SHARE_ENTRY_MISSING','SHARE_PANEL_UNAVAILABLE','SHARE_PANEL_EMPTY',
            'SHARE_RECIPIENT_MISSING','SHARE_CONTROL_MISSING','SHARE_RELOAD_TIMEOUT'].includes(error.code)||
            (error.code==='SHARE_TARGET_CHANGED'&&error.retryable===true));
          if(attemptedClick) throw error;
          // A late-rendered unavailable page can replace the share UI. Recheck
          // only before any possible submit; generic failures never mean deleted.
          if(refreshable) {
            if(await stopIfPaused()) return;
            try { await execute(tabId,'videoStatus',{videoId:delivery.video.id}); }
            catch(statusError) { if(statusError.code!=='VIDEO_UNAVAILABLE') throw statusError; error=statusError; }
          }
          if(error.code==='VIDEO_UNAVAILABLE' && error.details?.evidence==='visible-error' &&
              error.details.videoId===delivery.video.id && Object.hasOwn(UNAVAILABLE_REASONS,error.details.reason)) {
            if(await stopIfPaused()) return;
            await change(({state})=>{
              if(epoch!==commandEpoch||!state.enabled||state.paused) return;
              if(sendingKey) abortDelivery(state,sendingKey,'视频失效，尚未点击发送',Date.now());
              const skipped=skipUnavailableVideo(state,config.account.id,delivery.video.id,error.details.reason);
              state.activeVideoId=null;
              setFriendReport(state,{kind:'run',phase:'running',message:`已跳过失效视频：${UNAVAILABLE_REASONS[error.details.reason]}；跳过 ${skipped} 项待发，继续后续队列。`,skipped});
              deliverySkipped=true;
            });
            if(!deliverySkipped) {if(await stopIfPaused()) return;throw error;}
            sendingKey=null;attemptedClick=false;activeVideoId=null;
            await releasePointer();
            break;
          }
          if(!refreshable||error.code==='VIDEO_UNAVAILABLE') throw error;
          if(await stopIfPaused()) return;
          if(pageAttempt===MAX_SEND_REFRESHES) {
            error.message=`已刷新重试 ${MAX_SEND_REFRESHES} 次，${MAX_SEND_REFRESHES+1} 次尝试均失败；尚未点击好友发送：`+error.message;
            throw error;
          }
          await change(({state})=>{
            const message=`发送准备失败，自动刷新当前视频后重试（${pageAttempt+1}/${MAX_SEND_REFRESHES}；第 ${pageAttempt+2} 次尝试）；仍定位同一好友，尚未点击好友发送。原因：`+String(error.message).slice(0,240);
            log(state,'info',message);
            setFriendReport(state,{kind:'run',phase:'running',message,refreshAttempt:pageAttempt+1,maxRefreshes:MAX_SEND_REFRESHES});
          });
          result=undefined;
        }
      }
      if(deliverySkipped) continue;
      if(result.evidence==='panel-closed') await change(({state})=>log(state,'info','按面板关闭判定已发送（页面无明确提示，属低置信度）。'));
      await change(({state})=>{
        const preExisting=result.existingBeforeSend===true||(result.alreadySent===true&&!attemptedClick);
        completeDelivery(state,delivery.key,Date.now(),{preExisting});
        if(!state.deliveries.some(d=>d.status==='pending'&&d.video.id===delivery.video.id)) state.activeVideoId=null;
        log(state,'info',preExisting?`视频 ${delivery.video.id} 的目标好友已显示发送过，保留防重记录，不计入本轮新发送。`:`已向 ${delivery.recipient.name} 转发视频 ${delivery.video.id}。`);
      });
      sendingKey=null; attemptedClick=false; sends++;
      await delay(1200);
    }
  } catch(error) {
    runFailed=true;
    failureMessage=String(error?.message||error);
    const transient=/Detached|target_closed|not attached|No tab with given id/iu.test(String(error?.message||error));
    const requeuedTransient=!!sendingKey&&!attemptedClick&&transient;
    if(sendingKey&&!attemptedClick){
      await change(({state})=>abortDelivery(state,sendingKey,String(error.message),Date.now()));
      sendingKey=null;
    }
    if(sendingKey) await change(({state})=>failDelivery(state,sendingKey,String(error.message),Date.now()));
    const revision=error.code==='SHARE_TARGET_CHANGED'?'share-target-v12':error.code==='SHARE_PANEL_EMPTY'?'share-prepare-v9':'run-report-v13';
    let snapshot='';
    if(currentTabId!=null) try {snapshot=await shareSnapshot(currentTabId,null,revision);} catch {}
    await change(({state})=>{
      const previous=state.friendReadReport;
      const panelDetail=previous?.seq>runStartSeq&&previous.kind==='share-panel'&&previous.error?'\n'+previous.error:'';
      setFriendReport(state,{kind:dryRun?'scan':'run',error:'本轮检查失败（'+revision+'）：'+String(error.message)+
        (error.details?'\n'+JSON.stringify(error.details):'')+panelDetail+(snapshot?'\n'+snapshot:'')});
    });
    if(requeuedTransient) {if(dryRun) throw error;return;}
    if(dryRun) throw error;
    await pauseError(error.message || '任务执行失败。');
  } finally {
    clearInterval(heartbeat);
    try {
      await releasePointer();
      let continuation=null;
      if(reportStarted) await change(({state,config})=>{
        const checkpoint=state.searchCheckpoint;
        const own=!dryRun&&!queueOnly&&checkpoint?.roundId===roundId;
        const stopped=epoch!==commandEpoch||(!dryRun&&(!state.enabled||state.paused));
        const remaining=state.deliveries.filter(d=>d.status==='pending').length;
        const sent=state.round?.id===roundId?state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===roundId).length:0;
        const skipped=state.deliveries.filter(d=>d.status==='skipped'&&d.skipReason==='video-unavailable'&&d.skippedRoundId===roundId).length;
        const unfinished=own&&checkpoint.nextIndex<checkpoint.queries.length;
        const waiting=!dryRun&&!runFailed&&!stopped&&(remaining||unfinished);
        let waitText='';
        if(waiting) {
          if(own)checkpoint.phase=remaining?'drain':'query';
          const now=Date.now();
          const readyAt=remaining?nextDeliveryAt(state,now,config,state.activeVideoId):now;
          const limited=remaining&&readyAt>now;
          const reason=limited?'rate-limit':remaining?'send-segment':'query-segment';
          const at=Math.max(now+1000,limited?readyAt+250:now+1000);
          state.resumePlan={mode,roundId,reason,at};
          state.round.stage=limited?'waiting-rate':remaining?'waiting-send':'waiting-search';
          if(unfinished)state.round.scanStatus='waiting';
          delete state.round.stopReason;delete state.round.stopReasonText;
          waitText=limited?`达到发送限速，仍在运行；预计 ${Math.ceil((at-now)/1000)} 秒后自动继续，剩余 ${remaining} 项待发。`:
            remaining?`本段发送完成，仍在运行，将自动继续剩余 ${remaining} 项；不会重新查询。`:
            '本批队列已发完，将自动继续剩余查询。';
          log(state,'info',waitText);
          continuation={when:at};
        } else {
          state.resumePlan=null;
          if(!dryRun&&!runFailed) {
            sendStopReason=stopped?'manual-pause':!remaining?'queue-empty':sendStopReason||
              (end&&Date.now()>=end?'time-budget':'segment-end');
            state.round.stopReason=sendStopReason;
            state.round.stopReasonText=SEND_STOP_TEXT[sendStopReason];
          }
          if(own&&!runFailed&&!stopped)state.searchCheckpoint=null;
          finishRound(state,roundId,{status:runFailed?'failed':stopped?'paused':'done',error:failureMessage});
          if(mode==='auto-loop'&&!runFailed&&!stopped) {
            const at=Date.now()+(sent>0?1000:(Number(config.checkIntervalSeconds)||60)*1000);
            state.resumePlan={mode,roundId,reason:'next-round',at};
            state.round.stage='waiting-next-round';
            waitText=sent>0?'本轮已发送完毕，将自动开始下一轮抓取。':
              `本轮没有新的待发视频，${Number(config.checkIntervalSeconds)||60} 秒后自动再抓取；任务仍在运行。`;
            log(state,'info',waitText);continuation={when:at};
          }
          if(queueOnly||(['auto-loop'].includes(mode)&&runFailed)) {
            state.enabled=false;
            if(queueOnly)state.runMode=null;
            log(state,'info',`${queueOnly?'本次待发直发已结束':'全自动循环已停止'}，原因：${SEND_STOP_TEXT[sendStopReason]||'任务异常，请查看错误详情'}；剩余 ${remaining} 项待发。`);
          }
        }
        if(!runFailed) setFriendReport(state,{kind:dryRun?'scan':'run',phase:continuation?'running':'done',
          message:(skipped?`本轮已跳过 ${skipped} 项失效视频待发任务。`:'')+(continuation?`${mode==='auto-loop'?'全自动循环':queueOnly?'待发直发（不查询）':'监控'}：${waitText}本轮已确认发送 ${sent} 张卡片。`:
            queueOnly?`待发直发（不查询）已结束。原因：${SEND_STOP_TEXT[sendStopReason]||'本段任务已结束'}。本次确认发送 ${sent} 张卡片，剩余 ${remaining} 项待发。当前已暂停。`:
            dryRun?`本段试检索结束，命中 ${scanCount??0} 个视频，未发送。${state.scanCheckpoint?'查询未完成，再次点击试检索继续。':''}`:
            `本轮已结束，原因：${SEND_STOP_TEXT[sendStopReason]||'本段任务已结束'}。本次确认发送 ${sent} 张卡片，剩余 ${remaining} 项待发。${!state.enabled?'当前已暂停。':''}`),
          skipped,sent,remaining,runMode:dryRun?'scan':mode,stopReason:continuation?null:sendStopReason,resumeAt:state.resumePlan?.at||null});
      });
      if(continuation) await chrome.alarms.create(CONTINUE_ALARM,continuation).catch(()=>change(({state})=>
        log(state,'error','自动续段闹钟设置失败，将在下次定时检查继续；已保存进度。')));
    } finally {busy=false;}
  }
}

async function command(message) {
  const startedAt=Date.now();
  try {return await handleCommand(message);}
  catch(error){
    if(['START','AUTO_LOOP','SEND_PENDING','SCAN','FRIENDS','DIAGNOSE'].includes(message?.type)) await change(({state})=>{
      const current=state.friendReadReport;
      const detail=current?.at>=startedAt&&current.error?current.error:String(error?.message||error);
      setFriendReport(state,{kind:message.type==='FRIENDS'?'friends':message.type==='DIAGNOSE'?'diagnose':message.type==='SCAN'?'scan':'run',error:detail});
    });
    throw error;
  }
}

async function handleCommand(message) {
  await ready;
  const {type} = message;
  if(type==='STATUS') {
    const data=await chrome.storage.local.get(['state','config']);
    return {...data,busy,workerBuild:BUILD};
  }
  if(type==='OPEN_LOGIN') return chrome.tabs.create({url:'https://www.douyin.com/user/self'});
  if(type==='PAUSE') {commandEpoch++;const result=await change(({state})=>{
    state.enabled=false;state.resumePlan=null;
    if(!busy&&state.round?.status==='running') {
      state.round.stopReason='manual-pause';state.round.stopReasonText=SEND_STOP_TEXT['manual-pause'];
      finishRound(state,state.round.id,{status:'paused'});
    }
    if(!busy&&!state.paused&&state.friendReadReport?.phase==='running') {
      const remaining=state.deliveries.filter(d=>d.status==='pending').length;
      const sent=state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===state.round?.id).length;
      setFriendReport(state,{kind:'run',phase:'done',runMode:state.runMode,stopReason:'manual-pause',resumeAt:null,
        sent,remaining,message:`已手动暂停，自动等待和后续循环已取消。本轮已确认发送 ${sent} 张卡片，剩余 ${remaining} 项待发。`});
    }
    log(state,'info','已手动暂停；正在发送的单次操作会先完成。');
  });await chrome.alarms.clear(CONTINUE_ALARM).catch(()=>{});return result;}
  if(type==='SCAN') {
    const {state}=await chrome.storage.local.get('state');
    if(state.enabled&&!state.paused&&state.runMode)throw new Error('请先暂停当前任务，再试检索。');
    return cycle(true);
  }
  if(type==='MAIL_HEALTH') return mailHealth();
  if(type==='MAIL_TEST') {
    // 只有用户点击“发送测试邮件”才调用，测试通知与故障事件分开。
    const {config}=await chrome.storage.local.get('config');
    const response=await fetch(`${MAIL}/alert`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.mailBridgeToken}`},body:JSON.stringify({incidentId:`test-${crypto.randomUUID()}`,reason:'司凤转发（dead-mom sharing)：这是一封由你点击发送的测试邮件。',at:new Date().toISOString(),accountName:config.account?.name||'未绑定'}),signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error(`测试邮件发送失败（${response.status}），请检查本地邮件服务。`);
    return {sent:true};
  }
  if(type==='START'||type==='AUTO_LOOP'||type==='SEND_PENDING') {
    const queueOnly=type==='SEND_PENDING';
    const autoLoop=type==='AUTO_LOOP';
    if(busy) throw new Error('请等待当前任务结束后再开始／恢复。');
    const epoch=++commandEpoch;
    const {config,state}=await chrome.storage.local.get(['config','state']);
    validateConfig(config,{ready:true});
    if(state.enabled&&!state.paused&&(queueOnly||autoLoop||['queue-only','auto-loop'].includes(state.runMode)))
      throw new Error('任务正在运行或等待限速；切换模式请先暂停。');
    if(state.deliveries.some(d=>d.status==='unknown'||d.status==='sending')) throw new Error('请先处理“待核对”的发送记录，再恢复任务。');
    if(queueOnly) {
      const cached=structuredClone(state);
      enqueue(cached,Array.isArray(state.preview)?state.preview:[],config,Date.now());
      if(!cached.deliveries.some(d=>d.status==='pending')) throw new Error('没有可发送的待发视频；请先试检索，或确认已有结果仍在时间窗口内。');
    }
    if(!config.mailBridgeToken || config.mailBridgeToken.length<32) throw new Error('请填写邮件服务连接令牌（至少32位）。');
    await mailHealth();
    await change(({state,config})=>{
      if(epoch!==commandEpoch) throw new Error('开启操作已被后续的暂停或设置操作取消。');
      if(busy) throw new Error('任务执行中，请等待当前任务结束。');
      validateConfig(config,{ready:true});
      if(state.deliveries.some(d=>['unknown','sending'].includes(d.status))) throw new Error('请先核对未确认的发送记录。');
      if(queueOnly) {
        enqueue(state,Array.isArray(state.preview)?state.preview:[],config,Date.now());
        if(!state.deliveries.some(d=>d.status==='pending')) throw new Error('没有可发送的待发视频。');
      }
      state.enabled=true;state.paused=false;state.incident=null;state.runMode=queueOnly?'queue-only':autoLoop?'auto-loop':'monitor';
      state.resumePlan=null;
      log(state,'info',queueOnly?'开始发送待发视频：不重新查询；限速自动等待，直到队列发完或手动暂停／出错。':autoLoop?'已开启全自动循环：抓取 → 发送 → 发完再抓取；限速自动等待，直到暂停或出错。':'已开启监控。');
    });
    if(queueOnly) {void cycle(false,{queueOnly:true});return {started:true,queueOnly:true};}
    await scheduleAlarm();
    void cycle(); return autoLoop?{started:true,autoLoop:true}:{started:true};
  }
  if(busy) throw new Error('任务执行中；请先暂停，等待本轮结束后再修改或读取好友。');
  if(type==='DIAGNOSE') {
    // One click must be enough to explain a failure: the report is written to
    // the run log so it survives the toast timeout and can be pasted back.
    const report=[];let friendResult=null;
    await change(({state})=>setFriendReport(state,{kind:'diagnose',phase:'running',message:'正在诊断分享面板，只读取，不发送。'}));
    const add=(ok,text)=>{report.push({ok,text:String(text)});};
    const {state}=await chrome.storage.local.get('state');
    let tab=null;
    const tabs=await chrome.tabs.query({url:'https://www.douyin.com/*'});
    add(true,`抖音标签 ${tabs.length} 个：` + tabs.map(item=>String(item.url||'').slice(0,100)).join(' | ').slice(0,400));
    const picked=pickDouyinTab(tabs,state.workerTabId);
    tab=picked?.tab||null;
    const hasDebugger=typeof chrome.debugger?.attach==='function';
    add(hasDebugger,`调试接口 ${hasDebugger?'可用':'不可用（扩展未获得调试权限）'}`);
    if(!tab) add(false,'没有可用的抖音标签页');
    else {
      add(true,`目标标签 ${tab.id}：${String(tab.url||'').slice(0,120)}`);
      let trusted=false;
      try { await pointerFor(tab.id); trusted=true; add(true,'已附加调试会话'); }
      catch (error) { add(false,error.message); }
      if(trusted) add(true,'使用后台指针诊断，不切换前台窗口');
      try {
        const first=await execute(tab.id,'openShare',trusted?{pointer:true}:{});
        add(!!first?.opened,'面板首次探测：'+JSON.stringify(first));
        if(!first?.opened&&first?.needsPointer&&trusted) {
          await pointer.hover(first.x,first.y,{leaveFirst:true});
          await delay(700);
          const again=await execute(tab.id,'openShare',{pointer:true});
          add(!!again?.opened,'悬停 700ms 后：'+JSON.stringify(again));
        }
        const result=await readFriendPanel(tab.id);
        friendResult=result;
        const friends=Array.isArray(result)?result:result.friends;
        add(true,`已读取好友 ${friends.length} 位；如有遗漏，请查看“好友读取诊断”记录。`);
      } catch (error) { add(false,'面板或好友读取失败：'+error.message); }
      try { await releasePointer(); } catch {}
    }
    await change(({state})=>{
      for(const item of report) log(state,item.ok?'info':'error','诊断 · '+item.text);
      if(friendResult) setFriendReport(state,{...state.friendReadReport,kind:'diagnose'});
      else setFriendReport(state,{kind:'diagnose',error:report.filter(item=>!item.ok).map(item=>item.text).join('\n')||'没有取得好友读取结果。'});
    });
    return { report };
  }
  if(type==='SAVE') { const saved = await change(data=>{
    if(data.state.enabled && !data.state.paused) throw new Error('请先暂停监控再修改配置。');
    const config=validateConfig(message.config,{ready:false});
    if((config.account?.id||null)!==(data.config.account?.id||null)) throw new Error('账号绑定必须通过“识别并绑定账号”完成。');
    commandEpoch++;
    const before=data.state.deliveries.length;
    data.state.deliveries=data.state.deliveries.filter(delivery=>{
      if(delivery.status!=='pending') return true;
      const recipient=matchRules(delivery.video,config.rules).flatMap(r=>r.recipients).find(r=>r.id===delivery.recipient.id);
      if(!recipient || delivery.accountId!==config.account?.id) return false;
      delivery.recipient=structuredClone(recipient);return true;
    });
    if(before!==data.state.deliveries.length) log(data.state,'info',`规则变更后移除了 ${before-data.state.deliveries.length} 条不再符合的待发送记录。`);
    if(searchSignature(config)!==searchSignature(data.config)) {
      data.state.searchCheckpoint=null;data.state.scanCheckpoint=null;data.state.resumePlan=null;
    }
    data.config=config; log(data.state,'info','配置已保存。');
  });
  await scheduleAlarm();
  return saved;
  }
  if(type==='BIND') {
    commandEpoch++;
    const tabs=await chrome.tabs.query({url:'https://www.douyin.com/*'});
    const candidates=tabs.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
    if(!candidates.length) throw new Error('请先打开抖音并登录 bot 账号。');
    const account=await execute(candidates[0].id,'probe');
    await change(({state,config})=>{
      if(state.enabled && !state.paused) throw new Error('请先暂停监控。');
      if(config.account && String(config.account.id)!==String(account.id) && state.deliveries.some(d=>['pending','unknown','sending'].includes(d.status))) throw new Error('原账号还有待处理队列，请先完成或跳过，避免切换账号误发。');
      if(config.account?.id!==account.id) for(const rule of config.rules) rule.recipients=[];
      state.searchCheckpoint=null;state.scanCheckpoint=null;state.resumePlan=null;
      config.account=account; state.enabled=false;log(state,'info',`已绑定账号 ${account.name}。`);
    });
    return account;
  }
  if(type==='FRIENDS') {
    const {config,state}=await chrome.storage.local.get(['config','state']);
    if(!config.account) throw new Error('请先绑定账号。');
    const tabs=await chrome.tabs.query({url:'https://www.douyin.com/*'});
    const picked=pickDouyinTab(tabs,state.workerTabId);
    if(!picked) throw new Error('请先在抖音打开一条视频（视频页或推荐页弹出的视频都可以），再点击读取好友。');
    const tab=picked.tab;
    await change(({state})=>setFriendReport(state,{kind:'friends',phase:'running',message:'正在读取好友列表，不发送。'}));
    await change(({state})=>log(state,'info','读取好友使用标签页：' + picked.url.slice(0,200)));
    await assertAccount(tab.id,config);
    try {
      await openPanel(tab.id);
      const result=await readFriendPanel(tab.id);
      const found=Array.isArray(result)?result:result.friends;
      await change(({state})=>log(state,'info',`已读取 ${found.length} 位可见好友。`));
      return result;
    } catch (error) {
      // Keep the precise reason visible in the run log instead of a 10s toast.
      await change(({state})=>log(state,'error','读取好友失败：' + String(error?.message||error)));
      throw error;
    } finally { await releasePointer(); }
  }
  if(type==='RESOLVE') return change(({state})=>{
    resolveDelivery(state,message.key,message.action,Date.now());
    log(state,'info',`人工处理记录：${message.action}。`);
  });
  if(type==='EXPORT') {
    const {config,state}=await chrome.storage.local.get(['config','state']);
    return {format:'douyin-watch-backup',version:1,exportedAt:Date.now(),config:{...config,mailBridgeToken:''},state:{...state,enabled:false,workerTabId:null,searchCheckpoint:null,scanCheckpoint:null,resumePlan:null}};
  }
  if(type==='IMPORT') {
    commandEpoch++;
    const backup=message.backup;
    if(backup?.format!=='douyin-watch-backup'||backup.version!==1||!Array.isArray(backup.state?.deliveries)) throw new Error('备份文件格式不正确。');
    const config=validateConfig(backup.config,{ready:false});
    let state={...defaultState(),...backup.state,enabled:false,workerTabId:null};
    if(!Array.isArray(state.rate)||!Array.isArray(state.logs)||state.deliveries.some(d=>!d.key||!d.video?.id||!d.recipient?.id||!['pending','sending','sent','unknown','skipped'].includes(d.status)||d.key!==makeKey(d.accountId,d.video.id,d.recipient.id)||(['pending','sending','unknown'].includes(d.status)&&String(d.accountId)!==String(config.account?.id)))) throw new Error('备份中的发送记录或账号不一致。');
    state=recoverState(state,Date.now());
    state.round=null; // Imported historical statistics are not a local run.
    state.searchCheckpoint=null;state.scanCheckpoint=null;state.resumePlan=null;
    await change(data=>{state.friendReportSeq=Math.max(Number(state.friendReportSeq)||0,Number(data.state.friendReportSeq)||0,Number(data.state.friendReadReport?.seq)||0);data.config=config;data.state=state;log(state,'info','已导入备份；请核对账号和邮件配置后手动启动。');});
    return {imported:true};
  }
  throw new Error('不支持的操作。');
}
// A dropped debugger session is normal (tab reloaded, DevTools opened). Clear
// the cached handle, record why, and let the next call re-attach.
if (chrome.debugger?.onDetach?.addListener) {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (pointer && source?.tabId === pointer.tabId) pointer.connected = false;
    void change(({state}) => log(state, 'error', '调试会话断开：' + String(reason || 'unknown')));
  });
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  command(message).then(data=>respond({ok:true,data})).catch(error=>respond({ok:false,error:error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(async alarm=>{
  if(alarm.name===CONTINUE_ALARM) {
    const {state}=await chrome.storage.local.get('state');
    if(!activeResumePlan(state))return;
  }
  if(alarm.name===ALARM||alarm.name===CONTINUE_ALARM)return cycle();
});
chrome.action.onClicked.addListener(()=>chrome.runtime.openOptionsPage());
chrome.runtime.onStartup.addListener(()=>void ready);
