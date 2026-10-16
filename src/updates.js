'use strict';
// Deliberately separate from Agent downloads: no arbitrary sources, credentials or retries.
const https = require('node:https');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const { SaxesParser } = require('saxes');
const { publicTarget } = require('./network');
const REPO = 'xujk0217/ntpu-ai-vscode';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'];
const MAX_PACKAGE = 128 * 1024 * 1024;

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('更新版本格式不正確。');
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('更新版本超出範圍。');
  return parts;
}
function newer(candidate, installed) {
  const a = versionParts(candidate), b = versionParts(installed);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
function trustedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('更新來源不是允許的 GitHub HTTPS 位置。');
  return url;
}
function assetUrl(value, version, name) {
  const expected = `https://github.com/${REPO}/releases/download/v${version}/${name}`;
  if (value !== expected) throw new Error('更新附件位置不符合專案發行版本。');
  return expected;
}
function selectRelease(release, installed, target) {
  if (!TARGETS.includes(target)) throw new Error(`尚不支援此 Extension Host 平台：${target}。`);
  if (release.draft || release.prerelease || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('更新必須是正式發行版本。');
  const version = release.tag_name.slice(1); versionParts(version);
  if (release.html_url !== `https://github.com/${REPO}/releases/tag/v${version}`) throw new Error('更新版本來源不符。');
  if (!newer(version, installed)) return null;
  const name = `ntpu-ai-coder-${target}-${version}.vsix`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matches = assets.filter(asset => asset.name === name), checksums = assets.filter(asset => asset.name === 'SHA256SUMS.txt');
  if (matches.length !== 1 || checksums.length !== 1) throw new Error('新版缺少對應平台套件或 SHA256SUMS.txt，請稍後檢查。');
  const asset = matches[0];
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE || asset.state !== 'uploaded') throw new Error('更新套件大小或上傳狀態不正確。');
  if (asset.digest && !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new Error('GitHub 套件校驗碼格式錯誤。');
  return { version, target, name, size: asset.size, digest: asset.digest?.slice(7),
    url: assetUrl(asset.browser_download_url, version, name), checksumUrl: assetUrl(checksums[0].browser_download_url, version, 'SHA256SUMS.txt') };
}
function checksumFor(body, name) {
  const matches = body.toString('utf8').split(/\r?\n/).filter(line => line.slice(66) === name);
  if (matches.length !== 1 || !/^[a-fA-F0-9]{64} [ *]/.test(matches[0])) throw new Error('找不到唯一且有效的套件 SHA-256 校驗碼。');
  return matches[0].slice(0, 64).toLowerCase();
}

async function githubStream(value, signal, redirects = 0) {
  signal.throwIfAborted();
  if (redirects > 5) throw new Error('更新下載重新導向過多。');
  const url = trustedUrl(value);
  const { address } = await publicTarget(url.href); signal.throwIfAborted();
  const response = await new Promise((resolve, reject) => {
    let deadline;
    const request = https.get(url, { signal, timeout: 30000,
      headers: { 'User-Agent': 'NTPU-AI-Agent-Updater', Accept: '*/*' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => { clearTimeout(deadline); resolve(response); });
    deadline = setTimeout(() => request.destroy(new Error('更新連線逾時。')), 30000); deadline.unref();
    request.on('error', () => { clearTimeout(deadline); reject(new Error(signal.aborted ? '更新已取消。' : '無法連線至 GitHub，請檢查網路或 Proxy 設定。')); });
    request.on('timeout', () => request.destroy(new Error('更新下載逾時。')));
  });
  // Never surface Location/query strings: GitHub redirect URLs can contain signed credentials.
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.destroy(); return githubStream(new URL(response.headers.location, url).href, signal, redirects + 1);
  }
  if (response.statusCode !== 200) { response.destroy(); throw new Error(`GitHub 回應 HTTP ${response.statusCode}；未重試，請稍後手動檢查。`); }
  return response;
}
async function download(value, { signal, maxBytes, file, onProgress = () => {}, openStream = githubStream }) {
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, file ? 15 * 60 * 1000 : 45000); timer.unref();
  let source;
  try {
    trustedUrl(value);
    source = await openStream(value, controller.signal);
    const length = source.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new Error('更新下載超過大小上限。');
    let bytes = 0; const hash = createHash('sha256'), chunks = [];
    const measure = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(new Error('更新下載超過大小上限。'));
      hash.update(chunk); onProgress(bytes); callback(null, chunk);
    } });
    const sink = file ? createWriteStream(file, { flags: 'wx', mode: 0o600 }) : new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    await pipeline(source, measure, sink, { signal: controller.signal });
    if (length && bytes !== Number(length)) throw new Error('更新下載不完整。');
    return { bytes, sha256: hash.digest('hex'), buffer: file ? undefined : Buffer.concat(chunks) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '更新已取消。' : '更新下載超過等待上限，請稍後再試。');
    // Socket/TLS errors can contain full URLs; only our bounded user messages are exposed.
    if (/^(GitHub |更新|無法連線|找不到|尚不支援)/.test(error.message)) throw error;
    throw new Error('更新下載失敗，請檢查網路後再試。');
  } finally { source?.destroy(); clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function validateVsix(file, release, signal) {
  const zip = await yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true });
  const found = new Map(); let count = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      if (++count > 50000) throw new Error('更新套件項目過多。');
      if (!['extension/package.json', 'extension.vsixmanifest'].includes(entry.fileName)) continue;
      if (found.has(entry.fileName) || entry.uncompressedSize > 1024 * 1024 || entry.isEncrypted()) throw new Error('更新套件資訊重複、加密或過大。');
      const stream = await zip.openReadStreamPromise(entry), chunks = []; let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { stream.destroy(); throw new Error('更新套件資訊過大。'); }
        chunks.push(chunk);
      }
      found.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
    }
    const metadata = JSON.parse(found.get('extension/package.json') || 'null');
    let identity; const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw new Error('更新套件不得包含 XML DTD。'); });
    parser.on('opentag', node => {
      if (node.local === 'Identity') {
        if (identity) throw new Error('更新套件有重複身分。');
        identity = Object.fromEntries(Object.values(node.attributes).map(attribute => [attribute.local, attribute.value]));
      }
    });
    parser.write(found.get('extension.vsixmanifest') || '').close();
    if (metadata?.name !== 'ntpu-ai-coder' || metadata.publisher !== 'ntpu-local' || metadata.version !== release.version ||
      identity?.Id !== 'ntpu-ai-coder' || identity.Publisher !== 'ntpu-local' || identity.Version !== release.version || identity.TargetPlatform !== release.target) throw new Error('更新套件身分、版本或平台不符合，已取消安裝。');
  } finally { zip.close(); }
}

