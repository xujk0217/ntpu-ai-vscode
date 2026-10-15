'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const { AgentWorkers } = require('../src/agent-workers');
const { ModelBudget, RequestScheduler } = require('../src/parallel');
const { AdaptiveConcurrency } = require('../src/adaptive-concurrency');

const request = '研究登入架構與測試覆蓋，請同時比較風險，提供有檔案行號與實際證據的完整報告。';
const assessment = { kind: 'delegation', tasks: [{ title: '獨立測試證據', role: 'review', request: '檢查 child.js 的測試情境',
  independent: true, expectedOutput: '列出 child.js 的實際測試情境、行號及缺少的回歸案例。' }] };
const reply = value => ({ text: JSON.stringify(value) });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function environment({ parent, child, adaptive, budget = 30 }) {
  const controller = new AbortController(), modelBudget = new ModelBudget(budget), scheduler = new RequestScheduler(2, () => {}, { adaptive });
  const trace = [], prompts = [], snapshots = [], finals = [], events = [], savedParts = []; let channels = 0, closed = 0;
  const base = { catalog: () => [{ name: 'read_file', description: 'Read actual fixture evidence' }],
    execute: async (name, args) => { trace.push('read:' + args.path); return { ok: true, path: args.path, content: 'fixture evidence ' + args.path }; } };
  const bridge = { createChannel: async () => { channels++; trace.push('child:open'); return {
    chat: async (...args) => child(...args), close: async () => { closed++; trace.push('child:closed'); } }; } };
  const workers = new AgentWorkers({ base, bridge, scheduler, modelBudget, signal: controller.signal, createTools: () => base,
    profile: { agent: 'research' }, onEvent: event => events.push(event) });
  const run = (options = {}) => runAgent({ bridge: scheduler.bridge({ chat: async (...args) => { prompts.push(args[0]); return parent(...args); } }),
    tools: workers, modelBudget, request, signal: controller.signal, profile: { agent: 'research' }, maxSteps: 12,
    onCheckpoint: records => snapshots.push(records), onOutputPart: async part => savedParts.push(part), onFinal: text => finals.push(text), ...options });
  const close = async () => { await workers.close(); scheduler.close(); };
  return { run, close, base, workers, controller, scheduler, modelBudget, trace, prompts, snapshots, finals, events, savedParts,
    channels: () => channels, closed: () => closed };
}

test('complex request starts a real child, parent works independently, and final waits for actual child evidence', async () => {
  const childStarted = deferred(), finishChild = deferred(); let parentStep = 0, childStep = 0;
  const env = environment({
    parent: async prompt => {
      if (++parentStep === 1) { assert.match(prompt, /HOST DELEGATION ASSESSMENT REQUIRED/); return reply(assessment); }
      if (parentStep === 2) return reply({ kind: 'tool', name: 'read_file', args: { path: 'parent.js' } });
      if (parentStep === 3) {
        await childStarted.promise;
        assert(env.trace.includes('read:parent.js')); assert(!env.trace.includes('read:child.js'));
        finishChild.resolve(); return reply({ kind: 'final', message: '暫定結論，等待整合子任務。' });
      }
      assert.match(prompt, /actual child evidence: missing boundary case/);
      assert.match(prompt, /fixture evidence parent.js/);
      return reply({ kind: 'final', message: '已整合 parent.js 與 child.js 的真實證據，缺少邊界回歸案例。' });
    },
    child: async () => {
      if (++childStep === 1) { childStarted.resolve(); await finishChild.promise; return reply({ kind: 'tool', name: 'read_file', args: { path: 'child.js' } }); }
      return reply({ kind: 'final', message: 'actual child evidence: missing boundary case' });
    },
  });
  try {
    const result = await env.run();
    assert.equal(result.completed, true); assert.equal(env.channels(), 1); assert.equal(env.closed(), 1);
    assert.equal(parentStep, 4); assert.equal(childStep, 2); assert.equal(env.modelBudget.used, 6);
    assert.equal(env.finals.length, 1); assert.match(env.finals[0], /已整合/);
    const last = env.snapshots.at(-1);
    const assigned = last.find(record => record.type === 'delegation_assessment');
    assert.equal(assigned.result.tasks.length, 1);
    const collected = last.find(record => record.type === 'coordination');
    assert.equal(collected.result.tasks[0].status, 'done'); assert.match(collected.result.tasks[0].result, /actual child evidence/);
    assert.equal(env.savedParts.find(part => part.provisional).message, '暫定結論，等待整合子任務。');
    assert(env.trace.indexOf('read:parent.js') < env.trace.indexOf('read:child.js'));
  } finally { finishChild.resolve(); await env.close(); }
});

test('invalid assessment envelopes and unknown formats also have a bounded single-agent fallback', async () => {
  for (const invalid of [{ kind: 'delegation', tasks: [{ title: 'invalid', role: 'build' }] }, { kind: 'unknown' }]) {
    let step = 0;
    const env = environment({ parent: async () => reply(++step <= 2 ? invalid : { kind: 'final', message: '主 Agent 接手完成。' }),
      child: async () => { throw new Error('unexpected child'); } });
    try {
      assert.equal((await env.run()).completed, true); assert.equal(step, 3); assert.equal(env.channels(), 0);
      const fallback = env.snapshots.at(-1).find(record => record.type === 'delegation_assessment');
      assert.equal(fallback.result.delegated, false); assert.match(fallback.result.rationale, /模型未回傳有效分工格式/);
    } finally { await env.close(); }
  }
});

