'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BrowserManager, executablePaths, dataDirectory, defaultId } = require('../src/browser/manager');

function manager(platform, installed, preferred, failures = []) {
  const launches = [];
  const env = platform === 'win32' ? { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' } : { DISPLAY: ':1', PATH: '/usr/bin' };
  const instance = new BrowserManager({ platform, arch: 'x64', env, home: platform === 'win32' ? 'C:\\Users\\Test' : '/home/test',
    storageRoot: platform === 'win32' ? 'C:\\AgentData' : '/agent-data',
    exists: async file => installed.some(value => file.includes(value)), resolve: async value => value,
    prepareProfile: async () => {}, run: async () => ({ stdout: platform === 'darwin' ? JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: preferred }] }) : preferred }),
    engine: { executablePath: () => '/not-installed', launchPersistentContext: async (profile, options) => {
      launches.push({ profile, options }); if (failures.some(value => options.executablePath.includes(value))) throw new Error('mock launch failure');
      const page = { evaluate: async fn => fn.toString().includes('navigator.userAgent') ? 'Chromium mock controlled' : { width: 1024, height: 768 } };
      return { pages: () => [page], close: async () => {}, newCDPSession: async () => ({
        send: async (method, params) => { launches.at(-1).windowCalls ||= []; launches.at(-1).windowCalls.push({ method, params }); return { windowId: 1 }; }, detach: async () => {}
      }) };
    } } });
  return { instance, launches };
}
test('Windows Auto detects and controls Edge when it is the supported default', async () => {
  const { instance, launches } = manager('win32', ['msedge.exe', 'chrome.exe'], 'MSEdgeHTM');
  const result = await instance.launch(); assert.equal(result.info.browser, 'edge'); assert.equal(result.info.controlled, true);
  assert.equal(launches[0].options.headless, true);
  assert.match(launches[0].options.executablePath, /Microsoft\\Edge/); assert.match(launches[0].profile, /edge$/);
});
test('macOS unsupported Safari default falls back and launch failure tries an installed alternative', async () => {
  const { instance, launches } = manager('darwin', ['Google Chrome', 'Microsoft Edge'], 'com.apple.safari', ['Google Chrome']);
  const result = await instance.launch(); assert.equal(result.info.browser, 'edge'); assert.equal(launches.length, 2);
  assert.notEqual(launches[0].profile, launches[1].profile); assert.match(result.info.message, /預設瀏覽器不支援或不可用/);
});
test('Linux Chromium works and manual selection overrides system default', async () => {
  const { instance } = manager('linux', ['google-chrome', '/chromium'], 'chromium.desktop');
  assert.equal((await instance.launch()).info.browser, 'chromium');
  assert.equal(instance.info.headless, true);
  assert.equal((await instance.launch({ selection: 'chrome' })).info.browser, 'chrome');
});
test('login uses normal native window bounds clamped to the available screen', async () => {
  const { instance, launches } = manager('darwin', ['Google Chrome'], 'com.google.chrome');
  await instance.launch({ headless: false });
  assert.equal(launches[0].options.viewport, null);
  assert.deepEqual(launches[0].windowCalls.at(-1).params.bounds, { width: 1024, height: 768 });
  assert.ok(launches[0].options.args.includes('--restore-last-session'));
});
test('profile policy rejects daily browser profiles, workspaces and parent directories', async () => {
  const { instance } = manager('darwin', ['Google Chrome'], 'com.google.chrome');
  instance.options.profileRoot = '/home/test/Library/Application Support/Google/Chrome';
  await assert.rejects(instance.launch(), /Profile/);
  instance.options.profileRoot = '/projects/app'; instance.options.workspaces = ['/projects/app']; await assert.rejects(instance.launch(), /Profile/);
  instance.options.profileRoot = '/home/test'; await assert.rejects(instance.launch(), /Profile/);
});
test('remote hosts fail clearly without launching a desktop browser', async () => {
  const { instance, launches } = manager('linux', ['google-chrome'], 'google-chrome.desktop'); instance.options.remote = true;
  await assert.rejects(instance.launch(), /遠端/); assert.equal(launches.length, 0);
});

