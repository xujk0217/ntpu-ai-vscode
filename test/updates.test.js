'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { UpdateManager, newer, selectRelease, checksumFor, trustedUrl, validateVsix, download, TARGETS, API } = require('../src/updates');
const { Readable } = require('node:stream');
const { createUpdater } = require('../src/updates-vscode');
const version = '0.6.15', target = 'darwin-arm64', name = `ntpu-ai-coder-${target}-${version}.vsix`;
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
function metadata(buffer, platform = target) {
  const filename = `ntpu-ai-coder-${platform}-${version}.vsix`;
  return { tag_name: 'v' + version, html_url: `https://github.com/xujk0217/ntpu-ai-vscode/releases/tag/v${version}`, assets: [
    { name: filename, size: buffer.length, digest: 'sha256:' + sha(buffer), state: 'uploaded', browser_download_url: `https://github.com/xujk0217/ntpu-ai-vscode/releases/download/v${version}/${filename}` },
    { name: 'SHA256SUMS.txt', browser_download_url: `https://github.com/xujk0217/ntpu-ai-vscode/releases/download/v${version}/SHA256SUMS.txt` },
  ] };
}
// Small stored ZIP fixture, no external zipper/tool or platform-dependent commands.
function zip(entries) {
  const files = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const filename = Buffer.from(name), data = Buffer.from(content), local = Buffer.alloc(30), directory = Buffer.alloc(46);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    files.push(local, filename, data); central.push(directory, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
function packageEntries(overrides = {}) {
  return [['extension/package.json', JSON.stringify({ name: 'ntpu-ai-coder', publisher: 'ntpu-local', version, ...overrides })],
    ['extension.vsixmanifest', `<PackageManifest><Metadata><Identity Id="ntpu-ai-coder" Publisher="ntpu-local" Version="${version}" TargetPlatform="${target}"/></Metadata></PackageManifest>`]];
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-updates-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const buffer = zip(packageEntries()), release = metadata(buffer), map = new Map(), events = [], calls = [], installs = [];
  let locked = false;
  const transport = async (url, options) => {
    calls.push(url); options.signal.throwIfAborted();
    if (url === API) return { buffer: Buffer.from(JSON.stringify(release)) };
    if (url.endsWith('SHA256SUMS.txt')) return { buffer: Buffer.from(sha(buffer) + '  ' + name + '\n') };
    await fs.writeFile(options.file, buffer, { flag: 'wx' }); options.onProgress(buffer.length);
    return { bytes: buffer.length, sha256: sha(buffer) };
  };
  const storage = { get: (key, fallback) => map.has(key) ? map.get(key) : fallback, update: async (key, value) => map.set(key, value) };
  const options = { version: '0.6.14', target, directory, storage, autoCheck: () => true, transport,
    acquire: () => { assert.equal(locked, false); locked = true; return () => { locked = false; }; },
    save: async () => events.push('save'), install: async file => { assert.equal(locked, true); installs.push(file); events.push('install'); },
    onState: state => events.push(state.phase), ...overrides };
  return { manager: new UpdateManager(options), directory, buffer, release, map, calls, installs, events, storage, options, locked: () => locked };
}

test('stable version comparison rejects prereleases, malformed versions and downgrades', () => {
  assert.equal(newer('0.6.15', '0.6.14'), true); assert.equal(newer('0.6.9', '0.6.14'), false);
  assert.equal(newer('0.6.14', '0.6.14'), false); assert.equal(newer('1.0.0', '0.99.99'), true);
  for (const value of ['v0.6.15', '0.6.15-beta', '0.06.15', '99999999999999999999.0.0']) assert.throws(() => newer(value, '0.6.14'));
});
test('all four targets require exact release, asset path, size, upload state and checksums', () => {
  for (const platform of TARGETS) assert.equal(selectRelease(metadata(Buffer.from('test'), platform), '0.6.14', platform).target, platform);
  const good = metadata(Buffer.from('test'));
  for (const mutate of [r => { r.prerelease = true; }, r => { r.draft = true; }, r => { r.html_url += 'evil'; },
    r => { r.assets[0].browser_download_url += '?url=evil'; }, r => { r.assets[0].size = 0; }, r => { r.assets[0].size = 129 * 1024 * 1024; },
    r => { r.assets[0].state = 'new'; }, r => { r.assets[0].digest = 'md5:invalid'; }, r => { r.assets.pop(); }, r => { r.assets.push(r.assets[0]); }]) {
    const broken = structuredClone(good); mutate(broken); assert.throws(() => selectRelease(broken, '0.6.14', target));
  }
  assert.throws(() => selectRelease(good, '0.6.14', 'linux-arm64'));
  assert.equal(selectRelease(good, version, target), null);
});
test('only exact GitHub HTTPS redirect hosts are trusted', () => {
  for (const url of ['https://github.com/a', 'https://api.github.com/a', 'https://release-assets.githubusercontent.com/a']) assert.ok(trustedUrl(url));
  for (const url of ['http://github.com/a', 'https://github.com.evil.test/a', 'https://localhost/a', 'https://user@github.com/a', 'https://github.com:8443/a', 'file:///tmp/a']) assert.throws(() => trustedUrl(url));
});
test('checksum parser requires a single exact asset filename', () => {
  const digest = 'a'.repeat(64); assert.equal(checksumFor(Buffer.from(`${digest}  ${name}\r\n`), name), digest);
  for (const body of ['', `${digest}  other.vsix`, `${digest}  ${name}\n${digest}  ${name}`, `bad  ${name}`]) assert.throws(() => checksumFor(Buffer.from(body), name));
});
test('download pipeline bounds declared/actual bytes, detects truncation, hashes and respects cancellation', async t => {
  const { directory } = await fixture(t), file = path.join(directory, 'download.vsix');
  const openStream = async () => Object.assign(Readable.from([Buffer.from('abc'), Buffer.from('def')]), { headers: { 'content-length': '6' } });
  const options = { signal: new AbortController().signal, maxBytes: 6, openStream };
  const result = await download(API, { ...options, file }); assert.equal(result.bytes, 6); assert.equal(result.sha256, sha(Buffer.from('abcdef')));
  assert.equal((await fs.readFile(file)).toString(), 'abcdef');
  await assert.rejects(download(API, { ...options, maxBytes: 5 }), /大小/);
  await assert.rejects(download(API, { ...options, openStream: async () => Object.assign(Readable.from([Buffer.alloc(7)]), { headers: {} }) }), /大小/);
  await assert.rejects(download(API, { ...options, openStream: async () => Object.assign(Readable.from([Buffer.alloc(2)]), { headers: { 'content-length': '6' } }) }), /不完整/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(download(API, { ...options, signal: controller.signal, openStream: async (_url, signal) => { signal.throwIfAborted(); } }), /取消/);
});
test('real ZIP reader accepts identity and rejects wrong publisher, target, duplicate or missing manifest', async t => {
  const { directory } = await fixture(t), file = path.join(directory, 'test.vsix');
  await fs.writeFile(file, zip(packageEntries())); await validateVsix(file, { version, target });
  const bad = [packageEntries({ publisher: 'someone' }), packageEntries({ name: 'another-extension' }), packageEntries({ version: '9.9.9' }),
    packageEntries().slice(0, 1), [...packageEntries(), packageEntries()[0]],
    packageEntries().map(([name, text]) => [name, text.replace('darwin-arm64', 'linux-x64')])];
  for (const entries of bad) { await fs.writeFile(file, zip(entries)); await assert.rejects(validateVsix(file, { version, target })); }
  await fs.writeFile(file, 'not a zip'); await assert.rejects(validateVsix(file, { version, target }));
});
test('check never installs; explicit install saves first, validates real VSIX and cleans private files', async t => {
  const f = await fixture(t); await f.manager.check(); assert.equal(f.manager.state.phase, 'available'); assert.equal(f.installs.length, 0);
  assert.equal(await f.manager.install(), true); assert.equal(f.manager.state.phase, 'installed');
  assert.ok(f.events.indexOf('save') < f.events.indexOf('install')); assert.equal(f.installs.length, 1); assert.equal(f.locked(), false);
  assert.deepEqual(await fs.readdir(f.directory), []); await f.manager.install(); assert.equal(f.installs.length, 1);
});
test('auto check respects optout, throttle, caches available release across reload and never installs', async t => {
  const f = await fixture(t, { autoCheck: () => false }); await f.manager.check({ automatic: true }); assert.equal(f.calls.length, 0);
  await f.manager.check(); assert.equal(f.calls.length, 1);
  const restored = new UpdateManager({ ...f.options, autoCheck: () => true }); assert.equal(restored.state.latest, version);
  await restored.check({ automatic: true }); assert.equal(f.calls.length, 1);
  await restored.check(); assert.equal(f.calls.length, 2); assert.equal(f.installs.length, 0);
  assert.equal(new UpdateManager({ ...f.options, version }).state.latest, undefined);
});
test('coalesces simultaneous checks and installs', async t => {
  const f = await fixture(t); await Promise.all([f.manager.check(), f.manager.check()]); assert.equal(f.calls.length, 1);
  await Promise.all([f.manager.install(), f.manager.install()]); assert.equal(f.installs.length, 1);
});
test('failed automatic check is also throttled for 24 hours; manual check remains available', async t => {
  let attempts = 0;
  const f = await fixture(t, { transport: async () => { attempts++; throw new Error('GitHub 回應 HTTP 429。'); } });
  await f.manager.check({ automatic: true }); await f.manager.check({ automatic: true }); assert.equal(attempts, 1);
  await f.manager.check(); assert.equal(attempts, 2);
});
test('busy work and failed save prevent installer and release maintenance lock', async t => {
  for (const overrides of [{ acquire: () => { throw new Error('請先完成任務。'); } }, { save: async () => { throw new Error('disk full'); } }]) {
    const f = await fixture(t, overrides); await f.manager.check(); await f.manager.install();
    assert.equal(f.manager.state.phase, 'error'); assert.equal(f.installs.length, 0); assert.equal(f.locked(), false);
    assert.equal(f.calls.length, 1);
  }
});
test('checksum corruption, partial download, install error all clean files and preserve current version', async t => {
  for (const kind of ['checksum', 'partial', 'install']) {
    const f = await fixture(t); await f.manager.check(); const original = f.manager.transport;
    f.manager.transport = async (url, options) => { const result = await original(url, options);
      if (options.file && kind === 'checksum') result.sha256 = 'b'.repeat(64);
      if (options.file && kind === 'partial') result.bytes--;
      return result;
    };
    if (kind === 'install') f.manager.options.install = async () => { throw new Error('installer error'); };
    assert.equal(await f.manager.install(), false); assert.equal(f.manager.state.phase, 'error');
    assert.equal(f.manager.state.current, '0.6.14'); assert.deepEqual(await fs.readdir(f.directory), []); assert.equal(f.locked(), false);
  }
});
test('cancellation and disposal abort download without invoking installer', async t => {
  const f = await fixture(t); await f.manager.check();
  let started; const downloading = new Promise(resolve => { started = resolve; });
  f.manager.transport = (_url, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); });
  const operation = f.manager.install(); await downloading; f.manager.cancel(); await operation;
  assert.equal(f.installs.length, 0); assert.match(f.manager.state.message, /取消/); assert.equal(f.locked(), false); assert.deepEqual(await fs.readdir(f.directory), []);
  await f.manager.dispose(); await f.manager.check();
});
test('HTTP 429/network check failure does not retry, install or expose signed URLs', async t => {
  const f = await fixture(t, { transport: async () => { throw new Error('GitHub 回應 HTTP 429；未重試。'); } });
  await f.manager.check(); assert.match(f.manager.state.message, /429/); assert.equal(f.installs.length, 0);
  f.manager.transport = async () => { throw new Error('request https://github.com/secret?token=private'); };
  await f.manager.check(); assert.doesNotMatch(f.manager.state.message, /private|token/);
});
test('VS Code adapter blocks every active state, saves before native install and gates reload', async t => {
  const storage = new Map(), disposables = [], commands = [], config = new Map();
  const app = { gate: {}, changeReview: {}, memoryActions: {}, queue: [], ready: Promise.resolve(), busy() { return !!(this.controller || this.updateInstalling); }, state() {}, save: async () => commands.push('saved') };
  const vscode = { ConfigurationTarget: { Global: 1 }, Uri: { file: file => ({ fsPath: file }) }, commands: { executeCommand: async (...args) => commands.push(args) },
    window: { showInformationMessage: async () => undefined }, workspace: { getConfiguration: () => ({ get: (key, fallback) => config.get(key) ?? fallback, update: async (key, value) => config.set(key, value) }) } };
  const { directory } = await fixture(t);
  const context = { extension: { packageJSON: { version: '0.6.14' } }, globalStorageUri: { fsPath: directory }, subscriptions: disposables,
    globalState: { get: (key, fallback) => storage.get(key) ?? fallback, update: async (key, value) => storage.set(key, value) } };
  const updater = createUpdater(app, context, vscode); app.updates = updater; t.after(async () => { for (const item of disposables) item.dispose(); await updater.dispose(); });
  for (const [object, key, value] of [[app, 'controller', {}], [app.gate, 'pending', {}], [app, 'agentSettingsBusy', true], [app.changeReview, 'applying', true],
    [app, 'attachmentPicking', true], [app, 'attachmentPreparation', {}], [app.memoryActions, 'managingSessions', true], [app, 'queue', [{}]], [app, 'queueTransactions', new Set([1])], [app, 'loginOperation', Promise.resolve()]]) {
    const old = object[key]; object[key] = value; assert.throws(() => updater.options.acquire(), /請先/); object[key] = old;
  }
  const unlock = updater.options.acquire(); assert.equal(app.busy(), true); unlock(); assert.equal(app.busy(), false);
  await updater.reload(); assert.equal(commands.length, 0);
  updater.state.phase = 'installed'; await updater.reload(); assert.equal(commands[0], 'saved'); assert.equal(commands[1][0], 'workbench.action.reloadWindow');
  await updater.setAutoCheck(false); assert.equal(config.get('updates.autoCheck'), false); await updater.setAutoCheck('true'); assert.equal(config.get('updates.autoCheck'), false);
  await updater.options.install('/tmp/example.vsix'); assert.equal(commands.at(-1)[0], 'workbench.extensions.installExtension'); assert.deepEqual(commands.at(-1)[1], { fsPath: '/tmp/example.vsix' });
});
