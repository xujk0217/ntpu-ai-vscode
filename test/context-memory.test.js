'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ContextManager, summarize } = require('../src/memory/context');
const { MemoryStore } = require('../src/memory/store');

const manager = new ContextManager();

test('same-chat context includes complete recent messages beyond eight turns and 1600 characters', () => {
  const messages = Array.from({ length: 14 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `turn ${index}: preserve-this-${index}` }));
  messages.push({ role: 'assistant', text: 'Long detailed response. '.repeat(100) + ' FINAL-CONSTRAINT-PRESERVED' });
  const result = manager.compose({ request: 'continue', session: { messages }, budget: 12000 });
  for (let index = 0; index < 14; index++) assert.match(result.text, new RegExp(`preserve-this-${index}`));
  assert.match(result.text, /FINAL-CONSTRAINT-PRESERVED/);
  assert.equal(result.diagnostics.completeRecentMessages, messages.length);
  assert.equal(result.diagnostics.omittedMessages, 0);
  assert.equal(result.diagnostics.compacted, false);
  assert.equal(result.sections.map(section => section.text).join(''), result.text);
});

test('huge project memory and tasks cannot evict the preceding user constraint or latest response tail', () => {
  const session = { messages: [
    { role: 'user', text: 'Never remove the local history. EXACT-USER-CONSTRAINT' },
    { role: 'assistant', text: 'large body '.repeat(5000) + ' EXACT-LATEST-TAIL' },
  ] };
  const before = JSON.stringify(session);
  const result = manager.compose({ request: 'continue the work', session, budget: 6000,
    project: { entries: [{ id: 'huge', kind: 'summary', text: 'project details '.repeat(10000) }] },
    tasks: [{ id: 'large-task', request: 'continue the work', status: 'blocked', result: 'task details '.repeat(10000) }] });
  assert.match(result.text, /EXACT-USER-CONSTRAINT/);
  assert.match(result.text, /EXACT-LATEST-TAIL/);
  assert.match(result.text, /\[excerpt;/);
  assert.equal(result.sections[0].id, 'recent_conversation');
  assert.equal(result.diagnostics.compacted, true);
  assert.ok(result.text.length <= 6000);
  assert.equal(JSON.stringify(session), before, 'outbound compaction never mutates the saved full history');
});

test('relevance recall finds middle and tail facts from old same-chat messages after many turns and restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-context-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new MemoryStore(root).initialize();
  const session = store.create('project');
  store.add(session, { role: 'user', text: 'old intro '.repeat(300) + '\nquartz release directory = artifacts/quartz-verified\n' + 'middle padding '.repeat(300) + '\nquartz release owner = release-owner-alice' });
  for (let index = 0; index < 90; index++) store.add(session, { role: index % 2 ? 'assistant' : 'user', text: `Unrelated dialogue ${index}. ` + 'other discussion '.repeat(20) });
  await store.save(session);
  const restarted = await new MemoryStore(root).initialize();
  const restored = await restarted.openSession(session.id);
  const result = manager.compose({ request: 'What are the quartz release directory and owner?', session: restored, budget: 6500 });
  assert.match(result.text, /artifacts\/quartz-verified/);
  assert.match(result.text, /release-owner-alice/);
  assert.ok(result.diagnostics.recalledMessages > 0);
  assert.ok(result.diagnostics.omittedMessages > 0);
  assert.equal(restored.messages[0].text, session.messages[0].text);
  assert.equal(restored.messages.length, 91);
});

test('task ledger spans all tasks, keeps unresolved status and retrieves full current-session evidence', () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({ id: `task-${index}`, request: `request-${index}`, status: index === 0 ? 'blocked' : 'completed', result: `result-${index}` }));
  tasks[0].request = 'quartz deployment'; tasks[0].result = 'still blocked; approval required';
  tasks[0].pending = [{ title: 'receive user approval' }];
  const session = { tasks, messages: [] };
  summarize(session);
  assert.match(session.summary, /task-0: request=quartz deployment；status=blocked/);
  assert.match(session.summary, /receive user approval/);
  assert.match(session.summary, /task-24: request=request-24/);
  const result = manager.compose({ request: 'quartz deployment approval', session, budget: 10000,
    tasks: [{ id: 'task-0', request: 'quartz deployment', status: 'completed', result: 'stale project index' }] });
  const previous = result.sections.find(section => section.id === 'previous_tasks').text;
  assert.match(previous, /still blocked; approval required/);
  assert.doesNotMatch(previous, /stale project index/);
  assert.match(previous, /"status":"blocked"/);
});

test('context redacts complete sources before selecting head, matching middle and tail excerpts', () => {
  const secrets = ['ghp_' + 'A'.repeat(30), 'sample-cookie-value', 'middle-secret-value', 'tail-password-value'];
  const body = `Bearer ${secrets[0]}\nCookie: ${secrets[1]}\n` + 'prefix '.repeat(900) +
    `\nquartz password=${secrets[2]}\n` + 'suffix '.repeat(900) + `\npassword=${secrets[3]}\nFINAL-SAFE-TAIL`;
  const result = manager.compose({ request: 'quartz', budget: 3500, session: { messages: [{ role: 'user', text: body }] },
    project: { entries: [{ id: 'p', kind: 'summary', text: 'api_key=' + secrets[2] }] } });
  for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.match(result.text, /REDACTED/);
  assert.match(result.text, /FINAL-SAFE-TAIL/);
});

test('all context diagnostics and structured sections respect tight and ordinary budgets', () => {
  const session = { messages: [{ role: 'user', text: 'important '.repeat(1000) }], summary: 'history '.repeat(1000) };
  for (const budget of [0, 1, 50, 200, 1000, 8000]) {
    const result = manager.compose({ request: 'important history', session, budget, workspaceContext: 'workspace '.repeat(200) });
    assert.ok(result.text.length <= budget, `budget ${budget}`);
    assert.equal(result.diagnostics.usedCharacters, result.text.length);
    assert.equal(result.sections.map(section => section.text).join(''), result.text);
    assert.equal(result.diagnostics.compacted, true);
    assert.ok(result.diagnostics.omittedMessages >= 0);
  }
});

test('incomplete assistant output is labelled and current request is not duplicated as old dialogue', () => {
  const request = 'current authoritative question';
  const result = manager.compose({ request, session: { messages: [
    { role: 'user', text: 'older question' }, { role: 'assistant', text: 'not yet finished', incomplete: true },
    { role: 'user', text: request },
  ] } });
  assert.doesNotMatch(result.text, /current authoritative question/);
  assert.match(result.text, /incomplete\/interrupted/);
  assert.match(result.text, /not yet finished/);
});

test('future queued follow-ups are excluded from current history, ledger and task retrieval until actually dispatched', () => {
  const future = 'FUTURE-QUEUED-INSTRUCTION-MUST-NOT-APPLY';
  const result = manager.compose({ request: '繼續目前任務', session: {
    messages: [{ role: 'user', text: '目前任務' }, { role: 'user', text: future, queued: true }],
    summary: future,
    tasks: [{ id: 'now', request: '目前任務', status: 'running' }, { id: 'later', request: future, status: 'queued' }],
  }, tasks: [{ id: 'later', request: future, status: 'queued' }] });
  assert.doesNotMatch(result.text, new RegExp(future));
  assert.match(result.text, /目前任務/);
});
