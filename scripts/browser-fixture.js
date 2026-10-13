'use strict';
// A local website fixture; never logs in to or calls NTPU AI.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { BrowserPreview } = require('../src/browser/preview');
const { BrowserBridge } = require('../src/browser');
const { assets, testUI } = require('./ui-fixture');

const html = `<!doctype html><html><body>
<div id="auth-overlay" class="hidden" style="display:none"></div><span id="user-email">Fixture</span>
<button id="newChatBtn">New</button><span id="newCount">0</span><textarea id="input"></textarea><button id="sendBtn">Send</button>
<input id="fileInput" type="file"><div id="attachPreview"></div>
<script>
document.getElementById('newChatBtn').onclick=()=>{document.getElementById('newCount').textContent=Number(document.getElementById('newCount').textContent)+1};
document.getElementById('fileInput').onchange=async()=>{await fetch('/upload',{method:'POST',body:'fixture'});document.getElementById('attachPreview').innerHTML='<span class="attach-chip-badge">fixture</span>'};
document.getElementById('sendBtn').onclick=async()=>{
 const button=document.getElementById('sendBtn');button.classList.add('stop');
 try{const response=await fetch('/chat/stream',{method:'POST',body:document.getElementById('input').value});await response.text()}catch{}finally{button.classList.remove('stop')}
};
</script></body></html>`;
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-browser-fixture-'));
  const sockets = new Set();
  const ui = await assets();
  const server = http.createServer((request, response) => {
    if (ui.has(request.url)) { const [type, body] = ui.get(request.url); response.writeHead(200, { 'content-type': type }); response.end(body); return; }
    if (request.url === '/upload') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
    if (request.url !== '/chat/stream') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return; }
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      response.write('data: {"type":"judge","model":"fixture"}\n\n');
      const timer = setTimeout(() => {
        response.write('data: {"type":"token","content":"mock-');
        response.end('response"}\n\ndata: {"type":"done"}\n\n');
      }, body.includes('slow') ? 10000 : 40);
      response.on('close', () => clearTimeout(timer));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const options = { attachmentGuard: async attachment => { if (!attachment.approved) throw new Error("Fixture requires approval"); }, origin, storageRoot: directory, headless: process.env.NTPU_FIXTURE_HEADED !== '1', browser: process.env.NTPU_FIXTURE_BROWSER || 'auto' };
  let bridge = new BrowserBridge(options);
  try {
    await bridge.open(); assert.equal((await bridge.status()).ready, true);
    await bridge.page.evaluate(() => { document.cookie = 'fixture_state=synthetic; max-age=3600; path=/'; });
    assert.equal((await bridge.chat('first', { newConversation: true })).text, 'mock-response');
    assert.equal((await bridge.chat('second', { newConversation: false })).text, 'mock-response');
    assert.equal(await bridge.page.locator('#newCount').textContent(), '1');
    const image = { name: 'fixture.png', mimeType: 'image/png', approved: true, buffer: Buffer.from('synthetic fixture bytes') };
    assert.equal((await bridge.chat('attachment', { newConversation: false, attachment: image })).text, 'mock-response');
    const controller = new AbortController();
    const pending = bridge.chat('slow', { newConversation: false, signal: controller.signal });
    const cancel = setTimeout(() => controller.abort(), 150);
    try { await assert.rejects(pending, /已停止/); } finally { clearTimeout(cancel); }
    const selected = bridge.manager.info.label;
    await bridge.close(); bridge = new BrowserBridge(options); await bridge.open();
    assert.equal(await bridge.page.evaluate(() => document.cookie.includes('fixture_state=synthetic')), true);
    let frames = 0; const preview = new BrowserPreview({ bridge: () => bridge, emit: message => { if (message.image) frames++; } });
    try {
      await preview.start(); const size = bridge.page.viewportSize() || await bridge.page.evaluate(() => ({ width: innerWidth, height: innerHeight })); const bounds = await bridge.page.locator('#input').boundingBox();
      await preview.input({ action: 'click', x: (bounds.x + bounds.width / 2) / size.width, y: (bounds.y + bounds.height / 2) / size.height });
      await preview.input({ action: 'text', text: 'PREVIEW_INPUT' });
      assert.match(await bridge.page.locator('#input').inputValue(), /PREVIEW_INPUT/); assert.ok(frames > 0);
    } finally { preview.stop(); }
    await testUI(bridge.page, origin);
    console.log('Local mock website passed: ' + selected + '; streaming, task reuse, upload, cancel, persistent profile, memory/settings UI. No NTPU AI requests.');
  } finally {
    await bridge.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
