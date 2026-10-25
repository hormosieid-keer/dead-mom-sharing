import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { browserTask } from '../extension/adapter.js';

// Anonymous fixtures copied from the live share popover DOM observed on
// https://www.douyin.com/video/<id> (2026-10). Two images per row (avatar and a
// flame badge), a plain "搜索" box, a virtualized "分享给朋友" heading and a
// div[data-userid] share control are the parts that matter here.
const videoId = '7654321000123456789';
const avatar = (name) => `https://p3.douyinpic.com/aweme/100x100/aweme-avatar/${name}.jpeg?biz_tag=aweme_im`;
const liveRow = ({ uid = '7123456789012345678', name = '测试好友甲', avatarSrc = avatar('abc'), status = '在线', streak = '375' } = {}) => `
  <div class="row"><div class="avatar"><img src="${avatarSrc}"></div>
    <div class="meta"><div class="name"><span>${name}</span><div class="streak"><img src="https://lf3-static.bytednsdoc.com/obj/example/flame.png"><div>${streak}</div></div></div>
      <div class="status">${status}</div></div>
    <div class="send" data-userid="${uid}">分享</div>
  </div>`;
const livePanel = (rows = liveRow(), { heading = true } = {}) => `
  <div data-e2e="video-share-container"><div class="pop"><div class="list">
    <div class="search"><div><div><input placeholder="搜索" type="text" value=""></div></div></div>
    <div class="virtual" style="height:100px">
      ${heading ? '<div><div>分享给朋友</div></div>' : ''}${rows}
    </div>
  </div></div></div>`;
function fixture(body = '', path = `/video/${videoId}`, { fast = false } = {}) {
  const dom = new JSDOM(body, { url: `https://www.douyin.com${path}`, runScripts: 'outside-only' });
  dom.window.Element.prototype.getClientRects = function () {
    return [{ width: 40, height: 40, top: 0, left: 0, right: 40, bottom: 40 }];
  };
  if (fast) {
    const original = dom.window.setTimeout;
    dom.window.setTimeout = (callback, ms, ...args) => original(callback, ms === 250 ? 0 : ms, ...args);
  }
  const task = dom.window.eval(`(${browserTask.toString()})`);
  return { dom, window: dom.window, task, close: () => dom.window.close() };
}
const uidOf = (id) => `uid:${id}`;

test('live share rows bind the numeric uid and never read streak or status text as identity', async () => {
  const f = fixture(livePanel());
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.deepEqual({ id: friends[0].id, uid: friends[0].uid, name: friends[0].name }, {
      id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲'
    });
    assert.match(friends[0].avatarKey, /aweme-avatar\/abc\.jpeg/u);
    assert.doesNotMatch(friends[0].avatarKey, /flame|375/u);
    assert.equal(friends[0].avatar.includes('flame'), false);
  } finally { f.close(); }
});

test('the second and fourth first-screen friends are not dropped because of activity subtitles', async () => {
  const statuses = ['在线', '2小时前在线', '离线', '刚刚活跃'];
  const rows = statuses.map((status, index) => ({ uid: `712345678901234560${index}`, name: `好友${index + 1}`, status }));
  const f = fixture(livePanel(rows.map(liveRow).join('')), undefined, { fast: true });
  try {
    const result = await f.task({ action: 'friends', diagnostics: true });
    assert.deepEqual([...result.friends].map(friend => friend.name), rows.map(row => row.name));
    assert.equal(result.diagnostics.firstScreen.controls, 4);
    assert.equal(result.diagnostics.firstScreen.recognized, 4);
    assert.equal(result.diagnostics.unrecognized, 0);
    assert.equal(result.diagnostics.revision, 'friends-v3');
  } finally { f.close(); }
});

test('the primary nickname in a UID row is distinct from arbitrary secondary status text', async () => {
  const uid = '7123456789012345610';
  const f = fixture(livePanel(liveRow({ uid, name: '真正的昵称', status: '好友正在休息' })), undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends[0].name, '真正的昵称');
    f.window.document.querySelector('[data-userid]').onclick = (event) => { event.target.textContent = '已发送'; };
    const target = await f.task({ action: 'share', videoId, recipient: friends[0] });
    assert.equal(target.sent, true);
    assert.equal(friends[0].uid, uid);
  } finally { f.close(); }
});

test('text inside a flame badge cannot become a second nickname', async () => {
  const f = fixture(livePanel(liveRow({ name: '昵称甲', streak: '火花已中断', status: '昨天在线' })), undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends[0].name, '昵称甲');
  } finally { f.close(); }
});

test('a numeric nickname in the primary UID name slot is not confused with the streak count', async () => {
  const f = fixture(livePanel(liveRow({ name: '123456', streak: '375', status: '2小时前在线' })), undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends[0].name, '123456');
  } finally { f.close(); }
});

