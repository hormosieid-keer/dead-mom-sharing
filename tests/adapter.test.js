import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { browserTask } from '../extension/adapter.js';
const networkTapSource = await readFile(new URL('../extension/network-tap.js', import.meta.url), 'utf8');

const videoId = '7654321000123456789';
const recipient = { name: '小明', avatarKey: '/avatar/a.jpg' };
function fixture(body = '', path = `/video/${videoId}`) {
  const dom = new JSDOM(body, { url: `https://www.douyin.com${path}`, runScripts: 'outside-only' });
  dom.window.Element.prototype.getClientRects = function () {
    return [{ width: 40, height: 40, top: 0, left: 0, right: 40, bottom: 40 }];
  };
  // Evaluate the serialized function, as Chrome does. This catches accidental
  // dependencies on module scope in addition to exercising real DOM traversal.
  const task = dom.window.eval(`(${browserTask.toString()})`);
  return { dom, window: dom.window, task, close: () => dom.window.close() };
}
const friendRow = (name = '小明', avatar = 'https://p3.douyinpic.com/avatar/a.jpg~100x100?token=rotating', contents = '<button>发送</button>') =>
  `<li><img src="${avatar}"><span>${name}</span>${contents}</li>`;
const sharePanel = (rows = friendRow(), extra = '') =>
  `<div role="dialog"><h2>分享给朋友</h2><ul>${rows}</ul>${extra}</div>`;

test('explicit unavailable page produces video-bound evidence before opening or preparing a share', async () => {
  const f=fixture('<div class="error-page"><p>你要观看的视频不存在</p></div>');
  try {
    for(const action of ['videoStatus','openShare','share']) {
      const result=await f.task({action,videoId,mode:'probe',recipient,captureErrors:true});
      assert.equal(result.code,'VIDEO_UNAVAILABLE');
      assert.deepEqual(JSON.parse(JSON.stringify(result.details)),{videoId,reason:'not-found',evidence:'visible-error'});
    }
  } finally {f.close();}
});

test('unavailable detection excludes hidden, caption, comment, recommendation and share text', async () => {
  for(const body of [
    '<p hidden>你要观看的视频不存在</p>',
    '<div data-e2e="video-desc"><span>你要观看的视频不存在</span></div>',
    '<div class="comment"><span>你要观看的视频不存在</span></div>',
    '<aside><p>你要观看的视频不存在</p></aside>',
    '<div role="dialog"><p>你要观看的视频不存在</p></div>',
    '<video></video><p>你要观看的视频不存在</p>',
    '<p>网络异常，请稍后重试</p>', '<p>正在加载</p>', '<p>账号已被封禁</p>',
    '<p>这个视频说的是：你要观看的视频不存在</p>'
  ]) {
    const f=fixture(body);
    try {assert.equal((await f.task({action:'videoStatus',videoId})).unavailable,false,body);}
    finally {f.close();}
  }
});

test('unavailable pages cannot override verification or a mismatching live video identity',async()=>{
  for(const [body,path] of [
    ['<div class="captcha">验证</div><p>你要观看的视频不存在</p>',`/video/${videoId}`],
    ['<p>你要观看的视频不存在</p>','/video/999'],
    ['<p>你要观看的视频不存在</p>',`/video/${videoId}?modal_id=999`],
    ['<div data-e2e="feed-active-video" data-aweme-id="999"></div><div class="error"><p>你要观看的视频不存在</p></div>',`/video/${videoId}`]
  ]) {
    const f=fixture(body,path);
    try {
      const result=await f.task({action:'videoStatus',videoId,captureErrors:true});
      assert.ok(result.error);assert.notEqual(result.code,'VIDEO_UNAVAILABLE');
    } finally {f.close();}
  }
});

test('deleted, removed and video-specific violation labels have distinct reasons',async()=>{
  for(const [label,reason] of [['作品已删除','deleted'],['该视频已下架','removed'],['该视频因违规无法播放','restricted']]) {
    const f=fixture(`<div class="error-page"><p>${label}。</p></div>`);
    try {assert.equal((await f.task({action:'videoStatus',videoId,captureErrors:true})).details.reason,reason);}
    finally {f.close();}
  }
});

test('serialized adapter checks account identity and fails closed for missing login', async () => {
  const f = fixture();
  try {
    let request;
    f.window.fetch = async (url, init) => { request = { url, init }; return { ok: true, json: async () =>
      ({ status_code: 0, user: { uid: '123456', sec_uid: 'MS4w-account', nickname: '专用账号' } }) }; };
    assert.deepEqual(JSON.parse(JSON.stringify(await f.task({ action: 'probe' }))), { id: '123456', secUid: 'MS4w-account', name: '专用账号' });
    assert.equal(request.init.credentials, 'include');
    assert.match(request.url, /profile\/self/u);
    f.window.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0, user: {} }) });
    await assert.rejects(f.task({ action: 'probe' }), /未确认抖音登录账号/u);
  } finally { f.close(); }
});

