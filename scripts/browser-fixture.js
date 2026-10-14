'use strict';
// A local website fixture; never logs in to or calls NTPU AI.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { BrowserBridge } = require('../src/browser');
const { probeConcurrency } = require('../src/browser/concurrency-probe');
const { assets, testUI } = require('./ui-fixture');

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="auth-overlay" class="hidden" style="display:none"></div><span id="user-email">Fixture</span>
<button id="newChatBtn">New</button><span id="newCount">0</span><textarea id="input"></textarea><button id="sendBtn">Send</button>
<input id="fileInput" type="file"><div id="attachPreview"></div>
<div id="history"><button class="conv-del-btn" data-del-sid="unrelated">Existing conversation</button></div>
<script>
let sid = 'initial';
function stored(){return JSON.parse(localStorage.getItem('fixture-conversations')||'[]')}
function refresh(){for(const id of stored())addConversation(id)}
window.addEventListener('focus',refresh);
function addConversation(id){if(document.querySelector('[data-del-sid="'+id+'"]'))return;const button=document.createElement('button');button.className='conv-del-btn';button.dataset.delSid=id;button.textContent='Delete';button.onclick=async()=>{if(!confirm('確定要刪除此對話？刪除後無法復原。'))return;const response=await fetch('/reset?session_id='+encodeURIComponent(id),{method:'POST'});if(response.ok){localStorage.setItem('fixture-conversations',JSON.stringify(stored().filter(s=>s!==id)));button.remove()}};document.getElementById('history').append(button)}
refresh();
document.getElementById('newChatBtn').onclick=()=>{sid=crypto.randomUUID();document.getElementById('newCount').textContent=Number(document.getElementById('newCount').textContent)+1};
document.getElementById('fileInput').onchange=async()=>{await fetch('/upload',{method:'POST',body:'fixture'});document.getElementById('attachPreview').innerHTML='<span class="attach-chip-badge">fixture</span>'};
document.getElementById('sendBtn').onclick=async()=>{
 const button=document.getElementById('sendBtn');button.classList.add('stop');
 try{localStorage.setItem('fixture-conversations',JSON.stringify([...new Set([...stored(),sid])]));addConversation(sid);const response=await fetch('/chat/stream',{method:'POST',body:JSON.stringify({session_id:sid,message:document.getElementById('input').value})});await response.text()}catch{}finally{button.classList.remove('stop')}
};
</script></body></html>`;
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-browser-fixture-'));
  const sockets = new Set();
  const ui = await assets();
  let requiresLogin = false;
  const pairStreams = [];
  let activeStreams = 0, peakStreams = 0; const deletedIds = []; let failReset = false;
  const loginHtml = '<!doctype html><html><body><div id="auth-overlay">Fixture login</div><form action="/fixture-login" method="post"><input id="fixture-user" name="user"><button id="fixture-submit">Login</button></form></body></html>';
  const server = http.createServer((request, response) => {
    if (request.url === '/fixture-login') { response.writeHead(303, { location: '/', 'set-cookie': 'fixture_session=synthetic; HttpOnly; SameSite=Lax; Path=/' }); response.end(); return; }
    if (requiresLogin && !request.headers.cookie?.includes('fixture_session=synthetic')) { response.writeHead(200, { 'content-type': 'text/html' }); response.end(loginHtml); return; }
    if (ui.has(request.url)) { const [type, body] = ui.get(request.url); response.writeHead(200, { 'content-type': type }); response.end(body); return; }
    if (request.url.startsWith('/reset?')) { const id = new URL(request.url, 'http://fixture').searchParams.get('session_id'); if (!failReset) deletedIds.push(id); response.writeHead(failReset ? 503 : 200); response.end('{}'); return; }
    if (request.url === '/upload') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
    if (request.url !== '/chat/stream') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return; }
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      body = JSON.parse(body).message;
      activeStreams++; peakStreams = Math.max(peakStreams, activeStreams);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      response.write('data: {"type":"judge","model":"fixture"}\n\n');
      const marker = body.match(/NTPU_PARALLEL_[a-f0-9]+_[0-4]/)?.[0];
      const prefix = marker ? marker + '-' : body.startsWith('parallel-') ? body + '-' : 'mock-';
      response.write('data: ' + JSON.stringify({ type: 'token', content: prefix }) + '\n\n');
      const finish = () => { if (!response.destroyed) response.end('data: {"type":"token","content":"response"}\n\ndata: {"type":"done"}\n\n'); };
      const pair = ['parallel-A', 'parallel-B'].includes(body);
      const timer = setTimeout(finish, body.includes('slow') ? 10000 : pair ? 10000 : marker || body.startsWith('parallel-') ? 800 : 40);
      // The localhost pair test needs a deterministic rendezvous. Browser UI
      // scheduling on a busy CI runner can exceed an arbitrary 800 ms stream.
      if (pair) {
        pairStreams.push({ response, finish, timer });
        if (pairStreams.length === 2) setTimeout(() => { for (const stream of pairStreams) { clearTimeout(stream.timer); stream.finish(); } }, 80);
      }
      response.on('close', () => { clearTimeout(timer); activeStreams--; });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const options = { attachmentGuard: async attachment => { if (!attachment.approved) throw new Error("Fixture requires approval"); }, origin, storageRoot: directory, bootstrapTimeoutMs: 500, loginNoticeDurationMs: 2000, browser: process.env.NTPU_FIXTURE_BROWSER || 'auto' };
  let bridge = new BrowserBridge(options);
  try {
    await bridge.open(); assert.equal((await bridge.status()).ready, true); assert.equal(bridge.manager.info.headless, true, 'ordinary connection uses a hidden browser');
    await bridge.page.evaluate(() => { document.cookie = 'fixture_state=synthetic; max-age=3600; path=/'; });
    assert.equal((await bridge.chat('first', { newConversation: true })).text, 'mock-response');
    assert.equal((await bridge.chat('second', { newConversation: false })).text, 'mock-response');
    assert.equal(await bridge.page.locator('#newCount').textContent(), '1');
    assert.equal(bridge.ownedConversations.size, 1);
    failReset = true; assert.equal((await bridge.cleanupConversations()).failed, 1); assert.equal(bridge.ownedConversations.size, 1);
    failReset = false; assert.deepEqual(await bridge.cleanupConversations(), { deleted: 1, failed: 0 });
    assert.equal(await bridge.page.locator('[data-del-sid="unrelated"]').count(), 1); assert.equal(deletedIds.includes('unrelated'), false);
    await bridge.chat('after-cleanup', { newConversation: true });
    const image = { name: 'fixture.png', mimeType: 'image/png', approved: true, buffer: Buffer.from('synthetic fixture bytes') };
    assert.equal((await bridge.chat('attachment', { newConversation: false, attachment: image })).text, 'mock-response');
    const controller = new AbortController();
    const pending = bridge.chat('slow', { newConversation: false, signal: controller.signal });
    const cancel = setTimeout(() => controller.abort(), 150);
    try { await assert.rejects(pending, /已停止/); } finally { clearTimeout(cancel); }
    const firstChannel = await bridge.createChannel(), secondChannel = await bridge.createChannel();
    try {
      const replies = await Promise.all([firstChannel.chat('parallel-A'), secondChannel.chat('parallel-B')]);
      assert.deepEqual(replies.map(reply => reply.text), ['parallel-A-response', 'parallel-B-response']);
      assert.ok(peakStreams >= 2, 'the mock server observed overlapping independent streams');
      await firstChannel.close(); assert.equal(bridge.manager.info.controlled, true);
      const workerAbort = new AbortController();
      const slowWorker = secondChannel.chat('slow', { signal: workerAbort.signal });
      const parentReply = bridge.chat('parallel-parent');
      const cancelWorker = setTimeout(() => workerAbort.abort(), 150);
      try { await assert.rejects(slowWorker, /已停止/); assert.equal((await parentReply).text, 'parallel-parent-response'); }
      finally { clearTimeout(cancelWorker); }
    } finally { await firstChannel.close(); await secondChannel.close(); }
    const concurrent = await probeConcurrency(bridge, { groupPauseMs: 0 });
    assert.equal(concurrent.verified, true); assert.equal(concurrent.recommendedConcurrency, 5); assert.deepEqual(concurrent.groups.map(group => group.concurrency), [2,3,4,5]); assert.ok(peakStreams >= 5); assert.equal(bridge.channels.size, 0);
    const selected = bridge.manager.info.label;
    await bridge.close(); bridge = new BrowserBridge(options); await bridge.open();
    assert.equal(await bridge.page.evaluate(() => document.cookie.includes('fixture_state=synthetic')), true);
    // Real Chromium handoff with an HttpOnly session cookie (no expiry). The
    // mock server gates the entire app, so ready/streaming prove restoration.
    requiresLogin = true; await bridge.page.goto(origin);
    assert.equal((await bridge.status()).authentication, 'required');
    const profile = bridge.profile;
    await bridge.openLogin(); assert.equal(bridge.manager.info.headless, false);
    assert.equal((await bridge.finishLogin()).loginWindow, true);
    await bridge.page.locator('#fixture-user').fill('synthetic');
    await bridge.page.locator('#fixture-submit').click();
    await bridge.page.waitForSelector('#sendBtn');
    assert.equal((await bridge.finishLogin()).loginComplete, true);
    assert.equal(await bridge.page.getByRole('heading', { name: '登入成功' }).count(), 1);
    assert.equal(await bridge.page.getByText('可以關閉此視窗，回到 VS Code。', { exact: false }).isVisible(), true);
    await fs.mkdir(path.join(__dirname, '..', '.local'), { recursive: true });
    await bridge.page.screenshot({ path: path.join(__dirname, '..', '.local', 'login-success.png') });
    await bridge.page.getByRole('button', { name: '返回 VS Code', exact: true }).click();
    assert.equal((await bridge.finishLogin()).ready, true, 'login automatically hands off to a verified background connection');
    assert.equal(bridge.manager.info.headless, true); assert.equal(bridge.profile, profile);
    assert.equal((await bridge.chat('after-login', { newConversation: true })).text, 'mock-response');
    // A user closing the visible login window also returns to the background.
    await bridge.context.clearCookies(); await bridge.page.goto(origin);
    await bridge.openLogin(); await bridge.page.locator('#fixture-submit').click(); await bridge.page.waitForSelector('#sendBtn');
    assert.equal((await bridge.finishLogin()).loginComplete, true);
    await bridge.page.close();
    assert.equal((await bridge.finishLogin()).ready, true, 'closing login window preserves session-cookie authentication');
    assert.equal((await bridge.chat('after-window-close', { newConversation: true })).text, 'mock-response');
    // Without user action, the completion notice closes itself after its delay.
    await bridge.openLogin(); assert.equal((await bridge.finishLogin()).loginComplete, true);
    await bridge.page.waitForFunction(() => document.getElementById('__ntpu_login_complete').shadowRoot.querySelector('small').textContent.startsWith('0 秒'));
    assert.equal((await bridge.finishLogin()).ready, true);
    // Closing before login must not report success or open another window.
    await bridge.context.clearCookies(); await bridge.page.goto(origin);
    await bridge.openLogin(); await bridge.page.close();
    assert.equal((await bridge.finishLogin()).ready, false);
    assert.equal(bridge.mode, 'background');
    requiresLogin = false; await bridge.page.goto(origin);
    await testUI(bridge.page, origin);
    console.log('Local mock website passed: ' + selected + '; login window, session-cookie background handoff, manual close/cancel, streaming, task reuse, upload, persistent profile, memory/settings UI. No NTPU AI requests.');
  } finally {
    await bridge.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
