'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function assets() {
  const root = path.join(__dirname, '..', 'media');
  let html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  html = html.replaceAll('%CSP%', "'self'").replaceAll('%NONCE%', 'fixture').replaceAll('%STYLE%', '/agent.css').replaceAll('%SCRIPT%', '/chat.bundle.js');
  html = html.replace('<script nonce="fixture" src=', '<script nonce="fixture">window.hostMessages=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.hostMessages.push(message)});</script><script nonce="fixture" src=');
  const css = ':root{--vscode-sideBar-background:#1e1e1e;--vscode-editor-background:#252526;--vscode-foreground:#ddd;--vscode-descriptionForeground:#999;--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-input-background:#313131;--vscode-input-foreground:#ddd;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff}' + await fs.readFile(path.join(root, 'agent.css'), 'utf8');
  return new Map([['/ui', ['text/html', html]], ['/agent.css', ['text/css', css]], ['/chat.bundle.js', ['text/javascript', await fs.readFile(path.join(root, 'chat.bundle.js'), 'utf8')]]]);
}
async function testUI(page, origin) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/ui'); await page.setViewportSize({ width: 340, height: 800 });
  const state = { kind: 'state', busy: false, options: { agent: 'build', depth: 'standard', permission: 'ask', web: true, skills: [] }, workspace: 'Fixture', contexts: [], queue: [], connection: { ready: true, message: 'Fixture 已連線' } };
  const send = data => page.evaluate(value => window.postMessage(value, '*'), data);
  await send({ kind: 'session', session: { id: 'fixture', title: 'Fixture', messages: [{ id: 'm1', role: 'assistant', text: '本機歷史' }], hasMore: true, before: 1, changes: [], plan: [] } });
  await send({ kind: 'capabilities', skills: [], servers: [], tools: [], browser: { selection: 'auto', host: 'Fixture host' }, thinking: 'Fixture', image: 'Fixture' });
  await send(state); await page.waitForFunction(() => document.getElementById('connectionActions').hidden);
  await page.locator('.history-more').click();
  assert.equal(await page.evaluate(() => window.hostMessages.some(message => message.kind === 'historyPage')), true);
  await page.locator('#settings').click();
  assert.match(await page.locator('.account-card').textContent(), /已登入/);
  const input = page.getByRole('textbox', { name: 'Custom Browser Path', exact: true }); await input.fill('/fixture/draft');
  await send(state); assert.equal(await input.inputValue(), '/fixture/draft');
  await page.locator('[data-tab="memory"]').click();
  await send({ kind: 'memory', project: { entries: [{ id: 'e1', kind: 'architecture', text: 'TypeScript', source: { userEditedAt: 1 } }] }, tasks: [], storage: 'private fixture', enabled: true, autoUpdate: true });
  await page.waitForFunction(() => document.querySelector('.memory-card')?.textContent.includes('TypeScript'));
  const directory = path.join(__dirname, '..', '.local'); await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, 'memory-privacy-ui.png') });
  await page.locator('#closeDrawer').click(); await send({ ...state, connection: { ready: false, message: '尚未登入' } });
  await page.waitForFunction(() => !document.getElementById('connectionActions').hidden);
  assert.deepEqual(errors, []);
}
module.exports = { assets, testUI };
