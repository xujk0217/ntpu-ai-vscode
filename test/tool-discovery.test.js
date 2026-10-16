'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { ToolDiscovery, MAX_LOADED, workerTool } = require('../src/tool-discovery');
const { PermissionPolicy } = require('../src/permissions');
const { McpManager, listToolPages } = require('../src/mcp');
const { runAgent } = require('../src/agent');
const { buildPromptDetailed } = require('../src/protocol');
const { AgentWorkers } = require('../src/agent-workers');
function nativeTools(options = {}, approval = async detail => detail.accept) {
  const filename = path.join(__dirname, '..', 'src', 'tools.js'), mod = new Module(filename);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod.require = name => name === 'vscode' ? { workspace: { isTrusted: true } } : Module.prototype.require.call(mod, name);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return new mod.exports.WorkspaceTools({ fsPath: '/synthetic-workspace' }, {}, new AbortController().signal, () => {}, approval, options);
}
const remote = (index, extra = {}) => ({ name: 'mcp_fixture_tool_' + index, originalName: 'tool_' + index, server: 'fixture',
  description: 'Read PDF document extraction ' + index, external: true, readOnly: true,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, ...extra });
function fakeManager(tools) { return { catalog: () => [...tools.values()], tools, states: () => [], connections: new Map(), call: async () => ({ ok: true }) }; }
test('inventory beyond 40 stays searchable and paged; initial and loaded prompt catalogs remain bounded', () => {
  const all = Array.from({ length: 240 }, (_, index) => remote(index)), discovery = new ToolDiscovery(() => all);
  assert.equal(discovery.active().length, 0);
  const seen = []; let offset = 0;
  do { const page = discovery.search({ query: 'PDF', offset, limit: 20 }); seen.push(...page.matches.map(tool => tool.name)); offset = page.nextOffset; assert.equal(page.total, 240); } while (offset !== null);
  assert.equal(new Set(seen).size, 240);
  assert.equal(discovery.search({ query: 'tool_239' }).matches[0].name, all[239].name);
  for (const tool of all.slice(0, 10)) discovery.describe({ name: tool.name });
  assert.equal(discovery.active().length, MAX_LOADED); assert.equal(discovery.isLoaded(all[0].name), false);
  assert.equal(discovery.describe({ name: all[0].name }).evicted.length, 1);
  assert.equal(discovery.isLoaded(all[0].name), true);
});
test('large schema pages concatenate exactly; missing pages, stale versions and metadata changes never enable a tool', () => {
  const tool = remote(1, { inputSchema: { type: 'object', description: 'exact '.repeat(1100), properties: { text: { type: 'string' } } } });
  const discovery = new ToolDiscovery(() => [tool]);
  const first = discovery.describe({ name: tool.name }); assert.equal(first.complete, false); assert.equal(first.loaded, false);
  assert.throws(() => discovery.describe({ name: tool.name, offset: 2000 }), /version/);
  const last = discovery.describe({ name: tool.name, offset: first.totalCharacters - 100, version: first.version });
  assert.equal(last.complete, false); assert.equal(last.nextOffset, 2000);
  let text = first.schemaText, offset = first.nextOffset;
  while (offset !== null) { const page = discovery.describe({ name: tool.name, offset, version: first.version }); text += page.schemaText; offset = page.nextOffset; }
  assert.deepEqual(JSON.parse(text), tool.inputSchema); assert.equal(discovery.isLoaded(tool.name), true);
  tool.inputSchema.required = ['text']; assert.equal(discovery.isLoaded(tool.name), false);
  assert.throws(() => discovery.describe({ name: tool.name, offset: 2000, version: first.version }), /變更/);
  assert.throws(() => discovery.search({ query: 'x'.repeat(301) })); assert.throws(() => discovery.search({ offset: -1 }));
});
test('schema secrets are redacted before paging, metadata does not expose server credentials, and scope only narrows', async () => {
  const tool = remote(1, { description: 'Bearer private-fixture-token', inputSchema: { type: 'object', properties: { text: { type: 'string', default: 'Bearer private-fixture-token' } } } });
  const tools = nativeTools({ mcp: fakeManager(new Map([[tool.name, tool]])), servers: [{ name: 'private-server', label: 'Documents', url: 'https://private.invalid?token=not-for-model', secretKey: 'hidden-secret-key', command: 'private-command' }] });
  const page = await tools.execute('describe_tool', { name: tool.name });
  assert.doesNotMatch(JSON.stringify(page), /private-fixture-token/); assert.match(page.schemaText, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(await tools.execute('search_tools', {})), /not-for-model|hidden-secret-key|private-command/);
  tools.restrictDiscovery(workerTool); assert.equal((await tools.execute('search_tools', { query: 'tool_1' })).total, 0);
  assert.equal((await tools.execute('describe_tool', { name: tool.name })).ok, false);
  assert.equal((await tools.execute(tool.name, { text: 'x' })).denied, true);
  tools.restrictDiscovery(() => true); assert.equal(tools.catalog().some(item => item.name === tool.name), false);
});
test('automatic preparation selects relevant connected tools only; execution still requires approval and blocks sensitive arguments', async () => {
  const target = remote(64), irrelevant = remote(1, { description: 'Calendar events', name: 'mcp_calendar_event', originalName: 'event' });
  let calls = 0, approvals = 0;
  const manager = fakeManager(new Map([[target.name, target], [irrelevant.name, irrelevant]]));
  manager.call = async () => { calls++; return { ok: true, text: 'actual extracted text' }; };
  const tools = nativeTools({ mcp: manager }, async detail => { approvals++; return detail.accept; });
  const absent = await tools.execute(target.name, { text: 'x' }); assert.equal(absent.needsToolLoad, true); assert.notEqual(absent.denied, true);
  tools.prepareTools('PDF extraction'); assert.equal(tools.catalog().some(tool => tool.name === target.name), true);
  assert.equal(tools.catalog().some(tool => tool.name === irrelevant.name), false); assert.equal(calls, 0);
  assert.equal((await tools.execute(target.name, { text: 'hello' })).ok, true); assert.equal(approvals, 1); assert.equal(calls, 1);
  assert.equal((await tools.execute(target.name, { password: 'private-password' })).ok, false); assert.equal(calls, 1);
  const denied = nativeTools({ mcp: manager }, async () => null); denied.prepareTools('PDF');
  assert.equal((await denied.execute(target.name, { text: 'hello' })).denied, true); assert.equal(calls, 1);
  const readOnly = nativeTools({ mcp: manager, policy: new PermissionPolicy({ mode: 'full', agent: 'review' }) });
  target.readOnly = false; readOnly.prepareTools('PDF'); assert.equal(readOnly.catalog().some(tool => tool.name === target.name), false);
});
test('disabled web removes Exa discovery and schema access, including refresh; disconnected configured servers remain discoverable without connection', async () => {
  let refreshes = 0, connections = 0;
  const tool = remote(1, { server: 'exa' }), manager = fakeManager(new Map([[tool.name, tool]]));
  manager.connections.set('exa', { config: { name: 'exa' } }); manager.refresh = async () => { refreshes++; };
  const tools = nativeTools({ web: false, mcp: manager, servers: [{ name: 'docs', label: 'Research documents', type: 'stdio', command: 'node', args: [] }], connectMcp: async () => { connections++; } });
  assert.equal((await tools.execute('search_tools', { query: 'tool_1' })).total, 0);
  assert.equal((await tools.execute('search_tools', { server: 'exa', refresh: true })).ok, false); assert.equal(refreshes, 0);
  const servers = await tools.execute('search_tools', { query: 'Research' }); assert.equal(servers.matches[0].kind, 'server'); assert.equal(servers.matches[0].canConnect, true);
  assert.equal(connections, 0); assert.equal((await tools.execute('describe_tool', { name: tool.name })).ok, false);
});
test('model loop discovers, loads and calls a tool beyond the former cap with the full schema visible next round', async () => {
  const all = new Map(Array.from({ length: 80 }, (_, i) => { const t = remote(i, { description: 'Synthetic capability ' + i }); return [t.name, t]; }));
  let called = 0, turn = 0; const prompts = [], manager = fakeManager(all); manager.call = async () => { called++; return { ok: true, text: 'ACTUAL_RESULT' }; };
  const tools = nativeTools({ mcp: manager });
  const target = all.get('mcp_fixture_tool_79');
  const replies = [{ kind: 'tool', name: 'search_tools', args: { query: 'tool_79' } }, { kind: 'tool', name: 'describe_tool', args: { name: target.name } },
    { kind: 'tool', name: target.name, args: { text: 'fixture-input' } }, { kind: 'final', message: '已取得實際結果' }];
  const result = await runAgent({ tools, bridge: { chat: async prompt => { prompts.push(prompt); return { text: JSON.stringify(replies[turn++]) }; } }, request: '使用可用工具取得資料', signal: new AbortController().signal });
  assert.equal(result.completed, true); assert.equal(called, 1); assert.match(prompts[2], /mcp_fixture_tool_79:[\s\S]*"required":\["text"\]/);
  assert.match(prompts[3], /ACTUAL_RESULT/);
});
test('loaded tools remain usable under the minimum prompt budget without flooding the catalog', () => {
  const all = new Map(Array.from({ length: 6 }, (_, i) => { const t = remote(i, { inputSchema: { type: 'object', description: 'schema '.repeat(300) } }); return [t.name, t]; }));
  const tools = nativeTools({ mcp: fakeManager(all), computer: {} });
  for (const tool of all.values()) { let page = tools.discovery.describe({ name: tool.name }); while (!page.complete) page = tools.discovery.describe({ name: tool.name, offset: page.nextOffset, version: page.version }); }
  const wrapped = new AgentWorkers({ base: tools, signal: new AbortController().signal });
  for (const budget of [16000, 32000, 64000]) {
    const catalog = wrapped.catalog({ budget });
    const result = buildPromptDetailed({ request: '驗證工具', catalog, budget }); assert.ok(result.text.length <= budget);
  }
});
test('real paginated MCP server discovers and invokes tool 64 through WorkspaceTools', async t => {
  const manager = new McpManager({ sandbox: { stdio: async config => ({ executable: config.command, args: config.args, env: process.env, cwd: __dirname, cleanup: async () => {} }) } });
  t.after(() => manager.close());
  await manager.connect({ name: 'paged', type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-paged.js')], readOnly: true });
  assert.equal(manager.catalog().length, 75);
  const tools = nativeTools({ mcp: manager }); const match = await tools.execute('search_tools', { query: 'PDF' });
  const selected = match.matches.find(item => item.server === 'paged');
  assert.equal(selected.originalName, 'fixture_64');
  assert.equal((await tools.execute('describe_tool', { name: selected.name })).complete, true);
  const result = await tools.execute(selected.name, { text: 'synthetic' }); assert.equal(result.content[0].text, 'fixture_64:synthetic');
});
test('MCP refresh publishes only complete snapshots and rejects cancellation, stale connections and cursor loops', async () => {
  const manager = new McpManager(), original = { name: 'old', inputSchema: { type: 'object' } };
  const connection = { config: { name: 'fixture', readOnly: true }, tools: [original], client: { listTools: async ({ cursor }) => cursor ? { tools: [{ name: 'new2' }] } : { tools: [{ name: 'new1' }], nextCursor: 'next' } } };
  manager.connections.set('fixture', connection); manager.replaceTools(connection);
  await manager.refresh('fixture'); assert.equal(manager.catalog().length, 2); assert.equal(manager.catalog().some(t => t.originalName === 'old'), false);
  connection.client.listTools = async () => ({ tools: [], nextCursor: 'loop' });
  await assert.rejects(manager.refresh('fixture'), /游標重複/); assert.equal(manager.catalog().length, 2);
  const controller = new AbortController(); controller.abort(); await assert.rejects(manager.refresh('fixture', controller.signal), /已停止/);
  connection.client.listTools = async () => { manager.connections.delete('fixture'); return { tools: [] }; };
  await assert.rejects(manager.refresh('fixture'), /中斷/);
  await assert.rejects(listToolPages({ listTools: async () => ({ tools: [{ name: 'same' }, { name: 'same' }] }) }), /重複/);
  await manager.sandbox.close();
});
test('child discovery remains limited to the original worker allowlist and never changes the parent scope', async () => {
  const { ModelBudget, RequestScheduler } = require('../src/parallel');
  const custom = remote(1), trusted = remote(2, { server: 'exa' });
  const manager = fakeManager(new Map([[custom.name, custom], [trusted.name, trusted]]));
  const base = nativeTools({ mcp: manager }), scheduler = new RequestScheduler(2);
  const workers = new AgentWorkers({ base, scheduler, modelBudget: new ModelBudget(30), signal: new AbortController().signal,
    bridge: { createChannel: async () => ({ close: async () => {} }) }, createTools: () => nativeTools({ mcp: manager }),
    runner: async ({ tools }) => {
      await tools.prepareTools('PDF');
      const result = await tools.execute('search_tools', { query: 'PDF' });
      assert.equal(result.matches.some(item => item.server === 'fixture'), false);
      assert.equal(result.matches.some(item => item.server === 'exa'), true);
      assert.equal((await tools.execute('describe_tool', { name: custom.name })).ok, false);
      await assert.rejects(async () => tools.execute(custom.name, { text: 'x' }), /禁止/);
      return { completed: true };
    } });
  try {
    workers.delegationState({ request: '檢查多個部分的測試與風險', records: [] });
    base.prepareTools('PDF'); assert.equal(base.catalog().some(item => item.name === custom.name), true);
    const child = workers.delegate({ tasks: [{ title: 'Independent discovery', role: 'research', request: 'PDF research' }] });
    await workers.collect(child.tasks.map(task => task.id));
    assert.equal(base.catalog().some(item => item.name === custom.name), true);
  } finally { await workers.close(); scheduler.close(); }
});
test('stale or disconnected tools cannot execute; reloading changed schema permits a real call without a false denial', async () => {
  const tool = remote(1), map = new Map([[tool.name, tool]]), manager = fakeManager(map); let calls = 0;
  manager.call = async () => { calls++; return { ok: true }; };
  const tools = nativeTools({ mcp: manager }); tools.prepareTools('PDF');
  tool.inputSchema.required = ['text', 'format'];
  const stale = await tools.execute(tool.name, { text: 'x' }); assert.equal(stale.needsToolLoad, true); assert.equal(stale.denied, undefined); assert.equal(calls, 0);
  await tools.execute('describe_tool', { name: tool.name });
  assert.equal((await tools.execute(tool.name, { text: 'x', format: 'plain' })).ok, true); assert.equal(calls, 1);
  map.delete(tool.name); await assert.rejects(tools.execute(tool.name, { text: 'x' }), /未知工具/); assert.equal(calls, 1);
});
test('refresh search reaches only explicitly connected allowed servers, validates before networking and respects stop', async () => {
  const target = remote(1), manager = fakeManager(new Map([[target.name, target]])); let refreshes = 0;
  manager.connections.set('fixture', { config: { name: 'fixture' } });
  manager.refresh = async (_name, signal) => { refreshes++; assert.equal(signal.aborted, false); };
  const tools = nativeTools({ mcp: manager });
  assert.equal((await tools.execute('search_tools', { server: 'fixture', query: 'PDF', refresh: true })).ok, true);
  assert.equal((await tools.execute('search_tools', { server: 'unknown', refresh: true })).ok, false);
  assert.equal((await tools.execute('search_tools', { server: 'fixture', refresh: true, query: 'x'.repeat(301) })).ok, false);
  assert.equal(refreshes, 1);
  tools.signal = AbortSignal.abort(); await assert.rejects(tools.execute('search_tools', { server: 'fixture', refresh: true }), /已停止/); assert.equal(refreshes, 1);
});
test('MCP cancellation during listing and alias collisions preserve the previous complete snapshot', async () => {
  const controller = new AbortController();
  await assert.rejects(listToolPages({ listTools: async () => { controller.abort(); return { tools: [{ name: 'late' }] }; } }, controller.signal), /停止/);
  const manager = new McpManager(), old = { name: 'old', inputSchema: {} }, connection = { config: { name: 'fixture' }, tools: [old] };
  manager.replaceTools(connection);
  assert.throws(() => manager.replaceTools(connection, [{ name: 'same' }, { name: 'same' }]), /衝突/);
  assert.equal(manager.catalog()[0].originalName, 'old'); assert.deepEqual(connection.tools, [old]);
  await manager.sandbox.close();
});

test('catalog HTTP 429 stops the model loop immediately without another tool or model request', async () => {
  const manager = fakeManager(new Map()); let calls = 0, modelCalls = 0;
  manager.connections.set('fixture', { config: { name: 'fixture' } });
  manager.refresh = async () => { calls++; throw new Error('MCP HTTP 429 rate limit'); };
  const tools = nativeTools({ mcp: manager });
  await assert.rejects(runAgent({ tools, request: '檢查可用工具', signal: new AbortController().signal,
    bridge: { chat: async () => { modelCalls++; return { text: JSON.stringify({ kind: 'tool', name: 'search_tools', args: { server: 'fixture', refresh: true } }) }; } } }), /429/);
  assert.equal(calls, 1); assert.equal(modelCalls, 1);
});
