'use strict';
const { randomUUID } = require('node:crypto');
const { concurrencyLimit } = require('./parallel-policy');
const { sanitize, redact } = require('./security/guard');

const READ_BATCH_TOOLS = new Set(['list_files', 'read_file', 'search_text', 'web_search', 'web_fetch', 'ntpu_lookup']);
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
  constructor(limit = 1, onError = () => {}) { this.onError = onError; this.limit = concurrencyLimit(limit); this.active = 0; this.queue = []; }
  run(work, signal) {
    if (signal?.aborted) return Promise.reject(new Error('已停止'));
    return new Promise((resolve, reject) => {
      const job = { work, signal, resolve, reject };
      job.abort = () => { const index = this.queue.indexOf(job); if (index >= 0) { this.queue.splice(index, 1); signal.removeEventListener('abort', job.abort); reject(new Error('已停止')); } };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const job = this.queue.shift(); job.signal?.removeEventListener('abort', job.abort);
      if (job.signal?.aborted) { job.reject(new Error('已停止')); continue; }
      this.active++;
      Promise.resolve().then(job.work).then(job.resolve, error => { this.onError(error); job.reject(error); }).finally(() => { this.active--; this.drain(); });
    }
  }
  bridge(bridge) { return { chat: (prompt, options = {}) => this.run(() => bridge.chat(prompt, options), options.signal) }; }
}

class ModelBudget {
  constructor(limit) { this.limit = Math.max(1, Math.min(100, Number(limit) || 1)); this.used = 0; }
  consume() { if (this.used >= this.limit) return null; return ++this.used; }
}
module.exports = { READ_BATCH_TOOLS, batchNames, runReadBatch, RequestScheduler, ModelBudget };
