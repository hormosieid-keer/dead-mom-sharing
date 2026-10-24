// Local options UI only. All external requests are blocked; no real account,
// browser extension, forwarding or mail endpoints are used.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { defaultState } from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const results = path.join(root, 'test-results');
await mkdir(results, { recursive: true });
const [html, css, js] = await Promise.all(['options.html', 'options.css', 'options.js'].map(name => readFile(path.join(root, 'extension', name), 'utf8')));
const build = '0.1.0（司凤转发 15）';
const browser = await chromium.launch({ executablePath: process.env.BOT_TEST_CHROMIUM || undefined, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  await page.route('**/*', route => route.abort());
  await page.setContent(html.replace(/<link[^>]+>/gu, '').replace(/<script[^>]*src="options.js"[^>]*><\/script>/u, ''));
  await page.addStyleTag({ content: css });
  await page.evaluate(({ state, build }) => {
    state.friendReadReport = { at: 1, seq: 1, error: '旧版 share-prepare-v5 报告' };
    globalThis.fixtureState = state;
    globalThis.chrome = { runtime: { async sendMessage({ type }) {
      if (type !== 'STATUS') throw new Error('Unexpected fixture action');
      return { ok: true, data: { state, config: { account: { id: '123', name: '本地预览账号' }, rules: [] }, busy: false, workerBuild: build } };
    } } };
  }, { state: defaultState(), build });
  await page.addScriptTag({ content: js });
  await page.waitForFunction(() => document.getElementById('account-name').textContent === '本地预览账号');
  assert.match(await page.locator('#friend-diagnostic-output').inputValue(), /share-prepare-v5/);
  await page.evaluate(async build => {
    fixtureState.friendReadReport = { at: Date.now(), seq: 2, build, kind: 'run', phase: 'running', message: '正在发送待发视频，不重新查询。' };
    await refresh();
  }, build);
  assert.equal(await page.locator('#friend-diagnostic').getAttribute('data-state'), 'loading');
  assert.doesNotMatch(await page.locator('#friend-diagnostic-output').inputValue(), /share-prepare-v5/);
  await page.evaluate(async build => {
    fixtureState.friendReadReport = { at: Date.now(), seq: 3, build, kind: 'run', phase: 'done', message: '本轮已结束，本次确认发送 1 张卡片，剩余 0 项待发。当前已暂停。' };
    await refresh();
  }, build);
  assert.equal(await page.locator('#friend-diagnostic').getAttribute('data-state'), 'ready');
  assert.equal(await page.locator('#runtime-version').textContent(), '后台 ' + build);
  assert.match(await page.locator('#friend-diagnostic-output').inputValue(), /状态：已结束/);
  for (const [name, viewport] of [['desktop', { width: 1366, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' must not overflow');
    await page.screenshot({ path: path.join(results, `diagnostic-v14-${name}.png`), fullPage: true });
    await page.locator('#friend-diagnostic').screenshot({ path: path.join(results, `diagnostic-v14-${name}-panel.png`) });
  }
  console.log('PASS: old error -> running -> success; actual worker build visible; desktop and 390px layout checked, no external requests or messages.');
} finally { await browser.close(); }
