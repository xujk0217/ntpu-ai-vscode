'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserPreview } = require('../src/browser/preview');
function fixture() {
  const calls = [], messages = [];
  const page = { url: () => 'https://sso.ntpu.edu.tw/login', isClosed: () => false, setViewportSize: async () => {}, viewportSize: () => ({ width: 480, height: 640 }), screenshot: async () => Buffer.from('frame'), mouse: { click: async (...args) => calls.push(args), wheel: async (...args) => calls.push(args) }, keyboard: { insertText: async text => calls.push(text), press: async key => calls.push(key) } };
  const bridge = { origin: 'https://ai.ntpu.edu.tw', page, open: async () => {}, context: { pages: () => [page] } };
  let busy = false;
  const preview = new BrowserPreview({ bridge: () => bridge, emit: value => messages.push(value), busy: () => busy });
  return { page, preview, calls, messages, lock: () => busy = true };
}
test('browser preview supports HTTPS SSO input without recording text in frames', async () => {
  const f = fixture(); try {
    await f.preview.start(); await f.preview.input({ action: 'click', x: 0.5, y: 0.5 }); await f.preview.input({ action: 'text', text: 'synthetic user input' });
    assert.deepEqual(f.calls[0], [240, 320]); assert.ok(f.messages[0].image.startsWith('data:image/jpeg;base64,')); assert.equal(JSON.stringify(f.messages).includes('synthetic user input'), false);
  } finally { f.preview.stop(); }
});
test('busy agent blocks browser input and invalid coordinates or keys do not execute', async () => {
  const f = fixture(); try { await f.preview.start(); await f.preview.input({ action: 'click', x: 9, y: 0 }); await f.preview.input({ action: 'key', key: 'Control+L' }); f.lock(); await f.preview.input({ action: 'text', text: 'blocked' }); assert.equal(f.calls.length, 0); } finally { f.preview.stop(); }
});
test('non-HTTPS external pages are not captured or controlled', async () => {
  const f = fixture(); f.page.url = () => 'http://unknown.test'; try { await f.preview.start(); await f.preview.input({ action: 'text', text: 'blocked' }); assert.equal(f.calls.length, 0); assert.equal(f.messages[0].image, undefined); } finally { f.preview.stop(); }
});
