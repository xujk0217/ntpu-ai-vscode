'use strict';
const { randomUUID } = require('node:crypto');

class ApprovalGate {
  constructor(onChange) { this.pending = null; this.onChange = onChange; this.queue = []; }
  request(detail, signal) {
    if (signal.aborted) return Promise.reject(new Error('已停止'));
    return new Promise(resolve => {
      const id = randomUUID();
      const entry = { id, detail, signal, finish: null }; let settled = false;
      const abort = () => finish(undefined);
      const finish = answer => {
        if (settled) return; settled = true;
        signal.removeEventListener('abort', abort);
        const index = this.queue.indexOf(entry); if (index >= 0) this.queue.splice(index, 1);
        if (this.pending === entry) { this.pending = null; this.onChange(null); }
        resolve(answer);
        this.pump();
      };
      entry.finish = finish; this.queue.push(entry);
      signal.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }
  pump() {
    if (this.pending) return;
    while (this.queue.length) {
      const entry = this.queue.shift();
      if (entry.signal.aborted) { entry.finish(undefined); return; }
      this.pending = entry; this.onChange({ id: entry.id, ...entry.detail }); break;
    }
  }
  decide(id, approved) {
    if (!this.pending || this.pending.id !== id) return false;
    if (approved && this.pending.detail.type === 'question') return false;
    this.pending.finish(approved ? this.pending.detail.accept : undefined);
    return true;
  }
  answer(id, answer) {
    if (!this.pending || this.pending.id !== id || this.pending.detail.type !== 'question') return false;
    this.pending.finish(String(answer).slice(0, 4000)); return true;
  }
  state() { return this.pending ? { id: this.pending.id, ...this.pending.detail } : null; }
}

module.exports = { ApprovalGate };
