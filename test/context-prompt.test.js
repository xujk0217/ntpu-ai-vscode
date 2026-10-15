'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPromptDetailed } = require('../src/protocol');
const { ContextManager } = require('../src/memory/context');
const { runAgent } = require('../src/agent');
const { taskStepLimit } = require('../src/task-budget');
const { ModelBudget } = require('../src/parallel');

test('tool-log pressure compacts before the hard limit and reserves same-chat memory and latest actual evidence', () => {
  const messages = [{ role: 'user', text: '必須保留所有本機資料；工作目錄是 alpha，不能換成 beta。' },
    { role: 'assistant', text: '先前的完整內容。'.repeat(600) + 'RECENT-ANSWER-TAIL' }];
  const context = new ContextManager().compose({ request: '繼續修正', session: { messages }, budget: 32000,
    project: { entries: Array.from({ length: 100 }, (_, id) => ({ id, kind: 'summary', text: 'project-data '.repeat(300) })) } });
  const records = Array.from({ length: 120 }, (_, index) => ({ type: 'tool', name: 'read_file', args: { path: `old-${index}.js` }, result: { ok: true, text: 'long-source '.repeat(2000) } }));
  records.push({ type: 'tool', name: 'run_command', args: { command: 'npm test' }, result: { ok: false, exit_code: 1, output: 'logs '.repeat(10000) + 'LATEST-FAILURE-TAIL' } });
  const snapshot = JSON.stringify({ messages, records });
  const built = buildPromptDetailed({ request: '繼續修正', context, records, budget: 64000 });
  assert.ok(built.text.length <= 64000 * 0.85);
  assert.equal(built.diagnostics.used, built.text.length);
  assert.equal(built.diagnostics.compacted, true);
  assert.ok(built.diagnostics.reservedHistoryCharacters > 0);
  assert.match(built.text, /不能換成 beta/);
  assert.match(built.text, /RECENT-ANSWER-TAIL/);
  assert.match(built.text, /LATEST-FAILURE-TAIL/);
  assert.match(built.text, /"exit_code":1/);
  assert.match(built.text, /HOST CONTEXT COMPACTION/);
  assert.equal(JSON.stringify({ messages, records }), snapshot);
});

test('pending plan and denied actions survive a large newer tool history without becoming success', () => {
  const records = [
    { type: 'tool', name: 'update_plan', result: { ok: true, steps: [{ title: '仍須回歸驗證', status: 'pending' }] } },
    { type: 'tool', name: 'write_file', args: { path: 'protected-change.js' }, result: { ok: false, denied: true } },
    ...Array.from({ length: 80 }, () => ({ type: 'tool', name: 'read_file', result: { ok: true, text: 'noise '.repeat(3000) } })),
  ];
  const { text } = buildPromptDetailed({ request: '繼續', records, budget: 32000 });
  assert.match(text, /host_live_constraints/);
  assert.match(text, /仍須回歸驗證/);
  assert.match(text, /"status":"pending"/);
  assert.match(text, /protected-change.js/);
  assert.match(text, /"denied":true/);
});

test('middle unfinished plan steps and denied command identities survive compaction at the minimum budget', () => {
  const records = [
    { type: 'tool', name: 'update_plan', result: { ok: true, steps: Array.from({ length: 50 }, (_, i) => ({
      title: i === 25 ? 'ONLY-PENDING-MIDDLE-STEP' : `completed step ${i}`, status: i === 25 ? 'pending' : 'completed',
    })) } },
    { type: 'tool', name: 'run_command', args: { command: 'DO-NOT-RUN-THIS-EXACT-COMMAND' }, result: { ok: false, denied: true } },
    ...Array.from({ length: 80 }, () => ({ type: 'tool', name: 'read_file', result: { ok: true, text: 'noise '.repeat(3000) } })),
  ];
  const { text } = buildPromptDetailed({ request: '繼續', records, budget: 16000, catalog: [] });
  assert.match(text, /ONLY-PENDING-MIDDLE-STEP/);
  assert.match(text, /"unfinishedStepCount":1/);
  assert.match(text, /DO-NOT-RUN-THIS-EXACT-COMMAND/);
  assert.ok(text.length <= 16000);
});

test('small explicit context stays complete and sensitive text is redacted before record excerpts', () => {
  const secret = 'ghp_' + 'Z'.repeat(35);
  const built = buildPromptDetailed({ request: '檢查', context: 'tiny-memory', records: [
    { type: 'tool', name: 'read_file', result: { ok: true, text: `Bearer ${secret}\n` + 'body '.repeat(10000) + '\nSAFE-TAIL' } },
  ], budget: 32000 });
  assert.match(built.text, /tiny-memory/);
  assert.doesNotMatch(built.text, new RegExp(secret));
  assert.match(built.text, /SAFE-TAIL/);
  assert.match(built.text, /REDACTED/);
});

test('a self-contained fresh request retains attachment and preceding tool facts on every round', async () => {
  const prompts = [], fresh = [], attachments = [], budgets = [];
  const image = { name: 'approved-fixture.png', approved: true, buffer: Buffer.from('fixture') };
  const replies = [{ kind: 'tool', name: 'read_file', args: { path: 'source.js' } }, { kind: 'final', message: '已確認。' }];
  await runAgent({ request: '分析附件與程式', profile: { agent: 'ask' }, context: 'EARLIER-USER-RESTRICTION', attachment: image,
    signal: new AbortController().signal, onBudget: value => budgets.push(value),
    tools: { execute: async () => ({ ok: true, text: 'EXACT-ACTUAL-TOOL-FACT' }) },
    bridge: { chat: async (prompt, options) => { prompts.push(prompt); fresh.push(options.newConversation); attachments.push(options.attachment); return { text: JSON.stringify(replies.shift()) }; } },
  });
  assert.deepEqual(fresh, [true, true]);
  assert.deepEqual(attachments, [image, image]);
  assert.match(prompts[1], /EARLIER-USER-RESTRICTION/);
  assert.match(prompts[1], /EXACT-ACTUAL-TOOL-FACT/);
  assert.ok(budgets.every((value, i) => value.used === prompts[i].length && value.remoteConversation === 'fresh'));
});

test('standard and deep tasks can reach the configured 100–200 shared rounds without the old 50/100 clamps', () => {
  assert.equal(taskStepLimit(), 100);
  for (const depth of ['standard', 'deep']) for (const configured of [100, 150, 200]) {
    const budget = new ModelBudget(taskStepLimit(configured, depth));
    for (let index = 1; index <= configured; index++) assert.equal(budget.consume(), index);
    assert.equal(budget.consume(), null);
  }
  assert.equal(taskStepLimit(200, 'quick'), 12);
  assert.equal(taskStepLimit(500, 'deep'), 200);
  assert.equal(taskStepLimit(0), 1);
  assert.equal(taskStepLimit('invalid'), 100);
});
