'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { BrowserBridge } = require('./browser');
const { PreviewProvider, WorkspaceTools } = require('./tools');
const { safePath, hash, diskText, isBlocked } = require('./workspace');
const { runAgent } = require('./agent');
const { shortTitle, nameSession } = require('./session-title');
const { ApprovalGate } = require('./approval');
const { PermissionPolicy } = require('./permissions');
const { SessionStore } = require('./sessions');
const { MemoryStore } = require('./memory/store');
const { ContextManager, summarize, updateMemory } = require('./memory/context');
const { MemoryActions } = require('./memory/actions');
const { SkillCatalog } = require('./skills');
const { McpManager, EXA, BUILTINS, validateServer } = require('./mcp');
const { imageMime, thumbnail } = require('./visuals');
const { sanitize, redact, classifyPath, classifyContent } = require('./security/guard');
const { scanner } = require('./security/attachments');
const { SandboxExecutor } = require('./security/sandbox');
const { ChangeReview } = require('./change-review');
const { AgentWorkers } = require('./agent-workers');
const { RequestScheduler, ModelBudget } = require('./parallel');
const { RequestRateGate } = require('./request-rate');
const { AdaptiveConcurrency } = require('./adaptive-concurrency');
const { isServiceLimit } = require('./parallel-policy');
const { probeConcurrency } = require('./browser/concurrency-probe');
const { publicTarget } = require('./network');

