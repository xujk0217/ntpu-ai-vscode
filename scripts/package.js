'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');

async function main() {
  const host = process.platform + '-' + process.arch;
  const argument = process.argv.indexOf('--target'); const target = argument >= 0 ? process.argv[argument + 1] : host;
  if (!['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'].includes(target)) throw new Error('目前僅打包 Windows x64、macOS arm64／x64、Linux x64。');
  if (target !== host) throw new Error('sharp 是原生依賴，請在目標平台的 CI／主機打包，不可直接重標本機二進位套件。');
  if (process.platform === 'darwin') require('./build-macos-desktop').buildMacDesktop();
  const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#fff' } }).png().toBuffer();
  if ((await sharp(image).metadata()).width !== 1) throw new Error('sharp 原生依賴驗證失敗。');
  const manifest = require.resolve('@vscode/vsce/package.json'); const cli = path.join(path.dirname(manifest), require(manifest).bin.vsce);
  const result = spawnSync(process.execPath, [cli, 'package', '--target', target], { stdio: 'inherit' });
  if (result.error) throw result.error; if (result.status !== 0) process.exitCode = result.status || 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
