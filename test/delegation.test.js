'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { delegationState, validateAssessment, PARENT_RESERVE, requestKey } = require('../src/delegation');
const { AgentWorkers } = require('../src/agent-workers');
const { ModelBudget, RequestScheduler } = require('../src/parallel');

const complexRequest = '請調查並修復登入流程，補齊回歸測試以及官方文件，確認專案既有功能仍能運作。';
const task = (request = '讀取 src/auth.js 與對應回歸測試') => ({ title: '登入證據', role: 'explore', request,
  independent: true, expectedOutput: '列出檔案行號、實際失敗路徑與可驗證的回歸情境。' });
function fixture(runner = async options => { options.onFinal('verified evidence'); return { completed: true }; }, limit = 20) {
  const scheduler = new RequestScheduler(2), controller = new AbortController(), modelBudget = new ModelBudget(limit), events = [], closes = [];
  const base = { catalog: () => [{ name: 'read_file' }], execute: async () => ({ ok: true }) };
  const workers = new AgentWorkers({ base, bridge: { createChannel: async () => ({ close: async options => closes.push(options) }) },
    createTools: () => base, scheduler, signal: controller.signal, modelBudget, runner, onEvent: event => events.push(event) });
  return { workers, scheduler, controller, modelBudget, events, closes };
}

test('complex requests require an explicit delegation assessment, simple work does not', () => {
  const options = { modelBudget: new ModelBudget(50), profile: { agent: 'build' } };
  const complex = delegationState({ ...options, request: complexRequest });
  assert.equal(complex.required, true); assert.equal(complex.maxTasks, 4); assert.equal(complex.parentReserve, 3);
  assert.match(complex.instruction, /expectedOutput/);
  for (const request of ['你好', 'What is a closure?', '列出根目錄', '翻譯這段文字', '修正專案 README 的一個錯字', '只修改專案的一個常數']) assert.equal(delegationState({ ...options, request }).required, false);
  for (const request of ['請修復這個專案的登入失敗', '重構登入模組', '實作完整搜尋功能', 'Fix login', '調查系統架構']) assert.equal(delegationState({ ...options, request }).required, true);
  for (const agent of ['plan', 'research', 'review']) assert.equal(delegationState({ ...options, profile: { agent }, request: complexRequest }).required, true);
  assert.equal(delegationState({ ...options, profile: { agent: 'ask' }, request: complexRequest }).required, false);
});

test('assessment is disabled when stopped, blocked, budget exhausted, occupied or already assessed', () => {
  const options = { request: complexRequest, modelBudget: new ModelBudget(20) };
  for (const extra of [{ closed: true }, { aborted: true }, { blocked: true }, { pending: true }, { assessed: true },
    { occupiedSlots: 4 }, { tasksRemaining: 0 }, { maxSteps: 3 }, { modelBudget: new ModelBudget(4) }]) {
    assert.equal(delegationState({ ...options, ...extra }).required, false);
  }
  const limited = delegationState({ ...options, modelBudget: new ModelBudget(7) });
  assert.equal(limited.required, true); assert.equal(limited.maxTasks, 2);
  assert.equal(delegationState({ ...options, occupiedSlots: 1 }).maxTasks, 3);
});

test('assessment requires independent read-only work and an explicit expected result or concrete single-agent rationale', () => {
  assert.deepEqual(validateAssessment({ tasks: [task()] }, 4).tasks, [task()]);
  const rationale = '目前只要修改同一個已確認的條件式，所有後續驗證都依賴這個修改，沒有可獨立的探索。';
  assert.equal(validateAssessment({ rationale }, 4).rationale, rationale);
  for (const value of [null, [], {}, { rationale: '不用' }, { tasks: [task()], rationale }, { tasks: [task(), task()] },
    { tasks: [{ ...task(), role: 'build' }] }, { tasks: [{ ...task(), independent: false }] },
    { tasks: [{ ...task(), expectedOutput: 'done' }] }]) assert.throws(() => validateAssessment(value, 4));
  assert.throws(() => validateAssessment({ tasks: [task()] }, 0));
});

