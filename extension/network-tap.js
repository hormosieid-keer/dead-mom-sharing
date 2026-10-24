// MAIN world, document_start. Passive search-response observation only.
// No cookies, request signing, IM endpoints, storage, or external communication.
(() => {
  if (location.origin !== 'https://www.douyin.com' || Array.isArray(window.__DY_SENTINEL_SEARCH__)) return;
  const entries = [];
  Object.defineProperty(window, '__DY_SENTINEL_SEARCH__', { value: entries, writable: false, configurable: false });
  const permitted = new Set(['keyword', 'sort_type', 'publish_time', 'filter_selected', 'offset', 'count', 'search_id', 'search_channel']);
  const searchUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      if (url.origin !== location.origin || !['/aweme/v1/web/search/item/', '/aweme/v1/web/general/search/', '/aweme/v1/web/general/search/single/'].includes(url.pathname)) return null;
      const clean = new URL(url.pathname, url.origin);
      for (const [key, value] of url.searchParams) if (permitted.has(key)) clean.searchParams.append(key, value);
      return clean.href;
    } catch { return null; }
  };
  const remember = (url, payload) => {
    if (!url || !payload || typeof payload !== 'object') return;
    try {
      // Bound both response count and size. Expire old search records so video
      // discovery cannot accidentally reuse a previous monitoring session.
      const serialized = JSON.stringify(payload);
      if (serialized.length > 2_000_000) return;
      const at = Date.now();
      entries.push({ at, url, payload: JSON.parse(serialized) });
      while (entries.length > 25 || (entries.length && entries[0].at < at - 180000)) entries.shift();
    } catch { /* Observation must never interrupt the page. */ }
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const url = searchUrl(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url);
      const result = originalFetch.apply(this, args);
      if (url) result.then((response) => {
        if (!response.ok) return;
        response.clone().json().then((payload) => remember(url, payload)).catch(() => {});
      }).catch(() => {});
      return result;
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    requests.set(this, searchUrl(args[1]));
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = requests.get(this);
    if (url) this.addEventListener('loadend', () => {
      if (this.status < 200 || this.status >= 300) return;
      try {
        const payload = this.responseType === 'json' ? this.response :
          (!this.responseType || this.responseType === 'text') ? JSON.parse(this.responseText) : null;
        remember(url, payload);
      } catch { /* Ignore non-JSON responses. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
