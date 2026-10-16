'use strict';
const { validateServer, BUILTINS } = require('./mcp');
const { publicTarget } = require('./network');
const { redact } = require('./security/guard');
// Register only after a real MCP handshake and complete tools/list. A failed
// connection, cancelled request or failed save cannot leave a new usable config.
async function registerMcp(app, server, signal = new AbortController().signal, checkTarget = publicTarget) {
  signal.throwIfAborted(); validateServer(server);
  if (app.servers.some(item => item.name === server.name) || BUILTINS.some(item => item.name === server.name) || app.mcp.connections.has(server.name)) throw new Error('MCP 名稱已存在。');
  await checkTarget(server.url); signal.throwIfAborted();
  const previous = [...app.servers]; let writeAttempted = false;
  try {
    const connection = await app.mcp.connect(server, signal); signal.throwIfAborted();
    if (!connection.tools?.some(tool => tool.inputSchema && typeof tool.inputSchema === 'object')) throw new Error('MCP 未提供有效工具；沒有保存此設定。');
    const next = [...previous, server];
    writeAttempted = true; await app.context.globalState.update('ntpuAI.mcpServers', next);
    signal.throwIfAborted(); app.servers = next; app.capabilities();
    return { connected: true, tools: connection.tools.length };
  } catch (error) {
    await app.mcp.disconnect(server.name);
    if (writeAttempted) {
      try { await app.context.globalState.update('ntpuAI.mcpServers', previous); app.servers = previous; }
      catch { app.servers = [...previous, server]; throw new Error('連線已停止，但 MCP 設定回復保存失敗；請在設定頁移除此項。'); }
    }
    throw new Error(redact(error.message));
  }
}
module.exports = { registerMcp };
