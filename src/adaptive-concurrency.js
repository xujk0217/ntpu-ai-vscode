'use strict';
const { isServiceLimit } = require('./parallel-policy');
const MAX_SUBAGENTS = 4;
const clamp = value => Math.max(1, Math.min(4, Math.floor(Number(value) || 4)));
const median = values => { const sorted = values.slice().sort((a,b)=>a-b); return sorted[Math.floor(sorted.length / 2)]; };
class AdaptiveConcurrency {
  constructor({ now = Date.now, cooldownMs = 10000 } = {}) {
    this.now = now; this.cooldownMs = cooldownMs; this.ceiling = 4; this.limit = 2;
    this.samples = []; this.baseline = null; this.lastChange = -Infinity; this.blocked = false;
    this.reason = '從兩個請求開始，依多筆回應調整'; this.listeners = new Set(); this.decisions = [];
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { for (const listener of this.listeners) listener(); }
  configure(ceiling) { this.ceiling = clamp(ceiling); this.limit = Math.min(this.limit, this.ceiling); this.emit(); }
  change(limit, reason) {
    const previous = this.limit; this.limit = Math.min(this.ceiling, clamp(limit)); this.reason = reason;
    this.lastChange = this.now(); this.samples = [];
    this.decisions.push({ at: this.lastChange, from: previous, to: this.limit, reason }); this.decisions = this.decisions.slice(-20); this.emit();
  }
  block(error) { if (this.blocked) return; this.blocked = true; this.error = error; this.change(1, '服務限制或登入失效，已暫停新請求'); }
  resume() { this.blocked = false; this.error = null; this.baseline = null; this.change(1, '手動恢復，從單一請求重新觀察'); }
  observe({ success, firstTokenMs, durationMs, error, cancelled = false }) {
    if (isServiceLimit(error)) { this.block(error); return; }
    if (cancelled || this.blocked) return;
    const valid = success && Number.isFinite(firstTokenMs) && firstTokenMs >= 0 && Number.isFinite(durationMs) && durationMs >= firstTokenMs;
    const slow = valid && (firstTokenMs > Math.max(15000, (this.baseline?.firstTokenMs || 0) * 2.5) || durationMs > Math.max(90000, (this.baseline?.durationMs || 0) * 2.5));
    this.samples.push({ success, valid, slow, firstTokenMs, durationMs }); this.samples = this.samples.slice(-8);
    if (this.samples.length < 6 || this.now() - this.lastChange < this.cooldownMs) return;
    const failures = this.samples.filter(sample => !sample.success).length;
    const delays = this.samples.filter(sample => sample.slow).length;
    if (failures >= 2 || delays >= 3) { this.change(this.limit - 1, failures >= 2 ? '近期多筆網路錯誤，降低新請求名額' : '近期持續延遲，降低新請求名額'); return; }
    if (this.samples.length === 8 && failures === 0 && delays <= 1 && this.samples.every(sample => sample.valid)) {
      const healthy = this.samples.filter(sample => !sample.slow);
      this.baseline = { firstTokenMs: median(healthy.map(s=>s.firstTokenMs)), durationMs: median(healthy.map(s=>s.durationMs)) };
      this.change(this.limit + 1, this.limit < this.ceiling ? '連續八筆回應正常，逐步增加名額' : '回應穩定，維持目前名額');
    }
  }
  state() {
    const total = this.samples.length;
    return { adaptive: true, effectiveConcurrency: this.limit, ceiling: this.ceiling, workerConcurrency: MAX_SUBAGENTS,
      blocked: this.blocked, reason: this.reason, samples: total,
      successRate: total ? this.samples.filter(s=>s.success).length / total : null,
      firstTokenMs: this.baseline?.firstTokenMs ?? null, durationMs: this.baseline?.durationMs ?? null };
  }
}
module.exports = { AdaptiveConcurrency, MAX_SUBAGENTS };