test('failed parent checkpoint after scheduling is propagated without pretending assignment succeeded durably', async () => {
  const env = environment({ parent: async () => reply(assessment), child: async () => reply({ kind: 'final', message: '真實子任務結果。' }) });
  try {
    await assert.rejects(env.run({ onCheckpoint: async () => { throw new Error('本機保存失敗：磁碟已滿'); } }), /本機保存失敗/);
    await env.workers.close({ cancel: false });
    assert.equal(env.prompts.length, 1); assert.equal(env.channels(), 1); assert.equal(env.finals.length, 0);
    assert.equal(env.workers.jobs.size, 1); assert.equal([...env.workers.jobs.values()][0].result, '真實子任務結果。');
  } finally { await env.close(); }
});

test('simple work does not create children or demand an assessment', async () => {
  const env = environment({ parent: async prompt => { assert.doesNotMatch(prompt, /HOST DELEGATION ASSESSMENT REQUIRED/); return reply({ kind: 'final', message: '你好。' }); },
    child: async () => { throw new Error('unexpected child'); } });
  try { assert.equal((await env.run({ request: '你好' })).completed, true); assert.equal(env.channels(), 0); assert.equal(env.prompts.length, 1); }
  finally { await env.close(); }
});

test('disabled delegation leaves normal parent tools and completion working for complex requests', async () => {
  let step = 0;
  const env = environment({ parent: async prompt => {
    assert.doesNotMatch(prompt, /HOST DELEGATION ASSESSMENT REQUIRED/);
    return reply(++step === 1 ? { kind: 'tool', name: 'read_file', args: { path: 'parent.js' } } : { kind: 'final', message: '已直接完成調查。' });
  }, child: async () => { throw new Error('unexpected child'); } });
  try { assert.equal((await env.run({ tools: env.base })).completed, true); assert.deepEqual(env.trace, ['read:parent.js']); assert.equal(env.channels(), 0); }
  finally { await env.close(); }
});

test('two unsupported ordinary replies produce an explicit single-agent fallback without running the blocked tools', async () => {
  let step = 0;
  const env = environment({ parent: async () => reply(++step <= 2 ? { kind: 'tool', name: 'read_file', args: { path: 'should-not-run.js' } } :
    step === 3 ? { kind: 'tool', name: 'read_file', args: { path: 'parent.js' } } : { kind: 'final', message: '主 Agent 已完成。' }),
  child: async () => { throw new Error('unexpected child'); } });
  try {
    assert.equal((await env.run()).completed, true); assert.equal(step, 4); assert.equal(env.channels(), 0);
    assert.deepEqual(env.trace, ['read:parent.js']);
    const fallback = env.snapshots.at(-1).find(record => record.type === 'delegation_assessment');
    assert.equal(fallback.result.delegated, false); assert.match(fallback.result.rationale, /模型未回傳有效分工格式/);
  } finally { await env.close(); }
});

test('cancellation after receiving a plan cannot create a child or run its tools', async () => {
  const env = environment({ parent: async () => { env.controller.abort(); return reply(assessment); }, child: async () => { throw new Error('unexpected child'); } });
  try { await assert.rejects(env.run(), /已停止/); assert.equal(env.channels(), 0); assert.equal(env.workers.jobs.size, 0); assert.deepEqual(env.trace, []); }
  finally { await env.close(); }
});

test('provider 429 stops parent sends and prevents any delegation', async () => {
  const adaptive = new AdaptiveConcurrency();
  const env = environment({ adaptive, parent: async () => { throw Object.assign(new Error('HTTP 429 provider limit'), { status: 429 }); },
    child: async () => { throw new Error('unexpected child'); } });
  try {
    await assert.rejects(env.run(), /429/); assert.equal(env.channels(), 0); assert.equal(env.prompts.length, 1); assert.equal(adaptive.blocked, true);
    assert.throws(() => env.workers.delegate({ tasks: assessment.tasks }), /服務限制/);
  } finally { await env.close(); }
});

test('a child 429 blocks the shared queue rather than opening replacement child conversations', async () => {
  const adaptive = new AdaptiveConcurrency(); adaptive.configure(1); let sends = 0;
  const env = environment({ adaptive, parent: async () => reply(assessment),
    child: async () => { sends++; throw Object.assign(new Error('HTTP 429 child limit'), { status: 429 }); } });
  try {
    await assert.rejects(env.run(), /429/);
    await env.workers.collect(); assert.equal(adaptive.blocked, true); assert.equal(env.channels(), 1); assert.equal(sends, 1);
    assert.throws(() => env.workers.delegate({ tasks: [{ ...assessment.tasks[0], request: 'different independent work' }] }), /服務限制/);
    assert.equal(env.channels(), 1);
  } finally { await env.close(); }
});
