'use strict';
// Expand the file list in Node instead of relying on POSIX shell globs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const files = fs.readdirSync(path.join(__dirname, '..', 'test')).filter(name => name.endsWith('.test.js')).sort()
  .map(name => path.join(__dirname, '..', 'test', name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status || 0;
