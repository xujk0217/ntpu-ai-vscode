'use strict';

const { BrowserManager, dataDirectory } = require('./browser/manager');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ensureAttachment } = require('./security/attachments');
const { inspectOutboundPayload } = require('./security/guard');

const ORIGIN = 'https://ai.ntpu.edu.tw';
const PROFILE = path.join(dataDirectory(), 'browser-profiles');

// Observe only the site's own UI-initiated request. Cookies and verification stay
// inside the dedicated browser. No private API credentials are extracted.
function installStreamObserver(bindingName) {
  const key = '__ntpuLocalBridge';
  if (window[key]) return;
  window[key] = { active: null, controller: null, cancel: null };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const request = args[0];
    const url = typeof request === 'string' ? request : request?.url;
    const state = window[key];
    const id = state.active;
    const relevant = id && url && new URL(url, location.href).origin === location.origin &&
      new URL(url, location.href).pathname === '/chat/stream';
    if (!relevant) return originalFetch.apply(this, args);
    // Keep the website's Stop action and the local Stop action connected.
    const options = { ...(args[1] || {}) };
    const originalSignal = options.signal;
    const controller = new AbortController();
    state.controller = controller;
    const relayAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener('abort', relayAbort, { once: true });
    options.signal = controller.signal;
    let reader;
    let completed = false;
    const emit = payload => window[bindingName]({ id, ...payload }).catch(() => {});
    const task = (async () => {
      try {
        const response = await originalFetch.call(this, request, options);
        if (!response.ok) {
          const body = await response.clone().json().catch(() => ({}));
          await emit({ kind: 'failure', status: response.status,
            message: body.detail || `網站回應 HTTP ${response.status}` });
          return response;
        }
        reader = response.clone().body.getReader();
        state.cancel = () => { controller.abort(); reader?.cancel().catch(() => {}); };
        (async () => {
          const decoder = new TextDecoder();
          let buffer = '';
          const line = async raw => {
            if (!raw.startsWith('data:')) return;
            const data = raw.slice(5).trim();
            if (!data || data === '[DONE]') return;
            let event;
            try { event = JSON.parse(data); } catch { return; }
            if (event.type === 'done') completed = true;
            await emit({ kind: 'event', event });
          };
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              buffer += decoder.decode(result.value, { stream: true });
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop();
              for (const raw of lines) await line(raw);
            }
            buffer += decoder.decode();
            if (buffer) await line(buffer);
            if (!completed) await emit({ kind: 'failure', message: '網站串流中斷，未收到完成事件；沒有自動重送。' });
          } catch (error) {
            await emit({ kind: 'failure', message: controller.signal.aborted ? '已停止' : error.message });
          } finally {
            originalSignal?.removeEventListener('abort', relayAbort);
            if (state.controller === controller) { state.controller = null; state.cancel = null; }
          }
        })();
        return response;
      } catch (error) {
        await emit({ kind: 'failure', message: controller.signal.aborted ? '已停止' : error.message });
        throw error;
      }
    })();
    return task;
  };
}

class BrowserBridge {
  constructor(options = {}) {
    this.options = options;
    this.origin = options.origin || ORIGIN;
    this.manager = options.manager || new BrowserManager({ ...options, profileRoot: options.profile, storageRoot: options.storageRoot });
    this.context = null;
    this.page = null;
    this.pending = null;
    this.opening = null;
    this.binding = 'ntpuLocal_' + randomUUID().replaceAll('-', '');
    this.profile = options.profile || PROFILE;
  }

  async open() {
    if (this.page && !this.page.isClosed()) return;
    if (this.opening) return this.opening;
    this.opening = this._open();
    try { await this.opening; } finally { this.opening = null; }
  }