test('two unexplained peer nickname labels still cannot be resolved by taking the first one', async () => {
  const uncertain = `<div class="row"><div><img src="${avatar('ambiguous')}"></div>
    <div><span>候选甲</span><span>候选乙</span></div><div data-userid="7123456789012345620">分享</div></div>`;
  const f = fixture(livePanel(liveRow() + uncertain), undefined, { fast: true });
  try {
    const result = await f.task({ action: 'friends', diagnostics: true });
    assert.equal(result.friends.length, 1);
    assert.equal(result.diagnostics.rejectionCounts['name-ambiguous'], 1);
    assert.equal(result.friends[0].name, '测试好友甲');
  } finally { f.close(); }
});

test('same nickname with different uids stays distinct and only the bound uid is clicked', async () => {
  const f = fixture(livePanel(liveRow({ uid: '4111111111111111', name: '同名' }) + liveRow({ uid: '4222222222222222', name: '同名' })));
  try {
    const controls = f.window.document.querySelectorAll('[data-userid]');
    controls[0].onclick = () => assert.fail('another uid must never be shared');
    controls[1].onclick = () => { controls[1].textContent = '已发送'; };
    const result = await f.task({ action: 'share', videoId, recipient: { id: uidOf('4222222222222222'), uid: '4222222222222222', name: '同名', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } });
    assert.equal(result.sent, true);
  } finally { f.close(); }
});

test('a mismatched uid cannot fall back to a same-name friend', async () => {
  const f = fixture(livePanel(), undefined, { fast: true });
  try {
    f.window.document.querySelector('[data-userid]').onclick = () => assert.fail('wrong uid must not be shared');
    await assert.rejects(f.task({ action: 'share', videoId,
      recipient: { id: uidOf('4999999999999999'), uid: '4999999999999999', name: '测试好友甲', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } }), { code: 'SHARE_RECIPIENT_MISSING' });
  } finally { f.close(); }
});

test('an already bound UID can be located before nickname text finishes rendering', async () => {
  const uid = '7123456789012345690';
  const f = fixture(livePanel(`<div class="row"><div class="avatar"></div><div class="meta"></div><div data-userid="${uid}">分享</div></div>`), undefined, { fast: true });
  try {
    f.window.document.querySelector('[data-userid]').onclick = (event) => { event.target.textContent = '已发送'; };
    const sent = await f.task({ action: 'share', videoId, recipient: { id: uidOf(uid), uid, name: '已绑定好友' } });
    assert.equal(sent.sent, true);
  } finally { f.close(); }
});

test('a bound UID in the pinned part of the confirmed popover is usable for sending', async () => {
  const uid = '7123456789012345691';
  const f = fixture(`<div data-e2e="video-share-container"><div>${liveRow({ uid, name: '已绑定首屏好友' })}</div>
    <div data-e2e="share-panel"><input placeholder="搜索">${liveRow({ uid: '7123456789012345692', name: '列表好友' })}</div></div>`, undefined, { fast: true });
  try {
    const controls = [...f.window.document.querySelectorAll('[data-userid]')];
    controls[0].onclick = (event) => { event.target.textContent = '已发送'; };
    controls[1].onclick = () => assert.fail('a different UID must never be clicked');
    assert.equal((await f.task({ action: 'share', videoId, recipient: { id: uidOf(uid), uid, name: '已绑定首屏好友' } })).sent, true);
  } finally { f.close(); }
});

test('duplicate visible controls for the same bound UID cannot be resolved by picking the first', async () => {
  const uid = '7123456789012345693';
  const f = fixture(livePanel(liveRow({ uid, name: '好友甲' }) + liveRow({ uid, name: '好友乙' })), undefined, { fast: true });
  try {
    for (const control of f.window.document.querySelectorAll('[data-userid]')) control.onclick = () => assert.fail('ambiguous UID must not be sent');
    await assert.rejects(f.task({ action: 'share', videoId, recipient: { id: uidOf(uid), uid, name: '绑定好友' } }), { code: 'SHARE_RECIPIENT_AMBIGUOUS' });
  } finally { f.close(); }
});

test('an empty mounted popover is reported as not ready before any click', async () => {
  const f = fixture('<div data-e2e="video-share-container"><input placeholder="搜索"><img src="https://fixture.test/qr.png"></div>', undefined, { fast: true });
  try {
    const result = await f.task({ action: 'share', mode: 'probe', videoId, captureErrors: true,
      recipient: { id: uidOf('7123456789012345694'), uid: '7123456789012345694', name: '绑定好友' } });
    assert.equal(result.code, 'SHARE_PANEL_EMPTY');
    assert.match(result.error, /尚未点击发送/u);
    assert.doesNotMatch(result.error, /昵称或头像可能已变更/u);
  } finally { f.close(); }
});

