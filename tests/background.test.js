import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultState, enqueue, reserveDelivery, failDelivery, makeKey } from '../extension/core.js';

const clone = value => structuredClone(value);
const token = 'x'.repeat(40);
const config = () => ({ schemaVersion: 1, maxPages: 1, mailBridgeToken: token,
  account: { id: '123', name: 'bot' }, rules: [{ id: 'r', name: '话题', tags: ['爱慕杰'], keywords: [],
    recipients: [{ id: 'friend-1', name: '好友', avatarKey: 'avatar-1' }] }] });
const video = () => ({ id: '739000000000000001', type: 'video', publishedAt: Date.now() - 1000,
  title: '', description: '话题', tags: [{ id: 'tag-1', name: '爱慕杰' }],
  url: 'https://www.douyin.com/video/739000000000000001' });
function queued(settings = config()) {
  const state = { ...defaultState(), enabled: true };
  enqueue(state, [video()], settings);
  return state;
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Import the actual service worker with only its imports redirected. Every Chrome
// storage read/write clones values just as the real extension API does. No network
// request, real browser action or outgoing message is possible in this harness.
async function harness(t, seed = {}, fetchHandler, respond) {
  const globals = { chrome: globalThis.chrome, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const store = clone({ state: defaultState(), config: config(), ...seed });
  const calls = { fetch: [], scripts: [], alarms: [], access: [], messages: [], debugger: [], windows: [], tabs: [] };
  const listeners = {};
  let tab = { id: 7, windowId: 40, active: true, url: 'https://www.douyin.com/', status: 'complete' };
  let nextWindowId = 41;
  globalThis.chrome = {
    storage: { local: {
      async get(keys) {
        if (typeof keys === 'string') keys = [keys];
        return clone(Object.fromEntries(keys.map(key => [key, store[key]])));
      },
      async set(value) { Object.assign(store, clone(value)); },
      async setAccessLevel(value) { calls.access.push(value); }
    } },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      getPlatformInfo: async () => ({ os: 'win' }), openOptionsPage: async () => {},
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onStartup: { addListener: fn => { listeners.startup = fn; } } },
    alarms: { get: async () => null, clear: async () => true, create: async (...args) => { calls.alarms.push(args); },
      onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
    action: { onClicked: { addListener: fn => { listeners.action = fn; } } },
    windows: {
      get: async (id) => ({ id, focused: false, state: 'normal', tabs: id === tab.windowId ? [clone(tab)] : [] }),
      create: async (options) => {
        calls.windows.push({ op: 'create', options: clone(options) });
        tab = { ...tab, windowId: nextWindowId++, active: true, url: options.url || tab.url };
        return { id: tab.windowId, focused: options.focused, state: 'normal', tabs: [clone(tab)] };
      }
    },
    tabs: { get: async () => clone(tab), query: async () => [clone(tab)],
      reload: async id => { calls.tabs.push({ op: 'reload', id }); },
      create: async options => { calls.tabs.push({ op: 'create', options }); tab = { ...tab, ...options }; return clone(tab); },
      update: async (id, options) => { calls.tabs.push({ op: 'update', id, options }); tab = { ...tab, ...options }; return clone(tab); } },
    // Trusted pointer input is recorded, never delivered to a real browser.
    debugger: {
      async attach(target, version) { calls.debugger.push({ op: 'attach', target, version }); },
      async detach(target) { calls.debugger.push({ op: 'detach', target }); },
      async sendCommand(target, method, params) { calls.debugger.push({ op: method, target, params }); }
    },
    scripting: { async executeScript(options) {
      calls.scripts.push({ ...options, stateAtCall: clone(store.state) });
      const [request] = options.args;
      const action = request.action;
      const custom = respond?.(request);
      if (custom) return [{ result: clone(custom) }];
      return [{ result: action === 'probe' ? clone(store.config.account) :
        action === 'search' ? { payloads: [], truncated: false } :
        action === 'openShare' ? { opened: true } :
        action === 'friends' ? [] :
        action === 'share' && request.mode === 'arm' ? { armed: true, receiptToken: 'fixture-receipt-token' } :
        action === 'share' && request.mode === 'probe' ? { prepared: true, x: 5, y: 6 } : { sent: true } }];
    } }
  };
  globalThis.fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    return fetchHandler ? fetchHandler(url, options) : { ok: true, status: 200, json: async () => ({ configured: true }) };
  };
  // Browser page settling waits are unnecessary in an API mock.
  globalThis.setTimeout = (fn, ms, ...args) => globals.setTimeout(fn, ms === 1200 ? 0 : ms, ...args);
  let source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
  source = source.replace("from './core.js'", `from '${new URL('../extension/core.js', import.meta.url).href}'`)
    .replace("from './pointer.js'", `from '${new URL('../extension/pointer.js', import.meta.url).href}'`)
    .replace("import { browserTask } from './adapter.js';", 'const browserTask = () => {};');
  source += '\nexport { ready, command, cycle, reportIncident };\n';
  const worker = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${crypto.randomUUID()}`);
  await worker.ready;
  const idle = async () => {
    for (let index = 0; index < 1000; index++) {
      if (!(await worker.command({ type: 'STATUS' })).busy) return;
      await new Promise(resolve => globals.setTimeout(resolve, 1));
    }
    throw new Error('Mock background worker did not settle');
  };
  t.after(async () => {
    await idle();
    globalThis.chrome = globals.chrome;
    globalThis.fetch = globals.fetch;
    globalThis.setTimeout = globals.setTimeout;
  });
  return { worker, store, calls, listeners, idle };
}

test('worker startup assigns recovered state, pauses uncertain records and configures trusted storage/alarm', async t => {
  const state = queued();
  reserveDelivery(state, state.deliveries[0].key);
  const { store, calls } = await harness(t, { state });
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.paused, true);
  assert.equal(store.state.incident.notified, false);
  assert.deepEqual(store.state.preview, []);
  assert.deepEqual(calls.access, [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
  assert.deepEqual(calls.alarms, [['douyin-minute', { periodInMinutes: 1 }]]);
  assert.equal(calls.scripts.length, 0);
});

test('only messages from extension pages reach the command handler', async t => {
  const { listeners } = await harness(t);
  let answered = false;
  assert.equal(listeners.message({ type: 'STATUS' }, { id: 'other', url: 'https://www.douyin.com/' }, () => { answered = true; }), false);
  assert.equal(listeners.message({ type: 'STATUS' }, { id: 'test-extension', url: 'https://www.douyin.com/' }, () => { answered = true; }), false);
  assert.equal(answered, false);
  const reply = deferred();
  assert.equal(listeners.message({ type: 'STATUS' }, { id: 'test-extension', url: 'chrome-extension://test-extension/options.html' }, reply.resolve), true);
  assert.equal((await reply.promise).ok, true);
});

test('import validates records, canonicalizes links, recovers uncertainty and always requires manual start', async t => {
  const { worker, store, calls } = await harness(t);
  const backupState = queued();
  reserveDelivery(backupState, backupState.deliveries[0].key);
  backupState.workerTabId = 999;
  backupState.deliveries[0].video.url = 'https://example.invalid/unsafe';
  await worker.command({ type: 'IMPORT', backup: { format: 'douyin-watch-backup', version: 1, config: config(), state: backupState } });
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.paused, true);
  assert.equal(store.state.workerTabId, null);
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.deliveries[0].video.url, video().url);
  assert.equal(calls.scripts.length, 0);
  const invalid = clone(backupState);
  invalid.deliveries[0].video.id = 'https://example.invalid/';
  invalid.deliveries[0].key = makeKey(invalid.deliveries[0].accountId, invalid.deliveries[0].video.id, invalid.deliveries[0].recipient.id);
  await assert.rejects(worker.command({ type: 'IMPORT', backup: { format: 'douyin-watch-backup', version: 1, config: config(), state: invalid } }), /无效视频/);
  assert.equal(store.state.deliveries[0].video.id, video().id);
});

test('save cannot forge account binding or mutate running configuration; draft save works', async t => {
  const { worker, store } = await harness(t);
  const forged = config();
  forged.account.id = '999';
  await assert.rejects(worker.command({ type: 'SAVE', config: forged }), /账号绑定/);
  assert.equal(store.config.account.id, '123');
  store.state.enabled = true;
  await assert.rejects(worker.command({ type: 'SAVE', config: config() }), /暂停/);
  await worker.command({ type: 'PAUSE' });
  const edited = config();
  edited.rules[0].keywords = ['新品'];
  await worker.command({ type: 'SAVE', config: edited });
  assert.deepEqual(store.config.rules[0].keywords, ['新品']);
});

test('export disables execution and strips local email token and worker tab identity', async t => {
  const state = queued();
  state.workerTabId = 7;
  const { worker, store } = await harness(t, { state });
  const backup = await worker.command({ type: 'EXPORT' });
  assert.equal(backup.format, 'douyin-watch-backup');
  assert.equal(backup.state.enabled, false);
  assert.equal(backup.state.workerTabId, null);
  assert.equal(backup.config.mailBridgeToken, '');
  assert.equal(store.config.mailBridgeToken, token);
});

test('unknown records prevent start before any email health check or browser work', async t => {
  const state = queued();
  failDelivery(state, state.deliveries[0].key, '发送结果不确定');
  const { worker, calls } = await harness(t, { state });
  await assert.rejects(worker.command({ type: 'START' }), /待核对/);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.scripts.length, 0);
});

test('incident notification sends ISO time once, and respects all mail-bridge field limits', async t => {
  const settings = config();
  settings.account.name = 'b'.repeat(250);
  settings.rules[0].recipients[0].id = 'avatar:' + 'x'.repeat(300);
  const state = queued(settings);
  failDelivery(state, state.deliveries[0].key, 'r'.repeat(2400));
  const { worker, store, calls } = await harness(t, { config: settings, state });
  await worker.reportIncident();
  assert.equal(calls.fetch.length, 1);
  const payload = JSON.parse(calls.fetch[0].options.body);
  assert.match(payload.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(payload.incidentId.length <= 160, `incidentId length ${payload.incidentId.length}`);
  assert.ok(payload.reason.length <= 2000);
  assert.ok(payload.accountName.length <= 200);
  assert.equal(calls.fetch[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(store.state.incident.notified, true);
  await worker.reportIncident();
  assert.equal(calls.fetch.length, 1);
});

test('failed incident delivery remains paused and retryable without claiming notification success', async t => {
  const state = queued();
  failDelivery(state, state.deliveries[0].key, '登录过期');
  const { worker, store, calls } = await harness(t, { state }, async () => ({ ok: false, status: 503 }));
  await worker.reportIncident();
  assert.equal(store.state.paused, true);
  assert.equal(store.state.incident.notified, false);
  assert.match(store.state.incident.mailError, /邮件未能送达/);
  await worker.reportIncident();
  assert.equal(calls.fetch.length, 2);
});

test('a later PAUSE cancels a START waiting for email service and cannot be overwritten', async t => {
  const healthEntered = deferred(), healthResponse = deferred();
  const { worker, store, idle, calls } = await harness(t, {}, async url => {
    if (url.endsWith('/check')) { healthEntered.resolve(); return healthResponse.promise; }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const start = worker.command({ type: 'START' });
  await healthEntered.promise;
  await worker.command({ type: 'PAUSE' });
  healthResponse.resolve({ ok: true, status: 200, json: async () => ({ configured: true }) });
  await start.catch(() => {}); // A cancelled start may reject or report cancellation.
  await idle();
  assert.equal(store.state.enabled, false);
  assert.equal(calls.scripts.length, 0);
});

test('configuration edits cancel an in-flight start and remove pending tasks no longer matching rules', async t => {
  const healthEntered = deferred(), healthResponse = deferred();
  const state = queued();
  state.enabled = false;
  const { worker, store, calls } = await harness(t, { state }, async () => {
    healthEntered.resolve();
    return healthResponse.promise;
  });
  const start = worker.command({ type: 'START' });
  await healthEntered.promise;
  const edited = config();
  edited.rules[0].tags = ['其他话题'];
  await worker.command({ type: 'SAVE', config: edited });
  healthResponse.resolve({ ok: true, status: 200, json: async () => ({ configured: true }) });
  await assert.rejects(start, /取消/);
  assert.equal(store.state.enabled, false);
  assert.deepEqual(store.state.deliveries, []);
  assert.equal(calls.scripts.length, 0);
});

test('automatic cycle persists sending before share UI and marks sent only after confirmed success', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() });
  await worker.cycle();
  const shares = calls.scripts.filter(call => call.args[0].action === 'share');
  assert.deepEqual(shares.map(call => call.args[0].mode).sort(), ['arm', 'confirm', 'probe']);
  assert.equal(shares.at(-1).args[0].receiptToken, 'fixture-receipt-token');
  assert.equal(shares[0].stateAtCall.deliveries[0].status, 'sending');
  assert.equal(shares[0].world, 'ISOLATED');
  assert.equal(shares[0].stateAtCall.rate.length, 1);
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(store.state.paused, false);
});

test('all recipients of one video share one page load and pointer session before moving to the next video', async t => {
  const settings = config();
  settings.rules[0].recipients = ['a','b','c'].map(id => ({ id, name: id, avatarKey: 'avatar-' + id }));
  const state = queued(settings);
  const second = { ...video(), id: '739000000000000002' };
  enqueue(state, [second], settings);
  const confirmed = [];
  const { worker, store, calls } = await harness(t, { state, config: settings }, undefined, request => {
    if (request.action === 'share' && request.mode === 'confirm') confirmed.push([request.videoId, request.recipient.id]);
    return null;
  });
  await worker.cycle();
  assert.deepEqual(confirmed, [video().id, second.id].flatMap(id => ['a','b','c'].map(friend => [id, friend])));
  assert.equal(store.state.deliveries.every(d => d.status === 'sent'), true);
  const navigations = calls.tabs.filter(call => call.op === 'update' && call.options.url.includes('/video/'));
  assert.deepEqual(navigations.map(call => call.options.url), [video().url, 'https://www.douyin.com/video/' + second.id]);
  assert.equal(calls.debugger.filter(call => call.op === 'attach').length, 2);
});

test('the 50-card budget finishes the open video group before stopping ahead of the next video', async t => {
  const settings = config();
  settings.rules[0].recipients = Array.from({ length: 51 }, (_, n) => ({ id: 'friend-' + n, name: '好友' + n, avatarKey: 'avatar-' + n }));
  const state = queued(settings);
  enqueue(state, [{ ...video(), id: '739000000000000002' }], settings);
  const { worker, store, calls } = await harness(t, { state, config: settings });
  const timer = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, [30,40,80].includes(ms) ? 0 : ms, ...args);
  await worker.cycle();
  assert.equal(store.state.deliveries.filter(d => d.status === 'sent').length, 51);
  assert.equal(store.state.deliveries.filter(d => d.status === 'pending').length, 51);
  assert.equal(store.state.deliveries.filter(d => d.status === 'sent').every(d => d.video.id === video().id), true);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 1);
  assert.equal(store.state.activeVideoId, null);
});

test('interleaved pending records finish the current video before opening a different video', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '好友二', avatarKey: 'avatar-2' });
  const state = queued(settings);
  enqueue(state, [{ ...video(), id: '739000000000000002' }], settings);
  state.deliveries = [state.deliveries[0], state.deliveries[2], state.deliveries[1], state.deliveries[3]];
  const confirmed = [];
  const { worker, calls } = await harness(t, { state, config: settings }, undefined, request => {
    if (request.action === 'share' && request.mode === 'confirm') confirmed.push(request.videoId);
    return null;
  });
  await worker.cycle();
  assert.deepEqual(confirmed, [video().id, video().id, '739000000000000002', '739000000000000002']);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 2);
});

test('manual pause between recipients resumes the same video without a new search or page refresh', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '好友二', avatarKey: 'avatar-2' });
  let liveStore, stopAfterFirst = true;
  const { worker, store, calls, idle } = await harness(t, { state: queued(settings), config: settings }, undefined, request => {
    if (stopAfterFirst && request.action === 'share' && request.mode === 'confirm') {
      stopAfterFirst = false; liveStore.state.enabled = false;
    }
    return null;
  });
  liveStore = store;
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'pending']);
  assert.equal(store.state.activeVideoId, video().id);
  await worker.command({ type: 'START' });
  await idle();
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'sent']);
  assert.equal(store.state.activeVideoId, null);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'search').length, 1);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 1);
});

test('a different actual video in the work tab is navigated back instead of reusing stale page state', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '好友二', avatarKey: 'avatar-2' });
  let redirected = false;
  const { worker, store, calls } = await harness(t, { state: queued(settings), config: settings }, undefined, request => {
    if (request.action === 'share' && request.mode === 'confirm' && request.recipient.id === 'friend-1') redirected = true;
    return null;
  });
  const getTab = globalThis.chrome.tabs.get;
  globalThis.chrome.tabs.get = async id => {
    const tab = await getTab(id);
    if (redirected) { redirected = false; tab.url = 'https://www.douyin.com/video/739000000000000099'; }
    return tab;
  };
  await worker.cycle();
  assert.equal(store.state.deliveries.every(d => d.status === 'sent'), true);
  assert.equal(calls.tabs.filter(call => call.options.url === video().url).length, 2);
});

test('an uncertain recipient stops the group; manual resolution resumes only the remaining recipients on the same page', async t => {
  const settings = config();
  settings.rules[0].recipients = ['a','b','c'].map(id => ({ id, name: id, avatarKey: 'avatar-' + id }));
  const state = queued(settings);
  const confirms = [];
  const { worker, store, calls, idle } = await harness(t, { state, config: settings }, undefined, request => {
    if (request.action === 'share' && request.mode === 'confirm') {
      confirms.push(request.recipient.id);
      if (request.recipient.id === 'b') return { error: '未捕获明确的发送回执' };
    }
    return null;
  });
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent','unknown','pending']);
  assert.deepEqual(confirms, ['a','b']);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 1);
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /待核对/);
  await worker.command({ type: 'RESOLVE', key: store.state.deliveries[1].key, action: 'sent' });
  await worker.command({ type: 'SEND_PENDING' });
  await idle();
  assert.deepEqual(confirms, ['a','b','c']);
  assert.equal(store.state.deliveries.every(d => d.status === 'sent'), true);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 1, 'resuming the same loaded video must not refresh it');
});

test('receipt capture is armed before the first press and its token is passed to confirmation', async t => {
  let armed = false;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'arm') {
      armed = true;
      assert.equal(calls.debugger.some(call => call.params?.type === 'mousePressed'), false);
      assert.deepEqual(request.point, { x: 5, y: 6 });
      return { armed: true, receiptToken: 'current-send-only' };
    }
    if (request.action === 'share' && request.mode === 'confirm') {
      assert.equal(armed, true);
      assert.equal(request.receiptToken, 'current-send-only');
      assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
    }
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
});

test('a changed hit target blocks the actual press and leaves the delivery pending', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'arm' ? { error: '分享控件在点击前发生变化，尚未点击发送', code: 'SHARE_TARGET_CHANGED' } : null);
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.some(call => call.params?.type === 'mousePressed'), false);
  assert.equal(calls.scripts.some(call => call.args[0].mode === 'confirm'), false);
});

test('a transient pre-press movement is relocated on the same page and sends exactly once', async t => {
  let probes = 0, arms = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe') return { prepared: true, x: ++probes * 10, y: 30 };
    if (request.action === 'share' && request.mode === 'arm' && ++arms === 1) return {
      error: '鼠标落点变化，尚未点击发送', code: 'SHARE_TARGET_CHANGED', retryable: true, details: { reason: 'hit-mismatch' }
    };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(probes, 2);
  assert.equal(arms, 2);
  const presses = calls.debugger.filter(call => call.params?.type === 'mousePressed');
  assert.equal(presses.length, 1);
  assert.equal(presses[0].params.x, 20);
  assert.equal(calls.scripts.filter(call => call.args[0].reopen).length, 1);
  assert.equal(calls.tabs.filter(call => call.options.url?.includes('/video/')).length, 1);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('persistent pre-press changes stop after two relocations without any actual press', async t => {
  let arms = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'arm') {
      arms++;
      return { error: '鼠标落点变化，尚未点击发送', code: 'SHARE_TARGET_CHANGED', retryable: true, details: { reason: 'hit-mismatch' } };
    }
    return null;
  });
  await worker.cycle();
  assert.equal(arms, 3);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.scripts.filter(call => call.args[0].reopen).length, 2);
  assert.equal(calls.debugger.some(call => call.params?.type === 'mousePressed'), false);
  assert.match(store.state.friendReadReport.error, /hit-mismatch/);
});

test('pausing after a blocked pre-press check cancels relocation and never sends an alert', async t => {
  let liveStore;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'arm') {
      liveStore.state.enabled = false;
      return { error: '鼠标落点变化，尚未点击发送', code: 'SHARE_TARGET_CHANGED', retryable: true };
    }
    return null;
  });
  liveStore = store;
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(calls.scripts.some(call => call.args[0].reopen), false);
  assert.equal(calls.debugger.some(call => call.params?.type === 'mousePressed'), false);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('a retryable-looking error after mousePressed is still unknown and is never relocated or clicked again', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() });
  const dispatch = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    await dispatch(target, method, params);
    if (params?.type === 'mousePressed') {
      const error = new Error('Detached while handling command.');
      error.code = 'SHARE_TARGET_CHANGED'; error.retryable = true;
      throw error;
    }
  };
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
  assert.equal(calls.scripts.filter(call => call.args[0].mode === 'arm').length, 1);
  assert.equal(calls.scripts.some(call => call.args[0].reopen), false);
});

test('an old worker hidden behind the settings tab is moved to its own unfocused window before sending', async t => {
  const state = queued(); state.workerTabId = 7; state.workerWindowId = 40;
  const { worker, store, calls } = await harness(t, { state }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe' && !calls.windows.some(call => call.options.tabId === 7)) {
      return { code: 'SHARE_PANEL_EMPTY', error: '设置页所在窗口的隐藏抖音标签未加载好友行' };
    }
    return null;
  });
  const getWindow = globalThis.chrome.windows.get;
  globalThis.chrome.windows.get = async (id, options) => id === 40 ? {
    id, focused: true, state: 'normal', tabs: [
      { id: 7, windowId: 40, active: false }, { id: 8, windowId: 40, active: true, url: 'chrome-extension://test-extension/options.html' }
    ]
  } : getWindow(id, options);
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(store.state.workerWindowId, 41);
  assert.deepEqual(calls.windows.map(call => call.options), [{ tabId: 7, focused: false, type: 'normal' }]);
  assert.equal(calls.tabs.some(call => call.options?.active), false, 'never switch away from the settings tab');
  assert.equal(calls.debugger.some(call => call.op === 'Page.bringToFront'), false);
});

test('a healthy existing single-tab worker window is reused without creating more windows', async t => {
  const state = queued(); state.workerTabId = 7; state.workerWindowId = 40;
  const { worker, store, calls } = await harness(t, { state });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(calls.windows.length, 0);
  assert.equal(store.state.workerWindowId, 40);
});

test('failure to create an independent worker window pauses instead of falling back to a hidden tab', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() });
  globalThis.chrome.windows.create = async () => { throw new Error('Window unavailable'); };
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.tabs.some(call => call.op === 'create'), false);
  assert.equal(calls.scripts.length, 0);
});

test('manual queue sending skips search, preserves last results, stops monitoring and never repeats a sent card', async t => {
  const state = queued();
  state.deliveries[0].status = 'sent';
  enqueue(state, [{ ...video(), id: '739000000000000002' }], config());
  state.enabled = false; state.paused = true;
  state.lastScanAt = 12345; state.preview = [video()];
  const { worker, store, calls, idle } = await harness(t, { state });
  assert.deepEqual(await worker.command({ type: 'SEND_PENDING' }), { started: true, queueOnly: true });
  await idle();
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'sent']);
  assert.equal(calls.scripts.some(call => call.args[0].action === 'search'), false);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share' && call.args[0].mode === 'confirm').length, 1);
  assert.equal(store.state.lastScanAt, 12345);
  assert.deepEqual(store.state.preview, state.preview);
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.runMode, null);
  await worker.cycle(); // A later alarm must not start a new query.
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /没有可发送/);
  assert.equal(calls.scripts.some(call => call.args[0].action === 'search'), false);
});

test('manual queue sending can use the previous dry-run preview without another search', async t => {
  const state = { ...defaultState(), preview: [video()] };
  const { worker, store, calls, idle } = await harness(t, { state });
  await worker.command({ type: 'SEND_PENDING' });
  await idle();
  assert.equal(store.state.deliveries.length, 1);
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(calls.scripts.some(call => call.args[0].action === 'search'), false);
  assert.equal(calls.fetch[0].url.endsWith('/check'), true);
  assert.equal(store.state.enabled, false);
});

test('manual queue sending blocks uncertain records before health checks or browser work', async t => {
  const state = queued(); state.enabled = false;
  failDelivery(state, state.deliveries[0].key, '发送结果不确定');
  const { worker, store, calls } = await harness(t, { state });
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /待核对/);
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.scripts.length, 0);
});

test('manual queue sending respects the existing rate limit and leaves the queue ready for a later click', async t => {
  const state = queued(); state.enabled = false;
  state.rate = Array.from({ length: 5 }, (_, n) => ({ videoId: String(n + 1), at: Date.now() }));
  const { worker, store, calls, idle } = await harness(t, { state });
  await worker.command({ type: 'SEND_PENDING' });
  await idle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.enabled, false);
  assert.equal(calls.scripts.length, 0);
  assert.match(store.state.logs[0].message, /剩余 1 项待发/);
});

test('manual queue sending cannot start without the local mail service', async t => {
  const state = queued(); state.enabled = false;
  const { worker, store, calls } = await harness(t, { state }, async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /无法连接本地邮件服务/);
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(calls.scripts.length, 0);
});

test('a later pause cancels manual queue sending while its email check is pending', async t => {
  const entered = deferred(), response = deferred();
  const state = queued(); state.enabled = false;
  const { worker, store, calls } = await harness(t, { state }, async () => { entered.resolve(); return response.promise; });
  const start = worker.command({ type: 'SEND_PENDING' });
  await entered.promise;
  await worker.command({ type: 'PAUSE' });
  response.resolve({ ok: true, status: 200, json: async () => ({ configured: true }) });
  await assert.rejects(start, /取消/);
  assert.equal(store.state.enabled, false);
  assert.equal(calls.scripts.length, 0);
});

test('a failed manual send remains uncertain and paused instead of automatically retrying', async t => {
  const state = queued(); state.enabled = false;
  const { worker, store, calls, idle } = await harness(t, { state }, undefined, request =>
    request.action === 'share' && request.mode === 'confirm' ? { error: '未确认分享成功' } : null);
  await worker.command({ type: 'SEND_PENDING' });
  await idle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.paused, true);
  assert.equal(store.state.enabled, false);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share' && call.args[0].mode === 'confirm').length, 1);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
});

test('reloading an interrupted manual run cannot enable automatic monitoring', async t => {
  const state = queued(); state.runMode = 'queue-only';
  reserveDelivery(state, state.deliveries[0].key);
  const { worker, store, calls } = await harness(t, { state });
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.runMode, null);
  assert.equal(store.state.deliveries[0].status, 'unknown');
  await worker.cycle();
  assert.equal(calls.scripts.length, 0);
});

test('manual sending rejects empty, stale or no-longer-matching previews without querying', async t => {
  const state = { ...defaultState(), preview: [{ ...video(), publishedAt: Date.now() - 7200000 }] };
  const { worker, store, calls } = await harness(t, { state });
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /没有可发送/);
  store.state.preview = [{ ...video(), tags: [], description: '无匹配词' }];
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /没有可发送/);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.scripts.length, 0);
  assert.equal(store.state.enabled, false);
});

test('a missing share icon is retried without bringing the tab forward', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, (request) => {
    if (request.action !== 'openShare') return null;
    opens++;
    return opens === 1 ? { error: '无法唯一识别当前视频的分享按钮（找到 0 个，播放器 0 个）' } : { opened: true };
  });
  await worker.cycle();
  assert.equal(opens, 2);
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false, 'background recovery must not steal focus');
  assert.equal(store.state.deliveries[0].status, 'sent');
});

test('a hover-gated panel is opened and clicked only through trusted pointer input', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, (request) => {
    if (request.action === 'openShare') {
      opens++;
      return opens === 1 ? { opened: false, needsPointer: true, x: 10, y: 20 } : { opened: true };
    }
    if (request.action === 'share' && request.mode === 'probe') return { prepared: true, x: 30, y: 40, uid: '1' };
    if (request.action === 'share' && request.mode === 'confirm') return { sent: true };
    return null;
  });
  await worker.cycle();
  const attach = calls.debugger.filter(call => call.op === 'attach');
  assert.equal(attach.length, 1);
  const moves = calls.debugger.filter(call => call.op === 'Input.dispatchMouseEvent');
  assert.deepEqual(moves.slice(0, 3).map(call => [call.params.type, call.params.x, call.params.y]),
    [['mouseMoved', 1, 1], ['mouseMoved', 9, 19], ['mouseMoved', 10, 20]]);
  const pressed = moves.filter(call => call.params.type === 'mousePressed');
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].params.x, 30);
  assert.equal(pressed[0].params.buttons, 1);
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(calls.debugger.filter(call => call.op === 'detach').length, 1);
});

test('a second background hover attempt never activates the foreground window', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return ++opens <= 9 ? { opened: false, needsPointer: true, x: 10, y: 20 } : { opened: true };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
});

test('a pointer already inside the share icon leaves and reenters before opening, but never leaves before sending', async t => {
  let inside = true, opened = false, preparing = false;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return opened ? { opened: true } : { needsPointer: true, x: 100, y: 200 };
    if (request.action === 'share' && request.mode === 'probe') {
      preparing = true;
      return { prepared: true, x: 110, y: 210 };
    }
    return null;
  });
  const dispatch = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    await dispatch(target, method, params);
    if (method !== 'Input.dispatchMouseEvent' || params.type !== 'mouseMoved') return;
    const nextInside = params.x >= 80 && params.x <= 120 && params.y >= 180 && params.y <= 220;
    if (preparing) assert.equal(nextInside, true, 'moving out of the open popover would close it before sending');
    if (!inside && nextInside) opened = true;
    inside = nextInside;
  };
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent', 'a real exit/entry is required when the pointer starts inside');
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
  assert.equal(calls.debugger.filter(entry => entry.params?.type === 'mousePressed').length, 1, 'only the actual send is clicked');
});

test('an unavailable background panel pauses before sending and saves complete readable diagnostics', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return { needsPointer: true, x: 464, y: 966 };
    if (request.action === 'shareDebug') return {
      arrow: { h: 46, tabindex: '0', w: 42, x: 443, y: 943 }, dpr: 1.25, focused: true,
      hit: { cls: '[object SVGAnimatedString]', e2e: '', tag: 'path' },
      href: 'https://www.douyin.com/video/' + '1'.repeat(160),
      visibility: 'hidden', viewport: '1920x1080', scrollY: 0,
      panel: { found: false }, popover: null, userids: 0, point: { x: 464, y: 966 }
    };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.paused, true);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(calls.scripts.some(entry => entry.args[0].action === 'share'), false);
  const report = store.state.friendReadReport;
  assert.ok(report?.at);
  assert.match(report.error, /share-hover-v7/);
  const detail = JSON.parse(report.error.split('\n').at(-1));
  assert.equal(detail.visibility, 'hidden');
  assert.equal(detail.viewport, '1920x1080');
  assert.deepEqual(detail.point, { x: 464, y: 966 });
  assert.deepEqual(detail.arrow, { h: 46, tabindex: '0', w: 42, x: 443, y: 943 });
  assert.equal(detail.userids, 0);
  assert.equal(detail.hit.tag, 'path');
  assert.equal('href' in detail, false, 'omit the video URL from the copyable report');
  assert.equal('cls' in detail.hit, false);
  assert.match(store.state.incident.reason, /复制诊断结果/);
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
});

test('a safety challenge during panel polling pauses without clicking the covered page', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return ++opens === 1 ? { opened: false, needsPointer: true, x: 10, y: 20 } : { error: '抖音要求安全验证' };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
  assert.equal(calls.debugger.filter(entry => entry.params?.type === 'mousePressed').length, 0);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
});

test('without debugger access the panel falls back to the scripted click path', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, (request) =>
    request.action === 'openShare' ? { opened: true } : null);
  globalThis.chrome.debugger.attach = async () => { throw new Error('Another debugger is already attached'); };
  await worker.cycle();
  const shares = calls.scripts.filter(call => call.args[0].action === 'share');
  assert.equal(shares.length, 1);
  assert.equal(shares[0].args[0].mode, undefined);
  assert.equal(store.state.deliveries[0].status, 'sent');
});

test('a discarded tab before the click requeues the task instead of pausing', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, (request) => {
    if (request.action === 'openShare') return { opened: true };
    if (request.action === 'share' && request.mode === 'probe') return { error: 'Detached while handling command.' };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.paused, false, 'a browser hiccup must not pause the bot');
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.match(store.state.deliveries[0].error, /Detached/);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0, 'no incident email for a requeue');
});

test('a detach after the click still stays uncertain and pauses', async t => {
  const { worker, store } = await harness(t, { state: queued() }, undefined, (request) => {
    if (request.action === 'openShare') return { opened: true };
    if (request.action === 'share' && request.mode === 'probe') return { prepared: true, x: 5, y: 6 };
    if (request.action === 'share' && request.mode === 'confirm') return { error: 'Detached while handling command.' };
    return null;
  });
  await worker.cycle();
  assert.equal(store.state.paused, true);
  assert.equal(store.state.deliveries[0].status, 'unknown');
});

test('an empty second panel is reopened once without repeating the first confirmed card', async t => {
  const state = queued();
  const second = { ...video(), id: '739000000000000002', url: 'https://www.douyin.com/video/739000000000000002' };
  enqueue(state, [second], config());
  let secondProbes = 0;
  const { worker, store, calls } = await harness(t, { state }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe' && request.videoId === second.id && secondProbes++ === 0) {
      return { error: '分享面板未加载好友行；尚未点击发送', code: 'SHARE_PANEL_EMPTY' };
    }
    return null;
  });
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(item => item.status), ['sent', 'sent']);
  assert.equal(secondProbes, 2);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share' && call.args[0].mode === 'confirm').length, 2);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 2);
  assert.ok(calls.scripts.some(call => call.args[0].action === 'openShare' && call.args[0].reopen));
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
});

test('an empty second panel after bounded recovery stays pending and pauses without marking it uncertain', async t => {
  const state = queued();
  const second = { ...video(), id: '739000000000000002', url: 'https://www.douyin.com/video/739000000000000002' };
  enqueue(state, [second], config());
  let probes = 0;
  const { worker, store, calls } = await harness(t, { state }, undefined, request => {
    if (request.action === 'shareDebug') return {
      visibility: 'hidden', focused: true, viewport: '2040x974', panel: { found: true }, rows: 0, userids: 0
    };
    if (request.action === 'share' && request.mode === 'probe' && request.videoId === second.id) {
      probes++;
      return { error: '分享面板未加载好友行；尚未点击发送', code: 'SHARE_PANEL_EMPTY' };
    }
    return null;
  });
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(item => item.status), ['sent', 'pending']);
  assert.equal(probes, 2);
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
  const snapshot = JSON.parse(store.state.friendReadReport.error.split('\n').at(-1));
  assert.equal(snapshot.revision, 'share-prepare-v9');
  assert.equal(snapshot.visibility, 'hidden');
  assert.equal(snapshot.viewport, '2040x974');
  assert.deepEqual(snapshot.browser, { tabActive: true, windowFocused: false, windowState: 'normal', tabsInWindow: 1, ownWindow: true });
});

test('a debugger failure during the send click stays uncertain and never requeues the card', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() });
  const send = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    await send(target, method, params);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') throw new Error('Detached while handling command.');
  };
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mouseReleased').length, 1);
});

test('a lost mouse-press acknowledgement is not retried and remains uncertain', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() });
  const send = globalThis.chrome.debugger.sendCommand;
  globalThis.chrome.debugger.sendCommand = async (target, method, params) => {
    await send(target, method, params);
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') throw new Error('Detached while handling command.');
  };
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
});

test('pausing while an empty panel is being prepared cancels recovery without any send click', async t => {
  let currentStore;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe') {
      currentStore.state.enabled = false;
      return { error: '分享面板未加载好友行；尚未点击发送', code: 'SHARE_PANEL_EMPTY' };
    }
    return null;
  });
  currentStore = store;
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.enabled, false);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('mismatched account queues stop before opening share and notify instead of sending', async t => {
  const other = config();
  other.account.id = '456';
  const { worker, store, calls } = await harness(t, { state: queued(other) });
  await worker.cycle();
  assert.equal(calls.scripts.filter(call => ['openShare', 'share'].includes(call.args[0].action)).length, 0);
  assert.equal(store.state.paused, true);
  assert.match(store.state.incident.reason, /其他账号/);
  assert.equal(store.state.incident.notified, true);
});

test('import rejects forged delivery keys and pending tasks for another bound account', async t => {
  const { worker } = await harness(t);
  const backup = { format: 'douyin-watch-backup', version: 1, config: config(), state: queued() };
  backup.state.deliveries[0].key = 'forged';
  await assert.rejects(worker.command({ type: 'IMPORT', backup }), /记录或账号不一致/);
  const other = config();
  other.account.id = '456';
  backup.state = queued(other);
  await assert.rejects(worker.command({ type: 'IMPORT', backup }), /记录或账号不一致/);
});

test('the scan window follows the configured minutes instead of a fixed hour', async t => {
  const now = Date.now();
  const old = { aweme_id: '739000000000000777', video: { play_addr: {} }, aweme_type: 0,
    create_time: Math.floor((now - 2 * 3600 * 1000) / 1000), desc: '爱慕杰 旧视频',
    text_extra: [{ type: 1, hashtag_id: 'tag-1', hashtag_name: '爱慕杰' }] };
  const { worker, store } = await harness(t, {}, undefined, (request) => request.action === 'search'
    ? { payloads: [{ status_code: 0, data: [{ aweme_info: old }] }], truncated: false } : null);
  assert.equal((await worker.command({ type: 'SCAN' })).count, 0, 'two hours old is outside a one hour window');
  assert.match(store.state.logs[0].message, /读取 1 条视频，符合规则 1 条，窗口 60 分钟内 0 条/);
  store.config.videoWindowMinutes = 1440;
  assert.equal((await worker.command({ type: 'SCAN' })).count, 1, 'the same video is inside a one day window');
});

test('the alarm period follows the configured check interval and is resaved on edit', async t => {
  const settings = config();
  settings.checkIntervalSeconds = 120;
  const { worker, calls } = await harness(t, { config: settings });
  assert.deepEqual(calls.alarms.at(-1), ['douyin-minute', { periodInMinutes: 2 }]);
  const edited = config();
  edited.checkIntervalSeconds = 90;
  await worker.command({ type: 'SAVE', config: edited });
  assert.deepEqual(calls.alarms.at(-1), ['douyin-minute', { periodInMinutes: 1.5 }]);
});

test('friend reading accepts a video opened as a feed modal and prefers the video page', async t => {
  const { worker, calls } = await harness(t, {});
  globalThis.chrome.tabs.query = async () => [
    { id: 7, url: 'https://www.douyin.com/?recommend=1&modal_id=739000000000000001', status: 'complete', active: true },
    { id: 9, url: 'https://www.douyin.com/video/739000000000000002', status: 'complete' }
  ];
  assert.deepEqual(await worker.command({ type: 'FRIENDS' }), []);
  const open = calls.scripts.find(call => call.args[0].action === 'openShare');
  assert.equal(open.target.tabId, 9);
});

test('a modal-only video page is still read instead of being rejected', async t => {
  const { worker, calls } = await harness(t, {});
  globalThis.chrome.tabs.query = async () => [
    { id: 11, url: 'https://www.douyin.com/?recommend=1&modal_id=739000000000000003', status: 'complete', active: true }
  ];
  assert.deepEqual(await worker.command({ type: 'FRIENDS' }), []);
  assert.equal(calls.scripts.find(call => call.args[0].action === 'openShare').target.tabId, 11);
});

test('diagnostics report each failure step into the run log without sending', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, {}, undefined, request =>
    request.action === 'openShare' && ++opens === 1 ? { needsPointer: true, x: 100, y: 200 } : null);
  const result = await worker.command({ type: 'DIAGNOSE' });
  assert.ok(Array.isArray(result.report) && result.report.length >= 3);
  const text = store.state.logs.map(entry => entry.message).join('\n');
  assert.match(text, /调试接口 可用/);
  assert.match(text, /面板首次探测/);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share').length, 0);
  assert.equal(calls.debugger.some(entry => entry.op === 'Page.bringToFront'), false);
  assert.deepEqual(calls.debugger.filter(entry => entry.params?.type === 'mouseMoved').map(entry => [entry.params.x, entry.params.y]),
    [[1, 1], [99, 199], [100, 200]]);
});

test('friend read statistics reach the run log and UI without exposing friend identities', async t => {
  const report = {
    friends: [{ id: 'uid:7000000000000000991', uid: '7000000000000000991', name: '仅在选择列表显示的好友' }],
    diagnostics: { revision: 'friends-v2', firstScreen: { controls: 2, recognized: 1, rejected: 1 },
      observed: 2, recognized: 1, unrecognized: 1, stop: 'single-screen',
      rejectionCounts: { 'name-missing': 1 }, samples: [{ reason: 'name-missing', shape: [{ tag: 'DIV', children: 1, nameCandidates: 0 }] }] }
  };
  const { worker, store, calls } = await harness(t, {}, undefined,
    request => request.action === 'friends' ? report : null);
  globalThis.chrome.tabs.query = async () => [{ id: 9, url: 'https://www.douyin.com/video/739000000000000002', status: 'complete' }];
  const result = await worker.command({ type: 'FRIENDS' });
  assert.deepEqual(result, report);
  assert.deepEqual(store.state.friendReadReport.diagnostics, report.diagnostics);
  assert.equal(store.state.friendReadReport.total, 1);
  const logs = store.state.logs.map(entry => entry.message).join('\n');
  assert.match(logs, /首屏发现 2 个 UID，识别 1，跳过 1/u);
  assert.match(logs, /未找到昵称 1/u);
  assert.doesNotMatch(logs, /7000000000000000991|仅在选择列表/u);
  assert.equal(calls.scripts.find(call => call.args[0].action === 'friends').args[0].diagnostics, true);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share').length, 0);
  assert.equal(calls.fetch.length, 0);
});

test('email readiness uses the authenticated check endpoint', async t => {
  const { worker, calls } = await harness(t);
  await worker.command({ type: 'MAIL_HEALTH' });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, 'http://127.0.0.1:17321/check');
  assert.equal(calls.fetch[0].options.headers.Authorization, `Bearer ${token}`);
});

test('starting with a disconnected mail bridge gives a clear error before enabling or sending', async t => {
  const { worker, store, calls } = await harness(t, {}, () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(worker.command({ type: 'START' }), /无法连接本地邮件服务/u);
  assert.equal(store.state.enabled, false);
  assert.equal(calls.scripts.length, 0);
  assert.equal(calls.debugger.length, 0);
  assert.ok(calls.fetch.every(call => call.url.endsWith('/check')));
});

test('a rejected mail token is distinguished from a network failure', async t => {
  const { worker } = await harness(t, {}, () => ({ ok: false, status: 401 }));
  await assert.rejects(worker.command({ type: 'MAIL_HEALTH' }), /连接令牌不匹配/u);
});

const diagnosticBuild = '0.1.0（司凤转发 15）';
function oldDiagnostic(state = queued()) {
  state.friendReadReport = { at: 1, error: '发送前检查失败（share-prepare-v5）' };
  return state;
}

test('a successful cycle replaces an old preparation error, including a persisted running phase', async t => {
  const { worker, store, calls } = await harness(t, { state: oldDiagnostic() });
  await worker.cycle();
  const running = calls.scripts[0].stateAtCall.friendReadReport;
  assert.equal(running.phase, 'running');
  assert.equal(running.build, diagnosticBuild);
  const report = store.state.friendReadReport;
  assert.equal(report.phase, 'done');
  assert.equal(report.sent, 1);
  assert.equal(report.remaining, 0);
  assert.ok(report.seq > running.seq);
  assert.equal(report.error, undefined);
  assert.doesNotMatch(JSON.stringify(report), /share-prepare-v5/);
  assert.equal((await worker.command({ type: 'STATUS' })).workerBuild, diagnosticBuild);
});

test('a generic post-click failure replaces old diagnostics while preserving uncertain delivery safety', async t => {
  const { worker, store, calls } = await harness(t, { state: oldDiagnostic() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'confirm') throw new Error('未捕获明确的发送回执');
  });
  await worker.cycle();
  assert.equal(store.state.friendReadReport.phase, 'error');
  assert.equal(store.state.friendReadReport.build, diagnosticBuild);
  assert.match(store.state.friendReadReport.error, /run-report-v13.*未捕获明确的发送回执/u);
  assert.doesNotMatch(store.state.friendReadReport.error, /share-prepare-v5/);
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
});

test('a startup mail failure persists a fresh diagnostic before any browser action', async t => {
  const state = oldDiagnostic(); state.enabled = false;
  const { worker, store, calls } = await harness(t, { state }, () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /无法连接本地邮件服务/);
  assert.match(store.state.friendReadReport.error, /无法连接本地邮件服务/);
  assert.equal(store.state.friendReadReport.build, diagnosticBuild);
  assert.ok(store.state.friendReadReport.at > 1);
  assert.equal(calls.scripts.length, 0);
  assert.equal(calls.debugger.length, 0);
});

test('a manual diagnosis without a Douyin tab replaces stale errors and survives status reads', async t => {
  const { worker, store, calls } = await harness(t, { state: oldDiagnostic() });
  globalThis.chrome.tabs.query = async () => [];
  await worker.command({ type: 'DIAGNOSE' });
  assert.match(store.state.friendReadReport.error, /没有可用的抖音标签页/);
  assert.equal(store.state.friendReadReport.kind, 'diagnose');
  assert.equal(store.state.friendReadReport.phase, 'error');
  assert.equal(store.state.friendReadReport.seq, 2);
  assert.deepEqual((await worker.command({ type: 'STATUS' })).state.friendReadReport, store.state.friendReadReport);
  assert.equal(calls.scripts.length, 0);
});

test('manual diagnosis can use the sole independent work tab and writes a new friend report', async t => {
  const state = oldDiagnostic(); state.workerTabId = 7;
  const { worker, store, calls } = await harness(t, { state }, undefined, request => request.action === 'friends' ? {
    friends: [{ id: 'uid:7000000000000000991', uid: '7000000000000000991', name: '测试好友' }],
    diagnostics: { revision: 'friends-v3', firstScreen: { controls: 1, recognized: 1, rejected: 0 }, observed: 1, recognized: 1, unrecognized: 0, stop: 'bottom' }
  } : null);
  await worker.command({ type: 'DIAGNOSE' });
  assert.equal(store.state.friendReadReport.kind, 'diagnose');
  assert.equal(store.state.friendReadReport.phase, 'done');
  assert.equal(store.state.friendReadReport.total, 1);
  assert.equal(store.state.friendReadReport.build, diagnosticBuild);
  assert.equal(calls.scripts.find(call => call.args[0].action === 'friends').target.tabId, 7);
  assert.equal(calls.debugger.some(call => call.params?.type === 'mousePressed'), false);
});

test('report sequence advances after importing an older backup', async t => {
  const state = oldDiagnostic(); state.enabled = false; state.friendReadReport.seq = 90;
  const { worker, store } = await harness(t, { state });
  await worker.command({ type: 'IMPORT', backup: { format: 'douyin-watch-backup', version: 1, config: config(), state: defaultState() } });
  globalThis.chrome.tabs.query = async () => [];
  await worker.command({ type: 'DIAGNOSE' });
  assert.ok(store.state.friendReadReport.seq > 90);
});

test('a missing first share entry reloads once, rechecks the account and sends the group without further navigation', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '第二位', avatarKey: 'avatar-2' });
  let opens = 0, reloaded = false;
  const { worker, store, calls } = await harness(t, { config: settings, state: queued(settings) }, undefined, request => {
    if (request.action === 'openShare') {
      opens++;
      if (!reloaded) return { error: '分享按钮找到 0 个', code: 'SHARE_ENTRY_MISSING' };
    }
    return null;
  });
  const reload = globalThis.chrome.tabs.reload;
  globalThis.chrome.tabs.reload = async id => { await reload(id); reloaded = true; };
  await worker.cycle(false, { queueOnly: true });
  assert.equal(opens, 5, 'three checks before refresh, then one for each recipient');
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 1);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'probe').length, 3, 'account must be checked again after reload');
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'sent']);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 2);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
  assert.equal(calls.tabs.filter(call => call.op === 'update').length, 0, 'the remaining friend reuses the same document');
  assert.equal(calls.debugger.some(call => call.op === 'Page.bringToFront'), false);
  assert.ok(calls.windows.every(call => call.options.focused === false));
  assert.match(store.state.logs.map(entry => entry.message).join('\n'), /自动刷新.*1\/1/u);
});

test('an empty first friend panel can refresh after reopen fails without reserving or pressing twice', async t => {
  let reloaded = false, preparations = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe') {
      preparations++;
      if (!reloaded) return { error: '好友行尚未加载', code: 'SHARE_PANEL_EMPTY' };
    }
    return null;
  });
  const reload = globalThis.chrome.tabs.reload;
  globalThis.chrome.tabs.reload = async id => {
    assert.equal(store.state.deliveries[0].status, 'sending');
    await reload(id); reloaded = true;
  };
  await worker.cycle();
  assert.equal(preparations, 3);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 1);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(store.state.logs.filter(entry => entry.message === '开始转发视频').length, 1);
});

test('persistent missing UI stops after one page refresh and records only one incident', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'openShare' ? { error: '分享按钮找到 0 个', code: 'SHARE_ENTRY_MISSING' } : null);
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 1);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'openShare').length, 6);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
  assert.match(store.state.friendReadReport.error, /分享按钮找到 0 个/);
});

test('a missing share entry after the first confirmed card does not reload or repeat earlier recipients', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '第二位', avatarKey: 'avatar-2' });
  let opens = 0;
  const { worker, store, calls } = await harness(t, { config: settings, state: queued(settings) }, undefined, request =>
    request.action === 'openShare' && ++opens > 1 ? { error: '分享入口尚未加载', code: 'SHARE_ENTRY_MISSING' } : null);
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'pending']);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
});

test('a pause during refresh leaves preparation pending and skips all post-reload UI and alerts', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'probe' ? { error: '空好友面板', code: 'SHARE_PANEL_EMPTY' } : null);
  const reload = globalThis.chrome.tabs.reload;
  let scriptsAtReload;
  globalThis.chrome.tabs.reload = async id => {
    await reload(id); scriptsAtReload = calls.scripts.length;
    await worker.command({ type: 'PAUSE' });
  };
  await worker.cycle();
  assert.equal(calls.scripts.length, scriptsAtReload);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.enabled, false);
  assert.equal(store.state.paused, false);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('an account change during the refresh prevents reopening the share panel or sending', async t => {
  let reloaded = false;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'probe' && reloaded) return { id: 'other-account', name: 'other' };
    if (request.action === 'openShare') return { error: '分享入口尚未加载', code: 'SHARE_ENTRY_MISSING' };
    return null;
  });
  const reload = globalThis.chrome.tabs.reload;
  globalThis.chrome.tabs.reload = async id => { await reload(id); reloaded = true; };
  await worker.cycle();
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'openShare').length, 3);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.match(store.state.incident.reason, /账号不一致/);
});

test('ambiguous entry failures never trigger the new refresh recovery', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return { error: '分享入口不唯一', code: 'SHARE_ENTRY_AMBIGUOUS' };
  });
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
});

test('a refreshable-looking error after mouse press remains unknown without refreshing or retrying', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'confirm' ? { error: '面板已消失但发送结果未知', code: 'SHARE_PANEL_EMPTY' } : null);
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
});

test('each fresh cycle has its own single first-card refresh allowance', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') {
      opens++;
      return opens % 4 !== 0 ? { error: '分享入口尚未加载', code: 'SHARE_ENTRY_MISSING' } : null;
    }
  });
  await worker.cycle();
  enqueue(store.state, [{ ...video(), id: '739000000000000002' }], config());
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'sent']);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 2);
});
