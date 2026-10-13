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
  module.exports.WorkspaceTools = class extends Original { constructor(...args) { args[5] = { ...args[5], sandbox: testSandbox }; super(...args); } };
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