  async _open() {
    if (this.context) await this.context.close().catch(() => {});
    const launched = await this.manager.launch({ selection: this.options.browser || (this.options.chromePath ? 'custom' : 'auto'),
      customPath: this.options.customPath || this.options.chromePath || '', headless: !!this.options.headless });
    this.context = launched.context; this.page = launched.page; this.profile = launched.info.profile;
    await this.context.exposeBinding(this.binding, (source, payload) => {
      if (source.page !== this.page || !source.frame.url().startsWith(this.origin + '/')) return;
      this._receive(payload);
    });
    await this.context.addInitScript(installStreamObserver, this.binding);
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.page.on('close', () => this._fail(new Error('專用瀏覽器已關閉。請重新開啟登入瀏覽器。')));
    this.page.on('framenavigated', frame => {
      if (frame === this.page?.mainFrame() && this.pending) this._fail(new Error('回答期間網頁已離開，請重新確認登入狀態。'));
    });
    await this.page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // The page restores its existing session asynchronously after DOMContentLoaded.
    // Wait for that bootstrap before reporting a false login failure. This only
    // observes normal UI state and never completes a login or CAPTCHA.
    await this.page.waitForFunction(() => {
      const overlay = document.getElementById('auth-overlay');
      return overlay && (overlay.classList.contains('hidden') || getComputedStyle(overlay).display === 'none') && document.getElementById('input');
    }, null, { timeout: 12000 }).catch(() => {});
    await this.page.bringToFront();
  }

  async status() {
    if (!this.page || this.page.isClosed()) return { ready: false, authentication: 'unknown', message: '瀏覽器未連線。重新連線後會確認既有登入狀態；關閉瀏覽器不會清除登入資料。' };
    const url = this.page.url();
    if (!url.startsWith(this.origin + '/')) return { ready: false, authentication: 'unknown', message: '登入頁面正在切換，請完成學校登入並返回 NTPU AI。' };
    return this.page.evaluate(() => {
      const overlay = document.getElementById('auth-overlay');
      const input = document.getElementById('input');
      const hidden = overlay && (overlay.classList.contains('hidden') || getComputedStyle(overlay).display === 'none');
      const ready = !!(hidden && input && document.getElementById('sendBtn'));
      return { ready, authentication: ready ? 'authenticated' : overlay && !hidden ? 'required' : 'unknown', message: ready ? `已連線：${document.getElementById('user-email')?.textContent || 'NTPU AI'}` :
        '請在專用 Chrome 使用學校帳號登入，或完成安全驗證後按「以訪客身分試用」。' };
    }).catch(() => ({ ready: false, authentication: 'unknown', message: '登入頁面正在切換，請稍候再檢查。' }));
  }

