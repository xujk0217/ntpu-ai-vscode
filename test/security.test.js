'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPath, classifyContent, redact, sanitize, inspectOutboundPayload } = require('../src/security/guard');
const { runAgent } = require('../src/agent');

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
