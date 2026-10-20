'use strict';
// Only the synthetic AppKit window created here is selected or captured.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { ComputerController, macDesktopCall } = require('../src/computer/controller');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function read(file) { for (let i = 0; i < 100; i++) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; await sleep(100); } } throw new Error('Synthetic AppKit fixture timed out: ' + path.basename(file)); }
async function main() {
  if (process.platform !== 'darwin') throw new Error('This acceptance requires a local macOS desktop.');
  const permissions = await macDesktopCall({ op: 'status' });
  assert.ok(permissions.screenRecording && permissions.accessibility, 'Enable Screen Recording and Accessibility for the host app first.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-macos-desktop-'));
  const contents = path.join(directory, 'Fixture.app', 'Contents'); await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>tw.ntpu.synthetic.ComputerFixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>NTPUComputerUseFixture</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', path.join(os.tmpdir(), 'ntpu-swift-module-cache'), path.join(__dirname, 'fixtures/computer-window-macos.swift'), '-o', path.join(contents, 'MacOS', 'Fixture')]);
  const child = spawn(path.join(contents, 'MacOS', 'Fixture'), [directory], { stdio: 'ignore' });
  const controller = new ComputerController({ directory, approve: async () => true,
    selectWindow: async windows => windows.find(w => w.id === ready.id && w.bundle === 'tw.ntpu.synthetic.ComputerFixture'),
    desktop: async (message, options) => {
      try { return await macDesktopCall(message, options); } catch (error) { throw new Error(`Synthetic fixture ${message.op}/${message.action || ''}: ${error.message}`); }
    },
    image: async buffer => { assert.equal(buffer.subarray(1, 4).toString(), 'PNG'); return { analysis: 'Synthetic selected-window capture; result checked separately by fixture receipts.' }; } });
  let ready;
  const signal = new AbortController().signal;
  try {
    ready = await read(path.join(directory, 'ready.json'));
    assert.equal((await controller.open({ mode: 'desktop' }, signal)).controlled, true);
    let seen = await controller.observe({}, signal);
    for (const args of [{ action: 'click', ...ready.entry }, { action: 'type', text: '中文 FixtureABC123' }, { action: 'key', key: 'Tab' }, { action: 'click', ...ready.button }]) {
      console.log('Synthetic action: ' + args.action); await controller.action({ ...args, observation: seen.observation }, signal); await sleep(150); seen = await controller.observe({}, signal);
    }
    assert.deepEqual(await read(path.join(directory, 'receipt.json')), { text: '中文 FixtureABC123', clicked: true });
    await controller.action({ action: 'scroll', ...ready.scroll, direction: 'down', count: 3, observation: seen.observation }, signal);
    assert.equal((await read(path.join(directory, 'scroll.json'))).scrolled, true); seen = await controller.observe({}, signal);
    await assert.rejects(controller.action({ action: 'click', x: -1, y: 10, observation: seen.observation }, signal), /座標/); seen = await controller.observe({}, signal);
    await fs.writeFile(path.join(directory, 'move'), ''); await read(path.join(directory, 'moved.json'));
    await assert.rejects(controller.action({ action: 'click', ...ready.button, observation: seen.observation }, signal), /位置或大小/);
    seen = await controller.observe({}, signal);
    await assert.rejects(controller.action({ action: 'key', key: 'Enter', observation: seen.observation }, AbortSignal.abort()), /停止/);
    const abort = new AbortController();
    const pending = controller.action({ action: 'type', text: 'A'.repeat(1000), observation: seen.observation }, abort.signal);
    const timer = setTimeout(() => abort.abort(), 250);
    await assert.rejects(pending, /停止/); clearTimeout(timer); await sleep(150);
    seen = await controller.observe({}, signal);
    await controller.action({ action: 'click', ...ready.entry, observation: seen.observation }, signal).catch(error => { throw error; });
    seen = await controller.observe({}, signal);
    await controller.action({ action: 'type', text: 'OK', observation: seen.observation }, signal);
    seen = await controller.observe({}, signal);
    await fs.rm(path.join(directory, 'receipt.json'));
    await controller.action({ action: 'click', ...ready.button, observation: seen.observation }, signal);
    assert.ok((await read(path.join(directory, 'receipt.json'))).text.includes('OK'));
    await fs.writeFile(path.join(directory, 'secure'), ''); await read(path.join(directory, 'secure.json'));
    await assert.rejects(controller.observe({}, signal), /登入|密碼|驗證/);
    await controller.close(); child.kill(); await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    await assert.rejects(macDesktopCall({ op: 'observe', id: ready.id, identity: controller.window }), /關閉|禁止/);
    console.log(JSON.stringify({ fixture: 'macOS-selected-AppKit-window', architecture: process.arch, capture: true, unicode: true, click: true, key: true, scroll: true, staleGeometryDenied: true, outsideCoordinatesDenied: true, cancellation: true, closedWindowDenied: true, inFlightCancellation: true, subsequentInputRecovered: true, secureFieldDenied: true, schoolRequests: 0 }));
  } catch (error) { try { console.error('Synthetic event receipt: ' + await fs.readFile(path.join(directory, 'last-event.json'), 'utf8')); } catch {} throw error; } finally { await controller.dispose(); if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } await fs.rm(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
