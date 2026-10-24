// Render the real options UI with synthetic account/friend data. Every request
// is intercepted; this script cannot reach Douyin, SMTP, or a real extension.
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { defaultState, makeKey } from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/images');
await mkdir(out, { recursive: true });
const files = Object.fromEntries(await Promise.all(['options.html', 'options.css', 'options.js'].map(async name => [name, await readFile(path.join(root, 'extension', name), 'utf8')])));
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
  checkIntervalSeconds: 60, videoWindowMinutes: 60, maxVideosPerWindow: 5,
  mailBridgeToken: 'documentation-fixture-not-a-real-bridge-token',
  rules: [{ id: 'demo-rule', name: '示例：司凤视频转发', tags: ['司凤'], keywords: ['司凤视频'], recipients: recipients.slice(0, 2) }]
};
const video = { id: '1000000000000000001', type: 'video', publishedAt: at - 300000,
  url: 'https://www.douyin.com/video/1000000000000000001', description: '演示：司凤相关视频（非真实检索结果）', tags: [{ id: 'demo-tag', name: '司凤' }] };
const state = { ...defaultState(), friendReadReport: report, preview: [video], lastScanAt: at,
  logs: [{ at, level: 'info', message: '演示：试检索命中 1 条视频，本次未发送。' }] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.BOT_TEST_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(1);
    if (url.origin === 'https://documentation.invalid' && files[name]) return route.fulfill({
      contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', body: files[name]
    });
    await route.abort();
  });
  await page.addInitScript(({ state, config, recipients, build }) => {
    globalThis.docsFixture = { state, config };
    globalThis.chrome = { runtime: { async sendMessage({ type }) {
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
  await page.locator('.primary > .card').nth(0).screenshot({ path: path.join(out, 'bind-account.png') });
  await page.locator('.primary > .card').nth(1).screenshot({ path: path.join(out, 'read-friends.png') });
  await page.locator('.primary > .card').nth(2).screenshot({ path: path.join(out, 'rule-editor.png') });
  await page.locator('aside').screenshot({ path: path.join(out, 'controls-and-mail.png') });
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
  console.log('Rendered 6 screenshots from the real options UI using synthetic data. No external requests or messages.');
} finally { await browser.close(); }