test('profile checks resolve workspace aliases and keep agent memory isolated', async () => {
  const { instance } = manager('darwin', ['Google Chrome'], 'Safari');
  instance.options.workspaces = ['/workspace-link']; instance.options.profileRoot = '/physical/project/profiles';
  instance.resolve = async value => value === '/workspace-link' ? '/physical/project' : value;
  await assert.rejects(instance.launch(), /Profile/);
  instance.options.workspaces = []; instance.options.profileRoot = '/agent-data/agent-memory';
  await assert.rejects(instance.launch(), /Profile/);
});
test('custom Chromium paths and application data locations remain isolated across platforms', async () => {
  const { instance } = manager('linux', ['/opt/custom'], 'Firefox');
  const a = await instance.launch({ selection: 'custom', customPath: '/opt/custom-one' });
  const b = await instance.launch({ selection: 'custom', customPath: '/opt/custom-two' }); assert.notEqual(a.info.profile, b.info.profile);
  await assert.rejects(instance.launch({ selection: 'custom', customPath: 'relative-path' }), /絕對路徑/);
  assert.equal(defaultId('Safari'), null); assert.match(dataDirectory('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Home'), /^C:\\Local/);
  assert.match(dataDirectory('darwin', {}, '/home/test'), /Application Support/);
  assert.ok(executablePaths('edge', 'win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Home')[0].endsWith('msedge.exe'));
});

test('launch diagnostics preserve stderr, distinguish failure kinds and never disable the sandbox', async () => {
  const examples = [
    ['Failed to create a ProcessSingleton\n[pid=42][err] SingletonLock: Permission denied (13)', 'permission'],
    ['Target page, context or browser has been closed\n[pid=42][err] error while loading shared libraries: libX11.so: cannot open shared object file', 'dependencies'],
    ['Target closed\n[pid=42][err] No usable sandbox! user namespace denied', 'sandbox'],
    ['Target closed\n[pid=42][err] Missing X server or $DISPLAY', 'display'],
    ['Failed to create a ProcessSingleton\n[pid=42][err] SingletonLock: File exists (17)', 'profile-singleton'],
    ['Something unexpected\n[pid=42][err] meaningful underlying failure', 'unknown']
  ];
  for (const [message, kind] of examples) {
    const { instance } = manager('linux', ['google-chrome'], 'google-chrome.desktop');
    instance.engine.launchPersistentContext = async (_, options) => {
      assert.equal(options.chromiumSandbox, true); assert.ok(!options.args.includes('--no-sandbox'));
      throw new Error(message);
    };
    await assert.rejects(instance.launch(), error => {
      assert.equal(error.failures[0].kind, kind); assert.equal(error.failures[0].stage, 'spawn');
      assert.match(error.message, /Google Chrome.*\/usr\/bin\/google-chrome/);
      assert.ok(error.message.includes(message.split('\n')[1])); assert.match(error.message, /背景／Chromium 啟動/);
      if (kind !== 'profile-singleton') assert.ok(!error.message.includes('關閉該專用視窗'));
      return true;
    });
  }
});

test('diagnostics redact complete multi-line credentials and URLs before bounding output', async () => {
  const { browserReason } = require('../src/browser/diagnostics');
  const message = 'Target closed\n - <launching> /browser --password=launch-secret\n' +
    '[pid=3][err] Cookie: session=cookie-secret; another=private\n' +
    '[pid=3][err] Authorization: Bearer bearer-secret\n' +
    'password=super-private\nhttps://user:pass@sso.example/login?code=sso-secret&ticket=unknown-secret#fragment-secret\n' +
    'useful stderr\n' + 'noise'.repeat(2000);
  const reason = browserReason(new Error(message));
  for (const secret of ['launch-secret', 'cookie-secret', 'bearer-secret', 'super-private', 'sso-secret', 'unknown-secret', 'fragment-secret', 'user:pass']) assert.ok(!reason.includes(secret), secret);
  assert.match(reason, /useful stderr/); assert.ok(reason.length <= 3500); assert.ok(!reason.includes('<launching>'));
});

