'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AgentWorkers } = require('../src/agent-workers');
const { ModelBudget, RequestScheduler } = require('../src/parallel');
const { AdaptiveConcurrency } = require('../src/adaptive-concurrency');
const { runAgent } = require('../src/agent');
const invalidXml = '<function_calls><invoke name="read_file"><parameter name="path">auth.js</parameter></invoke></function_calls>';
const invalidParallel = '{"kind":"parallel","tools":[{"name":"read_file","args":{"path":"auth.js"}}';
const read = JSON.stringify({ kind: 'tool', name: 'read_file', args: { path: 'auth.js' } });
const final = JSON.stringify({ kind: 'final', message: 'actual read evidence: auth.js line 1', completed: true });
async function environment(t, responses, role = 'review', limit = 20) {
  const controller = new AbortController(), budget = new ModelBudget(limit), adaptive = new AdaptiveConcurrency(), scheduler = new RequestScheduler(2, () => {}, { adaptive });
  let channels = 0, closes = 0, sends = 0; const executed = [], prompts = [], events = [];
  const base = { catalog: () => [{ name: 'read_file', description: 'read actual evidence' }, { name: 'write_file' }],
    execute: async (name, args) => { executed.push({ name, args }); return { ok: true, content: 'actual source line 1', path: args.path }; } };
  const workers = new AgentWorkers({ base, createTools: () => base, scheduler, modelBudget: budget, signal: controller.signal,
    bridge: { createChannel: async () => { channels++; return { chat: async (prompt, transport) => { sends++; prompts.push(prompt); assert(responses.length, 'unexpected model send');
      const response = responses.shift(); return typeof response === 'function' ? response(transport, controller) : { text: response }; }, close: async () => { closes++; } }; } },
    onEvent: event => events.push(event) });
  workers.delegate({ tasks: [{ title: 'read-only actual evidence', role, request: 'Inspect auth.js with actual file tools and report its line-numbered evidence.' }] });
  t.after(async () => { await workers.close(); scheduler.close(); });
  return { workers, controller, budget, scheduler, adaptive, executed, prompts, events, counts: () => ({ channels, closes, sends }), collect: () => workers.collect() };
}

test('real read-only children repair malformed JSON and XML in the same channel and shared scheduler before reading evidence', async t => {
  for (const role of ['explore', 'review', 'research']) await t.test(role, async t => {
    const env = await environment(t, [invalidParallel, invalidXml, read, final], role);
    const result = await env.collect(); assert.equal(result.ok, true); assert.equal(result.tasks[0].status, 'done');
    assert.match(result.tasks[0].result, /actual read evidence/); assert.deepEqual(env.counts(), { channels: 1, closes: 1, sends: 4 });
    assert.equal(env.scheduler.requests, 4); assert.equal(env.budget.used, 4);
    assert.deepEqual(env.executed, [{ name: 'read_file', args: { path: 'auth.js' } }]);
    assert.match(env.prompts[1], /Invalid control envelope/); assert.match(env.prompts[2], /XML invoke\/function calls are unsupported/);
    const job = [...env.workers.jobs.values()][0]; assert.equal(job.records.filter(record => record.type === 'format_error').length, 2);
    assert.equal(job.outputParts.length, 0); assert.equal(job.outputDraft, undefined); assert.equal(job.partialResult, undefined);
    assert(!env.events.some(event => event.partialResult?.includes('<invoke')));
  });
});

test('three malformed read-only envelopes stop after two repairs without executing raw controls or opening a retry channel', async t => {
  const env = await environment(t, [invalidXml, invalidParallel, invalidXml]);
  const result = await env.collect(); assert.equal(result.ok, false); assert.equal(result.tasks[0].status, 'error');
  assert.deepEqual(env.counts(), { channels: 1, closes: 1, sends: 3 }); assert.equal(env.executed.length, 0);
  assert.match(result.tasks[0].result, /連續回傳無效的操作格式/); assert(!result.tasks[0].result.includes('<invoke'));
});

test('protocol repair never retries a provider 429 or a canceled child', async t => {
  for (const failure of ['429', 'cancel']) await t.test(failure, async t => {
    const env = await environment(t, [invalidXml, async (_transport, controller) => {
      if (failure === '429') throw Object.assign(new Error('HTTP 429 provider limit'), { status: 429 });
      controller.abort(); return { text: invalidXml };
    }]);
    const result = await env.collect(); assert.equal(result.ok, false); assert.equal(env.counts().sends, 2); assert.equal(env.counts().channels, 1);
    assert.equal(env.executed.length, 0); assert.equal(env.adaptive.blocked, failure === '429');
    assert.equal(result.tasks[0].status, failure === 'cancel' ? 'interrupted' : 'error');
  });
});

test('normal read-only plain explanations still use the existing fallback instead of protocol repair', async () => {
  for (const content of ['A plain explanation without host tool calls.', '[documentation](https://example.com) is a reference.']) {
    let sends = 0; const finals = [];
    const result = await runAgent({ request: 'Explain the meaning', profile: { agent: 'ask' }, signal: new AbortController().signal,
      bridge: { chat: async () => { sends++; return { text: content }; } }, tools: {}, onFinal: text => finals.push(text) });
    assert.equal(sends, 1); assert.equal(result.unstructured, true); assert.match(finals[0], /未使用本地操作格式/);
  }
});

test('format repair cannot expand the read-only catalog or consume the parent reserve', async t => {
  const deniedWrite = JSON.stringify({ kind: 'tool', name: 'write_file', args: { path: 'auth.js', content: 'must not write' } });
  const env = await environment(t, [deniedWrite, read, final]);
  assert.equal((await env.collect()).ok, true); assert.deepEqual(env.executed.map(call => call.name), ['read_file']);
  const limited = await environment(t, [invalidXml, read], 'review', 5);
  assert.equal((await limited.collect()).ok, false); assert.equal(limited.counts().sends, 2);
  assert.equal(limited.budget.limit - limited.budget.used, 3); assert.equal(limited.executed.length, 1);
});


test('bounded control repair preserves an already saved document instead of replacing it with malformed controls', async () => {
  const responses = [JSON.stringify({ kind: 'output', id: 'doc', index: 1, message: '完整保留的第一段。', done: false }), invalidXml, invalidXml, invalidXml];
  const finals = [], parts = [];
  const result = await runAgent({ request: '完整回傳文件', profile: { agent: 'ask' }, signal: new AbortController().signal, tools: {},
    bridge: { chat: async () => ({ text: responses.shift() }) }, onFinal: text => finals.push(text), onOutputPart: async part => parts.push(part) });
  assert.equal(result.completed, false); assert.equal(result.protocolError, true); assert.equal(parts.length, 1);
  assert.match(finals[0], /^完整保留的第一段。/); assert(!finals[0].includes('<invoke'));
});
