'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserBridge, ORIGIN } = require('../src/browser');

test('logout clears only NTPU-domain cookies and app origin storage', async () => {
  const bridge = new BrowserBridge();
  let cookieFilter;
  let storageCleared = false;
  const navigations = [];
  bridge.context = { clearCookies: async filter => { cookieFilter = filter; } };
  bridge.page = {
    isClosed: () => false,
    url: () => ORIGIN + '/',
    evaluate: async () => { storageCleared = true; },
    goto: async url => { navigations.push(url); },
  };

  await bridge.logout();

  assert.match(ORIGIN, /ai\.ntpu\.edu\.tw/);
  assert.equal(cookieFilter.domain.test('ntpu.edu.tw'), true);
  assert.equal(cookieFilter.domain.test('sso.ntpu.edu.tw'), true);
  assert.equal(cookieFilter.domain.test('example.com'), false);
  assert.equal(storageCleared, true);
  assert.deepEqual(navigations, [ORIGIN]);
});

test('logout refuses to clear credentials while an agent request is active', async () => {
  const bridge = new BrowserBridge();
  bridge.pending = { id: 'active' };
  await assert.rejects(bridge.logout(), /停止目前執行中的任務/);
});
