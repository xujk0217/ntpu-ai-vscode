'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { PermissionPolicy } = require('../src/permissions');

const testSandbox = { prepare: async (root, cwd, command) => ({ executable: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', args: process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], cwd, env: process.env, cleanup: async () => {}, info: { backend: 'explicit test adapter' } }) };
function loadTools(mock) {
  const filename = path.join(__dirname, '..', 'src', 'tools.js');
  const module = new Module(filename); module.filename = filename; module.paths = Module._nodeModulePaths(path.dirname(filename));
  module.require = name => name === 'vscode' ? mock : Module.prototype.require.call(module, name);
  module._compile(fsSync.readFileSync(filename, 'utf8'), filename); const Original = module.exports.WorkspaceTools;
  module.exports.WorkspaceTools = class extends Original { constructor(...args) { args[5] = { ...args[5], sandbox: args[5]?.sandbox || testSandbox }; super(...args); } };
  return module.exports;
}
function mockVscode() {
  class Edit {
    constructor() { this.actions = []; }
    createFile(uri) { this.actions.push({ type: 'create', uri }); }
    insert(uri, position, text) { this.actions.push({ type: 'text', uri, text }); }
    replace(uri, range, text) { this.actions.push({ type: 'text', uri, text }); }
  }
  const documents = new Map();
  const mock = { Uri: { file: file => ({ fsPath: file, toString: () => file }), from: value => ({ ...value, toString: () => JSON.stringify(value) }) },
    WorkspaceEdit: Edit, Position: class {}, Range: class {}, commands: { executeCommand: async () => {} },
    workspace: { isTrusted: true, textDocuments: [], openTextDocument: async uri => {
      if (!documents.has(uri.fsPath)) {
        let text = await fs.readFile(uri.fsPath, 'utf8');
        documents.set(uri.fsPath, { uri, getText: () => text, positionAt: index => ({ offset: index }),
          replace: value => { text = value; }, save: async () => { await fs.writeFile(uri.fsPath, text); return true; } });
      }
      return documents.get(uri.fsPath);
    }, applyEdit: async edit => {
      for (const action of edit.actions) {
        if (action.type === 'create') await fs.writeFile(action.uri.fsPath, '', { flag: 'wx' });
        else { const document = await mock.workspace.openTextDocument(action.uri); document.replace(action.text); }
      }
      return true;
    } } };
  return mock;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-execution-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.js'), 'const first = 1;\nconst second = 2;\nconst third = 3;\n');
  return root;
}
test('assisted mode applies a precise edit to read lines while preserving unseen content', async t => {
  const root = await fixture(t); let approvals = 0; const changes = [];
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {},
    async () => { approvals++; return undefined; }, { policy: new PermissionPolicy({ mode: 'assisted' }), onChange: change => changes.push(change) });
  assert.equal((await tools.execute('read_file', { path: 'main.js', start_line: 1, end_line: 1 })).ok, true);
  const result = await tools.execute('edit_file', { path: 'main.js', old_text: 'const first = 1;', new_text: 'const first = 10;' });
  assert.equal(result.saved, true); assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'const first = 10;\nconst second = 2;\nconst third = 3;\n');
  assert.equal(changes.length, 1);
});
test('read-only agents deny actual write execution even under full access', async t => {
  const root = await fixture(t); const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {},
    async () => { throw new Error('approval should not be requested'); }, { policy: new PermissionPolicy({ mode: 'full', agent: 'plan' }) });
  const result = await tools.execute('write_file', { path: 'created.js', content: 'x' });
  assert.equal(result.denied, true); await assert.rejects(fs.access(path.join(root, 'created.js')));
});
test('a user change during review prevents an approved write from overwriting new contents', async t => {
  const root = await fixture(t); const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async () => {
    await fs.writeFile(path.join(root, 'main.js'), 'user changed this\n'); return '套用並儲存';
  });
  await tools.execute('read_file', { path: 'main.js' });
  const result = await tools.execute('write_file', { path: 'main.js', content: 'agent proposal\n' });
  assert.equal(result.ok, false); assert.match(result.error, /預覽期間/);
  assert.equal(await fs.readFile(path.join(root, 'main.js'), 'utf8'), 'user changed this\n');
});

