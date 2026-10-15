'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { searchHistory, readHistory } = require('../src/memory/history');
const { PermissionPolicy } = require('../src/permissions');

test('queued future requests remain unavailable to active-task history tools until actually dispatched or steered', () => {
  const messages = [{ id: 'active', role: 'user', text: 'CURRENT-INSTRUCTION' },
    { id: 'future', role: 'user', text: 'FUTURE-INSTRUCTION', queued: true },
    { id: 'pending', role: 'user', text: 'PENDING-STEER-INSTRUCTION', steeringPending: true }];
  assert.equal(searchHistory(messages, { query: 'INSTRUCTION' }).totalMatches, 1);
  assert.throws(() => readHistory(messages, { messageId: 'future' }));
  assert.throws(() => readHistory(messages, { messageId: 'pending' }));
});

function loadTools() {
  const filename = path.join(__dirname, '..', 'src', 'tools.js');
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = name => name === 'vscode' ? { workspace: { isTrusted: true } } : Module.prototype.require.call(mod, name);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return mod.exports.WorkspaceTools;
}

test('search_history finds exact facts beyond old prompt limits and preserves actual source identity', () => {
  const messages = [{ id: 'old-message', role: 'user', text: 'padding '.repeat(1000) + 'Quartz release directory = artifacts/quartz\n' + 'tail '.repeat(1000) }];
  for (let index = 0; index < 80; index++) messages.push({ id: 'new-' + index, role: 'assistant', text: 'unrelated conversation' });
  const result = searchHistory(messages, { query: 'quartz release directory' });
  assert.equal(result.totalMatches, 1); assert.equal(result.matches[0].messageId, 'old-message');
  assert.equal(result.matches[0].index, 0); assert.equal(result.matches[0].role, 'user');
  assert.match(result.matches[0].text, /artifacts\/quartz/);
  assert.ok(result.matches[0].offset > 1600); assert.ok(result.matches[0].text.length <= 1000);
});

test('read_history pages full long content exactly without summarizing or modifying local messages', () => {
  const original = 'intro\n' + 'abcdefghijklmnopqrstuvwxyz\n'.repeat(1500) + 'EXACT-FINAL-TAIL';
  const messages = [{ id: 'long-answer', role: 'assistant', text: original, incomplete: true }];
  let offset = 0, combined = '';
  while (offset !== null) {
    const part = readHistory(messages, { messageId: 'long-answer', offset, limit: 10000 });
    combined += part.text; offset = part.nextOffset;
    assert.equal(part.totalCharacters, original.length); assert.equal(part.incomplete, true);
    assert.ok(part.text.length <= 10000);
  }
  assert.equal(combined, original); assert.equal(messages[0].text, original);
  const end = readHistory(messages, { messageId: 'long-answer', offset: original.length });
  assert.equal(end.text, ''); assert.equal(end.nextOffset, null);
});

test('history tools expose only the provided chat user/assistant messages and bound search results', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({ id: 'm-' + index, role: 'user', text: 'matching history ' + index }));
  messages.push({ id: 'tool-private', role: 'tool', text: 'matching history internal evidence' }, { id: 'notice-private', role: 'notice', text: 'matching history internal notice' });
  const result = searchHistory(messages, { query: 'matching history', limit: 8 });
  assert.equal(result.totalMatches, 12); assert.equal(result.matches.length, 8); assert.equal(result.matches[0].messageId, 'm-11');
  for (const messageId of ['different-chat-id', 'tool-private', 'notice-private']) assert.throws(() => readHistory(messages, { messageId }), /目前聊天找不到/);
});

test('full-source secret redaction remains safe across every read chunk boundary', () => {
  const secret = 'ghp_' + 'A'.repeat(30), cookie = 'private-cookie-value';
  const source = 'prefix '.repeat(30) + `Bearer ${secret}\nCookie: ${cookie}\n` + 'tail '.repeat(30);
  const messages = [{ id: 'redact-me', role: 'assistant', text: source }];
  let offset = 0, combined = '';
  while (offset !== null) {
    const part = readHistory(messages, { messageId: 'redact-me', offset, limit: 7 });
    combined += part.text; offset = part.nextOffset;
  }
  assert.equal(combined.includes(secret), false); assert.equal(combined.includes(cookie), false);
  assert.match(combined, /REDACTED/); assert.equal(messages[0].text, source);
  assert.equal(searchHistory(messages, { query: secret }).totalMatches, 0);
  assert.equal(searchHistory(messages, { query: cookie }).totalMatches, 0);
});

test('history validation rejects oversized queries, invalid offsets, limits and message IDs', () => {
  const messages = [{ id: 'm', role: 'user', text: 'hello' }];
  for (const query of ['', 'a', '  ', 'a'.repeat(301), 123]) assert.throws(() => searchHistory(messages, { query }), /query/);
  for (const limit of [0, 9, 1.5, '2']) assert.throws(() => searchHistory(messages, { query: 'hello', limit }), /limit/);
  for (const offset of [-1, 1.5, '1', Infinity]) assert.throws(() => readHistory(messages, { messageId: 'm', offset }), /offset/);
  for (const limit of [0, 10001, 2.5]) assert.throws(() => readHistory(messages, { messageId: 'm', limit }), /limit/);
  assert.throws(() => readHistory(messages, { messageId: '../other-chat' }), /messageId/);
  assert.throws(() => readHistory(messages, { messageId: 'm', offset: 6 }), /超過/);
});

test('WorkspaceTools history availability follows the callback and respects cancellation and read-only policy', async () => {
  const WorkspaceTools = loadTools(), controller = new AbortController(); let approvals = 0;
  let messages = [{ id: 'active-message', role: 'user', text: 'current history detail' }];
  const tools = new WorkspaceTools({ fsPath: '/unused' }, {}, controller.signal, () => {}, async () => { approvals++; throw new Error('no approval needed'); },
    { history: () => messages, policy: new PermissionPolicy({ mode: 'ask', agent: 'review' }), sandbox: {} });
  assert.equal((await tools.execute('search_history', { query: 'current history' })).matches[0].messageId, 'active-message');
  assert.equal((await tools.execute('read_history', { messageId: 'active-message' })).text, 'current history detail');
  assert.equal(approvals, 0);
  messages = [{ id: 'replacement-message', role: 'assistant', text: 'replacement current history', interrupted: true }];
  assert.equal((await tools.execute('search_history', { query: 'current history' })).matches[0].messageId, 'replacement-message');
  assert.equal((await tools.execute('read_history', { messageId: 'active-message' })).ok, false);
  const unavailable = new WorkspaceTools({ fsPath: '/unused' }, {}, controller.signal, () => {}, async detail => detail.accept, { sandbox: {} });
  assert.equal(unavailable.catalog().some(tool => ['search_history', 'read_history'].includes(tool.name)), false);
  assert.equal((await unavailable.execute('search_history', { query: 'current history' })).ok, false);
  controller.abort(); await assert.rejects(tools.execute('search_history', { query: 'current history' }), /已停止/);
});

test('literal search preserves original offsets with Unicode case folding and regex punctuation', () => {
  const messages = [{ id: 'unicode', role: 'user', text: 'İ'.repeat(400) + '\nMATCH.*[literal]\n' + 'rest '.repeat(500) },
    { id: 'not-literal', role: 'user', text: 'MATCH-anything-literal' }];
  const result = searchHistory(messages, { query: 'match.*[literal]' });
  assert.equal(result.totalMatches, 1); assert.equal(result.matches[0].messageId, 'unicode');
  assert.match(result.matches[0].text, /MATCH\.\*\[literal\]/);
  assert.equal(result.matches[0].offset, 201);
});
