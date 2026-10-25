import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultState, validateConfig, normalizeVideo, collectVideos, matchRules, enqueue,
  nextDelivery, nextDeliveryAt, reserveDelivery, completeDelivery, failDelivery, abortDelivery, recoverState,
  resolveDelivery, makeKey, beginRound, updateRoundResults, finishRound, skipUnavailableVideo
} from '../extension/core.js';

const NOW = 1_800_000_000_000;
const friend = id => ({ id, name: `好友${id}`, avatarKey: `avatar-${id}` });
const rule = (overrides = {}) => ({ id: 'r1', name: '话题', tags: ['爱慕杰', '胖胖蜘蛛侠'], keywords: [], recipients: [friend('a')], ...overrides });
const config = (rules = [rule()]) => ({ account: { id: 'bot', name: '专用账号' }, rules });
const raw = (id = '1', overrides = {}) => ({ aweme_id: id, create_time: NOW / 1000 - 10,
  aweme_type: 0, video: { play_addr: {} }, desc: '示例视频',
  text_extra: [{ type: 1, hashtag_id: 'tag-1', hashtag_name: '爱慕杰' }], ...overrides });
const video = (id = '1', overrides = {}) => normalizeVideo(raw(id, overrides));
const running = () => ({ ...defaultState(), enabled: true });

test('unavailable videos skip only matching pending recipients, retaining confirmations, uncertainty and limits',()=>{
  const state=running(),settings=config([rule({recipients:['a','b','c','d','e'].map(friend)})]);
  enqueue(state,[video(),video('2')],settings,NOW);
  enqueue(state,[video()],{...settings,account:{id:'other'}},NOW);
  const [sent,unknown,sending]=state.deliveries;
  sent.status='sent';unknown.status='unknown';sending.status='sending';
  state.rate=[{videoId:'1',at:NOW}];beginRound(state,{nowMs:NOW});
  assert.equal(skipUnavailableVideo(state,'bot','1','not-found',NOW),2);
  assert.deepEqual(state.deliveries.slice(0,5).map(d=>d.status),['sent','unknown','sending','skipped','skipped']);
  assert.ok(state.deliveries.slice(5).every(d=>d.status==='pending'));
  assert.deepEqual(state.rate,[{videoId:'1',at:NOW}]);
  assert.equal(state.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===state.round.id).length,0);
  assert.equal(state.unavailableVideos.length,1);
  assert.equal(skipUnavailableVideo(state,'bot','1','not-found',NOW),0);
  assert.equal(state.unavailableVideos.length,1);
});

test('unavailable evidence survives recovery and prevents stale search results for newly selected friends',()=>{
  const state=running();enqueue(state,[video()],config(),NOW);
  skipUnavailableVideo(state,'bot','1','not-found',NOW);
  state.unavailableVideos.push(null,{accountId:'bot',videoId:1,reason:'not-found',at:NOW},{accountId:'bot',videoId:'2',reason:'network',at:NOW});
  const restored=recoverState(structuredClone(state),NOW);
  assert.equal(restored.unavailableVideos.length,1);
  assert.equal(enqueue(restored,[video()],config([rule({recipients:[friend('new')]})]),NOW),0);
  assert.equal(enqueue(restored,[video()],{...config(),account:{id:'another'}},NOW),1);
  assert.throws(()=>skipUnavailableVideo(restored,'bot','2','network',NOW),/无效/);
});

