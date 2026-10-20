'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { McpManager, validateServer } = require('../src/mcp');
test('MCP stdio integration discovers and invokes a real local server', async () => {
  const manager = new McpManager({ sandbox: { stdio: async config => ({ executable: config.command, args: config.args, env: process.env, cwd: __dirname, cleanup: async () => {} }) } });
  try {
    await manager.connect({ name: 'fixture', type: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures', 'mcp-stdio.js')], readOnly: true });
    const [tool] = manager.catalog(); assert.match(tool.name, /^mcp_fixture_echo_/);
    const result = await manager.call(tool.name, { text: 'hello' }, new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(result.content[0].text, 'actual:hello');
  } finally { await manager.close(); }
  assert.equal(manager.catalog().length, 0);
});
test('MCP validation requires explicit secure endpoints and valid local commands', () => {
  assert.throws(() => validateServer({ name: 'x', type: 'http', url: 'http://remote.test/mcp' }), /HTTPS/);
  assert.throws(() => validateServer({ name: 'x', type: 'http', url: 'https://user:secret@example.com/mcp' }), /SecretStorage/);
  assert.throws(() => validateServer({ name: 'x', type: 'stdio', command: 'node', args: [1] }));
  assert.equal(validateServer({ name: 'x', type: 'http', url: 'http://localhost:3000/mcp' }).name, 'x');
});

test('official research lookup uses only the fixed AI4X catalog, rejects secrets and respects cancellation', async () => {
  const manager = new McpManager(); let connected=0, called=0;
  manager.connect=async config=>{assert.equal(config.url,'https://ai4x.mcp.ntpu.ai/mcp');connected++;return {tools:[{name:'get_center_info'}]};};
  manager.call=async (name,args)=>{called++;assert.match(name,/mcp_ntpu_ai4x_get_center_info_/);assert.deepEqual(args,{});return {ok:true};};
  assert.equal((await manager.lookup({operation:'get_center_info'},new AbortController().signal)).ok,true);
  await assert.rejects(manager.lookup({operation:'write_private_data'}));
  await assert.rejects(manager.lookup({operation:'get_center_info',parameters:{password:'real-private-password'}}));
  const controller=new AbortController();controller.abort();await assert.rejects(manager.lookup({operation:'get_center_info'},controller.signal));
  assert.equal(connected,1);assert.equal(called,1);await manager.close();
});

test('built-in search supplies live Exa objective schema, forwards cancellation, and fails clearly on unsupported required fields', async () => {
  const { McpManager } = require('../src/mcp'); const manager = new McpManager(); const signal = new AbortController().signal;
  let schema = { properties: { query: {}, objective: {}, numResults: {} }, required: ['query', 'objective'] }, called;
  manager.connect = async (config, requestSignal) => { assert.equal(config.name, 'exa'); assert.equal(requestSignal, signal); return { tools: [{ name: 'web_search_exa', inputSchema: schema }] }; };
  manager.call = async (name, args, requestSignal) => { called = args; assert.equal(requestSignal, signal); return { ok: true }; };
  assert.equal((await manager.search('public SVG documentation', signal)).ok, true); assert.match(called.objective, /primary sources/); assert.equal(called.numResults, 5);
  schema = { properties: { query: {} }, required: ['query'] }; await manager.search('query', signal); assert.deepEqual(called, { query: 'query' });
  schema = { properties: { query: {} }, required: ['query', 'unknownRequired'] }; await assert.rejects(manager.search('query', signal), /介面已變更/);
  await manager.close();
});
