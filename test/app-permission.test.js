'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { setImmediate: tick } = require('node:timers/promises');

test('real AgentApp saves explicit approval choices immediately and restores them safely', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-permission-'));
  const apps = new Set();
  t.after(async () => { for (const app of apps) await app.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
  const state = new Map(), memento = { get: (key, fallback) => state.get(key) ?? fallback,
    update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) };
  const mock = { Uri: { file: uri },
    window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
    workspace: { isTrusted: true, workspaceFolders: [{ name: 'test', uri: uri(directory) }],
      registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => fallback }) } };
  const originalLoad = Module._load; let AgentApp;
  try { Module._load = function(name, ...args) { return name === 'vscode' ? mock : originalLoad.call(this, name, ...args); }; ({ AgentApp } = require('../src/app')); }
  finally { Module._load = originalLoad; }
  const context = { subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(directory, 'storage')),
    workspaceState: memento, globalState: { get: (key, fallback) => fallback, update: async () => {} }, secrets: { get: async () => undefined } };
  async function open() { const app = new AgentApp(context); apps.add(app); await app.ready; return app; }
  async function restart(app) { await app.dispose(); apps.delete(app); return open(); }
  async function pending(app) {
    for (let i = 0; i < 100 && !app.gate.pending; i++) await tick();
    assert.ok(app.gate.pending); return app.gate.pending;
  }
  let app = await open();
  const id = app.session.id;
  app.store.add(app.session, { role: 'user', text: '保留這段聊天' });
  await app.store.updateProject(app.session.workspace, project => project.entries.push({ id: 'existing', kind: 'preference', text: '保留專案記憶' }));
  const projectBefore = JSON.stringify(await app.store.project(app.session.workspace));
  const disk = async () => JSON.parse(await fs.readFile(app.store.file(id), 'utf8')).session;

  await t.test('assisted reaches disk before the option operation returns, then survives reload', async () => {
    app.policies.set(id, { grants: ['write_file'] });
    await app.handle({ kind: 'option', key: 'permission', value: 'assisted' });
    assert.equal((await disk()).options.permission, 'assisted');
    assert.equal((await disk()).permissionChoice, 'assisted');
    assert.equal(app.policies.has(id), false);
    app = await restart(app);
    assert.equal(app.session.id, id); assert.equal(app.session.options.permission, 'assisted'); assert.equal(app.gate.pending, null);
  });
  await t.test('full still requires the existing approval and rejection preserves the saved choice', async () => {
    const operation = app.setOption('permission', 'full'), approval = await pending(app);
    assert.equal(app.session.options.permission, 'assisted'); assert.equal((await disk()).options.permission, 'assisted');
    app.gate.decide(approval.id, false); await operation;
    assert.equal(app.session.permissionChoice, 'assisted');
  });
  await t.test('approved full survives restart without restoring temporary tool grants', async () => {
    const operation = app.setOption('permission', 'full'), approval = await pending(app);
    assert.equal(approval.detail.accept, '啟用完整存取');
    app.gate.decide(approval.id, true); await operation;
    assert.equal((await disk()).permissionChoice, 'full');
    await app.setOption('depth', 'deep');
    app = await restart(app);
    assert.equal(app.session.options.permission, 'full'); assert.equal(app.session.options.depth, 'deep'); assert.equal(app.policies.size, 0);
  });
  await t.test('new chats and restored backups keep ask while the original choice stays saved', async () => {
    assert.equal(JSON.stringify(await app.store.project(app.session.workspace)), projectBefore);
    const backup = await app.store.backup(); await app.store.restore(backup);
    const restored = await app.store.openSession(app.store.sessions.find(item => item.id !== id).id);
    assert.equal(restored.options.permission, 'ask'); assert.equal(restored.permissionChoice, undefined);
    await app.newSession(); assert.notEqual(app.session.id, id); assert.equal(app.session.options.permission, 'ask');
    await app.handle({ kind: 'switch', id }); assert.equal(app.session.options.permission, 'full');
    assert.equal(app.session.messages[0].text, '保留這段聊天');
    assert.deepEqual((await app.store.project(app.session.workspace)).entries, JSON.parse(projectBefore).entries);
  });
  await t.test('save failure reports an error and rolls back both mode and its saved choice', async () => {
    const save = app.save; app.save = async () => { throw new Error('fixture disk full'); };
    try { await assert.rejects(app.setOption('permission', 'assisted'), /fixture disk full/); }
    finally { app.save = save; }
    assert.equal(app.session.options.permission, 'full'); assert.equal(app.session.permissionChoice, 'full');
    assert.equal((await disk()).options.permission, 'full');
  });
  await t.test('switching back to ask is also durable', async () => {
    await app.setOption('permission', 'ask'); app = await restart(app);
    assert.equal(app.session.options.permission, 'ask'); assert.equal(app.session.permissionChoice, 'ask');
  });
});
