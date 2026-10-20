'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
function buildMacDesktop() {
  if (process.platform !== 'darwin') return;
  const output = path.resolve(__dirname, '../src/computer/bin/desktop-macos');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', architecture + '-apple-macosx12.0', '-module-cache-path', path.join(require('node:os').tmpdir(), 'ntpu-swift-module-cache'), path.resolve(__dirname, '../src/computer/desktop-macos.swift'), '-o', output], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('macOS 桌面後端編譯失敗；打包主機需安裝 Xcode Command Line Tools。');
  fs.chmodSync(output, 0o755);
}
if (require.main === module) buildMacDesktop();
module.exports = { buildMacDesktop };