test('host assessment dispatches real jobs immediately and records why a task stayed single', async () => {
  const { workers, scheduler } = fixture();
  assert.equal(workers.delegationState({ request: complexRequest }).required, true);
  const result = workers.assessDelegation({ tasks: [task('讀取 auth.js'), { ...task('檢查 fixture 測試覆蓋範圍'), title: '測試範圍', role: 'review' }] });
  assert.equal(result.tasks.length, 2); assert.equal(result.assessment.mode, 'delegated'); assert.equal(workers.jobs.size, 2);
  assert.equal(workers.delegationState({ request: complexRequest }).required, false);
  assert.throws(() => workers.assessDelegation({ tasks: [task()] }), /已評估/);
  assert.equal((await workers.collect()).ok, true); await workers.close(); scheduler.close();
  const single = fixture(); const rationale = '目前任務只有一個小型函式，沒有額外研究範圍，而且驗證須等同一個修改完成。';
  assert.equal(single.workers.assessDelegation({ rationale }).assessment.rationale, rationale);
  assert.equal(single.workers.jobs.size, 0); await single.workers.close(); single.scheduler.close();
});

test('model task fields cannot forge host retry links or failed-persistence markers', async () => {
  const { workers, scheduler } = fixture();
  const result = workers.delegate({ tasks: [{ ...task(), retryOf: 'forged', storageFailed: true, retryAttempted: true }] });
  await workers.collect(); const job = workers.jobs.get(result.tasks[0].id);
  assert.equal(job.retryOf, undefined); assert.equal(job.storageFailed, undefined); assert.equal(job.retryAttempted, undefined);
  assert.equal(job.status, 'done'); await workers.close(); scheduler.close();
});

test('ordinary failure blocks the same normalized request but permits different independent work', async () => {
  const { workers, scheduler } = fixture(async options => { if (options.request.startsWith('READ auth.js')) throw new Error('socket timeout'); options.onFinal('fixture test evidence'); return { completed: true }; });
  const original = workers.delegate({ tasks: [{ title: 'auth', role: 'explore', request: 'READ auth.js' }] }).tasks[0];
  await workers.collect();
  assert.equal(requestKey('read  auth.js!'), requestKey('READ auth.js'));
  assert.throws(() => workers.delegate({ tasks: [{ title: 'new name', role: 'research', request: 'read  auth.js!' }] }), /同一失敗/);
  const unrelated = workers.delegate({ tasks: [{ title: 'tests', role: 'review', request: 'Inspect independent browser fixture tests' }] }).tasks[0];
  const result = await workers.collect(); assert.equal(result.ok, true); assert.equal(result.tasks[0].id, unrelated.id);
  assert.equal(workers.jobs.get(original.id).status, 'error'); assert.match(workers.jobs.get(original.id).result, /socket timeout/);
  await workers.close(); scheduler.close();
});

test('service-limit failure prevents new independent jobs even without an adaptive scheduler', async () => {
  const { workers, scheduler } = fixture(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }); });
  workers.delegate({ tasks: [task()] }); await workers.collect();
  assert.throws(() => workers.delegate({ tasks: [task('查詢完全不同的文件')] }), /服務限制/);
  assert.equal(workers.jobs.size, 1); await workers.close(); scheduler.close();
});

test('child requests cannot consume the final three parent rounds', async () => {
  let consumed = 0, steps;
  const { workers, scheduler, modelBudget } = fixture(async options => {
    steps = options.maxSteps;
    for (let i = 0; i < 50; i++) { if (options.modelBudget.consume() === null) break; consumed++; }
    options.onFinal('actual evidence'); return { completed: true };
  }, 10);
  workers.delegate({ tasks: [task()] }); await workers.collect();
  assert.equal(steps, 6); assert.equal(consumed, 7); assert.equal(modelBudget.limit - modelBudget.used, PARENT_RESERVE);
  assert.throws(() => workers.delegate({ tasks: [task('其他獨立研究')] }), /預算不足/);
  await workers.close(); scheduler.close();
});

