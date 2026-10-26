import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { defaultState, enqueue, reserveDelivery, failDelivery, makeKey, recoverState } from '../extension/core.js';

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
  const calls = { fetch: [], scripts: [], alarms: [], access: [], messages: [], debugger: [], windows: [], tabs: [], audio: [], badges: [] };
  let offscreenReady=false;
  const listeners = {};
  let tab = { id: 7, windowId: 40, active: true, url: 'https://www.douyin.com/', status: 'complete' };
  let nextWindowId = 41;
  const windowStates=new Map([[40,{state:'normal',focused:false}]]);
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
      getContexts:async()=>offscreenReady?[{}]:[],
      sendMessage:async message=>{calls.audio.push(clone(message));return {ok:true};},
      getPlatformInfo: async () => ({ os: 'win' }), openOptionsPage: async () => {},
      onMessage: { addListener: fn => { listeners.message = fn; } },
      onStartup: { addListener: fn => { listeners.startup = fn; } } },
    alarms: { get: async () => null, clear: async () => true, create: async (...args) => { calls.alarms.push(args); },
      onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
    action: { onClicked: { addListener: fn => { listeners.action = fn; } },setBadgeBackgroundColor:async()=>{},setBadgeText:async value=>calls.badges.push(value.text),setTitle:async()=>{} },
    offscreen:{createDocument:async()=>{offscreenReady=true;}},
    windows: {
      get: async (id) => ({ id, ...windowStates.get(id), tabs: id === tab.windowId ? [clone(tab)] : [] }),
      update: async (id,options) => {
        calls.windows.push({op:'update',id,options:clone(options)});
        windowStates.set(id,{...windowStates.get(id),...options});
        return {id,...windowStates.get(id),tabs:id===tab.windowId?[clone(tab)]:[]};
      },
      create: async (options) => {
        calls.windows.push({ op: 'create', options: clone(options) });
        tab = { ...tab, windowId: nextWindowId++, active: true, url: options.url || tab.url };
        windowStates.set(tab.windowId,{state:options.state||'normal',focused:options.focused});
        return { id: tab.windowId, ...windowStates.get(tab.windowId), tabs: [clone(tab)] };
      }
    },
    tabs: { get: async () => clone(tab), query: async () => [clone(tab)],
      reload: async id => { calls.tabs.push({ op: 'reload', id }); },
      create: async options => { calls.tabs.push({ op: 'create', options }); tab = { ...tab, ...options }; return clone(tab); },
      update: async (id, options) => { calls.tabs.push({ op: 'update', id, options }); tab = { ...tab, ...options,
        ...(typeof options.muted==='boolean'?{mutedInfo:{muted:options.muted}}:{}) }; return clone(tab); } },
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
        action === 'videoStatus' ? { unavailable: false, videoId: request.videoId } :
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
    .replace("from './browser-alerts.js'", `from '${new URL('../extension/browser-alerts.js', import.meta.url).href}'`)
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
  const navigations = calls.tabs.filter(call => call.op === 'update' && call.options.url?.includes('/video/'));
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

test('persistent pre-press changes stop after bounded relocation and two refreshes without any actual press', async t => {
  let arms = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'arm') {
      arms++;
      return { error: '鼠标落点变化，尚未点击发送', code: 'SHARE_TARGET_CHANGED', retryable: true, details: { reason: 'hit-mismatch' } };
    }
    return null;
  });
  await worker.cycle();
  assert.equal(arms, 9);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.scripts.filter(call => call.args[0].reopen).length, 6);
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
  assert.deepEqual(calls.windows.map(call => call.options), [{ tabId: 7, focused: false, type: 'normal' },{state:'maximized'}]);
  assert.equal(calls.tabs.some(call => call.options?.active), false, 'never switch away from the settings tab');
  assert.equal(calls.debugger.some(call => call.op === 'Page.bringToFront'), false);
});

test('a healthy existing single-tab worker window is reused without creating more windows', async t => {
  const state = queued(); state.workerTabId = 7; state.workerWindowId = 40;
  const { worker, store, calls } = await harness(t, { state });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.deepEqual(calls.windows,[{op:'update',id:40,options:{state:'maximized'}}]);
  assert.ok(calls.tabs.some(call=>call.options?.muted===true));
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
  assert.equal(store.state.friendReadReport.stopReason, 'queue-empty');
  assert.match(store.state.friendReadReport.message, /待发直发（不查询）.*原因：待发队列已处理完毕/u);
  await worker.cycle(); // A later alarm must not start a new query.
  await assert.rejects(worker.command({ type: 'SEND_PENDING' }), /没有可发送/);
  assert.equal(calls.scripts.some(call => call.args[0].action === 'search'), false);
});

test('queue-only yields its time budget and automatically finishes the remaining queue in the same round', async t => {
  const clock=budgetClock(t),settings=config(),state=queued(settings);
  enqueue(state,[nextVideo()],settings);state.enabled=false;
  const {worker,store,calls,idle,listeners}=await harness(t,{config:settings,state},undefined,request=>{
    if(request.action==='share'&&request.mode==='confirm')clock.advance(225001);
  });
  await worker.command({type:'SEND_PENDING'});await idle();
  const round=store.state.round.id;
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','pending']);
  assert.equal(store.state.friendReadReport.phase,'running');
  assert.equal(store.state.enabled,true);
  assert.equal(store.state.resumePlan.reason,'send-segment');
  assert.equal(store.state.friendReadReport.sent,1);
  advanceToResume(clock,store);
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(store.state.round.id,round);
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.equal(store.state.friendReadReport.sent,2);
  assert.equal(store.state.enabled,false);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,0);
  assert.equal(calls.scripts.some(call=>call.args[0].action==='search'),false);
});

test('queue-only waits through rate limiting and automatically resumes without another click', async t => {
  const clock=budgetClock(t),settings=config();settings.maxVideosPerWindow=1;
  const state=queued(settings);enqueue(state,[nextVideo()],settings);state.enabled=false;
  const {worker,store,calls,idle,listeners}=await harness(t,{config:settings,state});
  await worker.command({type:'SEND_PENDING'});await idle();
  const round=store.state.round.id;
  assert.equal(store.state.friendReadReport.phase,'running');
  assert.equal(store.state.resumePlan.reason,'rate-limit');
  assert.match(store.state.friendReadReport.message,/仍在运行/);
  assert.equal(store.state.friendReadReport.remaining,1);
  assert.equal(store.state.enabled,true);
  assert.equal(store.state.paused,false);
  const presses=calls.debugger.filter(call=>call.params?.type==='mousePressed').length;
  await listeners.alarm({name:'douyin-minute'});
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,presses,'early alarms cannot spend a rate slot');
  await assert.rejects(worker.command({type:'SEND_PENDING'}),/正在运行/);
  advanceToResume(clock,store);
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(store.state.round.id,round);
  assert.equal(store.state.friendReadReport.stopReason,'queue-empty');
  assert.equal(store.state.friendReadReport.sent,2);
  assert.equal(store.state.enabled,false);
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,2);
  assert.equal(calls.scripts.some(call=>call.args[0].action==='search'),false);
});

