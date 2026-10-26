// Render the real options UI with synthetic account/friend data. Every request
// is intercepted; this script cannot reach Douyin, SMTP, or a real extension.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState, makeKey, beginRound, finishRound } from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/images');
await mkdir(out, { recursive: true });
const files = Object.fromEntries(await Promise.all(['options.html', 'options.css', 'options.js', 'icons/tab.svg', 'icons/tab-alert.svg'].map(async name => [name, await readFile(path.join(root, 'extension', name), 'utf8')])));
const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifest.json'), 'utf8'));
const at = Date.UTC(2026, 9, 24, 7, 0);
const recipients = ['甲', '乙', '丙'].map((suffix, index) => ({
  id: 'uid:700000000000000000' + (index + 1), uid: '700000000000000000' + (index + 1), name: '演示好友' + suffix
}));
const report = { at, seq: 1, build: manifest.version_name, kind: 'friends', phase: 'done', total: 3, diagnostics: {
  revision: 'friends-v3', firstScreen: { controls: 3, recognized: 3, rejected: 0 }, observed: 3, recognized: 3,
  unrecognized: 0, stop: 'bottom', rejectionCounts: {}, samples: []
} };
const config = { schemaVersion: 1, account: { id: '12345678', name: '演示账号 · 非真实账号' }, maxPages: 3,
  mailAlertsEnabled:true,
  checkIntervalSeconds: 60, videoWindowMinutes: 60, maxVideosPerWindow: 5,
  mailBridgeToken: 'documentation-fixture-not-a-real-bridge-token',
  rules: [{ id: 'demo-rule', name: '示例：司凤视频转发', tags: ['司凤'], keywords: ['司凤视频'], recipients: recipients.slice(0, 2) }]
};
const video = { id: '1000000000000000001', type: 'video', publishedAt: at - 300000,
  url: 'https://www.douyin.com/video/1000000000000000001', description: '演示：司凤相关视频（非真实检索结果）', tags: [{ id: 'demo-tag', name: '司凤' }] };
const state = { ...defaultState(), friendReadReport: report, preview: [video], lastScanAt: at,
  logs: [{ at, level: 'info', message: '演示：试检索命中 1 条视频，本次未发送。' }] };
