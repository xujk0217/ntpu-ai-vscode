'use strict';
const path = require('node:path');
const { UpdateManager } = require('./updates');

function createUpdater(app, context, vscode) {
  const config = () => vscode.workspace.getConfiguration('ntpuAI');
  const acquire = () => {
    if (app.busy() || app.gate.pending || app.agentSettingsBusy || app.changeReview.applying || app.memoryActions?.managingSessions ||
        app.attachmentPicking || app.attachmentPreparation || app.queue.length || app.queueTransactions?.size || app.loginOperation || app.connection?.connecting) throw new Error('請先完成或停止任務、處理核准與排隊留言，並完成登入及附件準備後再更新。');
    app.updateInstalling = true; app.state();
    return () => { app.updateInstalling = false; app.state(); };
  };
  const updater = new UpdateManager({
    version: context.extension.packageJSON.version, target: process.platform + '-' + process.arch,
    directory: path.join(context.globalStorageUri.fsPath, 'updates'), storage: context.globalState,
    autoCheck: () => config().get('updates.autoCheck', true), acquire,
    save: async () => { await app.ready; clearTimeout(app.saveTimer); await app.save(); },
    install: file => vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file)),
    onState: () => app.state(),
    onAvailable: version => {
      void vscode.window.showInformationMessage(`NTPU AI Agent ${version} 已推出。`, '更新').then(choice => {
        if (choice === '更新') return updater.install();
      }).catch(error => { void vscode.window.showErrorMessage('NTPU AI Agent：' + error.message); });
    },
  });
  updater.reload = async () => {
    if (updater.state.phase !== 'installed') return;
    const unlock = acquire();
    try { await app.ready; clearTimeout(app.saveTimer); await app.save(); await vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    finally { unlock(); }
  };
  const install = updater.install.bind(updater);
  updater.install = async () => {
    const installed = await install();
    if (installed) {
      const choice = await vscode.window.showInformationMessage(`NTPU AI Agent ${updater.state.latest} 已安裝。`, '重新載入');
      if (choice === '重新載入') await updater.reload();
    } else if (installed === false && !/取消/.test(updater.state.message)) {
      await vscode.window.showErrorMessage('NTPU AI Agent：' + updater.state.message);
    }
    return installed;
  };
  updater.setAutoCheck = async value => {
    if (typeof value !== 'boolean') return;
    await config().update('updates.autoCheck', value, vscode.ConfigurationTarget.Global); app.state();
  };
  updater.autoCheckEnabled = () => config().get('updates.autoCheck', true);
  const timer = setTimeout(() => { void updater.check({ automatic: true }); }, 15000); timer.unref();
  const interval = setInterval(() => { void updater.check({ automatic: true }); }, 3600000); interval.unref();
  context.subscriptions.push({ dispose() { clearTimeout(timer); clearInterval(interval); } });
  return updater;
}
module.exports = { createUpdater };
