'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { createHash } = require('node:crypto');
const { inspectOutboundPayload, sanitize, redact } = require('./security/guard');

const EXA = { name: 'exa', type: 'http', url: 'https://mcp.exa.ai/mcp', builtin: true, readOnly: true };
function validateServer(config) {
  if (!config || !/^[a-zA-Z0-9_-]{1,48}$/.test(config.name || '')) throw new Error('MCP 名稱必須是 1–48 字的英數字、底線或連字號。');
  if (config.type === 'http' || config.type === 'sse') {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP 需要 HTTP(S) URL，請把驗證資訊存入 SecretStorage。');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('遠端 MCP 必須使用 HTTPS。');
  } else if (config.type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command || !Array.isArray(config.args || []) ||
      (config.args || []).some(argument => typeof argument !== 'string')) throw new Error('stdio MCP 需要 command 與字串 args。');
  } else throw new Error('MCP transport 需要 http、sse 或 stdio。');
  if ((config.args || []).some(argument => /^--?(?:api[-_]?key|token|password|secret|client[-_]?secret)(?:=|$)/i.test(argument)))
    throw new Error('MCP args 不能存放驗證參數；請使用 SecretStorage 的環境變數或 headers。');
  inspectOutboundPayload({ url: config?.url, command: config?.command, args: config?.args }, { reject: true });
  return config;
}
function alias(server, name) {
  const base = `mcp_${server}_${name}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const suffix = createHash('sha256').update(`${server}:${name}`).digest('hex').slice(0, 6);
  return base.slice(0, 54) + '_' + suffix;
}

class McpManager {
  constructor({ secrets, onState = () => {}, onContent = async content => content } = {}) {
    this.secrets = secrets; this.onState = onState; this.onContent = onContent;
    this.connections = new Map(); this.connecting = new Map(); this.tools = new Map(); this.failures = new Map();
  }
  async connect(config) {
    validateServer(config);
    if (this.connections.has(config.name)) return this.connections.get(config.name);
    if (this.connecting.has(config.name)) return this.connecting.get(config.name);
    const work = this._connect(config);
    this.connecting.set(config.name, work);
    this.onState();
    try { return await work; } finally { this.connecting.delete(config.name); this.onState(); }
  }
  async _connect(config) {
    const client = new Client({ name: 'ntpu-ai-coder', version: require('../package.json').version }, { capabilities: {} });
    let transport;
    try {
      const headers = {};
      const secret = config.secretKey && await this.secrets?.get(config.secretKey);
      if (secret) headers[config.authHeader || 'Authorization'] = config.authHeader === 'x-api-key' || /^Bearer\s/i.test(secret) ? secret : `Bearer ${secret}`;
      for (const [header, reference] of Object.entries(config.headerSecrets || {})) {
        if (!/^[a-zA-Z0-9-]+$/.test(header) || /^(cookie|host|connection|content-length)$/i.test(header)) continue;
        const value = await this.secrets?.get(reference); if (value) headers[header] = value;
      }
      if (config.type === 'stdio') {
        const env = {};
        for (const [key, reference] of Object.entries(config.envSecrets || {})) {
          const value = await this.secrets?.get(reference); if (value) env[key] = value;
        }
        transport = new StdioClientTransport({ command: config.command, args: config.args || [], env, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
      } else {
        const Transport = config.type === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
        transport = new Transport(new URL(config.url), { requestInit: { headers } });
      }
      await client.connect(transport, { timeout: 20000 });
      const response = await client.listTools({}, { timeout: 20000 });
      const connection = { client, transport, config, tools: response.tools || [] };
      this.connections.set(config.name, connection); this.failures.delete(config.name);
      for (const tool of connection.tools) {
        const name = alias(config.name, tool.name);
        this.tools.set(name, { name, originalName: tool.name, server: config.name,
          description: String(tool.description || tool.name).slice(0, 500), inputSchema: tool.inputSchema,
          readOnly: config.readOnly === true, external: true });
      }
      this.onState(); return connection;
    } catch (error) {
      await client.close().catch(() => {});
      this.failures.set(config.name, redact(error.message)); this.onState(); throw new Error(redact(error.message));
    }
  }
  catalog() { return [...this.tools.values()]; }
  states() {
    return [...this.connections.values()].map(connection => ({ name: connection.config.name, type: connection.config.type,
      connected: true, tools: connection.tools.length, builtin: connection.config.builtin === true }))
      .concat([...this.failures].map(([name, error]) => ({ name, connected: false, error })),
        [...this.connecting.keys()].filter(name => !this.connections.has(name)).map(name => ({ name, connected: false, connecting: true })));
  }
  async call(name, args, signal) {
    args = inspectOutboundPayload(args, { reject: true });
    const tool = this.tools.get(name);
    if (!tool) throw new Error('此 MCP 工具尚未連線。');
    const connection = this.connections.get(tool.server);
    let result;
    try { result = await connection.client.callTool({ name: tool.originalName, arguments: args }, undefined, { signal, timeout: 60000 }); }
    catch (error) { throw new Error(redact(error.message)); }
    let structuredContent = result.structuredContent;
    if (structuredContent && JSON.stringify(structuredContent).length > 18000) structuredContent = { truncated: true, text: JSON.stringify(structuredContent).slice(0, 18000) };
    return sanitize({ ok: !result.isError, server: tool.server, content: await this.onContent(sanitize(result.content || [])), structuredContent });
  }
  async search(query, signal) {
    const connection = await this.connect(EXA);
    const tool = connection.tools.find(tool => tool.name === 'web_search_exa');
    if (!tool) throw new Error('Exa MCP 沒有提供 web_search_exa。');
    const properties = tool.inputSchema?.properties || {};
    const args = { query };
    if (properties.numResults) args.numResults = 5;
    if (properties.contextMaxCharacters) args.contextMaxCharacters = 12000;
    const name = alias(EXA.name, tool.name);
    return this.call(name, args, signal);
  }
  async disconnect(name) {
    const connection = this.connections.get(name);
    if (connection) await connection.client.close().catch(() => {});
    this.connections.delete(name); this.failures.delete(name);
    for (const [key, tool] of this.tools) if (tool.server === name) this.tools.delete(key);
    this.onState();
  }
  async close() { for (const name of [...this.connections.keys()]) await this.disconnect(name); }
}
module.exports = { McpManager, EXA, validateServer, alias };
