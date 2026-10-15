'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { concurrencyLimit, isServiceLimit } = require('./parallel-policy');
const { sanitize, redact } = require('./security/guard');

const READ_BATCH_TOOLS = new Set(['list_files', 'read_file', 'search_text', 'search_history', 'read_history', 'web_search', 'web_fetch', 'ntpu_lookup']);
function batchNames(catalog = []) { return new Set(catalog.filter(tool => READ_BATCH_TOOLS.has(tool.name) || tool.readOnly && ['exa', 'ntpu_ai4x'].includes(tool.server)).map(tool => tool.name)); }

async function runReadBatch(calls, { tools, onTool, signal, message = '' }) {
  if (signal.aborted) throw new Error('已停止');
  const allowed = batchNames(tools.catalog?.());
  if (!Array.isArray(calls) || calls.length < 2 || calls.length > 6 || calls.some(call => !call || !allowed.has(call.name) || !call.args || typeof call.args !== 'object' || Array.isArray(call.args))) throw new Error('只可批次執行 2–6 個獨立唯讀工具。');
  const results = await Promise.all(calls.map(async (call, index) => {
    const id = randomUUID(); onTool({ id, name: call.name, args: call.args, status: 'running', message: index === 0 ? message : '', parallel: true });
    let result;
    try { result = sanitize(await tools.execute(call.name, call.args)); }
    catch (error) { result = { ok: false, error: redact(error.message) }; }
    onTool({ id, status: signal.aborted ? 'interrupted' : result.denied ? 'denied' : result.ok === false ? 'error' : 'done', result });
    return { type: 'tool', at: Date.now(), name: call.name, args: sanitize(call.args), result, parallel: true };
  }));
  if (signal.aborted) throw new Error('已停止');
  return results;
}

class RequestScheduler {
  constructor(limit = 2, onError = () => {}, { rateGate, onWait = () => {}, adaptive, onState = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { rateGate, onWait, adaptive, onState, now, onError });
    this.fixedLimit = Math.min(4, concurrencyLimit(limit)); this.active = 0; this.queue = []; this.pendingRate = null;
    this.streamActive = 0; this.peakStreams = 0; this.requests = 0; this.closed = false;
    this.liveStreams = new Set();
    this.unsubscribe = adaptive?.subscribe(() => { this.drain(); this.publish(); });
  }
  get limit() { return this.adaptive?.limit ?? this.fixedLimit; }
  state() { return { limit: this.limit, activeRequests: this.active, queuedRequests: this.queue.length, waitingForRate: !!this.pendingRate, blocked: !!this.adaptive?.blocked }; }
  publish() { this.onState(this.state()); }
  remove(job, error) {
    const index = this.queue.indexOf(job); if (index < 0) return;
    this.queue.splice(index, 1); job.signal?.removeEventListener('abort', job.abort); job.gateController.abort(); job.reject(error); this.publish();
  }
  run(work, signal) {
    if (signal?.aborted || this.closed) return Promise.reject(new Error('已停止'));
    if (this.adaptive?.blocked) return Promise.reject(this.adaptive.error || new Error('服務限制，已暫停新請求'));
    return new Promise((resolve, reject) => {
      const job = { work, signal, resolve, reject, gateController: new AbortController(), rateReady: !this.rateGate };
      job.abort = () => { this.remove(job, new Error('已停止')); this.drain(); };
      signal?.addEventListener('abort', job.abort, { once: true }); this.queue.push(job); this.publish(); this.drain();
    });
  }
  drain() {
    if (this.adaptive?.blocked || this.closed) {
      for (const job of [...this.queue]) this.remove(job, this.adaptive?.error || new Error('已停止'));
      return;
    }
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue[0];
      if (job.signal?.aborted) { this.remove(job, new Error('已停止')); continue; }
      if (!job.rateReady) {
        if (this.pendingRate) return;
        this.pendingRate = job;
        this.rateGate.acquire(job.gateController.signal, 1, this.onWait).then(() => {
          job.rateReady = true; this.pendingRate = null; this.drain(); this.publish();
        }, error => { this.pendingRate = null; this.remove(job, error); this.drain(); this.publish(); });
        this.publish(); return;
      }
      this.queue.shift(); job.signal?.removeEventListener('abort', job.abort); this.active++; this.publish();
      Promise.resolve().then(() => {
        if (job.signal?.aborted || this.adaptive?.blocked || this.closed) throw new Error('已停止');
        this.requests++; return job.work();
      }).then(job.resolve, error => {
        if (isServiceLimit(error)) this.adaptive?.block(error);
        this.onError(error); job.reject(error);
      }).finally(() => { this.active--; this.publish(); this.drain(); });
    }
  }
  bridge(bridge) { return { chat: (prompt, options = {}) => this.run(async () => {
    let opened = false, firstTokenAt = null, lastTokenAt = null, responseCharacters = 0, maxTokenGapMs = 0;
    const observed = { concurrentRequests: 1 }; const startedAt = this.now();
    try {
      const result = await bridge.chat(prompt, { ...options,
        onOpen: () => { if (!opened) { opened = true; this.liveStreams.add(observed); this.peakStreams = Math.max(this.peakStreams, ++this.streamActive);
          for (const stream of this.liveStreams) stream.concurrentRequests = Math.max(stream.concurrentRequests, this.streamActive); } options.onOpen?.(); },
        onToken: (...args) => {
          if (typeof args[0] === 'string' && args[0].length) { const at = this.now(); firstTokenAt ??= at;
            if (lastTokenAt !== null) maxTokenGapMs = Math.max(maxTokenGapMs, at - lastTokenAt);
            lastTokenAt = at; responseCharacters += args[0].length; }
          options.onToken?.(...args);
        } });
      this.adaptive?.observe({ success: true, firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt, durationMs: this.now() - startedAt, cancelled: options.signal?.aborted,
        responseCharacters: Math.max(responseCharacters, result.text?.length || 0), promptCharacters: prompt.length, concurrentRequests: observed.concurrentRequests, maxTokenGapMs });
      return result;
    } catch (error) {
      this.adaptive?.observe({ success: false, error, cancelled: options.signal?.aborted }); throw error;
    } finally { if (opened) { this.streamActive--; this.liveStreams.delete(observed); } }
  }, options.signal) }; }
  close() { this.closed = true; this.unsubscribe?.(); this.drain(); }
}

class ModelBudget {
  constructor(limit) { this.limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 1))); this.used = 0; }
  consume() { if (this.used >= this.limit) return null; return ++this.used; }
}
module.exports = { READ_BATCH_TOOLS, batchNames, runReadBatch, RequestScheduler, ModelBudget };
