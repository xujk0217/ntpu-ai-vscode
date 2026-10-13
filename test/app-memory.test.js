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
    globalState: { get: (key, fallback) => fallback }, secrets: { get: async () => undefined } };
  const app = new AgentApp(context); await app.ready;
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
  await app.dispose();
  const reopened = new AgentApp(context); await reopened.ready;
  assert.equal(reopened.session.messages[0].text, '原本的需求'); assert.match(reopened.session.checkpoint.request, /檢查登入系統/);
  reopened.getBridge = () => bridge; completed = true; await reopened.ask('繼續', false);
  assert.equal(reopened.session.checkpoint, null);
  assert.equal(reopened.session.tasks[0].resolvedBy, reopened.session.tasks[2].id);
  assert.equal(reopened.session.tasks[1].resolvedBy, reopened.session.tasks[2].id);
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
  await reopened.dispose();
});
