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
const build = '0.1.0（司凤转发 15）';
async function fixture({ saved, error, persistedError, workerBuild = build, clipboardError = false, manualSend = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://extension-fixture.test/options.html', runScripts: 'outside-only' });
  const { window } = dom;
  window.structuredClone = structuredClone;
  const state = { ...defaultState(), friendReadReport: saved };
  const config = { account: { id: '123', name: '测试账号' }, rules: [], mailBridgeToken: 'secret-must-not-be-copied' };
  const calls = [], copies = [];
  Object.defineProperty(window.navigator, 'clipboard', { value: { async writeText(text) {
    if (clipboardError) throw new Error('clipboard unavailable');
    copies.push(text);
  } } });
  window.chrome = { runtime: { async sendMessage({ type }) {
    calls.push(type);
    if (type === 'STATUS') return { ok: true, data: structuredClone({ state, config, busy: false, workerBuild }) };
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
  return { window, $, state, calls, copies, close: () => window.close() };
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
    assert.match(f.$('friend-diagnostic-output').value, /报告版本：0.1.0（司凤转发 15）/);
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
