'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setImmediate: tick } = require('node:timers/promises');
const { ApprovalGate } = require('../src/approval');
const { DEFAULT_OPTIONS, SessionStore } = require('../src/sessions');
const { MemoryStore } = require('../src/memory/store');
const { ApprovalPreferences } = require('../src/approval-preferences');
const { AgentSettingsFiles, SETTINGS_FILE, MAX_SETTINGS_BYTES, OPTION_VALUES, FULL_ACCESS_NOTICE,
  parseAgentSettings, serializeAgentSettings, readAgentSettings, saveAgentSettings } = require('../src/agent-settings');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-agent-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => 'file://' + file });
  const file = path.join(directory, SETTINGS_FILE), events = [], opened = [];
  const app = { session: { id: 'test-session', options: structuredClone(DEFAULT_OPTIONS), messages: [{ role: 'user', text: '保留對話' }], checkpoint: { request: '保留工作' } },
    ready: Promise.resolve(), running: false, busy() { return this.running; }, policies: new Map([['test-session', { grants: ['fixture'] }]]),
    skills: { items: new Map([['review', {}]]) }, workspace: () => ({ uri: uri(directory) }),
    gate: new ApprovalGate(value => events.push(value)), state() { events.push({ busy: !!this.agentSettingsBusy }); },
    saves: [], async save() { this.saves.push(structuredClone(this.session)); }, capabilities() { this.capabilityUpdates = (this.capabilityUpdates || 0) + 1; } };
  const globalState = new Map();
  app.approvalPreferences = new ApprovalPreferences({ get: (key, fallback) => globalState.get(key) ?? fallback,
    update: async (key, value) => globalState.set(key, value) });
  app.savePermissionMode = mode => app.approvalPreferences.set(mode);
  const vscode = { Uri: { file: uri }, workspace: { isTrusted: true, textDocuments: [], openTextDocument: async target => target },
    window: { showOpenDialog: async () => [uri(file)], showSaveDialog: async () => uri(file), showTextDocument: async target => opened.push(target) } };
  const settings = new AgentSettingsFiles(app, vscode);
  const write = async patch => fs.writeFile(file, JSON.stringify({ schemaVersion: 1, ...patch }));
  async function pending() {
    const limit = Date.now() + 2000;
    while (!app.gate.pending && Date.now() < limit) await tick();
    assert.ok(app.gate.pending, 'expected an approval after reading the file');
    return app.gate.pending;
  }
  return { directory, uri, file, app, vscode, settings, events, opened, write, pending };
}

test('settings round-trip only the five supported options with BOM and partial patches', () => {
  const options = { ...DEFAULT_OPTIONS, depth: 'deep', permission: 'assisted', skills: ['review'], token: 'secret-only-test', profile: '/private/profile', grants: ['shell'] };
  const exported = serializeAgentSettings(options);
  assert.deepEqual(parseAgentSettings('\uFEFF' + exported, new Set(['review'])), {
    agent: 'build', depth: 'deep', permission: 'assisted', web: true, skills: ['review'] });
  assert.deepEqual(parseAgentSettings('{"schemaVersion":1,"depth":"quick"}'), { depth: 'quick' });
  assert.equal(exported.includes('secret-only-test'), false); assert.equal(exported.includes('/private/profile'), false);
  assert.deepEqual(Object.keys(JSON.parse(exported)), ['schemaVersion', 'agent', 'depth', 'permission', 'web', 'skills']);
});

test('invalid settings are rejected without exposing unknown keys or malformed source', () => {
  for (const value of [null, [], {}, { schemaVersion: 2, web: true }, { schemaVersion: 1 },
    { schemaVersion: 1, agent: 'sudo' }, { schemaVersion: 1, depth: 'maximum' }, { schemaVersion: 1, permission: 'yes' },
    { schemaVersion: 1, web: 'true' }, { schemaVersion: 1, skills: ['../secret'] }, { schemaVersion: 1, skills: ['review', 'review'] },
    { schemaVersion: 1, skills: ['a', 'b', 'c', 'd', 'e'] }, { schemaVersion: 1, token: 'secret-only-test' }]) {
    assert.throws(() => parseAgentSettings(JSON.stringify(value)));
  }
  for (const text of ['{"schemaVersion":1,"secret-only-test":true}', '{"schemaVersion":1,"permission":"secret-only-test"}',
    '{"schemaVersion":1,"web":"secret-only-test" bad}', '{"schemaVersion":1,"__proto__":{"permission":"full"}}']) {
    assert.throws(() => parseAgentSettings(text), error => !error.message.includes('secret-only-test') && !error.message.includes('__proto__'));
  }
  assert.throws(() => parseAgentSettings('x'.repeat(MAX_SETTINGS_BYTES + 1)), /16 KB/);
  assert.throws(() => parseAgentSettings(JSON.stringify({ schemaVersion: 1, skills: ['missing'] }), new Set(['review'])), /未安裝/);
  assert.equal({}.permission, undefined);
});

