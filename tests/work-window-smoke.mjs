// Exercise real Chrome windows/tabs APIs in an isolated headless profile.
// Page actions use a stub adapter: no real account, sharing or SMTP is possible.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState, enqueue } from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const refreshCase = process.env.BOT_TEST_FIRST_REFRESH === '1';
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
  const source = await readFile(path.join(root, 'extension/background.js'), 'utf8');
  assert.ok(source.includes("const MAIL = 'http://127.0.0.1:17321';"));
  await writeFile(path.join(extension, 'background.js'), source.replace("const MAIL = 'http://127.0.0.1:17321';", `const MAIL = '${mail}';`));
  await writeFile(path.join(extension, 'adapter.js'), `export async function browserTask(input) {
    if(input.action==='probe') return {id:'123',name:'fixture'};
    if(input.action==='openShare') {
      if(${refreshCase}) {
        const marker='fixture-first-share-document';
        if(!sessionStorage.getItem(marker)) sessionStorage.setItem(marker,String(performance.timeOrigin));
        if(sessionStorage.getItem(marker)===String(performance.timeOrigin))
          return {error:'Local fixture: share entry not mounted',code:'SHARE_ENTRY_MISSING'};
      }
      return {opened:true};
    }
    if(input.action==='share'&&input.mode==='probe') return {sent:true,alreadySent:true};
    throw new Error('Unexpected test action: '+input.action);
  }`);
  await writeFile(path.join(extension, 'options.html'), '<!doctype html><title>Local settings fixture</title><p>Settings remain selected here.</p>');
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    executablePath: process.env.BOT_TEST_CHROMIUM || undefined, channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  await context.route('https://www.douyin.com/**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local video fixture</title>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
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
  const config = { schemaVersion: 1, maxPages: 1, mailBridgeToken: 'x'.repeat(40), account: { id: '123', name: 'fixture' },
    rules: [{ id: 'r', tags: ['测试话题'], keywords: [], recipients: [{ id: 'uid:7000000000000000001', uid: '7000000000000000001', name: 'fixture friend' }] }] };
  const state = { ...defaultState(), workerTabId: old.tabId, workerWindowId: old.windowId };
  state.friendReadReport = { at: 1, error: 'old share-prepare-v5 fixture' };
  enqueue(state, [{ id: '739000000000000001', type: 'video', publishedAt: Date.now() - 1000,
    title: '', description: '', tags: [{ id: 'tag-1', name: '测试话题' }] }], config);
  await worker.evaluate(data => chrome.storage.local.set(data), { state, config });
  const started = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SEND_PENDING' }));
  assert.equal(started.ok, true, JSON.stringify(started));
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
  assert.equal(after.state.deliveries[0].status, 'sent', JSON.stringify({ incident: after.state.incident, logs: after.state.logs }));
  assert.equal(after.state.friendReadReport.phase, 'done');
  assert.equal(after.state.friendReadReport.build, '0.1.0（司凤转发 15）');
  assert.equal(after.state.friendReadReport.sent, 1);
  assert.equal(after.state.friendReadReport.error, undefined);
  assert.ok(after.state.friendReadReport.seq >= 2);
  assert.notEqual(after.window.id, old.windowId);
  assert.equal(after.window.focused, false, 'the work window must remain unfocused');
  assert.equal(after.window.tabs.length, 1);
  assert.equal(after.window.tabs[0].id, old.tabId);
  assert.equal(after.window.tabs[0].active, true);
  const settingsStayed = await options.evaluate(async oldWindow => {
    const [tab] = await chrome.tabs.query({ windowId: oldWindow, active: true });
    return tab.url === location.href;
  }, old.windowId);
  assert.equal(settingsStayed, true);
  assert.deepEqual(requests, ['/check']);
  if(refreshCase) {
    assert.equal(after.state.logs.filter(entry=>entry.message.includes('自动刷新当前视频')).length,1);
    const navigation = await worker.evaluate(async tabId => {
      const [{ result }] = await chrome.scripting.executeScript({target:{tabId},func:()=>performance.getEntriesByType('navigation')[0]?.type});
      return result;
    }, old.tabId);
    assert.equal(navigation, 'reload', 'real tabs.reload must replace the old video document');
  }
  const report = 'PASS: real extension moves the legacy inactive worker into a separate single-tab window; settings stays selected, queue run stops, no search or actual send, fake health endpoint only.' +
    (refreshCase ? ' Missing first share entry triggers exactly one real tab reload, then preparation and report complete.' : '');
  await writeFile(path.join(results, refreshCase?'first-refresh-v14-smoke.txt':'worker-window-v9-smoke.txt'), report + '\n');
  console.log(report);
} finally {
  await context?.close();
  await new Promise(resolve => bridge.close(resolve));
  const resolved = path.resolve(temp);
  if (path.dirname(resolved) !== results || !path.basename(resolved).startsWith('worker-window-v9-temp-')) throw new Error('Unsafe cleanup path');
  await rm(resolved, { recursive: true, force: true });
}
