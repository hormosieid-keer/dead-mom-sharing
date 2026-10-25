// Shared by the Manifest V3 worker and the Ubuntu runner. No browser globals.
const WINDOW_MS = 60_000;
const VIDEO_AGE_MS = 3_600_000;
// Editable at runtime; the constants stay as the documented defaults.
export const DEFAULTS = Object.freeze({ checkIntervalSeconds: 60, videoWindowMinutes: 60, maxVideosPerWindow: 5 });
const setting = (value, fallback, min, max, label) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
  return number;
};
const MAX_LOGS = 200;
const str = value => value == null ? '' : String(value).trim();
const tagName = value => str(value).replace(/^#+/, '');
const unique = values => [...new Set(values)];

export function defaultState() {
  return { version: 1, enabled: false, paused: false, incident: null, deliveries: [], rate: [], logs: [], round: null,
    searchCheckpoint: null, scanCheckpoint: null, resumePlan: null, unavailableVideos: [] };
}

export function makeKey(accountId, videoId, recipientId) {
  return JSON.stringify([str(accountId), str(videoId), str(recipientId)]);
}

export function validateConfig(config, { ready = false } = {}) {
  if (!config || typeof config !== 'object') throw new Error('配置不能为空');
  const account = str(config.account?.id) ? { ...config.account, id: str(config.account.id), name: str(config.account.name) } : null;
  if (ready && !account?.id) throw new Error('请先绑定 bot 账号');
  if (config.rules != null && !Array.isArray(config.rules)) throw new Error('规则必须为列表');
  if (ready && !config.rules?.length) throw new Error('请至少添加一条规则');
  if (ready && !config.rules.some(rule => rule && rule.enabled !== false)) throw new Error('请至少启用一条规则');
  const ids = new Set();
  const rules = (config.rules || []).map((rule, index) => {
    if (!rule || typeof rule !== 'object') throw new Error(`规则 ${index + 1} 格式错误`);
    const id = str(rule.id);
    if (!id || ids.has(id)) throw new Error('每条规则必须有唯一 ID');
    ids.add(id);
    if (rule.tags != null && !Array.isArray(rule.tags)) throw new Error('话题必须为列表');
    if (rule.keywords != null && !Array.isArray(rule.keywords)) throw new Error('关键词必须为列表');
    const tags = (rule.tags || []).map(tag => typeof tag === 'string' ? tagName(tag) : {
      id: str(tag?.id), name: tagName(tag?.name)
    }).filter(tag => typeof tag === 'string' ? tag : tag.id || tag.name);
    const keywords = unique((rule.keywords || []).map(str).filter(Boolean));
    if (ready && rule.enabled !== false && !tags.length && !keywords.length) throw new Error(`规则 ${index + 1} 至少需要一个话题或关键词`);
    if (rule.recipients != null && !Array.isArray(rule.recipients)) throw new Error('好友必须为列表');
    if (ready && rule.enabled !== false && !rule.recipients?.length) throw new Error(`规则 ${index + 1} 未选择好友`);
    const recipients = [...new Map((rule.recipients || []).map(recipient => {
      const item = { ...recipient, id: str(recipient?.id), uid: str(recipient?.uid), name: str(recipient?.name),
        avatar: str(recipient?.avatar), avatarKey: str(recipient?.avatarKey), secUid: str(recipient?.secUid) };
      // The numeric Douyin uid is the only stable friend identity. Nicknames and
      // avatars rotate, so a uid-bound recipient must never carry another id.
      if (item.uid && !/^\d+$/u.test(item.uid)) throw new Error('好友 UID 格式无效，请重新读取好友列表');
      const uidId = item.uid ? `uid:${item.uid}` : '';
      if (uidId && item.id && item.id !== uidId) throw new Error('好友 UID 与身份 ID 不一致，请重新绑定');
      if (!uidId && item.id.startsWith('uid:')) throw new Error('好友 UID 缺失，请重新读取好友列表');
      if (uidId) item.id = uidId;
      if (!item.id) throw new Error('好友必须具有稳定的身份 ID');
      if (ready && (!item.name || (!item.uid && !item.secUid && !item.avatarKey))) throw new Error('好友缺少名称或身份指纹，请重新读取好友列表');
      return [item.id, item];
    })).values()];
    return { ...rule, id, name: str(rule.name) || `规则 ${index + 1}`, tags, keywords, recipients };
  });
  const maxPages = Number(config.maxPages ?? 3);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('搜索页数必须为 1 到 10 的整数');
  const checkIntervalSeconds = setting(config.checkIntervalSeconds, DEFAULTS.checkIntervalSeconds, 30, 3600, '检查间隔（秒）');
  // One month is the ceiling: 30 days of minutes.
  const videoWindowMinutes = setting(config.videoWindowMinutes, DEFAULTS.videoWindowMinutes, 5, 43200, '新视频窗口（分钟）');
  const maxVideosPerWindow = setting(config.maxVideosPerWindow, DEFAULTS.maxVideosPerWindow, 1, 30, '每分钟视频上限');
  return { ...config, schemaVersion: 1, maxPages, checkIntervalSeconds, videoWindowMinutes, maxVideosPerWindow, account, rules };
}

export function normalizeVideo(raw) {
  const item = raw?.aweme_info || raw?.aweme_detail || raw;
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'video' && /^\d+$/.test(str(item.id)) && Number.isFinite(item.publishedAt)) {
    return { ...item, id: str(item.id), description: str(item.description), title: str(item.title),
      url: `https://www.douyin.com/video/${str(item.id)}`,
      tags: (Array.isArray(item.tags) ? item.tags : []).filter(tag => str(tag?.id) && tagName(tag?.name)).map(tag => ({ id: str(tag.id), name: tagName(tag.name) })) };
  }
  const id = str(item.aweme_id);
  // A cover on an image post is not proof of a playable video.
  if (!/^\d+$/.test(id) || !item.video || typeof item.video !== 'object' || Array.isArray(item.video) ||
      [2, 68, 150].includes(Number(item.aweme_type)) ||
      (Array.isArray(item.images) && item.images.length) || item.image_post_info) return null;
  const seconds = Number(item.create_time);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const tags = new Map();
  for (const extra of Array.isArray(item.text_extra) ? item.text_extra : []) {
    if (!extra || Number(extra.type) !== 1) continue;
    const id = str(extra.hashtag_id), name = tagName(extra.hashtag_name);
    if (id && name) tags.set(id, { id, name });
  }
  for (const challenge of Array.isArray(item.cha_list) ? item.cha_list : []) {
    if (!challenge) continue;
    const id = str(challenge.cid ?? challenge.cha_id ?? challenge.id), name = tagName(challenge.cha_name);
    if (id && name) tags.set(id, { id, name });
  }
  return {
    id, description: str(item.desc), title: str(item.title ?? item.video_title ?? item.video.title),
    tags: [...tags.values()], publishedAt: seconds * 1000,
    url: `https://www.douyin.com/video/${id}`, type: 'video'
  };
}

