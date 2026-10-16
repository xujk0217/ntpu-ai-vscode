'use strict';
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const server = new Server({ name: 'paged-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async request => {
  const start = Number(request.params?.cursor || 0), end = Math.min(start + 25, 75);
  return { tools: Array.from({ length: end - start }, (_, offset) => ({ name: 'fixture_' + (start + offset),
    description: start + offset === 64 ? 'PDF extraction 回傳完整文件文字' : 'Synthetic capability ' + (start + offset),
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } })), ...(end < 75 ? { nextCursor: String(end) } : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: request.params.name + ':' + request.params.arguments.text }] }));
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; });
