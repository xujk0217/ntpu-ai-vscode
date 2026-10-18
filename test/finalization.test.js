'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const encode = reply => ({ text: JSON.stringify(reply) });
function fixture(replies, { execute = async () => ({ ok: true }), ...extra } = {}) {
  const streams = [], finals = [], parts = [], checkpoints = [], activities = [], executed = []; let calls = 0;
  const options = { request: '修正程式並完成交付', profile: { agent: 'build' }, context: '', signal: new AbortController().signal,
    tools: { execute: async (name, args) => { executed.push({ name, args }); return execute(name, args); } },
    bridge: { chat: async (_prompt, transport) => { calls++; assert(replies.length, 'unexpected model call'); const value = replies.shift();
      if (typeof value === 'function') return value(transport); const text = JSON.stringify(value); transport.onToken(text); return { text }; } },
    onStream: text => streams.push(text), onFinal: text => finals.push(text), onOutputPart: async part => parts.push(part),
    onCheckpoint: async records => checkpoints.push(structuredClone(records)), onActivity: text => activities.push(text), ...extra };
  return { run: overrides => runAgent({ ...options, ...overrides }), streams, finals, parts, checkpoints, activities, executed, calls: () => calls };
}

test('premature streamed conclusion stays hidden while the host completes actual work and publishes one validated final', async () => {
  const candidate = 'PREMATURE_COMPLETE: 一切都已經完成。';
  const f = fixture([{ kind: 'final', message: candidate }, { kind: 'tool', name: 'write_file', args: { path: 'game.js', content: 'actual implementation' } },
    { kind: 'final', message: 'VERIFIED_COMPLETE: 已保存實作。' }], { execute: async () => ({ ok: true, saved: true, path: 'game.js' }) });
  const result = await f.run(); assert.equal(result.completed, true); assert.equal(f.calls(), 3); assert.equal(f.executed.length, 1);
  assert.deepEqual(f.finals, ['VERIFIED_COMPLETE: 已保存實作。']); assert(!f.streams.some(text => text.includes(candidate)));
  assert(!f.parts.some(part => part.message.includes(candidate))); assert(f.activities.some(text => /未完成項目/.test(text)));
});

test('pending child evidence never publishes a provisional conclusion before integration', async () => {
  let pending = true;
  const f = fixture([{ kind: 'final', message: 'CHILD_NOT_YET_COLLECTED' }, { kind: 'final', message: '已整合真正子任務結果。' }], {
    request: '提供研究結果', profile: { agent: 'research' },
    tools: { hasPending: () => pending, waitPending: async () => { pending = false; return { ok: true, tasks: [{ status: 'done', result: 'real child evidence' }] }; } },
  });
  assert.equal((await f.run()).completed, true); assert.deepEqual(f.finals, ['已整合真正子任務結果。']);
  assert(!f.streams.some(text => text.includes('CHILD_NOT_YET_COLLECTED'))); assert.equal(f.parts.length, 0);
  assert(f.checkpoints.at(-1).some(record => record.type === 'coordination'));
});

test('a failed read-only child result does not become an unresolved parent execution failure', async () => {
  const f = fixture([{ kind: 'tool', name: 'get_task_results', args: {} }, { kind: 'tool', name: 'write_file', args: { path: 'game.js', content: 'implemented' } },
    { kind: 'final', message: '已保存程式；獨立審查失敗，未宣稱其驗證通過。' }], { execute: async name => name === 'get_task_results' ?
    { ok: false, tasks: [{ status: 'error', result: 'child returned an invalid tool envelope' }] } : { ok: true, saved: true, path: 'game.js' } });
  assert.equal((await f.run()).completed, true); assert.equal(f.calls(), 3); assert.equal(f.finals.length, 1);
  assert.equal(f.checkpoints.at(-1).filter(record => record.type === 'recovery_check').length, 0);
});

