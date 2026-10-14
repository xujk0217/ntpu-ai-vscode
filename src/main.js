'use strict';
const vscode = require('vscode');
const { AgentApp } = require('./app');
let app;
function activate(context) {
  app = new AgentApp(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('ntpuAI.chat', app, { webviewOptions: { retainContextWhenHidden: true } }));
  const command = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
    try { await handler(); } catch (error) { vscode.window.showErrorMessage('NTPU AI: ' + error.message); }
  }));
  command('ntpuAI.open', () => vscode.commands.executeCommand('workbench.view.extension.ntpuAI'));
  command('ntpuAI.login', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ntpuAI');
    await vscode.commands.executeCommand('ntpuAI.chat.focus');
    await app.login();
  });
  command('ntpuAI.logout', () => app.logout());
  command('ntpuAI.status', () => app.checkConnection());
  command('ntpuAI.testConcurrency', () => app.testConcurrency());
  command('ntpuAI.testFiveConcurrency', () => app.testConcurrency({ focusedFive: true }));
  command('ntpuAI.stop', () => app.stop());
  command('ntpuAI.askSelection', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.ntpuAI');
    await vscode.commands.executeCommand('ntpuAI.chat.focus');
    app.post({ kind: 'prefill', text: '請說明目前選取的程式碼，並指出可改善的地方。' });
  });
}
async function deactivate() { await app?.dispose(); }
module.exports = { activate, deactivate };