// Search responses differ across tabs. Walk wrappers, but only admit aweme records
// with a playable-video field; comment text and search suggestions never become hits.
export function collectVideos(payload) {
  const found = new Map();
  const visited = new WeakSet();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 18 || visited.has(value)) return;
    visited.add(value);
    const video = normalizeVideo(value);
    if (video) {
      const old = found.get(video.id);
      if (!old) found.set(video.id, video);
      else old.tags = [...new Map([...old.tags, ...video.tags].map(tag => [tag.id, tag])).values()];
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(payload, 0);
  return [...found.values()];
}

export function matchRules(video, rules) {
  if (video?.type !== 'video') return [];
  const text = `${video.title || ''}\n${video.description || ''}`.toLocaleLowerCase();
  return (rules || []).filter(rule => rule.enabled !== false && (
    (rule.tags || []).some(wanted => (video.tags || []).some(actual =>
      typeof wanted === 'string' ? actual.name === tagName(wanted) :
        wanted.id ? actual.id === str(wanted.id) : actual.name === tagName(wanted.name)
    )) || (rule.keywords || []).some(word => str(word) && text.includes(str(word).toLocaleLowerCase()))
  ));
}

// Presentation statistics are separate from the durable deduplication ledger.
// Never clear deliveries or infer a new round from a wall-clock timestamp.
function roundVideos(videos) {
  return [...new Map((Array.isArray(videos) ? videos : []).map(normalizeVideo).filter(Boolean).map(video => [video.id, video])).values()];
}
export function beginRound(state, { kind = 'monitor', source = 'search', videos = [], queriesTotal = 0, nowMs = Date.now() } = {}) {
  const items = roundVideos(videos);
  state.round = { id: crypto.randomUUID(), kind, source, status: 'running', startedAt: nowMs, updatedAt: nowMs,
    finishedAt: null, error: null, scanStatus: source === 'search' ? 'running' : 'skipped',
    queriesDone: 0, queriesTotal, foundCount: items.length, videos: items.slice(0, 100) };
  return state.round.id;
}
export function updateRoundResults(state, id, videos, { queriesDone = 0, queriesTotal = 0, done = false, nowMs = Date.now() } = {}) {
  if (state.round?.id !== id || state.round.status !== 'running') return false;
  const items = roundVideos(videos);
  Object.assign(state.round, { videos: items.slice(0, 100), foundCount: items.length, queriesDone, queriesTotal,
    scanStatus: done ? 'done' : 'running', updatedAt: nowMs });
  return true;
}
export function finishRound(state, id, { status = 'done', error = null, nowMs = Date.now() } = {}) {
  if (state.round?.id !== id || state.round.status !== 'running') return false;
  Object.assign(state.round, { status, error, finishedAt: nowMs, updatedAt: nowMs });
  if (state.round.scanStatus === 'running') state.round.scanStatus = status === 'done' ? 'done' : 'incomplete';
  return true;
}

