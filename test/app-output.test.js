'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { MemoryStore } = require('../src/memory/store');

test('real AgentApp durably stores, resumes and exports full segmented output without losing local history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-app-output-'));
  const apps = new Set();
  t.after(async () => {
    for (const app of apps) await app.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const uri = file => ({ fsPath: file, scheme: 'file', toString: () => 'file://' + file });
  const config = new Map([['parallel.enabled', false], ['memory.autoUpdate', false], ['maxSteps', 12]]);
  let exportTarget;
  const opened = [];
  const mock = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ConfigurationTarget: { Global: 1 },
    window: {
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      showSaveDialog: async () => exportTarget,
      showTextDocument: async target => opened.push(target),
      showWarningMessage: async (...args) => args.at(-1),
    },
    workspace: {
      isTrusted: true, workspaceFolders: [], textDocuments: [],
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback) => config.get(key) ?? fallback, update: async (key, value) => config.set(key, value) }),
      fs: { writeFile: async (target, bytes) => fs.writeFile(target.fsPath, bytes) },
    },
  };
  const originalLoad = Module._load;
  let AgentApp;
  try {
    Module._load = function(name, ...args) { return name === 'vscode' ? mock : originalLoad.call(this, name, ...args); };
    ({ AgentApp } = require('../src/app'));
  } finally { Module._load = originalLoad; }

  async function make(name) {
    const workspace = path.join(directory, name);
    await fs.mkdir(workspace);
    mock.workspace.workspaceFolders = [{ name, uri: uri(workspace) }];
    const state = new Map(), global = new Map();
    const memento = map => ({ get: (key, fallback) => map.get(key) ?? fallback,
      update: async (key, value) => value === undefined ? map.delete(key) : map.set(key, value) });
    const context = { subscriptions: [], extensionPath: directory, globalStorageUri: uri(path.join(workspace, 'storage')),
      workspaceState: memento(state), globalState: memento(global), secrets: { get: async () => undefined } };
    const app = new AgentApp(context); apps.add(app); await app.ready;
    assert.ok(app.store instanceof MemoryStore);
    app.session.title = '完整文件'; app.session.titleSource = 'manual'; app.session.options.agent = 'ask';
    const history = app.add('user', '舊聊天原文必須保留');
    const previousAnswer = app.add('assistant', '原本回答也保留');
    await app.store.updateProject(app.session.workspace, project => project.entries.push({ id: 'existing-preference', kind: 'preference', text: '使用繁體中文，保留完整文件。' }));
    await app.save();
    return { app, context, workspace, history, previousAnswer,
      disk: async () => JSON.parse(await fs.readFile(app.store.file(app.session.id), 'utf8')).session };
  }
  function attach(app, replies) {
    const calls = [];
    const bridge = {
      page: { isClosed: () => false }, open: async () => {}, status: async () => ({ ready: true }), close: async () => {},
      chat: async (prompt, options) => {
        calls.push({ prompt, options });
        assert.ok(replies.length, 'unexpected additional model request');
        const reply = replies.shift();
        return typeof reply === 'function' ? reply(prompt, options) : { text: JSON.stringify(reply) };
      },
    };
    app.getBridge = () => bridge;
    return { calls, bridge };
  }
  const output = (index, message, done = false) => ({ kind: 'output', id: 'document', index, message, done, ...(done ? { completed: true } : {}) });

  await t.test('each complete segment reaches the real MemoryStore before the next model request', async () => {
    const f = await make('complete');
    const first = '第一部分：完整原文\n'.repeat(1400), second = '第二部分：保留所有細節\n'.repeat(1100);
    const memoryBefore = await f.app.store.project(f.app.session.workspace);
    const { calls } = attach(f.app, [output(1, first), async () => {
      const saved = await f.disk(), task = saved.tasks.at(-1);
      assert.equal(task.outputParts.length, 1);
      assert.equal(task.outputParts[0].message, first);
      assert.equal(task.records.find(record => record.type === 'output_part').message, first);
      assert.equal(saved.checkpoint.records.find(record => record.type === 'output_part').message, first);
      return { text: JSON.stringify(output(2, second, true)) };
    }]);
    await f.app.ask('請完整整理這份調查報告。', false);
    const saved = await f.disk(), task = saved.tasks.at(-1);
    assert.equal(calls.length, 2);
    assert.equal(task.status, 'completed'); assert.equal(saved.checkpoint, null);
    assert.deepEqual(task.outputParts.map(part => part.message), [first, second]);
    assert.equal(task.result, first + second);
    assert.equal(saved.messages.filter(message => message.role === 'assistant').at(-1).text, first + second);
    assert.equal(saved.turns.at(-1).answer, first + second);
    assert.equal(saved.messages.find(message => message.id === f.history.id).text, f.history.text);
    assert.equal(saved.messages.find(message => message.id === f.previousAnswer.id).text, f.previousAnswer.text);
    assert.deepEqual(await f.app.store.project(f.app.session.workspace), memoryBefore);
    assert.equal(saved.messages.some(message => message.name === 'name_session'), false);
  });

  await t.test('cancelled draft survives restart and resume generates only the next incomplete segment', async () => {
    const f = await make('restart');
    const first = '已完成且保存的第一段\n'.repeat(950), draft = '第二段未完成的原文\n'.repeat(900), second = '完整第二段\n'.repeat(1000);
    const { calls } = attach(f.app, [output(1, first), async (_prompt, options) => {
      options.onToken(JSON.stringify(output(2, draft)).slice(0, -1));
      f.app.stop(); throw new Error('已停止');
    }]);
    await f.app.ask('請完整保留文件，不要摘要。', false);
    const interrupted = await f.disk(), task = interrupted.tasks.at(-1);
    assert.equal(calls.length, 2); assert.equal(task.status, 'stopped');
    assert.deepEqual(task.outputParts.map(part => part.message), [first]);
    assert.equal(task.outputDraft.message, draft); assert.equal(task.outputDraft.partial, true);
    assert.equal(interrupted.checkpoint.records.find(record => record.type === 'output_draft').message, draft);
    const message = interrupted.messages.filter(item => item.role === 'assistant' && item.incomplete).at(-1);
    assert.ok(message, 'an interrupted response must remain readable as user-facing incomplete text');
    assert.equal(message.text, first + draft);
    const oldTaskId = task.id, oldSessionId = f.app.session.id;
    const projectBefore = await f.app.store.project(f.app.session.workspace);
    await f.app.dispose(); apps.delete(f.app);
    const reopened = new AgentApp(f.context); apps.add(reopened); await reopened.ready;
    assert.equal(reopened.session.id, oldSessionId);
    assert.equal(reopened.session.checkpoint.records.find(record => record.type === 'output_part').message, first);
    assert.equal(reopened.session.messages.find(item => item.id === message.id).text, first + draft);
    assert.deepEqual(await reopened.store.project(reopened.session.workspace), projectBefore);
    const resumed = attach(reopened, [async prompt => {
      assert.match(prompt, /document/); assert.match(prompt, /nextIndex["\s:]+2/);
      return { text: JSON.stringify(output(2, second, true)) };
    }]);
    await reopened.ask('繼續', false);
    const saved = JSON.parse(await fs.readFile(reopened.store.file(oldSessionId), 'utf8')).session;
    assert.equal(resumed.calls.length, 1);
    assert.equal(saved.checkpoint, null);
    assert.deepEqual(saved.tasks.at(-1).outputParts.map(part => part.index), [1, 2]);
    assert.equal(saved.tasks.at(-1).result, first + second);
    assert.equal(saved.tasks.find(item => item.id === oldTaskId).resolvedBy, saved.tasks.at(-1).id);
    assert.equal(saved.messages.filter(item => item.role === 'assistant').at(-1).text, first + second);
    assert.equal(saved.messages.find(item => item.id === f.history.id).text, f.history.text);
    assert.deepEqual(await reopened.store.project(reopened.session.workspace), projectBefore);
  });

  await t.test('verification after a complete document preserves visible original text when a later tool fails', async () => {
    const { WorkspaceTools } = require('../src/tools');
    const execute = WorkspaceTools.prototype.execute;
    try {
      WorkspaceTools.prototype.execute = async function(name, args) {
        if (name === 'get_capabilities') throw new Error('本機保存失敗：fixture disk full');
        return execute.call(this, name, args);
      };
      for (const recovery of [false, true]) {
        const f = await make(recovery ? 'recovery-preserve' : 'tool-preserve');
        f.app.session.options.agent = 'build';
        const full = '已收到而且不應被後續工具覆蓋的完整文件。\n'.repeat(1000);
        const replies = [
          ...(recovery ? [{ kind: 'tool', name: 'read_file', args: { path: 'missing-evidence.txt' } }] : []),
          output(1, full, true),
          { kind: 'tool', name: 'get_capabilities', args: {} },
        ];
        const { calls } = attach(f.app, replies);
        await f.app.ask('建立完整的調查文件並驗證。', false);
        const saved = await f.disk(), task = saved.tasks.at(-1);
        assert.equal(calls.length, recovery ? 3 : 2);
        assert.equal(task.status, 'failed');
        assert.match(task.result, /本機保存失敗/);
        const preserved = saved.messages.find(message => message.role === 'assistant' && message.text === full);
        assert.ok(preserved, recovery ? 'recovery onStream empty must retain original text' : 'running tool must retain original text');
        assert.equal(preserved.incomplete, true);
        assert.equal(saved.messages.some(message => message.role === 'stream'), false);
        assert.equal(task.outputParts[0].message, full);
        assert.equal(saved.checkpoint.records.find(record => record.type === 'output_part').message, full);
        exportTarget = uri(path.join(f.workspace, 'interrupted-document.md'));
        await f.app.memoryActions.handle({ kind: 'exportSession', id: f.app.session.id });
        const markdown = await fs.readFile(exportTarget.fsPath, 'utf8');
        assert.ok(markdown.includes(full)); assert.match(markdown, /未完成原文/);
      }
    } finally { WorkspaceTools.prototype.execute = execute; }
  });

  await t.test('message and session Markdown exports use full assistant and worker text beyond preview limits', async () => {
    const f = await make('exports');
    const full = '主 Agent 完整文件。\n'.repeat(2400), worker = '子 Agent 完整研究證據。\n'.repeat(2200);
    const assistant = f.app.add('assistant', full);
    const child = f.app.add('tool', '', { name: 'agent_task', result: '短版畫面預覽', workerResult: worker, status: 'done' });
    await f.app.save();
    exportTarget = uri(path.join(f.workspace, 'answer.md'));
    await f.app.exportMessage(assistant.id);
    assert.ok((await fs.readFile(exportTarget.fsPath, 'utf8')).includes(full));
    exportTarget = uri(path.join(f.workspace, 'worker.md'));
    await f.app.exportMessage(child.id);
    const workerMarkdown = await fs.readFile(exportTarget.fsPath, 'utf8');
    assert.ok(workerMarkdown.includes(worker));
    exportTarget = uri(path.join(f.workspace, 'session.md'));
    await f.app.memoryActions.handle({ kind: 'exportSession', id: f.app.session.id });
    const sessionMarkdown = await fs.readFile(exportTarget.fsPath, 'utf8');
    assert.ok(sessionMarkdown.includes(full)); assert.ok(sessionMarkdown.includes(worker));
    assert.ok(sessionMarkdown.includes(f.history.text)); assert.ok(sessionMarkdown.includes(f.previousAnswer.text));
    assert.ok(opened.some(target => target.fsPath === exportTarget.fsPath));
    const invalidTarget = uri(path.join(f.workspace, 'invalid.md')); exportTarget = invalidTarget;
    await assert.rejects(f.app.exportMessage('missing-message'));
    await assert.rejects(fs.stat(invalidTarget.fsPath), { code: 'ENOENT' });
    exportTarget = undefined; await f.app.exportMessage(assistant.id);
    assert.equal((await f.disk()).messages.find(item => item.id === assistant.id).text, full);
  });
});