test('request deadline remains active while reading the response body', { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    const originalTimer = f.window.setTimeout;
    f.window.setTimeout = (callback) => originalTimer(callback, 0);
    f.window.fetch = async (_url, init) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(new Error('aborted'));
      else init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }) });
    await assert.rejects(f.task({ action: 'probe' }), /响应读取超时/u);
  } finally { f.close(); }
});

test('search uses newest filters and carries real cursor/search_id across pages', async () => {
  const f = fixture('', '/search/%23%E7%88%B1%E6%85%95%E6%9D%B0');
  try {
    const requests = [];
    f.window.fetch = async (url) => {
      requests.push(new URL(url, f.window.location.origin));
      return { ok: true, json: async () => requests.length === 1 ?
        { status_code: 0, data: [{ aweme_info: { aweme_id: '1' } }], has_more: 1, cursor: 7, log_pb: { impr_id: 'search-actual' } } :
        { status_code: 0, data: [], has_more: 0 } };
    };
    const result = await f.task({ action: 'search', query: '#爱慕杰' });
    assert.equal(result.payloads.length, 2);
    assert.equal(result.truncated, false);
    assert.equal(requests[0].pathname, '/aweme/v1/web/search/item/');
    assert.equal(requests[0].searchParams.get('sort_type'), '2');
    assert.equal(requests[0].searchParams.get('publish_time'), '1');
    assert.equal(requests[0].searchParams.get('search_channel'), 'aweme_video_web');
    assert.equal(requests[1].searchParams.get('offset'), '7');
    assert.equal(requests[1].searchParams.get('search_id'), 'search-actual');
  } finally { f.close(); }
});

test('the platform time filter follows the configured window instead of one day', async () => {
  const f = fixture('', '/search/test');
  try {
    const seen = [];
    f.window.fetch = async (url) => {
      seen.push(new URL(url, f.window.location.origin));
      return { ok: true, json: async () => ({ status_code: 0, data: [], has_more: 0 }) };
    };
    await f.task({ action: 'search', query: 'test', windowMinutes: 60 });
    await f.task({ action: 'search', query: 'test', windowMinutes: 10080 });
    await f.task({ action: 'search', query: 'test', windowMinutes: 43200 });
    assert.deepEqual(seen.map((url) => url.searchParams.get('publish_time')), ['1', '7', '182']);
    assert.ok(seen.every((url) => url.searchParams.get('sort_type') === '2'), 'newest-first ordering is kept');
  } finally { f.close(); }
});

test('search reports incomplete page caps and rejects malformed success responses', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0, data: [], has_more: 1, cursor: 20, search_id: 's' }) });
    assert.equal((await f.task({ action: 'search', query: 'test', maxPages: 1 })).truncated, true);
    f.window.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0 }) });
    await assert.rejects(f.task({ action: 'search', query: 'test' }), /响应结构不受支持/u);
    f.window.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0, data: [], has_more: 1, cursor: 0 }) });
    await assert.rejects(f.task({ action: 'search', query: 'test' }), /游标/u);
  } finally { f.close(); }
});

const capturedPage = (query, offset, payload, { at = Date.now(), sort = '2', searchId = '' } = {}) => ({
  at, url: `https://www.douyin.com/aweme/v1/web/search/item/?${new URLSearchParams({ keyword: query, offset: String(offset), sort_type: sort, search_id: searchId })}`, payload
});
test('failed direct request falls back only to current, newest-sorted native pages with correct cursor', async () => {
  const f = fixture('', '/search/test');
  try {
    const at = Date.now();
    f.window.__DY_SENTINEL_SEARCH__ = [
      capturedPage('wrong query', 0, { status_code: 0, data: [], has_more: 0 }, { at }),
      capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 }, { at, sort: '0' }),
      capturedPage('test', 0, { status_code: 0, data: [{ aweme_info: { aweme_id: '1' } }], has_more: 1, cursor: 7, search_id: 'native-search' }, { at }),
      capturedPage('test', 7, { status_code: 0, data: [{ aweme_info: { aweme_id: '2' } }], has_more: 0 }, { at, searchId: 'native-search' })
    ];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    const result = await f.task({ action: 'search', query: 'test' });
    assert.equal(result.source, 'native');
    assert.equal(result.payloads.length, 2);
    assert.equal(result.payloads[1].data[0].aweme_info.aweme_id, '2');
    assert.equal(result.truncated, false);
  } finally { f.close(); }
});

