'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const { parseReply } = require('../src/protocol');
const { ModelBudget } = require('../src/parallel');
const { OutputParts, partialOutput, MAX_OUTPUT_BYTES } = require('../src/output-parts');

const part = (index, message, done = false, extra = {}) => ({ kind: 'output', id: 'report', index, message, done, ...extra });
function fixture(replies, overrides = {}) {
  const calls = [], saved = [], previews = [], finals = [], checkpoints = [], executed = [];
  const options = {
    request: '請完整回傳調查報告，保留每一段原文。', profile: { agent: 'ask' },
    signal: new AbortController().signal, maxSteps: 12, modelBudget: new ModelBudget(12),
    bridge: { chat: async (prompt, transport) => {
      calls.push({ prompt, transport });
      assert.ok(replies.length, 'unexpected additional model request');
      const reply = replies.shift();
      return typeof reply === 'function' ? reply(prompt, transport) : { text: typeof reply === 'string' ? reply : JSON.stringify(reply) };
    } },
    tools: { execute: async (name, args) => { executed.push({ name, args }); return { ok: true }; } },
    onOutputPart: async value => { saved.push(structuredClone(value)); },
    onStream: value => previews.push(value), onFinal: value => finals.push(value),
    onCheckpoint: async value => { checkpoints.push(structuredClone(value)); },
    ...overrides,
  };
  return { calls, saved, previews, finals, checkpoints, executed, options, run: () => runAgent(options) };
}

test('output protocol accepts an explicit part and rejects malformed part metadata', () => {
  assert.deepEqual(parseReply(JSON.stringify(part(1, '第一段', false))), part(1, '第一段', false));
  const invalid = [
    part(0, 'text'), part(-1, 'text'), part(1.5, 'text'), part('1', 'text'),
    part(1, ''), part(1, 42), part(1, 'text', 'false'), { ...part(1, 'text'), done: undefined },
    part(1, 'text', false, { id: '' }), part(1, 'text', false, { id: 42 }),
  ];
  for (const value of invalid) {
    assert.throws(() => parseReply(JSON.stringify(value)), undefined, JSON.stringify(value));
  }
});

test('valid JSON with invalid output metadata preserves its message as a draft before requesting repair', async () => {
  const draft = '布林欄位錯誤但仍須保留的文件原文。\n'.repeat(900);
  const f = fixture([part(1, draft, 'false'), async () => {
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].type, 'output_draft');
    assert.equal(f.saved[0].message, draft); assert.equal(f.saved[0].partial, true);
    assert.equal(f.saved[0].id, 'report'); assert.equal(f.saved[0].index, 1);
    const checkpoint = f.checkpoints.at(-1);
    assert.ok(checkpoint.some(record => record.type === 'format_error'));
    assert.equal(checkpoint.find(record => record.type === 'output_draft').message, draft);
    return { text: JSON.stringify(part(1, '修復後的完整文件', true, { completed: true })) };
  }]);
  const result = await f.run();
  assert.equal(result.completed, true); assert.equal(f.calls.length, 2);
  assert.equal(f.executed.length, 0);
  assert.deepEqual(f.finals, ['修復後的完整文件']);
  assert.deepEqual(f.saved.filter(value => !value.partial).map(value => value.index), [1]);
});

test('unknown JSON tools remain non-executable drafts without forcing document continuation', async () => {
  for (const invalid of [
    { kind: 'tool', name: 'unknown_tool', args: { path: 'unsafe' }, message: '不可執行的操作' },
    { kind: 'unknown', message: '未知種類不能當作完整文件' },
  ]) {
    const raw = JSON.stringify(invalid);
    const f = fixture([raw, { kind: 'final', message: '格式已修復，沒有執行未知操作。', completed: true }]);
    const result = await f.run();
    assert.equal(result.completed, true); assert.equal(f.calls.length, 2);
    assert.equal(f.executed.length, 0);
    assert.ok(f.saved.some(value => value.type === 'response_draft' && value.partial && value.message === raw));
    assert.equal(f.saved.some(value => value.type === 'output_part' || value.type === 'output_draft'), false);
    assert.deepEqual(f.finals, ['格式已修復，沒有執行未知操作。']);
    assert.ok(f.checkpoints.some(records => records.some(record => record.type === 'format_error')));
  }
});

