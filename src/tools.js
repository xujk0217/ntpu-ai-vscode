'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { PermissionPolicy } = require('./permissions');
const { DEFINITIONS } = require('./protocol');
const { fetchPublic, pageText, publicTarget } = require('./network');
const { parseSkill } = require('./skills');
const { imageMime, renderSvg } = require('./visuals');
const { MAX_FILE_BYTES, EXCLUDES, hash, isBlocked, safePath, diskText, numberedLines, fullyRead } = require('./workspace');
const { classifyPath, classifyContent, sanitize, redact, inspectOutboundPayload } = require('./security/guard');
const { scanner } = require('./security/attachments');
const { SandboxExecutor } = require('./security/sandbox');

class PreviewProvider {
  constructor() { this.documents = new Map(); }
  provideTextDocumentContent(uri) { return this.documents.get(uri.toString()) || ''; }
  put(label, content) {
    const uri = vscode.Uri.from({ scheme: 'ntpu-ai-preview', path: '/' + label, query: randomUUID() });
    this.documents.set(uri.toString(), content);
    return uri;
  }
  remove(uri) { this.documents.delete(uri.toString()); }
}

class WorkspaceTools {
  constructor(root, previews, signal, onActivity, onApproval, options = {}) {
    this.root = root;
    this.previews = previews;
    this.signal = signal;
    this.onActivity = onActivity;
    this.onApproval = onApproval;
    this.options = options;
    this.policy = options.policy || new PermissionPolicy();
    this.skills = options.skills;
    this.loadedSkills = new Map();
    for (const name of options.selectedSkills || []) {
      try { this.loadedSkills.set(name, this.skills.load(name)); } catch {}
    }
    this.snapshots = new Map();
    this.sandbox = options.sandbox || new SandboxExecutor(); this.approvedData = new Set();
  }

  catalog() {
    return DEFINITIONS.filter(tool => this.options.web !== false || !['web_search', 'web_fetch', 'download_file'].includes(tool.name))
      .concat((this.options.mcp?.catalog() || []).filter(tool => this.options.web !== false || tool.server !== 'exa')).slice(0, 40);
  }

  parallelNames() { return this.options.parallel ? require('./parallel').batchNames(this.catalog()) : new Set(); }

  async authorize(name, args, detail = {}) {
    const metadata = name === 'ntpu_lookup' ? { external: true, readOnly: true, server: 'ntpu_ai4x' } : this.options.mcp?.tools.get(name) || {};
    const policyDecision = this.policy.decision(name, args, metadata);
    const decision = metadata.external && metadata.server !== 'exa' && policyDecision !== 'deny' ? 'ask' : policyDecision;
    if (decision === 'deny') return false;
    if (decision === 'allow') return true;
    if (!this.onApproval) return false;
    this.onActivity('等待核准：' + (detail.title || name));
    const accept = detail.accept || '允許這次操作';
    const answer = await this.onApproval({ title: detail.title || '確認工具操作 ' + name,
      detail: detail.detail || JSON.stringify(args, null, 2).slice(0, 4000), accept, tool: name, ...detail }, this.signal);
    this.checkStopped();
    if (answer === accept) this.onActivity('正在執行工具');
    return answer === accept;
  }

  checkStopped() { if (this.signal.aborted) throw new Error('已停止'); }

  async text(absolute) {
    await safePath(this.root.fsPath, path.relative(this.root.fsPath, absolute));
    const uri = vscode.Uri.file(absolute);
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (open) {
      const content = open.getText();
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('檔案過大，請選取需要的片段。');
      return content;
    }
    return diskText(absolute);
  }