test('native newest filter UI must produce an observed sorted response before use', async () => {
  const f = fixture('<button id="filter">筛选</button><button id="newest" hidden>最新发布</button>', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    f.window.document.querySelector('#filter').onclick = () => { f.window.document.querySelector('#newest').hidden = false; };
    f.window.document.querySelector('#newest').onclick = () => {
      const url = `https://www.douyin.com/aweme/v1/web/general/search/?${new URLSearchParams({ keyword: 'test', offset: '0', filter_selected: JSON.stringify({ sort_type: '2' }) })}`;
      f.window.__DY_SENTINEL_SEARCH__.push({ at: Date.now(), url, payload: { status_code: 0, data: [], has_more: 0 } });
    };
    const result = await f.task({ action: 'search', query: 'test' });
    assert.equal(result.source, 'native');
    assert.equal(result.truncated, false);
  } finally { f.close(); }
});

test('native search handles filter text split around icons and nested newest labels', async () => {
  const f = fixture('<div id="filter"><span>筛</span><span>选</span><svg></svg></div><label id="newest" role="radio" hidden><span>最新</span><b>发布</b></label>', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    f.window.document.querySelector('#filter').onclick = () => { f.window.document.querySelector('#newest').hidden = false; };
    f.window.document.querySelector('#newest').onclick = () => {
      f.window.__DY_SENTINEL_SEARCH__.push(capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 }));
    };
    assert.equal((await f.task({ action: 'search', query: 'test' })).source, 'native');
  } finally { f.close(); }
});

test('native search accepts a filter menu opened by hovering without toggling it shut', async () => {
  const f = fixture('<button id="filter">筛选</button><button id="newest" hidden>最新发布</button>', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    const filter = f.window.document.querySelector('#filter');
    const newest = f.window.document.querySelector('#newest');
    filter.onmouseover = () => { newest.hidden = false; };
    filter.onclick = () => { newest.hidden = true; };
    newest.onclick = () => { f.window.__DY_SENTINEL_SEARCH__.push(capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 })); };
    assert.equal((await f.task({ action: 'search', query: 'test' })).source, 'native');
  } finally { f.close(); }
});

test('native search waits for responsive filters that mount after the page load event', async () => {
  const f = fixture('<div id="toolbar"></div>', '/search/test');
  let timer;
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    timer = setTimeout(() => {
      f.window.document.querySelector('#toolbar').innerHTML = '<button id="newest">最新发布</button>';
      f.window.document.querySelector('#newest').onclick = () => { f.window.__DY_SENTINEL_SEARCH__.push(capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 })); };
    }, 120);
    assert.equal((await f.task({ action: 'search', query: 'test' })).source, 'native');
  } finally { clearTimeout(timer); f.close(); }
});

test('stale and non-newest native results cannot silently replace a failed search', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [
      capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 }, { at: Date.now() - 31000 }),
      capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 }, { sort: '0' })
    ];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(f.task({ action: 'search', query: 'test' }), /无法识别原生.*最新发布/u);
  } finally { f.close(); }
});

test('API verification requests and throttling pause instead of using cached native results', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [capturedPage('test', 0, { status_code: 0, data: [], has_more: 0 })];
    f.window.fetch = async () => ({ ok: true, json: async () => ({ status_code: 0, data: [], has_more: 0, verify_info: { required: true } }) });
    await assert.rejects(f.task({ action: 'search', query: 'test' }), /安全验证/u);
    f.window.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(f.task({ action: 'search', query: 'test' }), /HTTP 429/u);
  } finally { f.close(); }
});

test('native search reports page caps and does not consume mismatched pagination search IDs', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [
      capturedPage('test', 0, { status_code: 0, data: [], has_more: 1, cursor: 20, search_id: 'session-a' }),
      capturedPage('test', 20, { status_code: 0, data: [{ aweme_info: { aweme_id: 'wrong' } }], has_more: 0 }, { searchId: 'session-b' })
    ];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    assert.equal((await f.task({ action: 'search', query: 'test', maxPages: 1 })).truncated, true);
    const result = await f.task({ action: 'search', query: 'test', maxPages: 2 });
    assert.equal(result.payloads.length, 1);
    assert.equal(result.truncated, true);
  } finally { f.close(); }
});

