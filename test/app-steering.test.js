'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
let mock;
const original = Module._load;
try {
  mock = { Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
    workspace: { isTrusted: true, workspaceFolders: [], registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => ({ 'parallel.enabled': false, 'parallel.requestsPerMinute': 10000, 'memory.autoUpdate': false }[key] ?? fallback) }) } };
  Module._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); };
  var { AgentApp } = require('../src/app');
} finally { Module._load = original; }
async function environment(t, chat) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-steer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  mock.workspace.workspaceFolders = [{ name: 'fixture', uri: uri(directory) }];
  const state = new Map(), global = new Map();
  const context = { subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(directory, 'storage')),
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) },
    globalState: { get: (key, fallback) => global.get(key) ?? fallback, update: async (key, value) => global.set(key, value) }, secrets: { get: async () => undefined } };
  const app = new AgentApp(context); await app.ready; app.session.options.agent = 'ask'; app.session.titleSource = 'manual';
  const prompts = [], posts = [];
  const bridge = { page: { isClosed: () => false }, open: async () => {}, status: async () => ({ ready: true }), close: async () => {},
    chat: async prompt => { prompts.push(prompt); return chat(prompt, app); } };
  app.getBridge = () => bridge; app.post = value => posts.push(value);
  t.after(() => app.dispose());
  return { app, prompts, posts, context, bridge, directory };
}
const final = message => ({ text: JSON.stringify({ kind: 'final', message }) });

test('ordinary queued requests run FIFO only after the active task, and future queued messages never enter earlier prompts', async t => {
  const started = deferred(), finish = deferred(); let sends = 0;
  const { app, prompts } = await environment(t, async () => { if (++sends === 1) { started.resolve(); await finish.promise; } return final('done ' + sends); });
  const operation = app.ask('ACTIVE_MARKER', false); await started.promise;
  await app.ask('QUEUE_A_MARKER', false); await app.ask('QUEUE_B_MARKER', false);
  assert.equal(prompts.length, 1); assert.equal(app.queue.length, 2); assert.equal(app.controller.signal.aborted, false);
  finish.resolve(); await operation;
  assert.equal(prompts.length, 3); assert.match(prompts[1], /QUEUE_A_MARKER/); assert.doesNotMatch(prompts[1], /QUEUE_B_MARKER/);
  assert.match(prompts[2], /QUEUE_B_MARKER/); assert.equal(app.queue.length, 0);
  assert.deepEqual(app.session.tasks.map(task => task.status), ['completed', 'completed', 'completed']);
  assert.deepEqual(app.session.messages.filter(message => message.role === 'commentary' && message.text.startsWith('開始下一則排隊留言：')).map(message => message.text),
    ['開始下一則排隊留言：QUEUE_A_MARKER', '開始下一則排隊留言：QUEUE_B_MARKER']);
});

