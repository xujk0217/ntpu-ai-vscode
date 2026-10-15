'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { safePath } = require('./workspace');

const SETTINGS_FILE = '.ntpu-ai.json';
const MAX_SETTINGS_BYTES = 16384;
const OPTION_VALUES = { agent: ['build', 'plan', 'review', 'research', 'ask'], permission: ['ask', 'assisted', 'full'], depth: ['quick', 'standard', 'deep'] };
const LABELS = { agent: { build: 'Build · 實作', plan: 'Plan · 規劃', review: 'Review · 審查', research: 'Research · 研究', ask: 'Ask · 問答' },
  depth: { quick: '快速', standard: '標準', deep: '深入' }, permission: { ask: '要求核准', assisted: '協助核准', full: '完整存取' } };
const FULL_ACCESS_NOTICE = '這個工作階段將自動修改工作區檔案、執行允許的終端機與內建工具。敏感資料與自訂 MCP 仍需確認。終端機與 MCP 以你的使用者權限執行。Plan／Review 的唯讀限制仍適用。';

function parseAgentSettings(text, knownSkills) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) throw new Error('Agent 設定檔最多 16 KB。');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('Agent 設定檔必須是有效的 JSON，請檢查括號、引號與逗號。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) throw new Error('Agent 設定檔需要 schemaVersion: 1。');
  const keys = Object.keys(data).filter(key => key !== 'schemaVersion');
  if (!keys.length || keys.some(key => !Object.hasOwn(OPTION_VALUES, key) && !['web', 'skills'].includes(key)))
    throw new Error('Agent 設定檔僅支援 agent、depth、permission、web、skills，且至少需指定一項。');
  const options = {};
  for (const key of keys) {
    const value = data[key];
    if (Object.hasOwn(OPTION_VALUES, key) && !OPTION_VALUES[key].includes(value)) throw new Error('Agent 設定檔的 ' + key + ' 選項不正確。');
    if (key === 'web' && typeof value !== 'boolean') throw new Error('web 必須是 true 或 false。');
    if (key === 'skills') {
      if (!Array.isArray(value) || value.length > 4 || value.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) || new Set(value).size !== value.length)
        throw new Error('skills 必須是最多四個不重複的有效 skill 名稱。');
      if (knownSkills && value.some(name => !knownSkills.has(name))) throw new Error('設定檔包含目前未安裝的 Skill；請先加入對應的 Skills 資料夾並重新掃描。');
    }
    options[key] = Array.isArray(value) ? [...value] : value;
  }
  return options;
}
function serializeAgentSettings(options) {
  const data = { schemaVersion: 1, agent: options.agent, depth: options.depth, permission: options.permission, web: options.web, skills: options.skills || [] };
  parseAgentSettings(JSON.stringify(data));
  return JSON.stringify(data, null, 2) + '\n';
}
function describeAgentSettings(options) {
  return `Agent：${LABELS.agent[options.agent]}\n分析深度：${LABELS.depth[options.depth]}\n核准模式：${LABELS.permission[options.permission]}\n網路搜尋：${options.web ? '開啟' : '關閉'}\n預載 Skills：${options.skills.length ? options.skills.join('、') : '無'}`;
}
async function readSettingsHandle(handle) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error('Agent 設定檔必須是最多 16 KB 的一般文字檔。');
  const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
    if (!chunk.bytesRead) break;
    bytesRead += chunk.bytesRead;
  }
  if (bytesRead > MAX_SETTINGS_BYTES) throw new Error('Agent 設定檔最多 16 KB。');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)); }
  catch { throw new Error('Agent 設定檔必須使用 UTF-8 編碼。'); }
}
async function readAgentSettings(file, knownSkills) {
  // Opening a named pipe must not hang the extension before we can reject it.
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try { return parseAgentSettings(await readSettingsHandle(handle), knownSkills); } finally { await handle.close(); }
}
async function saveAgentSettings(file, options, { createOnly = false } = {}) {
  const text = serializeAgentSettings(options);
  let existing;
  try { existing = await fs.lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && createOnly) return false;
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('請選擇一般設定檔，匯出不會覆寫符號連結或非一般檔案。');
    const handle = await fs.open(file, constants.O_RDWR | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== existing.dev || opened.ino !== existing.ino) throw new Error('設定檔已變更，請重新匯出。');
      parseAgentSettings(await readSettingsHandle(handle));
    } catch { throw new Error('既有檔案不是有效的 Agent 設定檔，請另選新檔案匯出。'); }
    finally { await handle.close(); }
  }
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
    if (existing) {
      const current = await fs.lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== existing.dev || current.ino !== existing.ino ||
          current.size !== existing.size || current.mtimeMs !== existing.mtimeMs) throw new Error('設定檔已變更，請重新匯出。');
      await fs.rename(temporary, file);
    } else {
      // Publish an already complete file without replacing a destination created
      // while the temporary file was being written.
      try { await fs.link(temporary, file); }
      catch (error) { if (createOnly && error.code === 'EEXIST') return false; throw error; }
    }
    return true;
  } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}

