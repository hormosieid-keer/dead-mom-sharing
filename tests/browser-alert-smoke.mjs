// Native MV3 worker, offscreen audio, badge and options favicon. Synthetic
// incidents only. Headless/muted output; no real Douyin, SMTP or daily profile.
import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve(import.meta.dirname,'..');
const results=path.join(root,'test-results');
await mkdir(results,{recursive:true});
const temp=await mkdtemp(path.join(results,'browser-alert-temp-'));
let context;
async function until(fn) {
  for(let i=0;i<120;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}
  throw new Error('Browser alert fixture did not settle');
}
try {
  const extension=path.join(root,'extension');
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{
    channel:'chromium',executablePath:process.env.BOT_TEST_CHROMIUM||undefined,headless:true,
    viewport:{width:1440,height:1100},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--mute-audio']
  });
  let external=0;
  await context.route(/^https?:\/\//u,route=>{external++;return route.abort();});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const id=new URL(worker.url()).hostname;
  const options=await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.evaluate(()=>chrome.runtime.sendMessage({type:'STATUS'}));
  await worker.evaluate(async()=>{
    const {state,config}=await chrome.storage.local.get(['state','config']);
    config.mailAlertsEnabled=false;config.mailBridgeToken='';state.enabled=false;state.paused=false;state.incident=null;
    await chrome.storage.local.set({state,config});
  });
  const preview=await options.evaluate(()=>chrome.runtime.sendMessage({type:'BROWSER_ALERT_TEST'}));
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const audio=await options.evaluate(async()=>{
    const response=await fetch(chrome.runtime.getURL('audio/alert-ding-dong.wav'));
    const context=new AudioContext();
    try {const decoded=await context.decodeAudioData(await response.arrayBuffer());return {duration:decoded.duration,channels:decoded.numberOfChannels};}
    finally {await context.close();}
  });
  assert.equal(audio.duration,1.4);assert.equal(audio.channels,1);
  const second=await context.newPage();await second.goto(options.url());
  const incident=async id=>worker.evaluate(async id=>{
    const {state}=await chrome.storage.local.get('state');
    state.paused=true;state.incident={id,at:Date.now(),reason:'虚构验证告警，仅测试浏览器提示',notified:false};
    await chrome.storage.local.set({state});
    await chrome.alarms.create('douyin-minute',{when:Date.now()+100});
  },id);
  const status=()=>worker.evaluate(async()=>({
    ...(await chrome.storage.local.get('state')).state,
    badge:await chrome.action.getBadgeText({}),
    contexts:(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length
  }));
  await incident('fixture-open-pages');
  await until(async()=>{const state=await status();return state.browserAlert?.status==='played'&&state.badge==='!';});
  const warningTitle='告警：虚构验证告警，仅测试浏览器提示';
  await until(async()=>await options.title().then(title=>title===warningTitle)&&await second.title().then(title=>title===warningTitle));
  const href=await options.locator('#tab-icon').getAttribute('href');
  await options.waitForFunction(href=>document.querySelector('#tab-icon').getAttribute('href')!==href,href);
  const first=await status();assert.equal(first.contexts,1);
  assert.equal(await options.locator('#mail-alerts-enabled').isChecked(),false);
  await options.screenshot({path:path.join(results,'browser-alert-desktop.png'),fullPage:true});
  await options.setViewportSize({width:390,height:844});
  assert.equal(await options.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await options.screenshot({path:path.join(results,'browser-alert-mobile.png'),fullPage:true});
  await options.close();await second.close();
  await incident('fixture-closed-pages');
  await until(async()=>{const state=await status();return state.browserAlert?.incidentId==='fixture-closed-pages'&&state.browserAlert.status==='played';});
  const closed=await status();
  const reopened=await context.newPage();await reopened.goto(`chrome-extension://${id}/options.html`);
  await reopened.reload();
  await worker.evaluate(()=>chrome.alarms.create('douyin-minute',{when:Date.now()+100}));
  await until(async()=>await reopened.title().then(title=>title===warningTitle));
  assert.deepEqual((await status()).browserAlert,closed.browserAlert,'reopening or polling must not replay the incident');
  await worker.evaluate(async()=>{
    const {state}=await chrome.storage.local.get('state');state.incident=null;state.paused=false;
    await chrome.storage.local.set({state});await chrome.alarms.create('douyin-minute',{when:Date.now()+100});
  });
  await until(async()=>await reopened.title().then(title=>title==='司凤转发（dead-mom sharing)')&&(await status()).badge==='');
  await reopened.evaluate(()=>chrome.runtime.sendMessage({type:'PAUSE'}));
  assert.equal((await status()).incident,null);
  assert.equal(external,0,'no HTTP service or real account should be contacted');
  console.log('PASS: real MV3 offscreen playback/decode with settings closed, mail off, one incident claim, two-page favicon blinking, toolbar badge, reopen/recovery, manual pause, desktop/390px and zero external requests. Audio sink muted.');
} finally {
  if(context)await context.close();
  if(path.dirname(path.resolve(temp))!==results||!path.basename(temp).startsWith('browser-alert-temp-'))throw new Error('Unsafe fixture cleanup');
  await rm(temp,{recursive:true,force:true});
}
