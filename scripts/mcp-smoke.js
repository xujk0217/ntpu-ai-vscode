'use strict';
const { McpManager, EXA } = require('../src/mcp');
(async () => {
  const manager = new McpManager();
  try {
    const connection = await manager.connect(EXA);
    console.log('CONNECTED_TOOLS: ' + connection.tools.map(tool => tool.name).join(', '));
    const result = await manager.search('site:developer.mozilla.org JavaScript Array reduce', new AbortController().signal);
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (!result.ok || !text) throw new Error('搜尋未傳回可用內容。');
    console.log(text.slice(0, 1000));
    console.log('MCP_SEARCH_OK');
  } finally { await manager.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