test('native pagination scrolls the result container and uses only its matching captured page', async () => {
  const f = fixture('<div data-e2e="search-result-container" style="overflow-y:auto"><article data-e2e="search-result-item">结果</article></div>', '/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__ = [capturedPage('test', 0,
      { status_code: 0, data: [], has_more: 1, cursor: 20, search_id: 'native-session' })];
    f.window.fetch = async () => ({ ok: false, status: 403 });
    const container = f.window.document.querySelector('div');
    Object.defineProperty(container, 'scrollHeight', { value: 1000 });
    Object.defineProperty(container, 'clientHeight', { value: 200 });
    let scrolls = 0;
    container.scrollTo = () => {
      scrolls++;
      f.window.__DY_SENTINEL_SEARCH__.push(capturedPage('test', 20,
        { status_code: 0, data: [{ aweme_info: { aweme_id: 'next' } }], has_more: 0 }, { searchId: 'native-session' }));
    };
    const result = await f.task({ action: 'search', query: 'test', maxPages: 2 });
    assert.equal(scrolls, 1);
    assert.equal(result.payloads.length, 2);
    assert.equal(result.truncated, false);
  } finally { f.close(); }
});

test('network tap clones only search responses and strips all non-search parameters', async () => {
  const f = fixture('', '/search/test');
  try {
    let originalReads = 0;
    f.window.fetch = async () => ({ ok: true, json: async () => { originalReads++; return { untouched: true }; },
      clone: () => ({ json: async () => ({ status_code: 0, data: [], has_more: 0 }) }) });
    f.window.eval(networkTapSource);
    const url = '/aweme/v1/web/search/item/?keyword=test&sort_type=2&offset=0&msToken=secret&a_bogus=signature&cookie=secret';
    const response = await f.window.fetch(url);
    await f.window.fetch('/aweme/v1/web/user/profile/self/?cookie=secret');
    await f.window.fetch('https://elsewhere.test/aweme/v1/web/search/item/?keyword=test');
    await new Promise(setImmediate);
    assert.equal(f.window.__DY_SENTINEL_SEARCH__.length, 1);
    const entry = f.window.__DY_SENTINEL_SEARCH__[0];
    assert.equal(new URL(entry.url).searchParams.get('keyword'), 'test');
    assert.doesNotMatch(entry.url, /msToken|a_bogus|cookie|secret/u);
    assert.equal(originalReads, 0);
    await response.json();
    assert.equal(originalReads, 1);
  } finally { f.close(); }
});

test('network tap is bounded and repeated installation does not wrap fetch again', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.fetch = async () => ({ ok: true, clone: () => ({ json: async () => ({ status_code: 0, data: [], has_more: 0 }) }) });
    f.window.eval(networkTapSource);
    const once = f.window.fetch;
    f.window.eval(networkTapSource);
    assert.equal(f.window.fetch, once);
    await Promise.all(Array.from({ length: 35 }, (_, i) => f.window.fetch(`/aweme/v1/web/search/item/?keyword=test&offset=${i}`)));
    await new Promise(setImmediate);
    assert.equal(f.window.__DY_SENTINEL_SEARCH__.length, 25);
    assert.equal(new URL(f.window.__DY_SENTINEL_SEARCH__[0].url).searchParams.get('offset'), '10');
  } finally { f.close(); }
});

test('network tap captures native XHR JSON without reading or changing request bodies', async () => {
  const f = fixture('', '/search/test');
  try {
    let body;
    class FakeXHR extends f.window.EventTarget {
      open(method, url) { this.method = method; this.url = url; }
      send(value) {
        body = value;
        this.status = 200; this.responseType = 'json';
        this.response = { status_code: 0, data: [], has_more: 0 };
        this.dispatchEvent(new f.window.Event('loadend'));
      }
    }
    f.window.XMLHttpRequest = FakeXHR;
    f.window.eval(networkTapSource);
    const xhr = new f.window.XMLHttpRequest();
    xhr.open('GET', '/aweme/v1/web/general/search/?keyword=test&sort_type=2&msToken=secret');
    xhr.send('unchanged');
    assert.equal(body, 'unchanged');
    assert.equal(f.window.__DY_SENTINEL_SEARCH__.length, 1);
    assert.doesNotMatch(f.window.__DY_SENTINEL_SEARCH__[0].url, /msToken|secret/u);
    xhr.response.data.push('changed by page');
    assert.equal(f.window.__DY_SENTINEL_SEARCH__[0].payload.data.length, 0);
  } finally { f.close(); }
});