test('an actual basic command runs without approval and streams real output', async t => {
  const root = await fixture(t), outputs = []; let approvals = 0;
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {},
    async () => { approvals++; return undefined; }, { onCommandOutput: output => outputs.push(output) });
  const result = await tools.execute('run_command', { command: process.platform === 'win32' ? 'cd' : 'pwd' });
  assert.equal(result.ok, true); assert.equal(result.exit_code, 0); assert.equal(approvals, 0);
  assert.equal(await fs.realpath(result.output.trim()), await fs.realpath(root)); assert.ok(outputs.length); assert.match(result.approval, /唯讀/);
});
test('a custom command rule runs an actual process while explicit false requests approval', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'task.js'), 'console.log("ACTUAL_COMMAND_OK");');
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode()); let approvals = 0;
  const policy = new PermissionPolicy({ terminal: { rules: { 'node task.js': true } } });
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {},
    async () => { approvals++; return undefined; }, { policy });
  assert.match((await tools.execute('run_command', { command: 'node task.js' })).output, /ACTUAL_COMMAND_OK/);
  assert.equal(approvals, 0); policy.terminal.rules['node task.js'] = false;
  assert.equal((await tools.execute('run_command', { command: 'node task.js' })).denied, true); assert.equal(approvals, 1);
});

test('real terminal output is sanitized before model results and live history receive it', async t => {
  const root = await fixture(t), output = [];
  await fs.writeFile(path.join(root, 'secret-output.js'), 'console.log("Bearer only-test-token"); console.log("API_KEY=only-test-key");');
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async () => undefined,
    { policy: new PermissionPolicy({ mode: 'full' }), onCommandOutput: value => output.push(value) });
  const result = await tools.execute('run_command', { command: 'node secret-output.js' });
  assert.equal(result.ok, true); assert.equal(JSON.stringify([result, output]).includes('only-test-token'), false);
  assert.equal(JSON.stringify([result, output]).includes('only-test-key'), false);
});

test('search hides secrets and Review files still require consent under full access', async t => {
  const root = await fixture(t); const mock = mockVscode();
  await fs.writeFile(path.join(root, 'config.js'), 'API_KEY=only-test-search');
  await fs.writeFile(path.join(root, 'private.csv'), 'API_KEY=only-test-private');
  mock.RelativePattern = class {};
  mock.workspace.findFiles = async () => ['config.js', 'private.csv', '.env'].map(name => mock.Uri.file(path.join(root, name)));
  const { WorkspaceTools, PreviewProvider } = loadTools(mock);
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async () => undefined,
    { policy: new PermissionPolicy({ mode: 'full' }) });
  const result = await tools.execute('search_text', { query: 'API_KEY' });
  assert.equal(result.matches.length, 1); assert.equal(JSON.stringify(result).includes('only-test'), false);
  assert.equal((await tools.execute('read_file', { path: 'private.csv' })).ok, false);
});

test('isolation failure never falls back to an ordinary command even in full access', async t => {
  const root = await fixture(t); const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => detail.accept, { policy: new PermissionPolicy({ mode: 'full' }), sandbox: { prepare: async () => { throw new Error('ISOLATION_FAILED'); } } });
  const result = await tools.execute('run_command', { command: 'echo unsafe > should-not-exist.txt' });
  assert.equal(result.ok, false); assert.match(result.error, /ISOLATION_FAILED/); await assert.rejects(fs.access(path.join(root, 'should-not-exist.txt')));
});

test('download saves bounded public bytes only after approval and never overwrites an existing file', async t => {
  const root = await fixture(t), changes = []; let approvals = 0;
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => {
    approvals++; assert.equal(detail.title, '確認下載公開檔案'); return '確認下載公開檔案' === detail.title ? '允許這次操作' : undefined;
  }, { policy: new PermissionPolicy({ mode: 'ask' }), fetchPublic: async () => ({ url: 'https://example.com/file.bin', mime: 'application/octet-stream', body: Buffer.from([0, 1, 2, 255]) }), onChange: change => changes.push(change) });
  const result = await tools.execute('download_file', { url: 'https://example.com/file.bin', path: 'downloads/file.bin' });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.executed, false); assert.equal(approvals, 1);
  assert.deepEqual(await fs.readFile(path.join(root, 'downloads/file.bin')), Buffer.from([0, 1, 2, 255]));
  assert.equal(changes[0].binary, true); assert.equal(changes[0].mimeType, 'application/octet-stream');
  const duplicate = await tools.execute('download_file', { url: 'https://example.com/file.bin', path: 'downloads/file.bin' });
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已存在/); assert.equal(approvals, 1);
});

