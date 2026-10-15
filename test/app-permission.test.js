'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { setImmediate: tick } = require('node:timers/promises');
const { ApprovalPreferences, APPROVAL_MODE_KEY } = require('../src/approval-preferences');

test('real AgentApp uses one durable approval choice across old, new, restored and reopened chats', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-permission-'));
  const apps = new Set();
  t.after(async () => { for (const app of apps) await app.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
  const state = new Map(), memento = { get: (key, fallback) => state.get(key) ?? fallback,
    update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value) };
  const globalFile = path.join(directory, 'global-state.json'); let globalValues = {};
  const globalState = { get: (key, fallback) => globalValues[key] ?? fallback, update: async (key, value) => {
    const next = { ...globalValues, [key]: value }; await fs.writeFile(globalFile, JSON.stringify(next)); globalValues = next;
  } };
  const mock = { Uri: { file: uri },
    window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
    workspace: { isTrusted: true, workspaceFolders: [{ name: 'test', uri: uri(directory) }],
      registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => fallback }) } };
  const originalLoad = Module._load; let AgentApp;
  try { Module._load = function(name, ...args) { return name === 'vscode' ? mock : originalLoad.call(this, name, ...args); }; ({ AgentApp } = require('../src/app')); }
  finally { Module._load = originalLoad; }
  const context = { subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(directory, 'storage')),
    workspaceState: memento, globalState, secrets: { get: async () => undefined } };
  async function open() { const app = new AgentApp(context); apps.add(app); await app.ready; return app; }
  async function restart(app) {
    await app.dispose(); apps.delete(app);
    globalValues = JSON.parse(await fs.readFile(globalFile, 'utf8'));
    return open();
  }
  async function pending(app) {
    if (app.gate.pending) return app.gate.pending;
    return new Promise((resolve, reject) => {
      const original = app.gate.onChange;
      const finish = (error, approval) => {
        clearTimeout(timer); app.gate.onChange = original;
        if (error) reject(error); else resolve(approval);
      };
      const timer = setTimeout(() => finish(new Error('Expected an actual approval event within 5 seconds')), 5000);
      app.gate.onChange = value => { original(value); if (value) finish(null, app.gate.pending); };
    });
  }
  let app = await open();
  const id = app.session.id;
  app.store.add(app.session, { role: 'user', text: '保留這段聊天' });
  await app.store.updateProject(app.session.workspace, project => project.entries.push({ id: 'existing', kind: 'preference', text: '保留專案記憶' }));
  const projectBefore = JSON.stringify(await app.store.project(app.session.workspace));
  const globalMode = async () => JSON.parse(await fs.readFile(globalFile, 'utf8'))[APPROVAL_MODE_KEY];
  const older = app.store.create(app.session.workspace);
  older.options.depth = 'quick'; older.options.web = false; older.options.agent = 'review';
  await app.store.save(older);

  await t.test('assisted reaches disk before the option operation returns, then survives reload', async () => {
    app.policies.set(id, { grants: ['write_file'] });
    await app.handle({ kind: 'option', key: 'permission', value: 'assisted' });
    assert.equal(await globalMode(), 'assisted');
    assert.equal(older.options.permission, 'assisted');
    assert.equal(app.policies.has(id), false);
    app = await restart(app);
    assert.equal(app.session.id, id); assert.equal(app.session.options.permission, 'assisted'); assert.equal(app.gate.pending, null);
  });
  await t.test('full still requires the existing approval and rejection preserves the saved choice', async () => {
    const operation = app.setOption('permission', 'full'), approval = await pending(app);
    assert.equal(app.session.options.permission, 'assisted'); assert.equal(await globalMode(), 'assisted');
    assert.match(approval.detail.title, /所有聊天/);
    app.gate.decide(approval.id, false); await operation;
    assert.equal(await globalMode(), 'assisted');
  });
  await t.test('approved full survives restart without restoring temporary tool grants', async () => {
    const operation = app.setOption('permission', 'full'), approval = await pending(app);
    assert.equal(approval.detail.accept, '啟用完整存取');
    app.gate.decide(approval.id, true); await operation;
    assert.equal(await globalMode(), 'full');
    await app.setOption('depth', 'deep');
    app = await restart(app);
    assert.equal(app.session.options.permission, 'full'); assert.equal(app.session.options.depth, 'deep'); assert.equal(app.policies.size, 0);
  });
  await t.test('old, new and restored chats share approval while other options stay independent', async () => {
    assert.equal(JSON.stringify(await app.store.project(app.session.workspace)), projectBefore);
    await app.handle({ kind: 'switch', id: older.id });
    assert.equal(app.session.options.permission, 'full'); assert.equal(app.session.options.depth, 'quick');
    assert.equal(app.session.options.web, false); assert.equal(app.session.options.agent, 'review');
    await app.handle({ kind: 'switch', id }); assert.equal(app.session.options.depth, 'deep');
    const backup = await app.store.backup(); await app.store.restore(backup);
    const restored = await app.store.openSession(app.store.sessions.find(item => ![id, older.id].includes(item.id)).id);
    assert.equal(restored.options.permission, 'full'); assert.equal(await globalMode(), 'full');
    await app.newSession(); assert.notEqual(app.session.id, id); assert.equal(app.session.options.permission, 'full');
    await app.handle({ kind: 'switch', id }); assert.equal(app.session.options.permission, 'full');
    assert.equal(app.session.messages[0].text, '保留這段聊天');
    assert.deepEqual((await app.store.project(app.session.workspace)).entries, JSON.parse(projectBefore).entries);
  });
  await t.test('global save failure reports an error and changes no effective chat mode', async () => {
    const update = globalState.update; globalState.update = async () => { throw new Error('fixture disk full'); };
    const states = [], post = app.post;
    app.post = message => { if (message.kind === 'state') states.push(structuredClone(message)); };
    try { await assert.rejects(app.setOption('permission', 'assisted'), /fixture disk full/); }
    finally { globalState.update = update; app.post = post; }
    assert.equal(app.session.options.permission, 'full'); assert.equal(await globalMode(), 'full');
    assert.equal(states.at(-1).options.permission, 'full', 'the visible selector is reset to the actual saved mode');
    for (const session of app.store.loaded.values()) assert.equal(session.options.permission, 'full');
  });
  await t.test('switching back to ask is also durable', async () => {
    await app.setOption('permission', 'ask'); app = await restart(app);
    assert.equal(app.session.options.permission, 'ask'); assert.equal(await globalMode(), 'ask');
    await app.handle({ kind: 'switch', id: older.id }); assert.equal(app.session.options.permission, 'ask');
    const backup = await app.store.backup();
    for (const session of backup.sessions) { session.options.permission = 'full'; session.permissionChoice = 'full'; }
    await app.store.restore(backup);
    for (const session of app.store.loaded.values()) assert.equal(session.options.permission, 'ask', 'backup cannot change the separately saved global approval');
  });
  await t.test('config import shares only approval and rolls back when global storage fails', async () => {
    const file = path.join(directory, 'agent.ntpu-ai.json');
    // Real chooser/file I/O can take longer than any fixed number of event-loop
    // turns; exercise an actual delay before waiting for the gate's event.
    mock.window.showOpenDialog = async () => { await new Promise(resolve => setTimeout(resolve, 50)); return [uri(file)]; };
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, permission: 'assisted', depth: 'deep' }));
    const operation = app.agentSettings.importFile(), approval = await pending(app);
    assert.match(approval.detail.detail, /所有聊天/);
    app.gate.decide(approval.id, true); await operation;
    assert.equal(await globalMode(), 'assisted');
    for (const session of app.store.loaded.values()) assert.equal(session.options.permission, 'assisted');
    const before = structuredClone(app.session.options), update = globalState.update;
    globalState.update = async () => { throw new Error('fixture global storage unavailable'); };
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, permission: 'ask', depth: 'quick' }));
    try {
      const failed = app.agentSettings.importFile(), rejection = assert.rejects(failed, /fixture global storage/), preview = await pending(app);
      app.gate.decide(preview.id, true); await rejection;
    } finally { globalState.update = update; }
    assert.deepEqual(app.session.options, before);
    assert.equal(await globalMode(), 'assisted');
    const disk = JSON.parse(await fs.readFile(app.store.file(app.session.id), 'utf8')).session;
    assert.deepEqual(disk.options, before);
    app = await restart(app); assert.equal(app.session.options.permission, 'assisted');
  });
});