beginRound(state,{kind:'scan',source:'search',videos:[video],queriesTotal:1,nowMs:at});
state.round.queriesDone=1;
finishRound(state,state.round.id,{nowMs:at});
const browser = await chromium.launch({ headless: true, executablePath: process.env.BOT_TEST_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (url.origin === 'https://documentation.invalid' && files[name]) return route.fulfill({
      contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8', body: files[name]
    });
    await route.abort();
  });
  await page.addInitScript(({ state, config, recipients, build }) => {
    globalThis.docsFixture = { state, config };
    globalThis.docsCalls=[];
    globalThis.chrome = { runtime: { async sendMessage({ type }) {
      docsCalls.push(type);
      if (type === 'STATUS') return { ok: true, data: { state, config, workerBuild: build, busy: false } };
      if (type === 'FRIENDS') {
        state.friendReadReport = { ...state.friendReadReport, seq: state.friendReadReport.seq + 1 };
        return { ok: true, data: { friends: recipients, diagnostics: state.friendReadReport.diagnostics } };
      }
      if (type === 'MAIL_HEALTH') return { ok: true, data: { configured: true } };
      throw new Error('Documentation renderer blocks this action: ' + type);
    } } };
  }, { state, config, recipients, build: manifest.version_name });
  await page.goto('https://documentation.invalid/options.html');
  await page.waitForFunction(() => document.querySelector('#account-name').textContent.includes('演示账号'));
  await page.locator('#load-friends').click();
  await page.waitForFunction(() => !document.querySelector('#load-friends').disabled);
  await page.locator('#mail-health').click();
  await page.waitForFunction(() => document.querySelector('#mail-status').textContent.includes('已配置'));
  await page.locator('#toast').waitFor({ state: 'hidden', timeout: 12000 });
  await page.screenshot({ path: path.join(out, 'dashboard.png'), fullPage: true });
  await page.locator('.browser-alert-bar').screenshot({path:path.join(out,'browser-alert.png')});
  await page.locator('.primary > .card').nth(0).screenshot({ path: path.join(out, 'bind-account.png') });
  await page.locator('.primary > .card').nth(1).screenshot({ path: path.join(out, 'read-friends.png') });
  await page.locator('.primary > .card').nth(2).screenshot({ path: path.join(out, 'rule-editor.png') });
  await page.locator('aside').screenshot({ path: path.join(out, 'controls-and-mail.png') });
  await page.evaluate(() => {
    const {state}=docsFixture;
    docsFixture.baseline=structuredClone(state);
    state.enabled=true;state.runMode='auto-loop';
    state.round.status='running';state.round.stage='waiting-rate';state.round.kind='auto-loop';
    const original=state.round.videos[0],recipient=docsFixture.config.rules[0].recipients[0];
    state.deliveries=[{accountId:docsFixture.config.account.id,video:original,recipient,status:'sent',attemptRoundId:state.round.id},
      {accountId:docsFixture.config.account.id,video:{...original,id:'1000000000000000002'},recipient,status:'pending'}];
    state.resumePlan={mode:'auto-loop',roundId:state.round.id,reason:'rate-limit',at:Date.now()+45000};
    state.friendReadReport={at:Date.now(),seq:state.friendReadReport.seq+1,build:state.friendReadReport.build,
      kind:'run',phase:'running',message:'演示：达到发送限速，任务仍在运行，预计45秒后自动续发；发完本批再抓取。'};
  });
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='等待限速');
  await page.locator('.control').screenshot({path:path.join(out,'automatic-wait.png')});
  await page.evaluate(()=>{
    const {state,baseline}=docsFixture;
    for(const key of Object.keys(state))delete state[key];
    Object.assign(state,baseline);
  });
  await page.evaluate(()=>{
    const {state,config}=docsFixture;
    const original=state.round.videos[0],recipient=config.rules[0].recipients[0];
    state.deliveries=[{accountId:config.account.id,video:original,recipient,status:'skipped',skipReason:'video-unavailable',unavailableReason:'not-found'}];
  });
  await page.waitForFunction(()=>document.querySelector('#preview').textContent.includes('失效跳过 1 项'));
  await page.locator('#preview').locator('..').screenshot({path:path.join(out,'unavailable-video.png')});
  await page.evaluate(async ({ video, recipient, key, at }) => {
    const { state } = docsFixture;
    state.deliveries = [{ key, accountId: '12345678', video, recipient, status: 'unknown', error: '演示：未捕获明确发送回执，请人工核对聊天记录。', updatedAt: at }];
    state.paused = true;
    state.incident = { at, reason: '演示：发送结果无法确认，需要人工核对。', notified: false };
  }, { video, recipient: recipients[0], key: makeKey(config.account.id, video.id, recipients[0].id), at });
  // options.js is a module: use its normal STATUS polling instead of exposing
  // a private UI function on the page solely for screenshots.
  await page.getByRole('button', { name: '核对后标记已发送', exact: true }).waitFor();
  await page.locator('#uncertain').locator('..').screenshot({ path: path.join(out, 'review-required.png') });
  // Verify the hover behavior in the rendered browser, including clipping,
  // scrolling a long explanation, dynamic rule help and keyboard dismissal.
  const callsBefore=await page.evaluate(()=>docsCalls.length);
  const helpButtons=page.locator('.region-help-button');
  assert.equal(await helpButtons.count(),13,'12 regions plus the sample rule');
  const tooltip=page.locator('#region-help-tooltip');
  for(const viewport of [{width:1440,height:1100},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    for(let index=0;index<await helpButtons.count();index++){
      const button=helpButtons.nth(index);
      await button.hover();
      try{await tooltip.waitFor({state:'visible',timeout:4000});}
      catch(error){throw new Error(`Help did not open at ${viewport.width}px: ${await button.getAttribute('aria-label')}`,{cause:error});}
      assert.ok((await tooltip.textContent()).length>80,'region and button explanations must be present');
      const bounds=await tooltip.boundingBox();
      assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1,'help must fit the viewport');
      await page.mouse.move(1,1);await tooltip.waitFor({state:'hidden'});
    }
    const controlHelp=page.locator('[data-help="control"] > .region-help-button');
    await controlHelp.hover();await tooltip.waitFor({state:'visible'});
    const rect=await tooltip.boundingBox();
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
    await page.mouse.wheel(0,800);
    await page.waitForFunction(()=>document.querySelector('#region-help-tooltip').scrollTop>0,null,{timeout:3000});
    assert.equal(await tooltip.isVisible(),true,'moving into the explanation must allow reading and scrolling');
    assert.ok(await tooltip.evaluate(node=>node.scrollTop>0),'long explanations can scroll');
    await page.keyboard.press('Escape');await tooltip.waitFor({state:'hidden'});
    const accountHelp=page.locator('[data-help="account"] > .region-help-button');
    await page.keyboard.press('Tab');
    await accountHelp.focus();await tooltip.waitFor({state:'visible'});
    await page.keyboard.press('Escape');await tooltip.waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await controlHelp.hover();await tooltip.waitFor({state:'visible'});
    await tooltip.evaluate(node=>{node.scrollTop=0;});
    const destination=viewport.width===1440?path.join(out,'region-help.png'):path.join(root,'test-results','region-help-v22-390.png');
    await mkdir(path.dirname(destination),{recursive:true});
    await page.screenshot({path:destination});
    await page.mouse.move(1,1);await tooltip.waitFor({state:'hidden'});
  }
  assert.deepEqual(await page.evaluate(from=>docsCalls.slice(from).filter(type=>type!=='STATUS'),callsBefore),[],'help must never trigger a worker action');
  await page.setViewportSize({width:1440,height:1100});
  await page.locator('#mail-alerts-enabled').uncheck();
  await page.evaluate(()=>{docsFixture.config.mailAlertsEnabled=false;});
  await page.waitForFunction(()=>document.querySelector('#mail-status').textContent.includes('已关闭'));
  assert.equal(await page.locator('#mail-token').isEnabled(),false);
  assert.equal(await page.locator('#mail-health').isEnabled(),false);
  assert.equal(await page.locator('#mail-test').isEnabled(),false);
  await page.locator('[data-help="mail"]').screenshot({path:path.join(out,'optional-mail.png')});
  assert.deepEqual(await page.evaluate(from=>docsCalls.slice(from).filter(type=>type!=='STATUS'),callsBefore),[]);
  console.log('Rendered 11 screenshots. Browser-alert controls, help hover/keyboard/scroll, optional-mail disabled controls, desktop/390px bounds and zero worker actions checked. Synthetic data only.');
} finally { await browser.close(); }