test('bundled JSON schema matches runtime fields, limits and enum values', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(__dirname, '../schemas/agent-settings.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ['schemaVersion']); assert.equal(schema.minProperties, 2);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['schemaVersion', 'agent', 'depth', 'permission', 'web', 'skills'].sort());
  for (const [key, values] of Object.entries(OPTION_VALUES)) assert.deepEqual(schema.properties[key].enum, values);
  assert.equal(schema.properties.skills.maxItems, 4); assert.equal(schema.properties.skills.uniqueItems, true);
});

test('file I/O validates UTF-8 and size, preserves unrelated files, and exports private config', async t => {
  const f = await fixture(t);
  await saveAgentSettings(f.file, DEFAULT_OPTIONS);
  assert.deepEqual(await readAgentSettings(f.file), DEFAULT_OPTIONS);
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  await saveAgentSettings(f.file, { ...DEFAULT_OPTIONS, depth: 'deep' });
  assert.equal((await readAgentSettings(f.file)).depth, 'deep');
  await fs.writeFile(f.file, '{"important":"source data"}');
  await assert.rejects(saveAgentSettings(f.file, DEFAULT_OPTIONS), /另選新檔案/);
  assert.equal(await fs.readFile(f.file, 'utf8'), '{"important":"source data"}');
  await fs.writeFile(f.file, Buffer.from([0xff, 0xfe])); await assert.rejects(readAgentSettings(f.file), /UTF-8/);
  await fs.writeFile(f.file, 'x'.repeat(MAX_SETTINGS_BYTES + 1)); await assert.rejects(readAgentSettings(f.file), /16 KB/);
  await assert.rejects(readAgentSettings(f.directory), /一般文字檔/);
});

test('failed writes or sync never damage existing settings or publish a partial new file', async t => {
  const f = await fixture(t), open = fs.open;
  for (const existing of [false, true]) for (const failure of ['write', 'sync']) {
    await fs.rm(f.file, { force: true });
    const original = serializeAgentSettings({ ...DEFAULT_OPTIONS, depth: 'quick' });
    if (existing) await fs.writeFile(f.file, original);
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        if (failure === 'write') handle.writeFile = async text => { await write(text.slice(0, 16)); throw new Error('fixture interrupted write'); };
        else handle.sync = async () => { throw new Error('fixture failed sync'); };
      }
      return handle;
    };
    try { await assert.rejects(saveAgentSettings(f.file, { ...DEFAULT_OPTIONS, depth: 'deep' }), /fixture/); }
    finally { fs.open = open; }
    if (existing) assert.equal(await fs.readFile(f.file, 'utf8'), original);
    else await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  }
});

test('export preserves destinations created or edited while the replacement is being written', async t => {
  const f = await fixture(t), open = fs.open;
  for (const existing of [false, true]) {
    await fs.rm(f.file, { force: true });
    if (existing) await fs.writeFile(f.file, serializeAgentSettings(DEFAULT_OPTIONS));
    const changed = serializeAgentSettings({ ...DEFAULT_OPTIONS, depth: 'quick', web: false });
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async text => { await fs.writeFile(f.file, changed); return write(text); };
      }
      return handle;
    };
    try { await assert.rejects(saveAgentSettings(f.file, { ...DEFAULT_OPTIONS, depth: 'deep' })); }
    finally { fs.open = open; }
    assert.equal(await fs.readFile(f.file, 'utf8'), changed);
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  }
});

test('project edit creates a whitelisted file once and preserves existing edits', async t => {
  const f = await fixture(t); f.app.session.options.token = 'secret-only-test';
  await f.settings.openProject(); assert.equal(f.opened.length, 1);
  assert.equal((await fs.readFile(f.file, 'utf8')).includes('secret-only-test'), false);
  await f.write({ depth: 'deep' }); const before = await fs.readFile(f.file, 'utf8');
  await f.settings.openProject(); assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.equal(f.app.saves.length, 0); assert.equal(f.app.session.options.depth, 'standard');
});

