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
    workspace: { workspaceFolders: [{ name: 'test', uri: uri(directory) }], registerTextDocumentContentProvider: () => ({ dispose() {} }),
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
  app.session.checkpoint = { request: '繼續登入功能', records: [{ name: 'read_file', result: { ok: true, path: 'login.js' } }] };
  await app.store.updateProject(app.session.workspace, project => project.entries.push({ id: 'e1', kind: 'preference', text: '使用 TypeScript' }));
  await app.save();
  const bridge = { logout: async () => {}, open: async () => {}, status: async () => ({ ready: true, message: 'Mock Account B' }), close: async () => {} };
  app.getBridge = () => bridge; await app.logout(); await app.login();
  assert.equal(app.session.checkpoint.records.length, 1); assert.equal((await app.store.project(app.session.workspace)).entries[0].text, '使用 TypeScript');
  await app.dispose();
  const reopened = new AgentApp(context); await reopened.ready;
  assert.equal(reopened.session.messages[0].text, '原本的需求'); assert.equal(reopened.session.checkpoint.request, '繼續登入功能');
  await reopened.dispose();
});