function log(state, type, message, nowMs, key) {
  state.logs ||= [];
  state.logs.unshift({ at: nowMs, level: type === 'error' ? 'error' : 'info', message, ...(key ? { key } : {}) });
  state.logs = state.logs.slice(0, MAX_LOGS);
}

export function enqueue(state, videos, config, nowMs = Date.now()) {
  const normalized = validateConfig(config, { ready: true });
  const known = new Map(state.deliveries.map(delivery => [delivery.key, delivery]));
  const windowMs = (normalized.videoWindowMinutes || DEFAULTS.videoWindowMinutes) * 60_000;
  const unavailable = new Set((state.unavailableVideos || []).filter(item => item.accountId === normalized.account.id).map(item => item.videoId));
  let added = 0;
  for (const candidate of videos) {
    const video = normalizeVideo(candidate);
    const age = nowMs - Number(video?.publishedAt);
    if (video?.type !== 'video' || !str(video.id) || unavailable.has(video.id) || !Number.isFinite(age) || age < 0 || age > windowMs) continue;
    for (const rule of matchRules(video, normalized.rules)) {
      for (const recipient of rule.recipients) {
        const key = makeKey(normalized.account.id, video.id, recipient.id);
        const existing = known.get(key);
        if (existing) {
          existing.ruleIds = unique([...(existing.ruleIds || []), rule.id]);
          continue;
        }
        const delivery = { key, accountId: normalized.account.id, accountName: normalized.account.name, video: structuredClone(video), recipient: structuredClone(recipient),
          ruleIds: [rule.id], status: 'pending', discoveredAt: nowMs, updatedAt: nowMs, error: null };
        state.deliveries.push(delivery);
        known.set(key, delivery);
        added++;
      }
    }
  }
  if (added) log(state, 'queue', `已加入 ${added} 个视频转发任务`, nowMs);
  return added;
}

export const UNAVAILABLE_REASONS = Object.freeze({
  'not-found': '你要观看的视频不存在', deleted: '作品已删除', removed: '作品已下架', restricted: '作品因违规无法播放'
});
// Only a positively identified unavailable page, before any possible submit,
// may reach this helper. Never resolve uncertain or confirmed deliveries here.
export function skipUnavailableVideo(state, accountId, videoId, reason, nowMs = Date.now()) {
  accountId = str(accountId); videoId = str(videoId);
  if (!accountId || !/^\d+$/u.test(videoId) || !Object.hasOwn(UNAVAILABLE_REASONS, reason)) throw new Error('无效的视频失效证据');
  let skipped = 0;
  for (const delivery of state.deliveries) {
    if (delivery.accountId !== accountId || delivery.video.id !== videoId || delivery.status !== 'pending') continue;
    Object.assign(delivery, { status: 'skipped', skipReason: 'video-unavailable', unavailableReason: reason,
      skippedRoundId: state.round?.id || null, updatedAt: nowMs, error: UNAVAILABLE_REASONS[reason] });
    skipped++;
  }
  state.unavailableVideos ||= [];
  if (!state.unavailableVideos.some(item => item.accountId === accountId && item.videoId === videoId))
    state.unavailableVideos.push({ accountId, videoId, reason, at: nowMs });
  log(state, 'info', `已跳过失效视频 ${videoId}：${UNAVAILABLE_REASONS[reason]}；跳过 ${skipped} 项待发，继续处理后续队列。`, nowMs);
  return skipped;
}