test('project creation is atomic and leaves a concurrently created file untouched', async t => {
  const f = await fixture(t), open = fs.open;
  for (const failure of [true, false]) {
    const concurrent = '{"schemaVersion":1,"depth":"quick"}';
    fs.open = async (file, ...args) => {
      const handle = await open(file, ...args);
      if (String(file).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async text => {
          if (failure) { await write(text.slice(0, 16)); throw new Error('fixture interrupted project write'); }
          await fs.writeFile(f.file, concurrent); return write(text);
        };
      }
      return handle;
    };
    try {
      if (failure) await assert.rejects(f.settings.openProject(), /fixture interrupted/);
      else await f.settings.openProject();
    } finally { fs.open = open; }
    if (failure) await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(f.file, 'utf8'), concurrent);
    assert.deepEqual((await fs.readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  }
});

test('project edit rejects an outward symlink and export never follows a symlink', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-settings-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, 'target.json'); await fs.writeFile(target, serializeAgentSettings(DEFAULT_OPTIONS));
  const before = await fs.readFile(target, 'utf8'); await fs.symlink(target, f.file);
  await assert.rejects(f.settings.openProject(), /工作區外/);
  await assert.rejects(f.settings.exportFile()); assert.equal(await fs.readFile(target, 'utf8'), before);
});

test('import previews merged options, requires approval and preserves history/checkpoint', async t => {
  const f = await fixture(t); await f.write({ depth: 'deep', permission: 'assisted', web: false, skills: ['review'] });
  const messages = f.app.session.messages, checkpoint = f.app.session.checkpoint;
  const operation = f.settings.importFile(), approval = await f.pending();
  assert.match(approval.detail.detail, /深入/); assert.match(approval.detail.detail, /協助核准/);
  assert.equal(f.app.session.options.depth, 'standard'); assert.equal(f.app.saves.length, 0);
  f.app.gate.decide(approval.id, true); assert.equal(await operation, true);
  assert.deepEqual(f.app.session.options, { ...DEFAULT_OPTIONS, depth: 'deep', permission: 'assisted', web: false, skills: ['review'] });
  assert.equal(f.app.session.messages, messages); assert.equal(f.app.session.checkpoint, checkpoint);
  assert.equal(f.app.policies.has(f.app.session.id), false); assert.equal(f.app.saves.length, 1);
  assert.equal(f.app.capabilityUpdates, 1); assert.equal(f.app.agentSettingsBusy, false);
});

test('full permission uses the existing gate warning and rejection changes nothing', async t => {
  const f = await fixture(t); await f.write({ permission: 'full' }); const before = structuredClone(f.app.session);
  const operation = f.settings.importFile(), approval = await f.pending();
  assert.equal(approval.detail.accept, '啟用完整存取並套用'); assert.ok(approval.detail.detail.includes(FULL_ACCESS_NOTICE));
  f.app.gate.decide(approval.id, false); assert.equal(await operation, false);
  assert.deepEqual(f.app.session, before); assert.equal(f.app.saves.length, 0); assert.equal(f.app.policies.has(f.app.session.id), true);
});

test('invalid file, unsaved edits and cancelled chooser never prompt or mutate', async t => {
  const f = await fixture(t); await f.write({ permission: 'yes' });
  await assert.rejects(f.settings.importFile(), /permission/); assert.equal(f.app.gate.pending, null);
  await f.write({ depth: 'deep' }); f.vscode.workspace.textDocuments = [{ uri: f.uri(f.file), isDirty: true }];
  await assert.rejects(f.settings.importFile(), /先儲存/);
  await assert.rejects(f.settings.exportFile(), /未儲存/);
  f.vscode.workspace.textDocuments = []; f.vscode.window.showOpenDialog = async () => undefined;
  assert.equal(await f.settings.importFile(), false);
  f.vscode.window.showSaveDialog = async () => undefined; assert.equal(await f.settings.exportFile(), undefined);
  assert.equal(f.app.saves.length, 0); assert.equal(f.app.agentSettingsBusy, false);
});

test('busy tasks, untrusted workspace and pending approvals block config operations', async t => {
  const f = await fixture(t); await f.write({ depth: 'deep' });
  f.app.running = true; await assert.rejects(f.settings.importFile(), /目前任務/); f.app.running = false;
  f.vscode.workspace.isTrusted = false; await assert.rejects(f.settings.importFile(), /信任/); f.vscode.workspace.isTrusted = true;
  const existing = f.app.gate.request({ title: 'other', accept: 'yes' }, new AbortController().signal);
  await assert.rejects(f.settings.openProject(), /目前任務/); f.app.gate.decide(f.app.gate.pending.id, false); await existing;
  assert.equal(f.app.saves.length, 0);
});

test('stale chooser or stale approval cannot apply options to a different session', async t => {
  const f = await fixture(t); await f.write({ permission: 'full' });
  const original = f.app.session;
  f.vscode.window.showOpenDialog = async () => { f.app.session = { ...original, id: 'another', options: structuredClone(DEFAULT_OPTIONS) }; return [f.uri(f.file)]; };
  await assert.rejects(f.settings.importFile(), /聊天或選項已改變/);
  f.app.session = original; f.vscode.window.showOpenDialog = async () => [f.uri(f.file)];
  const operation = f.settings.importFile(), assertion = assert.rejects(operation, /聊天或選項已改變/), approval = await f.pending();
  original.options.depth = 'quick'; f.app.gate.decide(approval.id, true); await assertion;
  assert.equal(original.options.permission, 'ask'); assert.equal(original.options.depth, 'quick'); assert.equal(f.app.saves.length, 0);
});

