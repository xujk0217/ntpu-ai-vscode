'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

test('real AgentApp migrates history, persists checkpoints and keeps memory across mock account changes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-app-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
  const state = new Map([['ntpuAI.sessions.v2', [{ id: 'legacy-session', title: '歷史', workspace: uri(directory).toString(), messages: [{ id: 'msg1', role: 'user', text: '原本的需求' }] }]]]);
  const config = new Map();
  const mock = { Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) }, ConfigurationTarget: { Global: 1 },
    window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }), showWarningMessage: async (...args) => args.at(-1) },
    workspace: { isTrusted: true, workspaceFolders: [{ name: 'test', uri: uri(directory) }], registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback) => config.get(key) ?? fallback, update: async (key, value) => config.set(key, value) }) } };
  const original = Module._load;
  let AgentApp;
  try { Module._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); }; ({ AgentApp } = require('../src/app')); }
  finally { Module._load = original; }
  const context = { subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(directory, 'storage')),
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) },
    globalState: { get: (key, fallback) => fallback, update: async () => {} }, secrets: { get: async () => undefined } };
  const app = new AgentApp(context); await app.ready;
  assert.equal(app.parallelState().effectiveConcurrency, 2); assert.equal(app.parallelState().workerConcurrency, 4);
  app.parallelVerification = { timestamp: '2000-01-01', verified: false };
  assert.equal(app.parallelState().effectiveConcurrency, 2, 'expired diagnostic proof does not gate runtime');
  config.set('parallel.maxSubagents', 5); assert.equal(app.parallelState().workerConcurrency, 4);
  assert.equal(app.session.id, 'legacy-session'); assert.equal(state.has('ntpuAI.sessions.v2'), false);
  const editorFile = path.join(directory, 'settings.js'); await fs.writeFile(editorFile, 'API_KEY=only-test-editor');
  mock.window.activeTextEditor = { document: { uri: uri(editorFile), getText: () => 'API_KEY=only-test-editor' },
    selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } } };
  assert.equal((await app.editorContext({ uri: uri(directory) }, true, [])).includes('only-test-editor'), false);
  mock.window.activeTextEditor = undefined;
  app.session.checkpoint = { request: '繼續登入功能', records: [{ name: 'read_file', result: { ok: true, path: 'login.js' } }] };
  await app.store.updateProject(app.session.workspace, project => project.entries.push({ id: 'e1', kind: 'preference', text: '使用 TypeScript' }));
  await app.save();
  const prompts = []; let account = 'A', completed = false;
  const bridge = { page: { isClosed: () => false }, logout: async () => {}, open: async () => {},
    status: async () => ({ ready: true, message: 'Mock Account ' + account }), close: async () => {},
    chat: async prompt => { prompts.push({ account, prompt }); return { text: JSON.stringify({ kind: 'final', message: 'mock result', completed }) }; } };
  app.getBridge = () => bridge;
  await app.ask('檢查登入系統', false); await app.logout(); account = 'B'; await app.login(); await app.ask('繼續', false);
  assert.equal(app.session.tasks.length, 2); assert.equal(app.session.tasks[0].status, 'blocked');
  assert.equal(prompts[1].account, 'B'); assert.match(prompts[1].prompt, /使用 TypeScript/);
  assert.equal(app.session.checkpoint.records.length, 1); assert.equal((await app.store.project(app.session.workspace)).entries[0].text, '使用 TypeScript');
  app.adaptive.block(Object.assign(new Error('rate limit'), { status: 429 }));
  const beforeBlocked = prompts.length; await assert.rejects(app.testConcurrency(), /暫停/); assert.equal(prompts.length, beforeBlocked);
  await app.handle({ kind: 'resumeParallel' }); assert.equal(app.parallelState().effectiveConcurrency, 1); assert.equal(prompts.length, beforeBlocked);
  await app.dispose();
  const reopened = new AgentApp(context); await reopened.ready;
  assert.equal(reopened.session.messages[0].text, '原本的需求'); assert.match(reopened.session.checkpoint.request, /檢查登入系統/);
  reopened.getBridge = () => bridge; completed = true; await reopened.ask('繼續', false);
  assert.equal(reopened.session.checkpoint, null);
  assert.equal(reopened.session.tasks[0].resolvedBy, reopened.session.tasks.at(-1).id);
  assert.equal(reopened.session.tasks[1].resolvedBy, reopened.session.tasks.at(-1).id);
  assert.equal((await reopened.store.project(reopened.session.workspace)).entries.filter(entry => entry.kind === 'pending' && !entry.stale).length, 0);
  const inactive = reopened.store.create(reopened.session.workspace); inactive.title = '另一筆聊天';
  reopened.store.add(inactive, { role: 'user', text: '指定的完整內容 PASSWORD=only-test-export' }); await reopened.store.save(inactive);
  const exported = uri(path.join(directory, 'export.md')); mock.window.showSaveDialog = async () => exported;
  mock.window.showTextDocument = async () => {}; mock.workspace.fs = { writeFile: async (target, bytes) => fs.writeFile(target.fsPath, bytes) };
  const activeId = reopened.session.id;
  await reopened.memoryActions.handle({ kind: 'exportSession', id: inactive.id });
  const markdown = await fs.readFile(exported.fsPath, 'utf8');
  assert.match(markdown, /另一筆聊天/); assert.match(markdown, /指定的完整內容/); assert.equal(markdown.includes('only-test-export'), false);
  assert.equal(markdown.includes('mock result'), false); assert.equal(reopened.session.id, activeId);
  let loginWindows = 0;
  bridge.mode = 'background';
  bridge.status = async () => ({ ready: false, authentication: 'required', loginWindow: bridge.mode === 'login', message: 'Mock requires login' });
  bridge.openLogin = async () => { loginWindows++; bridge.mode = 'login'; };
  await reopened.login(false);
  assert.equal(loginWindows, 0, 'automatic background connection never opens a login window');
  await reopened.login();
  assert.equal(loginWindows, 1, 'explicit login opens the native login window');
  assert.equal(reopened.connection.loginWindow, true);
  bridge.mode = 'background'; bridge.status = async () => ({ ready: true });
  let unavailableCalls = 0;
  bridge.chat = async () => { if (++unavailableCalls === 1) await reopened.ask('後續排隊提問', false); throw new Error('timeout'); };
  await reopened.ask('檢查普通逾時', false);
  assert.equal(unavailableCalls, 3); assert.equal(reopened.adaptive.blocked, true);
  assert.equal(reopened.queue.length, 0); assert.equal(reopened.session.tasks.at(-1).status, 'stopped');
  assert.equal(reopened.session.tasks.at(-2).status, 'blocked'); assert.equal(reopened.session.checkpoint.records.filter(record => record.type === 'request_error').length, 3);
  await reopened.dispose();
});