test('manual pause during queue sending is reported separately from budget and rate stops', async t => {
  const state=queued();enqueue(state,[nextVideo()],config());state.enabled=false;
  const {worker,store,idle}=await harness(t,{state});
  const execute=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async options=>{
    const result=await execute(options);
    if(options.args[0].mode==='confirm')await worker.command({type:'PAUSE'});
    return result;
  };
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.friendReadReport.stopReason,'manual-pause');
  assert.match(store.state.friendReadReport.message,/收到手动暂停指令/);
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','pending']);
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

test('manual queue sending remains enabled while waiting for the existing rate limit', async t => {
  const state = queued(); state.enabled = false;
  state.rate = Array.from({ length: 5 }, (_, n) => ({ videoId: String(n + 1), at: Date.now() }));
  const { worker, store, calls, idle } = await harness(t, { state });
  await worker.command({ type: 'SEND_PENDING' });
  await idle();
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.enabled, true);
  assert.equal(calls.scripts.length, 0);
  assert.equal(store.state.resumePlan.reason,'rate-limit');
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
  assert.equal(store.state.runMode, 'queue-only');
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
  assert.equal(shares.length, 2);
  assert.equal(shares[0].args[0].mode, 'probe');
  assert.equal(shares[1].args[0].mode, undefined);
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
  assert.equal(probes, 6, 'one reopen per page, across three page attempts');
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
  assert.equal(store.state.paused, true);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
  const snapshot = JSON.parse(store.state.friendReadReport.error.split('\n').at(-1));
  assert.equal(snapshot.revision, 'share-prepare-v9');
  assert.equal(snapshot.visibility, 'hidden');
  assert.equal(snapshot.viewport, '2040x974');
  assert.deepEqual(snapshot.browser, { tabActive: true, windowFocused: false, windowState: 'maximized', tabsInWindow: 1, ownWindow: true });
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

const diagnosticBuild = '0.2.5（告警红点增强）';
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
  assert.equal(calls.tabs.filter(call => call.op === 'update'&&call.options.url).length, 1, 'only the initial blank worker navigates; the remaining friend reuses the same document');
  assert.equal(calls.debugger.some(call => call.op === 'Page.bringToFront'), false);
  assert.ok(calls.windows.every(call => call.options.focused !== true));
  assert.match(store.state.logs.map(entry => entry.message).join('\n'), /自动刷新.*1\/2/u);
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

test('persistent missing UI stops after two page refreshes and records only one incident', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'openShare' ? { error: '分享按钮找到 0 个', code: 'SHARE_ENTRY_MISSING' } : null);
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'openShare').length, 9);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
  assert.match(store.state.friendReadReport.error, /分享按钮找到 0 个/);
  assert.match(store.state.incident.reason, /已刷新重试 2 次，3 次尝试均失败/);
});

test('each recipient gets two refreshes, keeping one reservation and one actual send per recipient', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '第二位', avatarKey: 'avatar-2' });
  const probes = new Map();
  const rounds = new Set();
  const { worker, store, calls } = await harness(t, { config: settings, state: queued(settings) }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe') {
      const count = (probes.get(request.recipient.id) || 0) + 1;
      probes.set(request.recipient.id, count);
      rounds.add(store.state.round.id);
      if (count < 3) return { error: '未找到好友行转发按钮，尚未点击发送', code: 'SHARE_CONTROL_MISSING' };
    }
  });
  await worker.cycle(false, { queueOnly: true });
  assert.deepEqual([...probes.values()], [3, 3]);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 4, 'two refreshes for each current recipient');
  assert.deepEqual(store.state.deliveries.map(d => d.status), ['sent', 'sent']);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 2);
  assert.deepEqual(calls.scripts.filter(call => call.args[0].mode === 'confirm').map(call => call.args[0].recipient.id), ['friend-1', 'friend-2']);
  assert.equal(store.state.logs.filter(entry => entry.message === '开始转发视频').length, 2, 'reloads must not create more reservations');
  assert.equal(rounds.size, 1, 'refresh does not start a new round');
  assert.ok(store.state.deliveries.every(d => d.attemptRoundId === store.state.round.id));
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('persistent missing recipient stops after three probes and sends just one alert without pressing', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'probe' ? { error: '未找到目标好友', code: 'SHARE_RECIPIENT_MISSING' } : null);
  await worker.cycle();
  assert.equal(calls.scripts.filter(call => call.args[0].mode === 'probe').length, 3);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 1);
});

test('scripted fallback classifies missing controls before its possible-send boundary', async t => {
  let probes = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'share' && request.mode === 'probe' && ++probes < 3)
      return { error: '未找到转发按钮', code: 'SHARE_CONTROL_MISSING' };
  });
  globalThis.chrome.debugger.attach = async () => { throw new Error('Debugger unavailable'); };
  await worker.cycle();
  assert.equal(probes, 3);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'share' && !call.args[0].mode).length, 1);
  assert.equal(store.state.deliveries[0].status, 'sent');
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('a challenge carrying a refreshable code still pauses immediately without refreshing', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'probe' ? { error: '需要安全验证，分享面板未加载', code: 'SHARE_PANEL_EMPTY' } : null);
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(store.state.paused, true);
});

test('manual pause on the second refresh prevents the third preparation and all sending', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'probe' ? { error: '未找到转发按钮', code: 'SHARE_CONTROL_MISSING' } : null);
  const reload = globalThis.chrome.tabs.reload;
  globalThis.chrome.tabs.reload = async id => {
    await reload(id);
    if (calls.tabs.filter(call => call.op === 'reload').length === 2) await worker.command({ type: 'PAUSE' });
  };
  await worker.cycle();
  assert.equal(calls.scripts.filter(call => call.args[0].mode === 'probe').length, 2);
  assert.equal(store.state.deliveries[0].status, 'pending');
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(calls.fetch.filter(call => call.url.endsWith('/alert')).length, 0);
});

test('a missing share entry after the first confirmed card refreshes twice without repeating earlier recipients', async t => {
  const settings = config();
  settings.rules[0].recipients.push({ id: 'friend-2', name: '第二位', avatarKey: 'avatar-2' });
  let opens = 0;
  const { worker, store, calls } = await harness(t, { config: settings, state: queued(settings) }, undefined, request =>
    request.action === 'openShare' && ++opens > 1 ? { error: '分享入口尚未加载', code: 'SHARE_ENTRY_MISSING' } : null);
  await worker.cycle();
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 2);
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
  assert.equal(calls.scripts.filter(call => call.args[0].action === 'openShare').length, 1);
});