test('concurrent operations share one chooser and cancellation clears pending approval', async t => {
  const f = await fixture(t); await f.write({ depth: 'deep' }); let dialogs = 0;
  f.vscode.window.showOpenDialog = async () => { dialogs++; return [f.uri(f.file)]; };
  const first = f.settings.importFile(), second = f.settings.importFile(); await f.pending(); f.settings.cancel();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(dialogs, 1); assert.equal(f.app.gate.pending, null); assert.equal(f.settings.operation, null); assert.equal(f.app.agentSettingsBusy, false);
  const third = f.settings.importFile(), approval = await f.pending(); f.app.gate.decide(approval.id, true);
  assert.equal(await third, true, 'cancelled operation does not poison the next import');
});

test('cancelling an open picker settles promptly and ignores its eventual answer or rejection', { timeout: 2000 }, async t => {
  for (const action of ['importFile', 'exportFile']) for (const lateFailure of [false, true]) {
    const f = await fixture(t); if (action === 'importFile') await f.write({ permission: 'full' });
    let resolveDialog, rejectDialog, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const show = () => { entered(); return new Promise((resolve, reject) => { resolveDialog = resolve; rejectDialog = reject; }); };
    f.vscode.window.showOpenDialog = show; f.vscode.window.showSaveDialog = show;
    const before = structuredClone(f.app.session.options), operation = f.settings[action]();
    await started; f.settings.cancel(); await assert.rejects(operation, /已取消/);
    assert.equal(f.app.agentSettingsBusy, false); assert.equal(f.settings.operation, null);
    if (lateFailure) rejectDialog(new Error('native picker closed after deactivation'));
    else resolveDialog(action === 'importFile' ? [f.uri(f.file)] : f.uri(f.file));
    await tick(); await tick();
    assert.deepEqual(f.app.session.options, before); assert.equal(f.app.saves.length, 0); assert.equal(f.app.gate.pending, null);
    if (action === 'exportFile') await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  }
});

test('save failure restores prior options and unlocks the settings UI', async t => {
  const f = await fixture(t); await f.write({ permission: 'full', depth: 'deep' });
  const before = f.app.session.options; f.app.save = async () => { throw new Error('fixture disk error'); };
  const operation = f.settings.importFile(), assertion = assert.rejects(operation, /fixture disk error/), approval = await f.pending();
  f.app.gate.decide(approval.id, true); await assertion;
  assert.equal(f.app.session.options, before); assert.equal(f.app.session.options.permission, 'ask');
  assert.equal(f.app.session.permissionChoice, undefined);
  assert.equal(f.app.agentSettingsBusy, false); assert.equal(f.app.capabilityUpdates, undefined);
});

test('real memory store preserves history while the approved global mode applies after restart', async t => {
  const f = await fixture(t), store = await new MemoryStore(path.join(f.directory, 'storage'), { permissionMode: () => f.app.approvalPreferences.mode }).initialize();
  f.app.session = store.create(f.uri(f.directory).toString());
  store.add(f.app.session, { role: 'user', text: '這段聊天必須保留' });
  f.app.session.checkpoint = { request: '保留 checkpoint', records: [{ name: 'read_file', result: { ok: true } }] };
  await store.save(f.app.session);
  await store.updateProject(f.app.session.workspace, project => project.entries.push({ id: 'remember', kind: 'preference', text: '保留 Project Memory' }));
  const projectBefore = JSON.stringify(await store.project(f.app.session.workspace));
  f.app.save = () => store.save(f.app.session); await f.write({ depth: 'deep', permission: 'full' });
  const operation = f.settings.importFile(), approval = await f.pending(); f.app.gate.decide(approval.id, true); await operation;
  const stored = JSON.parse(await fs.readFile(store.file(f.app.session.id), 'utf8')).session;
  assert.equal(stored.options.depth, 'deep'); assert.equal(stored.options.permission, 'full');
  assert.equal(stored.messages[0].text, '這段聊天必須保留'); assert.equal(stored.checkpoint.request, '保留 checkpoint');
  assert.equal(JSON.stringify(await store.project(f.app.session.workspace)), projectBefore);
  const reopened = await (await new MemoryStore(store.directory, { permissionMode: () => f.app.approvalPreferences.mode }).initialize()).openSession(stored.id);
  assert.equal(reopened.options.depth, 'deep'); assert.equal(reopened.options.permission, 'full', 'restart retains the explicitly approved mode');
});
