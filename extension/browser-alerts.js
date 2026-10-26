// A real incident owns one sound attempt across page/worker reloads. Email is
// separate. Browser API failures must never stop the queue's safety pause.
export function createBrowserAlerts(api, { read, claim, record }) {
  const playerPath = 'alert-player.html';
  let serial = Promise.resolve(), creating;
  async function bounded(job) {
    let timer;
    try { return await Promise.race([job(), new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('audio-timeout')),5000); })]); }
    finally { clearTimeout(timer); }
  }
  async function ensurePlayer() {
    if (!api.offscreen?.createDocument || !api.runtime.getContexts) throw new Error('browser-audio-unavailable');
    if (creating) return creating;
    creating = (async () => {
      const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [api.runtime.getURL(playerPath)] });
      if (!contexts.length) await api.offscreen.createDocument({ url: playerPath, reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play one local notification sound when a task pauses for a real incident.' });
    })();
    try { await creating; } finally { creating = null; }
  }
  async function play(id) {
    await ensurePlayer();
    const result = await api.runtime.sendMessage({ target: 'alert-player', type: 'PLAY_ALERT', id });
    if (!result?.ok) throw new Error('browser-audio-blocked');
  }
  async function badge(active) {
    try {
      await api.action.setBadgeBackgroundColor({ color: '#E3344E' });
      await api.action.setBadgeText({ text: active ? '!' : '' });
      await api.action.setTitle({ title: active ? '司凤转发：任务已暂停，需要处理' : '打开司凤转发（dead-mom sharing)' });
    } catch { /* The settings-page favicon still carries the incident. */ }
  }
  async function syncNow() {
    const state = await read();
    const id = state?.paused && (state.incident?.id || state.incident?.incidentId);
    await badge(!!id);
    if (!id || !await claim(id)) return;
    try {
      const played = await bounded(async () => {
        await ensurePlayer();
        const current = await read();
        if (!current?.paused || (current.incident?.id || current.incident?.incidentId) !== id) return false;
        await play(id);
        return true;
      });
      if (!played) return;
      await record(id, null);
    } catch {
      await record(id, '提示音未能播放；请点击“试听提示音”检查浏览器声音设置。红点和页面告警仍保留。');
    }
  }
  return {
    sync() {
      const job = serial.then(syncNow);
      serial = job.catch(() => {});
      return job.catch(() => {});
    },
    async preview() {
      try { await bounded(() => play('preview-' + crypto.randomUUID())); }
      catch { throw new Error('提示音未能播放，请检查浏览器或系统是否静音，以及是否允许声音播放。'); }
      return { played: true };
    }
  };
}
