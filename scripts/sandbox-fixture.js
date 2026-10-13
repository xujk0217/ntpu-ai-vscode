'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { McpManager } = require('../src/mcp');
const { SandboxExecutor, quote } = require('../src/security/sandbox');
(async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-kernel-')));
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-outside-')));
  const executor = new SandboxExecutor();
  let connections = 0; const server = http.createServer((request, response) => { connections++; response.end('should not be reachable'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await fs.writeFile(path.join(outside, 'private.txt'), 'PRIVATE');
    await fs.writeFile(path.join(root, '.env'), 'SENSITIVE=x');
    await fs.writeFile(path.join(root, 'probe.js'), `const fs=require('fs');let blocked=0;for(const file of [${JSON.stringify(path.join(outside, 'private.txt'))},'.env']){try{fs.readFileSync(file);process.exitCode=1;}catch{blocked++;}}fs.writeFileSync('output.txt','OK');console.log('FILES_BLOCKED='+blocked);require('http').get('http://127.0.0.1:${port}').on('error',()=>console.log('NETWORK_BLOCKED'));`);
    const launch = await executor.prepare(root, root, quote(process.execPath) + ' probe.js');
    const result = await new Promise((resolve, reject) => { const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env }); let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data); child.on('error', reject); child.on('close', code => resolve({ code, output })); });
    await launch.cleanup(); assert.equal(result.code, 0, result.output); assert.match(result.output, /FILES_BLOCKED=2/); assert.match(result.output, /NETWORK_BLOCKED/); assert.equal(connections, 0); assert.equal(await fs.readFile(path.join(root, 'output.txt'), 'utf8'), 'OK');
    await fs.writeFile(path.join(root, 'mcp-server.js'), `const rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:{content:[{type:'text',text:'sandbox:'+m.params.arguments.text}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
    const mcp = new McpManager({ sandbox: executor, workspace: () => root });
    try { await mcp.connect({ name: 'isolated_fixture', type: 'stdio', command: process.execPath, args: ['mcp-server.js'], readOnly: true }); const reply = await mcp.call(mcp.catalog()[0].name, { text: 'OK' }, new AbortController().signal); assert.equal(reply.content[0].text, 'sandbox:OK'); } finally { await mcp.close(); }
    console.log(JSON.stringify({ platform: process.platform, backend: executor.state.label, isolatedRead: true, protectedRead: true, workspaceWrite: true, networkBlocked: true, stdioMcp: true, networkPolicy: 'deny-all' }));
  } finally { await new Promise(resolve => server.close(resolve)); await executor.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
