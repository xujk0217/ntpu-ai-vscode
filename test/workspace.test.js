'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { safePath, numberedLines, fullyRead, diskText } = require('../src/workspace');

test('file tools allow workspace files and new nested files, reject escapes and secrets', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-workspace-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'root');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'main.js'), 'export const x = 1;');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=x');
  await fs.writeFile(path.join(temp, 'outside.txt'), 'outside');
  await fs.symlink(path.join(temp, 'outside.txt'), path.join(root, 'outside-link'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'secret-link'));
  assert.equal(await diskText(await safePath(root, 'main.js')), 'export const x = 1;');
  assert.equal(await safePath(root, 'src/new.js'), path.join(root, 'src/new.js'));
  assert.equal(await safePath(root, '.env.example'), path.join(root, '.env.example'));
  for (const file of ['../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:\\secret', '.env', 'a/../.env',
    '.git/config', 'node_modules/test.js', 'private.pem', 'outside-link', 'secret-link']) {
    await assert.rejects(safePath(root, file), undefined, file);
  }
});

test('line budgets preserve actual line coverage rather than pretending to read truncated content', () => {
  const result = numberedLines('abc\ndef\nghi', 1, undefined, 8);
  assert.equal(result.text, '1: abc');
  assert.equal(result.end_line, 1);
  assert.equal(result.total_lines, 3);
  assert.equal(result.truncated, true);
  assert.equal(fullyRead({ ranges: [[1, 1]], totalLines: 3 }), false);
  assert.equal(fullyRead({ ranges: [[2, 3], [1, 1]], totalLines: 3 }), true);
  assert.equal(fullyRead({ ranges: [[1, 1], [3, 3]], totalLines: 3 }), false);
  assert.throws(() => numberedLines('x', 0), /行號/);
});