test('invalid stored global modes default to ask without accepting project or session values', async () => {
  const preferences = new ApprovalPreferences({ get: () => 'invalid', update: async () => {} });
  assert.equal(preferences.mode, 'ask');
  await assert.rejects(preferences.set('invalid'), /核准模式/);
});
test('global preferences refresh on focus and serialize writes without exposing pending or failed values', async () => {
  let saved = 'ask', release;
  const events = [], storage = { get: () => saved, update: async (key, value) => {
    saved = value; await new Promise(resolve => { release = resolve; });
  } };
  const preferences = new ApprovalPreferences(storage, mode => events.push(mode));
  const first = preferences.set('assisted'); await tick();
  preferences.refresh(); assert.equal(preferences.mode, 'ask');
  const second = preferences.set('ask'); release(); await first; await tick();
  assert.equal(preferences.mode, 'assisted'); release(); await second;
  assert.equal(preferences.mode, 'ask'); assert.deepEqual(events, ['assisted', 'ask']);
  saved = 'assisted'; preferences.refresh(); assert.equal(preferences.mode, 'assisted');
  storage.update = async () => { saved = 'full'; throw new Error('fixture global storage failed'); };
  await assert.rejects(preferences.set('full'), /fixture global storage/);
  preferences.refresh(); assert.equal(preferences.mode, 'assisted');
});
