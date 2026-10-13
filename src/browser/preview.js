'use strict';
// User-facing remote surface. Frames and typed text never enter agent history.
class BrowserPreview {
  constructor({ bridge, emit, busy = () => false }) { this.bridge = bridge; this.emit = emit; this.busy = busy; }
  async start() {
    this.stop(); this.active = true;
    await this.bridge().open();
    await this.frame();
    if (this.active) this.timer = setInterval(() => { void this.frame(); }, 1200);
    this.timer?.unref();
  }
  page() { const bridge = this.bridge(); return bridge.context?.pages().filter(page => !page.isClosed()).at(-1) || bridge.page; }
  allowed(page) { try { const url = new URL(page.url()); return url.protocol === 'https:' || url.origin === this.bridge().origin; } catch { return false; } }
  async frame() {
    if (!this.active || this.capturing) return;
    this.capturing = true;
    try {
      const page = this.page();
      if (!page || page.isClosed()) return this.emit({ kind: 'browserFrame', error: '瀏覽器未連線，請重新連線。' });
      if (!this.allowed(page)) return this.emit({ kind: 'browserFrame', error: '此頁面無法安全顯示；請開啟原生視窗。' });
      const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const buffer = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
      if (this.active) this.emit({ kind: 'browserFrame', image: 'data:image/jpeg;base64,' + buffer.toString('base64'), width: size.width, height: size.height, locked: this.busy() });
    } catch { if (this.active) this.emit({ kind: 'browserFrame', error: '畫面更新中，請稍候。' }); }
    finally { this.capturing = false; }
  }
  async input(message) {
    const page = this.page();
    if (!this.active || this.busy() || !page || page.isClosed() || !this.allowed(page)) return;
    if (message.action === 'click' && Number.isFinite(message.x) && Number.isFinite(message.y) && message.x >= 0 && message.x <= 1 && message.y >= 0 && message.y <= 1) {
      const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      await page.mouse.click(message.x * size.width, message.y * size.height);
    } else if (message.action === 'text' && typeof message.text === 'string' && message.text.length <= 2000) await page.keyboard.insertText(message.text);
    else if (message.action === 'key' && ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(message.key)) await page.keyboard.press(message.key);
    else if (message.action === 'scroll' && Number.isFinite(message.delta)) await page.mouse.wheel(0, Math.max(-800, Math.min(800, message.delta)));
    await this.frame();
  }
  stop() { this.active = false; clearInterval(this.timer); this.timer = null; }
}
module.exports = { BrowserPreview };
