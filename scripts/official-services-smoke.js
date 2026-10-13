'use strict';
const { McpManager, AI4X, alias } = require('../src/mcp');
const { sanitize, redact } = require('../src/security/guard');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const manager = new McpManager();
  try {
    const connection = await manager.connect(AI4X);
    const tools = connection.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    const queries = await Promise.all(['get_center_info', 'search_services'].filter(name => tools.some(tool => tool.name === name)).map(async name => ({ name,
      result: await manager.call(alias(AI4X.name, name), name === 'search_services' ? { limit: 3 } : {}, new AbortController().signal) })));
    console.log(JSON.stringify(sanitize({ connected: true, endpoint: AI4X.url, toolNames: tools.map(tool => tool.name), queries }), null, 2).slice(0, 5000));
    const directory = path.join(__dirname, '..', '.local'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'official-services.json'), JSON.stringify(sanitize({ timestamp: new Date().toISOString(), endpoint: AI4X.url, connected: true, tools, queries }), null, 2), { mode: 0o600 });
  } finally { await manager.close(); }
})().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
