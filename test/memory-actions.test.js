'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MemoryStore } = require('../src/memory/store');
const { MemoryActions } = require('../src/memory/actions');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-history-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new MemoryStore(path.join(directory, 'memory')).initialize();
  const a = store.create('project-a'), b = store.create('project-a'), c = store.create('project-b');
  for (const session of [a, b, c]) { store.add(session, { role: 'user', text: session.id }); await store.save(session); }
  let busy = false, confirmation = '確認'; const confirmations = [];
  const app = { store, session: a, gate: {}, contextFiles: ['old'], attachment: {}, busy: () => busy,
    save: () => store.save(app.session), render() {}, post() {}, refreshSkills: async () => {} };
  const vscode = { window: { showInputBox: async () => '改名 PASSWORD=only-test-private', showWarningMessage: async (...args) => { confirmations.push(args); return confirmation; } } };
  return { directory, store, a, b, c, app, vscode, actions: new MemoryActions(app, vscode), confirmations,
    setBusy: value => { busy = value; }, confirm: value => { confirmation = value; } };
}

test('history list renames a selected inactive chat without switching the active chat', async t => {
  const f = await fixture(t);
  await f.actions.handle({ kind: 'renameSession', id: f.b.id });
  assert.equal(f.app.session.id, f.a.id); assert.match(f.b.title, /改名/); assert.equal(f.b.title.includes('only-test-private'), false);
  const disk = new MemoryStore(path.join(f.directory, 'memory')); await disk.initialize();
  assert.equal((await disk.openSession(f.b.id)).title, f.b.title);
  await assert.rejects(f.actions.handle({ kind: 'sessionsAction', action: 'export', ids: [f.b.id] }), /不支援/);
  assert.equal(typeof f.app.exportSession, 'undefined');
});
test('selected chats can be archived and restored with explicit idempotent bulk actions', async t => {
  const f = await fixture(t);
  await f.actions.handle({ kind: 'sessionsAction', action: 'archive', ids: [f.a.id, f.b.id, f.a.id] });
  await f.actions.handle({ kind: 'sessionsAction', action: 'archive', ids: [f.a.id, f.b.id] });
  assert.equal(f.a.archived, true); assert.equal(f.b.archived, true); assert.equal(f.c.archived, undefined);
  await f.actions.handle({ kind: 'sessionsAction', action: 'unarchive', ids: [f.a.id, f.b.id] });
  assert.equal(f.a.archived, false); assert.equal(f.b.archived, false);
});
test('bulk delete confirms once, respects cancel, preserves source files and project memory, and replaces a deleted active chat', async t => {
  const f = await fixture(t); const source = path.join(f.directory, 'source.js'); await fs.writeFile(source, 'keep');
  await f.store.updateProject('project-a', project => project.entries.push({ id: 'fact', text: 'keep' }));
  f.confirm(undefined); await f.actions.handle({ kind: 'sessionsAction', action: 'delete', ids: [f.a.id, f.b.id] });
  assert.equal(f.store.sessions.length, 3);
  f.confirm('確認'); await f.actions.handle({ kind: 'sessionsAction', action: 'delete', ids: [f.a.id, f.b.id, f.b.id] });
  assert.equal(f.confirmations.length, 2); assert.match(f.confirmations[1][0], /2 個/);
  assert.equal(f.store.sessions.some(item => item.id === f.a.id || item.id === f.b.id), false);
  assert.equal(f.app.session.workspace, 'project-a'); assert.notEqual(f.app.session.id, f.a.id);
  assert.deepEqual(f.app.contextFiles, []); assert.equal(f.app.attachment, null);
  assert.equal(await fs.readFile(source, 'utf8'), 'keep'); assert.equal((await f.store.project('project-a')).entries[0].text, 'keep');
  assert.equal((await f.store.openSession(f.c.id)).messages.length, 1);
});
test('history management rejects invalid selection and running tasks, and serializes dialogs', async t => {
  const f = await fixture(t);
  await assert.rejects(f.actions.handle({ kind: 'sessionsAction', action: 'delete', ids: [f.a.id, '../escape'] }), /找不到/);
  await assert.rejects(f.actions.handle({ kind: 'sessionsAction', action: 'delete', ids: f.a.id }), /格式/);
  f.setBusy(true); await assert.rejects(f.actions.handle({ kind: 'deleteSession', id: f.a.id }), /停止/); f.setBusy(false);
  let resolve, entered; const started = new Promise(done => { entered = done; });
  f.vscode.window.showInputBox = () => new Promise(done => { resolve = done; entered(); });
  const first = f.actions.handle({ kind: 'renameSession', id: f.a.id }); await started;
  await assert.rejects(f.actions.handle({ kind: 'deleteSession', id: f.b.id }), /目前的聊天管理/);
  resolve('新名稱'); await first; assert.equal(f.store.sessions.length, 3);
});
test('partial bulk deletion failures leave a valid active chat and keep remaining history', async t => {
  const f = await fixture(t); const remove = f.store.remove.bind(f.store);
  f.store.remove = async id => { if (id === f.b.id) throw new Error('fixture file lock'); return remove(id); };
  await assert.rejects(f.actions.handle({ kind: 'sessionsAction', action: 'delete', ids: [f.a.id, f.b.id] }), /fixture file lock/);
  assert.equal(f.app.session.id, f.b.id); await f.app.save();
  assert.equal((await f.store.openSession(f.b.id)).messages.length, 1);
});