test('a missing row send control is refreshable but multiple controls are ambiguous', async () => {
  const uid = '7123456789012345678';
  for (const ambiguous of [false, true]) {
    const row = ambiguous ? liveRow().replace('</div>\n  </div>', '</div><button>分享</button>\n  </div>') : liveRow().replace('>分享</div>', '>暂不可转发</div>');
    const f = fixture(livePanel(row), undefined, { fast: true });
    try {
      f.window.document.addEventListener('click', () => assert.fail('probe cannot send anything'));
      const result = await f.task({ action: 'share', mode: 'probe', videoId, captureErrors: true,
        recipient: { id: uidOf(uid), uid, name: '绑定好友' } });
      assert.equal(result.code, ambiguous ? 'SHARE_CONTROL_AMBIGUOUS' : 'SHARE_CONTROL_MISSING');
    } finally { f.close(); }
  }
});

test('two separate share panels are ambiguous during open, probe and arm', async () => {
  const uid = '7123456789012345678';
  const f = fixture(livePanel() + livePanel(liveRow({ uid: '7123456789012345679' })), undefined, { fast: true });
  try {
    for (const request of [{ action: 'openShare' }, { action: 'share', mode: 'probe' }, { action: 'share', mode: 'arm', point: { x: 5, y: 6 } }]) {
      const result = await f.task({ ...request, videoId, captureErrors: true, recipient: { id: uidOf(uid), uid, name: '绑定好友' } });
      if (request.mode === 'arm') {
        assert.equal(result.code, 'SHARE_TARGET_CHANGED');
        assert.equal(result.retryable, false);
        assert.equal(result.details.reason, 'panel-ambiguous');
      } else assert.equal(result.code, 'SHARE_PANEL_AMBIGUOUS');
    }
  } finally { f.close(); }
});

test('a second panel appearing during recipient search stops before using stale rows', async () => {
  const uid = '7123456789012345699';
  const f = fixture(livePanel(), undefined, { fast: true });
  try {
    f.window.document.querySelector('input').oninput = () => f.window.document.body.insertAdjacentHTML('beforeend', livePanel(liveRow({ uid })));
    f.window.document.addEventListener('click', () => assert.fail('ambiguous search results cannot be sent'));
    const result = await f.task({ action: 'share', mode: 'probe', videoId, captureErrors: true,
      recipient: { id: uidOf(uid), uid, name: '绑定好友' } });
    assert.equal(result.code, 'SHARE_PANEL_AMBIGUOUS');
  } finally { f.close(); }
});

test('a hidden empty friend panel reports visibility without trying a nickname search', async () => {
  const f = fixture('<div data-e2e="video-share-container"><input placeholder="搜索"><img src="https://fixture.test/qr.png"></div>', undefined, { fast: true });
  try {
    Object.defineProperty(f.window.document, 'visibilityState', { value: 'hidden' });
    f.window.document.querySelector('input').oninput = () => assert.fail('do not search names in a panel with no friend rows');
    const result = await f.task({ action: 'share', mode: 'probe', videoId, captureErrors: true,
      recipient: { id: uidOf('7123456789012345694'), uid: '7123456789012345694', name: '绑定好友' } });
    assert.equal(result.code, 'SHARE_PANEL_EMPTY');
    assert.match(result.error, /页面可见性 hidden/);
    assert.match(result.error, /尚未点击发送/);
  } finally { f.close(); }
});

test('share control is the row div[data-userid] and a missing uid on it blocks the send', async () => {
  const f = fixture(livePanel(), undefined, { fast: true });
  try {
    const control = f.window.document.querySelector('[data-userid]');
    control.onclick = () => assert.fail('control without uid must not be clicked');
    control.removeAttribute('data-userid');
    await assert.rejects(f.task({ action: 'share', videoId,
      recipient: { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } }),
      /唯一匹配|无法确认接收人|账号 ID|未加载可识别的好友行/u);
  } finally { f.close(); }
});

test('hover opens the live popover and a click fallback is not used when hover worked', async () => {
  const f = fixture('<div data-e2e="video-share-icon-container"><div tabindex="0">分享</div></div>');
  try {
    const icon = f.window.document.querySelector('[data-e2e="video-share-icon-container"]');
    let clicks = 0;
    icon.addEventListener('mouseover', () => f.window.document.body.insertAdjacentHTML('beforeend', livePanel()));
    icon.onclick = () => { clicks++; };
    const result = await f.task({ action: 'openShare' });
    assert.equal(result.opened, true);
    assert.equal(result.via, 'hover');
    assert.equal(clicks, 0);
  } finally { f.close(); }
});

