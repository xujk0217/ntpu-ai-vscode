'use strict';
const { parseTree, findNodeAtLocation } = require('jsonc-parser');
const { redact } = require('./security/guard');

// Resource limits reject explicitly; they never silently shorten saved output.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
function validateOutputPart(part) {
  if (!part || typeof part.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(part.id) ||
      !Number.isSafeInteger(part.index) || part.index < 1 || typeof part.message !== 'string' || !part.message.length ||
      typeof part.done !== 'boolean' || part.completed !== undefined && typeof part.completed !== 'boolean') {
    throw new Error('分段回覆需要有效的 id、連續 index、非空 message 與布林 done。');
  }
  return part;
}

// Parse only top-level user-facing text. A damaged tool envelope is never executable.
function partialOutput(text, { allowComplete = false } = {}) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '');
  if (!raw.startsWith('{')) return null;
  const errors = [], tree = parseTree(raw, errors);
  const field = name => findNodeAtLocation(tree, [name])?.value;
  if (!['final', 'output'].includes(field('kind')) || typeof field('message') !== 'string') return null;
  if (!errors.length && !allowComplete) return null;
  const message = field('message');
  // Never preserve a dangling surrogate introduced by a cut Unicode escape.
  return message ? { kind: field('kind'), message: redact(message.replace(/[\uD800-\uDBFF]$/, '')), id: field('id'), index: field('index') } : null;
}

class OutputParts {
  constructor(records = []) {
    this.parts = records.filter(record => record.type === 'output_part' && !record.partial).map(record => {
      validateOutputPart(record); return { id: record.id, index: record.index, message: record.message, done: record.done, completed: record.completed };
    });
    this.bytes = 0;
    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      if (part.index !== i + 1 || part.id !== this.parts[0].id || i && this.parts[i - 1].done) throw new Error('已保存的分段順序不正確；原始資料已保留。');
      this.bytes += Buffer.byteLength(part.message);
    }
    const draft = [...records].reverse().find(record => record.type === 'output_draft');
    this.draft = draft && draft.index === this.parts.length + 1 ? draft : null;
  }
  get text() { return this.parts.map(part => part.message).join(''); }
  get active() { return this.parts.length > 0 || !!this.draft; }
  get done() { return this.parts.at(-1)?.done === true; }
  get nextIndex() { return this.parts.length + 1; }
  preview(message) { return this.text + redact(message || ''); }
  accept(part) {
    validateOutputPart(part);
    if (this.done || part.index !== this.nextIndex || this.parts.length && part.id !== this.parts[0].id ||
        !this.parts.length && this.draft?.id && part.id !== this.draft.id) throw new Error('分段 id 或 index 不符；請只接續下一段，不重送或省略內容。');
    const clean = { id: part.id, index: part.index, message: redact(part.message), done: part.done, completed: part.completed };
    const bytes = Buffer.byteLength(clean.message);
    if (this.bytes + bytes > MAX_OUTPUT_BYTES) throw Object.assign(new Error('分段回覆超過 8 MiB 本機保存上限；已保存的原文保留，請另開文件接續。'), { code: 'OUTPUT_TOO_LARGE' });
    this.parts.push(clean); this.bytes += bytes; this.draft = null;
    return { type: 'output_part', ...clean };
  }
  preserveDraft(text) {
    const partial = partialOutput(text, { allowComplete: true });
    if (!partial?.message || partial.kind !== 'output' || this.done) return null;
    const id = this.parts[0]?.id || this.draft?.id || (typeof partial.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(partial.id) ? partial.id : 'response');
    if (partial.index !== undefined && partial.index !== this.nextIndex || partial.id !== undefined && partial.id !== id) return null;
    if (this.bytes + Buffer.byteLength(partial.message) > MAX_OUTPUT_BYTES) return null;
    this.draft = { type: 'output_draft', id, index: this.nextIndex, message: partial.message, partial: true, done: false };
    return this.draft;
  }
  promptState() {
    if (!this.active) return null;
    const last = this.parts.at(-1);
    return { id: last?.id || this.draft.id, nextIndex: this.nextIndex, savedParts: this.parts.length, savedCharacters: this.text.length, done: this.done,
      previousTail: last?.message.slice(-1800) || '', draft: this.draft?.message.slice(0, 2000),
      instruction: this.draft ? 'The unfinished draft was saved locally but is NOT committed. Regenerate ONLY this next part from its beginning, using a smaller complete JSON output object. Keep all detail, never summarize. Do not repeat committed parts.' :
        this.done ? 'All output parts are saved. If verification is satisfied, return a short final envelope; the host retains the complete document.' :
          'Continue ONLY the next output part with this exact id and nextIndex. Append exact remaining content, including required whitespace; never repeat, summarize, or replace committed parts. End with done:true only when the full requested document is complete.' };
  }
}
module.exports = { MAX_OUTPUT_BYTES, validateOutputPart, partialOutput, OutputParts };
