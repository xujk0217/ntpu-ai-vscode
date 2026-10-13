'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright-core');
const { redact } = require('../security/guard');
const LABELS = { chrome: 'Google Chrome', edge: 'Microsoft Edge', chromium: 'Chromium', custom: '自訂 Chromium 瀏覽器' };

function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'NTPU AI Agent');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'NTPU AI Agent');
  return p.join(env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : p.join(home, '.local', 'share'), 'ntpu-ai-agent');
}
function executablePaths(id, platform, env, home) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    const app = { chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome', edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', chromium: 'Chromium.app/Contents/MacOS/Chromium' }[id];
    return app ? [p.join('/Applications', app), p.join(home, 'Applications', app)] : [];
  }
  if (platform === 'win32') {
    const suffix = { chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'], edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], chromium: ['Chromium', 'Application', 'chrome.exe'] }[id];
    return suffix ? [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean))].map(root => p.join(root, ...suffix)) : [];
  }
  const names = { chrome: ['google-chrome', 'google-chrome-stable'], edge: ['microsoft-edge', 'microsoft-edge-stable'], chromium: ['chromium', 'chromium-browser'] }[id] || [];
  return [...new Set(['/usr/bin', '/usr/local/bin', '/snap/bin', ...(env.PATH || '').split(':')].filter(p.isAbsolute))].flatMap(root => names.map(name => p.join(root, name)));
}
function defaultId(value) {
  value = String(value).toLowerCase();
  if (/chromehtml|google[.-]?chrome|com\.google\.chrome/.test(value)) return 'chrome';
  if (/msedge|microsoft[.-]?edge|com\.microsoft\.edgemac/.test(value)) return 'edge';
  if (/chromium/.test(value)) return 'chromium';
  return null;
}
async function realLocation(location) {
  let current = path.resolve(location), suffix = [];
  while (true) {
    try { return path.join(await fs.realpath(current), ...suffix.reverse()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(current); if (parent === current) throw error; suffix.push(path.basename(current)); current = parent; }
  }
}
class BrowserManager {
  constructor(options = {}) {
    this.options = options; this.platform = options.platform || process.platform; this.arch = options.arch || process.arch;
    this.env = options.env || process.env; this.home = options.home || os.homedir(); this.p = this.platform === 'win32' ? path.win32 : path.posix;
    this.engine = options.engine || chromium; this.run = options.run || promisify(execFile);
    this.exists = options.exists || (async file => { try { await fs.access(file, this.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; } });
    this.resolve = options.resolve || realLocation; this.info = null;
    this.prepareProfile = options.prepareProfile || (async profile => { await fs.mkdir(profile, { recursive: true, mode: 0o700 }); if (this.platform !== 'win32') await fs.chmod(profile, 0o700); });
  }
  async systemDefault() {
    try {
      const opts = { timeout: 3000, maxBuffer: 256000, windowsHide: true };
      if (this.platform === 'win32') return defaultId((await this.run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], opts)).stdout);
      if (this.platform === 'linux') return defaultId((await this.run('xdg-settings', ['get', 'default-web-browser'], opts)).stdout);
      if (this.platform === 'darwin') {
        const result = await this.run('plutil', ['-convert', 'json', '-o', '-', this.p.join(this.home, 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist')], opts);
        const handlers = JSON.parse(result.stdout).LSHandlers || [];
        const handler = handlers.find(item => item.LSHandlerURLScheme === 'https') || handlers.find(item => item.LSHandlerURLScheme === 'http');
        return defaultId(handler?.LSHandlerRoleAll);
      }
    } catch {}
    return null;
  }
  async candidates(selection = 'auto', customPath = '') {
    if (!['auto', ...Object.keys(LABELS)].includes(selection)) throw new Error('不支援的 Browser 設定。');
    if (selection === 'custom') {
      if (!this.p.isAbsolute(customPath) || !await this.exists(customPath)) throw new Error('Custom Browser Path 必須是可執行的 Chromium 瀏覽器絕對路徑。');
      return [{ id: 'custom', label: LABELS.custom, executablePath: customPath }];
    }
    const preferred = selection === 'auto' ? await this.systemDefault() : null;
    const ids = selection === 'auto' ? [...new Set([preferred, 'chrome', 'edge', 'chromium'].filter(Boolean))] : [selection];
    const results = [];
    for (const id of ids) {
      const choices = executablePaths(id, this.platform, this.env, this.home);
      if (id === 'chromium') { try { choices.push(this.engine.executablePath()); } catch {} }
      for (const executablePath of choices) if (await this.exists(executablePath)) { results.push({ id, label: LABELS[id], executablePath, preferred: id === preferred }); break; }
    }
    return results;
  }
  normalProfiles() {
    const p = this.p;
    if (this.platform === 'win32') return ['Google/Chrome/User Data', 'Microsoft/Edge/User Data', 'Chromium/User Data'].map(name => p.join(this.env.LOCALAPPDATA || p.join(this.home, 'AppData/Local'), name));
    if (this.platform === 'darwin') return ['Google/Chrome', 'Microsoft Edge', 'Chromium'].map(name => p.join(this.home, 'Library/Application Support', name));
    return ['google-chrome', 'microsoft-edge', 'chromium'].map(name => p.join(this.env.XDG_CONFIG_HOME || p.join(this.home, '.config'), name));
  }
  async profile(candidate) {
    const p = this.p;
    const root = this.options.profileRoot || p.join(this.options.storageRoot || dataDirectory(this.platform, this.env, this.home), 'browser-profiles');
    if (!p.isAbsolute(root)) throw new Error('Browser Profile Location 必須是絕對路徑。');
    const resolved = await this.resolve(root);
    const suffix = candidate.id === 'custom' ? '-' + createHash('sha256').update(candidate.executablePath).digest('hex').slice(0, 12) : '';
    const full = await this.resolve(p.join(resolved, candidate.id + suffix));
    const normal = await Promise.all(this.normalProfiles().map(value => this.resolve(value)));
    const boundaries = [...normal, ...await Promise.all((this.options.workspaces || []).map(value => this.resolve(p.resolve(value)))),
      ...(this.options.storageRoot ? [await this.resolve(p.join(this.options.storageRoot, 'agent-memory'))] : [])];
    const overlaps = (a, b) => {
      if (this.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
      const rel = p.relative(a, b); return rel === '' || (!rel.startsWith('..' + p.sep) && rel !== '..' && !p.isAbsolute(rel));
    };
    if ([p.parse(resolved).root, await this.resolve(this.home)].some(value => overlaps(resolved, value)) || boundaries.some(value => overlaps(value, full) || overlaps(full, value)))
      throw new Error('Profile 必須是獨立的私人資料夾，不能使用日常瀏覽器 Profile、家目錄或專案目錄。');
    return full;
  }
  async launch({ selection = 'auto', customPath = '', headless = false } = {}) {
    if (!['win32', 'darwin', 'linux'].includes(this.platform) || !(['x64'].includes(this.arch) || this.platform === 'darwin' && this.arch === 'arm64')) throw new Error('目前支援 Windows x64、macOS x64／arm64、Linux x64。');
    if (this.options.remote || this.env.WSL_DISTRO_NAME) throw new Error('Extension Host 位於遠端／WSL，無法假設可啟動使用者桌面瀏覽器。請在本機 VS Code 使用本機工作區；歷史仍可離線瀏覽。');
    if (this.platform === 'linux' && !headless && !this.env.DISPLAY && !this.env.WAYLAND_DISPLAY) throw new Error('Linux 沒有圖形顯示環境（DISPLAY／WAYLAND_DISPLAY）。請使用本機桌面 VS Code。');
    const candidates = await this.candidates(selection, customPath);
    if (!candidates.length) throw new Error('未找到已安裝的受支援瀏覽器。請安裝 Chrome／Edge／Chromium，或設定 Custom Browser Path。');
    const failures = [];
    for (const candidate of candidates) {
      let context;
      try {
        const profile = await this.profile(candidate);
        await this.prepareProfile(profile);
        context = await this.engine.launchPersistentContext(profile, { executablePath: candidate.executablePath, headless, chromiumSandbox: true, viewport: null,
          args: ['--no-first-run', '--no-default-browser-check'] });
        const page = context.pages()[0] || await context.newPage();
        const agent = await page.evaluate(() => navigator.userAgent);
        if (!/Chrome|Chromium|Edg/.test(agent)) throw new Error('瀏覽器不是可支援的 Chromium 引擎。');
        this.info = { browser: candidate.id, label: candidate.label, profile, controlled: true,
          selection, message: selection === 'auto' ? (candidate.preferred ? '已控制受支援的系統預設瀏覽器：' : '預設瀏覽器不支援或不可用，已選擇：') + candidate.label : '已由 Playwright 控制：' + candidate.label };
        return { context, page, info: this.info };
      } catch (error) { await context?.close().catch(() => {}); failures.push(candidate.label + '：' + redact(error.message).split('\n')[0].slice(0, 450)); }
    }
    throw new Error('瀏覽器自動化啟動失敗。請關閉其他使用相同專用 profile 的視窗，或改選另一個已安裝瀏覽器。\n' + failures.join('\n'));
  }
}
module.exports = { BrowserManager, dataDirectory, executablePaths, defaultId, realLocation, LABELS };
