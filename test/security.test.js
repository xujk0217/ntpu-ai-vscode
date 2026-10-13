'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPath, classifyContent, redact, sanitize, inspectOutboundPayload } = require('../src/security/guard');
const { runAgent } = require('../src/agent');
const { McpManager } = require('../src/mcp');

test('central path policy protects Windows and Unix credentials but allows env templates', () => {
  for (const name of ['.env', 'Secrets/data.txt', 'C:\\repo\\.AWS\\credentials', '.npmrc', '.pypirc', '.kube/config', 'service-account-demo.json', 'demo-service-account.json', '.ssh/id_rsa', 'private.PEM'])
    assert.equal(classifyPath(name).level, 'protected', name);
  for (const name of ['.env.example', '.env.sample', '.env.template', 'src/index.ts']) assert.equal(classifyPath(name).level, 'normal');
  assert.equal(classifyPath('data/private.csv').level, 'review');
  assert.equal(classifyPath('src/finance.ts', ['src/finance.*']).level, 'review');
});
test('secret guard preserves useful structure, fake template placeholders and hashes', () => {
  const fake = 'ghp_' + 'A'.repeat(36);
  const text = `PORT=3000\nAPI_KEY=${fake}\nPASSWORD=not-a-real-credential\nBearer only-test-token\nhttps://u:only-test@host/path?access_token=only-test-token\npostgresql://u:only-test@host/db\n-----BEGIN PRIVATE KEY-----\nonly-test\n-----END PRIVATE KEY-----`;
  const clean = redact(text);
  for (const value of [fake, 'not-a-real-credential', 'only-test-token', 'u:only-test', '-----BEGIN PRIVATE KEY-----']) assert.equal(clean.includes(value), false);
  assert.match(clean, /PORT=3000/); assert.equal(redact(clean), clean);
  assert.equal(classifyContent('API_KEY=example-value\nconst id = "a9ed4f1e-c2c4-420a-8bcd-c08a884967ab";').detected, false);
  assert.deepEqual(sanitize({ password: 'only-test', content: [{ text: 'Bearer only-test' }] }), { password: '[REDACTED_SECRET]', content: [{ text: 'Bearer [REDACTED_TOKEN]' }] });
  assert.throws(() => inspectOutboundPayload({ query: text }, { reject: true }), /阻止/);
  assert.equal(sanitize({ nested: { DB_PASSWORD: 'only-test-raw' } }).nested.DB_PASSWORD, '[REDACTED_SECRET]');
  assert.equal(redact('curl --token only-test-cli-key').includes('only-test-cli-key'), false);
  const object = sanitize(JSON.parse('{"__proto__":{"permission":"full"}}'));
  assert.equal(Object.getPrototypeOf(object), Object.prototype); assert.equal({}.permission, undefined);
});
test('actual tool results, context and checkpoints cannot leak secrets even in full access', async () => {
  const fake = 'ghp_' + 'B'.repeat(36), prompts = [], checkpoints = [];
  const replies = [{ kind: 'tool', name: 'read_file', args: { path: 'config.js' } }, { kind: 'final', message: '完成' }];
  await runAgent({ request: '檢查配置', context: `API_KEY=${fake}`, signal: new AbortController().signal,
    profile: { permission: 'full' }, tools: { execute: async () => ({ ok: true, output: `Bearer ${fake}`, structuredContent: { password: 'only-test' } }) },
    bridge: { chat: async prompt => { prompts.push(prompt); return { text: JSON.stringify(replies.shift()) }; } },
    onCheckpoint: records => checkpoints.push(JSON.stringify(records)) });
  assert.equal([...prompts, ...checkpoints].some(text => text.includes(fake) || text.includes('only-test')), false);
});

test('MCP structured and textual results are sanitized, credential arguments never reach transport', async () => {
  let calls = 0;
  const manager = new McpManager(); manager.tools.set('fixture', { server: 'fixture', originalName: 'fixture' });
  manager.connections.set('fixture', { client: { callTool: async () => {
    calls++; return { content: [{ type: 'text', text: 'Bearer only-test-mcp' }], structuredContent: { DB_PASSWORD: 'only-test-password' } };
  } } });
  const result = await manager.call('fixture', { query: 'normal' });
  assert.equal(JSON.stringify(result).includes('only-test'), false);
  await assert.rejects(manager.call('fixture', { query: 'Bearer only-test-key' }), /阻止/); assert.equal(calls, 1);
});

test('cookie headers and structured cookie collections cannot enter prompts or saved memory', () => {
  const payload = { headers: { Cookie: 'sid=only-test-session; other=only-test-other' },
    cookies: [{ name: 'sid', value: 'only-test-cookie', domain: 'example.test' }],
    details: { 'set-cookie': 'sid=only-test-cookie; HttpOnly' } };
  const clean = sanitize(payload);
  assert.equal(JSON.stringify(clean).includes('only-test'), false);
  assert.equal(classifyContent(payload).detected, true);
  assert.throws(() => inspectOutboundPayload(payload, { reject: true }), /阻止/);
  const text = 'Cookie: sid=only-test-session; other=only-test-other\nSet-Cookie: sid=only-test-cookie; HttpOnly\n{"cookie":"sid=only-test-cookie; path=/"}';
  assert.equal(redact(text).includes('only-test'), false);
  assert.equal(redact(redact(text)), redact(text));
  assert.deepEqual(sanitize(clean), clean);
});