class UpdateManager {
  constructor(options) {
    this.options = options; this.transport = options.transport || download; this.validate = options.validate || validateVsix;
    this.state = { current: options.version, target: options.target, phase: 'idle', message: '可從 GitHub Releases 檢查更新。' };
    try {
      const cached = options.storage.get('updates.release');
      if (cached) {
        this.release = selectRelease(cached, options.version, options.target);
        if (this.release) Object.assign(this.state, { latest: this.release.version, phase: 'available', message: `可更新至 ${this.release.version}。` });
      }
    } catch { /* Ignore stale/invalid cache; manual check still works. */ }
  }
  set(patch) { Object.assign(this.state, patch); this.options.onState?.({ ...this.state }); }
  async check({ automatic = false } = {}) {
    if (this.operation || this.state.phase === 'installed' || this.disposed) return;
    if (automatic && (!this.options.autoCheck() || Date.now() - this.options.storage.get('updates.lastCheck', 0) < 24 * 3600000)) return;
    this.operation = this.performCheck(automatic);
    try { return await this.operation; } finally { this.operation = null; }
  }
  async performCheck(automatic) {
    this.controller = new AbortController(); this.set({ phase: 'checking', message: '正在檢查 GitHub 最新正式版本…' });
    try {
      if (!TARGETS.includes(this.options.target)) throw new Error(`尚不支援此 Extension Host 平台：${this.options.target}。`);
      // Count failed attempts too, so an outage/rate limit cannot cause hourly auto retries.
      await this.options.storage.update('updates.lastCheck', Date.now());
      const result = await this.transport(API, { signal: this.controller.signal, maxBytes: 1024 * 1024 });
      const metadata = JSON.parse(result.buffer.toString('utf8'));
      this.release = selectRelease(metadata, this.options.version, this.options.target);
      await this.options.storage.update('updates.release', { tag_name: metadata.tag_name, html_url: metadata.html_url, draft: false, prerelease: false,
        assets: (metadata.assets || []).map(({ name, size, state, digest, browser_download_url }) => ({ name, size, state, digest, browser_download_url })) });
      this.set({ latest: this.release?.version, phase: this.release ? 'available' : 'current', message: this.release ? `可更新至 ${this.release.version}。` : '目前已是最新正式版本。' });
      if (automatic && this.release && this.options.storage.get('updates.notified') !== this.release.version) {
        await this.options.storage.update('updates.notified', this.release.version);
        await this.options.onAvailable?.(this.release.version);
      }
      return this.release;
    } catch (error) { this.release = null; this.set({ phase: 'error', message: safeError(error) }); }
  }
  async install() {
    if (this.operation || this.disposed || this.state.phase === 'installed') return;
    if (!this.release) await this.check();
    if (!this.release) return;
    this.operation = this.performInstall();
    try { return await this.operation; } finally { this.operation = null; }
  }
  async performInstall() {
    let directory, unlock;
    this.controller = new AbortController(); const signal = this.controller.signal, release = this.release;
    try {
      // Lock out task starts before saving/downloading; always release even when persistence fails.
      unlock = this.options.acquire();
      await this.options.save(); signal.throwIfAborted();
      this.set({ phase: 'downloading', message: `正在下載 ${release.version}…`, percent: 0 });
      await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(this.options.directory, 'update-')); await fs.chmod(directory, 0o700);
      const checksums = await this.transport(release.checksumUrl, { signal, maxBytes: 65536 });
      const checksum = checksumFor(checksums.buffer, release.name);
      if (release.digest && release.digest !== checksum) throw new Error('更新校驗碼與 GitHub 不一致。');
      const file = path.join(directory, release.name); let last = -1;
      const result = await this.transport(release.url, { file, signal, maxBytes: Math.min(MAX_PACKAGE, release.size), onProgress: bytes => {
        const percent = Math.min(100, Math.floor(bytes * 100 / release.size));
        if (percent !== last) { last = percent; this.set({ percent, message: `正在下載 ${release.version}：${(bytes / 1048576).toFixed(1)} / ${(release.size / 1048576).toFixed(1)} MB（${percent}%）` }); }
      } });
      if (result.bytes !== release.size || result.sha256 !== checksum) throw new Error('更新下載不完整或 SHA-256 不符，已取消安裝。');
      await this.validate(file, release, signal); signal.throwIfAborted();
      this.set({ phase: 'installing', message: '校驗完成，正在交由 VS Code 安裝…' });
      await this.options.install(file);
      this.set({ phase: 'installed', message: `${release.version} 已安裝，重新載入 VS Code 後生效。` });
      return true;
    } catch (error) { this.set({ phase: 'error', message: safeError(error) }); return false;
    } finally {
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      unlock?.();
    }
  }
  cancel() { if (this.state.phase !== 'installing') this.controller?.abort(); }
  async dispose() { this.disposed = true; this.cancel(); await this.operation; }
}
function safeError(error) {
  if (error?.name === 'AbortError') return '更新已取消。';
  return /^(更新|GitHub |尚不支援|可更新|目前|請先|無法連線|找不到)/.test(error?.message) ? error.message.slice(0, 300) : '更新失敗，請稍後重試或從 GitHub Releases 手動安裝。';
}
module.exports = { UpdateManager, newer, selectRelease, checksumFor, trustedUrl, assetUrl, download, validateVsix, API, TARGETS };
