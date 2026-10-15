'use strict';
const KEY = 'ntpuAI.approvalMode.v1';
const MODES = new Set(['ask', 'assisted', 'full']);

// This value lives in VS Code's local global state, outside project files and
// imported session backups. Only the existing user selection/approval flows set it.
class ApprovalPreferences {
  constructor(storage, onChange = () => {}) {
    this.storage = storage; this.onChange = onChange;
    this.mode = this.read(); this.tail = Promise.resolve(); this.saving = false; this.failed = false;
  }
  read() { const saved = this.storage.get(KEY, 'ask'); return MODES.has(saved) ? saved : 'ask'; }
  refresh() {
    if (this.saving || this.failed) return;
    const mode = this.read();
    if (mode !== this.mode) { this.mode = mode; this.onChange(mode); }
  }
  set(mode) {
    if (!MODES.has(mode)) return Promise.reject(new Error('核准模式不正確。'));
    const operation = this.tail.catch(() => {}).then(async () => {
      this.saving = true;
      try {
        await this.storage.update(KEY, mode);
        this.mode = mode; this.failed = false; this.onChange(mode);
      } catch (error) { this.failed = true; throw error; }
      finally { this.saving = false; }
    });
    this.tail = operation; return operation;
  }
}
module.exports = { ApprovalPreferences, APPROVAL_MODE_KEY: KEY };
