/**
 * Inject this function itself with chrome.scripting.executeScript.
 * `probe` and `search` require MAIN world, so the normal Douyin page fetch
 * integration can participate. Other actions use ISOLATED world.
 * Search parameters were checked against Youhai020616/douyin (MIT),
 * src/dy_cli/engines/api_client.py, commit 5267065. No signer is included.
 * Share DOM support is deliberately conservative and requires live validation.
 */
export async function browserTask(input = {}) {
  try {
  const fail = (message, code) => { const error = new Error(message); if (code) error.code = code; throw error; };
  if (location.origin !== 'https://www.douyin.com') fail('只能在 https://www.douyin.com 页面运行');
  const normalize = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
  const visible = (node) => {
    if (!node || node.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return node.getClientRects().length > 0;
  };
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(visible);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
  const checkChallenge = () => {
    const roots = [document], seen = new Set();
    const markers = '[id*="captcha" i],[class*="captcha" i],[data-e2e*="captcha" i],'+
      'iframe[src*="verify" i],iframe[src*="captcha" i],iframe[src*="challenge" i],'+
      'iframe[title*="安全验证"],iframe[title*="人机验证"]';
    const content = 'article,aside,nav,a,[data-e2e*="desc"],[data-e2e*="comment"],[data-e2e*="search-result"],'+
      '[class*="comment" i],[class*="caption" i],textarea,[contenteditable="true"]';
    // This image-selection dialog does not always have captcha in its classes.
    // Recognize its fixed instruction, never the changing puzzle or its answer.
    const instruction = /^请选择所有符合上文描述的图片[，,、]?并拖[拽动]到下方[。！!]?$/u;
    while (roots.length) {
      const root = roots.shift();
      if (seen.has(root)) continue;
      seen.add(root);
      if ([...root.querySelectorAll(markers)].some(visible))
        fail('抖音要求安全验证；请手动完成验证后恢复', 'SECURITY_CHALLENGE');
      for (const node of root.querySelectorAll('div,span,p,label,strong,h1,h2,h3')) {
        const raw = node.textContent || '';
        if (raw.length > 160 || !instruction.test(raw.replace(/\s+/gu, '')) || !visible(node) || node.closest(content) || node.querySelector(content)) continue;
        const walker = node.ownerDocument.createTreeWalker(node, 4);
        let shown = '', text;
        while ((text = walker.nextNode())) if (visible(text.parentElement)) shown += text.textContent;
        if (!instruction.test(shown.replace(/\s+/gu, ''))) continue;
        fail('抖音要求图片拖拽安全验证；请手动完成验证后恢复', 'SECURITY_CHALLENGE');
      }
      // Inspect accessible frames only. Cross-origin verification frames are
      // identified by visible frame markers above, without reading their data.
      for (const frame of root.querySelectorAll('iframe')) {
        if (!visible(frame)) continue;
        try { if (frame.contentDocument) roots.push(frame.contentDocument); } catch {}
      }
    }
  };
  checkChallenge();
  const read = async (url) => {
    checkChallenge();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let challengeError, poll, observer;
    let rejectChallenge;
    const challenge = new Promise((_, reject) => { rejectChallenge = reject; });
    const inspect = () => {
      if (challengeError) return;
      try { checkChallenge(); }
      catch (error) {
        challengeError = error;
        rejectChallenge(error);
        controller.abort();
      }
    };
    try {
      // A challenge may appear while fetch or response.json is still pending.
      // Race both stages, so even a stalled response cannot hide the dialog.
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class','style','hidden','aria-hidden','src','title'] });
      poll = setInterval(inspect, 250);
      let response;
      try { response = await Promise.race([fetch(url, { credentials: 'include', signal: controller.signal }), challenge]); }
      catch {
        if (challengeError) throw challengeError;
        checkChallenge();
        fail('抖音请求失败或超时；请检查登录和网络');
      }
      checkChallenge();
      if (!response.ok) fail(`抖音请求失败（HTTP ${response.status}）`);
      let payload;
      try { payload = await Promise.race([response.json(), challenge]); }
      catch {
        if (challengeError) throw challengeError;
        checkChallenge();
        fail(controller.signal.aborted ? '抖音响应读取超时' : '抖音未返回有效 JSON，可能需要验证');
      }
      checkChallenge();
      if (payload?.verify || payload?.verify_info || payload?.captcha) fail('抖音要求安全验证', 'SECURITY_CHALLENGE');
      if (payload?.status_code !== 0) fail(`抖音拒绝请求：${normalize(payload?.status_msg || payload?.status_code || '缺少状态码')}`);
      return payload;
    } finally { clearTimeout(timer); clearInterval(poll); observer?.disconnect(); }
  };
  const verifyVideo = () => {
      const actualId = location.pathname.match(/^\/video\/(\d+)\/?$/u)?.[1];
      const modalId = new URL(location.href).searchParams.get('modal_id');
      const playerIds = all('[data-e2e="feed-active-video"][data-aweme-id],[data-e2e="feed-active-video"][data-video-id]')
        .map((node) => node.getAttribute('data-aweme-id') || node.getAttribute('data-video-id'));
      // The live detail page also stamps the open video id on detail-video-info.
      // When it is present it must agree with the URL and the queue item.
      const detailIds = all('[data-e2e="detail-video-info"][data-e2e-aweme-id],[data-e2e="detail-video-info"][data-aweme-id]')
        .map((node) => node.getAttribute('data-e2e-aweme-id') || node.getAttribute('data-aweme-id'))
        .filter(Boolean);
      if (!/^\d+$/u.test(String(input.videoId || '')) || actualId !== String(input.videoId || '') || (modalId && modalId !== String(input.videoId || '')) ||
          playerIds.some((id) => id !== String(input.videoId || '')) ||
          (detailIds.length === 1 && detailIds[0] !== String(input.videoId || ''))) fail('当前页面不是待发送的视频，已停止发送');
    };
  const unavailableVideo = () => {
    verifyVideo();
    checkChallenge();
    const labels = new Map([
      ['你要观看的视频不存在', 'not-found'], ['视频不存在', 'not-found'], ['该视频不存在', 'not-found'],
      ['作品已删除', 'deleted'], ['该作品已删除', 'deleted'], ['视频已删除', 'deleted'], ['该视频已被删除', 'deleted'],
      ['作品已下架', 'removed'], ['该作品已下架', 'removed'], ['视频已下架', 'removed'], ['该视频已下架', 'removed'],
      ['该视频因违规无法播放', 'restricted'], ['作品因违规无法播放', 'restricted'], ['该作品因违规已被封禁', 'restricted']
    ]);
    const content = '[data-e2e*="desc"],[data-e2e*="title"],[data-e2e*="comment"],[data-e2e*="recommend"],[data-e2e*="share"],'+
      '[class*="comment"],[class*="Comment"],[class*="caption"],[class*="Caption"],[class*="description"],'+
      'aside,nav,a,[role="dialog"],textarea,input,[contenteditable="true"]';
    const errorZone = '[data-e2e*="error"],[class*="error"],[class*="Error"],[class*="not-found"],[class*="notFound"],[role="alert"]';
    const hasPlayer = all('video,[data-e2e="detail-video-info"],[data-e2e="feed-active-video"]').length > 0;
    for (const node of all('div,span,p,h1,h2,h3,strong')) {
      if (node.closest(content) || node.querySelector('script,style')) continue;
      const text = normalize(node.textContent).replace(/[。！!]+$/u, '');
      const reason = labels.get(text);
      if (!reason || (!node.closest(errorZone) && hasPlayer)) continue;
      // Match a standalone page error, never an ancestor containing a caption.
      if ([...node.children].some(child => normalize(child.textContent).replace(/[。！!]+$/u, '') === text)) continue;
      const error = new Error('视频已失效：' + text);
      error.code = 'VIDEO_UNAVAILABLE';
      error.details = { videoId: String(input.videoId), reason, evidence: 'visible-error' };
      throw error;
    }
    return { unavailable: false, videoId: String(input.videoId) };
  };
  if (input.action === 'videoStatus') return unavailableVideo();
  if (input.action === 'probe') {
    const payload = await read('/aweme/v1/web/user/profile/self/?aid=6383&device_platform=webapp');
    const user = payload.user;
    if (!user || !String(user.uid || '').match(/^\d+$/u) || !user.sec_uid) fail('未确认抖音登录账号，请先登录专用账号');
    return { id: String(user.uid), name: String(user.nickname || ''), secUid: String(user.sec_uid) };
  }
  if (input.action === 'search') {
    const query = normalize(input.query);
    if (!query || query.length > 200) fail('检索词不能为空且不能超过 200 字');
    if (!location.pathname.startsWith('/search/')) fail('请先打开对应抖音搜索页');
    const maxPages = Math.max(1, Math.min(10, Math.floor(Number(input.maxPages) || 3)));
    // The platform's own time filter was pinned to "one day", which silently
    // capped every scan no matter what window the user configured. Follow the
    // window, and keep the local exact filter as the real authority.
    const windowMinutes = Math.max(1, Math.min(43200, Math.floor(Number(input.windowMinutes) || 60)));
    const publishTime = windowMinutes <= 1440 ? '1' : windowMinutes <= 10080 ? '7' : windowMinutes <= 259200 ? '182' : '0';
    const startedAt = Date.now();
    const validatePage = (payload, offset) => {
      checkChallenge();
      if (payload?.verify || payload?.verify_info || payload?.captcha) fail('抖音要求安全验证', 'SECURITY_CHALLENGE');
      if (payload?.status_code !== 0 || !Array.isArray(payload.data) || ![0, 1, false, true].includes(payload.has_more)) {
        fail('抖音搜索响应结构不受支持，已暂停以免漏检');
      }
      const hasMore = Boolean(payload.has_more);
      const next = Number(payload.cursor ?? payload.offset);
      const searchId = String(payload.search_id || payload.log_pb?.impr_id || '');
      if (hasMore && (!Number.isSafeInteger(next) || next <= offset)) fail('搜索分页游标缺失或未前进，已暂停');
      if (hasMore && !searchId) fail('搜索分页缺少 search_id，已暂停');
      return { hasMore, next, searchId };
    };
    const directSearch = async () => {
      let offset = 0, searchId = '', hasMore = false;
      const payloads = [];
      for (let page = 0; page < maxPages; page++) {
        checkChallenge();
        const params = new URLSearchParams({ device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
          pc_client_type: '1', keyword: query, search_channel: 'aweme_video_web', offset: String(offset),
          count: '20', sort_type: '2', publish_time: publishTime, search_source: 'tab_search',
          query_correct_type: '1', is_filter_search: '1', need_filter_settings: page === 0 ? '1' : '0' });
        if (searchId) params.set('search_id', searchId);
        const payload = await read(`/aweme/v1/web/search/item/?${params}`);
        const pageInfo = validatePage(payload, offset);
        payloads.push(payload);
        hasMore = pageInfo.hasMore;
        if (!hasMore) break;
        offset = pageInfo.next;
        searchId = pageInfo.searchId;
      }
      return { payloads, truncated: hasMore };
    };
    const tapPages = () => {
      const records = window.__DY_SENTINEL_SEARCH__;
      if (!Array.isArray(records)) return [];
      return records.flatMap((entry) => {
        if (!entry || !Number.isFinite(entry.at) || entry.at < startedAt - 30000 ||
          (entry.at < startedAt && entry.at < Date.now() - 30000) || entry.at > Date.now() + 1000) return [];
        let url;
        try { url = new URL(entry.url, location.href); } catch { return []; }
        if (url.origin !== location.origin || !['/aweme/v1/web/search/item/', '/aweme/v1/web/general/search/', '/aweme/v1/web/general/search/single/'].includes(url.pathname) ||
            normalize(url.searchParams.get('keyword')) !== query) return [];
        let sort = url.searchParams.get('sort_type');
        if (!sort && url.searchParams.has('filter_selected')) {
          try { sort = JSON.parse(url.searchParams.get('filter_selected')).sort_type; } catch { return []; }
        }
        const offset = Number(url.searchParams.get('offset') || 0);
        if (String(sort) !== '2' || !Number.isSafeInteger(offset) || offset < 0 || entry.payload?.status_code !== 0) return [];
        return [{ ...entry, url, offset }];
      });
    };
    const exactControl = (pattern) => {
      // Responsive toolbars can wrap a label in several spans plus an icon.
      // Match the complete label, then choose the smallest unique region;
      // rejecting all non-leaf spans/divs misses those real controls.
      const candidates = [...document.querySelectorAll('button,[role="button"],[role="option"],[role="radio"],label,a,summary,span,div')].filter((node) =>
        (pattern.test(normalize(node.getAttribute('aria-label'))) || pattern.test(normalize(node.textContent))) && visible(node) &&
        !node.disabled && node.getAttribute('aria-disabled') !== 'true');
      const smallest = candidates.filter((node) => !candidates.some((other) => other !== node && node.contains(other)));
      return smallest.length === 1 ? smallest[0] : null;
    };
    const clickExact = (pattern) => {
      const target = exactControl(pattern);
      if (!target) return false;
      target.click();
      return true;
    };
    const nativeSearch = async () => {
      if (!Array.isArray(window.__DY_SENTINEL_SEARCH__)) fail('未安装原生搜索响应监听，请重新加载抖音页面');
      let first = tapPages().filter((entry) => entry.offset === 0).sort((a, b) => b.at - a.at)[0];
      if (!first) {
        let opener = null, hoverRound = -1, clicked = false, selected = false;
        for (let i = 0; i < 12; i++) {
          checkChallenge();
          first = tapPages().filter((entry) => entry.offset === 0).sort((a, b) => b.at - a.at)[0];
          if (first) break;
          if (clickExact(/^最新发布$/u)) { selected = true; break; }
          const target = exactControl(/^(筛选|排序|排序方式)$/u);
          if (target && target !== opener) {
            opener = target; hoverRound = i;
            for (const type of ['pointerover','mouseover','mouseenter']) {
              target.dispatchEvent(new MouseEvent(type,{bubbles:type!=='mouseenter',view:window}));
            }
          } else if (target && !clicked && i - hoverRound >= 2) {
            // Hover menus must not be clicked shut. Give them two samples to
            // open first, then click once for a click-driven toolbar.
            target.click(); clicked = true;
          }
          await wait();
        }
        if (!first && !selected) {
          const size = `${innerWidth}×${innerHeight}`;
          fail(opener ? `原生筛选面板未出现“最新发布”选项（视口 ${size}）；请将抖音工作窗口最大化后重试` :
            `无法识别原生“最新发布”筛选控件（视口 ${size}）；请将抖音工作窗口最大化，刷新页面后重试`);
        }
        for (let i = 0; !first && i < 32; i++) {
          await wait(); checkChallenge();
          first = tapPages().filter((entry) => entry.offset === 0 && entry.at >= startedAt).sort((a, b) => b.at - a.at)[0];
          if (first) break;
        }
      }
      if (!first) fail('未捕获到当前关键词的最新发布搜索响应，无法确认排序');
      const payloads = [];
      let entry = first;
      for (let page = 0; page < maxPages; page++) {
        const info = validatePage(entry.payload, entry.offset);
        payloads.push(entry.payload);
        if (!info.hasMore) return { payloads, truncated: false, source: 'native' };
        if (page === maxPages - 1) return { payloads, truncated: true, source: 'native' };
        const matchingNext = () => tapPages().filter((item) => item.at >= first.at && item.offset === info.next &&
          item.url.searchParams.get('search_id') === info.searchId).sort((a, b) => b.at - a.at)[0];
        let next = matchingNext();
        if (!next) {
          const resultItems = all('[data-e2e="search-result-item"],[data-e2e="search-result-list"],[data-e2e="search-result-container"]');
          const last = resultItems[resultItems.length - 1];
          let scroller = last;
          while (scroller && scroller !== document.body &&
            !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/u.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          scroller = scroller && scroller !== document.body ? scroller : document.scrollingElement;
          if (!scroller) return { payloads, truncated: true, source: 'native' };
          if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
          else scroller.scrollTop = scroller.scrollHeight;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          for (let i = 0; i < 24; i++) {
            await wait(); checkChallenge();
            next = matchingNext();
            if (next) break;
          }
        }
        if (!next) return { payloads, truncated: true, source: 'native' };
        entry = next;
      }
      return { payloads, truncated: true, source: 'native' };
    };
    try { return await directSearch(); }
    catch (directError) {
      checkChallenge();
      if (directError.code === 'SECURITY_CHALLENGE' || /安全验证|验证码|HTTP 429/u.test(String(directError.message))) throw directError;
      // Prefer an explicit failure over silently using unsorted, stale, or
      // unrelated page results. This is UI fallback, never a signer bypass.
      if (!Array.isArray(window.__DY_SENTINEL_SEARCH__)) throw directError;
      try { return await nativeSearch(); }
      catch (nativeError) {
        if (nativeError.code === 'SECURITY_CHALLENGE') throw nativeError;
        fail(`${directError.message}；原生搜索也未确认：${nativeError.message}`);
      }
    }
  }
  const HEADING = /^(分享给朋友|分享给好友|发送给朋友|发送给好友)$/u;
  const isHeading = (node) => !node.children.length && HEADING.test(normalize(node.textContent));
  const avatarKey = (source) => {
    try {
      const url = new URL(source, location.href);
      if (url.protocol !== 'https:') return '';
      return decodeURIComponent(url.pathname).replace(/(?:~|@).*/u, '');
    } catch { return ''; }
  };
  // The live share list renders a flame/badge image beside every avatar. A badge
  // is neither an identity nor a name, so it can never be used as either.
  const isBadge = (src) => /streak|flame|bytednsdoc\.com|\/obj\/|\.svg(?:[?#]|$)/iu.test(src);
  const resolveSrc = (img) => {
    const raw = String(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '').trim();
    if (!raw) return '';
    try { return new URL(raw, location.href).href; } catch { return ''; }
  };
  const avatarImage = (node) => {
    const images = [...node.querySelectorAll('img')].map((img) => ({ img, src: resolveSrc(img) }))
      .filter(({ src }) => /^https:\/\//u.test(src) && !isBadge(src));
    const preferred = images.filter(({ src }) => /avatar|aweme_im/iu.test(src));
    const pick = (preferred.length ? preferred : images)[0];
    if (!pick) return null;
    const key = avatarKey(pick.src);
    if (!key || key === '/' || key.length > 2000) return null;
    return { img: pick.img, src: pick.src, key };
  };
  const STATUS_TEXT = /^(在线|离开|忙碌|离线|互相关注|朋友|关注|已关注|发送|分享|已发送|已分享|选择|已选择|取消|搜索|搜索好友|搜索朋友|当前在线|不在线|(?:刚刚|今天|昨天|前天|最近|近期|本周|本月|\d+\s*(?:秒|分钟|小时|天|周|个月)前)(?:在线|活跃|来过))$/u;
  const nameOf = (row, uidControl) => {
    const identity = row.querySelector('[data-e2e="share-friend-name"],[data-e2e="user-name"],[data-e2e="user-title"]');
    if (identity) {
      const text = normalize(identity.getAttribute('title') || identity.textContent);
      if (text) return [text];
    }
    // Observed UID rows have three cells: avatar, metadata, share action. The
    // metadata's first line is the nickname plus optional flame decoration;
    // its later lines are activity/status. Do not flatten these separate UI
    // fields into competing names, or a subtitle drops the entire friend.
    // Use this only inside the confirmed single-UID row layout. Legacy rows
    // and unrecognized structures retain the ambiguity checks below.
    if (uidControl) {
      const cells = [...row.children];
      if (cells.length === 3 && cells[2].contains(uidControl)) {
        const avatarSlot = cells[0];
        const avatarLike = avatarSlot.matches('img') || avatarSlot.querySelector('img') ||
          (!avatarSlot.children.length && !normalize(avatarSlot.textContent));
        const metadata = cells[1];
        const line = metadata.matches('span,a,p') ? metadata : metadata.firstElementChild;
        if (avatarLike && line && visible(line)) {
          const isInline = (node) => node.matches('span,a,p') &&
            [...node.querySelectorAll('*')].every((child) => /^(SPAN|A|IMG|EM|STRONG|B|I|BR)$/u.test(child.tagName));
          const labels = isInline(line) || !line.children.length ? [line] : [...line.children].filter((node) => visible(node) && isInline(node));
          const separatedNameLine = line.matches('div') && [...line.children].some((node) => node.matches('span,a,p'));
          const knownSecondary = [...metadata.children].filter((node) => node !== line).every((node) =>
            !normalize(node.textContent) || STATUS_TEXT.test(normalize(node.textContent)) || node.matches('[role="status"],[data-e2e*="status"]'));
          const decorationOnly = (node) => !normalize(node.textContent) || /^\d+$/u.test(normalize(node.textContent)) ||
            [...node.querySelectorAll('img')].some((image) => isBadge(resolveSrc(image)));
          if ((line === metadata || separatedNameLine || knownSecondary) && labels.length === 1 &&
            (labels[0] === line || [...line.children].every((node) => node === labels[0] || decorationOnly(node)))) {
            const name = normalize(labels[0].getAttribute('title') || labels[0].textContent);
            if (name && name.length <= 200) return [name];
          }
        }
      }
    }
    // A nickname can contain nested spans or an emoji image. Read its outer
    // inline element once instead of treating each text fragment as a person.
    const candidates = [...row.querySelectorAll('span,p,div,a')].filter((node) =>
      visible(node) && !node.closest('[data-userid],button,[role="button"],input,[role="checkbox"]') &&
      (!node.children.length || (/^(SPAN|P|A)$/u.test(node.tagName) &&
        [...node.querySelectorAll('*')].every((child) => /^(SPAN|A|IMG|EM|STRONG|B|I|BR)$/u.test(child.tagName)))));
    return [...new Set(candidates
      .filter((node) => !candidates.some((other) => other !== node && other.contains(node)))
      .map((node) => normalize(node.getAttribute('title') || node.textContent))
      .filter((text) => text && text.length <= 200 && !STATUS_TEXT.test(text) && !/^\d+$/u.test(text) && !HEADING.test(text)))];
  };
  // Chrome's own input pipeline needs viewport CSS pixels, so every trusted
  // click is addressed by the centre of the node it is meant to hit.
  const pointOf = (node) => {
    const rect = node.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (!(rect.width > 0 && rect.height > 0) || x < 1 || y < 1 || x > innerWidth - 2 || y > innerHeight - 2) {
      fail('目标控件不在可视区域，无法用真实指针操作；请让视频页面保持正常窗口尺寸');
    }
    return { x, y };
  };
  // The live detail page keeps the popover inside video-share-container and
  // virtualizes the "分享给朋友" heading away after a search. The panel is
  // therefore anchored by its search box or its friend rows as well, and is
  // never inferred from ordinary page content.
  const panel = () => {
    const candidates = new Set();
    const consider = (node) => {
      if (!node || node === document.body || node === document.documentElement || !visible(node)) return;
      if (!node.querySelector('[data-userid]') && !avatarImage(node)) return;
      const anchored = node.querySelector('input') ||
        node.matches('[data-e2e="video-share-container"],[data-e2e*="share-panel"],[data-e2e*="share-dialog"],[role="dialog"]') ||
        [...node.querySelectorAll('div,span,p,h1,h2,h3,h4')].some(isHeading);
      if (anchored) candidates.add(node);
    };
    for (const node of all('[data-e2e="video-share-container"],[data-e2e*="share-panel"],[data-e2e*="share-dialog"],[data-e2e*="share-friend"],[role="dialog"]')) consider(node);
    for (const heading of document.querySelectorAll('div,span,p,h1,h2,h3,h4')) {
      if (!isHeading(heading) || !visible(heading)) continue;
      for (let node = heading.parentElement, i = 0; node && node !== document.body && i < 8; i++, node = node.parentElement) {
        if (node.querySelector('input') || node.querySelector('[data-userid]')) consider(node);
      }
    }
    const unique = [...candidates];
    // Prefer the region that owns both the search box and the friend rows; the
    // virtualized list alone loses the search box, the whole popover adds the
    // copy-link bar. Neither is allowed to become the sending scope.
    const complete = unique.filter((node) => node.querySelector('input') &&
      (node.querySelector('[data-userid]') || avatarImage(node)));
    const pool = complete.length ? complete : unique;
    const smallest = pool.filter((node) => !pool.some((other) => other !== node && node.contains(other)));
    if (smallest.length !== 1) fail('未能唯一识别原生分享好友面板，请把鼠标移到视频分享箭头展开面板后重试',smallest.length?'SHARE_PANEL_AMBIGUOUS':'SHARE_PANEL_EMPTY');
    return smallest[0];
  };
  const friendPanel = () => {
    const scoped = panel();
    const popover = scoped.closest('[data-e2e="video-share-container"],[data-e2e*="share-dialog"],[role="dialog"]');
    return popover && visible(popover) ? popover : scoped;
  };
  if (input.action === 'openShare') {
    if (input.videoId) unavailableVideo();
    if (!input.reopen) {
      try { panel(); return { opened: true, via: 'already-open' }; }
      catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* Open a closed panel. */ }
    }
    const activePlayers = all('[data-e2e="feed-active-video"]');
    const shareControls = (root) => {
      const visible = (node) => [...node.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
      // Observed detail-page DOM can have a zero-area video-player-share
      // wrapper beside the actual visible icon. Prefer the unique icon itself.
      const icons = all('[data-e2e="video-share-icon-container"]', root).filter(visible);
      if (icons.length) return icons;
      const legacy = all('[data-e2e="video-player-share"]', root).filter(visible);
      if (legacy.length) return legacy;
      return all('button,[role="button"]', root).filter(visible).filter((node) =>
        /^(分享|分享视频)$/u.test(normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent)));
    };
    // A modal opened from the feed can sit outside feed-active-video, so the
    // scoped lookup falls back to the whole page instead of refusing.
    let buttons = activePlayers.length === 1 ? shareControls(activePlayers[0]) : shareControls(document);
    if (!buttons.length && activePlayers.length === 1) buttons = shareControls(document);
    if (buttons.length !== 1) fail('无法唯一识别当前视频的分享按钮（找到 ' + buttons.length + ' 个，播放器 ' + activePlayers.length + ' 个）；请先点开具体视频再试',
      buttons.length === 0 ? 'SHARE_ENTRY_MISSING' : 'SHARE_ENTRY_AMBIGUOUS');
    // The wrapper also contains the popover and the share count, so its centre
    // is not the arrow. Prefer the icon node itself for the pointer target.
    const wrapper = buttons[0];
    const popover = wrapper.querySelector('[data-e2e="video-share-container"]');
    const svg = [...wrapper.querySelectorAll('svg')].filter((node) => visible(node))[0];
    const inner = [...wrapper.children].filter((node) => node !== popover && !node.contains(popover) &&
      !/^\d+$/u.test(normalize(node.textContent)) && visible(node));
    const target = (svg && (svg.closest('[tabindex],button,[role="button"]') || svg)) || inner[0] || wrapper;
    // The caller owns a trusted pointer: hand back the hover point at once and
    // let Chrome's input pipeline open the popover, which DOM events cannot do.
    if (input.pointer) {
      // React attaches enter/leave per element, so events dispatched on the
      // wrapper never reach the arrow's own handler. Fire them on the arrow too.
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter', cancelable: true, view: window }));
      }
      const point = pointOf(target);
      return { opened: false, needsPointer: true, x: point.x, y: point.y };
    }
    // The live detail page opens this popover from a hover, and a synthetic
    // click toggles it shut again. Try a real hover sequence first, then one
    // click, and never click a panel that already opened.
    for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: type !== 'mouseenter', cancelable: true, view: window }));
    }
    for (let i = 0; i < 8; i++) {
      checkChallenge();
      try { panel(); return { opened: true, via: 'hover' }; } catch { await wait(); }
    }
    target.click();
    for (let i = 0; i < 12; i++) {
      checkChallenge();
      try { panel(); return { opened: true, via: 'click' }; } catch { await wait(); }
    }
    // A popover driven by real hover state never opens for DOM events. Return
    // the point so the caller can retry with the browser's own pointer.
    const point = pointOf(target);
    return { opened: false, needsPointer: true, x: point.x, y: point.y };
  }
  const listFriends = (root, rejected) => {
    const results = [];
    const seenRows = new Set();
    // The live share row is <div class=row><img avatar><span name><div data-userid>分享</div></div>.
    // The numeric data-userid is the only stable identity here, so it outranks
    // every avatar/name heuristic and is always kept as a string.
    for (const control of all('[data-userid]', root)) {
      const uid = normalize(control.getAttribute('data-userid'));
      if (!/^\d{4,25}$/u.test(uid)) { rejected?.push({ uid, reason: 'invalid-uid' }); continue; }
      // The share control may have its own action wrappers. Walk up only while
      // this remains a single-UID scope, stopping at the first named row. Never
      // borrow a name from a neighbouring friend's row.
      let row = control.parentElement;
      let names = [], reason = 'name-missing';
      const shape = [];
      while (row && row !== root) {
        if (row.querySelectorAll('[data-userid]').length !== 1) break;
        names = nameOf(row, control);
        if (shape.length < 5) shape.push({ tag: row.tagName, children: row.children.length, nameCandidates: names.length });
        if (names.length === 1) break;
        if (names.length > 1) { reason = 'name-ambiguous'; break; }
        row = row.parentElement;
      }
      if (!row || row === root || names.length !== 1) { rejected?.push({ uid, reason, shape }); continue; }
      if (seenRows.has(row)) continue;
      // A uid row is identified by its numeric id alone: avatars are often lazy
      // loaded (or never loaded in a background window) and must not decide it.
      const avatar = avatarImage(row);
      seenRows.add(row);
      results.push({ row, friend: { id: `uid:${uid}`, uid, name: names[0], avatar: avatar?.src || '', avatarKey: avatar?.key || '' } });
    }
    for (const image of all('img', root)) {
      const source = String(image.currentSrc || image.src || '');
      if (!/^https:\/\//u.test(source) || isBadge(source)) continue;
      let row = image.closest('li,[role="option"],[data-e2e="share-friend-item"],[data-e2e="share-user-item"]');
      if (row && !root.contains(row)) row = null;
      if (!row) {
        let current = image.parentElement;
        for (let depth = 0; current && current !== root && depth < 5; depth++, current = current.parentElement) {
          if (current.querySelectorAll('img').length === 1 &&
            current.querySelector('button,[role="button"],input[type="checkbox"],[role="checkbox"]') &&
            normalize(current.textContent).replace(/已发送|发送|分享|已选择|选择/gu, '').trim()) { row = current; break; }
        }
      }
      if (!row || row === root || seenRows.has(row) || row.querySelector('[data-userid]') || row.querySelectorAll('img').length !== 1) continue;
      seenRows.add(row);
      const avatar = avatarImage(row);
      const names = nameOf(row);
      if (!avatar || names.length !== 1 || names[0].length > 200) continue;
      const name = names[0];
      const link = row.querySelector('a[href*="/user/"]');
      const profileUrl = link ? new URL(link.href, location.href) : null;
      const secUid = profileUrl?.origin === location.origin ? profileUrl.pathname.match(/^\/user\/([^/]+)\/?$/u)?.[1] : undefined;
      results.push({ row, friend: { id: secUid ? `sec:${secUid}` : `avatar:${encodeURIComponent(name)}:${encodeURIComponent(avatar.key)}`, name, avatar: avatar.src, avatarKey: avatar.key,
        ...(secUid ? { secUid } : {}) } });
    }
    const avatarCounts = new Map();
    for (const { friend } of results) avatarCounts.set(friend.avatarKey, (avatarCounts.get(friend.avatarKey) || 0) + 1);
    for (const entry of results) {
      // A bound UID cannot become ambiguous. Fallback identities still need a
      // non-generic, non-repeated avatar to be usable at all.
      entry.unsafeAvatar = !entry.friend.uid && !entry.friend.secUid && (avatarCounts.get(entry.friend.avatarKey) > 1 ||
        /default|placeholder|anonymous|no[_-]?avatar/iu.test(entry.friend.avatarKey));
    }
    return results;
  };
  // The popover virtualizes its rows: only the visible slice exists in the DOM,
  // so a single read can never see the whole friend list. The scroll target must
  // be the list's own box, found from a friend row upwards: scanning the whole
  // panel can otherwise pick a page-level scroller and scroll the video instead.
  const scrollerAround = (row, boundary) => {
    for (let node = row?.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      // overflow:hidden/overlay boxes still scroll programmatically and some
      // page versions clip the virtual list that way.
      if (/(?:auto|scroll|overlay|hidden)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight + 4) return node;
      if (node === boundary) break;
    }
    return null;
  };
  const clearFriendSearch = (root) => {
    const box = all('input', root).find((node) => /^(搜索|搜索好友|搜索朋友)$/u.test(normalize(node.placeholder || node.getAttribute('aria-label'))));
    if (!box || !box.value) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(box, '');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  if (input.action === 'friends') {
    // A share popover can have a pinned first-screen section alongside its
    // search/list region. Enumeration includes the whole confirmed popover;
    // sending still uses its original, narrower scope and exact UID checks.
    let root = friendPanel();
    // A leftover search term hides everyone else; reading the list starts clean.
    let cleared = clearFriendSearch(root);
    if (cleared) { await wait(); root = friendPanel(); }
    // Rows can mount a moment after the popover itself.
    for (let i = 0; i < 12 && listFriends(root).length === 0; i++) {
      await wait();
      try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* keep the last root */ }
    }
    const byId = new Map();
    let ambiguous = false;
    const observedUids = new Set(), recognizedUids = new Set(), rejectedUids = new Map();
    let firstScreen = null, snapshots = 0, stop = 'single-screen';
    const recordSnapshot = (entries, rejected, atTop) => {
      const controls = all('[data-userid]', root);
      for (const node of controls) observedUids.add(normalize(node.getAttribute('data-userid')));
      for (const item of rejected) if (!recognizedUids.has(item.uid)) rejectedUids.set(item.uid, item);
      for (const { friend } of entries) if (friend.uid) { recognizedUids.add(friend.uid); rejectedUids.delete(friend.uid); }
      if (atTop) firstScreen = { controls: controls.length, recognized: entries.filter(({ friend }) => friend.uid).length, rejected: rejected.length };
      snapshots++;
    };
    const collect = (entries) => {
      const local = new Set();
      for (const entry of entries) {
        // Two rows sharing one identity inside the same snapshot are ambiguous,
        // while scrolling legitimately re-reads rows it has already seen.
        if (local.has(entry.friend.id)) ambiguous = true;
        local.add(entry.friend.id);
        if (!byId.has(entry.friend.id)) byId.set(entry.friend.id, entry);
      }
    };
    let scroller = null;
    // A visible first row does not mean the first screen has finished mounting.
    // Sample until the mounted identities stop changing before moving away;
    // also discover a scroll box that only appears once more rows have loaded.
    const settle = async (rewind = false) => {
      let previous = '', quiet = 0;
      for (let sample = 0; sample < 12; sample++) {
        checkChallenge();
        try { root = friendPanel(); } catch { /* rows can recycle between samples */ }
        const rejected = [];
        const entries = listFriends(root, rejected);
        // A pinned friend may be outside the scrolling list. Inspect all rows
        // rather than letting that first row hide the real list's scroll box.
        const current = entries.map(({ row }) => scrollerAround(row, root)).find(Boolean);
        if (current) scroller = current;
        else if (scroller && (!scroller.isConnected || !root.contains(scroller))) scroller = null;
        // Reopening the panel can retain the previous scroll offset. Rewind
        // before collecting, including when a replacement box appears late.
        if (rewind && scroller && scroller.scrollTop !== 0) {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          previous = ''; quiet = 0;
          await wait();
          continue;
        }
        recordSnapshot(entries, rejected, rewind);
        collect(entries);
        const signature = JSON.stringify([entries.map(({ friend }) => [friend.id, friend.name]),
          scroller?.scrollTop, scroller?.scrollHeight, scroller?.clientHeight]);
        quiet = signature === previous ? quiet + 1 : 0;
        previous = signature;
        if (entries.length && quiet >= (rewind ? 3 : 2)) break;
        await wait();
      }
    };
    await settle(true);
    if (scroller) stop = 'scan-limit';
    for (let round = 0; scroller && round < 60 && byId.size < 500; round++) {
      checkChallenge();
      const top = scroller.scrollTop;
      // Keep overlapping slices even in a short viewport; a fixed minimum
      // larger than the viewport skips virtual rows permanently.
      const step = Math.max(1, Math.floor(scroller.clientHeight * 0.7));
      const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(bottom, top + step);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await settle();
      if (!scroller) { stop = 'scroll-box-lost'; break; }
      if (scroller.scrollTop === top && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) {
        stop = 'bottom'; break;
      }
    }
    const found = [...byId.values()];
    const rejectionCounts = {};
    for (const { reason } of rejectedUids.values()) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
    // Only counts and element shapes leave this function. No names, UID values,
    // URLs or raw DOM are written to diagnostic logs.
    const diagnostics = { revision: 'friends-v3', firstScreen, snapshots, stop,
      observed: observedUids.size, recognized: recognizedUids.size, unrecognized: rejectedUids.size,
      rejectionCounts, samples: [...rejectedUids.values()].slice(0, 3).map(({ reason, shape }) => ({ reason, shape: shape || [] })) };
    if (!found.length) fail(`分享面板已打开但没有可识别的好友行（发现 ${observedUids.size} 个 UID，跳过 ${rejectedUids.size} 个；${JSON.stringify(rejectionCounts)}）；请查看诊断后重试`);
    if (ambiguous) fail('好友身份重复，无法安全绑定；请缩小分享面板搜索范围');
    const seen = new Set();
    for (const { friend } of found) {
      if (seen.has(friend.id)) fail('好友身份重复，无法安全绑定；请缩小分享面板搜索范围');
      seen.add(friend.id);
    }
    const available = found.filter((entry) => !entry.unsafeAvatar).map(({ friend }) => friend);
    if (!available.length) fail('好友使用默认或重复头像且缺少稳定账号 ID，无法安全绑定');
    return input.diagnostics ? { friends: available, diagnostics } : available;
  }
  if (input.action === 'shareDebug') {
    // A failure at this step is invisible from outside the page, so capture the
    // facts that decide it: visibility, the hit test under the pointer, and
    // whether the popover actually mounted.
    const rectOf = (node) => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const info = {
      href: String(location.href).slice(0, 160), visibility: document.visibilityState, focused: document.hasFocus(),
      viewport: innerWidth + 'x' + innerHeight, scrollY: Math.round(scrollY), dpr: devicePixelRatio
    };
    try { info.panel = { found: true, rect: rectOf(panel()) }; info.rows = listFriends(panel()).length; }
    catch { info.panel = { found: false }; }
    const pop = document.querySelector('[data-e2e="video-share-container"]');
    info.popover = pop ? rectOf(pop) : null;
    info.userids = document.querySelectorAll('[data-userid]').length;
    const wrapper = all('[data-e2e="video-share-icon-container"]')[0];
    if (wrapper) {
      info.icon = rectOf(wrapper);
      const arrow = [...wrapper.children].find((node) => node.hasAttribute('tabindex') || node.querySelector('svg'));
      if (arrow) info.arrow = { ...rectOf(arrow), tabindex: arrow.getAttribute('tabindex') || '' };
    }
    if (input.point) {
      info.point = input.point;
      const hit = document.elementFromPoint(input.point.x, input.point.y);
      info.hit = hit ? { tag: hit.tagName, e2e: hit.getAttribute('data-e2e') || '', cls: String(hit.className).slice(0, 40) } : null;
    }
    return info;
  }
  if (input.action === 'share') {
    const videoId = String(input.videoId || '');
    const mode = ['probe', 'arm', 'confirm'].includes(input.mode) ? input.mode : 'click';
    verifyVideo();
    if (mode !== 'confirm') unavailableVideo();
    const recipient = input.recipient;
    const recipientUid = /^\d+$/u.test(String(recipient?.uid || '')) ? String(recipient.uid) : '';
    if (typeof recipient?.id === 'string' && recipient.id.startsWith('uid:') && recipient.id !== 'uid:' + recipientUid) {
      fail('好友 UID 与身份 ID 不一致，请重新绑定');
    }
    if (!recipient?.name || (!recipientUid && !recipient.secUid && !recipient.avatarKey)) fail('好友缺少稳定身份信息，请重新绑定');
    const text = (node) => normalize(node.textContent);
    // A bound numeric UID is authoritative: nickname and avatar can change, and
    // a failed UID match must never fall back to a different same-name friend.
    const matchFriend = (friend) => recipientUid ? friend.uid === recipientUid :
      recipient.secUid ? friend.secUid === recipient.secUid :
      friend.name === recipient.name && friend.avatarKey === recipient.avatarKey;
    const recipientRows = (scope) => {
      if (!recipientUid) return listFriends(scope).filter(({ friend }) => matchFriend(friend));
      // Binding already established the UID. A lazy/renamed nickname must not
      // make that exact control disappear from the sending path. Keep duplicate
      // controls as separate matches so ambiguity still blocks any click.
      return all('[data-userid]', scope).filter((control) => normalize(control.getAttribute('data-userid')) === recipientUid)
        .map((control) => {
          let row = control.parentElement;
          while (row && row !== scope && row.children.length < 2 && row.parentElement !== scope &&
            row.parentElement.querySelectorAll('[data-userid]').length === 1) row = row.parentElement;
          return row && row !== scope && row.querySelectorAll('[data-userid]').length === 1
            ? { row, friend: { id: 'uid:' + recipientUid, uid: recipientUid, name: recipient.name }, unsafeAvatar: false } : null;
        }).filter(Boolean);
    };
    const controls = (node, pattern) => {
      const nodes = [...node.querySelectorAll('[data-userid],button,[role="button"]')].filter((button) =>
        !button.querySelector('[data-userid]') && pattern.test(text(button)) &&
        !button.disabled && button.getAttribute('aria-disabled') !== 'true' && visible(button));
      return nodes.filter((button) => !nodes.some((other) => other !== button && button.contains(other)));
    };
    const rowSent = (row) => !!row && all('button,span,div,p,[role="status"]', row)
      .some((node) => node.children.length === 0 && /^(已发送|已分享)$/u.test(text(node)));
    const inComments = (node) => !!(node?.nodeType === 1 ? node : node?.parentElement)?.closest('[data-e2e*="comment" i],[class*="comment" i],[contenteditable="true"]');
    const successNodes = () => all('[role="status"],[role="alert"],[class*="toast"],[class*="message-notice"]')
      .filter((node) => !inComments(node))
      .filter((node) => /^(发送成功|分享成功|已发送|已分享|已发送给.+|已分享给.+)$/u.test(text(node)));
    const failureNodes = () => all('[role="alert"],[role="status"],[class*="toast"]')
      .filter((node) => !inComments(node))
      .filter((node) => /发送失败|分享失败|操作频繁|无法发送|账号异常|对方.*隐私/u.test(text(node)));

    if (mode === 'arm' || mode === 'confirm') {
      const slot = '__douyinWatchShareReceiptV10';
      const identity = recipientUid || recipient.id;
      if (mode === 'arm') {
        // This runs AFTER pointer movement and BEFORE mousePressed. A popover
        // may have closed or shifted since probe; never click its old position.
        const point = input.point;
        const changed = (reason, retryable = false, detail = {}) => {
          const labels = { 'invalid-point':'坐标无效', 'panel-closed':'分享面板关闭', 'target-missing':'好友行尚未挂载',
            'identity-ambiguous':'好友匹配不唯一', 'control-missing':'分享按钮尚未挂载', 'control-ambiguous':'分享按钮不唯一',
            'uid-mismatch':'接收人不一致', 'hit-mismatch':'鼠标落点已偏移', 'panel-ambiguous':'分享面板不唯一' };
          const error = new Error('分享控件在点击前发生变化（' + labels[reason] + '），尚未点击发送；请重试本条待发视频');
          error.code='SHARE_TARGET_CHANGED';error.retryable=retryable;error.details={reason,...detail};
          throw error;
        };
        if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) changed('invalid-point');
        let entries;
        try { entries = recipientRows(friendPanel()); }
        catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') changed('panel-ambiguous'); else changed('panel-closed',true); }
        if (entries.length !== 1) changed(entries.length ? 'identity-ambiguous' : 'target-missing', entries.length===0);
        const candidates = controls(entries[0].row, /^(发送|分享)$/u);
        if (candidates.length !== 1) changed(candidates.length ? 'control-ambiguous' : 'control-missing', candidates.length===0);
        const control = candidates[0];
        if (recipientUid && normalize(control.getAttribute('data-userid')) !== recipientUid) changed('uid-mismatch');
        const hit = document.elementFromPoint(point.x, point.y);
        if (!hit || (hit !== control && !control.contains(hit))) {
          const rect=control.getBoundingClientRect();
          changed('hit-mismatch',true,{point:{x:point.x,y:point.y},hitTag:hit?.tagName||null,targetRect:{x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)}});
        }
      }
      let session = globalThis[slot];
      if (mode === 'confirm' && input.receiptToken) {
        if (!session || session.token !== input.receiptToken || session.videoId !== videoId || session.identity !== identity) {
          fail('发送回执监听已失效或与本条任务不一致，请人工核对后恢复，系统不会自动重试');
        }
      } else {
        session?.dispose();
        const previousSuccess = new Set(successNodes());
        const SUCCESS_TEXT = /^(分享成功|发送成功|已发送给.+|已分享给.+|已发送|已分享)$/u;
        const receiptText = value => normalize(value).replace(/[\u200b-\u200d\u2060\ufeff]/gu, '');
        let successAppeared = false;
        const recordChanges = records => {
          for (const record of records) {
            if (inComments(record.target)) continue;
            const added = record.type === 'characterData' ? [record.target] : record.addedNodes;
            for (const node of added) {
              if (![1,3].includes(node.nodeType) || inComments(node)) continue;
              const nodes = node.nodeType === 1 ? [node, ...[...node.querySelectorAll('div,span,p')].slice(0, 64)] : [node];
              for (const candidate of nodes) {
                if (inComments(candidate)) continue;
                const value = receiptText(candidate.textContent);
                if (value && value.length <= 100 && SUCCESS_TEXT.test(value)) successAppeared = true;
              }
            }
          }
        };
        const observer = new MutationObserver(recordChanges);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        session = {
          token: globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random(),
          videoId, identity, startedAt: Date.now(), timer: null,
          readEvidence() {
            recordChanges(observer.takeRecords());
            const evidence = successNodes().filter(node => !previousSuccess.has(node));
            if (evidence.length) return { sent: true, evidence: text(evidence[0]).slice(0, 100) };
            if (successAppeared) return { sent: true, evidence: 'success-text' };
            try {
              const entries = recipientRows(friendPanel());
              if (entries.length === 1 && rowSent(entries[0].row)) return { sent: true, alreadySent: true };
            } catch { /* A closed popover alone is not a receipt. */ }
            return null;
          },
          dispose() {
            observer.disconnect();
            clearTimeout(this.timer);
            if (globalThis[slot] === this) delete globalThis[slot];
          }
        };
        globalThis[slot] = session;
        // Also release capture after navigation/dispatch failure prevents confirm.
        session.timer = setTimeout(() => session.dispose(), 30000);
      }
      if (mode === 'arm') return { armed: true, receiptToken: session.token };
      let closedAt = 0;
      const panelGone = () => { try { panel(); return false; } catch { return true; } };
      try {
        for (let i = 0; i < 24; i++) {
          checkChallenge();
          const evidence = session.readEvidence();
          if (evidence) return evidence;
          const bad = failureNodes();
          if (bad.length) fail('转发失败：' + text(bad[0]));
          if (i >= 2 && panelGone()) closedAt ||= Date.now() - session.startedAt;
          await wait();
        }
        checkChallenge();
        const lastEvidence = session.readEvidence();
        if (lastEvidence) return lastEvidence;
        const hints = [...new Set(failureNodes().map(node => text(node)))].slice(0, 5);
        fail('发送结果无法确认；请人工核对后恢复，系统不会自动重试' +
          (hints.length ? '（页面提示：' + hints.join(' / ').slice(0, 160) + '）' : '（未捕获明确的发送回执）') +
          (closedAt ? '（面板已关闭，' + closedAt + 'ms）' : ''));
      } finally { session.dispose(); }
    }

    let root;
    try { root = friendPanel(); }
    catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; fail('分享面板尚未展开或好友行尚未加载；尚未点击发送', 'SHARE_PANEL_EMPTY'); }
    const rowsReady = () => recipientUid ? all('[data-userid]', root).some((node) => /^\d{4,25}$/u.test(normalize(node.getAttribute('data-userid')))) : listFriends(root).length > 0;
    const noRows = () => fail(`分享面板未加载可识别的好友行（UID 控件 ${all('[data-userid]', root).length} 个，视口 ${innerWidth}×${innerHeight}，页面可见性 ${document.visibilityState}）；尚未点击发送`, 'SHARE_PANEL_EMPTY');
    // The popover can be mounted before its virtualized rows are. Without this
    // wait a slow render looks exactly like "friend not found".
    for (let i = 0; i < 12 && !rowsReady(); i++) {
      await wait();
      checkChallenge();
      try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* keep the last root */ }
    }
    // A background shell with no mounted friends is not a name-search failure.
    // Do not type into it; let the caller reopen it once before any send click.
    if (!rowsReady()) noRows();
    const match = () => recipientRows(root);
    const scanned = new Set();
    const noteSeen = () => {
      for (const { friend } of listFriends(root)) scanned.add(friend.id);
      for (const node of all('[data-userid]', root)) {
        const uid = normalize(node.getAttribute('data-userid'));
        if (/^\d{4,25}$/u.test(uid)) scanned.add('uid:' + uid);
      }
    };
    let matches = match();
    noteSeen();
    if (matches.length === 0) {
      if (root.querySelector('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')) {
        fail('分享面板已有选中好友，请先取消选择后重试');
      }
      // The live popover labels this box plain "搜索"; only a confirmed panel
      // root is ever searched, so no unrelated page input is touched.
      const searchInputs = all('input', root).filter((node) => /^(搜索|搜索好友|搜索朋友)$|搜索.*(?:朋友|好友)|(?:朋友|好友).*搜索/u.test(
        normalize(node.placeholder || node.getAttribute('aria-label'))));
      if (searchInputs.length === 1) {
        const searchInput = searchInputs[0];
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) fail('无法操作原生好友搜索框，请手动搜索后重试');
        setter.call(searchInput, recipient.name);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 12 && !matches.length; i++) {
          await wait();
          checkChallenge();
          try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* the popover may re-render */ }
          matches = match();
          noteSeen();
        }
        if (!matches.length) {
          // A renamed friend must not leave the list filtered to nothing.
          const liveInputs = all('input', root).filter((node) => /^(搜索|搜索好友|搜索朋友)$/u.test(normalize(node.placeholder || node.getAttribute('aria-label'))));
          const liveInput = liveInputs.length === 1 ? liveInputs[0] : searchInput;
          if (liveInput.isConnected) {
            setter.call(liveInput, '');
            liveInput.dispatchEvent(new Event('input', { bubbles: true }));
            liveInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await wait();
          try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* keep the last root */ }
          matches = match();
          noteSeen();
        }
      }
    }
    if (matches.length === 0) {
      // Rows are virtualized: a bound friend can exist without being mounted, so
      // walk the list's own scroll box until the bound UID shows up.
      const findScroller = () => [...listFriends(root).map(({ row }) => row),
        ...all('[data-userid]', root).map((node) => node.parentElement)]
        .map((row) => scrollerAround(row, root)).find(Boolean);
      let scroller = findScroller();
      // A previous recipient can leave the virtual list scrolled down. Search
      // from its top with overlapping slices, just like manual enumeration.
      if (scroller && scroller.scrollTop !== 0) {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait();checkChallenge();
        try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* recover below if rows disappeared */ }
        matches = match();noteSeen();
        if (!scroller.isConnected) scroller = findScroller();
      }
      for (let round = 0; scroller && round < 60 && matches.length === 0; round++) {
        checkChallenge();
        const top = scroller.scrollTop;
        const step = Math.max(1, Math.floor(scroller.clientHeight * 0.7));
        scroller.scrollTop = Math.min(Math.max(0, scroller.scrollHeight-scroller.clientHeight), top + step);
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        await wait();
        try { root = friendPanel(); } catch(error) { if(error.code==='SHARE_PANEL_AMBIGUOUS') throw error; /* rows recycle while scrolling */ }
        matches = match();
        noteSeen();
        if (!scroller.isConnected) scroller = findScroller();
        if (!scroller || (scroller.scrollTop === top && scroller.scrollTop >= scroller.scrollHeight-scroller.clientHeight-1)) break;
      }
    }
    if (matches.length !== 1 && !rowsReady()) {
      noRows();
    }
    if (matches.length !== 1) fail('找不到唯一匹配的好友（已扫描 ' + scanned.size + ' 位）；本条尚未点击发送，请核对原生分享面板中的目标好友',matches.length?'SHARE_RECIPIENT_AMBIGUOUS':'SHARE_RECIPIENT_MISSING');
    if (matches[0].unsafeAvatar) fail('好友头像为默认或重复头像，缺少稳定账号 ID，已停止发送');
    const { row } = matches[0];
    // The live per-friend control is a div[data-userid] labelled 分享, not a
    // button, so the row's own uid control is accepted here and nowhere else.
    if (rowSent(row)) return { sent: true, alreadySent: true, existingBeforeSend: true };
    const selected = [...root.querySelectorAll('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')];
    if (selected.some((node) => !row.contains(node))) fail('分享面板已有其他选中好友，请先取消选择');
    const send = controls(row, /^(发送|分享)$/u);
    checkChallenge();
    verifyVideo();

    if (mode === 'probe') {
      // Hand the exact on-screen point back to the browser's own input pipeline.
      // Nothing is clicked here: the caller performs the trusted click.
      if(send.length>1) fail('好友行有多个发送按钮，尚未发送','SHARE_CONTROL_AMBIGUOUS');
      if(!send.length) {
        const checkboxes=[...row.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(node=>!node.disabled&&node.getAttribute('aria-disabled')!=='true');
        if(checkboxes.length===1) return { fallback: true, reason: '使用原生单好友选择及确认控件' };
        fail('未找到好友行的转发按钮，尚未点击发送',checkboxes.length?'SHARE_CONTROL_AMBIGUOUS':'SHARE_CONTROL_MISSING');
      }
      const controlUid = normalize(send[0].getAttribute('data-userid'));
      if (controlUid && controlUid !== recipientUid) fail('分享按钮与目标好友的账号 ID 不一致，已停止发送');
      if (!controlUid && recipientUid) fail('分享控件缺少账号 ID，尚未点击发送','SHARE_CONTROL_MISSING');
      if (typeof send[0].scrollIntoView === 'function') send[0].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const point = pointOf(send[0]);
      return { prepared: true, x: point.x, y: point.y, uid: controlUid, name: matches[0].friend.name };
    }

    const previousSuccess = new Set(successNodes());
    let observedSuccess = false;
    const observer = new MutationObserver(() => {
      for (const node of successNodes()) if (!previousSuccess.has(node)) observedSuccess = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    try {
      // The popover can re-render between the search and the click. Accept a
      // stable ancestor, but never proceed once the target row left the panel.
      const livePanel = friendPanel();
      if (!row.isConnected || !livePanel.contains(row)) fail('分享面板已变化，请重新核对后重试');
      root = livePanel;
      if (send.length === 1) {
        const controlUid = normalize(send[0].getAttribute('data-userid'));
        if (controlUid && controlUid !== recipientUid) fail('分享按钮与目标好友的账号 ID 不一致，已停止发送');
        if (!controlUid && recipientUid && send[0].tagName === 'DIV') fail('分享按钮缺少账号 ID，无法确认接收人，已停止发送');
        send[0].click();
      } else {
        if (send.length > 1) fail('好友行有多个发送按钮，已停止');
        const checkboxes = [...row.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter((node) =>
          !node.disabled && node.getAttribute('aria-disabled') !== 'true');
        if (checkboxes.length !== 1) fail('此版本的好友选择控件尚不支持，未发送');
        const checkbox = checkboxes[0];
        if (!(checkbox.checked || checkbox.getAttribute('aria-checked') === 'true')) checkbox.click();
        const nowSelected = [...root.querySelectorAll('input[type="checkbox"]:checked,[role="checkbox"][aria-checked="true"]')];
        if (nowSelected.length !== 1 || !row.contains(nowSelected[0])) fail('无法确认唯一选择的好友，未发送');
        const confirms = controls(root, /^(发送|发送\s*[（(]1[）)]|分享)$/u)
          .filter((node) => !row.contains(node) && !node.hasAttribute('data-userid'));
        if (confirms.length !== 1) fail('无法唯一识别分享确认按钮，未发送');
        checkChallenge();
        verifyVideo();
        confirms[0].click();
      }
      for (let i = 0; i < 24; i++) {
        checkChallenge();
        if (rowSent(row) || observedSuccess || successNodes().some((node) => !previousSuccess.has(node))) return { sent: true };
        const failures = failureNodes();
        if (failures.length) fail('转发失败：' + text(failures[0]));
        await wait();
      }
      const hints = [...new Set(all('[role="status"],[role="alert"],[class*="toast"],[class*="notice"]')
        .map((node) => text(node)).filter(Boolean))].slice(0, 3);
      fail('发送结果无法确认；请人工核对后恢复，系统不会自动重试' + (hints.length ? '（页面提示：' + hints.join(' / ').slice(0, 200) + '）' : ''));
    } finally { observer.disconnect(); }
  }
  fail('未知浏览器操作');
  } catch (error) {
    // Chrome does not guarantee serialization of rejected promises from an
    // injected script. The extension opts in to a plain error envelope so the
    // pause notification retains the actual reason. Direct calls still throw.
    if (input?.captureErrors) return { error: String(error?.message || error || '浏览器操作失败'), ...(error?.code ? { code: error.code } : {}),
      ...(typeof error?.retryable==='boolean'?{retryable:error.retryable}:{}), ...(error?.details?{details:error.details}:{}) };
    throw error;
  }
}