test('round changes preserve deduplication and rate history; interrupted confirmation stays attributable', () => {
  const state=running();
  enqueue(state,[video()],config(),NOW);
  const first=beginRound(state,{nowMs:NOW});
  reserveDelivery(state,state.deliveries[0].key,NOW);
  failDelivery(state,state.deliveries[0].key,'回执不明',NOW);
  const restored=recoverState(structuredClone(state),NOW+1);
  assert.equal(restored.round.status,'interrupted');
  resolveDelivery(restored,restored.deliveries[0].key,'sent',NOW+2);
  assert.equal(restored.deliveries[0].attemptRoundId,first);
  const oldRate=structuredClone(restored.rate);
  const second=beginRound(restored,{nowMs:NOW});
  assert.notEqual(second,first,'same wall-clock time must still create a distinct round');
  assert.equal(restored.deliveries.filter(d=>d.status==='sent'&&d.attemptRoundId===second).length,0);
  assert.equal(enqueue(restored,[video()],config(),NOW+3),0,'statistics must not discard deduplication');
  assert.deepEqual(restored.rate,oldRate);
});

test('only the active round can publish results; preview is unique and bounded with a full count', () => {
  const state=running(),old=beginRound(state),current=beginRound(state);
  const videos=Array.from({length:105},(_,i)=>video(String(i+1)));
  assert.equal(updateRoundResults(state,old,videos),false);
  assert.equal(updateRoundResults(state,current,[...videos,videos[0]],{done:true}),true);
  assert.equal(state.round.foundCount,105);
  assert.equal(state.round.videos.length,100);
  finishRound(state,current);
  assert.equal(updateRoundResults(state,current,[]),false,'late progress cannot replace a finished round');
});
function sendNext(state, time = NOW) {
  const item = nextDelivery(state, time);
  assert.ok(item);
  reserveDelivery(state, item.key, time);
  completeDelivery(state, item.key, time);
  return item;
}

test('tag requires structural identity; title, desc and unrelated text_extra do not count', () => {
  const fake = video('1', { desc: '#爱慕杰 #胖胖蜘蛛侠', title: '爱慕杰',
    text_extra: [{ type: 0, hashtag_id: 'tag-1', hashtag_name: '爱慕杰' },
      { type: 1, hashtag_name: '胖胖蜘蛛侠' }] });
  assert.deepEqual(matchRules(fake, [rule()]), []);
  assert.equal(matchRules(video(), [rule()]).length, 1);
  assert.equal(matchRules(video('2', { text_extra: [], cha_list: [{ cid: 'c', cha_name: '胖胖蜘蛛侠' }] }), [rule()]).length, 1);
});

test('tag matching is exact, strips config # prefix and supports stable tag id', () => {
  assert.equal(matchRules(video(), [rule({ tags: ['#爱慕杰'] })]).length, 1);
  assert.equal(matchRules(video(), [rule({ tags: ['慕杰', '艾慕杰'] })]).length, 0);
  assert.equal(matchRules(video(), [rule({ tags: [{ id: 'tag-1', name: 'old-name' }] })]).length, 1);
  assert.equal(matchRules(video(), [rule({ tags: [{ id: 'different', name: '爱慕杰' }] })]).length, 0);
});

test('keywords use title or description, OR with tags, and ignore comments', () => {
  const keywords = rule({ tags: [], keywords: ['hello', '新品'] });
  assert.equal(matchRules(video('1', { title: 'HELLO 世界' }), [keywords]).length, 1);
  assert.equal(matchRules(video('2', { desc: '今日新品' }), [keywords]).length, 1);
  assert.equal(matchRules(video('3', { comments: [{ text: 'hello' }] }), [keywords]).length, 0);
  assert.equal(matchRules(video(), [rule({ keywords: ['不存在'] })]).length, 1);
  assert.equal(matchRules(video(), [rule({ enabled: false })]).length, 0);
});

test('normalization excludes image posts and incomplete records', () => {
  assert.equal(normalizeVideo(raw('1', { aweme_type: 68 })), null);
  assert.equal(normalizeVideo(raw('1', { aweme_type: 2 })), null);
  assert.equal(normalizeVideo(raw('1', { images: [{ uri: 'image' }] })), null);
  assert.equal(normalizeVideo(raw('1', { image_post_info: {} })), null);
  assert.equal(normalizeVideo(raw('1', { video: undefined })), null);
  assert.equal(normalizeVideo(raw('1', { create_time: 'invalid' })), null);
  assert.equal(normalizeVideo({ desc: '爱慕杰' }), null);
});