test('native general/search/single response is observed and accepted with verified newest sorting', async () => {
  const f = fixture('', '/search/test');
  try {
    f.window.fetch = async () => ({ ok: true, clone: () => ({ json: async () => ({ status_code: 0, data: [], has_more: 0 }) }) });
    f.window.eval(networkTapSource);
    await f.window.fetch(`/aweme/v1/web/general/search/single/?${new URLSearchParams({ keyword: 'test', offset: '0', filter_selected: JSON.stringify({ sort_type: '2' }) })}`);
    await new Promise(setImmediate);
    assert.equal(f.window.__DY_SENTINEL_SEARCH__.length, 1);
    assert.equal(new URL(f.window.__DY_SENTINEL_SEARCH__[0].url).pathname, '/aweme/v1/web/general/search/single/');
    f.window.fetch = async () => ({ ok: false, status: 403 });
    const result = await f.task({ action: 'search', query: 'test' });
    assert.equal(result.source, 'native');
    assert.equal(result.payloads.length, 1);
    assert.equal(result.truncated, false);
  } finally { f.close(); }
});

test('visible challenge blocks every operation without requests or clicks', async () => {
  const f = fixture('<div id="captcha-container">安全验证</div>');
  try {
    f.window.fetch = () => assert.fail('must not request');
    await assert.rejects(f.task({ action: 'probe' }), /安全验证/u);
    const captured = await f.task({ action: 'probe', captureErrors: true });
    assert.match(captured.error, /安全验证/u);
  } finally { f.close(); }
});

// Synthetic shell only. No puzzle images, answers or real verification service.
const imageChallenge = '<section role="dialog"><h2>虚构题目</h2><div>请选择所有符合上文描述的图片，并拖拽到下方</div><div>拖拽到这里</div><button>提交</button></section>';

test('image drag verification without captcha markers blocks search, account and share actions', async () => {
  const f = fixture(imageChallenge, '/search/test');
  try {
    f.window.fetch = () => assert.fail('must not request');
    f.window.document.querySelector('button').onclick = () => assert.fail('must not click verification');
    for (const action of ['search','probe','openShare']) {
      const result = await f.task({ action, query:'test', captureErrors:true });
      assert.equal(result.code, 'SECURITY_CHALLENGE');
      assert.match(result.error, /图片拖拽安全验证.*手动/u);
    }
  } finally { f.close(); }
});

test('hidden instructions, search content and an isolated drop label are not verification evidence', async () => {
  const phrase = '请选择所有符合上文描述的图片，并拖拽到下方';
  for (const body of [
    `<div hidden>${phrase}</div>`, `<div style="display:none"><p>${phrase}</p></div>`,
    `<div aria-hidden="true"><p>${phrase}</p></div>`, `<article><div>${phrase}</div></article>`,
    `<div><article><p>${phrase}</p></article></div>`, `<div><p hidden>${phrase}</p></div>`,
    `<div data-e2e="search-result-item"><p>${phrase}</p></div>`,
    `<div data-e2e="video-desc"><span>${phrase}</span></div>`,
    `<div class="Comment"><p>${phrase}</p></div>`, `<div contenteditable="true">${phrase}</div>`,
    '<div>虚构题目</div><div>拖拽到这里</div>', `<div>视频讲解：${phrase}</div>`
  ]) {
    const f = fixture(body, '/search/test');
    try {
      f.window.fetch = async () => ({ok:true,json:async()=>({status_code:0,data:[],has_more:0})});
      assert.equal((await f.task({action:'search',query:'test'})).payloads.length,1,body);
    } finally { f.close(); }
  }
});

test('visible split instruction in an accessible frame is detected, hidden frame is ignored', async () => {
  for (const hidden of [false,true]) {
    const f=fixture(`<iframe ${hidden?'hidden':''}></iframe>`,'/search/test');
    try {
      const frame=f.window.document.querySelector('iframe');
      frame.contentWindow.Element.prototype.getClientRects=f.window.Element.prototype.getClientRects;
      frame.contentDocument.body.innerHTML =
        '<p><span>请选择所有符合上文描述的图片，</span><b>并拖拽到下方</b></p>';
      let requests=0;
      f.window.fetch=async()=>{requests++;return {ok:true,json:async()=>({status_code:0,data:[],has_more:0})};};
      const result=await f.task({action:'search',query:'test',captureErrors:true});
      assert.equal(result.code,hidden?undefined:'SECURITY_CHALLENGE');
      assert.equal(requests,hidden?1:0);
    } finally {f.close();}
  }
});

test('verification markers include mixed-case captcha and visible verification frames',async()=>{
  for(const body of ['<div class="CaptchaDialog">安全验证</div>',
    '<iframe src="https://verification.invalid/Captcha/index"></iframe>',
    '<iframe title="人机验证"></iframe>']) {
    const f=fixture(body,'/search/test');
    try {assert.equal((await f.task({action:'search',query:'test',captureErrors:true})).code,'SECURITY_CHALLENGE');}
    finally {f.close();}
  }
});