test('ambiguous panels appearing during hover polling stop without refresh or any press', async t => {
  let opens = 0;
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request => {
    if (request.action === 'openShare') return ++opens === 1 ? { needsPointer: true, x: 10, y: 20 } :
      { error: '原生分享面板不唯一', code: 'SHARE_PANEL_AMBIGUOUS' };
  });
  await worker.cycle();
  assert.equal(opens, 2);
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 0);
  assert.equal(store.state.paused, true);
});

test('a refreshable-looking error after mouse press remains unknown without refreshing or retrying', async t => {
  const { worker, store, calls } = await harness(t, { state: queued() }, undefined, request =>
    request.action === 'share' && request.mode === 'confirm' ? { error: '面板已消失但发送结果未知', code: 'SHARE_PANEL_EMPTY' } : null);
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status, 'unknown');
  assert.equal(calls.tabs.filter(call => call.op === 'reload').length, 0);
  assert.equal(calls.debugger.filter(call => call.params?.type === 'mousePressed').length, 1);
});

test('each fresh cycle can recover its pending delivery without re-sending earlier cards', async t => {
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


test('each sending cycle excludes historical sent cards while preserving the durable ledger', async t => {
  const state=queued();
  const old=clone(state.deliveries[0]);
  old.recipient={...old.recipient,id:'old-friend'};old.key=makeKey(old.accountId,old.video.id,old.recipient.id);
  old.status='sent';old.attemptRoundId='historical-round';state.deliveries.unshift(old);
  const {worker,store}=await harness(t,{state});
  await worker.cycle();
  const first=store.state.round.id;
  assert.equal(store.state.deliveries.filter(d=>d.status==='sent').length,2);
  assert.equal(store.state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===first).length,1);
  enqueue(store.state,[{...video(),id:'739000000000000002'}],config());
  await worker.cycle();
  const second=store.state.round.id;
  assert.notEqual(first,second);
  assert.equal(store.state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===second).length,1);
  assert.equal(store.state.deliveries.filter(d=>d.status==='sent').length,3);
  assert.equal(store.state.round.status,'done');
});

test('search publishes intermediate results and retains this round after a later query fails', async t => {
  const settings=config();settings.rules[0].keywords=['第二个查询'];
  let searches=0,live;
  const {worker,store}=await harness(t,{config:settings},undefined,request=>{
    if(request.action!=='search') return null;
    if(++searches===1)return {payloads:[video()],truncated:false};
    assert.equal(live.state.round.queriesDone,1);
    assert.equal(live.state.round.videos[0].id,video().id);
    assert.equal(live.state.round.status,'running');
    return {error:'第二个查询超时'};
  });live=store;
  await assert.rejects(worker.command({type:'SCAN'}),/第二个查询超时/);
  assert.equal(store.state.round.status,'failed');
  assert.equal(store.state.round.scanStatus,'incomplete');
  assert.equal(store.state.round.foundCount,1);
  assert.equal(store.state.preview[0].id,video().id);
  assert.equal(store.state.deliveries.length,0,'dry search must not enqueue or send');
});

for(const mode of ['START','AUTO_LOOP','SCAN']) for(const mailEnabled of [false,true])
test(`image verification during ${mode} pauses with a persistent notice; email enabled=${mailEnabled}`,async t=>{
  const settings={...config(),mailAlertsEnabled:mailEnabled};
  const original=queued(settings);
  original.enabled=false;
  const reason='抖音要求图片拖拽安全验证；请手动完成验证后恢复';
  const {worker,store,calls,idle,listeners}=await harness(t,{config:settings,state:original},undefined,
    request=>request.action==='search'?{error:reason,code:'SECURITY_CHALLENGE'}:null);
  if(mode==='SCAN') await assert.rejects(worker.command({type:mode}),/图片拖拽安全验证/u);
  else {await worker.command({type:mode});await idle();}
  assert.equal(store.state.paused,true);
  assert.equal(store.state.incident.reason,reason);
  assert.equal(store.state.incident.notified,mailEnabled);
  assert.match(store.state.friendReadReport.error,/图片拖拽安全验证/u);
  assert.equal(store.state.round.status,'failed');
  assert.equal(store.state.resumePlan,null);
  assert.equal(store.state.deliveries.length,1);
  assert.equal(store.state.deliveries[0].status,'pending');
  const scripts=calls.scripts.length;
  await listeners.alarm({name:'douyin-minute'});await idle();
  assert.equal(calls.scripts.length,scripts,'paused verification must not resume queries on an alarm');
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,mailEnabled?1:0);
  assert.equal(calls.debugger.some(c=>c.method==='Input.dispatchMouseEvent'&&c.params?.type==='mousePressed'),false);
  assert.equal(calls.tabs.some(c=>c.op==='reload'),false,'verification must not enter refresh recovery');
});

test('a zero-result scan replaces a previous populated round instead of showing old discoveries', async t => {
  let withResults=true;
  const {worker,store}=await harness(t,{},undefined,request=>request.action==='search'?{payloads:withResults?[video()]:[],truncated:false}:null);
  await worker.command({type:'SCAN'});const first=store.state.round.id;
  assert.equal(store.state.round.foundCount,1);
  withResults=false;
  await worker.command({type:'SCAN'});
  assert.notEqual(store.state.round.id,first);
  assert.equal(store.state.round.foundCount,0);
  assert.deepEqual(store.state.round.videos,[]);
  assert.deepEqual(store.state.preview,[]);
});

test('queue-only rounds display the actual pending video list while leaving search time intact', async t => {
  const state=queued();state.enabled=false;state.preview=[{...video(),id:'739000000000000002',publishedAt:Date.now()-7200000}];state.lastScanAt=123;
  const {worker,store,calls,idle}=await harness(t,{state});
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.round.source,'queue');
  assert.equal(store.state.round.foundCount,1);
  assert.equal(store.state.round.videos[0].id,video().id);
  assert.equal(store.state.round.status,'done');
  assert.equal(store.state.lastScanAt,123);
  assert.equal(calls.scripts.some(c=>c.args[0].action==='search'),false);
});

test('a paused search cannot publish its delayed result over the paused round', async t => {
  const {worker,store}=await harness(t);
  const arrived=deferred(),release=deferred();
  const original=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async options=>{
    if(options.args[0].action!=='search')return original(options);
    arrived.resolve();await release.promise;
    return [{result:{payloads:[video()],truncated:false}}];
  };
  const scan=worker.command({type:'SCAN'});
  await arrived.promise;await worker.command({type:'PAUSE'});release.resolve();
  assert.equal((await scan).cancelled,true);
  assert.equal(store.state.round.status,'paused');
  assert.equal(store.state.round.foundCount,0);
});

test('import never presents another installation historical round as the local current round', async t => {
  const {worker,store}=await harness(t);
  const state=defaultState();state.round={id:'imported-round',status:'done',videos:[video()],foundCount:1};
  await worker.command({type:'IMPORT',backup:{format:'douyin-watch-backup',version:1,config:config(),state}});
  assert.equal(store.state.round,null);
});


