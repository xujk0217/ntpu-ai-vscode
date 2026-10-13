'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChangeReview, hunks } = require('../src/change-review');
const { hash } = require('../src/workspace');

async function fixture(t, before, after, created = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-review-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'main.js'); await fs.writeFile(file, after);
  let document, deleted = false, saved = 0;
  const vscode = { Uri: { file: fsPath => ({ fsPath }) }, Range: class {}, WorkspaceEdit: class { replace(uri, range, text) { this.text = text; } },
    workspace: { openTextDocument: async uri => {
      if (!document) { let text = await fs.readFile(uri.fsPath, 'utf8'); document = { isDirty: false, getText: () => text, positionAt: offset => offset,
        replace: value => { text = value; }, save: async () => { await fs.writeFile(uri.fsPath, text); return true; } }; }
      return document;
    }, applyEdit: async edit => { document.replace(edit.text); return true; }, fs: { delete: async (uri, options) => { assert.equal(options.useTrash, true); deleted = true; await fs.unlink(uri.fsPath); } } } };
  const app = { session: { changes: [] }, busy: () => false, workspace: () => ({ uri: { fsPath: root } }), postChanges: () => {}, save: async () => { saved++; } };
  const review = new ChangeReview(app, vscode);
  review.capture({ id: 'c1', taskId: 't1', path: 'main.js', before: created ? null : before, after, afterHash: hash(after), created, saved: true });
  return { review, app, file, read: () => fs.readFile(file, 'utf8'), deleted: () => deleted, saved: () => saved, vscode };
}

test('hunks preserve line endings, missing final newline and unicode while separating independent edits', () => {
  const before = '第一行\r\n相同\r\n第三行', after = '🙂\r\n相同\r\n末行';
  const parts = hunks(before, after); assert.equal(parts.length, 2);
  let restored = after;
  for (const part of [...parts].reverse()) restored = restored.slice(0, part.newOffset) + part.oldText + restored.slice(part.newOffset + part.newText.length);
  assert.equal(restored, before);
});
test('reverting one hunk preserves another edit and its accepted review state', async t => {
  const f = await fixture(t, 'one\nsame\nthree\n', 'ONE\nsame\nTHREE\n');
  const [first, second] = f.review.view()[0].hunks;
  await f.review.act({ id: 'c1', action: 'accept', hunkId: second.id });
  await f.review.act({ id: 'c1', action: 'revert', hunkId: first.id });
  assert.equal(await f.read(), 'one\nsame\nTHREE\n');
  assert.equal(f.review.view()[0].hunks.length, 1); assert.equal(f.review.view()[0].hunks[0].accepted, true);
  await f.review.act({ id: 'c1', action: 'revert', hunkId: second.id });
  assert.equal(await f.read(), 'one\nsame\nthree\n'); assert.equal(f.review.view()[0].reverted, true);
});
test('successive changes in one task aggregate into one file rollback', async t => {
  const f = await fixture(t, 'one\n', 'two\n');
  await fs.writeFile(f.file, 'three\n'); f.review.capture({ id: 'c2', taskId: 't1', path: 'main.js', before: 'two\n', after: 'three\n', afterHash: hash('three\n') });
  assert.equal(f.review.view().length, 1); assert.equal(f.review.find('c1').after, 'three\n');
  await f.review.act({ id: 'c1', action: 'revert' });
  assert.equal(await f.read(), 'one\n'); assert.ok(f.app.session.changes.every(change => change.reverted));
});
test('later user edits and stale hunk IDs never get overwritten', async t => {
  const f = await fixture(t, 'old\n', 'AI\n');
  await fs.writeFile(f.file, 'user\n');
  await assert.rejects(f.review.act({ id: 'c1', action: 'revert' }), /沒有覆蓋/);
  assert.equal(await f.read(), 'user\n'); assert.equal(f.saved(), 0);
  await assert.rejects(f.review.act({ id: 'c1', action: 'revert', hunkId: 'stale' }), /已更新/);
});
test('new file rollback uses trash; accepted files remain reversible', async t => {
  const f = await fixture(t, '', 'created\n', true);
  await f.review.act({ id: 'c1', action: 'accept' }); assert.equal(f.review.view()[0].accepted, true);
  await f.review.act({ id: 'c1', action: 'revert' }); assert.equal(f.deleted(), true);
});
test('busy tasks and redacted snapshots cannot be reverted', async t => {
  const f = await fixture(t, 'old\n', 'AI\n'); f.app.busy = () => true;
  await assert.rejects(f.review.act({ id: 'c1', action: 'revert' }), /停止/);
  f.app.busy = () => false; f.app.session.changes[0].before = '[REDACTED_SECRET]';
  await assert.rejects(f.review.act({ id: 'c1', action: 'revert' }), /遮蔽/);
  assert.equal(await f.read(), 'AI\n');
});