  async logout() {
    if (this.pending) throw new Error('請先停止目前執行中的任務，再登出 NTPU AI。');
    if (!this.context || !this.page || this.page.isClosed()) await this.open();
    await this.context.clearCookies({ domain: /(^|\.)ntpu\.edu\.tw$/ });
    if (!this.page.url().startsWith(this.origin + '/'))
      await this.page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
    await this.page.goto(this.origin, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  async chat(prompt, options = {}) {
    prompt = inspectOutboundPayload(prompt);
    if (options.attachment) await (this.options.attachmentGuard || ensureAttachment)(options.attachment);
    if (this.pending) throw new Error('已有一個 NTPU AI 請求執行中。');
    if (!this.page || this.page.isClosed()) await this.open();
    const status = await this.status();
    if (!status.ready) throw new Error(status.message);
    if (options.signal?.aborted) throw new Error('已停止');
    await this.page.waitForFunction(() => {
      const button = document.getElementById('sendBtn');
      return button && !button.classList.contains('stop');
    }, null, { timeout: 10000 });
    if (options.newConversation !== false) {
      const newChat = this.page.locator('#newChatBtn');
      await newChat.click({ timeout: 10000 });
    }
    for (const action of ['clear-attach', 'clear-quote']) {
      const clear = this.page.locator(`[data-action="${action}"]`);
      if (await clear.count()) await clear.first().click({ timeout: 5000 });
    }
    // Search is performed by the local MCP harness, with its own permissions.
    await this.page.evaluate(() => {
      for (const id of ['menuSearchItem', 'menuNtpuItem']) {
        const element = document.getElementById(id);
        if (element?.classList.contains('active') || element?.classList.contains('ntpu-active')) element.click();
      }
    });
    if (options.attachment) {
      options.onUpload?.(options.attachment.name || '圖片');
      await this._attach(options.attachment);
      if (options.signal?.aborted) throw new Error('已停止');
    }
    await this.page.locator('#input').fill(prompt, { timeout: 10000 });
    await this.page.evaluate(installStreamObserver, this.binding);
    const id = randomUUID();
    let resolve, reject;
    const result = new Promise((a, b) => { resolve = a; reject = b; });
    // Attach immediately: a click failure can reject before the final await.
    result.catch(() => {});
    const timer = setTimeout(() => {
      this._fail(new Error('等待回答逾時；沒有自動重送。請檢查瀏覽器是否還在產生回答。'));
      void this._abortPage();
    }, options.timeoutMs || 240000);
    const abort = () => { this._fail(new Error('已停止')); void this._abortPage(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    this.pending = { id, resolve, reject, timer, text: '', model: null,
      onToken: options.onToken, onJudge: options.onJudge, signal: options.signal, abort };
    try {
      await this.page.evaluate(requestId => { window.__ntpuLocalBridge.active = requestId; }, id);
      if (options.signal?.aborted) abort();
      else await this.page.locator('#sendBtn').click({ timeout: 10000 });
      return await result;
    } catch (error) {
      this._fail(error);
      await this._abortPage();
      throw error;
    }
  }

  async _attach(attachment) {
    const response = this.page.waitForResponse(result => result.url() === this.origin + '/upload' && result.request().method() === 'POST', { timeout: 45000 });
    response.catch(() => {});
    await this.page.locator('#fileInput').setInputFiles({ name: attachment.name,
      mimeType: attachment.mimeType, buffer: attachment.buffer }, { timeout: 10000 });
    const upload = await response;
    if (!upload.ok()) throw new Error(`附件上傳失敗（HTTP ${upload.status()}），請檢查網站驗證或用量限制。`);
    await this.page.waitForFunction(() => !!document.querySelector('#attachPreview .attach-chip-badge'), null, { timeout: 10000 });
  }

  _receive(payload) {
    const pending = this.pending;
    if (!pending || payload?.id !== pending.id) return;
    if (payload.kind === 'failure') {
      const suffix = [401, 403].includes(payload.status) ? ' 請回瀏覽器重新登入或完成驗證。' :
        payload.status === 429 ? ' 已達網站用量限制，請等待或使用學校帳號；不會自動重試。' : '';
      return this._fail(new Error((payload.message || '網站請求失敗') + suffix));
    }
    const event = payload.event;
    if (!event) return;
    if (event.type === 'judge') { pending.model = event.model || event.selected_model || event; pending.onJudge?.(event); }
    else if (event.type === 'token') { pending.text += event.content || ''; pending.onToken?.(event.content || ''); }
    else if (event.type === 'error') this._fail(new Error(event.message || 'NTPU AI 回答失敗'));
    else if (event.type === 'done') {
      const result = { text: pending.text, model: pending.model, meta: event };
      this._clear();
      if (!result.text.trim()) pending.reject(new Error('網站回傳空白回答。'));
      else pending.resolve(result);
    }
  }

  _clear() {
    if (!this.pending) return;
    const id = this.pending.id;
    clearTimeout(this.pending.timer);
    this.pending.signal?.removeEventListener('abort', this.pending.abort);
    this.pending = null;
    this.page?.evaluate(requestId => {
      if (window.__ntpuLocalBridge?.active === requestId) window.__ntpuLocalBridge.active = null;
    }, id).catch(() => {});
  }

  _fail(error) { const pending = this.pending; this._clear(); pending?.reject(error); }

  async _abortPage() {
    if (!this.page || this.page.isClosed()) return;
    await this.page.evaluate(() => { window.__ntpuLocalBridge?.cancel?.(); window.__ntpuLocalBridge?.controller?.abort(); }).catch(() => {});
  }

  async close() {
    this._fail(new Error('已停止'));
    await this._abortPage();
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
    if (this.manager.info) this.manager.info.controlled = false;
  }
}

module.exports = { BrowserBridge, PROFILE, ORIGIN, installStreamObserver };