test('pre-existing sent controls are retained for deduplication but not counted as a fresh send',async t=>{
 const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>request.action==='share'&&request.mode==='probe'?{sent:true,alreadySent:true,existingBeforeSend:true}:null);
 await worker.cycle();
 assert.equal(store.state.deliveries[0].status,'sent');
 assert.equal(store.state.deliveries[0].attemptRoundId,null);
 assert.equal(store.state.friendReadReport.sent,0);
 assert.equal(calls.debugger.some(c=>c.params?.type==='mousePressed'),false);
});

test('a newly sent row observed after the actual press still counts toward this round',async t=>{
 const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>request.action==='share'&&request.mode==='confirm'?{sent:true,alreadySent:true}:null);
 await worker.cycle();
 assert.equal(store.state.deliveries[0].attemptRoundId,store.state.round.id);
 assert.equal(store.state.friendReadReport.sent,1);
 assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
});


function budgetClock(t) {
  const original=Date.now;
  let now=original();
  Date.now=()=>now;
  t.after(()=>{Date.now=original;});
  return {advance:ms=>{now+=ms;}};
}
function multiQueryConfig() {
  const settings=config();
  settings.rules[0].keywords=['第二查询'];
  return settings;
}
function nextVideo() {
  return {...video(),id:'739000000000000002',url:'https://www.douyin.com/video/739000000000000002'};
}

test('query budget yields to sending then the continuation alarm resumes the next query in the same round',async t=>{
  const clock=budgetClock(t),settings=multiQueryConfig();
  const searched=[];let live;
  const {worker,store,calls,listeners,idle}=await harness(t,{config:settings,state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action!=='search')return null;
    searched.push(request.query);
    if(searched.length===1){clock.advance(185000);return {payloads:[video()],truncated:false};}
    assert.equal(live.state.deliveries[0].status,'sent','drain discovered cards before resuming queries');
    return {payloads:[nextVideo()],truncated:false};
  });live=store;
  await worker.cycle();
  const round=store.state.round.id;
  assert.deepEqual(searched,['爱慕杰']);
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  assert.equal(store.state.searchCheckpoint.phase,'query');
  assert.equal(store.state.round.queriesDone,1);
  assert.equal(store.state.round.status,'running');
  assert.equal(store.state.round.stage,'waiting-search');
  assert.equal(store.state.deliveries[0].status,'sent');
  assert.equal(store.state.paused,false);
  assert.equal(store.state.lastScanAt,undefined,'partial querying must not claim a full scan');
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,0);
  assert.ok(calls.alarms.some(([name])=>name==='douyin-continue'));
  advanceToResume(clock,store);
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.deepEqual(searched,['爱慕杰','第二查询']);
  assert.equal(store.state.searchCheckpoint,null);
  assert.equal(store.state.round.id,round,'scheduled segments belong to one logical round');
  assert.equal(store.state.round.status,'done');
  assert.equal(store.state.round.queriesDone,2);
  assert.equal(store.state.round.foundCount,2);
  assert.equal(store.state.friendReadReport.sent,2);
  assert.ok(store.state.lastScanAt);
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,2);
});

test('rate-limited draining keeps the query cursor until every queued video has been sent',async t=>{
  const clock=budgetClock(t),settings=multiQueryConfig();settings.maxVideosPerWindow=1;
  let searches=0;
  const {worker,store,calls}=await harness(t,{config:settings,state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action!=='search')return null;
    if(++searches===1){clock.advance(185000);return {payloads:[video(),nextVideo()],truncated:false};}
    return {payloads:[],truncated:false};
  });
  await worker.cycle();
  const round=store.state.round.id;
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','pending']);
  assert.equal(store.state.searchCheckpoint.phase,'drain');
  await worker.cycle();
  assert.equal(searches,1,'do not query while the prior batch is rate limited');
  assert.equal(store.state.round.stage,'waiting-rate');
  clock.advance(61000);await worker.cycle();
  assert.equal(searches,1,'draining finishes before any further search');
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  advanceToResume(clock,store);await worker.cycle();
  assert.equal(searches,2);
  assert.equal(store.state.searchCheckpoint,null);
  assert.equal(store.state.round.id,round);
  assert.equal(store.state.friendReadReport.sent,2);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,0);
});

test('manual pause cancels scheduled querying; Start resumes from the saved next query',async t=>{
  const clock=budgetClock(t),searched=[];
  const {worker,store,listeners,idle}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action!=='search')return null;
    searched.push(request.query);
    if(searched.length===1)clock.advance(185000);
    return {payloads:[],truncated:false};
  });
  await worker.cycle();
  await worker.command({type:'PAUSE'});
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.deepEqual(searched,['爱慕杰']);
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  await worker.command({type:'START'});await idle();
  assert.deepEqual(searched,['爱慕杰','第二查询']);
  assert.equal(store.state.searchCheckpoint,null);
});

test('a possible send pauses the segmented workflow and blocks all scheduled remaining queries',async t=>{
  const clock=budgetClock(t);let searches=0;
  const {worker,store,calls,listeners,idle}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action==='search'){
      searches++;clock.advance(185000);return {payloads:[video()],truncated:false};
    }
    if(request.action==='share'&&request.mode==='confirm')return {error:'未捕获明确的发送回执'};
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'unknown');
  assert.equal(store.state.paused,true);
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(searches,1);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,1);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,1);
  assert.equal(calls.alarms.filter(([name])=>name==='douyin-continue').length,0);
});

test('budget-limited dry scans keep progress and continue on the next Scan without any delivery',async t=>{
  const clock=budgetClock(t),searched=[];
  const {worker,store,calls}=await harness(t,{config:multiQueryConfig()},undefined,request=>{
    if(request.action!=='search')return null;
    searched.push(request.query);
    if(searched.length===1)clock.advance(185000);
    return {payloads:[searched.length===1?video():nextVideo()],truncated:false};
  });
  const first=await worker.command({type:'SCAN'});
  assert.equal(first.partial,true);
  assert.equal(first.queriesDone,1);
  assert.equal(store.state.round.scanStatus,'incomplete');
  assert.equal(store.state.scanCheckpoint.nextIndex,1);
  const second=await worker.command({type:'SCAN'});
  assert.equal(second.partial,false);
  assert.equal(second.count,2);
  assert.equal(store.state.scanCheckpoint,null);
  assert.deepEqual(searched,['爱慕杰','第二查询']);
  assert.equal(store.state.deliveries.length,0);
  assert.equal(calls.scripts.some(call=>call.args[0].action==='share'),false);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,0);
  assert.equal(calls.alarms.some(([name])=>name==='douyin-continue'),false);
});

test('queue-only sending never resumes a saved monitoring query checkpoint',async t=>{
  const clock=budgetClock(t);let searches=0;
  const {worker,store,calls,idle}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action==='search'){searches++;clock.advance(230000);return {payloads:[video()],truncated:false};}
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'pending');
  await worker.command({type:'PAUSE'});
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.deliveries[0].status,'sent');
  assert.equal(store.state.enabled,false);
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  await worker.cycle();
  assert.equal(searches,1);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,1);
});