for (const stage of ['fetch','json']) test(`image verification interrupts a pending ${stage} and aborts without native fallback`, {timeout:2000}, async()=>{
  const f=fixture('<button id="newest">最新发布</button>','/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__=[capturedPage('test',0,{status_code:0,data:[],has_more:0})];
    f.window.document.querySelector('button').onclick=()=>assert.fail('must not attempt native search');
    let signal;
    const stalled=()=>{
      f.window.setTimeout(()=>f.window.document.body.insertAdjacentHTML('beforeend',imageChallenge),10);
      return new Promise(()=>{});
    };
    f.window.fetch=(_url,options)=>{
      signal=options.signal;
      return stage==='fetch'?stalled():Promise.resolve({ok:true,json:stalled});
    };
    const result=await f.task({action:'search',query:'test',captureErrors:true});
    assert.equal(result.code,'SECURITY_CHALLENGE');
    assert.match(result.error,/图片拖拽安全验证/u);
    assert.equal(signal.aborted,true);
  } finally {f.close();}
});

test('a fresh successful response cannot conceal a simultaneously appearing verification dialog',async()=>{
  const f=fixture('','/search/test');
  try {
    f.window.fetch=async()=>({ok:true,json:async()=>{
      f.window.document.body.innerHTML=imageChallenge;
      return {status_code:0,data:[],has_more:0};
    }});
    assert.equal((await f.task({action:'search',query:'test',captureErrors:true})).code,'SECURITY_CHALLENGE');
  } finally {f.close();}
});

test('native filtering that opens image verification retains its explicit challenge error',async()=>{
  const f=fixture('<button id="filter">筛选</button>','/search/test');
  try {
    f.window.__DY_SENTINEL_SEARCH__=[];
    f.window.fetch=async()=>({ok:false,status:403});
    f.window.document.querySelector('button').onmouseover=()=>f.window.document.body.insertAdjacentHTML('beforeend',imageChallenge);
    const result=await f.task({action:'search',query:'test',captureErrors:true});
    assert.equal(result.code,'SECURITY_CHALLENGE');
  } finally {f.close();}
});

test('request verification watchers are removed after a successful response',async()=>{
  const f=fixture('','/search/test');
  try {
    let signal;
    const originalInterval=f.window.setInterval,originalClear=f.window.clearInterval;
    const active=new Set();
    f.window.setInterval=(...args)=>{const id=originalInterval(...args);active.add(id);return id;};
    f.window.clearInterval=id=>{active.delete(id);originalClear(id);};
    f.window.fetch=async(_url,options)=>{signal=options.signal;return {ok:true,json:async()=>({status_code:0,data:[],has_more:0})};};
    await f.task({action:'search',query:'test'});
    assert.equal(active.size,0);
    f.window.document.body.innerHTML=imageChallenge;
    await new Promise(setImmediate);
    assert.equal(signal.aborted,false,'a finished request must not react to later dialogs');
  } finally {f.close();}
});

test('video changes during native friend search cannot send the replacement video', async () => {
  const f = fixture(sharePanel(friendRow('小红', 'https://p3.douyinpic.com/avatar/b.jpg'), '<input placeholder="搜索好友">'));
  try {
    f.window.document.querySelector('input').oninput = () => {
      f.window.document.querySelector('ul').innerHTML = friendRow();
      f.window.document.querySelector('button').onclick = () => assert.fail('must not send after route change');
      f.window.history.pushState({}, '', '/video/111');
    };
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /不是待发送的视频/u);
  } finally { f.close(); }
});

test('friend binding strips rotating avatar parameters and excludes outside-chat rows', async () => {
  const f = fixture(`${sharePanel()}<aside>${friendRow('外部好友')}</aside>`);
  try {
    const result = await f.task({ action: 'friends' });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, '小明');
    assert.equal(result[0].avatarKey, recipient.avatarKey);
    assert.equal(result[0].id, `avatar:${encodeURIComponent('小明')}:${encodeURIComponent('/avatar/a.jpg')}`);
  } finally { f.close(); }
});

test('opens only a unique video share control and waits for its native panel', async () => {
  const f = fixture('<button data-e2e="video-player-share">分享</button>');
  try {
    f.window.document.querySelector('button').onclick = () => f.window.document.body.insertAdjacentHTML('beforeend', sharePanel());
    assert.equal((await f.task({ action: 'openShare' })).opened, true);
  } finally { f.close(); }
});

