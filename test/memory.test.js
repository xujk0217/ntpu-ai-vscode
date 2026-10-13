'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MemoryStore } = require('../src/memory/store');
const { ContextManager, MemoryRetriever, updateMemory } = require('../src/memory/context');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-memory-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: await new MemoryStore(path.join(root, 'storage')).initialize() };
}
test('complete history survives restart beyond previous message/session limits with pagination', async t => {
  const { root, store } = await fixture(t); const active = store.create('file:///one');
  for (let i = 0; i < 155; i++) store.add(active, { role: 'user', text: 'message ' + i });
  await store.save(active);
  for (let i = 0; i < 27; i++) await store.save(store.create('file:///one'));
  const restored = await new MemoryStore(store.directory).initialize();
  assert.equal(restored.sessions.length, 28);
  const session = await restored.openSession(active.id); assert.equal(session.messages.length, 155);
  const page = restored.page(session); assert.equal(page.messages.length, 50); assert.equal(page.before, 105);
  assert.equal(restored.page(session, page.before).messages[0].text, 'message 55');
  await fs.writeFile(path.join(root, 'project-source.js'), 'keep'); await restored.remove(active.id);
  assert.equal(await fs.readFile(path.join(root, 'project-source.js'), 'utf8'), 'keep');
});
test('migration is idempotent, preserves IDs and creates sanitized backup before import', async t => {
  const { store } = await fixture(t);
  const legacy = [{ id: 'legacy-one', title: 'old', messages: [{ id: 'm1', role: 'user', text: 'Bearer only-test' }], workspace: 'file:///one' }];
  await store.initialize(legacy, 'project'); await store.initialize(legacy, 'project');
  assert.equal(store.sessions.length, 1); const session = await store.openSession('legacy-one'); assert.equal(session.messages[0].id, 'm1');
  const names = await fs.readdir(path.join(store.directory, 'backups')); assert.equal(names.length, 1);
  assert.equal((await fs.readFile(path.join(store.directory, 'backups', names[0]), 'utf8')).includes('only-test'), false);
});
test('atomic queued writes, orphan recovery and conflict preservation prevent silent history loss', async t => {
  const { store } = await fixture(t); const session = store.create('file:///one');
  await store.save(session); const other = await new MemoryStore(store.directory).initialize(); const stale = await other.openSession(session.id);
  const saves = [];
  for (let i = 0; i < 5; i++) { store.add(session, { text: 'v' + i }); saves.push(store.save(session)); }
  await Promise.all(saves); assert.equal(JSON.parse(await fs.readFile(store.file(session.id), 'utf8')).session.messages.length, 5);
  await assert.rejects(other.save(stale), /另一個視窗/); assert.equal((await fs.readdir(path.join(store.directory, 'conflicts'))).length, 1);
  const indexFile = path.join(store.directory, 'index.json'); const index = JSON.parse(await fs.readFile(indexFile, 'utf8')); index.sessions = []; await fs.writeFile(indexFile, JSON.stringify(index));
  assert.equal((await new MemoryStore(store.directory).initialize()).sessions.length, 1);
  await store.remove(session.id); await assert.rejects(other.save(stale), /刪除/);
});
test('project memories are isolated, evidence updates are idempotent and plans never become accomplishments', async t => {
  const { store } = await fixture(t); const session = store.create('file:///one');
  const task = { id: 'task1', status: 'blocked', request: '登入', endedAt: 1, records: [
    { name: 'update_plan', result: { ok: true, steps: [{ title: 'done?', status: 'pending' }] } },
    { name: 'write_file', result: { ok: true, saved: true, path: 'login.js' } } ] };
  session.tasks.push(task); await updateMemory(store, session, task); await updateMemory(store, session, task);
  assert.equal((await store.project('file:///one')).entries.length, 2);
  assert.equal((await store.project('file:///one')).entries.find(entry => entry.kind === 'completed').stale, false);
  assert.equal((await store.project('file:///two')).entries.length, 0);
  await store.updateProject('file:///one', project => { project.entries.push({ text: 'API_KEY=only-test-value' }); });
  assert.equal(JSON.stringify(await store.project('file:///one')).includes('only-test-value'), false);
});
test('cross-account restart recovers local checkpoint and relevant Chinese history without remote history', async t => {
  const { store } = await fixture(t); const session = store.create('file:///one');
  session.tasks = [{ id: 'task-a', request: '修正登入系統', status: 'stopped', records: [{ name: 'read_file', result: { path: 'login.ts' } }], files: ['login.ts'] }];
  session.checkpoint = { request: '修正登入系統', records: session.tasks[0].records }; await store.save(session);
  const restored = await new MemoryStore(store.directory).initialize(); const local = await restored.openSession(session.id);
  const prompt = new ContextManager().compose({ request: '繼續修改之前的登入', session: local, project: await restored.project(local.workspace), tasks: restored.projectTasks(local.workspace), budget: 3000 });
  const accountB = { chat: async context => ({ text: context.includes('login.ts') ? '可恢復' : '失敗' }) };
  assert.equal((await accountB.chat(prompt.text)).text, '可恢復'); assert.equal(local.checkpoint.records.length, 1); assert.ok(prompt.text.length <= 3000);
  assert.equal(new MemoryRetriever().retrieve('登入', [{ request: '圖片' }, { request: '登入系統' }])[0].request, '登入系統');
});
test('backups restore with new session IDs without overwriting existing local history', async t => {
  const { store } = await fixture(t); const session = store.create('file:///one'); store.add(session, { text: 'keep' }); await store.save(session);
  const backup = await store.backup(); await store.restore(backup);
  assert.equal(store.sessions.length, 2); assert.equal((await store.openSession(session.id)).messages[0].text, 'keep');
});

test('architecture observations derive from actual complete file reads and become stale after edits', async t => {
  const { store } = await fixture(t); const session = store.create('file:///one');
  const task = { id: 'architecture-task', status: 'completed', request: '查看架構', endedAt: 10, records: [
    { name: 'read_file', at: 9, result: { ok: true, path: 'package.json', start_line: 1, end_line: 1, total_lines: 1,
      text: '1: {"name":"fixture","dependencies":{"next":"14.0.0","typescript":"5.0.0"}}' } } ] };
  await updateMemory(store, session, task);
  const project = await store.project(session.workspace); assert.match(project.entries.find(entry => entry.kind === 'architecture').text, /next@14.0.0/);
  await updateMemory(store, session, { id: 'new-edit', status: 'completed', request: '修改依賴', endedAt: 20,
    records: [{ name: 'write_file', at: 19, result: { ok: true, saved: true, path: 'package.json' } }] });
  assert.equal((await store.project(session.workspace)).entries.find(entry => entry.kind === 'architecture').stale, true);
});
