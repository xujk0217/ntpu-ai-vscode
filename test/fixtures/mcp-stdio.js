'use strict';
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo a fixture string', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: 'actual:' + text }] }));
server.connect(new StdioServerTransport()).catch(() => { process.exitCode = 1; });
