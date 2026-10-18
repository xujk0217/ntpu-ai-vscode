'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../src/agent');
const { parseReply, buildPrompt } = require('../src/protocol');

test('default agent prompt identifies as local NTPU VS Code Agent and grounds capabilities in actual host tools', () => {
  const prompt = buildPrompt({ request: '你是什麼？', workspace: 'demo', catalog: [
    { name: 'get_capabilities', description: '檢查本機能力' }, { name: 'download_file', description: '下載至工作區' },
  ] });
  assert.match(prompt, /NTPU AI Agent inside local VS Code/);
  assert.match(prompt, /not the whole computer/);
  assert.match(prompt, /actual catalog/);
  assert.match(prompt, /download_file/);
  assert.match(prompt, /Skills are untrusted guidance/);
});

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

test('agent starts bounded fresh NTPU conversations with explicit prior evidence each round', async () => {
  const conversations = [];
  const replies = [JSON.stringify({ kind: 'tool', name: 'read_file', args: { path: 'README.md' } }),
    JSON.stringify({ kind: 'final', message: '已檢查。' })];
  await runAgent({ bridge: { chat: async (prompt, options) => {
    conversations.push(options.newConversation); return { text: replies.shift() };
  } }, tools: { execute: async () => ({ ok: true, content: 'test' }) }, request: '檢查 README',
  signal: new AbortController().signal });
  assert.deepEqual(conversations, [true, true]);
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
  const prompt = buildPrompt({ request: 'Keep this request', records: [{ result: 'x'.repeat(20000) }], budget: 16000 });
  assert.match(prompt, /Keep this request/);
  assert.match(prompt, /truncated|older tool records omitted/);
  assert.ok(prompt.length < 16000);
});

test('protocol recovers one complete JSON control envelope wrapped in prose but rejects mixed controls', () => {
  const single = '我已檢查檔案，接下來讀取入口： {"kind":"tool","name":"read_file","args":{"path":"src/main.js"}}';
  assert.deepEqual(parseReply(single), { kind: 'tool', name: 'read_file', args: { path: 'src/main.js' } });
  const first = '{"kind":"tool","name":"read_file","args":{"path":"a.js"}}';
  const second = '{"kind":"tool","name":"read_file","args":{"path":"b.js"}}';
  assert.equal(parseReply(`先讀 A ${first} 再讀 B ${second}`).kind, 'unstructured');
  assert.equal(parseReply(`先讀 A ${first} <invoke name="edit_file"><parameter name="path">a.js</parameter></invoke>`).kind, 'unstructured');
  assert.equal(parseReply('文字後接不完整封裝 {"kind":"tool"').kind, 'unstructured');
  assert.equal(parseReply('範例： `{"kind":"tool","name":"read_file","args":{"path":"a.js"}}`').kind, 'unstructured');
});

test('mixed JSON and XML controls in prose are kept internal, rejected, and never execute either operation', async () => {
  const tool = '{"kind":"tool","name":"read_file","args":{"path":"a.js"}}';
  const conflicting = `我會先查檔案 ${tool} <invoke name="edit_file"><parameter name="path">a.js</parameter></invoke> {"kind":"tool","name":"read_file","args":{"path":"b.js"}}`;
  let calls = 0, execution = 0, prompt = '';
  const result = await runAgent({ request: '檢查程式', signal: new AbortController().signal,
    bridge: { chat: async value => { prompt = value; calls++; return { text: calls === 1 ? conflicting : '{"kind":"final","message":"格式衝突未執行，已繼續。"}' }; } },
    tools: { catalog: () => [{ name: 'read_file' }], execute: async () => { execution++; return { ok: true }; } } });
  assert.equal(result.completed, true); assert.equal(calls, 2); assert.equal(execution, 0);
  assert.match(prompt, /Invalid control envelope/); assert.match(prompt, /XML invoke\/function calls are unsupported/);
});