test('virtualized heading can disappear without losing the panel or the search box', async () => {
  const f = fixture(livePanel(liveRow({ uid: '4333333333333333', name: '小红' }), { heading: false }));
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].uid, '4333333333333333');
    const search = f.window.document.querySelector('input');
    search.oninput = () => {
      assert.equal(search.value, '测试好友甲');
      f.window.document.querySelector('.virtual').innerHTML = liveRow({ uid: '4444444444444444', name: '测试好友甲' });
      f.window.document.querySelector('[data-userid]').onclick = (event) => { event.target.textContent = '已发送'; };
    };
    const result = await f.task({ action: 'share', videoId,
      recipient: { id: uidOf('4444444444444444'), uid: '4444444444444444', name: '测试好友甲', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } });
    assert.equal(result.sent, true);
  } finally { f.close(); }
});

test('reads the whole virtualized friend list by scrolling past the mounted slice', async () => {
  const rows = [
    ['7000000000000000001', '好友甲'], ['7000000000000000002', '好友乙'], ['7000000000000000003', '好友丙']
  ];
  const f = fixture(`<div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows">${liveRow({ uid: rows[0][0], name: rows[0][1] })}</div></div></div>`);
  try {
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(list, 'scrollHeight', { value: 300 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    let index = 0;
    list.addEventListener('scroll', () => {
      index++;
      if (index < rows.length) {
        f.window.document.querySelector('.rows').insertAdjacentHTML('beforeend', liveRow({ uid: rows[index][0], name: rows[index][1] }));
      }
    });
    const friends = await f.task({ action: 'friends' });
    assert.deepEqual([...friends].map(friend => friend.uid), rows.map(row => row[0]));
  } finally { f.close(); }
});

test('only the friend list scrolls, never a page-level scroller around it', async () => {
  const rows = [['7000000000000000101', '好友甲'], ['7000000000000000102', '好友乙'], ['7000000000000000103', '好友丙']];
  const f = fixture(`<div class="page" style="overflow-y:auto"><div class="page-inner"><div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows">${liveRow({ uid: rows[0][0], name: rows[0][1] })}</div></div></div></div></div>`);
  try {
    const page = f.window.document.querySelector('.page');
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(page, 'scrollHeight', { value: 3000 });
    Object.defineProperty(page, 'clientHeight', { value: 900 });
    Object.defineProperty(list, 'scrollHeight', { value: 300 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    let index = 0;
    list.addEventListener('scroll', () => {
      index++;
      if (index < rows.length) {
        f.window.document.querySelector('.rows').insertAdjacentHTML('beforeend', liveRow({ uid: rows[index][0], name: rows[index][1] }));
      }
    });
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 3);
    assert.equal(page.scrollTop, 0, 'the page must never scroll');
    assert.ok(list.scrollTop > 0, 'the friend list must scroll');
  } finally { f.close(); }
});

test('reading friends rewinds a remembered virtual list to include its first screen', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ uid: `700000000000000060${index}`, name: `好友${index}` }));
  const f = fixture(`<div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows"></div></div></div>`, undefined, { fast: true });
  try {
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(list, 'scrollHeight', { value: 300 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    list.scrollTop = 150;
    const render = () => {
      const start = Math.floor(list.scrollTop / 50);
      f.window.document.querySelector('.rows').innerHTML = rows.slice(start, start + 2).map(liveRow).join('');
    };
    list.addEventListener('scroll', render);
    render();
    const friends = await f.task({ action: 'friends' });
    assert.deepEqual([...friends].map(friend => friend.uid).sort(), rows.map(row => row.uid));
  } finally { f.close(); }
});

test('first-screen friends can finish mounting after the first recognizable row', async () => {
  const f = fixture(livePanel(liveRow({ uid: '7000000000000000701', name: '先出现' })));
  const timer = setTimeout(() => {
    f.window.document.querySelector('.virtual').insertAdjacentHTML('beforeend', liveRow({ uid: '7000000000000000702', name: '稍后出现' }));
  }, 450);
  try {
    const friends = await f.task({ action: 'friends' });
    assert.deepEqual([...friends].map(friend => friend.uid), ['7000000000000000701', '7000000000000000702']);
  } finally { clearTimeout(timer); f.close(); }
});

test('a short friend viewport is scanned without jumping over virtual rows', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ uid: `700000000000000080${index}`, name: `好友${index}` }));
  const f = fixture(`<div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows"></div></div></div>`, undefined, { fast: true });
  try {
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(list, 'scrollHeight', { value: 320 });
    Object.defineProperty(list, 'clientHeight', { value: 80 });
    const render = () => {
      const start = Math.floor(list.scrollTop / 40);
      f.window.document.querySelector('.rows').innerHTML = rows.slice(start, start + 2).map(liveRow).join('');
    };
    list.addEventListener('scroll', render);
    render();
    const friends = await f.task({ action: 'friends' });
    assert.deepEqual([...friends].map(friend => friend.uid), rows.map(row => row.uid));
  } finally { f.close(); }
});

