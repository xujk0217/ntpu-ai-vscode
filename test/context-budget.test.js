'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contextBudgetPresentation } = require('../media/context-budget');

test('input budget identifies its local character limit and does not round near capacity to 100%', () => {
  const view = contextBudgetPresentation({ used: 63999, total: 64000, remoteConversation: 'fresh' });
  assert.equal(view.text, '本輪輸入 99%');
  assert.match(view.title, /63999／64000 字元/);
  assert.match(view.title, /不是 Token 數/);
  assert.match(view.title, /不是校方模型上下文使用率/);
  assert.match(view.title, /每次模型請求使用新的校方對話/);
});

test('input budget explains actual compaction and preserves omitted and excerpted history counts', () => {
  const view = contextBudgetPresentation({ used: 24000, total: 32000, compacted: true,
    omittedRecords: 15, excerptedRecords: 2, omittedSections: 3, excerptedSections: 1, memory: { compacted: true, omittedMessages: 50 } });
  assert.equal(view.text, '本輪輸入 75% · 已整理');
  assert.match(view.title, /本機完整聊天、任務與工具紀錄仍保留/);
  assert.match(view.title, /15 筆工具歷史未帶入本輪/);
  assert.match(view.title, /2 筆工具歷史以節錄帶入/);
  assert.match(view.title, /聊天記憶也已依預算選取/);
  assert.doesNotMatch(view.title, /50/);
  assert.match(view.title, /3 個其他輸入區段未帶入本輪/);
  assert.match(view.title, /1 個其他輸入區段以節錄帶入/);
});

test('full input and overflow are explicit instead of clamped to a silent 100%', () => {
  const full = contextBudgetPresentation({ used: 64000, total: 64000 });
  assert.equal(full.text, '本輪輸入 100%');
  assert.match(full.title, /已達本機字元預算上限/);
  const overflow = contextBudgetPresentation({ used: 70400, total: 64000 });
  assert.equal(overflow.text, '本輪輸入 110% · 超出預算');
  assert.match(overflow.title, /請查看任務訊息/);
});

test('missing or invalid budget clears stale presentation without exposing diagnostic input', () => {
  for (const budget of [null, {}, { used: 0, total: 0 }, { used: NaN, total: 1 }, { used: 1, total: Infinity }, { used: -1, total: 64000 }])
    assert.deepEqual(contextBudgetPresentation(budget), { text: '', title: '' });
  const empty = contextBudgetPresentation({ used: 0, total: 64000, omittedRecords: 'secret-token', excerptedRecords: Infinity });
  assert.equal(empty.text, '本輪輸入 0%');
  assert.doesNotMatch(empty.title, /secret-token|Infinity/);
});
