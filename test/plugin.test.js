'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PluginBroker } = require('../src/plugin/broker');
const { callBroker } = require('../src/plugin/client');
const { advisory, enablePlugin, exportPlugin } = require('../src/plugin/vscode');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { AdaptiveConcurrency } = require('../src/adaptive-concurrency');
const { RequestRateGate } = require('../src/request-rate');
async function fixture(t, run = async text => ({ text, completed: true })) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-plugin-')); const broker = new PluginBroker({ directory: root, run, status: () => ({ lastKnownReady: true }) });
  await broker.start(); t.after(async () => { await broker.close(); await fs.rm(root, { recursive: true, force: true }); }); return broker;
}
test('broker durably saves exact long output and returns bounded pages without exposing arbitrary files or history', async t => {
  const text = '完整原文🧪\n'.repeat(4000);
  const broker = await fixture(t, async (_prompt, _signal, update) => { await update({ text: text.slice(0, 16000), parts: 1 }); return { text, completed: true, parts: 2 }; });
  const started = await callBroker(broker.connectionFile, { method: 'start', prompt: 'Synthetic advisory request' }); await broker.tail;
  let offset = 0, result = '';
  do { const page = await callBroker(broker.connectionFile, { method: 'read', id: started.id, offset, limit: 7000 }); result += page.text; offset = page.nextOffset; assert.equal(page.complete, true); } while (offset !== null);
  assert.equal(result, text);
  const disk = JSON.parse(await fs.readFile(path.join(broker.instanceDirectory, started.id + '.json'))); assert.equal(disk.result, text);
  await assert.rejects(callBroker(broker.connectionFile, { method: 'read', id: '../private-session' }), /找不到/);
  await assert.rejects(callBroker(broker.connectionFile, { method: 'start', prompt: 'password=private-fixture' }), /秘密/);
  const status = await callBroker(broker.connectionFile, { method: 'status' }); assert.equal(status.advisoryOnly, true); assert.equal(status.lastKnownReady, true);
});
test('broker rejects missing credentials, browser-origin requests, unsafe descriptors and invalid result ranges', async t => {
  const broker = await fixture(t), connection = JSON.parse(await fs.readFile(broker.connectionFile));
  async function request(headers) { return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: connection.port, path: '/rpc', method: 'POST', headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    r.on('error', reject); r.end('{}');
  }); }
  assert.equal(await request({ 'content-type': 'application/json' }), 403);
  assert.equal(await request({ 'content-type': 'application/json', authorization: 'Bearer ' + connection.secret, origin: 'https://example.invalid' }), 403);
  const task = await callBroker(broker.connectionFile, { method: 'start', prompt: 'fixture' }); await broker.tail;
  await assert.rejects(callBroker(broker.connectionFile, { method: 'read', id: task.id, offset: -1 }), /分頁/);
  if (process.platform !== 'win32') { await fs.chmod(broker.connectionFile, 0o644); await assert.rejects(callBroker(broker.connectionFile, { method: 'status' }), /不安全/); await fs.chmod(broker.connectionFile, 0o600); }
});
test('cancellation and bridge shutdown retain partial output and never start cancelled queued jobs', async t => {
  let entered; const running = new Promise(resolve => { entered = resolve; }); let calls = 0;
  const broker = await fixture(t, async (_text, signal, update) => {
    calls++; await update({ text: 'saved partial', parts: 1 }); entered();
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('已停止')), { once: true }); });
  });
  const a = await callBroker(broker.connectionFile, { method: 'start', prompt: 'first' }); await running;
  const b = await callBroker(broker.connectionFile, { method: 'start', prompt: 'second' });
  await callBroker(broker.connectionFile, { method: 'cancel', id: a.id }); await broker.close();
  assert.equal(broker.jobs.get(a.id).status, 'cancelled'); assert.equal(broker.jobs.get(a.id).result, 'saved partial'); assert.equal(broker.jobs.get(b.id).status, 'cancelled'); assert.equal(calls, 1);
  await assert.rejects(fs.access(broker.connectionFile));
});
test('bundled portable MCP server is a real stdio server with task, result and cancellation tools', async t => {
  const broker = await fixture(t, async text => ({ text: 'actual:' + text, completed: true }));
  const bundle = path.join(broker.instanceDirectory, 'server.bundle.cjs');
  await require('esbuild').build({ entryPoints: [path.join(__dirname, '../src/plugin/server.js')], outfile: bundle, bundle: true, platform: 'node', target: 'node20.9' });
  const client = new Client({ name: 'plugin-fixture', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, '--connection', broker.connectionFile], cwd: broker.instanceDirectory, stderr: 'pipe' }));
  const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
  const task = (await client.callTool({ name: 'ntpu_start_task', arguments: { prompt: 'fixture prompt' } })).structuredContent;
  await broker.tail;
  const result = (await client.callTool({ name: 'ntpu_read_result', arguments: { id: task.id } })).structuredContent;
  assert.equal(result.text, 'actual:fixture prompt'); assert.equal(result.complete, true);
});
function appFixture(reply) {
  let modelCalls = 0, closed = 0, approvals = 0;
  const channel = { chat: async () => { modelCalls++; return reply(); }, close: async () => { closed++; } };
  const app = { queue: [], queuePaused: true, adaptive: new AdaptiveConcurrency(), requestRate: new RequestRateGate(10), connection: {}, state() {}, busy() { return !!this.externalController || !!this.controller; },
    gate: { request: async () => { approvals++; return '傳送此請求'; } }, getBridge: () => ({ open: async () => {}, status: async () => ({ ready: true }), createChannel: async () => channel }) };
  const vscode = { workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, value) => value }) } };
  return { app, vscode, counts: () => ({ modelCalls, closed, approvals }) };
}
test('external advisory reuses an owned channel without workspace tools or memory and releases it before unlocking', async () => {
  const f = appFixture(() => ({ text: JSON.stringify({ kind: 'final', message: 'actual advisory result' }) }));
  const result = await advisory(f.app, f.vscode, 'only explicitly supplied prompt', new AbortController().signal, async () => {});
  assert.equal(result.completed, true); assert.equal(result.text, 'actual advisory result'); assert.deepEqual(f.counts(), { modelCalls: 1, closed: 1, approvals: 1 }); assert.equal(f.app.externalController, null); f.app.requestRate.close();
});
test('rejected external advisory and provider limits never bypass approval or retry school requests', async () => {
  const denied = appFixture(() => { throw new Error('should not call'); }); denied.app.gate.request = async () => null;
  await assert.rejects(advisory(denied.app, denied.vscode, 'fixture', new AbortController().signal, async () => {}), /未批准/); assert.equal(denied.counts().modelCalls, 0); denied.app.requestRate.close();
  const limited = appFixture(() => { throw new Error('HTTP 429 rate limit'); });
  await assert.rejects(advisory(limited.app, limited.vscode, 'fixture', new AbortController().signal, async () => {}), /429/); assert.equal(limited.counts().modelCalls, 1); assert.equal(limited.app.adaptive.blocked, true); assert.equal(limited.counts().closed, 1); limited.app.requestRate.close();
});

