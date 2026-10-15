'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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

test('a closed browser reports unknown authentication without clearing login credentials', async () => {
  const bridge = new BrowserBridge();
  let clears = 0; bridge.context = { clearCookies: async () => { clears++; } };
  bridge.page = { isClosed: () => true };
  const status = await bridge.status();
  assert.equal(status.ready, false); assert.equal(status.authentication, 'unknown'); assert.match(status.message, /不會清除/);
  assert.equal(clears, 0);
});

function loginFixture({ restore = true } = {}) {
  const launches = []; let authenticated = false, active = 0;
  const manager = { info: null, launch: async options => {
    assert.equal(active, 0, 'profile lock is released before the next launch'); active++;
    const context = new EventEmitter(), page = new EventEmitter(); let closed = false;
    page.isClosed = () => closed; page.url = () => ORIGIN + '/';
    page.goto = page.bringToFront = page.waitForFunction = async () => {};
    page.mainFrame = () => null;
    page.evaluate = async () => ({ ready: authenticated, authentication: authenticated ? 'authenticated' : 'required', message: 'mock' });
    page.close = async () => { closed = true; page.emit('close'); };
    context.pages = () => closed ? [] : [page];
    context.exposeBinding = context.addInitScript = async () => {};
    context.close = async () => { if (closed) { active = 0; return; } active--; closed = true; page.emit('close'); context.emit('close'); };
    if (options.headless && launches.length && !restore) authenticated = false;
    launches.push(options);
    manager.info = { browser: 'chrome', profile: '/private-test-profile/chrome', headless: options.headless, controlled: true };
    return { context, page, info: manager.info };
  } };
  return { bridge: new BrowserBridge({ manager }), launches, authenticate: () => { authenticated = true; } };
}

test('concurrent login requests use one window and release profile ownership before background handoff', async () => {
  const f = loginFixture();
  await f.bridge.open(); await Promise.all([f.bridge.openLogin(), f.bridge.openLogin()]);
  assert.equal(f.launches.length, 2); assert.equal(f.launches[1].headless, false);
  assert.equal(f.launches[1].selection, 'chrome', 'Auto selection stays pinned during login');
  assert.equal((await f.bridge.finishLogin()).loginWindow, true);
  f.authenticate();
  assert.equal((await f.bridge.finishLogin()).loginComplete, true);
  f.bridge.loginAcknowledged = true;
  const statuses = await Promise.all([f.bridge.finishLogin(), f.bridge.finishLogin()]);
  assert.ok(statuses.every(status => status.ready)); assert.equal(f.launches.length, 3);
  assert.equal(f.launches[2].headless, true); assert.equal(f.bridge.mode, 'background');
  await f.bridge.close();
});

test('closing a login window before authenticating resumes the background and never reports login success', async () => {
  const f = loginFixture(); await f.bridge.openLogin(); await f.bridge.page.close();
  assert.equal((await f.bridge.finishLogin()).ready, false);
  assert.equal(f.bridge.mode, 'background'); assert.equal(f.launches.length, 2);
  await f.bridge.close();
});

test('login success is only reported after the background browser restores authentication', async () => {
  const f = loginFixture({ restore: false }); await f.bridge.openLogin(); f.authenticate();
  await f.bridge.finishLogin(); f.bridge.loginAcknowledged = true;
  const status = await f.bridge.finishLogin();
  assert.equal(status.ready, false); assert.match(status.message, /背景連線尚未取得有效登入/);
  assert.equal(f.bridge.mode, 'background'); await f.bridge.close();
});

test('active requests cannot switch into the login window or acquire another profile lock', async () => {
  const f = loginFixture(); f.bridge.pending = { id: 'active' };
  await assert.rejects(f.bridge.openLogin(), /停止目前任務/);
  assert.equal(f.launches.length, 0); f.bridge.pending = null;
});

test('page initialization and navigation failures close owned contexts and report the failing stage', async () => {
  for (const stage of ['bindings', 'navigation']) {
    const f = loginFixture(); const launch = f.bridge.manager.launch;
    let closed = 0;
    f.bridge.manager.launch = async options => {
      const result = await launch(options), close = result.context.close;
      result.context.close = async () => { closed++; await close(); };
      if (stage === 'bindings') result.context.exposeBinding = async () => { throw new Error('binding unavailable'); };
      else result.page.goto = async () => { throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://sso.example/?ticket=private-ticket'); };
      return result;
    };
    await assert.rejects(f.bridge.openLogin(), error => {
      assert.equal(error.failures[0].stage, stage); assert.ok(!error.message.includes('private-ticket')); return true;
    });
    assert.equal(closed, 1); assert.equal(f.bridge.context, null); assert.equal(f.bridge.mode, null);
    assert.equal(f.bridge.manager.info, null); assert.equal((await f.bridge.status()).authentication, 'unknown');
  }
});

test('a failed background handoff reports its operation and never reports authentication success', async () => {
  const f = loginFixture(); await f.bridge.openLogin(); f.authenticate();
  await f.bridge.finishLogin(); f.bridge.loginAcknowledged = true;
  f.bridge.manager.launch = async () => { throw new Error('Chromium spawn failed'); };
  await assert.rejects(f.bridge.finishLogin(), /登入後背景交接失敗[\s\S]*Chromium spawn failed/);
  assert.equal(f.bridge.context, null); assert.equal(f.bridge.mode, null);
  assert.equal((await f.bridge.status()).authentication, 'unknown');
});