test('a leftover search term is cleared before reading the full list', async () => {
  const f = fixture(`<div data-e2e="video-share-container"><div class="list"><input placeholder="搜索" value="小红"><div class="rows">${liveRow({ uid: '7000000000000000009', name: '好友甲' })}</div></div></div>`);
  try {
    const box = f.window.document.querySelector('input');
    box.addEventListener('input', () => {
      if (!box.value) f.window.document.querySelector('.rows').insertAdjacentHTML('beforeend', liveRow({ uid: '7000000000000000010', name: '好友乙' }));
    });
    const friends = await f.task({ action: 'friends' });
    assert.equal(box.value, '');
    assert.deepEqual([...friends].map(friend => friend.uid).sort(), ['7000000000000000009', '7000000000000000010']);
  } finally { f.close(); }
});

test('a uid row is bound even when its avatar is lazy or missing', async () => {
  const lazy = fixture('<div data-e2e="video-share-container"><div class="list"><input placeholder="搜索"><div class="rows"><div class="row"><div class="avatar"><img data-src="https://p3.douyinpic.com/aweme-avatar/lazy.jpeg?biz_tag=aweme_im"></div><div class="meta"><span>懒加载好友</span></div><div class="send" data-userid="7000000000000000501">分享</div></div></div></div></div>');
  try {
    const friends = await lazy.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].uid, '7000000000000000501');
    assert.equal(friends[0].name, '懒加载好友');
  } finally { lazy.close(); }
  const bare = fixture('<div data-e2e="video-share-container"><div class="list"><input placeholder="搜索"><div class="rows"><div class="row"><div class="meta"><span>无头像好友</span></div><div class="send" data-userid="7000000000000000502">分享</div></div></div></div></div>');
  try {
    const friends = await bare.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].uid, '7000000000000000502');
  } finally { bare.close(); }
});

test('a share control inside an extra action wrapper still belongs to its named row', async () => {
  const f = fixture(livePanel(`<div class="row"><div class="meta"><span>普通好友</span></div>
    <div class="actions"><div class="inner"><div data-userid="7000000000000000901">分享</div></div></div></div>`), undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].name, '普通好友');
    assert.equal(friends[0].uid, '7000000000000000901');
    f.window.document.querySelector('[data-userid]').onclick = (event) => { event.target.textContent = '已发送'; };
    assert.equal((await f.task({ action: 'share', videoId, recipient: friends[0] })).sent, true);
  } finally { f.close(); }
});

test('an ordinary nickname split into inline markup is read as one full name', async () => {
  const f = fixture(livePanel(`<div class="row"><div class="meta"><span>普通<span>好友</span><img alt="" src="https://fixture.test/emoji.png"></span></div>
    <div data-userid="7000000000000000902">分享</div></div>`), undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].name, '普通好友');
  } finally { f.close(); }
});

test('friend reading includes a first-screen section outside the nested search region', async () => {
  const pinned = liveRow({ uid: '7000000000000000903', name: '首屏好友' });
  const regular = liveRow({ uid: '7000000000000000904', name: '列表好友' });
  const f = fixture(`<div data-e2e="video-share-container"><div class="pinned">${pinned}</div>
    <div data-e2e="share-panel"><input placeholder="搜索">${regular}</div></div>`, undefined, { fast: true });
  try {
    const friends = await f.task({ action: 'friends' });
    assert.deepEqual([...friends].map(friend => friend.uid), ['7000000000000000903', '7000000000000000904']);
  } finally { f.close(); }
});

test('friend diagnostics report rejected UID rows without borrowing names or exposing identities', async () => {
  const f = fixture(livePanel(liveRow({ uid: '7000000000000000911', name: '隐私好友甲' }) +
    '<div class="row"><div><span>隐私好友乙</span><span>无法归属的备注</span></div><div data-userid="7000000000000000912">分享</div></div>' +
    '<div class="row"><div data-userid="7000000000000000913">分享</div></div>'), undefined, { fast: true });
  try {
    const result = await f.task({ action: 'friends', diagnostics: true });
    assert.equal(result.friends.length, 1, 'ambiguous or nameless rows must not borrow a neighbour name');
    assert.equal(result.diagnostics.firstScreen.controls, 3);
    assert.equal(result.diagnostics.firstScreen.recognized, 1);
    assert.equal(result.diagnostics.firstScreen.rejected, 2);
    assert.equal(result.diagnostics.unrecognized, 2);
    assert.equal(result.diagnostics.rejectionCounts['name-ambiguous'], 1);
    assert.equal(result.diagnostics.rejectionCounts['name-missing'], 1);
    const diagnosticText = JSON.stringify(result.diagnostics);
    assert.doesNotMatch(diagnosticText, /700000000000000091|隐私好友|无法归属/u);
    assert.ok(result.diagnostics.samples.some(sample => sample.shape.length));
  } finally { f.close(); }
});

