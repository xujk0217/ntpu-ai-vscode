'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const reply = value => ({ text: JSON.stringify(value) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(chat, execute = async () => ({ ok: true })) {
  const pending = [], prompts = [], checkpoints = [], committed = [], finals = [], controller = new AbortController();
  const options = { request: '提供目前進度與證據', context: '', workspace: 'fixture', signal: controller.signal, profile: { agent: 'ask' },
    tools: { catalog: () => [{ name: 'read_file', description: 'read fixture' }], execute }, bridge: { chat: async prompt => { prompts.push(prompt); return chat(prompt); } },
    getSteering: async () => pending.slice(), onSteeringCommitted: async ids => { committed.push(...ids); for (const id of ids) pending.splice(pending.findIndex(item => item.id === id), 1); },
    onCheckpoint: async records => checkpoints.push(structuredClone(records)), onFinal: text => finals.push(text) };
  return { options, pending, prompts, checkpoints, committed, finals, controller, run: extra => runAgent({ ...options, ...extra }) };
}

test('steering during an in-flight response is durably saved before continuation and prevents accepting stale final', async () => {
  const started = deferred(), finish = deferred(); let calls = 0;
  const env = fixture(async prompt => { if (++calls === 1) { started.resolve(); await finish.promise; return reply({ kind: 'final', message: 'original stale conclusion' }); }
    assert.match(prompt, /USER STEERING \(authoritative/); assert.match(prompt, /保留目前公開介面/);
    assert.equal(env.checkpoints.at(-1).find(record => record.type === 'user_steering').id, 'guidance-1');
    assert.deepEqual(env.committed, ['guidance-1']); return reply({ kind: 'final', message: '已依新指示保留介面。' }); });
  const operation = env.run(); await started.promise;
  env.pending.push({ id: 'guidance-1', request: '保留目前公開介面', context: 'untrusted file excerpt' });
  assert.equal(env.controller.signal.aborted, false); assert.equal(env.prompts.length, 1); finish.resolve();
  assert.equal((await operation).completed, true); assert.equal(calls, 2); assert.deepEqual(env.finals, ['已依新指示保留介面。']);
  assert.equal(env.pending.length, 0); assert.equal(env.checkpoints.at(-1).filter(record => record.type === 'user_steering').length, 1);
});

test('steering waits until a running tool settles instead of aborting it or duplicating queued work', async () => {
  const started = deferred(), finish = deferred(); let calls = 0, executed = 0;
  const env = fixture(async prompt => ++calls === 1 ? reply({ kind: 'tool', name: 'read_file', args: { path: 'a.js' } }) :
    (assert.match(prompt, /先檢查相容性/), reply({ kind: 'final', message: '已整合工具與引導。' })), async () => { executed++; started.resolve(); await finish.promise; return { ok: true, content: 'actual tool evidence' }; });
  const operation = env.run(); await started.promise; env.pending.push({ id: 'during-tool', request: '先檢查相容性' });
  assert.equal(env.committed.length, 0); assert.equal(env.controller.signal.aborted, false); finish.resolve();
  assert.equal((await operation).completed, true); assert.equal(executed, 1); assert.equal(calls, 2); assert.deepEqual(env.committed, ['during-tool']);
});

test('failed steering checkpoint never acknowledges guidance or starts a further model request', async () => {
  const env = fixture(async () => reply({ kind: 'final', message: 'should not send' })); env.pending.push({ id: 'unsaved', request: '完整保存原文' });
  await assert.rejects(env.run({ onCheckpoint: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(env.prompts.length, 0); assert.deepEqual(env.committed, []); assert.equal(env.pending.length, 1);
});

test('cancellation and service limits preserve unconsumed guidance without accepting stale final', async () => {
  for (const failure of ['cancel', '429']) {
    const started = deferred(), finish = deferred();
    const env = fixture(async () => { started.resolve(); await finish.promise; if (failure === '429') throw Object.assign(new Error('HTTP 429'), { status: 429 }); return reply({ kind: 'final', message: 'stale' }); });
    const operation = env.run(); await started.promise; env.pending.push({ id: failure, request: '保留尚未接收的引導' });
    if (failure === 'cancel') env.controller.abort(); finish.resolve();
    await assert.rejects(operation, failure === 'cancel' ? /已停止/ : /429/);
    assert.equal(env.pending.length, 1); assert.equal(env.committed.length, 0); assert.equal(env.finals.length, 0);
  }
});

test('last-round final cannot consume or claim to apply steering without a next model round', async () => {
  const { ModelBudget } = require('../src/parallel');
  const started = deferred(), finish = deferred();
  const env = fixture(async () => { started.resolve(); await finish.promise; return reply({ kind: 'final', message: '已完成原任務。' }); });
  const operation = env.run({ modelBudget: new ModelBudget(1), maxSteps: 1 }); await started.promise;
  env.pending.push({ id: 'no-round', request: '這份指示留到下一項執行' }); finish.resolve();
  assert.equal((await operation).completed, true); assert.equal(env.pending.length, 1); assert.equal(env.committed.length, 0);
  assert.equal(env.prompts.length, 1); assert(!env.checkpoints.flat().some(record => record.type === 'user_steering'));
});

test('guidance waits for an unfinished document to finish, then its next task may use tools normally', async () => {
  let calls = 0, executed = 0;
  const env = fixture(async prompt => {
    calls++;
    if (calls === 1) { env.pending.push({ id: 'after-document', request: '文件完成後查驗 auth.js' }); return reply({ kind: 'output', id: 'doc', index: 1, message: '完整第一段。', done: false }); }
    if (calls === 2) { assert.equal(env.committed.length, 0); return reply({ kind: 'tool', name: 'read_file', args: { path: 'too-early.js' } }); }
    if (calls === 3) { assert.equal(env.committed.length, 0); return reply({ kind: 'output', id: 'doc', index: 2, message: '完整第二段。', done: true }); }
    if (calls === 4) { assert.deepEqual(env.committed, ['after-document']); assert.match(prompt, /文件完成後查驗 auth.js/); return reply({ kind: 'tool', name: 'read_file', args: { path: 'auth.js' } }); }
    return reply({ kind: 'final', message: '已完成文件與查驗。' });
  }, async (_name, args) => { assert.equal(args.path, 'auth.js'); executed++; return { ok: true, content: 'verified source' }; });
  const parts = [];
  assert.equal((await env.run({ onOutputPart: async part => parts.push(part) })).completed, true);
  assert.equal(calls, 5); assert.equal(executed, 1); assert.equal(env.pending.length, 0);
  assert.deepEqual(parts.map(part => part.message), ['完整第一段。', '完整第二段。']);
  assert.deepEqual(env.finals, ['完整第一段。完整第二段。\n\n已完成文件與查驗。']);
});