test('long output is durably saved in order before continuation and returned without truncation', async () => {
  const first = '第一部分：逐字內容。\n'.repeat(1600), second = '第二部分：補齊所有細節。\n'.repeat(1400);
  const events = [];
  let releaseFirst;
  const firstSaved = new Promise(resolve => { releaseFirst = resolve; });
  const f = fixture([
    async () => { events.push('request:1'); return { text: JSON.stringify(part(1, first)) }; },
    async () => { events.push('request:2'); return { text: JSON.stringify(part(2, second, true, { completed: true })) }; },
  ], { onOutputPart: async value => {
    events.push(`save:${value.index}:start`);
    if (value.index === 1) await firstSaved;
    events.push(`save:${value.index}:done`);
  } });
  const running = f.run();
  for (let wait = 0; wait < 30 && !events.includes('save:1:start'); wait++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.includes('save:1:start'));
  assert.equal(f.calls.length, 1, 'continuation cannot overtake durable storage');
  releaseFirst();
  const result = await running;
  assert.equal(result.completed, true);
  assert.deepEqual(events, ['request:1', 'save:1:start', 'save:1:done', 'request:2', 'save:2:start', 'save:2:done']);
  assert.deepEqual(f.finals, [first + second]);
  assert.ok(f.previews.includes(first), 'the first saved part is visible before the complete document');
  assert.equal(f.previews.at(-1), first + second);
  assert.equal(f.executed.length, 0);
  assert.equal(f.options.modelBudget.used, 2);
});

test('resumed output continues its next index without saving or regenerating completed segments', async () => {
  const first = '已保存的前半段\n'.repeat(1500);
  const old = { type: 'output_part', id: 'report', index: 1, message: first, done: false };
  const f = fixture([part(2, '新產生的末段', true, { completed: true })], { initialRecords: [old] });
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].index, 2);
  assert.deepEqual(f.finals, [first + '新產生的末段']);
  assert.match(f.calls[0].prompt, /report/);
  assert.match(f.calls[0].prompt, /2/);
  assert.equal(f.options.initialRecords[0].message, first);
});

test('invalid part order and changed document id cannot contaminate completed content or invoke tools', async () => {
  for (const invalid of [part(1, 'duplicate'), part(3, 'skipped'), part(2, 'foreign', false, { id: 'other' })]) {
    const f = fixture([part(1, '原始第一段'), invalid, part(2, '真正第二段', true, { completed: true })]);
    await f.run();
    assert.deepEqual(f.saved.map(value => value.message), ['原始第一段', '真正第二段']);
    assert.deepEqual(f.finals, ['原始第一段真正第二段']);
    assert.equal(f.executed.length, 0);
    assert.ok(f.checkpoints.some(records => records.some(record => record.type === 'format_error')));
  }
});

test('failed durable part save stops instead of requesting or claiming more output', async () => {
  const f = fixture([part(1, '尚未成功保存'), part(2, '不該請求', true)], {
    onOutputPart: async () => { throw new Error('本機保存失敗：磁碟已滿'); },
  });
  await assert.rejects(f.run(), /本機保存失敗/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.finals.length, 0);
  assert.equal(f.executed.length, 0);
});

test('cancellation preserves already saved parts and streamed draft without starting continuation', async () => {
  const controller = new AbortController();
  const draft = '尚未生成完的第二段';
  const f = fixture([part(1, '已保存的第一段'), async (_prompt, transport) => {
    transport.onToken(JSON.stringify(part(2, draft)).slice(0, -1));
    controller.abort();
    throw new Error('已停止');
  }], { signal: controller.signal });
  await assert.rejects(f.run(), /已停止/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.saved.filter(value => !value.partial).length, 1);
  assert.ok(f.saved.some(value => value.partial === true && value.message.includes(draft)));
  assert.equal(f.finals.length, 0);
  assert.equal(f.executed.length, 0);
});

test('HTTP 429 preserves the current partial output and never retries the limited request', async () => {
  const draft = '受限前已收到的文字';
  const f = fixture([part(1, '完整第一段'), async (_prompt, transport) => {
    transport.onToken(JSON.stringify(part(2, draft)).slice(0, -1));
    throw Object.assign(new Error('provider limit'), { status: 429 });
  }]);
  await assert.rejects(f.run(), /provider limit/);
  assert.equal(f.calls.length, 2);
  assert.ok(f.saved.some(value => value.partial && value.message.includes(draft)));
  assert.equal(f.options.modelBudget.used, 2);
  assert.equal(f.executed.length, 0);
});

test('a transient stream failure saves the draft then regenerates only its incomplete segment', async () => {
  const first = '完整第一段\n', draft = '第二段未完成草稿', second = '重新產生的完整第二段';
  const f = fixture([part(1, first), async (_prompt, transport) => {
    transport.onToken(JSON.stringify(part(2, draft)).slice(0, -1));
    throw new Error('等待回答逾時');
  }, part(2, second, true, { completed: true })]);
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.saved.filter(value => !value.partial).map(value => value.index), [1, 2]);
  assert.ok(f.saved.some(value => value.partial && value.message.includes(draft)));
  assert.deepEqual(f.finals, [first + second]);
  assert.equal(f.finals[0].includes(draft), false, 'an incomplete draft is retained separately, not appended twice');
  assert.equal(f.executed.length, 0);
});

