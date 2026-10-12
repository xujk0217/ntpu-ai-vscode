'use strict';
const { randomUUID } = require('node:crypto');

class ApprovalGate {
  constructor(onChange) { this.pending = null; this.onChange = onChange; }
  request(detail, signal) {
    if (this.pending) return Promise.reject(new Error('已有一個操作正在等待確認。'));
    if (signal.aborted) return Promise.reject(new Error('已停止'));
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => finish(undefined);
      const finish = answer => {
        signal.removeEventListener('abort', abort);
        this.pending = null;
        this.onChange(null);
        resolve(answer);
      };
      this.pending = { id, detail, finish };
      signal.addEventListener('abort', abort, { once: true });
      this.onChange({ id, ...detail });
    });
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
