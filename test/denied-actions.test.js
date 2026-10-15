'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { previouslyDenied } = require('../src/denied-actions');
const { runAgent } = require('../src/agent');

test('denied tool identities survive argument key ordering and differ from genuinely different actions', () => {
  const records = [{ type: 'tool', name: 'write_file', args: { path: 'a.js', content: '42' }, result: { ok: false, denied: true } }];
  assert.equal(previouslyDenied(records, 'write_file', { content: '42', path: 'a.js' }), true);
  assert.equal(previouslyDenied(records, 'write_file', { path: 'b.js', content: '42' }), false);
  assert.equal(previouslyDenied(records, 'read_file', { path: 'a.js' }), false);
});

test('an old denied command cannot execute again even when its full tool record is omitted from the prompt', async () => {
  let executed = 0, step = 0;
  const records = [{ type: 'tool', name: 'run_command', args: { command: 'do-not-run-again', cwd: '.' }, result: { ok: false, denied: true } },
    ...Array.from({ length: 50 }, () => ({ type: 'tool', name: 'read_file', result: { ok: true, text: 'noise '.repeat(3000) } }))];
  const result = await runAgent({ request: '繼續', initialRecords: records, budget: 16000, signal: new AbortController().signal,
    tools: { execute: async () => { executed++; return { ok: true }; } },
    bridge: { chat: async () => ({ text: JSON.stringify(++step === 1 ?
      { kind: 'tool', name: 'run_command', args: { cwd: '.', command: 'do-not-run-again' } } :
      { kind: 'final', completed: false, message: '先前拒絕的操作沒有再執行。' }) }) },
  });
  assert.equal(executed, 0); assert.equal(result.completed, false);
});

test('parallel read batches also honor earlier denials while allowing a different independent read', async () => {
  const executed = []; let step = 0;
  await runAgent({ request: '繼續讀取', signal: new AbortController().signal,
    initialRecords: [{ type: 'tool', name: 'read_file', args: { path: 'private.csv' }, result: { ok: false, denied: true } }],
    tools: { catalog: () => [{ name: 'read_file' }], parallelNames: () => new Set(['read_file']),
      execute: async (name, args) => { executed.push(args.path); return { ok: true }; } },
    bridge: { chat: async () => ({ text: JSON.stringify(++step === 1 ? { kind: 'parallel', tools: [
      { name: 'read_file', args: { path: 'private.csv' } }, { name: 'read_file', args: { path: 'public.js' } },
    ] } : { kind: 'final', completed: false, message: '僅讀取已允許的檔案。' }) }) },
  });
  assert.deepEqual(executed, ['public.js']);
});