test('a persisted checkpoint survives worker recovery without repeating finished queries or recipients',async t=>{
  const clock=budgetClock(t),searched=[];
  const {worker,store,calls}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action!=='search')return null;
    searched.push(request.query);
    if(searched.length===1)clock.advance(185000);
    return {payloads:[searched.length===1?video():nextVideo()],truncated:false};
  });
  await worker.cycle();
  const first=store.state.round.id;
  store.state=recoverState(structuredClone(store.state));
  assert.equal(store.state.round.status,'interrupted');
  advanceToResume(clock,store);await worker.cycle();
  assert.deepEqual(searched,['爱慕杰','第二查询']);
  assert.notEqual(store.state.round.id,first);
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,2);
  assert.equal(store.state.searchCheckpoint,null);
});

test('changing search rules invalidates saved cursors and exports never carry scheduling checkpoints',async t=>{
  const clock=budgetClock(t);
  const {worker,store}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action==='search'){clock.advance(185000);return {payloads:[],truncated:false};}
  });
  await worker.cycle();
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  await worker.command({type:'PAUSE'});
  assert.equal(store.state.round.status,'paused');
  const backup=await worker.command({type:'EXPORT'});
  assert.equal(backup.state.searchCheckpoint,null);
  assert.equal(store.state.searchCheckpoint.nextIndex,1,'export must not delete local progress');
  const changed=multiQueryConfig();changed.rules[0].keywords=['新查询'];
  await worker.command({type:'SAVE',config:changed});
  assert.equal(store.state.searchCheckpoint,null);
  assert.equal(store.state.scanCheckpoint,null);
  backup.state.searchCheckpoint={version:1,nextIndex:100};
  backup.state.scanCheckpoint={version:1,nextIndex:100};
  await worker.command({type:'IMPORT',backup});
  assert.equal(store.state.searchCheckpoint,null);
  assert.equal(store.state.scanCheckpoint,null);
});


test('a continuation alarm failure preserves progress and the periodic alarm safely resumes it',async t=>{
  const clock=budgetClock(t),searched=[];
  const {worker,store,calls,listeners,idle}=await harness(t,{config:multiQueryConfig(),state:{...defaultState(),enabled:true}},undefined,request=>{
    if(request.action!=='search')return null;
    searched.push(request.query);
    if(searched.length===1)clock.advance(185000);
    return {payloads:[],truncated:false};
  });
  const create=chrome.alarms.create;
  chrome.alarms.create=async(name,...args)=>{
    if(name==='douyin-continue')throw new Error('Fixture scheduling unavailable');
    return create(name,...args);
  };
  await worker.cycle();
  assert.equal(store.state.searchCheckpoint.nextIndex,1);
  assert.equal(store.state.paused,false);
  assert.ok(store.state.logs.some(entry=>entry.message.includes('下次定时检查继续')));
  advanceToResume(clock,store);
  await listeners.alarm({name:'douyin-minute'});await idle();
  assert.deepEqual(searched,['爱慕杰','第二查询']);
  assert.equal(store.state.searchCheckpoint,null);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,0);
});


test('a stale continuation alarm does not start another scan after the checkpoint is complete',async t=>{
  const {worker,store,calls,listeners,idle}=await harness(t,{state:{...defaultState(),enabled:true}});
  await worker.cycle();
  assert.equal(store.state.searchCheckpoint,null);
  const searches=calls.scripts.filter(call=>call.args[0].action==='search').length;
  await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(calls.scripts.filter(call=>call.args[0].action==='search').length,searches);
});


function advanceToResume(clock,store) {
  if(store.state.resumePlan)clock.advance(Math.max(0,store.state.resumePlan.at-Date.now()));
}

test('automatic loop searches, drains every recipient, waits for rate slots and only then searches again',async t=>{
  const clock=budgetClock(t),settings=config();settings.maxVideosPerWindow=1;
  const events=[];let searches=0;
  const {worker,store,calls,idle,listeners}=await harness(t,{config:settings},undefined,request=>{
    if(request.action==='search'){
      events.push('search');searches++;
      return {payloads:searches===1?[video(),nextVideo()]:[],truncated:false};
    }
    if(request.action==='share'&&request.mode==='confirm')events.push('sent:'+request.videoId);
  });
  assert.deepEqual(await worker.command({type:'AUTO_LOOP'}),{started:true,autoLoop:true});await idle();
  const round=store.state.round.id;
  assert.equal(store.state.runMode,'auto-loop');
  assert.equal(store.state.enabled,true);
  assert.equal(store.state.resumePlan.reason,'rate-limit');
  assert.deepEqual(events,['search','sent:'+video().id]);
  advanceToResume(clock,store);await listeners.alarm({name:'douyin-continue'});await idle();
  assert.deepEqual(events,['search','sent:'+video().id,'sent:'+nextVideo().id]);
  assert.equal(searches,1,'new batch cannot query until all pending cards have completed');
  assert.equal(store.state.round.id,round);
  assert.equal(store.state.friendReadReport.sent,2);
  assert.equal(store.state.resumePlan.reason,'next-round');
  assert.equal(store.state.enabled,true);
  advanceToResume(clock,store);await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(searches,2);
  assert.notEqual(store.state.round.id,round);
  assert.equal(store.state.resumePlan.reason,'next-round');
  assert.ok(store.state.resumePlan.at-Date.now()>=60000,'empty batches use the configured interval');
  await worker.command({type:'PAUSE'});
  const count=calls.scripts.length;
  await listeners.alarm({name:'douyin-continue'});await listeners.alarm({name:'douyin-minute'});await idle();
  assert.equal(calls.scripts.length,count);
  assert.equal(store.state.resumePlan,null);
  assert.equal(store.state.enabled,false);
});

test('automatic loop stops on an uncertain send and cannot query or retry the next batch',async t=>{
  const {worker,store,calls,idle,listeners}=await harness(t,{},undefined,request=>{
    if(request.action==='search')return {payloads:[video(),nextVideo()],truncated:false};
    if(request.action==='share'&&request.mode==='confirm')return {error:'未捕获明确的发送回执'};
  });
  await worker.command({type:'AUTO_LOOP'});await idle();
  assert.equal(store.state.deliveries[0].status,'unknown');
  assert.equal(store.state.paused,true);
  assert.equal(store.state.enabled,false);
  assert.equal(store.state.resumePlan,null);
  await listeners.alarm({name:'douyin-continue'});await listeners.alarm({name:'douyin-minute'});await idle();
  assert.equal(calls.scripts.filter(call=>call.args[0].action==='search').length,1);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,1);
  assert.equal(calls.fetch.filter(call=>call.url.endsWith('/alert')).length,1);
});

