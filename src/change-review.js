'use strict';
const { diffLines } = require('diff');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { hash, safePath } = require('./workspace');
const { sanitize } = require('./security/guard');

function hunks(before = '', after = '') {
  const result = []; let oldOffset = 0, newOffset = 0, current = null;
  const flush = () => {
    if (!current) return;
    current.id = hash(`${current.oldOffset}:${current.oldText}:${current.newText}`).slice(0, 24);
    current.line = after.slice(0, current.newOffset).split('\n').length;
    result.push(current); current = null;
  };
  for (const part of diffLines(before, after)) {
    if (!part.added && !part.removed) { flush(); oldOffset += part.value.length; newOffset += part.value.length; continue; }
    current ||= { oldOffset, newOffset, oldText: '', newText: '', added: 0, removed: 0 };
    if (part.added) { current.newText += part.value; current.added += part.count; newOffset += part.value.length; }
    if (part.removed) { current.oldText += part.value; current.removed += part.count; oldOffset += part.value.length; }
  }
  flush(); return result;
}

function groups(changes = []) {
  const map = new Map();
  for (const change of changes) {
    const id = change.groupId || change.id;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(change);
  }
  return [...map].map(([id, records]) => {
    const first = records[0], last = records.at(-1);
    const parts = last.binary ? [] : hunks(first.before || '', last.after || '');
    const acceptedHunks = last.acceptedHunks || [];
    return { id, path: first.path, taskId: first.taskId, before: first.before, after: last.after, afterHash: last.afterHash,
      created: first.created, binary: last.binary, saved: last.saved, records,
      reverted: records.every(record => record.reverted), protected: /\[REDACTED/.test(String(first.before) + String(last.after)),
      accepted: last.reviewState === 'accepted' || parts.length > 0 && parts.every(part => acceptedHunks.includes(part.id)),
      hunks: parts.map(part => ({ ...part, accepted: acceptedHunks.includes(part.id) })),
      added: parts.reduce((sum, part) => sum + part.added, 0), removed: parts.reduce((sum, part) => sum + part.removed, 0) };
  });
}

class ChangeReview {
  constructor(app, vscode) { this.app = app; this.vscode = vscode; this.applying = false; }
  capture(change) {
    const session = this.app.session; session.changes ||= [];
    const previous = groups(session.changes).reverse().find(group => !group.reverted && group.taskId === change.taskId && group.path === change.path && group.after === change.before);
    session.changes.push(sanitize({ ...change, groupId: previous?.id || change.id, reviewState: 'applied' }));
  }
  find(id) { return groups(this.app.session.changes).find(group => group.id === id); }
  view() {
    return groups(this.app.session.changes).map(({ records, before, after, ...group }) => ({ ...group,
      hunks: group.hunks.map(({ oldText, newText, oldOffset, newOffset, ...part }) => ({ ...part, before: oldText.slice(0, 4000), after: newText.slice(0, 4000), truncated: oldText.length > 4000 || newText.length > 4000 })) }));
  }
  async act({ id, action, hunkId }) {
    if (this.app.busy()) throw new Error('請等目前任務完成或停止後，再檢視變更。');
    if (this.applying) throw new Error('正在處理另一個變更，請稍候。');
    if (!['accept', 'revert'].includes(action)) return;
    const group = this.find(id); if (!group || group.reverted) return;
    const part = hunkId ? group.hunks.find(item => item.id === hunkId) : null;
    if (hunkId && !part) throw new Error('這段變更已更新，請重新檢視目前的 diff。');
    if (group.protected && action === 'revert') throw new Error('快照包含遮蔽內容，請在編輯器手動回復，避免覆蓋秘密。');
    this.applying = true;
    try {
      const root = this.app.workspace(); if (!root) throw new Error('請先開啟這個工作階段的專案。');
      const absolute = await safePath(root.uri.fsPath, group.path), uri = this.vscode.Uri.file(absolute);
      const document = group.binary ? null : await this.vscode.workspace.openTextDocument(uri);
      const current = group.binary ? await fs.readFile(absolute) : document.getText();
      if (hash(current) !== group.afterHash) throw new Error('檔案在 AI 修改後又有變動，本次沒有覆蓋檔案。請先在編輯器確認差異。');
      if (document && !document.isDirty && hash(await fs.readFile(absolute)) !== hash(current)) throw new Error('磁碟上的檔案已更新，本次沒有覆蓋檔案。請重新載入編輯器中的內容。');
      const last = group.records.at(-1);
      if (action === 'accept') {
        if (part) last.acceptedHunks = [...new Set([...(last.acceptedHunks || []), part.id])];
        else last.reviewState = 'accepted';
      } else {
        if (group.binary && !group.created) throw new Error('沒有二進位原始快照，請手動回復此檔案。');
        const next = part ? current.slice(0, part.newOffset) + part.oldText + current.slice(part.newOffset + part.newText.length) : group.before;
        if (group.created && (!part || next === '')) await this.vscode.workspace.fs.delete(uri, { useTrash: true });
        else {
          const edit = new this.vscode.WorkspaceEdit();
          edit.replace(uri, new this.vscode.Range(document.positionAt(0), document.positionAt(current.length)), next);
          if (!(await this.vscode.workspace.applyEdit(edit)) || !(await document.save())) throw new Error('無法儲存撤回結果，請在編輯器確認。');
        }
        if (!part || group.created && next === '' || !group.created && next === group.before) for (const record of group.records) record.reverted = true;
        else this.app.session.changes.push(sanitize({ id: randomUUID(), groupId: group.id, taskId: group.taskId, path: group.path,
          before: group.before, after: next, afterHash: hash(next), created: group.created, saved: true, binary: false,
          reviewState: 'applied', acceptedHunks: last.reviewState === 'accepted' ? group.hunks.map(item => item.id) : last.acceptedHunks || [] }));
      }
      this.app.postChanges(); await this.app.save();
    } finally { this.applying = false; }
  }
}
module.exports = { ChangeReview, hunks, groups };
