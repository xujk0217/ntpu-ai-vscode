'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { redact, sanitize } = require('../security/guard');
const { updateMemory, summarize } = require('./context');

class MemoryActions {
  constructor(app, vscode) { this.app = app; this.vscode = vscode; }
  async view() {
    const { app } = this; const config = this.vscode.workspace.getConfiguration('ntpuAI');
    app.post({ kind: 'memory', project: await app.store.project(app.session.workspace),
      tasks: (app.session.tasks || []).map(({ id, request, status, resolvedBy, result, pending, startedAt, endedAt }) => ({ id, request, status, resolvedBy, result, pending, startedAt, endedAt })),
      storage: app.store.directory, enabled: config.get('memory.enableProject', true), autoUpdate: config.get('memory.autoUpdate', true),
      reviewPaths: config.get('privacy.reviewPaths', []), error: app.persistenceError });
  }
  async confirm(text, detail = '') {
    return await this.vscode.window.showWarningMessage(text, { modal: true, detail }, '確認') === '確認';
  }
  async manageSessions(message) {
    const { app, vscode } = this;
    if (this.managingSessions) throw new Error('請先完成目前的聊天管理操作。');
    this.managingSessions = true;
    try {
      const action = message.kind === 'renameSession' ? 'rename' : message.kind === 'exportSession' ? 'export' : message.action;
      if (!['rename', 'export', 'archive', 'unarchive', 'delete'].includes(action)) throw new Error('不支援的聊天管理操作。');
      if (message.ids !== undefined && !Array.isArray(message.ids)) throw new Error('聊天選取格式無效。');
      const ids = [...new Set(message.ids || [message.id])];
      if (!ids.length || ids.some(id => !app.store.sessions.some(item => item.id === id))) throw new Error('找不到選取的聊天紀錄，請重新選取。');
      if (['rename', 'export'].includes(action) && ids.length !== 1) throw new Error('請選取一個聊天紀錄。');
      clearTimeout(app.saveTimer); await app.save();
      if (action === 'export') return await app.exportSession(ids[0]);
      if (action === 'rename') {
        const session = await app.store.openSession(ids[0]);
        const title = await vscode.window.showInputBox({ title: '重新命名聊天', value: session.title, validateInput: text => text.trim() ? undefined : '請輸入名稱' });
        if (!title?.trim()) return;
        if (app.busy() || app.gate.pending) throw new Error('請先停止目前任務，再管理聊天。');
        session.title = redact(title.trim().slice(0, 80)); await app.store.save(session); app.render(); return;
      }
      if (action === 'delete') {
        const titles = ids.slice(0, 5).map(id => '• ' + app.store.sessions.find(item => item.id === id).title).join('\n');
        if (!await this.confirm(`刪除 ${ids.length} 個本機聊天紀錄？`, titles + (ids.length > 5 ? '\n…' : '') + '\n只刪除選取聊天的歷史與檢查點，不修改專案檔案、Project Memory 或校方資料。既有備份仍會保留；建議先匯出或備份。')) return;
      }
      if (app.busy() || app.gate.pending) throw new Error('請先停止目前任務，再管理聊天。');
      try {
        for (const id of ids) {
          if (action === 'delete') await app.store.remove(id);
          else { const session = await app.store.openSession(id); session.archived = action === 'archive'; await app.store.save(session); }
        }
      } finally {
        if (!app.store.sessions.some(item => item.id === app.session.id)) {
          const next = app.store.sessions.find(item => item.workspace === app.session.workspace && !item.archived);
          app.session = next ? await app.store.openSession(next.id) : app.store.create(app.session.workspace);
          app.contextFiles = []; app.attachment = null; app.streamId = null; await app.refreshSkills();
        }
        await app.save(); app.render();
      }
    } finally { this.managingSessions = false; }
  }
  async handle(message) {
    const { app, vscode } = this;
    if (message.kind === 'memory') return this.view();
    if (app.busy() || app.gate.pending) throw new Error('請先停止目前任務，再管理記憶。');
    if (['renameSession', 'exportSession', 'sessionsAction', 'archiveSession', 'deleteSession'].includes(message.kind)) {
      if (message.kind === 'archiveSession') message = { ...message, action: app.store.sessions.find(item => item.id === message.id)?.archived ? 'unarchive' : 'archive' };
      if (message.kind === 'deleteSession') message = { ...message, action: 'delete' };
      return this.manageSessions(message);
    }
    if (message.kind === 'privacySetting') {
      if (!['memory.enableProject', 'memory.autoUpdate'].includes(message.key) || typeof message.value !== 'boolean') return;
      await vscode.workspace.getConfiguration('ntpuAI').update(message.key, message.value, vscode.ConfigurationTarget.Global);
    } else if (message.kind === 'editMemory') {
      const project = await app.store.project(app.session.workspace); const entry = project.entries.find(item => item.id === message.id);
      const kind = entry?.kind || await vscode.window.showQuickPick(['summary', 'architecture', 'decision', 'preference', 'pending', 'issue'], { title: '專案記憶類型' });
      if (!kind) return;
      const text = await vscode.window.showInputBox({ title: '編輯專案記憶', value: entry?.text || '', prompt: '會保存在本機；相關內容可用於後續模型請求，秘密會自動遮蔽。' });
      if (!text?.trim()) return;
      await app.store.updateProject(app.session.workspace, target => {
        const updated = { id: entry?.id || randomUUID(), kind, text: redact(text.trim()), stale: false, source: { userEditedAt: Date.now() } };
        target.entries = target.entries.filter(item => item.id !== updated.id).concat(updated);
      });
    } else if (message.kind === 'deleteMemory') {
      if (!await this.confirm('刪除這筆專案記憶？')) return;
      await app.store.updateProject(app.session.workspace, target => { target.entries = target.entries.filter(item => item.id !== message.id); });
    } else if (message.kind === 'clearMemory') {
      if (!await this.confirm('清空這個專案的本機 Project Memory？', 'Session 歷史、原始碼與校方資料不會被刪除。')) return;
      await app.store.updateProject(app.session.workspace, project => { project.entries = []; });
    } else if (message.kind === 'refreshMemory') {
      await app.store.updateProject(app.session.workspace, project => { project.taskRevisions = {}; });
      for (const metadata of app.store.sessions.filter(item => item.workspace === app.session.workspace)) {
        const session = await app.store.openSession(metadata.id);
        for (const task of session.tasks || []) await updateMemory(app.store, session, task);
        summarize(session); await app.store.save(session);
      }
    } else if (message.kind === 'resumeTask') {
      const task = app.session.tasks?.find(item => item.id === message.id);
      if (!task || task.status === 'completed') return;
      if (['build', 'plan', 'review', 'research', 'ask'].includes(task.agent)) app.session.options.agent = task.agent;
      app.session.checkpoint = sanitize({ taskId: task.id, request: task.taskRequest || task.request, records: task.records || [] });
      await app.ask('繼續 ' + task.request, false); return;
    } else if (message.kind === 'backupMemory') {
      await app.save();
      const directory = path.join(app.context.globalStorageUri.fsPath, 'exports'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = await vscode.window.showSaveDialog({ title: '備份全部本機記憶（遮蔽後）', defaultUri: vscode.Uri.file(path.join(directory, 'NTPU-memory-backup.json')), filters: { JSON: ['json'] } });
      if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(await app.store.backup(), null, 2)));
    } else if (message.kind === 'restoreMemory') {
      const files = await vscode.window.showOpenDialog({ title: '還原本機記憶備份', canSelectMany: false, filters: { JSON: ['json'] } });
      if (!files?.length) return;
      const stat = await fs.stat(files[0].fsPath); if (stat.size > 256 * 1024 * 1024) throw new Error('備份過大，請分批還原。');
      const backup = JSON.parse(await fs.readFile(files[0].fsPath, 'utf8'));
      if (!await this.confirm('匯入備份的 Sessions 與 Project Memory？', 'Session 將用新 ID 匯入，既有歷史不會覆蓋。')) return;
      await app.save(); await app.store.restore(backup); app.render();
    }
    await this.view();
  }
}
module.exports = { MemoryActions };