test('pausing a rate wait cancels queue-only continuation and keeps unsent tasks pending',async t=>{
  const clock=budgetClock(t),settings=config();settings.maxVideosPerWindow=1;
  const state=queued(settings);enqueue(state,[nextVideo()],settings);state.enabled=false;
  const {worker,store,calls,idle,listeners}=await harness(t,{config:settings,state});
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.resumePlan.reason,'rate-limit');
  await worker.command({type:'PAUSE'});clock.advance(70000);
  await listeners.alarm({name:'douyin-continue'});await listeners.alarm({name:'douyin-minute'});await idle();
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','pending']);
  assert.equal(calls.debugger.filter(call=>call.params?.type==='mousePressed').length,1);
  assert.equal(store.state.resumePlan,null);
  assert.equal(store.state.round.status,'paused');
  assert.equal(store.state.friendReadReport.phase,'done');
  assert.match(store.state.friendReadReport.message,/已手动暂停/);
});

test('worker restart preserves a safe rate wait and the queue round without changing it into monitoring',async t=>{
  const clock=budgetClock(t),settings=config();settings.maxVideosPerWindow=1;
  const state=queued(settings);enqueue(state,[nextVideo()],settings);
  state.runMode='queue-only';
  state.deliveries[0].status='sent';state.deliveries[0].attemptRoundId='saved-queue';
  state.round={id:'saved-queue',kind:'queue-only',source:'queue',status:'running',stage:'waiting-rate',startedAt:Date.now(),videos:[],foundCount:2};
  state.rate=[{videoId:video().id,at:Date.now()-55000}];
  state.resumePlan={mode:'queue-only',roundId:'saved-queue',reason:'rate-limit',at:Date.now()+5250};
  const {worker,store,calls,listeners,idle}=await harness(t,{config:settings,state});
  assert.equal(store.state.enabled,true);
  assert.equal(store.state.round.status,'running');
  assert.equal(store.state.runMode,'queue-only');
  await worker.cycle();assert.equal(calls.scripts.length,0);
  advanceToResume(clock,store);await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(store.state.round.id,'saved-queue');
  assert.equal(store.state.friendReadReport.sent,2);
  assert.equal(store.state.enabled,false);
  assert.equal(calls.scripts.some(call=>call.args[0].action==='search'),false);
});

test('auto-loop startup still checks mail readiness and refuses unknown deliveries',async t=>{
  const state=queued();state.enabled=false;
  failDelivery(state,state.deliveries[0].key,'待核对');
  const {worker,calls}=await harness(t,{state});
  await assert.rejects(worker.command({type:'AUTO_LOOP'}),/待核对/);
  assert.equal(calls.fetch.length,0);
  assert.equal(calls.scripts.length,0);
});
const unavailableResult=(videoId=video().id)=>({error:'视频已失效：你要观看的视频不存在',code:'VIDEO_UNAVAILABLE',details:{videoId,reason:'not-found',evidence:'visible-error'}});

test('unavailable first video skips every remaining friend and immediately drains the next video without refresh or alert',async t=>{
  const settings=config();settings.rules[0].recipients=['a','b','c'].map(id=>({id,name:id,avatarKey:id}));
  const state=queued(settings);enqueue(state,[nextVideo()],settings);state.enabled=false;
  const {worker,store,calls,idle}=await harness(t,{state,config:settings},undefined,request=>{
    if(request.action==='videoStatus'&&request.videoId===video().id)return unavailableResult();
  });
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['skipped','skipped','skipped','sent','sent','sent']);
  assert.equal(store.state.friendReadReport.sent,3);assert.equal(store.state.friendReadReport.skipped,3);
  assert.match(store.state.friendReadReport.message,/已跳过 3 项失效视频/);
  assert.equal(store.state.paused,false);assert.equal(store.state.enabled,false);
  assert.equal(calls.tabs.filter(c=>c.op==='reload').length,0);
  assert.equal(calls.scripts.some(c=>c.args[0].action==='share'&&c.args[0].videoId===video().id),false);
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,3);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
  assert.equal(store.state.rate.some(r=>r.videoId===video().id),false);
});

test('a video removed after one successful recipient preserves that confirmation and skips only remaining recipients',async t=>{
  const settings=config();settings.rules[0].recipients=['a','b','c'].map(id=>({id,name:id,avatarKey:id}));
  let confirmed=false;
  const {worker,store,calls}=await harness(t,{state:queued(settings),config:settings},undefined,request=>{
    if(request.action==='share'&&request.mode==='confirm')confirmed=true;
    if(request.action==='videoStatus'&&confirmed)return unavailableResult();
  });
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','skipped','skipped']);
  assert.equal(store.state.friendReadReport.sent,1);assert.equal(store.state.friendReadReport.skipped,2);
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
  assert.equal(store.state.rate.length,2,'confirmed activity is retained');
});

test('late unavailable evidence cancels a pre-press reservation and continues without an unknown delivery',async t=>{
  const state=queued();enqueue(state,[nextVideo()],config());
  const {worker,store,calls}=await harness(t,{state},undefined,request=>{
    if(request.action==='share'&&request.mode==='arm'&&request.videoId===video().id)return unavailableResult();
  });
  await worker.cycle();
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['skipped','sent']);
  assert.equal(store.state.incident,null);
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
  assert.equal(store.state.rate.some(r=>r.videoId===video().id),true,'conservative reservation history is retained');
});

test('missing controls recheck a late-rendered unavailable page before spending a reload',async t=>{
  let failed=false;
  const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>{
    if(request.action==='openShare'){failed=true;return {error:'分享面板未加载',code:'SHARE_PANEL_EMPTY'};}
    if(request.action==='videoStatus'&&failed)return unavailableResult();
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'skipped');
  assert.equal(calls.tabs.filter(c=>c.op==='reload').length,0);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
});

test('unavailable evidence after an actual press remains unknown and pauses without a tombstone or retry',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>{
    if(request.action==='share'&&request.mode==='confirm')return unavailableResult();
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'unknown');assert.equal(store.state.paused,true);
  assert.equal(store.state.unavailableVideos.length,0);
  assert.equal(calls.tabs.filter(c=>c.op==='reload').length,0);
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,1);
});

test('wrong-video or unstructured unavailable evidence cannot silently discard a pending task',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>{
    if(request.action==='videoStatus')return unavailableResult('999');
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'pending');assert.equal(store.state.paused,true);
  assert.equal(store.state.unavailableVideos.length,0);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,1);
});

test('verification discovered during the late status recheck pauses without reloading or skipping',async t=>{
  let failed=false;
  const {worker,store,calls}=await harness(t,{state:queued()},undefined,request=>{
    if(request.action==='share'&&request.mode==='probe'){failed=true;return {error:'缺少好友',code:'SHARE_RECIPIENT_MISSING'};}
    if(request.action==='videoStatus'&&failed)return {error:'抖音要求安全验证'};
  });
  await worker.cycle();
  assert.equal(store.state.deliveries[0].status,'pending');assert.equal(store.state.paused,true);
  assert.equal(store.state.unavailableVideos.length,0);assert.equal(calls.tabs.filter(c=>c.op==='reload').length,0);
});