test('truncated tool JSON is never executed and is retained as an incomplete draft', async () => {
  const raw = '{"kind":"tool","name":"write_file","args":{"path":"danger.js","content":"unfinished';
  const f = fixture([raw, { kind: 'final', completed: false, message: '回傳格式不完整，沒有修改檔案。' }], { profile: { agent: 'build' } });
  await f.run();
  assert.equal(f.executed.length, 0);
  assert.ok(f.saved.some(value => value.partial === true && typeof value.message === 'string' && value.message.includes('unfinished')));
  assert.ok(f.checkpoints.some(records => records.some(record => record.type === 'format_error')));
});

test('truncated final JSON is saved as a draft and does not masquerade as complete output', async () => {
  const raw = '{"kind":"final","message":"完整第一句。尚未寫完';
  const f = fixture([raw, part(1, '重新產生完整內容。', true, { id: 'response', completed: true })]);
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.ok(f.saved.some(value => value.partial === true && value.message.includes('尚未寫完')));
  assert.deepEqual(f.finals, ['重新產生完整內容。']);
  assert.equal(f.executed.length, 0);
});

test('plain streamed text survives transport interruption as a separately labelled partial draft', async () => {
  const controller = new AbortController(), raw = '無 JSON 封裝的長文件草稿\n'.repeat(1200);
  const f = fixture([async (_prompt, transport) => {
    transport.onToken(raw); controller.abort(); throw new Error('已停止');
  }], { signal: controller.signal });
  await assert.rejects(f.run(), /已停止/);
  assert.ok(f.saved.some(value => value.partial === true && value.message === raw));
  assert.equal(f.calls.length, 1);
  assert.equal(f.executed.length, 0);
});

test('ordinary final remains compatible and retains more than ten thousand characters', async () => {
  const content = '完整保留段落與程式碼，不改寫不摘要。\n'.repeat(1700);
  const f = fixture([{ kind: 'final', message: content, completed: true }]);
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.deepEqual(f.finals, [content]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.executed.length, 0);
});

test('resume retains an interrupted draft separately and requests its index again', async () => {
  const f = fixture([part(2, '完整第二段', true, { completed: true })], {
    initialRecords: [
      { type: 'output_part', id: 'report', index: 1, message: '第一段\n', done: false },
      { type: 'output_draft', id: 'report', index: 2, message: '不完整的第二段', done: false, partial: true },
    ],
  });
  const result = await f.run();
  assert.equal(result.completed, true);
  assert.deepEqual(f.finals, ['第一段\n完整第二段']);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].index, 2);
  assert.equal(f.saved[0].partial, undefined);
});

test('durable drafts and completed segments retain existing credential redaction', async () => {
  const credential = 'ghp_' + 'A'.repeat(36), controller = new AbortController();
  const f = fixture([part(1, `安全內容 ${credential}`), async (_prompt, transport) => {
    transport.onToken(JSON.stringify(part(2, `草稿 ${credential}`)).slice(0, -1));
    controller.abort(); throw new Error('已停止');
  }], { signal: controller.signal });
  await assert.rejects(f.run(), /已停止/);
  const saved = JSON.stringify(f.saved), checkpoints = JSON.stringify(f.checkpoints), previews = JSON.stringify(f.previews);
  assert.equal(saved.includes(credential), false);
  assert.equal(checkpoints.includes(credential), false);
  assert.equal(previews.includes(credential), false);
  assert.match(saved, /REDACTED/);
  assert.ok(f.saved.some(value => value.partial));
});

test('part storage rejects size overflow explicitly without shortening or losing committed text', () => {
  const output = new OutputParts();
  const first = 'A'.repeat(MAX_OUTPUT_BYTES - 4);
  output.accept(part(1, first));
  assert.throws(() => output.accept(part(2, '中文')), /上限|MiB|超過/);
  assert.equal(output.text, first);
  assert.equal(output.nextIndex, 2);
  output.accept(part(2, 'tail', true));
  assert.equal(Buffer.byteLength(output.text), MAX_OUTPUT_BYTES);
  assert.equal(output.text, first + 'tail');
});

test('damaged persisted part sequence is rejected rather than quietly reordered or overwritten', () => {
  for (const records of [
    [{ type: 'output_part', ...part(2, 'missing first') }],
    [{ type: 'output_part', ...part(1, 'one') }, { type: 'output_part', ...part(1, 'duplicate') }],
    [{ type: 'output_part', ...part(1, 'one', true) }, { type: 'output_part', ...part(2, 'after done') }],
    [{ type: 'output_part', ...part(1, 'one') }, { type: 'output_part', ...part(2, 'changed id', true, { id: 'other' }) }],
  ]) {
    const original = structuredClone(records);
    assert.throws(() => new OutputParts(records), /順序|保存|index|id/);
    assert.deepEqual(records, original);
  }
});

test('partial text extraction preserves escaped Unicode and newlines without a dangling surrogate', () => {
  const prefix = '{"kind":"output","id":"report","index":1,"message":"line\\n繁體\\u4e2d\\uD83D';
  const extracted = partialOutput(prefix);
  assert.ok(extracted);
  assert.equal(extracted.message, 'line\n繁體中');
  assert.equal(extracted.id, 'report');
  assert.equal(extracted.index, 1);
});