test('Steer saves real guidance and file context then continues current task without a separate duplicate run', async t => {
  const started = deferred(), finish = deferred(); let sends = 0;
  const { app, prompts } = await environment(t, async () => { if (++sends === 1) { started.resolve(); await finish.promise; return final('stale'); } return final('accepted steering'); });
  app.editorContext = async (root, includeEditor, files) => files.length ? 'file selection content is untrusted' : '';
  const operation = app.ask('ACTIVE_TASK', false); await started.promise;
  app.contextFiles = [{ relative: 'auth.js' }]; await app.ask('STEER_KEEP_INTERFACE', true);
  const id = app.queue[0].id; await app.handle({ kind: 'steerQueue', id }); await app.handle({ kind: 'steerQueue', id });
  assert.equal(app.queue[0].steeringPending, true); assert.equal(app.session.messages.find(message => message.id === app.queue[0].messageId).steered, undefined);
  assert.equal(app.controller.signal.aborted, false); finish.resolve(); await operation;
  assert.equal(prompts.length, 2); assert.match(prompts[1], /USER STEERING \(authoritative/); assert.match(prompts[1], /STEER_KEEP_INTERFACE/); assert.match(prompts[1], /file selection content is untrusted/);
  const task = app.session.tasks[0], merged = app.session.tasks[1]; assert.equal(task.records.filter(record => record.type === 'user_steering').length, 1);
  assert.equal(merged.status, 'steered'); assert.equal(merged.resolvedBy, task.id); assert.equal(app.queue.length, 0);
  const stored = JSON.parse(await fs.readFile(app.store.file(app.session.id), 'utf8')).session;
  assert.equal(stored.messages.find(message => message.steered).queued, false); assert.equal(stored.tasks[0].records.find(record => record.type === 'user_steering').id, id);
});

test('Stop and reload preserve pending queue truthfully, including unavailable attachment metadata', async t => {
  const started = deferred(), finish = deferred();
  const { app, context, bridge } = await environment(t, async () => { started.resolve(); await finish.promise; return final('interrupted'); });
  const operation = app.ask('ACTIVE', false); await started.promise;
  app.attachment = { name: 'example.png', buffer: Buffer.from('private attachment bytes') }; await app.ask('QUEUED_ATTACHMENT', false);
  const item = app.queue[0]; assert.equal(app.canSteer(item), false); await assert.rejects(app.handle({ kind: 'steerQueue', id: item.id }), /附件/);
  app.stop(); finish.resolve(); await operation; await app.save();
  assert.equal(app.queue.length, 1); assert.equal(app.session.messages.find(message => message.id === item.messageId).canceled, undefined);
  const saved = await fs.readFile(app.store.file(app.session.id), 'utf8'); assert(!saved.includes('private attachment bytes'));
  const reopened = new AgentApp(context); await reopened.ready; reopened.getBridge = () => bridge; t.after(() => reopened.dispose());
  assert.equal(reopened.queue.length, 1); assert.equal(reopened.queuePaused, true); assert.equal(reopened.queue[0].attachmentUnavailable, true);
  assert.equal(reopened.session.tasks.find(task => task.id === item.id).status, 'queued');
  assert.equal(reopened.session.messages.find(message => message.id === item.messageId).queued, true);
  await reopened.handle({ kind: 'runQueue' }); assert.equal(reopened.queue.length, 1); assert.equal(reopened.queuePaused, true);
});

test('reload after the first steering checkpoint repairs merged task status and never duplicates the saved guidance', async t => {
  const { app } = await environment(t, async () => final('unused'));
  app.controller = new AbortController(); const owner = { id: 'owner-task', status: 'running', records: [{ type: 'user_steering', id: 'queued-task', request: 'saved guidance' }] };
  app.activeTask = owner; app.session.tasks = [owner, { id: 'queued-task', status: 'queued', records: [] }];
  app.session.messages.push({ id: 'queued-message', role: 'user', text: 'saved guidance', queued: true, steeringPending: true });
  app.session.queue = [{ id: 'queued-task', request: 'saved guidance', sessionId: app.session.id, messageId: 'queued-message', steeringPending: true }];
  app.restoreQueue(); app.controller = null; app.activeTask = null;
  assert.equal(app.queue.length, 0); assert.equal(app.session.tasks[1].status, 'steered'); assert.equal(app.session.tasks[1].resolvedBy, owner.id);
  assert.equal(app.session.messages.at(-1).steered, true); assert.equal(app.session.messages.at(-1).steeredInto, owner.id);
});

test('cancel while selected context is being reviewed keeps canceled input out of active steering', async t => {
  const { app } = await environment(t, async () => final('unused'));
  const started = deferred(), finish = deferred(); app.controller = new AbortController();
  const owner = { id: 'owner', request: 'active', status: 'running', records: [] }; app.activeTask = owner; app.session.tasks = [owner];
  app.editorContext = async () => { started.resolve(); await finish.promise; return 'selected private text'; };
  await app.ask('cancel before accepted', true); const queued = app.queue[0]; await app.steerQueue(queued.id);
  const pending = app.pendingSteering(owner, app.workspace()); await started.promise; await app.cancelQueued(queued.id); finish.resolve();
  assert.deepEqual(await pending, []); assert.equal(app.queue.length, 0); assert.equal(app.session.messages.find(message => message.id === queued.messageId).canceled, true);
  app.controller = null; app.activeTask = null;
});

test('denied selected context remains queued and cannot be represented as accepted guidance', async t => {
  const { app } = await environment(t, async () => final('unused'));
  app.controller = new AbortController(); const owner = { id: 'owner', request: 'active', status: 'running', records: [] }; app.activeTask = owner; app.session.tasks = [owner];
  await app.ask('must include selected file', true); const queued = app.queue[0]; await app.steerQueue(queued.id);
  app.editorContext = async () => { throw new Error('選取檔案未獲核准'); };
  assert.deepEqual(await app.pendingSteering(owner, app.workspace()), []); assert.equal(app.queue.length, 1);
  assert.equal(app.queue[0].steeringPending, false); assert.equal(app.session.messages.find(message => message.id === queued.messageId).queued, true);
  app.controller = null; app.activeTask = null;
});

test('restored session IDs may change while owned queued messages and tasks still restore in FIFO order', async t => {
  const { app } = await environment(t, async () => final('unused'));
  app.session.tasks = [{ id: 'saved-id', request: 'saved request', status: 'queued' }];
  app.session.messages.push({ id: 'saved-message', role: 'user', text: 'saved request', queued: true });
  app.session.queue = [{ id: 'saved-id', request: 'saved request', messageId: 'saved-message', sessionId: 'old-restored-session' }];
  app.restoreQueue(); assert.equal(app.queue.length, 1); assert.equal(app.queue[0].sessionId, app.session.id); assert.equal(app.queuePaused, true);
});

test('queued preflight failure preserves the full FIFO and queued message state', async t => {
  const { app } = await environment(t, async () => final('unused'));
  app.controller = new AbortController(); await app.ask('must retain first', false); await app.ask('must retain second', false); app.controller = null;
  const original = app.workspace; app.workspace = () => null; await app.runQueued(); app.workspace = original;
  assert.equal(app.queue.length, 2); assert.equal(app.queuePaused, true);
  assert(app.queue.every(item => app.session.messages.find(message => message.id === item.messageId).queued));
});

test('canceling queued input rolls back message and FIFO state when durable save fails, then survives restart consistently', async t => {
  const { app, context } = await environment(t, async () => final('unused'));
  app.controller = new AbortController();
  await app.ask('first retained input', false); await app.ask('second retained input', false);
  app.controller = null;
  const ids = app.queue.map(item => item.id), first = app.queue[0];
  const save = app.save.bind(app);
  app.save = async () => { throw new Error('disk full'); };
  try { await assert.rejects(app.cancelQueued(first.id), /原留言仍保留.*disk full/); }
  finally { app.save = save; }
  assert.deepEqual(app.queue.map(item => item.id), ids);
  assert.equal(app.session.tasks.find(task => task.id === first.id).status, 'queued');
  const message = app.session.messages.find(message => message.id === first.messageId);
  assert.equal(message.queued, true); assert.notEqual(message.canceled, true);
  await app.save();
  const reopened = new AgentApp(context); await reopened.ready; t.after(() => reopened.dispose());
  assert.deepEqual(reopened.queue.map(item => item.id), ids);
  assert.equal(reopened.queuePaused, true);
  await reopened.cancelQueued(first.id);
  assert.equal(reopened.queue.length, 1);
  assert.equal(reopened.session.messages.find(message => message.id === first.messageId).canceled, true);
});

test('queue draining waits for a cancellation transaction and cannot skip an input whose cancellation fails', async t => {
  const { app } = await environment(t, async () => final('unused'));
  app.controller = new AbortController(); await app.ask('first', false); await app.ask('second', false); app.controller = null;
  const ids = app.queue.map(item => item.id), started = deferred(), finish = deferred(), executed = [];
  const save = app.save.bind(app), run = app.run.bind(app);
  app.save = async () => { started.resolve(); await finish.promise; throw new Error('disk failure'); };
  app.run = async item => executed.push(item.id);
  const cancellation = app.cancelQueued(ids[0]); await started.promise;
  const rejected = assert.rejects(cancellation, /原留言仍保留/);
  const drain = app.runQueued();
  assert.deepEqual(executed, []);
  finish.resolve(); await rejected;
  app.save = save; await drain; app.run = run;
  assert.deepEqual(executed, [ids[0]]);
  assert.deepEqual(app.queue.map(item => item.id), [ids[1]]);
});