test('search payload collection supports wrappers, pagination duplicates, cycles and normalized records', () => {
  const payload = { data: [{ aweme_info: raw() }, { aweme_info: raw() }, raw('2')],
    suggestions: [{ text: '#爱慕杰' }], cached: video('3') };
  payload.circular = payload;
  assert.deepEqual(collectVideos(payload).map(item => item.id), ['1', '2', '3']);
});

test('draft config can precede account/friends; ready config fails closed', () => {
  const draft = validateConfig({ rules: [{ id: 'r', tags: [' #爱慕杰 ', ''], keywords: ['  hello  '] }], mailBridgeToken: 'keep' });
  assert.equal(draft.maxPages, 3);
  assert.equal(draft.schemaVersion, 1);
  assert.equal(draft.mailBridgeToken, 'keep');
  assert.equal(draft.account, null);
  assert.equal(validateConfig({ account: { id: '', name: '' } }).account, null);
  assert.deepEqual(draft.rules[0].tags, ['爱慕杰']);
  assert.deepEqual(draft.rules[0].keywords, ['hello']);
  assert.throws(() => validateConfig(draft, { ready: true }), /账号/);
  assert.throws(() => validateConfig(config([rule({ recipients: [] })]), { ready: true }), /好友/);
  assert.throws(() => validateConfig(config([rule({ tags: [] })]), { ready: true }), /关键词/);
  assert.throws(() => validateConfig({ ...config(), maxPages: 0 }), /搜索页数/);
  assert.throws(() => validateConfig(config([rule(), rule()])), /唯一/);
  assert.throws(() => validateConfig(config([rule({ enabled: false })]), { ready: true }), /启用一条规则/);
  assert.equal(validateConfig(config([rule({ enabled: false })])).rules[0].enabled, false);
  assert.throws(() => validateConfig(config([rule({ recipients: [{ id: 'a', name: '好友' }] })]), { ready: true }), /身份指纹/);
  assert.throws(() => validateConfig(config([rule({ recipients: [{ id: 'a', name: '', secUid: 's' }] })]), { ready: true }), /身份指纹/);
  assert.equal(validateConfig(config([rule({ recipients: [{ id: 'a', name: '好友', secUid: 's' }] })]), { ready: true }).rules[0].recipients[0].secUid, 's');
});

test('a numeric uid is a complete friend identity and can never disagree with its id', () => {
  const uid = '7123456789012345678';
  const bound = validateConfig(config([rule({ recipients: [{ id: `uid:${uid}`, uid, name: '好友' }] })]), { ready: true });
  assert.equal(bound.rules[0].recipients[0].id, `uid:${uid}`);
  assert.equal(bound.rules[0].recipients[0].uid, uid);
  assert.equal(typeof bound.rules[0].recipients[0].uid, 'string');
  assert.throws(() => validateConfig(config([rule({ recipients: [{ id: 'uid:1', uid: '2', name: '好友' }] })]), { ready: true }), /不一致/);
  assert.throws(() => validateConfig(config([rule({ recipients: [{ id: 'uid:1', name: '好友' }] })]), { ready: true }), /UID 缺失/);
  assert.throws(() => validateConfig(config([rule({ recipients: [{ id: 'a', uid: 'not-a-uid', name: '好友' }] })]), { ready: true }), /UID 格式无效/);
  // Two friends with the same nickname remain two distinct queue targets.
  const state = running();
  enqueue(state, [video('1')], config([rule({ recipients: [
    { id: `uid:${uid}`, uid, name: '同名' }, { id: 'uid:7123456789012345679', uid: '7123456789012345679', name: '同名' }] })]), NOW);
  assert.equal(state.deliveries.length, 2);
  assert.deepEqual(state.deliveries.map((d) => d.recipient.id).sort(), [`uid:${uid}`, 'uid:7123456789012345679'].sort());
});