class AgentApp {
  constructor(context) {
    this.context = context; this.view = null; this.bridge = null; this.controller = null;
    this.previews = new PreviewProvider();
    this.changeReview = new ChangeReview(this, vscode);
    this.store = new SessionStore(context.workspaceState.get('ntpuAI.sessions.v2', []));
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
    this.session = this.store.get(context.workspaceState.get('ntpuAI.activeSession')) || this.store.sessions[0] || this.store.create(workspace);
    this.queue = []; this.contextFiles = []; this.attachment = null; this.policies = new Map();
    this.connection = { ready: false, message: '尚未連線' }; this.progress = '就緒'; this.model = '';
    this.budget = { used: 0, total: 48000 }; this.streamId = null;
    this.gate = new ApprovalGate(approval => {
      this.post({ kind: 'approval', approval });
      this.state();
    });
    this.skills = new SkillCatalog(path.join(context.extensionPath, 'skills'), vscode.workspace.getConfiguration('ntpuAI').get('skillDirectories', []));
    this.initialAutoConnect = false;
    this.requestRate = new RequestRateGate(vscode.workspace.getConfiguration('ntpuAI').get('parallel.requestsPerMinute', 8));
    this.adaptive = new AdaptiveConcurrency();
    this.parallelVerification = context.globalState.get('ntpuAI.parallelVerification', null);
    this.sandbox = new SandboxExecutor();
    this.mcp = new McpManager({ secrets: context.secrets, sandbox: this.sandbox, workspace: () => this.workspace()?.uri.scheme === 'file' ? this.workspace().uri.fsPath : null, onState: () => this.capabilities(), onContent: content => this.mcpContent(content) });
    this.servers = context.globalState.get('ntpuAI.mcpServers', []);
    this.poller = setInterval(() => {
      if (this.bridge && !this.bridge.opening && !this.loginOperation && !this.busy()) void this.checkConnection().catch(error => {
        this.connection = { ready: false, authentication: 'unknown', message: '背景連線失敗：' + redact(error.message) };
        this.state();
      });
    }, 2000);
    this.poller.unref();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('ntpu-ai-preview', this.previews));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.state()));
    this.ready = this.initializeMemory();
    const configurationListener = vscode.workspace.onDidChangeConfiguration?.(event => {
      if (event.affectsConfiguration('ntpuAI.chat.submitMode')) this.state();
      if (['browser', 'customBrowserPath', 'chromePath', 'browserProfilePath'].some(key => event.affectsConfiguration('ntpuAI.' + key)) && !this.browserUpdating) {
        if (this.busy()) this.browserConfigurationChanged = true;
        else void this.reconnectBrowser(false).catch(error => this.notice(redact(error.message), 'error'));
      }
    });
    if (configurationListener) context.subscriptions.push(configurationListener);
  }

  async initializeMemory() {
    const legacy = this.context.workspaceState.get('ntpuAI.sessions.v2', []);
    this.store = await new MemoryStore(path.join(this.context.globalStorageUri.fsPath, 'agent-memory')).initialize(legacy,
      vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join('|') || 'no-workspace');
    const id = this.context.workspaceState.get('ntpuAI.activeSession');
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || '';
    const metadata = this.store.sessions.find(item => item.id === id) || this.store.sessions.find(item => item.workspace === workspace && !item.archived);
    this.session = metadata ? await this.store.openSession(metadata.id) : this.store.create(workspace);
    this.contextManager = new ContextManager(); this.memoryActions = new MemoryActions(this, vscode);
    await this.save();
    if (!this.store.errors.length) await this.context.workspaceState.update('ntpuAI.sessions.v2', undefined);
    else this.persistenceError = this.store.errors.join('\n');
    await this.refreshSkills();
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), this.context.globalStorageUri] };
    const nonce = randomBytes(18).toString('base64');
    view.webview.html = fsSync.readFileSync(path.join(this.context.extensionPath, 'media', 'index.html'), 'utf8')
      .replaceAll('%NONCE%', nonce).replaceAll('%CSP%', view.webview.cspSource)
      .replaceAll('%STYLE%', view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'agent.css')).toString())
      .replaceAll('%SCRIPT%', view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.bundle.js')).toString());
    view.webview.onDidReceiveMessage(message => { void this.handle(message).catch(error => this.notice(error.message, 'error')); }, null, this.context.subscriptions);
    if (!this.initialAutoConnect) {
      this.initialAutoConnect = true;
      void this.ready.then(() => this.login(false)).catch(error => {
        this.connection = { ready: false, authentication: 'unknown', message: '背景連線失敗：' + redact(error.message) };
        this.state();
      });
    }
  }
  post(message) { void this.view?.webview.postMessage(sanitize(message)); }
  busy() { return !!(this.controller || this.diagnosticController); }
  workspace(session = this.session) {
    return vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString() === session.workspace) ||
      (!session.workspace ? vscode.workspace.workspaceFolders?.[0] : null);
  }
  editor() {
    const editor = vscode.window.activeTextEditor;
    const root = this.workspace();
    if (!root || !editor || editor.document.uri.scheme !== 'file') return null;
    const relative = path.relative(root.uri.fsPath, editor.document.uri.fsPath).replaceAll(path.sep, '/');
    if (!relative || relative.startsWith('../') || isBlocked(relative)) return null;
    return { name: path.basename(relative), path: relative, selected: !editor.selection.isEmpty,
      line: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 };
  }
  state() {
    const config = vscode.workspace.getConfiguration('ntpuAI');
    this.post({ kind: 'state', busy: this.busy(), progress: this.progress, modelRequest: this.modelRequest, connection: this.connection, parallel: this.parallelState(),
      model: this.model, options: this.session.options, submitMode: config.get('chat.submitMode', 'enter'), submitModifier: process.platform === 'darwin' ? '⌘' : 'Ctrl', workspace: this.workspace()?.name || '未開啟專案',
      budget: this.budget, persistenceError: this.persistenceError, editor: this.editor(), contexts: this.contextFiles.map(file => ({ path: file.relative, name: path.basename(file.relative) })),
      attachment: this.attachment ? { name: this.attachment.name, mimeType: this.attachment.mimeType, preview: this.attachment.preview } : null,
      queue: this.queue.map(item => ({ id: item.id, request: item.request })), sessionId: this.session.id, sessionTitle: this.session.title });
  }
  render() {
    for (const message of this.session.messages) if (message.thumbnailData) message.imageUri = message.thumbnailData;
    void this.refreshArtifacts();
    this.post({ kind: 'session', session: { id: this.session.id, title: this.session.title,
      ...this.store.page(this.session), changes: this.changeReview.view(), plan: this.session.plan || [] } });
    this.post({ kind: 'sessions', sessions: this.store.sessions.map(({ id, title, updatedAt, archived, workspace, tasks }) => ({ id, title, updatedAt, archived, workspace, searchText: (tasks || []).map(task => task.request).join(' '), pending: (tasks || []).filter(task => task.status !== 'completed' && !task.resolvedBy).length })) });
    this.post({ kind: 'approval', approval: this.gate.state() }); this.state(); this.capabilities();
  }
  add(role, text, extra = {}) {
    const item = this.store.add(this.session, sanitize({ role, text, ...extra }));
    this.post({ kind: 'message', message: item }); this.persist(); return item;
  }
  patch(id, patch) {
    const item = this.store.update(this.session, id, sanitize(patch));
    if (item) this.post({ kind: 'patch', message: item }); this.persist(); return item;
  }
  notice(text, role = 'notice') { this.add(role, text); }
  persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save().catch(error => { this.persistenceError = redact(error.message); this.state(); }); }, 350);
    this.saveTimer.unref();
  }
  async save() {
    await this.store.save(this.session);
    await this.context.workspaceState.update('ntpuAI.activeSession', this.session.id);
  }
  getBridge() {
    if (!this.bridge) {
      const config = vscode.workspace.getConfiguration('ntpuAI');
      this.bridge = new BrowserBridge({ browser: config.get('browser', 'auto') === 'auto' && config.get('chromePath') ? 'custom' : config.get('browser', 'auto'),
        customPath: config.get('customBrowserPath') || config.get('chromePath') || '', profile: config.get('browserProfilePath') || undefined,
        cleanupConversations: config.get('browser.cleanupTaskConversations', true), onCleanupFailure: () => this.notice('部分任務對話未能從校方網站清理；本機記錄已保留，請到網站確認。'),
        storageRoot: this.context.globalStorageUri.fsPath, workspaces: vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath) || [],
        remote: this.context.globalStorageUri.scheme === 'vscode-remote' || this.context.extension?.extensionKind === 2 && !!vscode.env?.remoteName });
    }
    return this.bridge;
  }
  async login(interactive = true) {
    if (this.busy()) return;
    if (this.loginOperation) {
      await this.loginOperation;
      if (!interactive || this.connection.ready || this.connection.loginWindow) return;
    }
    this.loginOperation = this.connectBrowser(interactive);
    try { await this.loginOperation; } finally { this.loginOperation = null; }
  }
  async connectBrowser(interactive) {
    this.connection = { ...this.connection, connecting: true }; this.state();
    try {
      const bridge = this.getBridge();
      if (bridge.mode !== 'login') await bridge.open();
      await this.checkConnection();
      if (interactive && !this.connection.ready) {
        this.connection = { ...this.connection, connecting: true }; this.state();
        await bridge.openLogin(); await this.checkConnection();
      }
    } catch (error) {
      this.connection = { ready: false, authentication: 'unknown', message: redact(error.message) };
      throw error;
    } finally {
      this.connection = { ...this.connection, connecting: false }; this.state(); this.capabilities();
    }
  }
  async reconnectBrowser(open = true) {
    await this.ready; if (this.busy()) throw new Error('請先停止任務再更換瀏覽器。');
    if (this.loginOperation) await this.loginOperation;
    if (this.connectionCheck) await this.connectionCheck;
    await this.save(); await this.bridge?.close(); this.bridge = null;
    this.connection = { ready: false, message: '瀏覽器設定已更新，請重新連線。' }; this.state(); this.capabilities();
    if (open) await this.login();
  }
  async updateBrowser(message) {
    if (this.busy()) return;
    if (!['auto', 'chrome', 'edge', 'chromium', 'custom'].includes(message.browser) || typeof message.customPath !== 'string' || typeof message.profileLocation !== 'string') return;
    this.browserUpdating = true;
    try {
      const config = vscode.workspace.getConfiguration('ntpuAI');
      await config.update('browser', message.browser, vscode.ConfigurationTarget.Global);
      await config.update('customBrowserPath', message.customPath, vscode.ConfigurationTarget.Global);
      await config.update('browserProfilePath', message.profileLocation, vscode.ConfigurationTarget.Global);
      await config.update('chromePath', '', vscode.ConfigurationTarget.Global);
    } finally { this.browserUpdating = false; }
    await this.reconnectBrowser(true);
  }
  async logout() {
    if (this.busy()) return;
    const choice = await vscode.window.showWarningMessage(
      '登出 NTPU AI？這會清除專用瀏覽器中 NTPU／北大網域的登入 Cookie 與網站資料。其他網站的資料不會變更。',
      { modal: true }, '登出');
    if (choice !== '登出') return;
    if (this.loginOperation) await this.loginOperation;
    if (this.connectionCheck) await this.connectionCheck;
    if (this.busy()) return;
    await this.getBridge().logout();
    this.parallelVerification = null; await this.context.globalState.update('ntpuAI.parallelVerification', undefined);
    this.connection = { ready: false, authentication: 'signed_out', message: '已登出 NTPU AI' };
    this.post({ kind: 'connection', connection: this.connection });
    this.state();
  }
  async checkConnection() {
    if (this.connectionCheck) return this.connectionCheck;
    this.connectionCheck = (async () => {
      const bridge = this.getBridge(); const mode = bridge.mode;
      this.connection = await (bridge.finishLogin ? bridge.finishLogin() : bridge.status());
      if (this.connection.authentication === 'required' && this.parallelVerification) {
        this.parallelVerification = null; await this.context.globalState.update?.('ntpuAI.parallelVerification', undefined);
      }
      this.state(); if (mode !== bridge.mode) this.capabilities();
      return this.connection;
    })();
    try { return await this.connectionCheck; } finally { this.connectionCheck = null; }
  }
  async refreshSkills() {
    const root = this.workspace();
    if (root) await this.skills.discover(root.uri.fsPath);
    this.capabilities();
  }
  parallelScope() { return this.bridge ? hash(this.bridge.origin + ':' + this.bridge.profile) : ''; }
  parallelState() {
    const config = vscode.workspace.getConfiguration('ntpuAI');
    const verification = this.parallelVerification;
    const enabled = config.get('parallel.enabled', true);
    const rawConfigured = Number(config.get('parallel.maxConcurrency', 0));
    const configured = Number.isFinite(rawConfigured) ? Math.max(0, Math.min(4, Math.floor(rawConfigured))) : 0;
    const ceiling = enabled ? (configured > 0 ? Math.min(4, configured) : 4) : 1;
    const adaptive = this.adaptive.state();
    return { ...adaptive, enabled, maxConcurrency: configured, ceiling, effectiveConcurrency: Math.min(adaptive.effectiveConcurrency, ceiling),
      ...(this.scheduler?.state() || { activeRequests: 0, queuedRequests: 0 }),
      runningAgents: (this.controller && !this.controller.signal.aborted ? 1 : 0) + (this.namingActive ? 1 : 0) + [...(this.workers?.jobs.values() || [])].filter(job => job.status === 'running').length,
      queuedTasks: this.queue.length, requestsPerMinute: config.get('parallel.requestsPerMinute', 8), maxTestConcurrency: Math.max(2, Math.min(4, config.get('parallel.probeMaxConcurrency', 4))), probeIntervalSeconds: config.get('parallel.probeIntervalSeconds', 60),
      verification: verification ? { timestamp: verification.timestamp, message: verification.message, stopReason: verification.stopReason,
        serviceLimited: verification.serviceLimited, cancelled: verification.cancelled, groups: verification.groups || [] } : null };
  }
  async updateParallel(message) {
    if (this.busy()) throw new Error('請先停止或完成目前任務再修改並行設定。');
    const values = { maxConcurrency: [0,1,2,3,4], probeMaxConcurrency: [2,3,4], probeIntervalSeconds: [0,30,60,90,120], requestsPerMinute: [1,2,3,4,5,6,7,8,9,10] };
    if (!values[message.key]?.includes(message.value)) throw new Error('無效的並行設定。');
    await vscode.workspace.getConfiguration('ntpuAI').update('parallel.' + message.key, message.value, vscode.ConfigurationTarget.Global);
    const config = vscode.workspace.getConfiguration('ntpuAI');
    this.adaptive.configure(config.get('parallel.enabled', true) ? (config.get('parallel.maxConcurrency', 0) || 4) : 1);
    this.capabilities(); this.state();
  }
  async testConcurrency() {
    await this.ready;
    if (this.busy() || this.changeReview.applying) throw new Error('請等目前任務完成或停止後再測試。');
    if (this.adaptive.blocked) throw new Error('服務限制已暫停發送，請先處理原因並手動恢復；不會另開聊天室重試。');
    await this.login(false);
    if (!this.connection.ready) throw new Error('請先按「登入」完成學校登入，再執行並行測試。');
    if (this.busy() || this.changeReview.applying) throw new Error('目前已有任務執行，請稍後再測試。');
    const initialGroups = [];
    this.diagnosticController = new AbortController(); this.state();
    this.concurrencyOperation = (async () => {
      this.parallelVerification = null; await this.context.globalState.update('ntpuAI.parallelVerification', undefined);
      const directory = path.join(this.context.globalStorageUri.fsPath, 'diagnostics'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const partial = { schemaVersion: 2, timestamp: new Date().toISOString(), scope: this.parallelScope(), verified: false, groups: [...initialGroups], recommendedConcurrency: 1, inProgress: true };
      this.requestRate.configure(vscode.workspace.getConfiguration('ntpuAI').get('parallel.requestsPerMinute', 8));
      const result = await probeConcurrency(this.getBridge(), { signal: this.diagnosticController.signal,
        maxConcurrency: Math.max(2, Math.min(4, vscode.workspace.getConfiguration('ntpuAI').get('parallel.probeMaxConcurrency', 4))),
        initialGroups, responseLines: 10,
        groupPauseMs: vscode.workspace.getConfiguration('ntpuAI').get('parallel.probeIntervalSeconds', 60) * 1000,
        onProgress: text => { this.progress = text; this.state(); },
        beforeRequests: (count, requestSignal) => this.requestRate.acquire(requestSignal, count, milliseconds => { this.progress = `等待本機請求節奏（約 ${Math.ceil(milliseconds / 1000)} 秒），不會重送已失敗請求。`; this.state(); }),
        onGroup: async group => { partial.groups.push(group); this.parallelVerification = partial; this.capabilities();
          await fs.writeFile(path.join(directory, 'concurrency.json'), JSON.stringify(sanitize(partial), null, 2), { mode: 0o600 }); } });
      const evidence = sanitize({ ...result, scope: this.parallelScope(), platform: process.platform + '-' + process.arch, browser: this.bridge?.manager.info?.browser });
      if (result.serviceLimited) this.adaptive.block({ serviceLimited: true, message: result.message });
      this.parallelVerification = evidence;
      await this.context.globalState.update('ntpuAI.parallelVerification', evidence);
      await fs.writeFile(path.join(directory, 'concurrency.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
      void vscode.window.showInformationMessage?.(result.message); return result;
    })();
    try { return await this.concurrencyOperation; }
    finally {
      this.concurrencyOperation = null; this.diagnosticController = null; this.progress = '就緒'; this.state(); this.capabilities();
      if (this.queue.length && !this.busy()) void this.run(this.queue.shift());
    }
  }
  capabilities() {
    const connected = this.mcp.states();
    const config = vscode.workspace.getConfiguration('ntpuAI');
    this.post({ kind: 'capabilities', parallel: this.parallelState(), sandbox: this.sandbox.state, browser: { headless: this.bridge?.mode !== 'login', selection: config.get('browser', 'auto'), customPath: config.get('customBrowserPath', ''),
      profileLocation: config.get('browserProfilePath', ''), info: this.bridge?.manager.info, host: process.platform + ' ' + process.arch, remoteName: vscode.env?.remoteName || '' }, skills: this.skills.list(), skillErrors: this.skills.errors,
      servers: [...BUILTINS, ...this.servers.filter(server => !BUILTINS.some(item => item.name === server.name))].map(server => ({ name: server.name, label: server.label, type: server.type,
        target: server.url || [server.command, ...(server.args || [])].join(' '), builtin: !!server.builtin,
        ...connected.find(state => state.name === server.name) })),
      tools: this.mcp.catalog().map(({ name, originalName, description, server }) => ({ name, originalName, description, server })),
      thinking: 'NTPU AI 未提供原生 thinking 設定。分析深度會調整本地 agent 的規劃與驗證策略。',
      image: '可分析圖片，並以 SVG 繪製 PNG。照片型生圖可透過你連接的影像 MCP 工具擴充。' });
  }

  async handle(message) {
    if (!message || typeof message !== 'object' || typeof message.kind !== 'string') return;
    switch (message.kind) {
      case 'ready': await this.ready; this.render(); if (!this.initialAutoConnect) { this.initialAutoConnect = true; await this.login(false); } break;
      case 'historyPage': this.post({ kind: 'historyPage', sessionId: this.session.id, ...this.store.page(this.session, message.before) }); break;
      case 'memory': case 'resumeTask': case 'renameSession': case 'exportSession': case 'sessionsAction': case 'deleteSession': case 'archiveSession': case 'refreshMemory': case 'editMemory': case 'deleteMemory': case 'clearMemory': case 'privacySetting': case 'backupMemory': case 'restoreMemory': await this.memoryActions.handle(message); break;
      case 'login': await this.login(); break;
      case 'browserUpdate': await this.updateBrowser(message); break;
      case 'reconnectBrowser': await this.reconnectBrowser(true); break;
      case 'testConcurrency': await this.testConcurrency(); break;
      case 'logout': await this.logout(); break;
      case 'status': await this.checkConnection(); break;
      case 'ask': if (typeof message.text === 'string') await this.ask(message.text, message.includeEditor !== false); break;
      case 'stop': this.stop(); break;
      case 'cancelWorker': if (this.workers && typeof message.id === 'string') await this.workers.execute('cancel_task', { id: message.id }); break;
      case 'cancelQueue': { const task = this.session.tasks?.find(item => item.id === message.id); if (task) { task.status = 'stopped'; task.result = '已取消佇列'; task.endedAt = Date.now(); } const queued = this.queue.find(item => item.id === message.id); if (queued) this.patch(queued.messageId, { queued: false, canceled: true }); this.queue = this.queue.filter(item => item.id !== message.id); this.state(); break; }
      case 'new': await this.newSession(); break;
      case 'dismissWarning': {
        const warning = this.session.messages.find(item => item.id === message.id && item.role === 'error');
        if (warning && !warning.dismissed) { this.patch(warning.id, { dismissed: true }); clearTimeout(this.saveTimer); await this.save(); }
        break;
      }
      case 'switch': if (!this.busy() && !this.gate.pending && this.store.sessions.some(item => item.id === message.id)) { await this.save(); this.session = await this.store.openSession(message.id); this.contextFiles = []; this.attachment = null; await this.refreshSkills(); this.render(); this.persist(); } break;
      case 'rename': await this.memoryActions.handle({ kind: 'renameSession', id: this.session.id }); break;
      case 'option': await this.setOption(message.key, message.value); break;
      case 'approval': {
        const pending = this.gate.pending;
        if (pending?.id === message.id && message.approved === true && message.scope === 'session' && pending.detail.tool && !pending.detail.tool.startsWith('mcp_')) this.activePolicy?.grant(pending.detail.tool);
        if (typeof message.approved === 'boolean') this.gate.decide(message.id, message.approved);
        break;
      }
      case 'answer': if (typeof message.answer === 'string') this.gate.answer(message.id, message.answer); break;
      case 'copy': if (typeof message.text === 'string' && message.text.length <= 200000) await vscode.env.clipboard.writeText(message.text); break;
      case 'openLink': await this.openLink(message.url); break;
      case 'openFile': await this.openFile(message.path); break;
      case 'addContext': await this.addContext(); break;
      case 'removeContext': this.contextFiles = this.contextFiles.filter(file => file.relative !== message.path); this.state(); break;
      case 'attach': await this.attach(); break;
      case 'removeAttachment': this.attachment = null; this.state(); break;
      case 'change': await this.showChange(message.id); break;
      case 'revert': await this.revert(message.id); break;
      case 'reviewChange': await this.changeReview.act(message); break;
      case 'export': await this.memoryActions.handle({ kind: 'exportSession', id: this.session.id }); break;
      case 'refreshSkills': await this.refreshSkills(); break;
      case 'openSkill': { const skill = this.skills.load(message.name); await vscode.window.showTextDocument(vscode.Uri.file(skill.file)); break; }
      case 'addSkillDirectory': await this.addSkillDirectory(); break;
      case 'openArtifact': await this.openArtifact(message.id); break;
      case 'saveArtifact': await this.saveArtifact(message.id); break;
      case 'connectMcp': await this.connectServer(message.name); break;
      case 'officialAssistant': await vscode.env.openExternal(vscode.Uri.parse('https://aia.ntpu.ai/')); break;
      case 'disconnectMcp': if (!this.busy()) await this.mcp.disconnect(message.name); break;
      case 'addMcp': await this.addServer(); break;
      case 'importMcp': await this.importServers(); break;
      case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ntpuAI'); break;
      case 'privacySettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ntpuAI.privacy'); break;
      case 'terminalSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ntpuAI.terminal'); break;
      case 'resumeParallel':
        if (this.busy() || !this.connection.ready) throw new Error('請先完成任務與登入，再手動恢復。');
        this.adaptive.resume(); this.state(); this.capabilities(); break;
      case 'parallelUpdate': await this.updateParallel(message); break;
      case 'composerUpdate': await this.updateComposer(message.value); break;
      case 'parallelSettings': await vscode.commands.executeCommand('workbench.action.openSettings', 'ntpuAI.parallel'); break;
      case 'chooseWorkspace': await this.chooseWorkspace(); break;
    }
  }

  async newSession(targetWorkspace) {
    if (this.newSessionOperation) return this.newSessionOperation;
    this.newSessionOperation = (async () => {
      await this.ready;
      if (this.busy() || this.gate.pending || this.changeReview.applying || this.memoryActions.managingSessions) return;
      clearTimeout(this.saveTimer); await this.save();
      const workspace = targetWorkspace ?? (this.workspace()?.uri.toString() || '');
      const empty = await this.store.findEmpty(workspace, this.session.id);
      // A task or approval may have started while storage was being read.
      if (this.busy() || this.gate.pending || this.changeReview.applying || this.memoryActions.managingSessions) return;
      const next = empty || this.store.create(workspace);
      if (next.id !== this.session.id) {
        this.session = next; this.contextFiles = []; this.attachment = null; this.streamId = null;
        await this.refreshSkills();
      }
      await this.save(); this.render();
    })();
    try { return await this.newSessionOperation; } finally { this.newSessionOperation = null; }
  }

  async setOption(key, value) {
    if (this.busy() || this.gate.pending) return;
    const allowed = { agent: ['build', 'plan', 'review', 'research', 'ask'], permission: ['ask', 'assisted', 'full'], depth: ['quick', 'standard', 'deep'] };
    if (allowed[key] && !allowed[key].includes(value)) return;
    if (key === 'web' && typeof value !== 'boolean') return;
    if (key === 'skills') { if (!Array.isArray(value)) return; value = value.filter(name => this.skills.items.has(name)).slice(0, 4); }
    if (!allowed[key] && !['web', 'skills'].includes(key)) return;
    if (key === 'permission' && value === 'full') {
      const answer = await this.gate.request({ title: '啟用完整存取？', detail: '這個工作階段將自動修改工作區檔案、執行允許的終端機與內建工具。敏感資料與自訂 MCP 仍需確認。終端機與 MCP 以你的使用者權限執行。Plan／Review 的唯讀限制仍適用。', accept: '啟用完整存取' }, new AbortController().signal);
      if (answer !== '啟用完整存取') { this.state(); return; }
    }
    this.session.options[key] = value; this.policies.delete(this.session.id); this.state(); this.persist();
  }
  async updateComposer(value) {
    if (!['enter', 'modifierEnter'].includes(value)) return;
    await vscode.workspace.getConfiguration('ntpuAI').update('chat.submitMode', value, vscode.ConfigurationTarget.Global);
    this.state();
  }
  async chooseWorkspace() {
    if (this.busy()) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) { await vscode.commands.executeCommand('workbench.action.files.openFolder'); return; }
    const chosen = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { title: '工作階段的專案' });
    if (chosen && chosen.folder.uri.toString() !== this.session.workspace) await this.newSession(chosen.folder.uri.toString());
  }
  async editorContext(root, includeEditor, files = this.contextFiles) {
    const pieces = [];
    const editor = vscode.window.activeTextEditor;
    if (includeEditor && editor?.document.uri.scheme === 'file') {
      const relative = path.relative(root.uri.fsPath, editor.document.uri.fsPath).replaceAll(path.sep, '/');
      try {
        await safePath(root.uri.fsPath, relative);
        await this.approveData(relative);
        const selected = !editor.selection.isEmpty;
        pieces.push(`File ${relative}${selected ? ` (selected lines ${editor.selection.start.line + 1}–${editor.selection.end.line + 1})` : ''}:\n` +
          (selected ? editor.document.getText(editor.selection) : editor.document.getText()).slice(0, 9000));
      } catch {}
    }
    for (const file of files.slice(0, 3)) {
      const absolute = await safePath(root.uri.fsPath, file.relative);
      await this.approveData(file.relative);
      pieces.push(`File ${file.relative} (excerpt; read_file for full contents):\n` + (await diskText(absolute)).slice(0, 5000));
    }
    return redact(pieces.join('\n\n'));
  }
  async ask(request, includeEditor = true) {
    if (this.changeReview.applying) throw new Error('正在處理變更，請稍候再送出任務。');
    await this.ready;
    request = redact(request.trim()); if (!request) return;
    if (request.length > 20000) throw new Error('提問超過 20000 字。');
    const slash = request.match(/^\/(build|plan|review|research|ask)\b\s*/);
    if (slash && !this.busy()) { this.session.options.agent = slash[1]; request = request.slice(slash[0].length) || '請依目前專案提供協助。'; }
    if (this.queue.length >= 5) throw new Error('佇列最多保留五個提問。');
    const item = { id: randomUUID(), createdAt: Date.now(), request, includeEditor, sessionId: this.session.id, attachment: this.attachment, files: [...this.contextFiles] };
    this.session.tasks ||= []; this.session.tasks.push({ id: item.id, request, createdAt: item.createdAt, status: 'queued', records: [], files: [], pending: [] });
    this.attachment = null; this.contextFiles = [];
    const user = this.add('user', request, { queued: this.busy(), attachment: item.attachment ? { name: item.attachment.name } : null });
    item.messageId = user.id;
    if (this.session.tasks.length === 1 && this.session.titleSource !== 'manual') { item.nameSession = true; this.session.title = shortTitle(request); }
    if (this.busy()) { this.queue.push(item); this.state(); return; }
    await this.run(item);
  }

  async run(item) {
    const operation = this.runTask(item); this.runOperation = operation;
    try { return await operation; } finally { if (this.runOperation === operation) this.runOperation = null; }
  }
  async runTask(item) {
    const root = this.workspace();
    if (!root) { const task = this.session.tasks.find(task => task.id === item.id); task.status = 'blocked'; task.result = '尚未開啟工作區'; task.endedAt = Date.now(); this.notice('請開啟這個工作階段的專案資料夾，或建立新的工作階段。', 'error'); await this.save(); return; }
    if (!vscode.workspace.isTrusted) throw new Error('請先信任目前工作區。');
    if (root.uri.scheme !== 'file') throw new Error('目前 Extension Host 只能操作本機 file 工作區；遠端資料夾可離線瀏覽歷史，但不會用本機路徑執行遠端任務。');
    this.controller = new AbortController(); const signal = this.controller.signal;
    const task = this.session.tasks.find(task => task.id === item.id);
    task.startedAt = Date.now(); task.status = 'running'; task.agent = this.session.options.agent;
    this.patch(item.messageId, { queued: false }); this.state();
    let workers, scheduler, naming;
    try {
      await this.save();
      if (this.adaptive.blocked) throw new Error('服務限制已暫停新請求，請處理原因後在工具設定手動恢復發送。');
      const bridge = this.getBridge();
      if (!bridge.page || bridge.page.isClosed()) { this.progress = '正在 VS Code 背景連線'; this.state(); await bridge.open(); }
      this.connection = await this.checkConnection();
      if (!this.connection.ready) throw new Error(this.connection.message);
      if (signal.aborted) throw new Error('已停止');
      await this.refreshSkills();
      const workspaceContext = await this.editorContext(root, item.includeEditor, item.files);
      const project = vscode.workspace.getConfiguration('ntpuAI').get('memory.enableProject', true) ? await this.store.project(this.session.workspace) : null;
      const context = this.contextManager.compose({ request: item.request, session: this.session, project,
        tasks: this.store.projectTasks(this.session.workspace).filter(task => task.id !== item.id), workspaceContext, budget: Math.min(18000, Math.floor(vscode.workspace.getConfiguration('ntpuAI').get('contextCharacters', 64000) * 0.3)) }).text;
      let policy = this.policies.get(this.session.id);
      if (!policy || policy.mode !== this.session.options.permission || policy.agent !== this.session.options.agent) {
        policy = new PermissionPolicy({ mode: this.session.options.permission, agent: this.session.options.agent }); this.policies.set(this.session.id, policy);
      }
      const config = vscode.workspace.getConfiguration('ntpuAI');
      policy.terminal = { enabled: config.get('terminal.enableAutoApprove', true), rules: config.get('terminal.autoApprove', {}) };
      this.activePolicy = policy;
      this.configureScanner();
      this.requestRate.configure(config.get('parallel.requestsPerMinute', 8));
      this.adaptive.configure(this.parallelState().ceiling);
      scheduler = this.scheduler = new RequestScheduler(2, error => {
        if (isServiceLimit(error)) {
          this.parallelVerification = null; void this.context.globalState.update('ntpuAI.parallelVerification', undefined);
          this.notice(redact(error.message), 'error'); this.stop();
        }
      }, { adaptive: this.adaptive, onState: () => this.state(), rateGate: this.requestRate, onWait: milliseconds => { this.progress = `等待本機請求節奏（約 ${Math.ceil(milliseconds / 1000)} 秒）`; this.state(); } });
      const modelBudget = new ModelBudget(Math.min(config.get('maxSteps', 50), { quick: 12, standard: 50, deep: 100 }[this.session.options.depth] || 50));
      const baseTools = new WorkspaceTools(root.uri, this.previews, signal, text => { this.progress = text; this.state(); this.capabilities(); },
        (detail, requestSignal) => this.gate.request(detail, requestSignal), { policy, skills: this.skills, sandbox: this.sandbox,
          selectedSkills: this.session.options.skills, web: this.session.options.web, mcp: this.mcp, servers: this.servers, builtins: BUILTINS,
          connectMcp: async server => { await this.mcp.connect(server); this.capabilities(); },
          addMcp: async server => {
            if (this.servers.some(item => item.name === server.name) || BUILTINS.some(item => item.name === server.name)) throw new Error('MCP 名稱已存在。');
            await publicTarget(server.url); validateServer(server);
            this.servers.push(server); await this.context.globalState.update('ntpuAI.mcpServers', this.servers);
            try { await this.mcp.connect(server); }
            catch (error) { this.servers = this.servers.filter(item => item.name !== server.name); await this.context.globalState.update('ntpuAI.mcpServers', this.servers); throw error; }
            this.capabilities();
          },
          onCatalogChange: () => this.capabilities(),
          bridge: scheduler.bridge(bridge), parallel: this.parallelState().enabled,
          reviewPaths: config.get('privacy.reviewPaths', []),
          onPlan: steps => { this.session.plan = steps; this.post({ kind: 'plan', steps }); this.persist(); },
          onSkill: name => { if (!this.session.options.skills.includes(name)) this.post({ kind: 'skillLoaded', name }); },
          onArtifact: artifact => this.artifact(artifact), onChange: change => this.changed({ ...change, taskId: item.id }),
          onCommandOutput: output => { if (this.activeToolId) this.patch(this.activeToolId, { liveOutput: output }); } });
      const tools = this.parallelState().enabled ? (workers = new AgentWorkers({ base: baseTools, bridge, scheduler, modelBudget, signal, context, workspace: root.name,
        profile: this.session.options, occupiedSlots: () => this.namingActive ? 1 : 0, maxWorkers: this.parallelState().workerConcurrency, timeoutMs: config.get('responseTimeoutSeconds', 240) * 1000,
        createTools: (workerSignal, workerBridge, title) => new WorkspaceTools(root.uri, this.previews, workerSignal, () => {},
          (detail, requestSignal) => this.gate.request({ ...detail, title: title + ' · ' + detail.title }, requestSignal),
          { ...baseTools.options, policy: new PermissionPolicy({ mode: policy.mode, agent: 'research' }), bridge: workerBridge,
            onPlan: undefined, onChange: undefined, onArtifact: undefined, onCommandOutput: undefined }),
        onBeforeCleanup: () => this.save(),
        onEvent: event => {
          const existing = this.session.messages.find(message => message.id === event.id);
          const detail = JSON.stringify({ activity: event.activity, retryOf: event.retryOf, retryReason: event.retryReason, result: event.result, evidence: event.records }, null, 2).slice(0, 20000);
          if (!existing) this.add('tool', '', { id: event.id, name: 'agent_task', args: { name: event.title, role: event.role, retryOf: event.retryOf, retryReason: event.retryReason }, status: event.status, startedAt: event.startedAt });
          this.patch(event.id, { status: event.status, result: detail, finishedAt: event.endedAt }); this.state();
        } })) : baseTools;
      this.workers = workers;
      const resume = this.session.checkpoint && /^(?:請)?(?:繼續|接著|continue\b|resume\b)/i.test(item.request);
      if (resume) task.resumeOf = this.session.checkpoint.taskId;
      const taskRequest = resume ? this.session.checkpoint.request + '\n\nUSER FOLLOW-UP:\n' + item.request : item.request;
      if (!resume) { this.session.plan = []; this.post({ kind: 'plan', steps: [] }); }
      const initialRecords = resume ? sanitize(this.session.checkpoint.records).map(record => ({ ...record, historical: true })) : [];
      if (resume) initialRecords.push({ type: 'resume_validation', instruction: 'Checkpoint evidence is historical. Re-read affected files and verify workspace state before editing or claiming completed verification. File snapshots have been reset.' });
      task.taskRequest = taskRequest; task.records = initialRecords;
      this.session.checkpoint = { taskId: task.id, request: taskRequest, records: initialRecords };
      await this.save();
      this.toolsSinceBrief = 0;
      this.add('commentary', resume ? '我會接續原任務，先確認目前檔案與先前結果，再完成剩餘工作。' :
        this.session.options.agent === 'build' ? '我會先查看專案脈絡，再完成實作並確認執行結果。' : '我會先查看相關證據，再整理這次需求的結果。');
      if (item.nameSession) {
        const namingId = randomUUID(); this.namingActive = true;
        this.add('tool', '', { id: namingId, name: 'name_session', args: {}, status: 'running', startedAt: Date.now() });
        naming = nameSession({ session: this.session, request: item.request, bridge, scheduler, modelBudget, signal,
          onEvent: (status, result) => { this.patch(namingId, { status, result, ...(status !== 'running' ? { finishedAt: Date.now() } : {}) }); this.state(); },
          onSave: () => this.save() }).finally(() => { this.namingActive = false; this.state(); });
      }
      let answer = '';
      const result = await runAgent({ bridge: scheduler.bridge(bridge), tools, modelBudget, request: taskRequest, initialRecords, context, workspace: root.name, signal,
        attachment: item.attachment, profile: this.session.options, maxSteps: modelBudget.limit,
        budget: config.get('contextCharacters', 64000), timeoutMs: config.get('responseTimeoutSeconds', 240) * 1000,
        onActivity: text => { this.progress = text; this.state(); this.capabilities(); }, onBudget: budget => { this.budget = budget; this.state(); },
        onJudge: event => { this.model = event.model || ''; this.state(); },
        onResponseMetadata: metadata => {
          task.requests ||= []; task.requests.push(sanitize(metadata));
          if (metadata.outcome === 'empty') this.notice('NTPU AI 這輪沒有回傳內容，已保留任務進度。');
        },
        onRequestState: request => { this.modelRequest = request; this.state(); },
        onStream: text => {
          if (!text) { if (this.streamId) { this.patch(this.streamId, { role: 'notice', text: '回覆未完成，正在接續任務。' }); this.streamId = null; } return; }
          if (!this.streamId) this.streamId = this.add('stream', '').id;
          this.patch(this.streamId, { text });
        },
        onFinal: text => { answer = text; if (this.streamId) { this.patch(this.streamId, { role: 'assistant', text }); this.streamId = null; } else this.add('assistant', text); },
        onCheckpoint: async records => {
          task.records = sanitize(records);
          task.files = [...new Set(records.filter(record => !record.historical && record.result?.ok && (record.result?.saved || record.name === 'create_visual')).map(record => record.result.path).filter(Boolean))];
          task.pending = (this.session.plan || []).filter(step => step.status !== 'completed');
          this.session.checkpoint = sanitize({ taskId: task.id, request: taskRequest, records });
          await this.save();
        }, onTool: event => this.toolEvent(event) });
      if (result.completed) this.session.checkpoint = null;
      this.session.turns = [...(this.session.turns || []), { request: item.request, answer }];
      task.status = result.completed ? 'completed' : 'blocked'; task.result = answer;
      if (result.completed && task.resumeOf) {
        const seen = new Set(); let previousId = task.resumeOf;
        while (previousId && !seen.has(previousId)) {
          seen.add(previousId); const previous = this.session.tasks.find(item => item.id === previousId);
          if (!previous || previous.agent !== task.agent) break;
          previous.resolvedBy = task.id; previous.resolvedAt = Date.now(); previousId = previous.resumeOf;
        }
      }
      this.progress = result.completed ? '已完成' : '已停止，等待下一個指示';
    } catch (error) {
      if (isServiceLimit(error) && !this.adaptive.blocked) { this.adaptive.block(error); this.stop(); }
      task.status = this.adaptive.blocked ? 'blocked' : signal.aborted ? 'stopped' : 'failed'; task.result = redact(error.message);
      if (this.streamId) { this.patch(this.streamId, { role: 'notice', text: '回覆未完成。' }); this.streamId = null; }
      this.notice(this.adaptive.blocked ? error.message : signal.aborted ? '已停止。已套用的修改會保留。' : error.message, this.adaptive.blocked || !signal.aborted ? 'error' : 'notice');
      this.progress = signal.aborted ? '已停止' : '需要處理';
    } finally {
      await naming; this.namingActive = false;
      await workers?.close({ cancel: signal.aborted || this.adaptive.blocked }); this.workers = null;
      if (scheduler) task.parallel = { adaptive: true, configuredConcurrency: scheduler.limit, modelRequests: scheduler.requests, peakStreams: scheduler.peakStreams, decisions: this.adaptive.decisions.filter(decision => decision.at >= task.startedAt), blocked: this.adaptive.blocked };
      scheduler?.close(); this.scheduler = null;
      task.endedAt = Date.now(); task.pending = (this.session.plan || []).filter(step => step.status !== 'completed');
      summarize(this.session);
      try {
        const privacy = vscode.workspace.getConfiguration('ntpuAI');
        if (privacy.get('memory.enableProject', true) && privacy.get('memory.autoUpdate', true)) await updateMemory(this.store, this.session, task);
        await this.save();
        const cleanup = await this.bridge?.cleanupConversations?.();
        if (cleanup?.deleted) this.add('tool', '', { name: 'cleanup_conversations', args: {}, status: 'done', result: JSON.stringify({ deleted: cleanup.deleted, message: '本機紀錄保留，校方任務對話已刪除。' }) });
        if (cleanup?.failed) this.notice('任務已存本機，但部分校方對話清理失敗，請到網站確認。');
      } catch (error) { this.persistenceError = redact(error.message); }
      this.controller = null; this.activePolicy = null;
      if (this.browserConfigurationChanged) { this.browserConfigurationChanged = false; await this.reconnectBrowser(false); }
      this.state(); this.persist();
      this.post({ kind: 'sessions', sessions: this.store.sessions.map(({ id, title, updatedAt, archived, workspace, tasks }) => ({ id, title, updatedAt, archived, workspace, searchText: (tasks || []).map(task => task.request).join(' '), pending: (tasks || []).filter(task => task.status !== 'completed' && !task.resolvedBy).length })) });
    }
    const next = this.queue.shift(); if (next) await this.run(next);
  }
  toolEvent(event) {
    if (event.status === 'running') {
      this.toolsSinceBrief++;
      this.activeToolId = event.name === 'run_command' ? event.id : null;
      if (this.streamId) { this.patch(this.streamId, { role: 'notice', text: '' }); this.streamId = null; }
      if (event.message) { this.add('commentary', event.message); this.toolsSinceBrief = 0; }
      const args = { ...event.args }; delete args.content; delete args.svg; delete args.new_text;
      this.add('tool', '', { id: event.id, name: event.name, args, status: 'running', startedAt: Date.now() });
    } else {
      const result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2);
      this.patch(event.id, { status: event.status, result: result.slice(0, 20000),
        outcome: typeof event.result === 'object' ? { created: !!event.result.created, changed: event.result.changed, saved: event.result.saved, exitCode: event.result.exit_code } : null, finishedAt: Date.now() });
      this.activeToolId = null;
      if (event.status === 'done' && event.result?.saved && this.toolsSinceBrief >= 3) {
        this.add('commentary', '已儲存 ' + event.result.path + '。接著確認剩餘需求與驗證結果。'); this.toolsSinceBrief = 0;
      }
    }
  }
  stop() { for (const item of this.queue) { this.patch(item.messageId, { queued: false, canceled: true }); const task = this.session.tasks?.find(task => task.id === item.id); if (task) { task.status = 'stopped'; task.result = '已取消佇列'; task.endedAt = Date.now(); } } this.queue = []; this.controller?.abort(); this.diagnosticController?.abort(); this.state(); }

  async addContext() {
    const root = this.workspace(); if (!root) throw new Error('請先開啟專案。');
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), '**/{.git,node_modules,.local,dist,build}/**', 250);
    const chosen = await vscode.window.showQuickPick(files.map(uri => ({ label: path.relative(root.uri.fsPath, uri.fsPath), uri })), { title: '加入專案檔案作為脈絡' });
    if (!chosen) return;
    const relative = path.relative(root.uri.fsPath, chosen.uri.fsPath).replaceAll(path.sep, '/');
    await safePath(root.uri.fsPath, relative); await diskText(chosen.uri.fsPath);
    if (!this.contextFiles.some(file => file.relative === relative)) this.contextFiles.push({ relative });
    this.contextFiles = this.contextFiles.slice(-3); this.state();
  }
  configureScanner() { const config = vscode.workspace.getConfiguration('ntpuAI'); scanner.options = { ...config.get('attachments.ocr', {}) }; }
  async attach() {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, title: '附加圖片或 PDF（會隨提問送給 NTPU AI）',
      filters: { '圖片或 PDF': ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'] } });
    if (!files?.length) return;
    const file = files[0]; const stat = await fs.stat(file.fsPath);
    await this.approveData(await fs.realpath(file.fsPath), true);
    if (stat.size > 20 * 1024 * 1024) throw new Error('附件上限 20 MB。');
    const buffer = await fs.readFile(file.fsPath);
    this.configureScanner();
    let mimeType, preview;
    if (buffer.subarray(0, 5).toString() === '%PDF-') mimeType = 'application/pdf';
    else { mimeType = imageMime(buffer); preview = 'data:image/png;base64,' + (await thumbnail(buffer)).toString('base64'); }
    await scanner.scan(buffer, mimeType);
    this.attachment = { name: path.basename(file.fsPath), mimeType, buffer, preview, approved: true }; this.state();
  }
  async addSkillDirectory() {
    if (this.busy()) return;
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '加入 skills 資料夾（內含 <名稱>/SKILL.md）' });
    if (!folders?.length) return;
    const config = vscode.workspace.getConfiguration('ntpuAI');
    const directories = [...new Set([...config.get('skillDirectories', []), folders[0].fsPath])];
    await config.update('skillDirectories', directories, vscode.ConfigurationTarget.Global);
    this.skills.extraDirectories = directories; await this.refreshSkills();
  }
  async artifact({ buffer, mimeType, title }) {
    if (buffer.length > 8 * 1024 * 1024) throw new Error('圖片產出超過 8 MB。');
    const actualMime = imageMime(buffer); this.configureScanner(); await scanner.scan(buffer, actualMime); const extension = actualMime === 'image/jpeg' ? 'jpg' : actualMime.split('/')[1];
    const directory = path.join(this.context.globalStorageUri.fsPath, 'artifacts');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(), file = path.join(directory, id + '.' + extension);
    await fs.writeFile(file, buffer, { mode: 0o600 });
    const uri = 'data:image/png;base64,' + (await thumbnail(buffer)).toString('base64');
    this.add('artifact', title || '圖片產出', { artifactId: id, imageUri: uri, thumbnailData: uri, cacheFile: file, mimeType: actualMime });
    return { id, uri };
  }
  async refreshArtifacts() {
    const current = this.session;
    for (const message of current.messages) {
      if (message.role !== 'artifact' || message.thumbnailData || !message.cacheFile?.startsWith(path.join(this.context.globalStorageUri.fsPath, 'artifacts') + path.sep)) continue;
      try {
        const file = path.resolve(message.cacheFile);
        if (!file.startsWith(path.join(this.context.globalStorageUri.fsPath, 'artifacts') + path.sep)) continue;
        const stat = await fs.stat(file); if (stat.size > 8 * 1024 * 1024) continue;
        message.thumbnailData = 'data:image/png;base64,' + (await thumbnail(await fs.readFile(file))).toString('base64');
        message.imageUri = message.thumbnailData;
        if (this.session === current) this.post({ kind: 'patch', message });
        this.persist();
      } catch {}
    }
  }
  async mcpContent(content) {
    const result = [];
    let textBudget = 24000;
    for (const item of content.slice(0, 10)) {
      if (item.type === 'image' && typeof item.data === 'string') {
        if (item.data.length > 12 * 1024 * 1024) throw new Error('MCP 圖片過大。');
        const artifact = await this.artifact({ buffer: Buffer.from(item.data, 'base64'), mimeType: item.mimeType, title: 'MCP 圖片產出' });
        result.push({ type: 'image', artifact: artifact.id });
      } else if (item.type === 'text') { const text = String(item.text).slice(0, Math.min(18000, textBudget)); textBudget -= text.length; result.push({ type: 'text', text, truncated: text.length < String(item.text).length }); }
      else if (item.type === 'resource_link') result.push({ type: 'resource_link', uri: item.uri, name: item.name });
      else result.push({ type: item.type, note: '此內容類型沒有內嵌顯示。' });
    }
    return result;
  }
  changed(change) {
    this.changeReview.capture(change); this.postChanges(); this.persist();
  }
  postChanges() { this.post({ kind: 'changes', changes: this.changeReview.view() }); }
  async showChange(id) {
    const change = this.changeReview.find(id); if (!change) return;
    if (change.binary) { await this.openFile(change.path); return; }
    await vscode.commands.executeCommand('vscode.diff', this.previews.put('before/' + change.path, change.before || ''),
      this.previews.put('after/' + change.path, change.after), 'NTPU AI 修改：' + change.path, { preview: true });
  }
  async revert(id) {
    await this.changeReview.act({ id, action: 'revert' });
  }
  async openFile(relative) {
    if (typeof relative !== 'string') return;
    const root = this.workspace(); if (!root) throw new Error('請先開啟專案。');
    const match = relative.match(/^(.*?):(\d+)$/); const file = match ? match[1] : relative;
    const absolute = await safePath(root.uri.fsPath, file);
    if (/\.(png|jpg|jpeg|webp|gif|pdf)$/i.test(file)) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute)); return; }
    await vscode.window.showTextDocument(vscode.Uri.file(absolute), match ? { selection: new vscode.Range(Number(match[2]) - 1, 0, Number(match[2]) - 1, 0) } : {});
  }
  artifactMessage(id) {
    const message = this.session.messages.find(item => item.role === 'artifact' && item.artifactId === id);
    if (!message?.cacheFile?.startsWith(path.join(this.context.globalStorageUri.fsPath, 'artifacts') + path.sep)) throw new Error('找不到這個圖片產出。');
    return message;
  }
  async openArtifact(id) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.artifactMessage(id).cacheFile)); }
  async saveArtifact(id) {
    const message = this.artifactMessage(id);
    const extension = message.mimeType === 'image/jpeg' ? 'jpg' : message.mimeType.split('/')[1];
    const filename = 'NTPU-image.' + extension;
    const target = await vscode.window.showSaveDialog({ title: '另存圖片', defaultUri: this.workspace() ? vscode.Uri.joinPath(this.workspace().uri, filename) : undefined, filters: { 圖片: [extension] } });
    if (target) await vscode.workspace.fs.writeFile(target, await fs.readFile(message.cacheFile));
  }
  async openLink(url) {
    if (typeof url !== 'string') return;
    if (/^https?:\/\//i.test(url)) {
      const target = new URL(url); if (target.username || target.password) throw new Error('不開啟含有帳密的網址。');
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else if (!/^[a-z]+:/i.test(url)) await this.openFile(url);
  }
  async exportSession(id = this.session.id) {
    const source = await this.store.openSession(id);
    const snapshot = sanitize({ title: source.title, messages: source.messages });
    const target = await vscode.window.showSaveDialog({ title: '匯出工作階段', defaultUri: vscode.Uri.joinPath(this.context.globalStorageUri, 'NTPU-AI-session.md'), filters: { Markdown: ['md'] } });
    if (!target) return;
    const text = '# ' + snapshot.title + '\n\n' + snapshot.messages.map(message =>
      `## ${message.role === 'user' ? '使用者' : 'NTPU AI'}\n\n${message.text || JSON.stringify({ name: message.name, args: message.args, result: message.result })}\n`).join('\n');
    await vscode.workspace.fs.writeFile(target, Buffer.from(redact(text))); await vscode.window.showTextDocument(target);
  }

  async approveData(file, attachment = false) {
    const level = classifyPath(file, vscode.workspace.getConfiguration('ntpuAI').get('privacy.reviewPaths', [])).level;
    if (level === 'protected') throw new Error('受保護路徑禁止傳送。');
    if (!attachment && level !== 'review') return;
    const answer = await vscode.window.showWarningMessage('這份資料將傳送至 NTPU AI：' + redact(file),
      { modal: true, detail: '文字秘密會遮蔽。圖片與 PDF 的秘密無法由文字掃描辨識，請先確認附件。完整存取仍需要此次資料確認。' }, '確認傳送');
    if (answer !== '確認傳送') throw new Error('未批准資料傳送。');
  }

  async connectServer(name) {
    if (this.busy()) return;
    const server = BUILTINS.find(server => server.name === name) || this.servers.find(server => server.name === name);
    if (!server) throw new Error('找不到這個 MCP 設定。');
    if (!server.builtin) {
      const detail = server.type === 'stdio' ? '將在 OS 沙箱中啟動，工作區唯讀、禁止網路；無法啟動時停止：\n' + [server.command, ...(server.args || [])].join(' ') : '將連線至：\n' + server.url;
      const answer = await this.gate.request({ title: '連線 MCP：' + server.name, detail, accept: '連線' }, new AbortController().signal);
      if (answer !== '連線') return;
    }
    await this.mcp.connect(server); this.capabilities();
  }
  async addServer() {
    if (this.busy()) return;
    const choice = await vscode.window.showQuickPick([{ label: 'HTTP / HTTPS', type: 'http' }, { label: '本地 stdio', type: 'stdio' }], { title: '新增 MCP server' });
    if (!choice) return;
    const name = await vscode.window.showInputBox({ title: 'MCP 名稱', prompt: '英數字、底線或連字號' }); if (!name) return;
    if (BUILTINS.some(server => server.name === name) || this.servers.some(server => server.name === name)) throw new Error('名稱已存在。');
    const config = { name, type: choice.type };
    if (choice.type === 'http') {
      config.url = await vscode.window.showInputBox({ title: 'MCP endpoint URL', placeHolder: 'https://example.com/mcp' }); if (!config.url) return;
      validateServer(config);
      const token = await vscode.window.showInputBox({ title: 'API key／token（選用）', prompt: '留空表示不使用金鑰。會存入 VS Code SecretStorage。', password: true });
      if (token) {
        const header = await vscode.window.showQuickPick(['Authorization（Bearer token）', 'x-api-key'], { title: 'MCP 金鑰傳送方式' });
        if (!header) return;
        config.authHeader = header === 'x-api-key' ? 'x-api-key' : 'Authorization';
        config.secretKey = 'ntpuAI.mcp.' + name; await this.context.secrets.store(config.secretKey, token);
      }
    } else {
      config.command = await vscode.window.showInputBox({ title: 'MCP 執行檔', placeHolder: 'node' }); if (!config.command) return;
      const args = await vscode.window.showInputBox({ title: 'MCP args（JSON 陣列）', value: '[]' }); if (args === undefined) return;
      config.args = JSON.parse(args); validateServer(config);
    }
    this.servers.push(config); await this.context.globalState.update('ntpuAI.mcpServers', this.servers); this.capabilities();
  }
  async importServers() {
    if (this.busy()) return;
    const chosen = await vscode.window.showOpenDialog({ canSelectMany: false, title: '匯入 VS Code／OpenCode MCP 設定', filters: { JSON: ['json', 'jsonc'] } });
    if (!chosen?.length) return;
    const text = await fs.readFile(chosen[0].fsPath, 'utf8');
    if (text.length > 100000) throw new Error('MCP 設定檔過大。');
    const config = require('jsonc-parser').parse(text);
    const source = config?.servers || config?.mcpServers || config?.mcp;
    if (!source || typeof source !== 'object') throw new Error('找不到 servers、mcpServers 或 mcp 設定。');
    const choices = Object.entries(source).map(([name, value]) => ({ label: name, value }));
    const entries = await vscode.window.showQuickPick(choices, { title: '選擇要匯入的 MCP（不會自動啟動）', canPickMany: true });
    for (const entry of entries || []) {
      const value = entry.value; const name = entry.label;
      const command = Array.isArray(value.command) ? value.command[0] : value.command;
      const server = { name, type: value.url ? (value.type === 'sse' ? 'sse' : 'http') : 'stdio', url: value.url,
        command, args: Array.isArray(value.command) ? value.command.slice(1) : value.args || [] };
      validateServer(server); server.envSecrets = {};
      for (const [key, secret] of Object.entries(value.env || value.environment || {})) {
        if (typeof secret !== 'string') continue;
        const reference = `ntpuAI.mcp.${name}.env.${key}`; await this.context.secrets.store(reference, secret); server.envSecrets[key] = reference;
      }
      server.headerSecrets = {};
      for (const [header, secret] of Object.entries(value.headers || {})) {
        if (typeof secret !== 'string' || !/^[a-zA-Z0-9-]+$/.test(header) || /^(cookie|host|connection|content-length)$/i.test(header)) continue;
        const reference = `ntpuAI.mcp.${name}.header.${header}`;
        await this.context.secrets.store(reference, secret); server.headerSecrets[header] = reference;
      }
      if (!BUILTINS.some(item => item.name === name)) this.servers = this.servers.filter(item => item.name !== name).concat(server);
    }
    await this.context.globalState.update('ntpuAI.mcpServers', this.servers); this.capabilities();
  }
  async dispose() { clearInterval(this.poller); await this.ready; this.stop(); clearTimeout(this.saveTimer); await this.loginOperation?.catch(() => {}); await this.connectionCheck?.catch(() => {}); await this.concurrencyOperation?.catch(() => {}); await this.runOperation?.catch(() => {}); this.requestRate.close(); await this.save(); await this.bridge?.close(); await this.mcp.close(); await this.sandbox.close(); }
}

module.exports = { AgentApp };