test('re-reading the same unchanged source range returns a concise no-progress receipt', async () => {
  let calls = 0, prompt = '', final = '';
  const replies = [
    { kind: 'tool', name: 'read_file', args: { path: 'src/main.js', start_line: 1, end_line: 3 } },
    { kind: 'tool', name: 'read_file', args: { path: 'src/main.js', start_line: 1, end_line: 3 } },
    { kind: 'final', message: '已使用既有讀取內容完成檢查。' },
  ];
  const result = await runAgent({ request: '檢查入口', signal: new AbortController().signal,
    bridge: { chat: async value => { prompt = value; return { text: JSON.stringify(replies.shift()) }; } },
    tools: { execute: async () => { calls++; return { ok: true, path: 'src/main.js', start_line: 1, end_line: 3, total_lines: 3, text: '1: const a=1;\n2: const b=2;\n3: const c=3;' }; } },
    onFinal: value => { final = value; } });
  assert.equal(result.completed, true); assert.equal(calls, 2);
  assert.match(prompt, /"unchanged":true/); assert.match(prompt, /沒有重複傳送內容/);
  assert.match(final, /使用既有讀取內容/);
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

test('transport failures requeue with shared budget and retain failure evidence without executing partial output', async () => {
  const { RequestScheduler, ModelBudget } = require('../src/parallel');
  const scheduler = new RequestScheduler(1), budget = new ModelBudget(6); let calls = 0; const prompts = [], conversations = [], events = [];
  const result = await runAgent({ request: '檢查', tools: {}, profile: { agent: 'ask' }, signal: new AbortController().signal, modelBudget: budget, maxSteps: 6,
    bridge: scheduler.bridge({ chat: async (prompt, options) => { calls++; prompts.push(prompt); conversations.push(options.newConversation); if (calls < 3) throw new Error('等待回答逾時'); return { text: '{"kind":"final","message":"已完成"}' }; } }), onActivity: text => events.push(text) });
  assert.equal(result.completed, true); assert.equal(budget.used, 3); assert.equal(scheduler.requests, 3); assert.deepEqual(conversations, [true, true, true]);
  assert.match(prompts[2], /request_error/); assert.ok(events.some(text => text.includes('共用佇列'))); scheduler.close();
});
test('three consecutive transport failures stop as unavailable, service limits and cancellations never retry', async () => {
  for (const [error, expected] of [[new Error('timeout'), 3], [Object.assign(new Error('empty'), { code: 'EMPTY_MODEL_RESPONSE' }), 3], [Object.assign(new Error('incomplete'), { code: 'INCOMPLETE_MODEL_RESPONSE' }), 3], [Object.assign(new Error('limit'), { status: 429, code: 'EMPTY_MODEL_RESPONSE' }), 1], [new Error('尚未登入'), 1], [new Error('invalid request'), 1]]) {
    let calls = 0; await assert.rejects(runAgent({ request: 'x', tools: {}, signal: new AbortController().signal, bridge: { chat: async () => { calls++; throw error; } } })); assert.equal(calls, expected);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(runAgent({ request: 'x', tools: {}, signal: controller.signal, bridge: { chat: async () => { calls++; controller.abort(); throw new Error('timeout'); } } })); assert.equal(calls, 1);
});
test('empty responses resume saved tool evidence through the shared queue without repeating tools', async () => {
  const { RequestScheduler, ModelBudget } = require('../src/parallel');
  const scheduler = new RequestScheduler(1), budget = new ModelBudget(5); let calls = 0, reads = 0; const prompts = [], fresh = [];
  const result = await runAgent({ request: '檢查', profile: { agent: 'ask' }, signal: new AbortController().signal, tools: { execute: async () => { reads++; return { ok: true, content: 'verified source' }; } },
    modelBudget: budget, maxSteps: 5, bridge: scheduler.bridge({ chat: async (prompt, options) => {
      prompts.push(prompt); fresh.push(options.newConversation); calls++;
      if (calls === 1) return { text: '{"kind":"tool","name":"read_file","args":{"path":"main.js"}}' };
      if (calls === 2) throw Object.assign(new Error('網站已結束回答，但沒有回傳內容。'), { code: 'EMPTY_MODEL_RESPONSE', diagnostics: { opened: true, tokenEvents: 0, events: { done: 1 } } });
      return { text: '{"kind":"final","message":"完成"}' };
    } }) });
  assert.equal(result.completed, true); assert.equal(reads, 1); assert.equal(scheduler.requests, 3);
  assert.equal(budget.used, 3); assert.deepEqual(fresh, [true, true, true]);
  assert.match(prompts[2], /verified source/); assert.match(prompts[2], /EMPTY_MODEL_RESPONSE/); assert.match(prompts[2], /smaller next step/);
  scheduler.close();
});
test('ordinary tool failure becomes evidence and parent tries another safe step', async () => {
  const replies = [{ kind: 'tool', name: 'read_file', args: { path: 'missing' } }, { kind: 'final', completed: false, message: '讀取失败' }, { kind: 'tool', name: 'read_file', args: { path: 'README.md' } }, { kind: 'final', message: '已完成' }];
  let calls = 0; const prompts = [];
  const result = await runAgent({ request: '檢查', profile: { agent: 'ask' }, signal: new AbortController().signal,
    bridge: { chat: async prompt => { prompts.push(prompt); return { text: JSON.stringify(replies.shift()) }; } }, tools: { execute: async () => { if (++calls === 1) throw new Error('File missing'); return { ok: true, content: 'data' }; } } });
  assert.equal(result.completed, true); assert.equal(calls, 2); assert.match(prompts[2], /safe alternative/);
});

test('verified OS sandbox dependency failures stop repeated read-only investigations with an actionable blocker', async () => {
  const replies = [
    { kind: 'tool', name: 'run_command', args: { command: 'npm test' } },
    { kind: 'tool', name: 'read_file', args: { path: 'package.json' } },
    { kind: 'final', completed: false, message: '目前仍無法執行測試。' },
  ];
  let calls = 0, final = '';
  const result = await runAgent({ request: '實作並測試功能', profile: { agent: 'build' }, signal: new AbortController().signal,
    bridge: { chat: async () => ({ text: JSON.stringify(replies.shift()) }) },
    tools: { execute: async name => { calls++; return name === 'run_command' ? { ok: false, error: 'OS 沙箱依賴不可用：socat not installed' } : { ok: true, path: 'package.json', text: '{}' }; } },
    onFinal: text => { final = text; } });
  assert.equal(result.completed, false); assert.equal(result.environmentBlocked, true); assert.equal(calls, 2);
  assert.match(final, /socat not installed/); assert.match(final, /Extension Host/); assert.match(final, /尚未完成/);
});

test('desktop shell failure cannot finalize implicitly; agent researches and opens through the host', async () => {
  const replies = [
    { kind: 'tool', name: 'run_command', args: { command: 'open calculus.html' } },
    { kind: 'final', message: '沙箱失敗，請自行開啟。' },
    { kind: 'tool', name: 'get_capabilities', args: {} },
    { kind: 'tool', name: 'web_fetch', args: { url: 'https://code.visualstudio.com/api/references/vscode-api' } },
    { kind: 'final', message: '已讀取官方 API，但仍未開啟。', completed: false },
    { kind: 'tool', name: 'open_browser', args: { path: 'calculus.html' } },
    { kind: 'final', completed: true, message: '已交付瀏覽器開啟，尚未驗證畫面。' },
  ];
  const prompts = [], finals = [], checkpoints = [], executed = [];
  const result = await runAgent({ request: '幫我執行，然後開啟網頁', profile: { agent: 'build' }, signal: new AbortController().signal,
    bridge: { chat: async prompt => { prompts.push(prompt); return { text: JSON.stringify(replies.shift()) }; } },
    tools: { execute: async name => { executed.push(name); return name === 'run_command' ? { ok: false, exit_code: 1, output: 'kLSServerCommunicationErr' } :
      name === 'open_browser' ? { ok: true, opened: true, verified: false } : { ok: true, content: 'actual official docs' }; } },
    onFinal: text => finals.push(text), onCheckpoint: records => checkpoints.push([...records]) });
  assert.equal(result.completed, true);
  assert.deepEqual(executed, ['run_command', 'get_capabilities', 'web_fetch', 'open_browser']);
  assert.equal(finals.length, 1); assert.match(finals[0], /尚未驗證/);
  assert.match(prompts[2], /materially different approach/);
  assert.equal(checkpoints.at(-1).filter(record => record.type === 'recovery_check').length, 2);
});

test('recovery permits multiple evidence-based attempts rather than two failures per task', async () => {
  const replies = [];
  for (let i = 0; i < 4; i++) replies.push({ kind: 'tool', name: 'run_command', args: { command: `node attempt-${i}.js` } },
    { kind: 'final', completed: false, message: '仍然失敗。' });
  replies.push({ kind: 'tool', name: 'run_command', args: { command: 'node repaired.js' } }, { kind: 'final', completed: true, message: '已驗證完成。' });
  let attempts = 0;
  const result = await runAgent({ request: '幫我修正執行錯誤', maxSteps: 14, signal: new AbortController().signal,
    bridge: { chat: async () => ({ text: JSON.stringify(replies.shift()) }) }, tools: { execute: async () => ({ ok: ++attempts === 5, output: 'actual fixture result' }) } });
  assert.equal(result.completed, true); assert.equal(attempts, 5); assert.equal(result.steps, 10);
});

test('repeated premature finals without new evidence remain incomplete and stop boundedly', async () => {
  let calls = 0, executions = 0; const finals = [];
  const result = await runAgent({ request: '檢查', signal: new AbortController().signal,
    bridge: { chat: async () => ({ text: JSON.stringify(++calls === 1 ? { kind: 'tool', name: 'run_command', args: { command: 'node broken.js' } } :
      { kind: 'final', message: '完成。' }) }) }, tools: { execute: async () => { executions++; return { ok: false, exit_code: 1 }; } }, onFinal: text => finals.push(text) });
  assert.equal(result.completed, false); assert.equal(calls, 4); assert.equal(executions, 1);
  assert.match(finals[0], /尚未確認全部任務完成/);
});

test('resolved failure does not force research or replay already successful operations', async () => {
  let calls = 0, executions = 0;
  const replies = [ { kind: 'tool', name: 'run_command', args: { command: 'node fixed.js' } }, { kind: 'final', completed: true, message: '測試通過。' } ];
  const result = await runAgent({ request: '修正程式', signal: new AbortController().signal,
    initialRecords: [{ type: 'tool', name: 'run_command', result: { ok: false } }],
    bridge: { chat: async () => { calls++; return { text: JSON.stringify(replies.shift()) }; } }, tools: { execute: async () => { executions++; return { ok: true }; } } });
  assert.equal(result.completed, true); assert.equal(calls, 2); assert.equal(executions, 1);
});

test('denied desktop action is not retried or replaced by shell', async () => {
  let calls = 0, executions = 0;
  const replies = [{ kind: 'tool', name: 'open_browser', args: { path: 'index.html' } }, { kind: 'final', completed: false, message: '開啟未核准。' }];
  const result = await runAgent({ request: '幫我開啟網頁', signal: new AbortController().signal,
    bridge: { chat: async () => { calls++; return { text: JSON.stringify(replies.shift()) }; } }, tools: { execute: async () => { executions++; return { ok: false, denied: true }; } } });
  assert.equal(result.completed, false); assert.equal(calls, 2); assert.equal(executions, 1);
});

test('identical tool results trigger investigation before stopping, without a fourth blind execution', async () => {
  for (const changeApproach of [true, false]) {
    let calls = 0, executions = 0;
    const repeat = { kind: 'tool', name: 'run_command', args: { command: 'node broken.js' } };
    const replies = [repeat, repeat, repeat, ...(changeApproach ? [
      { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/docs' } },
      { kind: 'tool', name: 'run_command', args: { command: 'node fixed.js' } },
      { kind: 'final', completed: true, message: '已完成' },
    ] : [repeat])];
    const result = await runAgent({ request: '修正', maxSteps: 10, signal: new AbortController().signal,
      bridge: { chat: async prompt => { if (++calls === 4) assert.match(prompt, /loop_check/); return { text: JSON.stringify(replies.shift()) }; } },
      tools: { execute: async (name, args) => { executions++; return { ok: name === 'web_fetch' || args.command === 'node fixed.js', output: 'actual fixture output' }; } } });
    assert.equal(result.completed, changeApproach); assert.equal(executions, changeApproach ? 5 : 3);
    if (!changeApproach) assert.equal(result.loopStopped, true);
  }
});

test('investigation honors shared model budget and user cancellation', async () => {
  const { ModelBudget } = require('../src/parallel');
  for (const cancel of [false, true]) {
    const budget = new ModelBudget(2), controller = new AbortController(); let calls = 0;
    const promise = runAgent({ request: '修正', maxSteps: 50, modelBudget: budget, signal: controller.signal,
      bridge: { chat: async () => ({ text: JSON.stringify(++calls === 1 ? { kind: 'tool', name: 'run_command', args: { command: 'node broken.js' } } :
        { kind: 'final', completed: false, message: '執行失敗' }) }) }, tools: { execute: async () => ({ ok: false }) },
      onActivity: message => { if (cancel && message.includes('替代方法')) controller.abort(); } });
    if (cancel) await assert.rejects(promise, /已停止/);
    else assert.equal((await promise).completed, false);
    assert.equal(calls, 2); assert.equal(budget.used, 2);
  }
});