test('skill install validates frontmatter, asks for approval, writes only a new workspace skill and reloads it', async t => {
  const root = await fixture(t), changes = [], approvals = [];
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const { SkillCatalog } = require('../src/skills');
  const skills = new SkillCatalog(path.join(root, 'builtin'));
  await skills.discover(root);
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => { approvals.push(detail); return detail.accept; },
    { policy: new PermissionPolicy({ mode: 'full' }), skills, onChange: change => changes.push(change) });
  const content = '---\nname: web-research\ndescription: Search and cite public sources.\n---\nUse public search tools and cite sources.';
  const result = await tools.execute('install_skill', { name: 'web-research', content });
  assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(approvals.length, 1);
  assert.equal(skills.load('web-research').body, 'Use public search tools and cite sources.');
  assert.equal(changes[0].path, '.agents/skills/web-research/SKILL.md');
  const duplicate = await tools.execute('install_skill', { name: 'web-research', content });
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /同名 skill 已存在/);
});

test('agent can connect only a named configured MCP and connection requires approval', async t => {
  const root = await fixture(t); let connected = 0;
  const manager = { connections: new Map(), catalog: () => [{ name: 'mcp_fixture_echo_abcd12', originalName: 'echo', server: 'fixture', description: 'echo', inputSchema: {} }] };
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => detail.accept,
    { policy: new PermissionPolicy({ mode: 'full' }), mcp: manager, servers: [{ name: 'fixture', type: 'http', url: 'https://example.com/mcp' }],
      connectMcp: async () => { connected++; } });
  const result = await tools.execute('connect_mcp', { name: 'fixture' });
  assert.equal(result.ok, true); assert.equal(connected, 1); assert.equal(result.tools[0].originalName, 'echo');
  const unknown = await tools.execute('connect_mcp', { name: 'not-configured' });
  assert.equal(unknown.ok, false); assert.match(unknown.error, /尚未設定/);
});

test('agent can propose a public HTTPS MCP only after host validation and explicit approval', async t => {
  const root = await fixture(t); let connected = null, approvals = 0; const available = [];
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => {
    approvals++; assert.match(detail.detail, /公開 HTTPS endpoint/); return detail.accept;
  }, { policy: new PermissionPolicy({ mode: 'full' }), mcp: { catalog: () => available, connections: new Map() }, servers: [], builtins: [],
    publicTarget: async value => ({ url: new URL(value), address: { address: '93.184.216.34', family: 4 } }),
    addMcp: async config => { connected = config; available.push({ name: 'mcp_new_research_search_abc123', originalName: 'search', server: config.name, description: 'search', inputSchema: {} }); } });
  const result = await tools.execute('add_mcp', { name: 'new-research', url: 'https://research.example/mcp' });
  assert.equal(result.ok, true); assert.equal(approvals, 1); assert.equal(connected.agentAdded, true); assert.equal(connected.readOnly, false);
  assert.equal(result.tools[0].originalName, 'search');
});

test('disabling workspace web access removes and blocks downloads and URL-based skill installs', async t => {
  const root = await fixture(t); let fetches = 0;
  const { WorkspaceTools, PreviewProvider } = loadTools(mockVscode());
  const { SkillCatalog } = require('../src/skills'); const skills = new SkillCatalog(path.join(root, 'builtin')); await skills.discover(root);
  const tools = new WorkspaceTools({ fsPath: root }, new PreviewProvider(), new AbortController().signal, () => {}, async detail => detail.accept,
    { skills, web: false, fetchPublic: async () => { fetches++; throw new Error('unexpected fetch'); } });
  assert.equal(tools.catalog().some(tool => tool.name === 'download_file'), false);
  const download = await tools.execute('download_file', { url: 'https://example.com/file.bin', path: 'file.bin' });
  const install = await tools.execute('install_skill', { name: 'remote-skill', url: 'https://example.com/SKILL.md' });
  assert.equal(download.denied, true); assert.equal(install.denied, true); assert.equal(fetches, 0);
});
