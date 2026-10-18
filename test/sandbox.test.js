'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { SandboxExecutor, cleanEnvironment, quote } = require('../src/security/sandbox');
test('sandbox removes inherited secrets and quotes shell arguments', () => {
  assert.equal(cleanEnvironment({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: 'injected' }).AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(cleanEnvironment({ NODE_OPTIONS: 'injected' }).NODE_OPTIONS, undefined); assert.equal(quote("a'b"), "'a'\\''b'");
});
test('sandbox blocks protected, binary, symlink and unapproved Review paths', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-boundaries-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, data] of [['main.js', 'ordinary'], ['.env', 'PASSWORD=x'], ['report.txt', 'ordinary'], ['binary.dat', Buffer.from([0, 1])]]) await fs.writeFile(path.join(root, name), data);
  const executor = new SandboxExecutor(); const denied = await executor.boundaries(root, ['report.txt']);
  for (const name of ['.env', 'report.txt', 'binary.dat']) assert.ok(denied.includes(path.join(root, name)));
  assert.equal(denied.includes(path.join(root, 'main.js')), false);
  assert.equal((await executor.boundaries(root, ['report.txt'], new Set(['report.txt']))).includes(path.join(root, 'report.txt')), false);
});
test('stdio requires a workspace and never falls back to a host process', async () => {
  await assert.rejects(new SandboxExecutor().stdio({ command: 'node' }, null), /工作區/);
});

test('parallel sandbox commands reassert distinct scratch directories inside the runtime shell', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ntpu-scratch-space's-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executor = new SandboxExecutor(), calls = [];
  executor.runtime = async () => ({ wrapWithSandboxArgv: async (command, shell, config, signal, cwd, options) => {
    calls.push({ command, config, options }); return { argv: ['/test/runtime'], env: {} };
  }, cleanupAfterCommand() {} });
  executor.readRoots = async () => [];
  const originalTmpdir = process.env.TMPDIR;
  const launches = await Promise.all([executor.prepare(root, root, 'node first.js'), executor.prepare(root, root, 'node second.js')]);
  t.after(async () => { for (const launch of launches) await launch.cleanup(); });
  assert.notEqual(launches[0].env.TMPDIR, launches[1].env.TMPDIR);
  assert.equal(process.env.TMPDIR, originalTmpdir);
  for (const [index, launch] of launches.entries()) {
    const call = calls.find(value => value.options.commandText === `node ${index ? 'second' : 'first'}.js`);
    const prefix = `export TMPDIR=${quote(launch.env.TMPDIR)} TMP=${quote(launch.env.TMPDIR)} TEMP=${quote(launch.env.TMPDIR)}; `;
    assert.equal(call.command, prefix + call.options.commandText);
    assert.ok(call.config.filesystem.allowWrite.includes(launch.env.TMPDIR));
    assert.ok(call.config.filesystem.allowRead.includes(launch.env.TMPDIR));
    assert.equal(call.config.filesystem.allowWrite.includes('/tmp/claude'), false);
  }
});
