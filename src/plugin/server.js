'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { callBroker } = require('./client');
function createServer(file) {
  const server = new McpServer({ name: 'ntpu-ai', version: require('../../package.json').version });
  const register = (name, description, inputSchema, method) => server.registerTool(name, { description, inputSchema }, async (args, extra) => {
    try { const result = await callBroker(file, { method, ...args }, extra.signal); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  register('ntpu_status', 'Check the enabled local VS Code NTPU advisory bridge. Does not expose browser credentials or local chat history.', {}, 'status');
  register('ntpu_start_task', 'Submit explicitly supplied non-sensitive text for NTPU analysis. Requires approval in VS Code. No workspace tools or inherited chat memory. Returns an asynchronous task ID.', { prompt: z.string().min(1).max(20000) }, 'start');
  register('ntpu_task_status', 'Read status and saved result length for a task created by this bridge.', { id: z.string().uuid() }, 'get');
  register('ntpu_read_result', 'Read exact saved result pages, without summarization. Follow nextOffset; completed indicates the whole task finished.', { id: z.string().uuid(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(10000).optional() }, 'read');
  register('ntpu_cancel_task', 'Cancel only the specified external task; keeps saved result parts and does not stop unrelated VS Code tasks.', { id: z.string().uuid() }, 'cancel');
  return server;
}
if (require.main === module) {
  const i = process.argv.indexOf('--connection'); const file = i >= 0 ? process.argv[i + 1] : process.env.NTPU_BRIDGE_FILE;
  createServer(file).connect(new StdioServerTransport()).catch(() => { process.stderr.write('NTPU MCP stdio 啟動失敗。\n'); process.exitCode = 1; });
}
module.exports = { createServer };