test('concurrent plugin enable shares one bridge and export contains a usable descriptor path without the capability', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-plugin-export-')); const destination = path.join(root, 'exports'); await fs.mkdir(destination);
  const app = { ready: Promise.resolve(), connection: {}, adaptive: {}, busy: () => false, workspace: () => ({ name: 'Synthetic' }) };
  const context = { globalStorageUri: { scheme: 'file', fsPath: root }, extensionPath: path.join(__dirname, '..') };
  const vscode = { workspace: { isTrusted: true }, env: {}, window: { showOpenDialog: async () => [{ fsPath: destination }], showInformationMessage: async () => {} } };
  t.after(async () => { await app.pluginBroker?.close(); await fs.rm(root, { recursive: true, force: true }); });
  const [a,b] = await Promise.all([enablePlugin(app, context, vscode),enablePlugin(app, context, vscode)]); assert.equal(a,b);
  // Export bundles are generated in normal builds. Use our own isolated template to
  // prove export's configuration without requiring a pre-existing ignored bundle.
  const template = path.join(root, 'template'); await fs.mkdir(path.join(template, 'plugins/ntpu-ai'), {recursive:true});
  await fs.writeFile(path.join(template, 'plugins/ntpu-ai/plugin.json'), '{}'); context.extensionPath = template;
  const exported = await exportPlugin(app,context,vscode); const config = await fs.readFile(path.join(exported,'mcp-client.json'),'utf8');
  assert.ok(config.includes(JSON.stringify(a.connectionFile).slice(1,-1))); assert.ok(!config.includes(a.secret));
  assert.equal(JSON.parse(config).mcpServers['ntpu-ai'].args[1],'--connection');
  assert.equal(JSON.parse(await fs.readFile(path.join(exported,'mcp.json'),'utf8')).$schema,'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  await assert.rejects(exportPlugin(app,context,vscode), /EEXIST/);
});
test('failed durable writes do not report completed external results', async t => {
  const broker = await fixture(t); const task = await broker.dispatch({ method: 'start', prompt: 'fixture' });
  broker.save = async () => { throw new Error('synthetic disk unavailable'); }; await broker.tail;
  const status = await broker.dispatch({method:'get',id:task.id}); assert.equal(status.status,'failed'); assert.match(status.error,/保存失敗/);
});