test('profile preparation and discovery errors have their own stages and clear stale success', async () => {
  const { instance } = manager('linux', ['google-chrome'], 'google-chrome.desktop');
  await instance.launch(); assert.equal(instance.info.controlled, true);
  instance.prepareProfile = async () => { throw new Error('EACCES: mkdir dedicated profile'); };
  await assert.rejects(instance.launch(), error => error.failures[0].stage === 'profile-prepare' && error.failures[0].kind === 'permission');
  assert.equal(instance.info, null);
  await assert.rejects(instance.launch({ selection: 'custom', customPath: 'relative' }), error => error.failures[0].stage === 'discovery');
});

test('optional CDP window sizing failures retain a controlled login context', async () => {
  for (const failure of ['screen', 'session', 'get', 'bounds', 'detach']) {
    const { instance, launches } = manager('linux', ['google-chrome'], 'google-chrome.desktop');
    let closed = 0, probes = 0, detached = 0;
    const page = { evaluate: async fn => {
      if (fn.toString().includes('navigator.userAgent')) { probes++; return 'Chrome controlled'; }
      if (failure === 'screen') throw new Error('Screen dimensions unavailable');
      return { width: 1100, height: 800 };
    } };
    const context = { pages: () => [page], close: async () => { closed++; }, newCDPSession: async () => {
      if (failure === 'session') throw new Error('CDP unavailable');
      return { send: async method => {
        if (failure === 'get' || failure === 'bounds' && method === 'Browser.setWindowBounds') throw new Error('Window manager does not support bounds');
        return { windowId: 3 };
      }, detach: async () => { detached++; if (failure === 'detach') throw new Error('detach unavailable'); } };
    } };
    instance.engine.launchPersistentContext = async () => context;
    const result = await instance.launch({ headless: false });
    assert.equal(result.context, context); assert.equal(closed, 0); assert.equal(probes, 2);
    assert.equal(result.info.controlled, true); assert.equal(result.info.warnings[0].stage, 'window-sizing');
    assert.match(result.info.message, /保留原生視窗/);
    if (['get', 'bounds', 'detach'].includes(failure)) assert.equal(detached, 1);
    assert.equal(launches.length, 0);
  }
});

test('a lost page during sizing is cleaned up and never reported as controlled', async () => {
  const { instance } = manager('linux', ['google-chrome'], 'google-chrome.desktop');
  let probes = 0, closed = 0;
  instance.engine.launchPersistentContext = async () => ({ pages: () => [{ evaluate: async () => {
    if (++probes === 1) return 'Chrome controlled'; throw new Error('Target page closed');
  } }], close: async () => { closed++; } });
  await assert.rejects(instance.launch({ headless: false }), error => error.failures[0].stage === 'control');
  assert.equal(closed, 1); assert.equal(instance.info, null);
});

test('failed page control closes the context before Auto tries another browser', async () => {
  const { instance } = manager('linux', ['google-chrome', 'microsoft-edge'], 'google-chrome.desktop');
  const launch = instance.engine.launchPersistentContext; let closed = false;
  instance.engine.launchPersistentContext = async (profile, options) => {
    if (options.executablePath.includes('google-chrome')) return { pages: () => [{ evaluate: async () => { throw new Error('page control failed'); } }], close: async () => { closed = true; } };
    assert.equal(closed, true); return launch(profile, options);
  };
  assert.equal((await instance.launch()).info.browser, 'edge');
});
