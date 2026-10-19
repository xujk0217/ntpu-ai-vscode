'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { scanner } = require('../src/security/attachments');
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
const mock = { Uri: { file: uri }, window: { onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
  workspace: { isTrusted: true, workspaceFolders: [], registerTextDocumentContentProvider: () => ({ dispose() {} }), getConfiguration: () => ({ get: (key, fallback) => fallback }) } };
let AgentApp;
const original = Module._load;
try { Module._load = function(name, ...args) { return name === 'vscode' ? mock : original.call(this, name, ...args); }; ({ AgentApp } = require('../src/app')); }
finally { Module._load = original; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function environment(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-attachment-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const values = new Map(), memento = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => values.set(key, value) };
  const app = new AgentApp({ subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(directory, 'storage')), workspaceState: memento, globalState: memento, secrets: { get: async () => undefined } });
  await app.ready; const posts = []; app.post = value => posts.push(value);
  const file = path.join(directory, 'fixture.pdf'); await fs.writeFile(file, '%PDF-1.4\nsynthetic fixture');
  mock.window.showOpenDialog = async () => [uri(file)]; mock.window.showWarningMessage = async () => { throw new Error('upload must not show a warning dialog'); };
  const oldScan = scanner.scan; let scans = 0;
  scanner.scan = async () => { scans++; return {}; };
  t.after(async () => { scanner.scan = oldScan; await app.dispose(); });
  return { app, posts, file, scans: () => scans };
}
test('user-selected attachment needs no warning, survives delayed scanning, blocks sending, then exposes only ready metadata', async t => {
  const { app, posts, file } = await environment(t), scanStarted = deferred(), finish = deferred();
  scanner.scan = async () => { scanStarted.resolve(); await finish.promise; };
  const operation = app.attach(); await scanStarted.promise;
  assert.equal(posts.find(p => p.attachmentPreparation)?.attachmentPreparation.stage, '正在準備附件');
  const current = posts.at(-1); assert.equal(current.attachment, null);
  assert.deepEqual(current.attachmentPreparation, { name: 'fixture.pdf', stage: '正在進行本機安全檢查' });
  assert.doesNotMatch(JSON.stringify(current), /synthetic fixture|%PDF|fsPath|buffer/);
  await assert.rejects(app.ask('should wait', false), /附件正在準備/); assert.equal(app.queue.length, 0);
  finish.resolve(); await operation;
  assert.equal(app.attachmentPreparation, null); assert.equal(app.attachment.name, path.basename(file));
  assert.equal(posts.at(-1).attachment.mimeType, 'application/pdf'); assert.equal(posts.at(-1).attachmentPreparation, null);
});
test('oversize, missing file and scan failure remove pending state and never attach unchecked bytes', async t => {
  const { app, file, scans } = await environment(t);
  mock.window.showWarningMessage = async () => { throw new Error('upload must not show a warning dialog'); };
  await fs.truncate(file, 20 * 1024 * 1024 + 1);
  await assert.rejects(app.attach(), /20 MB/); assert.equal(scans(), 0); assert.equal(app.attachmentPreparation, null);
  await fs.writeFile(file, '%PDF-1.4\nfixture'); scanner.scan = async () => { throw new Error('scan rejected'); };
  await assert.rejects(app.attach(), /scan rejected/); assert.equal(app.attachment, null); assert.equal(app.attachmentPreparation, null);
  await fs.rm(file); await assert.rejects(app.attach(), /ENOENT/); assert.equal(app.attachmentPreparation, null);
});
test('removal, chat switch and disposal discard late scanner results; cancel permits another selection', async t => {
  const { app } = await environment(t);
  for (const action of ['remove', 'switch', 'dispose']) {
    const started = deferred(), finish = deferred();
    scanner.scan = async () => { started.resolve(); await finish.promise; };
    const operation = app.attach(); await started.promise;
    if (action === 'remove') {
      await app.handle({ kind: 'removeAttachment' });
      scanner.scan = async () => {};
      await app.attach(); assert.equal(app.attachment.name, 'fixture.pdf');
      finish.resolve(); await operation; assert.equal(app.attachment.name, 'fixture.pdf');
      await app.handle({ kind: 'removeAttachment' }); continue;
    }
    if (action === 'switch') { const other = app.store.create(''); await app.handle({ kind: 'switch', id: other.id }); }
    else await app.dispose();
    finish.resolve(); await operation; assert.equal(app.attachment, null); assert.equal(app.attachmentPreparation, null);
  }
});
test('canceling picker preserves the existing attachment; disposed picker results and update-time selections are ignored', async t => {
  const { app, file, scans } = await environment(t);
  const previous = { name: 'previous.pdf' }; app.attachment = previous;
  mock.window.showOpenDialog = async () => undefined;
  await app.attach(); assert.equal(app.attachment, previous); assert.equal(app.attachmentPicking, false);
  app.updateInstalling = true; mock.window.showOpenDialog = async () => { throw new Error('picker must not open'); };
  await app.attach(); app.updateInstalling = false;
  const finish = deferred(); mock.window.showOpenDialog = async () => finish.promise;
  const operation = app.attach(); await app.dispose(); finish.resolve([uri(file)]); await operation;
  assert.equal(scans(), 0); assert.equal(app.attachment, previous); assert.equal(app.attachmentPreparation, null);
});

test('explicit attachment selection skips review dialog but protected paths and non-attachment review remain enforced', async t => {
  const { app, file, scans } = await environment(t);
  const protectedFile = path.join(path.dirname(file), '.ssh', 'fixture.pdf');
  await fs.mkdir(path.dirname(protectedFile)); await fs.writeFile(protectedFile, '%PDF-1.4');
  mock.window.showOpenDialog = async () => [uri(protectedFile)];
  await assert.rejects(app.attach(), /受保護路徑/); assert.equal(scans(), 0); assert.equal(app.attachment, null);
  let warnings = 0; mock.window.showWarningMessage = async () => { warnings++; return '確認傳送'; };
  await app.approveData('config.local.json', true); assert.equal(warnings, 0);
  await app.approveData('private.csv'); assert.equal(warnings, 1);
  mock.window.showWarningMessage = async () => undefined;
  await assert.rejects(app.approveData('private.csv'), /未批准/);
});
test('all supported user-selected image types and PDF attach without any transfer warning', async t => {
  const { app, file } = await environment(t); const sharp = require('sharp');
  for (const format of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf']) {
    const selected = path.join(path.dirname(file), 'selected.' + format);
    const buffer = format === 'pdf' ? Buffer.from('%PDF-1.4') : await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).toFormat(format === 'jpg' ? 'jpeg' : format).toBuffer();
    await fs.writeFile(selected, buffer); mock.window.showOpenDialog = async () => [uri(selected)];
    await app.attach(); assert.equal(app.attachment.name, 'selected.' + format); assert.equal(app.attachment.approved, true);
  }
});
