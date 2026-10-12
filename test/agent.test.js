'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const { parseReply, buildPrompt } = require('../src/protocol');

test('agent sends actual denied results back and never invents completed edits', async () => {
  const prompts = [];
  const replies = [JSON.stringify({ kind: 'tool', name: 'write_file', args: { path: 'hello.js', content: 'export const x = 1;' } }),
    JSON.stringify({ kind: 'final', message: '修改未被批准，沒有建立檔案。' })];
  const actions = [], finals = [];
  await runAgent({ bridge: { chat: async prompt => { prompts.push(prompt); return { text: replies.shift() }; } },
    tools: { execute: async (name, args) => { actions.push({ name, args }); return { ok: false, denied: true }; } },
    request: '建立 hello.js', workspace: 'demo', signal: new AbortController().signal, onFinal: text => finals.push(text) });
  assert.equal(actions.length, 1);
  assert.match(prompts[1], /"denied":true/);
  assert.deepEqual(finals, ['修改未被批准，沒有建立檔案。']);
});

test('agent reuses one NTPU conversation for all rounds of a VS Code task', async () => {
  const conversations = [];
  const replies = [JSON.stringify({ kind: 'tool', name: 'read_file', args: { path: 'README.md' } }),
    JSON.stringify({ kind: 'final', message: '已檢查。' })];
  await runAgent({ bridge: { chat: async (prompt, options) => {
    conversations.push(options.newConversation); return { text: replies.shift() };
  } }, tools: { execute: async () => ({ ok: true, content: 'test' }) }, request: '檢查 README',
  signal: new AbortController().signal });
  assert.deepEqual(conversations, [true, false]);
});

test('unstructured prose never executes tools and canceled requests never start a model call', async () => {
  let executed = false;
  const result = await runAgent({ bridge: { chat: async () => ({ text: '```js\nconsole.log(1)\n```' }) },
    tools: { execute: async () => { executed = true; } }, request: '說明程式', signal: new AbortController().signal });
  assert.equal(result.unstructured, true);
  assert.equal(executed, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runAgent({ bridge: { chat: async () => { throw new Error('unexpected model call'); } },
    request: 'x', signal: controller.signal }), /已停止/);
});

test('protocol rejects unknown tools and budget retains authoritative request', () => {
  assert.throws(() => parseReply('{"kind":"tool","name":"delete_all","args":{}}'), /未知工具/);
  assert.equal(parseReply('```json\n{"kind":"final","message":"完成"}\n```').kind, 'final');
  const prompt = buildPrompt({ request: 'Keep this request', records: [{ result: 'x'.repeat(20000) }], budget: 8000 });
  assert.match(prompt, /Keep this request/);
  assert.match(prompt, /older tool records omitted/);
  assert.ok(prompt.length < 8000);
});

test('Build repairs prose and continues actual tool calls before finalizing', async () => {
  const replies = ['我會建立程式。', JSON.stringify({ kind: 'tool', name: 'write_file', args: { path: 'main.js', content: '42' }, message: '我會建立主程式。' }), JSON.stringify({ kind: 'final', message: '已建立 main.js。' })];
  const prompts = [], tools = [], events = [];
  const result = await runAgent({ profile: { agent: 'build' }, request: '建立 main.js', signal: new AbortController().signal,
    bridge: { chat: async prompt => { prompts.push(prompt); return { text: replies.shift() }; } },
    tools: { execute: async (name, args) => { tools.push({ name, args }); return { ok: true, created: true }; } }, onTool: event => events.push(event) });
  assert.equal(result.completed, true); assert.equal(tools.length, 1); assert.equal(prompts.length, 3);
  assert.match(prompts[1], /plain text; no tool ran/); assert.equal(events[0].message, '我會建立主程式。'); assert.equal(events[1].status, 'done');
});
test('unfinished plans trigger continuation, then successful verification updates the plan', async () => {
  const pending = [{ title: '建立並驗證程式', status: 'in_progress' }], done = [{ title: '建立並驗證程式', status: 'completed' }];
  const replies = [
    { kind: 'tool', name: 'update_plan', args: { steps: pending } }, { kind: 'final', message: '以下是計畫。' },
    { kind: 'tool', name: 'run_command', args: { command: 'node --version' } },
    { kind: 'tool', name: 'update_plan', args: { steps: done } }, { kind: 'final', message: '實際檢查完成。' }];
  const prompts = [], checkpoints = [];
  const result = await runAgent({ profile: { agent: 'build' }, request: '檢查環境', signal: new AbortController().signal,
    bridge: { chat: async prompt => { prompts.push(prompt); return { text: JSON.stringify(replies.shift()) }; } },
    tools: { execute: async (name, args) => ({ ok: true, ...(args.steps ? { steps: args.steps } : { output: 'v20' }) }) }, onCheckpoint: records => checkpoints.push([...records]) });
  assert.equal(result.completed, true); assert.equal(prompts.length, 5); assert.match(prompts[2], /unfinished steps/); assert.equal(checkpoints.length, 4);
});
test('a truthful blocked final does not loop or claim completion', async () => {
  const records = [{ type: 'tool', name: 'update_plan', result: { ok: true, steps: [{ title: '建立檔案', status: 'pending' }] } }];
  const result = await runAgent({ profile: { agent: 'build' }, initialRecords: records, request: '繼續', signal: new AbortController().signal,
    bridge: { chat: async () => ({ text: JSON.stringify({ kind: 'final', completed: false, message: '使用者拒絕修改，無法完成。' }) }) }, tools: {} });
  assert.equal(result.completed, false); assert.equal(result.steps, 1);
});
test('resuming carries actual prior results and does not rerun them', async () => {
  let called = false, prompt;
  const result = await runAgent({ initialRecords: [{ type: 'tool', name: 'write_file', args: { path: 'main.js' }, result: { ok: true, saved: true } }],
    request: '繼續', signal: new AbortController().signal, bridge: { chat: async value => { prompt = value; return { text: '{"kind":"final","message":"已完成"}' }; } },
    tools: { execute: async () => { called = true; } } });
  assert.match(prompt, /"saved":true/); assert.equal(called, false); assert.equal(result.completed, true);
});

test('Plan mode may finish with an actionable pending plan without implementing it', async () => {
  const result = await runAgent({ profile: { agent: 'plan' }, initialRecords: [{ name: 'update_plan', result: { ok: true, steps: [{ title: '未來實作', status: 'pending' }] } }],
    request: '規劃功能', signal: new AbortController().signal, tools: {}, bridge: { chat: async () => ({ text: '{"kind":"final","message":"這是實作計畫。"}' }) } });
  assert.equal(result.completed, true); assert.equal(result.steps, 1);
});

test('Build rejects a final-only code proposal and requires actual tool evidence', async () => {
  const replies = [{ kind: 'final', message: '這是完整程式碼。' }, { kind: 'tool', name: 'write_file', args: { path: 'main.js', content: '42' } }, { kind: 'final', message: '已建立檔案。' }];
  let executions = 0;
  const result = await runAgent({ profile: { agent: 'build' }, request: '建立 main.js', signal: new AbortController().signal,
    bridge: { chat: async () => ({ text: JSON.stringify(replies.shift()) }) }, tools: { execute: async () => { executions++; return { ok: true }; } } });
  assert.equal(result.completed, true); assert.equal(executions, 1); assert.equal(result.steps, 3);
});