test('a friend list that mounts late is waited for instead of being reported empty', async () => {
  const f = fixture('<div data-e2e="video-share-container"><div class="list"><input placeholder="搜索"><img src="https://p3.douyinpic.com/qr/code.png"><div class="rows"></div></div></div>');
  try {
    setTimeout(() => {
      f.window.document.querySelector('.rows').insertAdjacentHTML('beforeend', liveRow({ uid: '7000000000000000401', name: '慢好友' }));
    }, 120);
    const friends = await f.task({ action: 'friends' });
    assert.equal(friends.length, 1);
    assert.equal(friends[0].uid, '7000000000000000401');
  } finally { f.close(); }
});

test('a bound friend that is not mounted yet is found by scrolling the list', async () => {
  const target = ['7000000000000000301', '目标好友'];
  const f = fixture(`<div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows">${liveRow({ uid: '7000000000000000300', name: '其它好友' })}</div></div></div>`, undefined, { fast: true });
  try {
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(list, 'scrollHeight', { value: 400 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    let mounted = false;
    list.addEventListener('scroll', () => {
      if (mounted) return;
      mounted = true;
      f.window.document.querySelector('.rows').insertAdjacentHTML('beforeend', liveRow({ uid: target[0], name: target[1] }));
      const control = [...f.window.document.querySelectorAll('[data-userid]')]
        .find((node) => node.getAttribute('data-userid') === target[0]);
      control.onclick = () => { control.textContent = '已发送'; };
    });
    const result = await f.task({ action: 'share', videoId,
      recipient: { id: 'uid:' + target[0], uid: target[0], name: target[1], avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } });
    assert.equal(result.sent, true);
    assert.ok(mounted, 'the list had to be scrolled to reveal the friend');
  } finally { f.close(); }
});

test('sending rewinds a remembered list before looking for a bound first-screen UID', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ uid: `712345678901234565${index}`, name: `好友${index}` }));
  const f = fixture('<div data-e2e="video-share-container"><div class="list" style="overflow-y:auto"><input placeholder="搜索"><div class="rows"></div></div></div>', undefined, { fast: true });
  try {
    const list = f.window.document.querySelector('.list');
    Object.defineProperty(list, 'scrollHeight', { value: 300 });
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    list.scrollTop = 200;
    const render = () => {
      const start = Math.floor(list.scrollTop / 50);
      f.window.document.querySelector('.rows').innerHTML = rows.slice(start,start+2).map(liveRow).join('');
      for (const control of f.window.document.querySelectorAll('[data-userid]')) control.onclick = (event) => {
        assert.equal(control.getAttribute('data-userid'), rows[0].uid);
        event.target.textContent = '已发送';
      };
    };
    list.addEventListener('scroll', render);render();
    assert.equal((await f.task({ action: 'share', videoId, recipient: { id: uidOf(rows[0].uid), ...rows[0] } })).sent, true);
    assert.equal(list.scrollTop, 0);
  } finally { f.close(); }
});

test('a search input replaced by the page is reacquired before clearing a failed search', async () => {
  const uid = '7123456789012345660';
  const f = fixture(livePanel(liveRow({ uid: '7123456789012345661', name: '其他好友' })), undefined, { fast: true });
  try {
    const oldInput = f.window.document.querySelector('input');
    oldInput.oninput = () => {
      f.window.document.querySelector('[data-e2e="video-share-container"]').innerHTML = '<input placeholder="搜索" value="旧昵称"><img src="https://fixture.test/qr.png"><div class="rows"></div>';
      f.window.document.querySelector('input').oninput = (event) => {
        if (event.target.value) return;
        f.window.document.querySelector('.rows').innerHTML = liveRow({ uid, name: '新昵称' });
        f.window.document.querySelector('[data-userid]').onclick = (e) => { e.target.textContent = '已发送'; };
      };
    };
    assert.equal((await f.task({ action: 'share', videoId, recipient: { id: uidOf(uid), uid, name: '旧昵称' } })).sent, true);
    assert.equal(oldInput.isConnected, false);
  } finally { f.close(); }
});

