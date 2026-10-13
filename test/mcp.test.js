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
