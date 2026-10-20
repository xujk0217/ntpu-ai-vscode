'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { ComputerController, macDesktopCall } = require('../src/computer/controller');
const signal = () => new AbortController().signal;
function fixture() {
  const selected = { id: '12', pid: 100, bundle: 'tw.ntpu.synthetic.notes', title: 'Synthetic notes', class: 'Notes' };
  const messages = [];
  const controller = new ComputerController({ platform: 'darwin', directory: '/synthetic', approve: async () => true,
    selectWindow: async windows => { assert.deepEqual(windows, [selected]); return windows[0]; },
    desktop: async message => { messages.push(message);
      if (message.op === 'list') return { windows: [selected, { id: '13', class: 'Code', title: 'Work', bundle: 'com.microsoft.VSCode' }, { id: '14', class: 'Safari', title: 'Home', bundle: 'com.apple.Safari' }, { id: '15', class: 'Test', title: '登入' }] };
      if (message.op === 'observe') return { png: Buffer.from('fixture').toString('base64'), x: 10, y: 20, width: 500, height: 300, title: selected.title };
      return { ok: true, performed: true, requiresObservation: true };
    }, image: async () => ({ analysis: 'synthetic' }) });
  return { controller, messages, selected };
}
test('macOS selection filters host IDEs, browser bundles and login windows; native calls pin selected identity', async () => {
  const { controller: c, messages, selected } = fixture(), s = signal();
  assert.equal((await c.open({ mode: 'desktop' }, s)).controlled, true);
  const seen = await c.observe({}, s);
  await c.action({ action: 'key', key: 'Enter', observation: seen.observation }, s);
  assert.deepEqual(messages[1].identity, selected); assert.deepEqual(messages[2].identity, selected);
  assert.equal(messages[2].key, 'Return'); assert.equal(c.needsObservation, true);
  await c.dispose();
});
test('macOS denied, cancelled and stale observations never send a native action', async () => {
  const { controller: c, messages } = fixture(), s = signal();
  await c.open({ mode: 'desktop' }, s); let seen = await c.observe({}, s);
  c.options.approve = async () => false;
  assert.equal((await c.action({ action: 'key', key: 'Enter', observation: seen.observation }, s)).denied, true);
  c.options.approve = async () => true;
  await assert.rejects(c.action({ action: 'key', key: 'Enter', observation: seen.observation }, AbortSignal.abort()), /停止/);
  assert.equal(messages.filter(m => m.op === 'action').length, 0);
  await c.action({ action: 'key', key: 'Enter', observation: seen.observation }, s);
  await assert.rejects(c.action({ action: 'key', key: 'Enter', observation: seen.observation }, s), /觀察/);
  await c.dispose();
});
test('macOS helper missing and cancelled states report actionable errors, never use Python or shell fallback', async () => {
  await assert.rejects(macDesktopCall({ op: 'list' }, { executable: '/nonexistent/ntpu-native-helper' }), /完整 VSIX/);
  await assert.rejects(macDesktopCall({ op: 'list' }, { signal: AbortSignal.abort(), executable: process.execPath }), /停止/);
});
test('native macOS source uses single-window ScreenCaptureKit, explicit permission checks and paired input cleanup', async () => {
  const source = await fs.readFile(require.resolve('../src/computer/desktop-macos.swift'), 'utf8');
  for (const token of ['CGPreflightScreenCaptureAccess()', 'AXIsProcessTrusted()', 'SCContentFilter(desktopIndependentWindow:', 'postToPid(pid)', 'pthread_sigmask', 'kAXFocusedWindowAttribute', 'requiresObservation', 'safeContents']) assert.ok(source.includes(token), token);
  assert.ok(!source.includes('NSPasteboard')); assert.ok(!source.includes('CGDisplayCreateImage'));
});
