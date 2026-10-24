// Trusted pointer input through the DevTools protocol.
// The live share popover is bound to real hover state: an injected script can
// dispatch mouseover/click, but the browser does not treat that as hovering, so
// the friend list never appears (and unmounts as soon as the real pointer
// leaves). Only the browser's own input pipeline produces the state Douyin
// listens to, which is what chrome.debugger exposes here.
const PROTOCOL = '1.3';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Pointer {
  constructor(tabId) {
    this.tabId = tabId;
    this.connected = false;
  }
  async connect() {
    if (this.connected) return this;
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, PROTOCOL);
    } catch (error) {
      throw new Error('无法启用真实鼠标指针（' + String(error?.message || error) + '）；请关闭该标签页的开发者工具后重试。');
    }
    this.connected = true;
    // Let the page believe it has focus so focus-gated UI still renders, without
    // actually taking the user's focus.
    try { await chrome.debugger.sendCommand({ tabId: this.tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* optional */ }
    return this;
  }
  async send(method, params = {}) {
    const call = () => chrome.debugger.sendCommand({ tabId: this.tabId }, method, params);
    try {
      await call();
    } catch (error) {
      const message = String(error?.message || error);
      if (!/Detached|not attached|No tab with given id/iu.test(message)) throw error;
      // A press/release may have reached the page before its acknowledgement
      // was lost. Repeating it can send a card twice; only movement and other
      // non-submitting commands may reconnect and retry automatically.
      if (method === 'Input.dispatchMouseEvent' && ['mousePressed','mouseReleased'].includes(params.type)) {
        this.connected = false;
        throw error;
      }
      // The browser can drop a debugger session on its own. Re-attach once and
      // repeat the exact call instead of pausing the whole bot.
      this.connected = false;
      await this.connect();
      await call();
    }
  }
  async command(params) {
    await this.send('Input.dispatchMouseEvent', params);
  }
  async hover(x, y, { leaveFirst = false } = {}) {
    await this.connect();
    // Retrying within the same icon does not cause mouseleave/mouseenter. Only
    // opening the share panel may reset the pointer to the page corner. A send
    // click must stay inside the open popover or it would close before clicking.
    if (leaveFirst) {
      await this.command({ type: 'mouseMoved', x: 1, y: 1, button: 'none', buttons: 0, clickCount: 0 });
      await pause(100);
    }
    await this.command({ type: 'mouseMoved', x: Math.max(1, x - 1), y: Math.max(1, y - 1), button: 'none', buttons: 0, clickCount: 0 });
    await pause(30);
    await this.command({ type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
  }
  async click(x, y, { beforePress } = {}) {
    await this.hover(x, y);
    await pause(80);
    // Hover can close or re-render a popover. Revalidate the live hit target and
    // arm receipt capture after movement but before the first submitting input.
    if (beforePress) await beforePress();
    await this.command({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await pause(40);
    await this.command({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }
  async close() {
    if (!this.connected) return;
    this.connected = false;
    try { await chrome.debugger.detach({ tabId: this.tabId }); } catch { /* tab already gone */ }
  }
}
