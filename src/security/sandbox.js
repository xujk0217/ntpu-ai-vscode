'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { classifyPath, classifyContent, redact } = require('./guard');

const PROTECTED = ['**/.env', '**/.env.*', '**/.ssh/**', '**/.aws/**', '**/.azure/**', '**/.gcloud/**', '**/.kube/**', '**/.codex/**', '**/.git/**', '**/.local/**', '**/agent-memory/**', '**/browser-profiles/**', '**/Secrets/**', '**/Credentials/**', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/.npmrc', '**/.pypirc', '**/.git-credentials', '**/secrets/**', '**/credentials/**', '**/browser-profile/**', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/id_dsa*', '**/Cookies*', '**/cookies*', '**/Login Data*', '**/service-account*.json', '**/*-service-account.json'];
function cleanEnvironment(parent = process.env) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL']) if (parent[key]) env[key] = parent[key];
  env.OPENSSL_CONF = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return env;
}
function quote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }

class SandboxExecutor {
  constructor(options = {}) { this.options = options; this.sessions = new Set(); this.state = { available: null, label: 'OS 隔離 · 待檢查', network: '禁止網路', error: '' }; }
  async runtime() {
    if (!this.initializing) this.initializing = (async () => {
      if (process.platform === 'win32') throw new Error('Windows OS 沙箱仍待實機驗收，暫時阻止 Shell／stdio MCP；HTTPS MCP 與受控檔案工具仍可使用。');
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || major === 22 && minor < 12) throw new Error('OS 沙箱需要 Node 22.12 以上；請更新 VS Code。指令不會改用一般 Shell。');
      let sdk;
      try { sdk = await import('@anthropic-ai/sandbox-runtime'); } catch { throw new Error('缺少 OS 沙箱執行期，請安裝此平台的完整 VSIX。'); }
      const manager = sdk.SandboxManager;
      const check = await manager.checkDependenciesAsync();
      if (check.errors?.length) throw new Error('OS 沙箱依賴不可用：' + check.errors.join('；'));
      await manager.initialize({ network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
        filesystem: { denyRead: [process.platform === 'win32' ? path.parse(os.homedir()).root : '/'], allowRead: [], allowWrite: [], denyWrite: PROTECTED },
        allowAppleEvents: false, enableWeakerNetworkIsolation: false, enableWeakerNestedSandbox: false }, async () => false, false);
      if (!manager.isSandboxingEnabled() || manager.getMitmCA()) { await manager.reset(); throw new Error('隔離或禁止 TLS 攔截的條件未成立，已停止執行。'); }
      this.state = { available: true, label: process.platform === 'darwin' ? 'macOS Seatbelt' : process.platform === 'linux' ? 'Linux bubblewrap' : 'Windows 隔離帳號／WFP（Alpha）', network: '禁止網路', error: '' };
      return manager;
    })().catch(error => { this.state = { available: false, label: 'OS 隔離不可用', network: '禁止網路', error: redact(error.message) }; this.initializing = null; throw error; });
    return this.initializing;
  }
  async readRoots() {
    const roots = process.platform === 'win32' ? [process.env.SystemRoot || 'C:\\Windows', path.dirname(process.execPath)] :
      ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/lib', '/lib64', '/System/Library', '/System/Volumes/Preboot/Cryptexes/OS/usr/lib', '/System/Volumes/Preboot/Cryptexes/OS/System/Library', '/Library/Apple', '/opt/homebrew/bin', '/opt/homebrew/Cellar', '/opt/homebrew/opt', '/opt/homebrew/lib', '/opt/homebrew/share', '/usr/local/bin', '/usr/local/lib', path.dirname(process.execPath)];
    const prefix = path.dirname(path.dirname(process.execPath));
    if (!['/', '/usr', '/usr/local', '/opt', '/opt/homebrew', os.homedir()].includes(prefix)) roots.push(prefix);
    const result = [];
    for (const root of roots) { try { const stat = await fs.stat(root); if (stat.isDirectory() && root !== os.homedir() && path.dirname(root) !== root) result.push(root, await fs.realpath(root)); } catch {} }
    return [...new Set(result)];
  }
  async boundaries(root, reviewPaths = [], approved = new Set()) {
    const denied = [], started = Date.now(); let count = 0;
    const walk = async (directory, relative = '') => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (++count > 20000 || Date.now() - started > 10000) throw new Error('工作區安全掃描超過上限，指令未執行；請縮小工作區。');
        const file = path.join(directory, entry.name), name = relative ? relative + '/' + entry.name : entry.name;
        const level = classifyPath(name, reviewPaths).level;
        if (entry.isSymbolicLink() || level === 'protected' && entry.name !== 'node_modules' || level === 'review' && !approved.has(name)) { denied.push(file); continue; }
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') await walk(file, name); continue; }
        if (!entry.isFile()) { denied.push(file); continue; }
        const stat = await fs.stat(file);
        if (stat.size > 2 * 1024 * 1024 || /\.(png|jpe?g|webp|gif|pdf|p12|pfx|pem|key)$/i.test(name)) { denied.push(file); continue; }
        const bytes = await fs.readFile(file);
        if (bytes.includes(0) || classifyContent(bytes.toString('utf8')).detected) denied.push(file);
      }
    };
    await walk(root); return denied;
  }
  async prepare(root, cwd, command, signal, { reviewPaths = [], approved = new Set(), readOnly = false, extraEnv = {} } = {}) {
    const manager = await this.runtime(), realRoot = await fs.realpath(root), realCwd = await fs.realpath(cwd);
    const relative = path.relative(realRoot, realCwd); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('沙箱工作目錄超出工作區。');
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-sandbox-'))); await fs.mkdir(path.join(scratch, 'home'), { mode: 0o700 });
    try {
      const denied = await this.boundaries(realRoot, reviewPaths, approved), roots = await this.readRoots();
      const filesystem = { denyRead: [process.platform === 'win32' ? path.parse(realRoot).root : '/', ...PROTECTED, ...denied],
        allowRead: [realRoot, scratch, ...roots], allowWrite: readOnly ? [scratch] : [realRoot, scratch], denyWrite: [...PROTECTED, ...denied] };
      const specification = await manager.wrapWithSandboxArgv(command, undefined, { filesystem }, signal, realCwd, { commandId: randomUUID() });
      if (!specification.argv?.length) throw new Error('OS 沙箱未回傳可用指令。');
      const env = cleanEnvironment();
      for (const [key, value] of Object.entries(specification.env || {})) if (value !== process.env[key]) env[key] = value;
      Object.assign(env, extraEnv, { HOME: path.join(scratch, 'home'), USERPROFILE: path.join(scratch, 'home'), TMPDIR: scratch, TMP: scratch, TEMP: scratch, OPENSSL_CONF: process.platform === 'win32' ? 'NUL' : '/dev/null' });
      const cleanup = async () => { this.sessions.delete(cleanup); await fs.rm(scratch, { recursive: true, force: true }); manager.cleanupAfterCommand(); };
      this.sessions.add(cleanup);
      return { executable: specification.argv[0], args: specification.argv.slice(1), cwd: realCwd, env, shell: false, cleanup,
        info: { backend: this.state.label, network: '禁止網路', restrictedFiles: denied.length } };
    } catch (error) { await fs.rm(scratch, { recursive: true, force: true }); throw error; }
  }
  async stdio(config, root, env = {}) {
    if (!root) throw new Error('stdio MCP 需要本機工作區，並在 OS 沙箱內執行。');
    if (process.platform === 'win32') throw new Error('Windows stdio MCP 沙箱尚需驗收；可使用 HTTPS MCP。沒有改用一般主機程序。');
    return this.prepare(root, root, [config.command, ...(config.args || [])].map(quote).join(' '), undefined, { readOnly: true, extraEnv: env });
  }
  async close() { for (const cleanup of [...this.sessions]) await cleanup().catch(() => {}); if (this.initializing) { const manager = await this.initializing.catch(() => null); await manager?.reset(); this.initializing = null; } }
}
module.exports = { SandboxExecutor, cleanEnvironment, quote, PROTECTED };