class AgentSettingsFiles {
  constructor(app, vscode) { this.app = app; this.vscode = vscode; this.operation = null; this.controller = null; }
  cancel() { this.controller?.abort(); }
  pick(operation) {
    const signal = this.controller.signal;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('已取消 Agent 設定檔操作。'));
      signal.addEventListener('abort', abort, { once: true });
      // Native dialogs have no cancellation API. Observe their eventual result,
      // but never let a late answer mutate state after Stop or deactivation.
      Promise.resolve(operation).then(value => finish(null, value), error => finish(error));
      if (signal.aborted) abort();
    });
  }
  assertIdle(session, options) {
    const app = this.app;
    if (this.controller?.signal.aborted) throw new Error('已取消 Agent 設定檔操作。');
    if (!this.vscode.workspace.isTrusted) throw new Error('請先信任目前工作區，再操作 Agent 設定檔。');
    if (app.busy() || app.gate.pending || app.changeReview?.applying || app.memoryActions?.managingSessions) throw new Error('請先完成目前任務、核准或檔案變更，再操作 Agent 設定檔。');
    if (session && (app.session !== session || JSON.stringify(session.options) !== options)) throw new Error('目前聊天或選項已改變，請重新操作 Agent 設定檔。');
  }
  async run(action) {
    if (this.operation) return this.operation;
    this.controller = new AbortController();
    this.operation = (async () => {
      await this.app.ready; this.assertIdle(); this.app.agentSettingsBusy = true; this.app.state();
      try { return await action(); } finally { this.app.agentSettingsBusy = false; this.app.state(); }
    })();
    try { return await this.operation; } finally { this.operation = null; this.controller = null; }
  }
  async projectUri() {
    if (!this.vscode.workspace.isTrusted) throw new Error('請先信任目前工作區，再操作專案 Agent 設定檔。');
    const root = this.app.workspace();
    if (!root || root.uri.scheme !== 'file') throw new Error('請先選擇本機專案資料夾。');
    return this.vscode.Uri.file(await safePath(root.uri.fsPath, SETTINGS_FILE));
  }
  async openProject() {
    return this.run(async () => {
      const uri = await this.projectUri();
      await saveAgentSettings(uri.fsPath, this.app.session.options, { createOnly: true });
      await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri));
      return uri;
    });
  }
  async exportFile() {
    return this.run(async () => {
      const options = structuredClone(this.app.session.options), root = this.app.workspace();
      const uri = await this.pick(this.vscode.window.showSaveDialog({ title: '匯出目前 Agent 設定', filters: { 'Agent 設定 JSON': ['json'] },
        defaultUri: root?.uri.scheme === 'file' ? this.vscode.Uri.file(path.join(root.uri.fsPath, 'agent.ntpu-ai.json')) : undefined }));
      if (!uri) return;
      if (uri.scheme !== 'file') throw new Error('請選擇本機 JSON 設定檔。');
      if (this.vscode.workspace.textDocuments?.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) throw new Error('請先儲存或關閉目的設定檔的未儲存變更，再匯出。');
      this.assertIdle(); await saveAgentSettings(uri.fsPath, options);
      await this.vscode.window.showTextDocument(await this.vscode.workspace.openTextDocument(uri));
      return uri;
    });
  }
  async importFile() {
    return this.run(async () => {
      const session = this.app.session, options = JSON.stringify(session.options);
      const root = this.app.workspace();
      const picked = await this.pick(this.vscode.window.showOpenDialog({ title: '套用 Agent 設定檔', canSelectMany: false, filters: { 'Agent 設定 JSON': ['json'] },
        defaultUri: root?.uri.scheme === 'file' ? this.vscode.Uri.file(path.join(root.uri.fsPath, SETTINGS_FILE)) : undefined }));
      if (!picked?.[0]) return false;
      const uri = picked[0]; if (uri.scheme !== 'file') throw new Error('請選擇本機 JSON 設定檔。');
      if (this.vscode.workspace.textDocuments?.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) throw new Error('請先儲存設定檔，再套用設定。');
      const patch = await readAgentSettings(uri.fsPath, this.app.skills.items);
      this.assertIdle(session, options);
      const next = { ...session.options, ...patch };
      const full = next.permission === 'full' && session.options.permission !== 'full';
      const accept = full ? '啟用完整存取並套用' : '套用設定';
      const answer = await this.app.gate.request({ title: Object.hasOwn(patch, 'permission') ? '套用 Agent 設定？核准模式影響所有聊天' : '套用 Agent 設定至目前聊天？',
        detail: describeAgentSettings(next) + (Object.hasOwn(patch, 'permission') ? '\n\n核准模式會保存並套用至所有聊天；其他選項只套用目前聊天。' : '') + (full ? '\n\n' + FULL_ACCESS_NOTICE : ''), accept }, this.controller.signal);
      if (answer !== accept) return false;
      this.assertIdle(session, options);
      const before = session.options;
      session.options = next;
      this.app.policies.delete(session.id);
      let saved = false;
      try {
        await this.app.save(); saved = true;
        if (Object.hasOwn(patch, 'permission')) await this.app.savePermissionMode(next.permission);
      }
      catch (error) {
        session.options = before;
        if (saved) {
          try { await this.app.save(); }
          catch { throw new Error('全域核准設定保存失敗，聊天選項也無法回復保存；請檢查本機儲存空間後重試。'); }
        }
        this.app.state(); throw error;
      }
      this.app.state(); this.app.capabilities(); return true;
    });
  }
}
module.exports = { SETTINGS_FILE, MAX_SETTINGS_BYTES, OPTION_VALUES, FULL_ACCESS_NOTICE, parseAgentSettings, serializeAgentSettings, describeAgentSettings, readAgentSettings, saveAgentSettings, AgentSettingsFiles };