function recentRate(state, nowMs) {
  return (state.rate || []).filter(entry => Number.isFinite(entry.at) && entry.at > nowMs - WINDOW_MS);
}

export function nextDelivery(state, nowMs = Date.now(), limits = {}, preferredVideoId = null) {
  if (!state.enabled || state.paused || state.deliveries.some(delivery => ['sending', 'unknown'].includes(delivery.status))) return null;
  // Once a video is open, finish its remaining recipients before navigating.
  // Default selection remains FIFO; sent/unknown records are never reordered.
  const first = (preferredVideoId && state.deliveries.find(delivery => delivery.status === 'pending' && delivery.video.id === preferredVideoId)) ||
    state.deliveries.find(delivery => delivery.status === 'pending');
  if (!first) return null;
  const maxVideos = Number.isInteger(limits?.maxVideosPerWindow) ? limits.maxVideosPerWindow : DEFAULTS.maxVideosPerWindow;
  const videoIds = new Set(recentRate(state, nowMs).map(entry => entry.videoId));
  return videoIds.has(first.video.id) || videoIds.size < maxVideos ? first : null;
}

// The latest activity for each distinct video owns its sliding-window slot.
// Waiting must use that same rule, including after lowering the configured cap.
export function nextDeliveryAt(state, nowMs = Date.now(), limits = {}, preferredVideoId = null) {
  if (!state.enabled || state.paused || state.deliveries.some(d => ['sending', 'unknown'].includes(d.status))) return null;
  const first = (preferredVideoId && state.deliveries.find(d => d.status === 'pending' && d.video.id === preferredVideoId)) ||
    state.deliveries.find(d => d.status === 'pending');
  if (!first) return null;
  const latest = new Map();
  for (const entry of recentRate(state, nowMs)) latest.set(entry.videoId, Math.max(latest.get(entry.videoId) || 0, entry.at));
  const cap = Number.isInteger(limits?.maxVideosPerWindow) ? limits.maxVideosPerWindow : DEFAULTS.maxVideosPerWindow;
  if (latest.has(first.video.id) || latest.size < cap) return nowMs;
  const expirations = [...latest.values()].map(at => at + WINDOW_MS).sort((a, b) => a - b);
  return expirations[latest.size - cap];
}

function deliveryFor(state, key) {
  const delivery = state.deliveries.find(item => item.key === key);
  if (!delivery) throw new Error('转发记录不存在');
  return delivery;
}

// Caller MUST await persistence of the mutated state before touching the share UI.
export function reserveDelivery(state, key, nowMs = Date.now(), limits = {}, preferredVideoId = null) {
  const delivery = nextDelivery(state, nowMs, limits, preferredVideoId);
  if (!delivery || delivery.key !== key) throw new Error('当前任务不可发送：已暂停、限速或队列顺序不符');
  delivery.status = 'sending';
  delivery.attemptRoundId = state.round?.status === 'running' ? state.round.id : null;
  delivery.updatedAt = nowMs;
  delivery.error = null;
  state.rate = [...recentRate(state, nowMs), { videoId: delivery.video.id, at: nowMs }];
  log(state, 'sending', '开始转发视频', nowMs, key);
  return delivery;
}

export function completeDelivery(state, key, nowMs = Date.now(), { preExisting = false } = {}) {
  const delivery = deliveryFor(state, key);
  if (delivery.status !== 'sending') throw new Error('只有发送中的任务可以确认成功');
  delivery.status = 'sent';
  if (preExisting) delivery.attemptRoundId = null;
  delivery.updatedAt = nowMs;
  delivery.error = null;
  // Reserve occupies a slot before interacting with the UI. Completion keeps
  // slow friend searches/native sends inside the actual delivery window too.
  state.rate = [...recentRate(state, nowMs), { videoId: delivery.video.id, at: nowMs }];
  log(state, 'sent', '视频已转发', nowMs, key);
  return delivery;
}