test('check interval, video window and rate ceiling are validated user settings', () => {
  const defaults = validateConfig(config([rule()]), { ready: true });
  assert.deepEqual([defaults.checkIntervalSeconds, defaults.videoWindowMinutes, defaults.maxVideosPerWindow], [60, 60, 5]);
  const custom = validateConfig({ ...config([rule()]), checkIntervalSeconds: 120, videoWindowMinutes: 30, maxVideosPerWindow: 2 }, { ready: true });
  assert.deepEqual([custom.checkIntervalSeconds, custom.videoWindowMinutes, custom.maxVideosPerWindow], [120, 30, 2]);
  assert.throws(() => validateConfig({ ...config(), checkIntervalSeconds: 5 }), /检查间隔/);
  assert.throws(() => validateConfig({ ...config(), checkIntervalSeconds: 1.5 }), /检查间隔/);
  assert.throws(() => validateConfig({ ...config(), videoWindowMinutes: 0 }), /新视频窗口/);
  assert.equal(validateConfig({ ...config(), videoWindowMinutes: 43200 }).videoWindowMinutes, 43200, 'one month is allowed');
  assert.throws(() => validateConfig({ ...config(), videoWindowMinutes: 43201 }), /新视频窗口/);
  assert.throws(() => validateConfig({ ...config(), maxVideosPerWindow: 0 }), /每分钟/);
});

test('the configured window and rate ceiling really gate enqueue and sending', () => {
  const settings = validateConfig({ ...config([rule({ recipients: [friend('a')] })]), videoWindowMinutes: 10, maxVideosPerWindow: 2 }, { ready: true });
  const state = running();
  enqueue(state, [video('1', { create_time: NOW / 1000 - 30 * 60 })], settings, NOW);
  assert.equal(state.deliveries.length, 0, 'older than the configured window');
  enqueue(state, [video('2', { create_time: NOW / 1000 - 5 * 60 })], settings, NOW);
  assert.equal(state.deliveries.length, 1, 'inside the configured window');
  enqueue(state, [video('3'), video('4')], settings, NOW);
  sendNext(state, NOW);
  sendNext(state, NOW);
  assert.equal(nextDelivery(state, NOW, settings), null, 'rate ceiling respected');
  const relaxed = nextDelivery(state, NOW, { maxVideosPerWindow: 5 });
  assert.ok(relaxed, 'a higher ceiling allows the next video');
  assert.equal(relaxed.video.id, '4');
});

test('video IDs are numeric and every raw, normalized, enqueued or restored URL is canonical', () => {
  assert.equal(normalizeVideo(raw('../outside')), null);
  assert.equal(normalizeVideo({ ...video(), id: '1?next=https://example.com' }), null);
  const imported = { ...video('123'), url: 'https://example.com/unsafe' };
  assert.equal(normalizeVideo(imported).url, 'https://www.douyin.com/video/123');
  const state = running();
  enqueue(state, [imported], config(), NOW);
  assert.equal(state.deliveries[0].video.url, 'https://www.douyin.com/video/123');
  state.deliveries[0].video.url = 'javascript:alert(1)';
  const restored = recoverState(state, NOW);
  assert.equal(restored.deliveries[0].video.url, 'https://www.douyin.com/video/123');
  restored.deliveries[0].video.id = 'external';
  assert.throws(() => recoverState(restored, NOW), /无效视频/);
});

test('logs use level and newest-first order, bounded to 200 records', () => {
  const state = running();
  for (let index = 0; index < 205; index++) enqueue(state, [video(String(1000 + index))], config(), NOW + index);
  assert.equal(state.logs.length, 200);
  assert.equal(state.logs[0].at, NOW + 204);
  assert.equal(state.logs[199].at, NOW + 5);
  assert.equal(state.logs[0].level, 'info');
  assert.equal(Object.hasOwn(state.logs[0], 'type'), false);
  failDelivery(state, state.deliveries[0].key, '故障', NOW + 300);
  assert.equal(state.logs[0].level, 'error');
  assert.equal(state.logs[0].at, NOW + 300);
  assert.equal(state.logs.length, 200);
});