  async execute(name, args) {
    this.checkStopped();
    if (!vscode.workspace.isTrusted) throw new Error('請先信任目前的 VS Code 工作區。');
    const methods = {
      list_files: () => this.list(args), read_file: () => this.read(args), search_text: () => this.search(args),
      write_file: () => this.write(args), edit_file: () => this.edit(args), run_command: () => this.command(args),
      update_plan: () => this.plan(args), ask_user: () => this.question(args), load_skill: () => this.skill(args),
      get_capabilities: () => this.getCapabilities(), refresh_skills: () => this.refreshSkills(),
      install_skill: () => this.installSkill(args), connect_mcp: () => this.connectMcp(args), add_mcp: () => this.addMcp(args), download_file: () => this.download(args),
      ntpu_lookup: () => this.options.mcp.lookup(args, this.signal), web_search: () => this.webSearch(args), web_fetch: () => this.webFetch(args),
      inspect_image: () => this.inspect(args), create_visual: () => this.visual(args),
    };
    const mcpTool = this.options.mcp?.tools?.get(name);
    if (!methods[name] && !mcpTool) throw new Error('未知工具。');
    if (this.options.web === false && (['web_search', 'web_fetch', 'download_file'].includes(name) || name === 'install_skill' && typeof args.url === 'string' || mcpTool?.server === 'exa')) return { ok: false, denied: true, error: '這個工作階段未啟用公開網路工具；請先開啟輸入框旁的地球按鈕。' };
    if (this.policy.decision(name, args, mcpTool) === 'deny') return { ok: false, denied: true, error: '目前 agent 模式禁止這個操作。' };
    try {
      if (!['write_file', 'edit_file', 'run_command', 'create_visual', 'install_skill', 'connect_mcp', 'add_mcp', 'download_file'].includes(name) && !(await this.authorize(name, args))) return { ok: false, denied: true, message: '使用者未批准這次操作。' };
      return sanitize(methods[name] ? await methods[name]() : await this.options.mcp.call(name, inspectOutboundPayload(args, { reject: true }), this.signal));
    }
    catch (error) { if (this.signal.aborted) throw error; return sanitize({ ok: false, error: error.message }); }
  }

