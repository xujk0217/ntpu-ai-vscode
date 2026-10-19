'use strict';
// Capture the shipped webview with synthetic example data, never school accounts or private chats.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { assets } = require('./ui-fixture');

async function main() {
  const files = await assets();
  const browser = await chromium.launch({ channel: process.env.NTPU_SCREENSHOT_BROWSER || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 840 }, deviceScaleFactor: 2 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://preview.invalid/**', route => {
      const asset = files.get(new URL(route.request().url()).pathname);
      return route.fulfill(asset ? { contentType: asset[0], body: asset[1] } : { status: 404, body: '' });
    });
    await page.goto('https://preview.invalid/ui');
    const send = message => page.evaluate(data => new Promise(resolve => {
      const marker = crypto.randomUUID();
      const delivered = event => { if (event.data?.marker === marker) { window.removeEventListener('message', delivered); resolve(); } };
      window.addEventListener('message', delivered); window.postMessage({ ...data, marker }, '*');
    }), message);
    const state = { kind: 'state', busy: false, progress: '就緒', workspace: 'task-board', sessionTitle: '新工作階段',
      connection: { ready: true }, options: { agent: 'build', depth: 'standard', permission: 'ask', web: true, skills: [] },
      contexts: [], queue: [], submitMode: 'enter', submitModifier: '⌘',
      parallel: { enabled: true, effectiveConcurrency: 2, runningAgents: 0, activeRequests: 0, queuedRequests: 0 },
      budget: { used: 0, total: 64000 } };
    await send(state);
    await send({ kind: 'capabilities', skills: [], servers: [], tools: [] });
    await send({ kind: 'session', session: { id: 'home', title: '新工作階段', messages: [], changes: [], plan: [] } });
    const directory = path.join(__dirname, '..', 'docs', 'images'); await fs.mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, 'overview-home.png') });
    const now = Date.now(), done = (id, name, args, result) => ({ id, role: 'tool', name, args, status: 'done', result: JSON.stringify(result), startedAt: now - 5000, finishedAt: now });
    await send({ ...state, sessionTitle: '任務清單搜尋', progress: '已完成' });
    await send({ kind: 'session', session: { id: 'task', title: '任務清單搜尋', messages: [
      { id: 'request', role: 'user', text: '幫任務清單加入搜尋功能，沿用現有風格，並補上測試。' },
      { id: 'context', role: 'commentary', text: '先確認清單元件與既有測試，再加入搜尋條件。' },
      done('files', 'read_file', { path: 'src/TaskList.tsx' }, { ok: true, text: '已確認清單元件與篩選條件。' }),
      done('review', 'agent_task', { name: '檢查搜尋邊界', role: 'review' }, { result: '需涵蓋空白搜尋、大小寫及沒有結果。' }),
      done('edit', 'edit_file', { path: 'src/TaskList.tsx' }, { ok: true, saved: true }),
      done('checks', 'run_command', { command: 'npm test', cwd: '.' }, { ok: true, output: '12 tests passed', exit_code: 0 }),
      { id: 'answer', role: 'assistant', text: '已完成任務清單搜尋。\n\n- 即時篩選標題，支援大小寫與空白處理。\n- 沒有結果時顯示空白狀態。\n- 相關 **12 項測試通過**。\n\n可以在下方檢視這次的檔案變更。' },
    ], plan: [
      { title: '確認元件與測試範圍', status: 'completed' },
      { title: '實作搜尋與空白狀態', status: 'completed' },
      { title: '補上並執行相關測試', status: 'completed' },
    ], changes: [
      { id: 'component', path: 'src/TaskList.tsx', added: 18, removed: 3, saved: true, hunks: [] },
      { id: 'test', path: 'test/TaskList.test.tsx', added: 24, removed: 0, saved: true, hunks: [] },
    ] } });
    await page.locator('#messages').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(directory, 'overview-task.png') });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Saved main-page screenshots: overview-home.png, overview-task.png (synthetic data).');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