test('discovery admits one-hour boundary, excludes old and future videos', () => {
  const state = running();
  const count = enqueue(state, [video('101', { create_time: NOW / 1000 }),
    video('102', { create_time: NOW / 1000 - 3600 }),
    video('103', { create_time: NOW / 1000 - 3601 }),
    video('104', { create_time: NOW / 1000 + 1 })], config(), NOW);
  assert.equal(count, 2);
  assert.deepEqual(state.deliveries.map(item => item.video.id), ['101', '102']);
});

test('overlapping rules union recipients and deduplicate account/video/recipient after JSON restart', () => {
  const state = running();
  const rules = [rule({ recipients: [friend('a'), friend('b')] }),
    rule({ id: 'r2', recipients: [friend('b'), friend('c')] })];
  assert.equal(enqueue(state, [video()], config(rules), NOW), 3);
  assert.deepEqual(state.deliveries.find(item => item.recipient.id === 'b').ruleIds, ['r1', 'r2']);
  sendNext(state);
  const restarted = recoverState(JSON.parse(JSON.stringify(state)), NOW + 1000);
  assert.equal(enqueue(restarted, [video()], config(rules), NOW + 1000), 0);
  assert.equal(restarted.deliveries[0].status, 'sent');
  assert.equal(enqueue(restarted, [video()], { ...config(), account: { id: 'other' } }, NOW + 1000), 1);
  assert.notEqual(makeKey('a|b', 'c', 'd'), makeKey('a', 'b|c', 'd'));
});

test('FIFO persists and already queued items remain eligible after one hour', () => {
  const state = running();
  enqueue(state, [video('201'), video('202')], config(), NOW);
  assert.equal(sendNext(state, NOW + 2 * 3_600_000).video.id, '201');
  assert.equal(nextDelivery(state, NOW + 2 * 3_600_000).video.id, '202');
});

test('an open video finishes its non-adjacent pending recipients before FIFO advances to another video', () => {
  const settings = config([rule({ recipients: [friend('a'), friend('b')] })]);
  const state = running();
  enqueue(state, [video('201'), video('202')], settings, NOW);
  state.deliveries = [state.deliveries[0], state.deliveries[2], state.deliveries[1], state.deliveries[3]];
  const first = sendNext(state, NOW);
  assert.equal(first.video.id, '201');
  const same = nextDelivery(state, NOW + 1, settings, '201');
  assert.equal(same.video.id, '201');
  assert.equal(same.recipient.id, 'b');
  reserveDelivery(state, same.key, NOW + 1, settings, '201');
  completeDelivery(state, same.key, NOW + 2);
  assert.equal(nextDelivery(state, NOW + 3, settings, '201').video.id, '202');
});

test('group preference still honors unknown records and the distinct-video rate limit', () => {
  const settings = { ...config([rule({ recipients: [friend('a'), friend('b')] })]), maxVideosPerWindow: 1 };
  const state = running();
  enqueue(state, [video('201'), video('202')], settings, NOW);
  sendNext(state, NOW);
  const same = nextDelivery(state, NOW + 1, settings, '201');
  assert.equal(same.recipient.id, 'b');
  reserveDelivery(state, same.key, NOW + 1, settings, '201');
  failDelivery(state, same.key, '确认不明', NOW + 2);
  assert.equal(nextDelivery(state, NOW + 3, settings, '202'), null);
  resolveDelivery(state, same.key, 'sent', NOW + 4);
  state.paused = false;
  assert.equal(nextDelivery(state, NOW + 5, settings, '202'), null);
});

