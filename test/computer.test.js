'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComputerController, target } = require('../src/computer/controller');
const { runAgent } = require('../src/agent');
const { PermissionPolicy } = require('../src/permissions');
function fixture(approve = async () => true) {
  let actions = 0, captures = 0;
  const controller = new ComputerController({ platform: 'linux', directory: '/synthetic-computer', approve,
    desktop: async message => {
      if (message.op === 'list') return { windows: [{ id: '42', title: 'Synthetic notes', class: 'text-editor' }, { id: '43', title: 'Daily browser', class: 'Google-chrome' }] };
      if (message.op === 'observe') return { png: Buffer.from('synthetic-png').toString('base64'), width: 500, height: 300, x: 10, y: 20, title: 'Synthetic notes' };
      assert.deepEqual(message.geometry, { x: 10, y: 20, width: 500, height: 300 }); actions++; return { ok: true, performed: true };
    }, selectWindow: async windows => { assert.equal(windows.length, 1); return windows[0]; }, image: async (_buffer, question) => { captures++; return { artifact: 'fixture-image', analysis: question ? 'actual observation' : undefined }; } });
  return { controller, counts: () => ({ actions, captures }), signal: new AbortController().signal };
}
test('desktop control requires explicit selection/approval and consumes one fresh observation per action', async () => {
  const f = fixture(); const c = f.controller;
  await c.open({ mode: 'desktop' }, f.signal);
  await assert.rejects(c.action({ action: 'click' }, f.signal), /觀察/);
  const seen = await c.observe({ question: 'Describe' }, f.signal); assert.equal(seen.analysis, 'actual observation');
  assert.equal((await c.action({ observation: seen.observation, action: 'click', x: 20, y: 20 }, f.signal)).performed, true);
  assert.equal(c.needsObservation, true);
  await assert.rejects(c.action({ observation: seen.observation, action: 'click', x: 20, y: 20 }, f.signal), /觀察/);
  await c.observe({ question: 'Verify actual result' }, f.signal); assert.equal(c.needsObservation, false); assert.equal(f.counts().actions, 1); await c.dispose();
});
test('rejection, secrets, remote environments and cancelled requests never perform desktop actions', async () => {
  const denied = fixture(async () => false); assert.equal((await denied.controller.open({ mode: 'desktop' }, denied.signal)).denied, true); assert.equal(denied.counts().actions, 0);
  const f = fixture(); await f.controller.open({ mode: 'desktop' }, f.signal); const seen = await f.controller.observe({}, f.signal);
  await assert.rejects(f.controller.action({ action: 'type', observation: seen.observation, text: 'password=private-fixture' }, f.signal), /秘密/);
  await assert.rejects(f.controller.action({ action: 'click', observation: seen.observation }, AbortSignal.abort()), /停止/); assert.equal(f.counts().actions, 0);
  const remote = fixture(); remote.controller.options.remote = true; await assert.rejects(remote.controller.open({ mode: 'desktop' }, remote.signal), /遠端/);
  await f.controller.dispose(); await denied.controller.dispose(); await remote.controller.dispose();
});
test('work browser targets reject school auth, credential URLs, private networks and unsafe schemes', async () => {
  for (const url of ['https://ai.ntpu.edu.tw/', 'file:///etc/passwd', 'https://user:pass@example.com', 'http://192.168.1.2', 'http://169.254.169.254']) await assert.rejects(target(url));
  assert.equal((await target('http://localhost:3456/preview')).url.origin, 'http://localhost:3456');
});
test('read-only Agent modes cannot acquire computer tools, including full permission mode', () => {
  const policy = new PermissionPolicy({ mode: 'full', agent: 'review' });
  for (const name of ['computer_open','computer_observe','computer_action','computer_close']) assert.equal(policy.decision(name), 'deny');
});
test('agent finalization requires an actual post-action observation and stops repeated unverified conclusions', async () => {
  for (const observe of [true, false]) {
    let pending = false, index = 0, finals = [];
    const tools = { catalog: () => [{ name: 'computer_action' }, { name: 'computer_observe' }], needsComputerObservation: () => pending,
      execute: async name => { pending = name === 'computer_action'; return { ok: true, ...(pending ? { performed: true } : { actualObservedText: 'clicked' }) }; } };
    const replies = [{ kind: 'tool', name: 'computer_action', args: {} }, { kind: 'final', message: 'premature conclusion' },
      ...(observe ? [{ kind: 'tool', name: 'computer_observe', args: {} }, { kind: 'final', message: 'verified result' }] : Array(3).fill({ kind: 'final', message: 'premature conclusion' }))];
    const result = await runAgent({ tools, request: 'Verify actual UI behavior', signal: new AbortController().signal,
      bridge: { chat: async () => ({ text: JSON.stringify(replies[index++]) }) }, onFinal: value => finals.push(value) });
    assert.equal(result.completed, observe); assert.equal(finals.length, 1); assert.notEqual(finals[0], 'premature conclusion');
  }
});

test('native screenshots without analysis and closing an unverified target cannot establish task success', async () => {
  const f = fixture(), c = f.controller;
  await c.open({ mode: 'desktop' }, f.signal); let seen = await c.observe({ question: 'Locate controls' }, f.signal);
  await c.action({ observation: seen.observation, action: 'click', x: 10, y: 10 }, f.signal);
  seen = await c.observe({}, f.signal); assert.equal(seen.verificationAvailable, false); assert.equal(c.needsObservation, true);
  await c.close(); await c.open({ mode: 'desktop' }, f.signal); await c.observe({ question: 'Different target' }, f.signal);
  assert.equal(c.needsObservation, true); await c.dispose();
});
test('public network switch also applies to the controlled browser', async () => {
  const f = fixture(); f.controller.options.web = false;
  await assert.rejects(f.controller.open({ url: 'https://example.com' }, f.signal), /公開網路已停用/);
  assert.equal((await f.controller.checkedTarget('http://localhost:3000')).url.hostname, 'localhost'); await f.controller.dispose();
});