test('verified sandbox dependency limitation reports the actual blocker instead of forcing more recovery cycles', async () => {
  const f = fixture([{ kind: 'tool', name: 'run_command', args: { command: 'node visual-test.js' } }, { kind: 'final', message: '所有測試都已完成。' },
    { kind: 'tool', name: 'get_capabilities', args: {} }, { kind: 'tool', name: 'read_file', args: { path: 'game.js' } },
    { kind: 'tool', name: 'get_task_results', args: {} }, { kind: 'final', completed: false, message: '程式已保存；OS 沙箱缺少 rg／socat，尚未執行視覺測試，需要人工開啟檢查。' }], {
    initialRecords: [{ type: 'tool', name: 'write_file', args: { path: 'game.js' }, result: { ok: true, saved: true } }],
    execute: async name => name === 'run_command' ? { ok: false, error: 'OS 沙箱依賴不可用：ripgrep (rg) not found；socat not installed' } :
      name === 'get_task_results' ? { ok: false, tasks: [{ status: 'error', result: 'invalid parallel envelope' }] } : { ok: true, content: 'actual inspected capability/source evidence' },
  });
  assert.equal((await f.run()).completed, false); assert.equal(f.calls(), 6); assert.equal(f.finals.length, 1);
  assert.match(f.finals[0], /socat not installed/); assert.match(f.finals[0], /尚未完成/); assert(!f.streams.some(text => text.includes('所有測試都已完成')));
  assert.equal(f.checkpoints.at(-1).filter(record => record.type === 'recovery_check').length, 1);
});

test('repeated finals separated only by read-only busywork stop with one truthful host outcome', async () => {
  const repeated = '重複聲稱已全部完成';
  const replies = [];
  for (let index = 0; index < 3; index++) replies.push({ kind: 'tool', name: 'read_file', args: { path: 'game.js' } }, { kind: 'final', message: repeated });
  const f = fixture(replies, { execute: async () => ({ ok: true, content: 'unchanged source', timestamp: Date.now() }) });
  const result = await f.run(); assert.equal(result.completed, false); assert.equal(f.calls(), 6); assert.equal(f.finals.length, 1);
  assert.match(f.finals[0], /尚未確認全部任務完成/); assert(!f.finals[0].includes(repeated)); assert(!f.streams.some(text => text.includes(repeated)));
});

test('canceled final streams remain internal recoverable drafts without masquerading as an unfinished document', async () => {
  const controller = new AbortController(); const marker = '尚未驗證的完成結論';
  const f = fixture([async transport => { transport.onToken('{"kind":"final","message":"' + marker); controller.abort(); throw new Error('已停止'); }], { signal: controller.signal });
  await assert.rejects(f.run(), /已停止/); assert.equal(f.finals.length, 0); assert.equal(f.streams.length, 0); assert.equal(f.parts.length, 0);
  const draft = f.checkpoints.at(-1).find(record => record.type === 'response_draft');
  assert.equal(draft.message, marker); assert.equal(draft.internal, true); assert.equal(draft.provisional, true);
  assert(!f.checkpoints.at(-1).some(record => record.type === 'output_draft'));
});

test('read-only timestamp changes do not count as new recovery evidence or extend repeated-final loops', async () => {
  const replies = [{ kind: 'tool', name: 'run_command', args: { command: 'node broken.js' } }, { kind: 'final', message: '仍聲稱已完成。' }];
  for (let index = 0; index < 3; index++) replies.push({ kind: 'tool', name: 'read_file', args: { path: 'game.js' } }, { kind: 'final', message: '仍聲稱已完成。' });
  let reads = 0;
  const f = fixture(replies, { execute: async name => name === 'run_command' ? { ok: false, exit_code: 1, output: 'ordinary runtime failure' } :
    { ok: true, content: 'unchanged source', timestamp: ++reads, duration_ms: reads * 7 } });
  assert.equal((await f.run()).completed, false); assert.equal(f.calls(), 8); assert.equal(f.finals.length, 1);
  assert.equal(f.checkpoints.at(-1).filter(record => record.type === 'recovery_check').length, 3);
  assert.match(f.finals[0], /尚未確認全部任務完成/);
});