test('detail share uses the visible icon sibling instead of a zero-area legacy wrapper', async () => {
  const f = fixture('<div data-e2e="video-player-share"></div><div data-e2e="video-share-icon-container" role="button" aria-label="分享"></div>');
  try {
    const wrapper = f.window.document.querySelector('[data-e2e="video-player-share"]');
    const icon = f.window.document.querySelector('[data-e2e="video-share-icon-container"]');
    wrapper.getClientRects = () => [{ width: 0, height: 0 }];
    wrapper.onclick = () => assert.fail('zero-area wrapper must not be clicked');
    let clicks = 0;
    icon.onclick = () => {
      clicks++;
      f.window.document.body.insertAdjacentHTML('beforeend', sharePanel());
      f.window.document.querySelector('li button').onclick = () => assert.fail('opening share must not send');
    };
    assert.equal((await f.task({ action: 'openShare' })).opened, true);
    assert.equal(clicks, 1);
  } finally { f.close(); }
});

test('ambiguous visible share icons fail without clicking icons or falling back to a wrapper', async () => {
  const f = fixture('<div data-e2e="video-player-share"></div><div data-e2e="video-share-icon-container"></div><div data-e2e="video-share-icon-container"></div>');
  try {
    for (const node of f.window.document.querySelectorAll('[data-e2e]')) node.onclick = () => assert.fail('ambiguous icons must not be clicked');
    await assert.rejects(f.task({ action: 'openShare' }), /无法唯一识别当前视频的分享按钮/u);
    const result = await f.task({ action: 'openShare', captureErrors: true });
    assert.equal(result.code, 'SHARE_ENTRY_AMBIGUOUS');
  } finally { f.close(); }
});

test('a missing share entry has a distinct code for bounded page refresh recovery', async () => {
  const f = fixture('<main>播放器尚未加载</main>');
  try {
    const result = await f.task({ action: 'openShare', captureErrors: true });
    assert.equal(result.code, 'SHARE_ENTRY_MISSING');
    assert.match(result.error, /找到 0 个/);
  } finally { f.close(); }
});

test('share control is scoped to the active player when other player controls exist', async () => {
  const f = fixture('<section><button data-e2e="video-player-share">分享</button></section><section data-e2e="feed-active-video"><button data-e2e="video-player-share">分享</button></section>');
  try {
    const buttons = f.window.document.querySelectorAll('button');
    buttons[0].onclick = () => assert.fail('inactive player must not be selected');
    buttons[1].onclick = () => f.window.document.body.insertAdjacentHTML('beforeend', sharePanel());
    assert.equal((await f.task({ action: 'openShare' })).opened, true);
  } finally { f.close(); }
});

test('known default avatars and repeated visible avatars cannot provide fallback identities', async () => {
  for (const path of ['default_avatar.jpg', 'placeholder.jpg', 'anonymous.jpg', 'no-avatar.jpg']) {
    const f = fixture(sharePanel(friendRow('小明', `https://p3.douyinpic.com/avatar/${path}`)));
    try {
      f.window.document.querySelector('button').onclick = () => assert.fail('default avatar must not be used');
      await assert.rejects(f.task({ action: 'friends' }), /默认或重复头像/u);
      await assert.rejects(f.task({ action: 'share', videoId, recipient: { name: '小明', avatarKey: `/avatar/${path}` } }), /默认或重复头像/u);
    } finally { f.close(); }
  }
  const f = fixture(sharePanel(friendRow() + friendRow('另一个昵称')));
  try {
    f.window.document.querySelector('button').onclick = () => assert.fail('shared avatar must not be used');
    await assert.rejects(f.task({ action: 'friends' }), /默认或重复头像/u);
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /默认或重复头像/u);
  } finally { f.close(); }
});

test('a verified secUid permits identity binding even with a default avatar', async () => {
  const f = fixture(sharePanel('<li><img src="https://p3.douyinpic.com/avatar/default.jpg"><a href="/user/MS4w-stable">小明</a><button>发送</button></li>'));
  try {
    const result = await f.task({ action: 'friends' });
    assert.equal(result[0].secUid, 'MS4w-stable');
    const button = f.window.document.querySelector('button');
    button.onclick = () => { button.textContent = '已发送'; };
    assert.equal((await f.task({ action: 'share', videoId, recipient: result[0] })).sent, true);
  } finally { f.close(); }
});

test('sends only exact avatar/name match and confirms row status', async () => {
  const f = fixture(sharePanel(friendRow('小明', 'https://p3.douyinpic.com/avatar/b.jpg') + friendRow()));
  try {
    let clicked = 0;
    const buttons = f.window.document.querySelectorAll('li button');
    buttons[0].onclick = () => assert.fail('same name with different avatar must not be selected');
    buttons[1].onclick = () => { clicked++; buttons[1].textContent = '已发送'; };
    assert.equal((await f.task({ action: 'share', videoId, recipient })).sent, true);
    assert.equal(clicked, 1);
  } finally { f.close(); }
});

