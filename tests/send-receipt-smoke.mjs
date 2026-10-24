// Local HTML + actual adapter/CDP input; no real Douyin data or sending.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { browserTask } from '../extension/adapter.js';
import { Pointer } from '../extension/pointer.js';

const videoId = '739000000000000001';
const recipient = { id: 'uid:7000000000000000001', uid: '7000000000000000001', name: '测试好友' };
const secondRecipient = { id: 'uid:7000000000000000002', uid: '7000000000000000002', name: '第二位好友' };
const html = `<!doctype html><meta charset="utf-8"><style>
  #icon{position:absolute;left:100px;top:200px;width:42px;height:46px;background:#ccc}
  #arrow{width:42px;height:46px}
  #panel{display:none;position:absolute;left:42px;top:0;width:320px;height:150px;background:#eef}
  #icon:hover #panel{display:block}.row{display:flex;align-items:center;gap:16px;height:50px}
  img{width:26px;height:26px}[data-userid]{padding:8px;background:#ddd}
  </style><div data-e2e="video-share-icon-container" id="icon"><div id="arrow" tabindex="0">分享</div>
  <div data-e2e="video-share-container" id="panel"><input placeholder="搜索">
  <div class="row"><img src="https://fixture.test/avatar.jpg"><div><span>测试好友</span></div><div data-userid="7000000000000000001"><span>分享</span></div></div>
  <div class="row"><img src="https://fixture.test/second-avatar.jpg"><div><span>第二位好友</span></div><div data-userid="7000000000000000002"><span>分享</span></div></div></div></div>
  <script>window.sends=0;window.sentUids=[];
  document.querySelector('#arrow').addEventListener('mouseenter',()=>{document.querySelector('#panel').style.display='';});
  document.querySelectorAll('[data-userid]').forEach(control=>control.addEventListener('click',()=>{
    sends++;sentUids.push(control.getAttribute('data-userid'));const receipt=document.createElement('div');receipt.textContent='分享成功';
    document.body.append(receipt);queueMicrotask(()=>receipt.remove());
    document.querySelector('#panel').style.display='none';
  }));</script>`;
const browser = await chromium.launch({ headless: true, channel: 'chromium', executablePath: process.env.BOT_TEST_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`https://www.douyin.com/video/${videoId}`);
  const cdp = await page.context().newCDPSession(page);
  globalThis.chrome = { debugger: { attach: async () => {}, detach: async () => {},
    sendCommand: async (target, method, params) => cdp.send(method, params) } };
  const pointer = new Pointer(1);
  const task = input => page.evaluate(({ source, input }) => (0, eval)(`(${source})`)(input), { source: browserTask.toString(), input });
  const prepare = async (targetRecipient = recipient) => {
    const open = await task({ action: 'openShare', pointer: true });
    if (!open.opened) await pointer.hover(open.x, open.y, { leaveFirst: true });
    const target = await task({ action: 'share', mode: 'probe', videoId, recipient: targetRecipient });
    assert.equal(target.prepared, true, JSON.stringify(target));
    return target;
  };
  const target = await prepare();
  let receiptToken;
  await pointer.click(target.x, target.y, { beforePress: async () => {
    const armed = await task({ action: 'share', mode: 'arm', videoId, recipient, point: target });
    receiptToken = armed.receiptToken;
  } });
  assert.equal(await page.getByText('分享成功', { exact: true }).count(), 0, 'receipt must already be gone before confirm');
  const result = await task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken });
  assert.equal(result.sent, true);
  assert.equal(await page.evaluate(() => window.sends), 1);
  assert.equal(await page.evaluate(() => globalThis.__douyinWatchShareReceiptV10), undefined);

  // Stay in the same loaded document, reopen after hover moved if necessary,
  // and capture a separate receipt for the next UID without any navigation.
  await page.evaluate(() => { globalThis.documentMarker = 'same-video-document'; });
  const second = await prepare(secondRecipient);
  let secondToken;
  await pointer.click(second.x, second.y, { beforePress: async () => {
    const armed = await task({ action: 'share', mode: 'arm', videoId, recipient: secondRecipient, point: second });
    secondToken = armed.receiptToken;
  } });
  assert.notEqual(secondToken, receiptToken);
  assert.equal((await task({ action: 'share', mode: 'confirm', videoId, recipient: secondRecipient, receiptToken: secondToken })).sent, true);
  assert.deepEqual(await page.evaluate(() => window.sentUids), [recipient.uid, secondRecipient.uid]);
  assert.equal(await page.evaluate(() => globalThis.documentMarker), 'same-video-document');

  // The first hover moves the real control after probe. The blocked attempt
  // must not press; reacquiring the same UID uses its new on-screen position.
  await page.setContent(html);
  const moving = await prepare();
  await page.evaluate(() => {
    globalThis.documentMarker = 'relocation-same-document';
    document.querySelector('[data-userid]').addEventListener('mouseenter', event => {
      event.currentTarget.style.transform = 'translateX(70px)';
    }, { once: true });
  });
  let blocked;
  await assert.rejects(pointer.click(moving.x, moving.y, { beforePress: async () => {
    blocked=await task({ action: 'share', mode: 'arm', videoId, recipient, point: moving, captureErrors: true });
    if(blocked.error) throw new Error(blocked.error);
  } }), /尚未点击发送/);
  assert.equal(blocked.code, 'SHARE_TARGET_CHANGED');
  assert.equal(blocked.retryable, true);
  assert.equal(await page.evaluate(() => window.sends), 0);
  const reopened = await task({ action: 'openShare', pointer: true, reopen: true });
  await pointer.hover(reopened.x, reopened.y, { leaveFirst: true });
  const relocated = await prepare();
  assert.notEqual(relocated.x, moving.x);
  let relocatedToken;
  await pointer.click(relocated.x, relocated.y, { beforePress: async () => {
    relocatedToken = (await task({ action: 'share', mode: 'arm', videoId, recipient, point: relocated })).receiptToken;
  } });
  assert.equal((await task({ action: 'share', mode: 'confirm', videoId, recipient, receiptToken: relocatedToken })).sent, true);
  assert.equal(await page.evaluate(() => window.sends), 1);
  assert.equal(await page.evaluate(() => globalThis.documentMarker), 'relocation-same-document');

  await page.setContent(html);
  const stale = await prepare();
  await page.evaluate(() => document.querySelector('[data-userid]').addEventListener('mouseenter', () => {
    document.querySelector('#panel').style.display = 'none';
  }));
  await assert.rejects(pointer.click(stale.x, stale.y, { beforePress: () => task({ action: 'share', mode: 'arm', videoId, recipient, point: stale }) }), /尚未点击发送/);
  assert.equal(await page.evaluate(() => window.sends), 0, 'a closed hover panel must prevent a stale-coordinate press');
  await pointer.close();
  const report = 'PASS: two different UIDs receive separate flash receipts in one unchanged document via real CDP, reopening the panel after each send; a hover-closed target blocks the press. Local fixture only, no real messages or mail.';
  await writeFile('test-results/send-receipt-v10-smoke.txt', report + '\n');
  await writeFile('test-results/group-send-v11-smoke.txt', report + '\n');
  await writeFile('test-results/preclick-v12-smoke.txt', report + '\nPASS: real control moved on first hover; blocked attempt had zero clicks, reacquiring the same UID clicked exactly once at its new position without navigation.\n');
  console.log(report);
} finally {
  delete globalThis.chrome;
  await browser.close();
}