// A preparation that never reached a send call has no uncertain outcome:
// restore pending. The caller decides whether the cause also requires a pause.
export function abortDelivery(state, key, reason, nowMs = Date.now()) {
  const delivery = deliveryFor(state, key);
  if (delivery.status !== 'sending') throw new Error('只有发送中的任务可以撤销');
  delivery.status = 'pending';
  delivery.updatedAt = nowMs;
  delivery.error = str(reason?.message || reason) || '发送未开始，稍后重试';
  log(state, 'info', '本次发送未执行，已放回队列：' + delivery.error, nowMs, key);
  return delivery;
}

export function failDelivery(state, key, reason, nowMs = Date.now()) {
  const delivery = deliveryFor(state, key);
  if (!['sending', 'pending'].includes(delivery.status)) throw new Error('此任务不在可失败状态');
  delivery.status = 'unknown';
  delivery.updatedAt = nowMs;
  delivery.error = str(reason?.message || reason) || '无法确认转发结果';
  state.paused = true;
  state.incident = { id: crypto.randomUUID(), key, at: nowMs, accountName: delivery.accountName, reason: delivery.error, notified: false };
  log(state, 'error', delivery.error, nowMs, key);
  return delivery;
}

export function recoverState(saved, nowMs = Date.now()) {
  const state = Object.assign(defaultState(), saved && typeof saved === 'object' ? saved : {});
  for (const field of ['deliveries', 'rate', 'logs', 'unavailableVideos']) if (!Array.isArray(state[field])) state[field] = [];
  state.unavailableVideos = [...new Map(state.unavailableVideos.filter(item => item && typeof item.accountId === 'string' && item.accountId.trim() &&
    typeof item.videoId === 'string' && /^\d+$/u.test(item.videoId) && Object.hasOwn(UNAVAILABLE_REASONS, item.reason) && Number.isFinite(item.at))
    .map(item => [JSON.stringify([item.accountId, item.videoId]), { accountId: item.accountId, videoId: item.videoId, reason: item.reason, at: item.at }])).values()];
  for (const delivery of state.deliveries) {
    if (!delivery || typeof delivery !== 'object') throw new Error('导入记录包含无效转发任务');
    const video = normalizeVideo(delivery.video);
    if (!video) throw new Error('导入记录包含无效视频 ID 或视频数据');
    delivery.video = video;
  }
  const interrupted = state.deliveries.filter(delivery => delivery.status === 'sending');
  for (const delivery of interrupted) {
    delivery.status = 'unknown';
    delivery.updatedAt = nowMs;
    delivery.error = '运行中断，无法确认视频是否已经转发，请人工核对';
  }
  const unknown = state.deliveries.find(delivery => delivery.status === 'unknown');
  if (unknown) {
    state.paused = true;
    if (interrupted.length || !state.incident) state.incident = {
      id: crypto.randomUUID(), key: unknown.key, at: nowMs, accountName: unknown.accountName, reason: unknown.error || '存在待核对转发记录', notified: false
    };
  }
  state.logs = state.logs.filter(entry => entry && typeof entry === 'object')
    .map(entry => ({ ...entry, level: entry.level || (entry.type === 'error' ? 'error' : 'info') }))
    .sort((a, b) => Number(b.at) - Number(a.at)).slice(0, MAX_LOGS);
  state.rate = recentRate(state, nowMs);
  if (!state.round || typeof state.round.id !== 'string' || !state.round.id) state.round = null;
  else {
    state.round.videos = roundVideos(state.round.videos).slice(0, 100);
    if (state.round.status === 'running') finishRound(state, state.round.id, { status: 'interrupted', nowMs });
  }
  if (interrupted.length) log(state, 'error', `发现 ${interrupted.length} 条中断记录，已暂停等待核对`, nowMs);
  return state;
}

export function resolveDelivery(state, key, action, nowMs = Date.now()) {
  const delivery = deliveryFor(state, key);
  if (delivery.status !== 'unknown') throw new Error('仅待核对任务可以人工处理');
  const status = { sent: 'sent', retry: 'pending', skip: 'skipped' }[action];
  if (!status) throw new Error('未知处理方式');
  delivery.status = status;
  delivery.updatedAt = nowMs;
  delivery.error = null;
  log(state, 'resolve', `人工处理：${action}`, nowMs, key);
  // Keep pause until the user explicitly presses Resume after handling all issues.
  return delivery;
}