test('rolling 60 seconds limits distinct videos; multiple friends do not consume additional slots', () => {
  const state = running();
  enqueue(state, Array.from({ length: 6 }, (_, index) => video(String(index))),
    config([rule({ recipients: [friend('a'), friend('b'), friend('c')] })]), NOW);
  for (let index = 0; index < 15; index++) sendNext(state, NOW + index * 1000);
  assert.equal(nextDelivery(state, NOW + 59_999), null);
  // Only video 0 has expired, so the sixth video may start at exactly 62 s.
  assert.equal(nextDelivery(state, NOW + 60_000), null);
  assert.equal(nextDelivery(state, NOW + 62_000).video.id, '5');
});

test('each recipient start extends that video presence in the sliding window', () => {
  const state = running();
  enqueue(state, Array.from({ length: 6 }, (_, index) => video(String(index))),
    config([rule({ recipients: [friend('a'), friend('b')] })]), NOW);
  sendNext(state, NOW);
  sendNext(state, NOW + 61_000); // Same video must count in this new window.
  for (let index = 0; index < 8; index++) sendNext(state, NOW + 62_000 + index * 100);
  assert.equal(nextDelivery(state, NOW + 70_000), null);
  assert.equal(nextDelivery(state, NOW + 121_000).video.id, '5');
});

test('slow native send completion remains in the rolling window after its reservation expires', () => {
  const state = running();
  enqueue(state, Array.from({ length: 6 }, (_, index) => video(String(index + 1))), config(), NOW);
  const first = nextDelivery(state, NOW);
  reserveDelivery(state, first.key, NOW);
  completeDelivery(state, first.key, NOW + 59_000);
  assert.ok(state.rate.some(entry => entry.videoId === first.video.id && entry.at === NOW));
  assert.ok(state.rate.some(entry => entry.videoId === first.video.id && entry.at === NOW + 59_000));
  for (let index = 0; index < 4; index++) sendNext(state, NOW + 60_000 + index * 1000);
  assert.equal(nextDelivery(state, NOW + 64_000), null);
  assert.equal(nextDelivery(state, NOW + 118_999), null);
  assert.equal(nextDelivery(state, NOW + 119_000).video.id, '6');
});

test('reservation is serial, must follow FIFO and must be persisted before share', () => {
  const state = running();
  enqueue(state, [video('301'), video('302')], config(), NOW);
  assert.throws(() => reserveDelivery(state, state.deliveries[1].key, NOW), /顺序/);
  const first = nextDelivery(state, NOW);
  reserveDelivery(state, first.key, NOW);
  assert.equal(first.status, 'sending');
  assert.equal(nextDelivery(state, NOW), null);
  assert.throws(() => completeDelivery(state, state.deliveries[1].key, NOW), /发送中/);
});

test('uncertain send pauses globally without disabling and requires explicit resolution and resume', () => {
  const state = running();
  enqueue(state, [video('301'), video('302')], config(), NOW);
  const first = nextDelivery(state, NOW);
  reserveDelivery(state, first.key, NOW);
  failDelivery(state, first.key, new Error('没有收到成功提示'), NOW + 1);
  assert.equal(state.enabled, true);
  assert.equal(state.paused, true);
  assert.equal(first.status, 'unknown');
  assert.equal(state.incident.reason, '没有收到成功提示');
  assert.ok(state.incident.id);
  state.paused = false;
  assert.equal(nextDelivery(state, NOW + 2), null); // Unknown cannot be bypassed.
  state.paused = true;
  resolveDelivery(state, first.key, 'sent', NOW + 3);
  assert.equal(nextDelivery(state, NOW + 4), null);
  state.paused = false;
  assert.equal(nextDelivery(state, NOW + 5).video.id, '302');
});

