// Only local playback. This hidden page never operates Douyin or email.
const tone = new Audio(chrome.runtime.getURL('audio/alert-ding-dong.wav'));
tone.preload = 'auto';
tone.volume = 1;
const heard = new Set();
let serial = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'alert-player' || message.type !== 'PLAY_ALERT' || sender.id !== chrome.runtime.id ||
      typeof message.id !== 'string' || !message.id || message.id.length > 160) return false;
  const job = serial.then(async () => {
    if (heard.has(message.id)) return { ok: true, duplicate: true };
    tone.pause(); tone.currentTime = 0;
    await tone.play();
    heard.add(message.id);
    if (heard.size > 128) heard.delete(heard.values().next().value);
    return { ok: true };
  });
  serial = job.catch(() => {});
  job.then(respond).catch(() => respond({ ok: false }));
  return true;
});
