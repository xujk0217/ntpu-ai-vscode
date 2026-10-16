'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { PluginBroker } = require('./broker');
const { runAgent } = require('../agent');
const { RequestScheduler, ModelBudget } = require('../parallel');
const { taskStepLimit } = require('../task-budget');
const { isServiceLimit } = require('../parallel-policy');
async function advisory(app, vscode, prompt, signal, update) {
  if (app.busy() || app.gate.pending || app.queue.length || app.attachmentPreparation || app.agentSettingsBusy || app.loginOperation || app.adaptive.blocked) throw new Error('VS Code 主任務、核准、登入或服務限制尚未處理；未傳送外部請求。');
  if (!vscode.workspace.isTrusted) throw new Error('請先信任本機工作區。');
  app.externalController = { signal }; app.progress = '等待確認外部 Agent 請求'; app.state();
  let channel, scheduler; const parts = []; let text = '';
  try {
    const accepted = await app.gate.request({ title: '外部 Agent 請求使用 NTPU AI', detail: prompt + '\n\n只傳送上述文字；不讀目前聊天、檔案、Project Memory，不執行本機工具。', accept: '傳送此請求' }, signal);
    if (accepted !== '傳送此請求') throw new Error('使用者未批准外部請求。');
    if (signal.aborted) throw new Error('已停止');
    const bridge = app.getBridge(); await bridge.open();
    if (!(await bridge.status()).ready || bridge.mode === 'login') throw new Error('請先在 VS Code 人工完成學校登入。');
    channel = await bridge.createChannel();
    scheduler = new RequestScheduler(1, error => { if (isServiceLimit(error)) app.adaptive.block(error); }, { rateGate: app.requestRate, adaptive: app.adaptive });
    const config = vscode.workspace.getConfiguration('ntpuAI');
    const modelBudget = new ModelBudget(taskStepLimit(config.get('maxSteps', 100), 'standard'));
    const result = await runAgent({ bridge: scheduler.bridge(channel), tools: { catalog: () => [], execute: async () => { throw new Error('外部諮詢不提供本機工具。'); } },
      request: prompt, profile: { agent: 'ask', depth: 'standard' }, context: '', workspace: 'external advisory; no local workspace access', signal, modelBudget,
      maxSteps: modelBudget.limit, timeoutMs: config.get('responseTimeoutSeconds', 240) * 1000,
      onOutputPart: async part => { if (part.partial) await update({ text: parts.join('') + part.message, parts: parts.length }); else { parts.push(part.message); await update({ text: parts.join(''), parts: parts.length }); } },
      onActivity: value => { app.progress = '外部 Agent · ' + value; app.state(); }, onFinal: value => { text = value; } });
    return { text, completed: result.completed, parts: parts.length };
  } catch (error) { if (isServiceLimit(error)) app.adaptive.block(error); throw error; }
  finally {
    try { await channel?.close(); } finally { scheduler?.close(); app.externalController = null; app.progress = '就緒'; app.state(); if (!app.disposed && !app.queuePaused) void app.runQueued().catch(error => app.notice(error.message, 'error')); }
  }
}
async function enablePlugin(app, context, vscode) {
  if (app.pluginBroker && !app.pluginBroker.closed) return app.pluginBroker;
  if (app.pluginEnableOperation) return app.pluginEnableOperation;
  const operation = (async () => {
    await app.ready;
    if (app.disposed) throw new Error('VS Code 正在關閉。');
    if (!vscode.workspace.isTrusted || context.globalStorageUri.scheme !== 'file' || vscode.env?.remoteName) throw new Error('外部 Agent 橋接需要受信任的本機 VS Code。');
    const broker = new PluginBroker({ directory: path.join(context.globalStorageUri.fsPath, 'plugin-bridges'),
      status: () => ({ lastKnownReady: !!app.connection.ready, busy: app.busy(), serviceBlocked: app.adaptive.blocked, workspace: app.workspace()?.name || '' }),
      run: (prompt, signal, update) => advisory(app, vscode, prompt, signal, update) });
    await broker.start();
    if (app.disposed) { await broker.close(); throw new Error('VS Code 正在關閉。'); }
    app.pluginBroker = broker; return broker;
  })();
  app.pluginEnableOperation = operation;
  try { return await operation; } finally { if (app.pluginEnableOperation === operation) app.pluginEnableOperation = null; }
}
async function exportPlugin(app, context, vscode) {
  const broker = await enablePlugin(app, context, vscode);
  const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: '選擇 NTPU plugin 匯出位置（供本機 Agent 使用）' });
  if (!selected?.length) return;
  const target = path.join(selected[0].fsPath, 'ntpu-ai-plugin');
  await fs.mkdir(target, { recursive: false, mode: 0o700 });
  await fs.cp(path.join(context.extensionPath, 'plugins', 'ntpu-ai'), target, { recursive: true, force: false });
  const config = { mcpServers: { 'ntpu-ai': { type: 'stdio', command: 'node', args: [path.join(target, 'server.bundle.cjs'), '--connection', broker.connectionFile] } } };
  await fs.writeFile(path.join(target, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', ...config }, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(target, 'mcp-client.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await vscode.window.showInformationMessage('NTPU plugin 已匯出至：' + target + '；其他 MCP 主機可使用 mcp-client.json，VS Code 關閉後橋接會停止。');
  return target;
}
module.exports = { advisory, enablePlugin, exportPlugin };