test('restart converts sending to unknown, persists incident without notifying twice', () => {
  const state = running();
  enqueue(state, [video()], config(), NOW);
  reserveDelivery(state, state.deliveries[0].key, NOW);
  const restored = recoverState(JSON.parse(JSON.stringify(state)), NOW + 100);
  assert.equal(restored.paused, true);
  assert.equal(restored.deliveries[0].status, 'unknown');
  assert.equal(restored.incident.notified, false);
  restored.incident.notified = true;
  const again = recoverState(JSON.parse(JSON.stringify(restored)), NOW + 200);
  assert.equal(again.incident.notified, true);
  assert.equal(again.incident.id, restored.incident.id);
  assert.equal(nextDelivery(again, NOW + 200), null);
});

test('incident IDs stay short for long recipient fingerprints and remain stable after recovery', () => {
  const state = running();
  const settings = config([rule({ recipients: [{ ...friend('a'), id: 'avatar:' + 'x'.repeat(1000) }] })]);
  enqueue(state, [video()], settings, NOW);
  failDelivery(state, state.deliveries[0].key, '无法确认发送', NOW);
  assert.match(state.incident.id, /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/);
  const restored = recoverState(JSON.parse(JSON.stringify(state)), NOW + 100);
  assert.equal(restored.incident.id, state.incident.id);
  assert.ok(restored.incident.id.length <= 160);
});

test('manual retry and skip retain dedupe history and pause until explicit resume', () => {
  for (const action of ['retry', 'skip']) {
    const state = running();
    enqueue(state, [video()], config(), NOW);
    const key = state.deliveries[0].key;
    failDelivery(state, key, '验证码', NOW);
    resolveDelivery(state, key, action, NOW + 100);
    assert.equal(state.deliveries[0].status, action === 'retry' ? 'pending' : 'skipped');
    assert.equal(state.paused, true);
    assert.equal(enqueue(state, [video()], config(), NOW + 200), 0);
  }
});

test('aborting a send that never started requeues it without pausing', () => {
  const state = running();
  enqueue(state, [video('1')], config(), NOW);
  const key = state.deliveries[0].key;
  reserveDelivery(state, key, NOW);
  assert.equal(state.deliveries[0].status, 'sending');
  abortDelivery(state, key, 'Detached while handling command.', NOW);
  assert.equal(state.deliveries[0].status, 'pending');
  assert.match(state.deliveries[0].error, /Detached/);
  assert.equal(state.paused, false);
  assert.equal(state.incident, null);
});

test('disabled and paused states cannot send; recovery tolerates missing arrays', () => {
  const state = defaultState();
  enqueue(state, [video()], config(), NOW);
  assert.equal(nextDelivery(state, NOW), null);
  state.enabled = true;
  state.paused = true;
  assert.equal(nextDelivery(state, NOW), null);
  assert.deepEqual(recoverState({ deliveries: null, logs: null, rate: null }, NOW).deliveries, []);
});


test('rate wait expires at the latest activity of each distinct video and agrees with nextDelivery',()=>{
  const state=running();enqueue(state,[video('9')],config(),NOW);
  state.rate=[{videoId:'1',at:NOW-50000},{videoId:'1',at:NOW-10000},{videoId:'2',at:NOW-20000}];
  const ready=nextDeliveryAt(state,NOW,{maxVideosPerWindow:2});
  assert.equal(ready,NOW+40000);
  assert.equal(nextDelivery(state,ready-1,{maxVideosPerWindow:2}),null);
  assert.ok(nextDelivery(state,ready,{maxVideosPerWindow:2}));
});

test('lowered video caps wait for enough distinct slots, while the current video can continue now',()=>{
  const state=running();enqueue(state,[video('9')],config(),NOW);
  state.rate=[{videoId:'1',at:NOW-50000},{videoId:'2',at:NOW-30000},{videoId:'3',at:NOW-10000}];
  assert.equal(nextDeliveryAt(state,NOW,{maxVideosPerWindow:1}),NOW+50000);
  state.rate.push({videoId:'9',at:NOW-1});
  assert.equal(nextDeliveryAt(state,NOW,{maxVideosPerWindow:1}),NOW);
  state.paused=true;
  assert.equal(nextDeliveryAt(state,NOW,{maxVideosPerWindow:1}),null);
});
