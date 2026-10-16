'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');
const { inspectOutboundPayload, redact, sanitize } = require('../security/guard');
const MAX_RESULT = 8 * 1024 * 1024;
class PluginBroker {
  constructor({ directory, run, status = () => ({}) }) { Object.assign(this, { directory, run, status }); this.jobs = new Map(); this.tail = Promise.resolve(); this.closed = false; }
  async start() {
    const directory = path.join(this.directory, randomUUID()); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    this.instanceDirectory = directory; this.connectionFile = path.join(directory, 'connection.json');
    this.secret = randomBytes(32).toString('hex');
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    try { await fs.writeFile(this.connectionFile, JSON.stringify({ version: 1, port: this.server.address().port, secret: this.secret }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await new Promise(resolve => this.server.close(resolve)); throw error; }
    return this.connectionFile;
  }
  async handle(request, response) {
    const reply = (status, value) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(sanitize(value))); } };
    try {
      const authorization = String(request.headers.authorization || ''), expected = 'Bearer ' + this.secret;
      if (this.closed || request.headers.origin || request.method !== 'POST' || request.url !== '/rpc' || !/^Bearer [a-f0-9]{64}$/.test(authorization) || authorization.length !== expected.length ||
          !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { request.resume(); return reply(403, { error: '本機橋接未授權。' }); }
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) { request.resume(); return reply(400, { error: '需要 JSON。' }); }
      request.setTimeout(5000, () => request.destroy());
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 128000) { reply(413, { error: '請求過大。' }); request.destroy(); return; } chunks.push(chunk); }
      const message = JSON.parse(Buffer.concat(chunks).toString());
      const result = await this.dispatch(message); reply(200, result);
    } catch (error) { reply(400, { error: redact(error.message) }); }
  }
  view(job) { return { id: job.id, status: job.status, createdAt: job.createdAt, endedAt: job.endedAt, characters: job.result.length, savedParts: job.parts, error: job.error }; }
  async save(job) {
    const file = path.join(this.instanceDirectory, job.id + '.json');
    await fs.writeFile(file + '.tmp', JSON.stringify(sanitize({ ...this.view(job), prompt: job.prompt, result: job.result })), { mode: 0o600 });
    await fs.rename(file + '.tmp', file);
  }
  async dispatch(message) {
    if (!message || typeof message !== 'object' || this.closed) throw new Error('橋接已停止或請求無效。');
    if (message.method === 'status') return { ok: true, ...this.status(), advisoryOnly: true };
    if (message.method === 'start') {
      const prompt = message.prompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('請求需為 1–20,000 字。');
      inspectOutboundPayload(prompt, { reject: true });
      if ([...this.jobs.values()].filter(job => !job.endedAt).length >= 5) throw new Error('外部請求佇列已滿。');
      const job = { id: randomUUID(), prompt, status: 'queued', createdAt: Date.now(), result: '', parts: 0, controller: new AbortController() };
      this.jobs.set(job.id, job);
      try { await this.save(job); } catch (error) { this.jobs.delete(job.id); throw error; }
      const work = this.tail.then(() => this.execute(job)); this.tail = work.catch(() => {});
      return { ok: true, ...this.view(job) };
    }
    const job = this.jobs.get(message.id); if (!job) throw new Error('找不到此橋接建立的請求。');
    if (message.method === 'cancel') { job.controller.abort(); return { ok: true, ...this.view(job) }; }
    if (message.method === 'get') return { ok: true, ...this.view(job) };
    if (message.method === 'read') {
      const offset = message.offset ?? 0, limit = message.limit ?? 8000;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > job.result.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('結果分頁參數無效。');
      return { ok: true, ...this.view(job), offset, text: job.result.slice(offset, offset + limit),
        nextOffset: offset + limit < job.result.length ? offset + limit : null, complete: job.status === 'completed' };
    }
    throw new Error('未知橋接操作。');
  }
  async execute(job) {
    const update = async ({ text, parts = job.parts }) => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RESULT) throw new Error('外部結果超過 8 MiB 保存上限。');
      job.result = redact(text); job.parts = parts; await this.save(job);
    };
    try {
      if (job.controller.signal.aborted || this.closed) throw new Error('已停止');
      job.status = 'running'; await this.save(job);
      const result = await this.run(job.prompt, job.controller.signal, update);
      if (job.controller.signal.aborted) throw new Error('已停止');
      await update({ text: result.text, parts: result.parts ?? job.parts });
      job.status = result.completed ? 'completed' : 'incomplete';
    } catch (error) { job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'; job.error = redact(error.message); }
    finally { job.endedAt = Date.now(); try { await this.save(job); } catch (error) { job.status = 'failed'; job.error = '本機結果保存失敗：' + redact(error.message); } }
  }
  cancelAll() { for (const job of this.jobs.values()) if (!job.endedAt) job.controller.abort(); }
  async close() {
    this.closed = true; this.cancelAll(); await this.tail;
    if (this.server) await new Promise(resolve => { this.server.close(resolve); this.server.closeIdleConnections(); });
    if (this.connectionFile) await fs.rm(this.connectionFile, { force: true });
  }
}
module.exports = { PluginBroker };
