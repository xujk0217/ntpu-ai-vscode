'use strict';
const { BrowserManager } = require('../browser/manager');
const { chromium } = require('playwright-core');
const { publicTarget } = require('../network');
const { inspectOutboundPayload, redact } = require('../security/guard');
const { randomUUID } = require('node:crypto');
const blockedWindowClass = new RegExp(require('./window-policy.json').blockedClassPattern, 'i');
const path = require('node:path');
const { execFile } = require('node:child_process');
function desktopCall(message, { python = '/usr/bin/python3', signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(python, [path.join(__dirname, 'desktop.py')], { signal, timeout: 15000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout) => {
      try { const result = JSON.parse(stdout); if (!result.ok) reject(new Error(result.error)); else resolve(result); }
      catch { reject(new Error(error ? '桌面控制服務不可用；需要 Python 3、PyGObject／GDK 3、X11 與 XTest。' : '桌面控制回應格式無效。')); }
    }); child.stdin.end(JSON.stringify(message)); child.stdin.on('error', () => {});
  });
}
async function target(value) {
  inspectOutboundPayload(value, { reject: true }); const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || url.hostname === 'ai.ntpu.edu.tw') throw new Error('Computer use 不接受憑證 URL、校方模型登入網站或非 HTTP(S) 網址。');
  if (['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return { url, address: { address: url.hostname === '[::1]' ? '::1' : '127.0.0.1' } };
  return publicTarget(value);
}
class ComputerController {
  constructor(options) { this.options = options; this.desktop = options.desktop || desktopCall; this.engine = options.engine || chromium; this.sequence = Promise.resolve(); this.closed = false; }
  serial(work, signal) { const next = this.sequence.then(async () => {
    if (this.closed || signal?.aborted) throw new Error('Computer use 已停止。');
    const abort = () => { void this.context?.close().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
    try { return await work(); } finally { signal?.removeEventListener('abort', abort); }
  }); this.sequence = next.catch(() => {}); return next; }
  async approve(detail, signal) { if (signal.aborted) throw new Error('已停止'); if (!await this.options.approve(detail, signal)) return false; if (signal.aborted) throw new Error('已停止'); return true; }
  async checkedTarget(value) {
    const url = new URL(value);
    if (this.options.web === false && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('公開網路已停用；Computer use 僅能開啟明確核准的 localhost 預覽。');
    return target(value);
  }
  open(args, signal) { return this.serial(async () => {
    if (this.options.remote) throw new Error('Computer use 需要本機 Extension Host，不會把遠端顯示環境當成本機桌面。');
    if (this.mode) throw new Error('請先 computer_close 關閉目前控制目標。');
    if (args.mode === 'desktop') {
      if ((this.options.platform || process.platform) !== 'linux') throw new Error('原生桌面目前支援 Linux X11／XWayland；此平台可使用獨立工作瀏覽器。');
      const windows = (await this.desktop({ op: 'list' }, { signal })).windows.filter(window => !blockedWindowClass.test(window.class || '') && !/\b(?:sso|sign.?in|log.?in)\b|登入|驗證碼/i.test(window.title));
      const selected = await this.options.selectWindow(windows, signal); if (!selected) return { ok: false, denied: true };
      if (!await this.approve({ title: '控制選定視窗', detail: `視窗：${redact(selected.title)}\n僅限這個 X11／XWayland 視窗。觀察會讀取畫面，影像分析需另外確認；每次動作仍需核准。`, accept: '控制此視窗' }, signal)) return { ok: false, denied: true };
      this.mode = 'desktop'; this.window = selected; return { ok: true, mode: this.mode, title: redact(selected.title), controlled: true };
    }
    if (args.mode !== undefined && args.mode !== 'browser') throw new Error('mode 需為 browser 或 desktop。');
    const checked = await this.checkedTarget(args.url);
    if (!await this.approve({ title: '開啟獨立工作瀏覽器', detail: `網址：${checked.url.href}\n使用獨立 Computer Profile；畫面與頁面文字可能送至 NTPU AI。僅允許此來源，不使用日常或模型登入 Profile，每次操作仍需核准。`, accept: '開啟工作瀏覽器' }, signal)) return { ok: false, denied: true };
    this.origin = checked.url.origin;
    const host = checked.url.hostname.replace(/^\[|\]$/g, '');
    const rules = `MAP ${host} ${checked.address.address}, MAP * ~NOTFOUND`;
    const engine = { executablePath: () => this.engine.executablePath(), launchPersistentContext: (profile, options) => this.engine.launchPersistentContext(profile,
      { ...options, serviceWorkers: 'block', acceptDownloads: false, args: [...options.args.filter(arg => arg !== '--restore-last-session'), '--host-resolver-rules=' + rules] }) };
    this.manager = new BrowserManager({ ...this.options.browserOptions, storageRoot: this.options.directory,
      profileRoot: path.join(this.options.directory, 'computer-profiles'), engine });
    try {
      const launched = await this.manager.launch({ selection: this.options.browser || 'auto', customPath: this.options.customPath || '', headless: this.options.headless === true });
      this.context = launched.context; this.page = launched.page;
      if (signal.aborted) throw new Error('已停止');
      await this.context.route('**/*', route => { try { return new URL(route.request().url()).origin === this.origin && !(route.request().resourceType() === 'document' && route.request().frame() !== this.page.mainFrame()) ? route.continue() : route.abort('blockedbyclient'); } catch { return route.abort('blockedbyclient'); } });
      await this.context.routeWebSocket('**/*', ws => ws.close());
      this.context.on('page', page => { if (page !== this.page) void page.close(); });
      this.page.on('dialog', dialog => { void dialog.dismiss(); });
      this.page.on('filechooser', chooser => { void chooser.setFiles([]); });
      this.page.on('download', download => { void download.cancel(); });
      const abort = () => { void this.context?.close(); }; signal.addEventListener('abort', abort, { once: true });
      try { await this.page.goto(checked.url.href, { waitUntil: 'domcontentloaded', timeout: 20000 }); await this.page.evaluate(() => document.readyState); }
      finally { signal.removeEventListener('abort', abort); }
      if (signal.aborted) throw new Error('已停止');
      this.mode = 'browser'; return { ok: true, mode: this.mode, controlled: true, origin: this.origin, sameOriginOnly: true };
    } catch (error) { await this.release(); throw error; }
  }, signal); }
  async browserSafe() {
    if (!this.page || this.page.isClosed() || new URL(this.page.url()).origin !== this.origin) throw new Error('工作頁面已關閉或離開核准來源。');
    if (await this.page.locator('iframe:visible,frame:visible').count()) throw new Error('此版不擷取嵌入頁面；請以獨立工作來源開啟。');
    if (/(?:^|\/)(?:login|signin|sso|oauth|saml|authorize)(?:\/|$)/i.test(new URL(this.page.url()).pathname) ||
      await this.page.locator('input[type=password]:visible,input[autocomplete="one-time-code"]:visible,input[name*=captcha i]:visible').count()) throw new Error('登入／驗證畫面交由使用者人工操作；不擷取或分析此頁內容。');
  }
  observe(args, signal) { return this.serial(async () => {
    if (!this.mode) throw new Error('請先 computer_open 選擇控制目標。');
    if (!await this.approve({ title: '觀察選定畫面', detail: '將擷取選定視窗並讀取可見頁面文字；請先移開私人資料。登入／驗證畫面不得擷取。', accept: '觀察此畫面' }, signal)) return { ok: false, denied: true };
    let buffer, result = {};
    if (this.mode === 'browser') {
      await this.browserSafe();
      for (const handle of this.elements?.values() || []) await handle.dispose().catch(() => {});
      this.elements = new Map();
      const controls = [];
      for (const handle of await this.page.locator('a,button,input,textarea,select,[role=button],[contenteditable=true]').elementHandles()) {
        const metadata = await handle.evaluate(el => {
          const r = el.getBoundingClientRect(), type = (el.getAttribute('type') || '').toLowerCase();
          if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth || getComputedStyle(el).visibility !== 'visible' || ['password','file','hidden'].includes(type)) return null;
          return { tag: el.tagName.toLowerCase(), type, label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || '').slice(0, 160) };
        });
        if (!metadata || controls.length >= 80) { await handle.dispose(); continue; }
        const id = String(controls.length + 1); this.elements.set(id, handle); controls.push({ id, ...metadata });
      }
      result = { text: redact((await this.page.locator('body').innerText()).slice(0, 16000)), controls, url: redact(this.page.url()) };
      buffer = await this.page.screenshot({ type: 'png', timeout: 10000 });
      this.geometry = await this.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    } else {
      const observation = await this.desktop({ op: 'observe', id: this.window.id }, { signal });
      this.geometry = Object.fromEntries(['x','y','width','height'].map(key => [key, observation[key]])); buffer = Buffer.from(observation.png, 'base64'); result = { title: redact(observation.title), width: observation.width, height: observation.height };
    }
    if (buffer.length > 8 * 1024 * 1024) throw new Error('截圖超過 8 MiB，請縮小視窗。');
    const image = await this.options.image(buffer, args.question, signal);
    const verificationAvailable = !this.unverifiedClosed && (this.mode === 'browser' || typeof image.analysis === 'string' && !!image.analysis.trim());
    if (verificationAvailable) this.needsObservation = false;
    this.observation = randomUUID(); return { ok: true, mode: this.mode, observation: this.observation, ...result, ...image, verificationAvailable, requiresObservationAfterAction: true };
  }, signal); }
  action(args, signal) { return this.serial(async () => {
    if (!this.mode || !this.observation || args.observation !== this.observation) throw new Error('需要最近一次 computer_observe 的 observation；操作後必須重新觀察。');
    inspectOutboundPayload(args, { reject: true });
    if (!['click','fill','type','key','scroll','navigate'].includes(args.action)) throw new Error('不支援此操作。');
    if (!await this.approve({ title: '執行畫面操作：' + args.action, detail: JSON.stringify(args), accept: '執行這次操作' }, signal)) return { ok: false, denied: true };
    this.observation = null; this.needsObservation = true;
    if (this.mode === 'desktop') {
      const keys = { Enter: 'Return', Space: 'space', Backspace: 'BackSpace', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'Page_Up', PageDown: 'Page_Down' };
      return this.desktop({ ...args, key: keys[args.key] || args.key, op: 'action', id: this.window.id, geometry: this.geometry }, { signal });
    }
    await this.browserSafe();
    const handle = this.elements?.get(args.element);
    if (args.action === 'navigate') {
      const checked = await this.checkedTarget(args.url); if (checked.url.origin !== this.origin) throw new Error('新來源需要關閉後重新 computer_open 核准。');
      await this.page.goto(checked.url.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (args.action === 'click' && handle) await handle.click({ timeout: 5000 });
    else if (args.action === 'fill' && handle) {
      if (typeof args.text !== 'string' || args.text.length > 2000) throw new Error('文字最多 2000 字。');
      await handle.fill(args.text, { timeout: 5000 });
    } else if (args.action === 'key') {
      if (!['Enter','Tab','Escape','Space','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(args.key)) throw new Error('不允許系統或瀏覽器快捷鍵。');
      await this.page.keyboard.press(args.key);
    } else if (args.action === 'scroll') {
      if (!Number.isFinite(args.y) || Math.abs(args.y) > 1200) throw new Error('捲動範圍需在正負 1200 內。');
      await this.page.mouse.wheel(0, args.y);
    } else throw new Error('請使用目前觀察回傳的 element ID 與支援動作。');
    return { ok: true, performed: true, requiresObservation: true };
  }, signal); }
  async release() { if (this.mode && this.needsObservation) this.unverifiedClosed = true; this.observation = null; await this.context?.close(); this.context = null; this.page = null; this.mode = null; this.elements = null; this.window = null; }
  close() { return this.serial(() => this.release().then(() => ({ ok: true, closed: true }))); }
  async dispose() { this.closed = true; await this.context?.close().catch(() => {}); await this.sequence; await this.release(); }
}
module.exports = { ComputerController, desktopCall, target };