  async files(glob = '**/*', limit = 250) {
    if (typeof glob !== 'string' || glob.length > 300 || glob.includes('..') || path.isAbsolute(glob)) throw new Error('glob 必須是工作區內的相對樣式。');
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, glob), EXCLUDES, limit, this.signalToken());
    const allowed = [];
    for (const uri of uris) {
      this.checkStopped();
      const relative = path.relative(this.root.fsPath, uri.fsPath).replaceAll(path.sep, '/');
      if (isBlocked(relative)) continue;
      try { await safePath(this.root.fsPath, relative); allowed.push({ uri, relative }); } catch {}
    }
    return allowed;
  }

  signalToken() {
    const signal = this.signal;
    return { get isCancellationRequested() { return signal.aborted; }, onCancellationRequested: listener => {
      signal.addEventListener('abort', listener, { once: true });
      return { dispose: () => signal.removeEventListener('abort', listener) };
    } };
  }

  async list(args) {
    this.onActivity('列出專案檔案');
    const files = await this.files(args.glob);
    return { ok: true, files: files.map(file => file.relative), limit: 250, possibly_truncated: files.length >= 250 };
  }

  async read(args) {
    await this.reviewData(args.path);
    const absolute = await safePath(this.root.fsPath, args.path);
    this.onActivity('讀取 ' + args.path);
    const text = await this.text(absolute);
    const lines = numberedLines(text, args.start_line ?? 1, args.end_line, 18000);
    const digest = hash(text);
    let snapshot = this.snapshots.get(absolute);
    if (!snapshot || snapshot.hash !== digest) snapshot = { hash: digest, ranges: [], totalLines: lines.total_lines };
    if (lines.end_line >= lines.start_line) snapshot.ranges.push([lines.start_line, lines.end_line]);
    this.snapshots.set(absolute, snapshot);
    snapshot.sensitive = classifyContent(text).detected;
    return { ok: true, path: args.path, ...lines,
      ...(lines.truncated ? { hint: '內容超過本輪上限，使用行號分段 read_file 取得其餘內容。' } : {}) };
  }

  async search(args) {
    if (typeof args.query !== 'string' || !args.query || args.query.length > 200) throw new Error('query 必須是 1–200 字的文字。');
    this.onActivity('搜尋 ' + args.query);
    const files = await this.files(args.glob, 120);
    const matches = [];
    for (const { uri, relative } of files) {
      this.checkStopped();
      try { await this.reviewData(relative); } catch { continue; }
      let text;
      try { text = await this.text(uri.fsPath); } catch { continue; }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].includes(args.query)) matches.push({ path: relative, line: index + 1, text: lines[index].slice(0, 300) });
        if (matches.length >= 40) return { ok: true, matches, truncated: true };
      }
    }
    return { ok: true, matches, searched_files: files.length, file_limit: 120 };
  }

  async write(args, internal = {}) {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_FILE_BYTES || args.content.includes('\0')) {
      throw new Error('content 必須是完整文字檔內容，最多 160 KB。');
    }
    const absolute = await safePath(this.root.fsPath, args.path);
    let before = '', exists = true;
    try { before = await this.text(absolute); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
    if (exists && !this.snapshots.has(absolute)) throw new Error('請先 read_file 讀取這個既有檔案，再提出修改。');
    if (exists && classifyContent(before).detected) throw new Error('這個檔案含已遮蔽的秘密，為避免覆蓋憑證，請在編輯器手動修改。');
    if (exists && this.snapshots.get(absolute).hash !== hash(before)) throw new Error('檔案已被其他操作修改，請重新 read_file 後再提出修改。');
    if (exists && !fullyRead(this.snapshots.get(absolute)) && !internal.partialVerified) throw new Error('尚未讀完這個檔案。請以 read_file 分段讀取其餘行數，或用 edit_file 精確替換已讀取的區段。');
    if (before === args.content && exists) return { ok: true, path: args.path, changed: false };
    const decision = this.policy.decision(internal.partialVerified ? 'edit_file' : 'write_file', args) === 'allow' ? '套用並儲存' :
      await this.review(this.previews.put('before/' + args.path, before), this.previews.put('after/' + args.path, args.content), args.path, internal.partialVerified ? 'edit_file' : 'write_file');
    this.checkStopped();
    if (decision !== '套用並儲存') return { ok: false, denied: true, path: args.path, message: '使用者未批准這次修改。' };
    await safePath(this.root.fsPath, args.path);
    let current = '', stillExists = true;
    try { current = await this.text(absolute); } catch (error) { if (error.code === 'ENOENT') stillExists = false; else throw error; }
    if (exists !== stillExists || hash(current) !== hash(before)) throw new Error('預覽期間檔案已改變，本次修改未套用。請重新讀取。');
    const uri = vscode.Uri.file(absolute);
    const edit = new vscode.WorkspaceEdit();
    if (stillExists) {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), args.content);
    } else {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await safePath(this.root.fsPath, args.path);
      edit.createFile(uri, { overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), args.content);
    }
    this.checkStopped();
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code 無法套用這次修改。');
    const doc = await vscode.workspace.openTextDocument(uri);
    const saved = await doc.save();
    this.snapshots.delete(absolute);
    this.options.onChange?.(sanitize({ id: randomUUID(), path: args.path, before: exists ? before : null,
      after: doc.getText(), afterHash: hash(doc.getText()), created: !exists, saved, binary: false }));
    this.onActivity((saved ? '已儲存 ' : '已套用但尚未儲存 ') + args.path);
    return { ok: saved, applied: true, saved, created: !exists, path: args.path,
      ...(saved ? {} : { error: '修改已套用到編輯器，但儲存失敗；請在編輯器確認。' }) };
  }

  async review(base, next, relative, tool = 'write_file') {
    this.onActivity('等待確認修改 ' + relative);
    await vscode.commands.executeCommand('vscode.diff', base, next, 'NTPU AI 修改：' + relative, { preview: true });
    const detail = { title: '確認修改 ' + relative, detail: '查看編輯器中的 diff，再決定是否套用並儲存。', accept: '套用並儲存', tool };
    const decision = this.onApproval ? await this.onApproval(detail, this.signal) :
      await vscode.window.showInformationMessage(`NTPU AI 提議修改 ${relative}。請查看 diff 後選擇。`, '套用並儲存', '拒絕');
    // Keep contents as long as their diff remains open; extension lifetime is bounded.
    return decision;
  }

  async edit(args) {
    if (typeof args.old_text !== 'string' || !args.old_text || typeof args.new_text !== 'string') throw new Error('edit_file 需要非空 old_text 與文字 new_text。');
    const absolute = await safePath(this.root.fsPath, args.path);
    const before = await this.text(absolute);
    const snapshot = this.snapshots.get(absolute);
    if (!snapshot || snapshot.hash !== hash(before)) throw new Error('請先 read_file 取得目前檔案内容。');
    const first = before.indexOf(args.old_text);
    if (first < 0 || before.indexOf(args.old_text, first + args.old_text.length) >= 0) throw new Error('old_text 必須恰好匹配一次，請補充上下文。');
    const start = before.slice(0, first).split('\n').length;
    const end = start + args.old_text.split('\n').length - 1;
    for (let line = start; line <= end; line++) if (!snapshot.ranges.some(([a, b]) => line >= a && line <= b)) throw new Error('要替換的區段尚未被讀取，請先 read_file。');
    return this.write({ path: args.path, content: before.slice(0, first) + args.new_text + before.slice(first + args.old_text.length) }, { partialVerified: true });
  }

  async plan(args) {
    if (!Array.isArray(args.steps) || args.steps.length > 15 || args.steps.some(step => typeof step.title !== 'string' || !['pending', 'in_progress', 'completed'].includes(step.status))) throw new Error('plan 需要最多 15 個有效步驟。');
    const steps = args.steps.map(step => ({ title: step.title.slice(0, 160), status: step.status }));
    this.options.onPlan?.(steps); return { ok: true, steps };
  }
  async question(args) {
    if (typeof args.question !== 'string' || !args.question.trim()) throw new Error('缺少問題。');
    this.onActivity('等待你的回答');
    const answer = await this.onApproval({ type: 'question', title: args.question.slice(0, 500),
      detail: '選擇一個選項，或輸入自己的回答。', options: Array.isArray(args.options) ? args.options.slice(0, 5).map(String) : [], accept: '送出回覆' }, this.signal);
    this.checkStopped(); return { ok: !!answer, answer: answer || '', ...(answer ? {} : { denied: true }) };
  }
  async skill(args) {
    const skill = this.skills?.load(args.name);
    if (!skill) throw new Error('沒有可用的 skills catalog。');
    this.loadedSkills.set(skill.name, skill); this.options.onSkill?.(skill.name);
    return { ok: true, name: skill.name, instructions: skill.body };
  }
  getCapabilities() {
    return { ok: true, workspace: path.basename(this.root.fsPath), workspaceScoped: true,
      networkSearchEnabled: this.options.web !== false, mcp: this.options.mcp?.states?.() || [],
      tools: this.catalog().map(({ name, server, description }) => ({ name, server, description })),
      skills: this.skills?.list?.() || [], limits: { downloadBytes: 10 * 1024 * 1024,
        downloadedFilesAreExecuted: false, skillInstallLocation: '.agents/skills/<name>/SKILL.md' } };
  }
  async refreshSkills() {
    if (!this.skills || !this.root?.fsPath) throw new Error('沒有可重新掃描的 Skills catalog 或工作區。');
    await this.skills.discover(this.root.fsPath);
    this.options.onCatalogChange?.();
    return { ok: true, skills: this.skills.list(), errors: this.skills.errors };
  }
  async installSkill(args) {
    if (!this.skills || !this.root?.fsPath) throw new Error('沒有可安裝 Skills 的工作區。');
    if (typeof args.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.name) ||
        (typeof args.content === 'string') === (typeof args.url === 'string')) throw new Error('請提供有效名稱，並且只提供 SKILL.md 的 content 或公開 HTTPS url 其中一種。');
    let text = args.content;
    if (typeof args.url === 'string') {
      inspectOutboundPayload({ url: args.url }, { reject: true });
      if (!args.url.startsWith('https://')) throw new Error('Skills 來源只接受公開 HTTPS 網址。');
      const response = await (this.options.fetchPublic || fetchPublic)(args.url, this.signal);
      text = response.body;
    }
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 24000) throw new Error('SKILL.md 必須是最多 24 KB 的文字。');
    inspectOutboundPayload({ content: text }, { reject: true });
    const parsed = parseSkill(text, args.name);
    if (parsed.name !== args.name) throw new Error('SKILL.md 內的 name 必須與指定名稱一致。');
    if (this.skills.items.has(args.name)) throw new Error('同名 skill 已存在；請先用新的名稱安裝，避免覆蓋內建或既有指引。');
    const relative = `.agents/skills/${args.name}/SKILL.md`;
    const absolute = await safePath(this.root.fsPath, relative);
    try { await fs.access(absolute); throw new Error('目標 SKILL.md 已存在，為避免覆蓋不會安裝。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const detail = `來源：${args.url || '提供的 SKILL.md 內容'}\n安裝位置：${relative}\n名稱：${parsed.name}\n說明：${parsed.description}\n\nSkills 是不可信任的任務指引，不能授予權限或覆蓋主機規則。`;
    const answer = await this.onApproval?.({ title: '安裝 Skill：' + parsed.name, detail, accept: '安裝 Skill' }, this.signal);
    this.checkStopped();
    if (answer !== '安裝 Skill') return { ok: false, denied: true, message: '使用者未批准安裝。' };
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await safePath(this.root.fsPath, relative);
    await fs.writeFile(absolute, text, { flag: 'wx', mode: 0o600 });
    await this.skills.discover(this.root.fsPath);
    const skill = this.skills.load(args.name);
    this.loadedSkills.set(skill.name, skill); this.options.onSkill?.(skill.name); this.options.onCatalogChange?.();
    this.options.onChange?.({ id: randomUUID(), path: relative, before: null, after: text, afterHash: hash(text), created: true, saved: true, binary: false });
    return { ok: true, saved: true, created: true, path: relative, name: skill.name, description: skill.description };
  }
  async connectMcp(args) {
    if (typeof args.name !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(args.name)) throw new Error('需要已設定的 MCP 名稱。');
    const manager = this.options.mcp;
    const config = [...(manager?.connections?.values?.() || [])].map(item => item.config).find(item => item.name === args.name) ||
      [...(this.options.servers || []), ...(this.options.builtins || [])].find(item => item.name === args.name);
    if (!config || typeof this.options.connectMcp !== 'function') throw new Error('這個 MCP 尚未設定。請先在工具與設定 → 新增 MCP 完成設定，再要求我連接。');
    const target = config.type === 'stdio' ? `${config.command} ${(config.args || []).join(' ')}` : config.url;
    const answer = await this.onApproval?.({ title: '連接 MCP：' + (config.label || config.name),
      detail: `MCP：${config.name}\n連線目標：${target}\n連線後此伺服器會提供工具，後續外部工具呼叫仍依權限核准。憑證不會顯示或匯出。`,
      accept: '連接 MCP' }, this.signal);
    this.checkStopped();
    if (answer !== '連接 MCP') return { ok: false, denied: true, message: '使用者未批准連接。' };
    await this.options.connectMcp(config);
    return { ok: true, name: config.name, tools: manager.catalog().filter(tool => tool.server === config.name).map(({ name, originalName, description, inputSchema }) => ({ name, originalName, description, inputSchema })) };
  }
  async addMcp(args) {
    if (typeof args.name !== 'string' || !/^[a-zA-Z0-9_-]{1,48}$/.test(args.name) || typeof args.url !== 'string') throw new Error('需要有效的 MCP 名稱與公開 HTTPS 網址。');
    if (typeof this.options.addMcp !== 'function' || !this.options.mcp) throw new Error('目前工作階段不能新增 MCP。');
    if ([...(this.options.servers || []), ...(this.options.builtins || [])].some(server => server.name === args.name)) throw new Error('同名 MCP 已設定。');
    inspectOutboundPayload({ url: args.url }, { reject: true });
    const config = { name: args.name, label: args.name, type: 'http', url: args.url, agentAdded: true, readOnly: false };
    const target = await (this.options.publicTarget || publicTarget)(args.url);
    if (target.url.protocol !== 'https:') throw new Error('新增 MCP 僅接受公開 HTTPS endpoint。');
    const answer = await this.onApproval?.({ title: '新增並連接 MCP：' + config.name,
      detail: `公開 HTTPS endpoint：${target.url.origin}${target.url.pathname}\n此 MCP 不包含登入憑證。連線會先驗證公開 DNS 目標並固定每次請求的解析結果。工具呼叫仍依權限核准。需要 API 金鑰的 server 請改從設定頁新增，讓金鑰存入 SecretStorage。`,
      accept: '新增並連接 MCP' }, this.signal);
    this.checkStopped();
    if (answer !== '新增並連接 MCP') return { ok: false, denied: true, message: '使用者未批准新增 MCP。' };
    await this.options.addMcp(config);
    return { ok: true, name: config.name, tools: this.options.mcp.catalog().filter(tool => tool.server === config.name).map(({ name, originalName, description, inputSchema }) => ({ name, originalName, description, inputSchema })) };
  }
  async download(args) {
    inspectOutboundPayload({ url: args.url }, { reject: true });
    if (typeof args.url !== 'string' || !args.url.startsWith('https://')) throw new Error('檔案下載只接受公開 HTTPS 網址。');
    if (typeof args.path !== 'string' || !args.path.trim() || args.path.endsWith('/') || args.path.includes('\\')) throw new Error('path 必須是工作區中的新檔案相對路徑。');
    const absolute = await safePath(this.root.fsPath, args.path);
    try { await fs.access(absolute); throw new Error('目標檔案已存在，為避免覆蓋不會下載。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!(await this.authorize('download_file', { url: args.url, path: args.path }, {
      title: '確認下載公開檔案', detail: `網址：${args.url}\n存入：${args.path}\n最多 10 MB；不解壓、不執行。` }))) return { ok: false, denied: true, message: '使用者未批准下載。' };
    const response = await (this.options.fetchPublic || fetchPublic)(args.url, this.signal, 0, { binary: true, maxBytes: 10 * 1024 * 1024 });
    this.checkStopped();
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await safePath(this.root.fsPath, args.path);
    const handle = await fs.open(absolute, 'wx', 0o600);
    try { await handle.writeFile(response.body); } catch (error) { await handle.close().catch(() => {}); await fs.rm(absolute, { force: true }).catch(() => {}); throw error; }
    await handle.close();
    this.options.onChange?.({ id: randomUUID(), path: args.path, before: null, after: null, afterHash: hash(response.body), created: true, saved: true, binary: true, mimeType: response.mime });
    this.onActivity('已下載 ' + args.path);
    return { ok: true, saved: true, created: true, path: args.path, bytes: response.body.length, mimeType: response.mime, url: response.url, executed: false };
  }
  async webSearch(args) {
    inspectOutboundPayload(args, { reject: true });
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) throw new Error('搜尋 query 需要 1–1000 字。');
    if (!this.options.mcp) throw new Error('MCP 尚未初始化。');
    return this.options.mcp.search(args.query, this.signal);
  }
  async webFetch(args) {
    inspectOutboundPayload(args, { reject: true });
    if (typeof args.url !== 'string') throw new Error('需要公開網址。');
    const page = await fetchPublic(args.url, this.signal);
    const content = page.mime.includes('html') ? pageText(page.body) : page.body;
    return { ok: true, url: page.url, content: content.slice(0, 18000), truncated: content.length > 18000 };
  }
  async inspect(args) {
    await this.reviewData(args.path, true);
    const absolute = await safePath(this.root.fsPath, args.path);
    const stat = await fs.stat(absolute);
    if (stat.size > 8 * 1024 * 1024) throw new Error('圖片／PDF 工具上限 8 MB。');
    const buffer = await fs.readFile(absolute);
    const mimeType = buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : imageMime(buffer);
    await scanner.scan(buffer, mimeType);
    if (!this.options.bridge) throw new Error('圖片分析需要已登入的 NTPU AI 瀏覽器。');
    const result = await this.options.bridge.chat('請依附上的真實圖片回答：' + String(args.question || '描述圖片內容，指出可觀察到的細節。').slice(0, 2000),
      { signal: this.signal, newConversation: false, attachment: { name: path.basename(absolute), mimeType, buffer, approved: true }, timeoutMs: 240000 });
    return { ok: true, path: args.path, analysis: result.text.slice(0, 16000) };
  }
  async visual(args) {
    if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.png')) throw new Error('create_visual 需要 .png 相對路徑。');
    const absolute = await safePath(this.root.fsPath, args.path);
    try { await fs.access(absolute); throw new Error('輸出圖片已存在，請選擇新的檔名。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const buffer = await renderSvg(args.svg, args.width || 1024, args.height || 768);
    const artifact = await this.options.onArtifact?.({ buffer, mimeType: 'image/png', title: args.path, preview: true });
    if (!(await this.authorize('create_visual', args, { title: '確認產生圖檔 ' + args.path,
      detail: `PNG · ${buffer.length} bytes\n${args.width || 1024} × ${args.height || 768}`, accept: '儲存圖片', previewUri: artifact?.uri }))) return { ok: false, denied: true };
    this.checkStopped();
    await fs.mkdir(path.dirname(absolute), { recursive: true }); await safePath(this.root.fsPath, args.path);
    await fs.writeFile(absolute, buffer, { flag: 'wx' });
    this.options.onChange?.({ id: randomUUID(), path: args.path, before: null, after: null, afterHash: hash(buffer), created: true, saved: true, binary: true });
    return { ok: true, path: args.path, bytes: buffer.length, artifact: artifact?.id };
  }

  async command(args) {
    inspectOutboundPayload(args, { reject: true });
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 2000) throw new Error('command 必須是 1–2000 字的完整指令。');
    const cwd = await safePath(this.root.fsPath, args.cwd || '.');
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd 必須是工作區內的資料夾。');
    this.onActivity('準備執行指令');
    const approvalInfo = this.policy.commandExplanation(args.command);
    const detail = { title: '確認執行指令', detail: args.command + `\n\n工作目錄：${cwd}\n${approvalInfo.reason}\nOS 沙箱限制工作區與執行期資料，禁止網路與憑證存取，最多 60 秒；無法啟動隔離時停止執行。`, accept: '執行這次指令', tool: 'run_command' };
    const autoApproved = this.policy.decision('run_command', args) === 'allow';
    const approved = autoApproved ? '執行這次指令' : this.onApproval ? await this.onApproval(detail, this.signal) :
      await vscode.window.showWarningMessage('NTPU AI 要執行終端機指令：\n' + args.command,
        { modal: true, detail: `工作目錄：${cwd}\n在 OS 沙箱執行，禁止網路，最多 60 秒；隔離失敗即停止。` }, '執行這次指令');
    this.checkStopped();
    if (approved !== '執行這次指令') return { ok: false, denied: true, message: '使用者未批准這次指令。' };
    await safePath(this.root.fsPath, args.cwd || '.');
    const launch = await this.sandbox.prepare(this.root.fsPath, cwd, args.command, this.signal, { reviewPaths: this.options.reviewPaths, approved: this.approvedData, readOnly: this.policy.agent !== 'build' });
    this.onActivity('執行 ' + args.command);
    return new Promise((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, { shell: false, cwd: launch.cwd, env: launch.env, windowsHide: true, detached: process.platform !== 'win32' });
      let output = '', total = 0, timedOut = false, lastOutput = 0;
      const consume = data => { const text = data.toString(); total += text.length; output = (output + text).slice(0, 1024 * 1024);
        if (Date.now() - lastOutput > 200) { lastOutput = Date.now(); const lastLine = output.lastIndexOf('\n'); if (lastLine >= 0) this.options.onCommandOutput?.(redact(output.slice(0, lastLine + 1)).slice(-14000)); } };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      const kill = () => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
          else process.kill(-child.pid, 'SIGTERM');
        } catch {}
        const force = setTimeout(() => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
        force.unref();
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, 60000);
      this.signal.addEventListener('abort', kill, { once: true });
      const cleanup = () => { clearTimeout(timer); this.signal.removeEventListener('abort', kill); };
      child.once('error', error => { cleanup(); void launch.cleanup(); reject(error); });
      child.once('close', async (exitCode, signal) => {
        cleanup();
        await launch.cleanup().catch(() => {});
        if (this.signal.aborted) return reject(new Error('已停止'));
        resolve({ ok: exitCode === 0 && !timedOut, exit_code: exitCode, signal, timed_out: timedOut,
          output: redact(output).slice(0, 14000), truncated: total > 14000, sandbox: launch.info, approval: !autoApproved ? '使用者核准' : this.policy.mode === 'full' && !approvalInfo.explicit ? '完整存取' : approvalInfo.reason, matched_rule: approvalInfo.rule });
      });
      if (this.signal.aborted) kill();
    });
  }

  async reviewData(relative, attachment = false) {
    const classification = classifyPath(relative, this.options.reviewPaths || []);
    if (classification.level === 'protected') throw new Error('受保護資料禁止 Agent 存取。');
    if (classification.level !== 'review' && !attachment) return;
    const accept = '傳送遮蔽後的資料';
    const result = await this.onApproval?.({ title: '確認資料傳送：' + relative,
      detail: '資料將交給 NTPU AI。文字憑證會遮蔽；圖片／PDF 會先在本機檢查已知秘密，但 OCR 可能漏辨，請確認內容適合傳送。', accept }, this.signal);
    this.checkStopped();
    if (result !== accept) throw new Error('未批准敏感資料傳送。');
    if (!attachment) this.approvedData.add(relative);
  }
}

module.exports = { PreviewProvider, WorkspaceTools };