test('a newly inserted 分享成功 text confirms the send even without a toast class', async () => {
  const f = fixture('');
  try {
    const pending = f.task({ action: 'share', videoId, mode: 'confirm',
      recipient: { id: 'uid:1', uid: '1', name: '小明', avatarKey: '/a.jpg' } });
    await new Promise((resolve) => setTimeout(resolve, 120));
    f.window.document.body.insertAdjacentHTML('beforeend', '<div>分享成功</div>');
    const result = await pending;
    assert.equal(result.sent, true);
    assert.equal(result.evidence, 'success-text');
  } finally { f.close(); }
});

test('arming before click retains a success receipt that disappears before confirm starts', async () => {
  const f = fixture(livePanel(), undefined, { fast: true });
  const recipient = { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' };
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('[data-userid]');
    const armed = await f.task({ action: 'share', mode: 'arm', videoId, recipient, point: { x: 20, y: 20 } });
    const receipt = f.window.document.createElement('div');
    receipt.textContent = '分享成功';
    f.window.document.body.append(receipt);
    receipt.remove(); // Simulate a short receipt entirely inside the CDP click.
    const result = await f.task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken: armed.receiptToken });
    assert.equal(result.sent, true);
    assert.equal(result.evidence, 'success-text');
    assert.equal(f.window.__douyinWatchShareReceiptV10, undefined);
  } finally { f.close(); }
});

test('a success notice already present before arming is not reused for a new send', async () => {
  const f = fixture(livePanel() + '<div role="status">分享成功</div>', undefined, { fast: true });
  const recipient = { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' };
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('[data-userid]');
    const armed = await f.task({ action: 'share', mode: 'arm', videoId, recipient, point: { x: 20, y: 20 } });
    await assert.rejects(f.task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken: armed.receiptToken }), /发送结果无法确认/);
  } finally { f.close(); }
});

test('new comment text including 分享成功 is neither a receipt nor copied into the error', async () => {
  const f = fixture(livePanel(), undefined, { fast: true });
  const recipient = { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' };
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('[data-userid]');
    const armed = await f.task({ action: 'share', mode: 'arm', videoId, recipient, point: { x: 20, y: 20 } });
    f.window.document.body.insertAdjacentHTML('beforeend', '<div data-e2e="comment-list"><div>匿名评论者一</div><span role="status">分享成功</span><div>暂时没有更多评论</div></div>');
    const result = await f.task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken: armed.receiptToken, captureErrors: true });
    assert.match(result.error, /发送结果无法确认/);
    assert.doesNotMatch(result.error, /匿名评论者|暂时没有更多评论|新增文字/);
  } finally { f.close(); }
});

