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
      const page = { evaluate: async () => 'Chromium mock controlled' };
      return { pages: () => [page], close: async () => {} };
    } } });
  return { instance, launches };
}
test('Windows Auto detects and controls Edge when it is the supported default', async () => {
  const { instance, launches } = manager('win32', ['msedge.exe', 'chrome.exe'], 'MSEdgeHTM');
  const result = await instance.launch(); assert.equal(result.info.browser, 'edge'); assert.equal(result.info.controlled, true);
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
  assert.equal((await instance.launch({ selection: 'chrome' })).info.browser, 'chrome');
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