test('secUid binding survives nickname and avatar changes', async () => {
  const f = fixture(sharePanel('<li><img src="https://p3.douyinpic.com/avatar/changed.jpg"><a href="/user/MS4w-stable">新昵称</a><button>发送</button></li>'));
  try {
    const button = f.window.document.querySelector('button');
    button.onclick = () => { button.textContent = '已发送'; };
    assert.equal((await f.task({ action: 'share', videoId, recipient: { name: '旧昵称', secUid: 'MS4w-stable' } })).sent, true);
  } finally { f.close(); }
});

test('uses native friend search when bound friend is not initially visible', async () => {
  const f = fixture(sharePanel(friendRow('小红', 'https://p3.douyinpic.com/avatar/b.jpg'), '<input placeholder="搜索好友">'));
  try {
    const search = f.window.document.querySelector('input');
    search.oninput = () => {
      assert.equal(search.value, recipient.name);
      f.window.document.querySelector('ul').innerHTML = friendRow();
      const button = f.window.document.querySelector('li button');
      button.onclick = () => { button.textContent = '已发送'; };
    };
    assert.equal((await f.task({ action: 'share', videoId, recipient })).sent, true);
  } finally { f.close(); }
});

test('ambiguous recipient, nickname-only binding and wrong video cannot cause any sends', async () => {
  const f = fixture(sharePanel(friendRow() + friendRow()));
  try {
    for (const button of f.window.document.querySelectorAll('button')) button.onclick = () => assert.fail('must not send');
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /唯一匹配/u);
    await assert.rejects(f.task({ action: 'share', videoId, recipient: { name: '小明' } }), /稳定身份/u);
    await assert.rejects(f.task({ action: 'share', videoId: '111', recipient }), /不是待发送的视频/u);
    await assert.rejects(f.task({ action: 'friends' }), /身份重复/u);
  } finally { f.close(); }
});

test('checkbox flow refuses other selected friends and sends only confirmed single target', async () => {
  const f = fixture(sharePanel(friendRow('小明', 'https://p3.douyinpic.com/avatar/a.jpg', '<input type="checkbox">') +
    friendRow('小红', 'https://p3.douyinpic.com/avatar/b.jpg', '<input type="checkbox" checked>'), '<button id="confirm">发送</button>'));
  try {
    let sends = 0;
    f.window.document.querySelector('#confirm').onclick = () => {
      sends++;
      f.window.document.querySelector('li').insertAdjacentHTML('beforeend', '<span>已发送</span>');
    };
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /已有其他选中好友/u);
    assert.equal(sends, 0);
    f.window.document.querySelectorAll('input')[1].checked = false;
    assert.equal((await f.task({ action: 'share', videoId, recipient })).sent, true);
    assert.equal(sends, 1);
  } finally { f.close(); }
});

test('hidden checked recipients are also rejected before sending', async () => {
  const f = fixture(sharePanel(friendRow() + '<li hidden><input type="checkbox" checked></li>'));
  try {
    f.window.document.querySelector('button').onclick = () => assert.fail('hidden recipient must prevent sends');
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /已有其他选中好友/u);
  } finally { f.close(); }
});

test('active modal pointing to a different video prevents sending', async () => {
  const f = fixture(sharePanel(), `/video/${videoId}?modal_id=111`);
  try {
    f.window.document.querySelector('button').onclick = () => assert.fail('must not send a different modal video');
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /不是待发送的视频/u);
  } finally { f.close(); }
});

test('a stale success toast cannot turn an unconfirmed send into success', async () => {
  const f = fixture(`${sharePanel()}<div role="status">发送成功</div>`);
  try {
    let clicks = 0;
    f.window.document.querySelector('button').onclick = () => { clicks++; };
    const originalTimer = f.window.setTimeout;
    f.window.setTimeout = (callback) => originalTimer(callback, 0);
    await assert.rejects(f.task({ action: 'share', videoId, recipient }), /结果无法确认/u);
    assert.equal(clicks, 1);
  } finally { f.close(); }
});

test('a newly observed native success toast confirms a send', async () => {
  const f = fixture(sharePanel());
  try {
    f.window.document.querySelector('button').onclick = () => f.window.document.body.insertAdjacentHTML('beforeend', '<div role="status">分享成功</div>');
    assert.equal((await f.task({ action: 'share', videoId, recipient })).sent, true);
  } finally { f.close(); }
});