test('a pointer now over the comments cannot arm a click at a stale friend position', async () => {
  const f = fixture(livePanel() + '<div id="comment">评论内容</div>');
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('#comment');
    const result = await f.task({ action: 'share', mode: 'arm', videoId, captureErrors: true, point: { x: 20, y: 20 },
      recipient: { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' } });
    assert.equal(result.code, 'SHARE_TARGET_CHANGED');
    assert.equal(result.retryable, true);
    assert.equal(result.details.reason, 'hit-mismatch');
    assert.match(result.error, /尚未点击发送/);
    assert.equal(f.window.__douyinWatchShareReceiptV10, undefined);
  } finally { f.close(); }
});

test('an ambiguous UID blocks relocation rather than repeatedly choosing a control', async () => {
  const uid = '7123456789012345678';
  const f = fixture(livePanel(liveRow({ uid, name: '好友甲' }) + liveRow({ uid, name: '好友乙' })));
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('[data-userid]');
    const result = await f.task({ action: 'share', mode: 'arm', videoId, captureErrors: true, point: { x: 20, y: 20 },
      recipient: { id: uidOf(uid), uid, name: '测试好友甲' } });
    assert.equal(result.code, 'SHARE_TARGET_CHANGED');
    assert.equal(result.retryable, false);
    assert.equal(result.details.reason, 'identity-ambiguous');
    assert.equal(f.window.__douyinWatchShareReceiptV10, undefined);
  } finally { f.close(); }
});

test('a closed share panel is classified as a retryable pre-press change', async () => {
  const f = fixture('');
  try {
    const result = await f.task({ action: 'share', mode: 'arm', videoId, captureErrors: true, point: { x: 20, y: 20 },
      recipient: { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' } });
    assert.equal(result.code, 'SHARE_TARGET_CHANGED');
    assert.equal(result.retryable, true);
    assert.equal(result.details.reason, 'panel-closed');
    assert.equal(f.window.__douyinWatchShareReceiptV10, undefined);
  } finally { f.close(); }
});

test('a receipt token from another attempt cannot confirm this attempt', async () => {
  const f = fixture(livePanel());
  const recipient = { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲' };
  try {
    f.window.document.elementFromPoint = () => f.window.document.querySelector('[data-userid]');
    await f.task({ action: 'share', mode: 'arm', videoId, recipient, point: { x: 20, y: 20 } });
    await assert.rejects(f.task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken: 'another-attempt' }), /监听已失效或与本条任务不一致/);
  } finally { f.close(); }
});

test('success arriving at the last confirmation wait is checked before reporting failure', async () => {
  const f = fixture('');
  try {
    let waits = 0;
    const timer = f.window.setTimeout;
    f.window.setTimeout = (callback, ms) => ms !== 250 ? timer(callback, ms) : timer(() => {
      if (++waits === 24) f.window.document.body.insertAdjacentHTML('beforeend', '<div>分享成功</div>');
      callback();
    }, 0);
    const result = await f.task({ action: 'share', videoId, mode: 'confirm', recipient: { id: 'uid:1', uid: '1', name: '好友' } });
    assert.equal(result.sent, true);
  } finally { f.close(); }
});

test('zero-width formatting in a new success notification does not hide the receipt', async () => {
  const f = fixture('');
  try {
    const timer = f.window.setTimeout;
    let inserted = false;
    f.window.setTimeout = (callback, ms) => ms !== 250 ? timer(callback, ms) : timer(() => {
      if (!inserted) { inserted = true; f.window.document.body.insertAdjacentHTML('beforeend', '<div>分享\u200b成功</div>'); }
      callback();
    }, 0);
    assert.equal((await f.task({ action: 'share', videoId, mode: 'confirm', recipient: { id: 'uid:1', uid: '1', name: '好友' } })).sent, true);
  } finally { f.close(); }
});

test('an existing anonymous notification updated through its text node is observed', async () => {
  const f = fixture('<div id="notice">正在处理</div>');
  try {
    const timer = f.window.setTimeout;
    let changed = false;
    f.window.setTimeout = (callback, ms) => ms !== 250 ? timer(callback, ms) : timer(() => {
      if (!changed) { changed = true; f.window.document.querySelector('#notice').firstChild.data = '分享成功'; }
      callback();
    }, 0);
    assert.equal((await f.task({ action: 'share', videoId, mode: 'confirm', recipient: { id: 'uid:1', uid: '1', name: '好友' } })).sent, true);
  } finally { f.close(); }
});

test('a newly inserted sentence containing the words 分享成功 is not a success receipt', async () => {
  const f = fixture('', undefined, { fast: true });
  try {
    const timer = f.window.setTimeout;
    let inserted = false;
    f.window.setTimeout = (callback, ms) => ms !== 250 ? timer(callback, ms) : timer(() => {
      if (!inserted) { inserted = true; f.window.document.body.insertAdjacentHTML('beforeend', '<div>提高分享成功率</div>'); }
      callback();
    }, 0);
    await assert.rejects(f.task({ action: 'share', videoId, mode: 'confirm', recipient: { id: 'uid:1', uid: '1', name: '好友' } }), /发送结果无法确认/u);
  } finally { f.close(); }
});

test('unrelated inserted text such as 清屏 never counts as a send', async () => {
  const f = fixture('', undefined, { fast: true });
  try {
    f.window.document.body.insertAdjacentHTML('beforeend', '<div>清屏</div><div>标清 540P</div>');
    await assert.rejects(f.task({ action: 'share', videoId, mode: 'confirm',
      recipient: { id: 'uid:1', uid: '1', name: '小明', avatarKey: '/a.jpg' } }), /发送结果无法确认/u);
  } finally { f.close(); }
});

test('detail-video-info must agree with the queued video before any click', async () => {
  const f = fixture(`<div data-e2e="detail-video-info" data-e2e-aweme-id="111">${livePanel()}</div>`);
  try {
    f.window.document.querySelector('[data-userid]').onclick = () => assert.fail('stale video must not be shared');
    await assert.rejects(f.task({ action: 'share', videoId,
      recipient: { id: uidOf('7123456789012345678'), uid: '7123456789012345678', name: '测试好友甲', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } }),
      /不是待发送的视频/u);
  } finally { f.close(); }
});

test('uid identity survives long numeric ids without precision loss', async () => {
  const uid = '7123456789012345678';
  const f = fixture(livePanel(liveRow({ uid })));
  try {
    const friends = await f.task({ action: 'friends' });
    assert.equal(typeof friends[0].uid, 'string');
    assert.equal(friends[0].uid, uid);
    const control = f.window.document.querySelector('[data-userid]');
    control.onclick = () => { control.textContent = '已发送'; };
    assert.equal((await f.task({ action: 'share', videoId,
      recipient: { id: uidOf(uid), uid, name: '测试好友甲', avatarKey: '/aweme/100x100/aweme-avatar/abc.jpeg' } })).sent, true);
  } finally { f.close(); }
});
