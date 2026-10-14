'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nameSession, shortTitle, parseTitle } = require('../src/session-title');
const { loginPresentation } = require('../media/login-state');
const { ModelBudget, RequestScheduler } = require('../src/parallel');
const { AdaptiveConcurrency } = require('../src/adaptive-concurrency');

test('titles are normalized and capped at ten unicode codepoints', () => {
  assert.equal(shortTitle('  一二三四五六七八九十十一\n '), '一二三四五六七八九十');
  assert.equal(Array.from(shortTitle('😀'.repeat(15))).length, 10);
  assert.equal(parseTitle('```json\n{"title":" 測試登入功能 "}\n```'), '測試登入功能');
  assert.throws(() => parseTitle('{"title":3}'));
});
test('naming shares queue and budget, saves title and cleans an independent channel', async () => {
  const scheduler = new RequestScheduler(1); const budget = new ModelBudget(5), signal = new AbortController().signal;
  let release; const occupied = scheduler.run(() => new Promise(resolve => { release = resolve; })); await new Promise(resolve => setImmediate(resolve));
  let sent = 0, cleanup, saved = 0; const events = [], session = { title: '原始提問' };
  const job = nameSession({ session, request: '處理登入', signal, scheduler, modelBudget: budget,
    bridge: { createChannel: async () => ({ chat: async () => { sent++; return { text: '{"title":"登入流程改進"}' }; }, close: async options => { cleanup = options.cleanup; } }) },
    onEvent: (...args) => events.push(args), onSave: async () => { saved++; } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent, 0); assert.equal(budget.used, 0);
  release(); await occupied; await job;
  assert.equal(session.title, '登入流程改進'); assert.equal(budget.used, 1); assert.equal(scheduler.requests, 2); assert.equal(cleanup, true); assert.equal(saved, 1); assert.equal(events.at(-1)[0], 'done'); scheduler.close();
});
test('naming failures preserve fallback and manual names; hard limits pause parent scheduler', async () => {
  for (const mode of ['manual', 'format', 'timeout', 'limit', 'cancel']) {
    const adaptive = new AdaptiveConcurrency(), scheduler = new RequestScheduler(2, () => {}, { adaptive });
    const budget = new ModelBudget(8), controller = new AbortController(), session = { title: '原始名稱' }; let sent = 0;
    await nameSession({ session, request: 'x', signal: controller.signal, scheduler, modelBudget: budget,
      bridge: { createChannel: async () => ({ chat: async () => { sent++; if (mode === 'manual') { session.title = '使用者名稱'; session.titleSource = 'manual'; }
        if (mode === 'cancel') { controller.abort(); throw new Error('已停止'); }
        if (mode === 'timeout') throw new Error('timeout'); if (mode === 'limit') throw Object.assign(new Error('limit'), { status: 429 });
        return { text: mode === 'format' ? 'bad' : '{"title":"AI名稱"}' }; }, close: async () => {} }) } });
    assert.equal(sent, 1); assert.equal(session.title, mode === 'manual' ? '使用者名稱' : '原始名稱'); assert.equal(adaptive.blocked, mode === 'limit'); scheduler.close();
  }
});
test('login notice distinguishes required login, background disconnect and completed connection', () => {
  assert.equal(loginPresentation({ ready: true }).hidden, true);
  const required = loginPresentation({ authentication: 'required' }); assert.equal(required.required, true); assert.equal(required.action, '登入 NTPU AI');
  assert.equal(loginPresentation({ authentication: 'unknown' }).title, 'NTPU AI 尚未連線');
  assert.equal(loginPresentation({ loginWindow: true }).action, '返回登入視窗');
  assert.equal(loginPresentation({ connecting: true }).action, '');
  assert.equal(loginPresentation({ loginComplete: true }).title, '登入成功');
});
