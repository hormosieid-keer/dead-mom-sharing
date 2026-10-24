// Isolated local HTML only: no real Douyin page, messages or mail service.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Pointer } from '../extension/pointer.js';

const browser = await chromium.launch({ headless: true, channel: 'chromium',
  executablePath: process.env.BOT_TEST_CHROMIUM || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(`<style>
    #share{position:absolute;left:100px;top:200px;width:42px;height:46px;background:#ccc}
    #panel{display:none;position:absolute;left:42px;top:0;width:140px;height:46px;background:#eef}
    #share:hover #panel{display:block}button{width:140px;height:46px}
    </style><div id="share">share<div id="panel"><button>Send fixture</button></div></div>
    <script>window.entries=0;window.sent=0;
    document.querySelector('#share').addEventListener('mouseenter',()=>entries++);
    document.querySelector('button').addEventListener('click',()=>sent++);</script>`);
  const cdp = await page.context().newCDPSession(page);
  globalThis.chrome = { debugger: { attach: async () => {}, detach: async () => {},
    sendCommand: async (target, method, params) => cdp.send(method, params) } };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 121, y: 223 });
  await page.evaluate(() => { window.entries = 0; });
  const pointer = new Pointer(1);
  await pointer.hover(121, 223);
  assert.equal(await page.evaluate(() => window.entries), 0, 'small moves within the icon do not produce reentry');
  await pointer.hover(121, 223, { leaveFirst: true });
  assert.equal(await page.evaluate(() => window.entries), 1);
  assert.equal(await page.locator('#panel').isVisible(), true);
  await pointer.click(212, 223);
  assert.equal(await page.evaluate(() => window.sent), 1, 'sending must keep the hover panel open');
  await pointer.close();
  console.log('PASS: real CDP reentry opens the hover panel and clicks the local fixture once.');
} finally {
  delete globalThis.chrome;
  await browser.close();
}