test('all-invalid automatic batches wait the configured interval and never re-enqueue stale hits',async t=>{
  const clock=budgetClock(t);let searches=0;
  const {worker,store,calls,listeners,idle}=await harness(t,{},undefined,request=>{
    if(request.action==='search'){searches++;return {payloads:[video()],truncated:false};}
    if(request.action==='videoStatus')return unavailableResult();
  });
  await worker.command({type:'AUTO_LOOP'});await idle();
  assert.equal(store.state.enabled,true);assert.equal(store.state.paused,false);
  assert.equal(store.state.deliveries[0].status,'skipped');
  assert.ok(store.state.resumePlan.at-Date.now()>=60000);
  advanceToResume(clock,store);await listeners.alarm({name:'douyin-continue'});await idle();
  assert.equal(searches,2);assert.equal(store.state.deliveries.length,1);
  assert.equal(calls.scripts.filter(c=>c.args[0].action==='videoStatus').length,1);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
  await worker.command({type:'PAUSE'});
});

test('pause while reading unavailable evidence prevents automatic skip and further queue work',async t=>{
  let workerRef,pause;
  const h=await harness(t,{state:queued()},undefined,request=>{
    if(request.action==='videoStatus'){pause=workerRef.command({type:'PAUSE'});return unavailableResult();}
  });workerRef=h.worker;
  await h.worker.cycle();await pause;
  assert.equal(h.store.state.deliveries[0].status,'pending');
  assert.equal(h.store.state.unavailableVideos.length,0);assert.equal(h.store.state.enabled,false);
});

test('a new search worker opens maximized and unfocused, and confirms muting before the first Douyin navigation',async t=>{
  const {worker,calls,store}=await harness(t,{state:{...defaultState(),enabled:true}});
  await worker.cycle();
  assert.deepEqual(calls.windows.filter(call=>call.op==='create').map(call=>call.options),[
    {url:'about:blank',focused:false,type:'normal'}
  ]);
  const navigation=calls.tabs.findIndex(call=>call.options?.url?.includes('/search/'));
  const mute=calls.tabs.findIndex(call=>call.options?.muted===true);
  assert.ok(mute>=0&&navigation>mute,'an autoplaying URL must not load before muting');
  assert.equal((await chrome.tabs.get(store.state.workerTabId)).mutedInfo.muted,true);
  assert.equal((await chrome.windows.get(store.state.workerWindowId)).state,'maximized');
  assert.equal(calls.tabs.some(call=>call.options?.active===true),false);
});

test('a worker restored to a small audible window is maximized and muted again on the next same-video recipient',async t=>{
  const settings=config();settings.rules[0].recipients=['a','b'].map(id=>({id,name:id,avatarKey:id}));
  const state=queued(settings);state.workerTabId=7;state.workerWindowId=40;
  let restored=false;
  const {worker,store,calls}=await harness(t,{state,config:settings},undefined,request=>{
    if(request.action==='share'&&request.mode==='confirm'&&!restored){
      restored=true;
      // Simulate a user restoring/unmuting the owned worker between recipients.
      void chrome.windows.update(40,{state:'normal',focused:false});
      void chrome.tabs.update(7,{muted:false});
    }
  });
  await worker.cycle(false,{queueOnly:true});
  assert.deepEqual(store.state.deliveries.map(d=>d.status),['sent','sent']);
  assert.equal(calls.windows.filter(c=>c.op==='create').length,0);
  assert.equal(calls.windows.filter(c=>c.op==='update'&&c.options.state==='maximized').length,2);
  assert.equal(calls.tabs.filter(c=>c.options?.muted===true).length,2);
  assert.equal(calls.tabs.filter(c=>c.options?.url).length,1,'the same video document must survive resizing');
  assert.equal((await chrome.tabs.get(7)).mutedInfo.muted,true);
  assert.equal((await chrome.windows.get(40)).state,'maximized');
});

test('unconfirmed muting stops a new blank worker before navigation, querying or sending',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()});
  const update=chrome.tabs.update;
  chrome.tabs.update=async(id,options)=>options.muted===true?{id,mutedInfo:{muted:false}}:update(id,options);
  await worker.cycle();
  assert.equal(store.state.paused,true);assert.match(store.state.incident.reason,/静音/);
  assert.equal(store.state.deliveries[0].status,'pending');
  assert.equal(calls.scripts.length,0);assert.equal(calls.tabs.some(c=>c.options?.url),false);
  assert.equal(calls.windows[0].options.url,'about:blank');
});

test('failure to maximize an existing worker stops before page actions without focusing another window',async t=>{
  const state=queued();state.workerTabId=7;state.workerWindowId=40;
  const {worker,store,calls}=await harness(t,{state});
  chrome.windows.update=async(_id,options)=>{assert.equal(options.focused,undefined);throw new Error('maximize failed');};
  await worker.cycle();
  assert.equal(store.state.paused,true);assert.match(store.state.incident.reason,/最大化/);
  assert.equal(store.state.deliveries[0].status,'pending');assert.equal(calls.scripts.length,0);
  assert.equal(calls.windows.filter(c=>c.op==='create').length,0);
  assert.equal(calls.debugger.some(c=>c.op==='Page.bringToFront'),false);
});

test('manual pause during pointer movement cancels before arm without an incident or alert',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()});
  const dispatch=chrome.debugger.sendCommand;let paused=false;
  chrome.debugger.sendCommand=async(target,method,params)=>{
    await dispatch(target,method,params);
    if(!paused&&method==='Input.dispatchMouseEvent'&&params.type==='mouseMoved'){
      paused=true;await worker.command({type:'PAUSE'});
    }
  };
  await worker.cycle(false,{queueOnly:true});
  assert.equal(paused,true);assert.equal(store.state.deliveries[0].status,'pending');
  assert.equal(store.state.enabled,false);assert.equal(store.state.paused,false);assert.equal(store.state.incident,null);
  assert.equal(store.state.round.status,'paused');assert.equal(store.state.friendReadReport.error,undefined);
  assert.equal(store.state.friendReadReport.stopReason,'manual-pause');
  assert.equal(calls.scripts.some(c=>c.args[0].mode==='arm'),false);
  assert.equal(calls.debugger.some(c=>c.params?.type==='mousePressed'),false);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
});

test('manual pause after arming cancels before press without alert and the pending task can resume once',async t=>{
  const {worker,store,calls,idle}=await harness(t,{state:queued()});
  const execute=chrome.scripting.executeScript;let pauseOnce=true;
  chrome.scripting.executeScript=async options=>{
    const result=await execute(options);
    if(options.args[0].mode==='arm'&&pauseOnce){pauseOnce=false;await worker.command({type:'PAUSE'});}
    return result;
  };
  await worker.cycle(false,{queueOnly:true});
  assert.equal(store.state.deliveries[0].status,'pending');assert.equal(store.state.incident,null);
  assert.equal(store.state.round.status,'paused');assert.equal(store.state.friendReadReport.error,undefined);
  assert.equal(calls.debugger.some(c=>c.params?.type==='mousePressed'),false);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.deliveries[0].status,'sent');
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
});