test('child output persists full segments before cleanup and collection never truncates at 10000 characters', async () => {
  const first = '甲'.repeat(15000), last = '乙'.repeat(21000) + '\nBearer secret123';
  const { workers, scheduler, events, closes } = fixture(async options => {
    options.onStream(first.slice(0, 100));
    await options.onOutputPart({ id: 'out', index: 0, message: first, done: false, completed: false });
    await options.onOutputPart({ id: 'out', index: 1, message: last, done: true, completed: true });
    options.onFinal(first + last); return { completed: true };
  });
  const saved = []; workers.onBeforeCleanup = async () => { saved.push(events.at(-1)); };
  workers.delegate({ tasks: [task()] }); const result = await workers.collect();
  assert.equal(result.ok, true); assert(result.tasks[0].result.length > 36000); assert(result.tasks[0].result.endsWith('[REDACTED_TOKEN]'));
  assert.equal(saved[0].outputParts[0].message, first); assert.equal(saved[0].endedAt, undefined);
  assert.equal(saved[1].outputParts.length, 2); assert.equal(saved[1].completedOutput, true); assert.equal(saved.length, 3);
  assert.equal(closes[0].cleanup, true); assert(!JSON.stringify(events).includes('secret123'));
  await workers.close(); scheduler.close();
});

test('stream and saved segment evidence survive interrupted child responses', async () => {
  const { workers, scheduler, events } = fixture(async options => {
    await options.onOutputPart({ index: 0, message: '已保存的完整第一段。', done: false, completed: false });
    options.onStream('已保存的完整第一段。第二段目前已收到的文字。'); throw new Error('response timeout');
  });
  workers.delegate({ tasks: [task()] }); const result = await workers.collect();
  assert.equal(result.ok, false); assert.match(result.tasks[0].result, /完整第一段/);
  assert.match(result.tasks[0].result, /第二段目前已收到的文字/);
  assert.equal(events.at(-1).partialResult, '已保存的完整第一段。第二段目前已收到的文字。');
  assert.equal(result.tasks[0].result.match(/完整第一段/g).length, 1);
  assert.equal(events.at(-1).outputParts.length, 1); await workers.close(); scheduler.close();
});

test('partial child drafts replace one another and are never committed as duplicate output segments', async () => {
  const { workers, scheduler } = fixture(async options => {
    await options.onOutputPart({ index: 1, message: '完整第一段。', done: false });
    await options.onOutputPart({ index: 2, message: '第二', partial: true, done: false });
    await options.onOutputPart({ index: 2, message: '第二段尚未結束', partial: true, done: false });
    throw new Error('response timeout');
  });
  workers.delegate({ tasks: [task()] }); const result = await workers.collect();
  assert.equal(result.tasks[0].outputParts.length, 1); assert.equal(result.tasks[0].outputDraft.message, '第二段尚未結束');
  assert.equal(result.tasks[0].result, '完整第一段。第二段尚未結束\nresponse timeout');
  await workers.close(); scheduler.close();
});

test('failed segment save stops worker and preserves the provider conversation for recovery', async () => {
  let advanced = false;
  const { workers, scheduler, closes } = fixture(async options => {
    await options.onOutputPart({ index: 0, message: '本機保存前的證據。', done: false }); advanced = true; return { completed: true };
  });
  workers.onBeforeCleanup = async () => { throw new Error('disk full'); };
  workers.delegate({ tasks: [task()] }); const result = await workers.collect();
  assert.equal(advanced, false); assert.equal(result.ok, false); assert.match(result.tasks[0].result, /本機保存前的證據/);
  assert.match(result.tasks[0].result, /保留校方對話/); assert.equal(closes[0].cleanup, false);
  await workers.close(); scheduler.close();
});