test('a late query failure after explicit pause is cancellation and does not create a new incident',async t=>{
  const {worker,store,calls}=await harness(t,{state:{...defaultState(),enabled:true}});
  const execute=chrome.scripting.executeScript,arrived=deferred(),release=deferred();
  chrome.scripting.executeScript=async options=>{
    if(options.args[0].action==='search'){arrived.resolve();await release.promise;throw new Error('查询响应在暂停后超时');}
    return execute(options);
  };
  const cycle=worker.cycle();await arrived.promise;await worker.command({type:'PAUSE'});release.resolve();await cycle;
  assert.equal(store.state.incident,null);assert.equal(store.state.paused,false);assert.equal(store.state.enabled,false);
  assert.equal(store.state.round.status,'paused');assert.equal(store.state.friendReadReport.error,undefined);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
});

test('manual pause before a scripted fallback prevents any possibly submitting call',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()});
  chrome.debugger.attach=async()=>{throw new Error('debugger unavailable');};
  const execute=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async options=>{
    if(options.args[0].action==='share'&&options.args[0].mode==='probe'){
      await worker.command({type:'PAUSE'});return [{result:{fallback:true}}];
    }
    return execute(options);
  };
  await worker.cycle(false,{queueOnly:true});
  assert.equal(store.state.deliveries[0].status,'pending');assert.equal(store.state.incident,null);
  assert.equal(calls.scripts.some(c=>c.args[0].action==='share'&&!c.args[0].mode),false);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,0);
});

test('a possible press followed by pause and missing receipt still preserves unknown and a real alert',async t=>{
  const {worker,store,calls}=await harness(t,{state:queued()});
  const execute=chrome.scripting.executeScript;
  chrome.scripting.executeScript=async options=>{
    if(options.args[0].mode==='confirm'){
      await worker.command({type:'PAUSE'});return [{result:{error:'发送结果无法确认，未捕获回执'}}];
    }
    return execute(options);
  };
  await worker.cycle(false,{queueOnly:true});
  assert.equal(store.state.deliveries[0].status,'unknown');assert.equal(store.state.paused,true);
  assert.equal(calls.debugger.filter(c=>c.params?.type==='mousePressed').length,1);
  assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,1);
});

test('manual pause does not erase an existing real incident or its pending mail retry',async t=>{
  const state=queued();failDelivery(state,state.deliveries[0].key,'真实发送结果不明');
  const incidentId=state.incident.id;
  const {worker,store,calls}=await harness(t,{state});
  await worker.command({type:'PAUSE'});await worker.reportIncident();
  assert.equal(store.state.incident.id,incidentId);assert.equal(store.state.deliveries[0].status,'unknown');
  assert.equal(store.state.incident.notified,true);assert.equal(calls.fetch.filter(c=>c.url.endsWith('/alert')).length,1);
});

for(const mode of ['START','AUTO_LOOP','SEND_PENDING'])test('mail disabled starts '+mode+' without a token or reachable mail service',async t=>{
  const settings={...config(),mailAlertsEnabled:false,mailBridgeToken:''};
  const state=mode==='SEND_PENDING'?queued(settings):defaultState();state.enabled=false;
  const {worker,store,calls,idle}=await harness(t,{config:settings,state},async()=>{throw new Error('mail service absent');});
  assert.equal((await worker.command({type:mode})).started,true);await idle();
  assert.equal(calls.fetch.length,0);assert.equal(store.state.incident,null);
  if(mode==='SEND_PENDING')assert.equal(store.state.deliveries[0].status,'sent');
  await worker.command({type:'PAUSE'});
});

test('mail disabled retains real uncertainty on the page but never sends or retries mail even with a saved token',async t=>{
  const settings={...config(),mailAlertsEnabled:false};
  const {worker,store,calls,idle}=await harness(t,{config:settings,state:{...queued(settings),enabled:false}},async()=>{throw new Error('must not contact service');},request=>{
    if(request.mode==='confirm')return {error:'发送回执不明'};
  });
  await worker.command({type:'SEND_PENDING'});await idle();await worker.reportIncident();
  assert.equal(store.state.deliveries[0].status,'unknown');assert.equal(store.state.paused,true);
  assert.equal(store.state.incident.notified,false);assert.equal(store.state.incident.mailError,undefined);
  assert.equal(calls.fetch.length,0);
});

test('disabled mail endpoints cannot send test mail or perform a health request',async t=>{
  const {worker,calls}=await harness(t,{config:{...config(),mailAlertsEnabled:false}});
  assert.deepEqual(await worker.command({type:'MAIL_HEALTH'}),{enabled:false,configured:false,skipped:true});
  await assert.rejects(worker.command({type:'MAIL_TEST'}),/已关闭/);
  assert.equal(calls.fetch.length,0);
});

test('enabled mail still requires a valid connection token before starting',async t=>{
  const {worker,store,calls}=await harness(t,{config:{...config(),mailAlertsEnabled:true,mailBridgeToken:''}});
  await assert.rejects(worker.command({type:'START'}),/连接令牌/);
  assert.equal(store.state.enabled,false);assert.equal(calls.fetch.length,0);assert.equal(calls.scripts.length,0);
});

test('an older saved token preserves enabled notifications without requiring reconfiguration',async t=>{
  const {worker,store,calls}=await harness(t);
  assert.equal(store.config.mailAlertsEnabled,true);
  await worker.command({type:'MAIL_HEALTH'});assert.equal(calls.fetch.length,1);
});

test('real incidents sound once with email off, manual pause is silent, and resume clears the badge',async t=>{
  const settings={...config(),mailAlertsEnabled:false};
  const state=queued(settings);state.enabled=false;
  const {worker,store,calls,idle}=await harness(t,{state,config:settings});
  await worker.command({type:'PAUSE'});assert.equal(calls.audio.length,0);
  store.state.paused=true;store.state.incident={id:'browser-only',reason:'需要本人验证',notified:false};
  await Promise.all([worker.reportIncident(),worker.reportIncident()]);
  assert.equal(calls.audio.length,1);assert.equal(calls.fetch.length,0);assert.equal(calls.badges.at(-1),'!');
  await worker.command({type:'SEND_PENDING'});await idle();
  assert.equal(store.state.incident,null);assert.equal(calls.badges.at(-1),'');assert.equal(calls.audio.length,1);
});

test('local sound preview never performs mail or Douyin operations',async t=>{
  const {worker,store,calls}=await harness(t,{config:{...config(),mailAlertsEnabled:false}});
  assert.deepEqual(await worker.command({type:'BROWSER_ALERT_TEST'}),{played:true});
  assert.equal(calls.audio.length,1);assert.equal(calls.fetch.length,0);assert.equal(calls.scripts.length,0);assert.equal(store.state.incident,null);
});
