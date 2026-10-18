'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { responseWatchdog } = require('../src/browser/response-watchdog');

function fixture(idleMs = 100) {
  let at = 0, callback, deadline; const failures = [];
  const watch = responseWatchdog({ idleMs, now: () => at, schedule: (fn, delay) => { callback = fn; deadline = at + delay; return 1; }, cancel: () => { callback = undefined; }, onTimeout: code => failures.push(code) });
  const advance = time => { at = time; if (callback && deadline <= at) { const fn = callback; callback = undefined; fn(); } };
  return { watch, failures, advance };
}

test('answer progress extends idle waiting while silent streams still time out', () => {
  const f = fixture(); f.advance(90); f.watch.progress(); f.advance(100); assert.deepEqual(f.failures, []);
  f.advance(180); f.watch.progress(); f.advance(190); assert.deepEqual(f.failures, []);
  f.advance(280); assert.deepEqual(f.failures, ['IDLE_RESPONSE_TIMEOUT']);
});
test('continuous streaming remains bounded by a total ceiling', () => {
  const f = fixture(); for (const at of [90, 180, 270, 360]) { f.advance(at); f.watch.progress(); }
  f.advance(400); assert.deepEqual(f.failures, ['TOTAL_RESPONSE_TIMEOUT']);
  f.advance(500); assert.equal(f.failures.length, 1);
});
test('stopping the watchdog prevents later timeouts or progress from rearming it', () => {
  const f = fixture(); f.watch.stop(); f.watch.progress(); f.advance(500); assert.deepEqual(f.failures, []);
});

test('600-second evaluation accepts first content after 240 seconds and still bounds silent requests', () => {
  const slow = fixture(600000);
  slow.advance(240001); assert.deepEqual(slow.failures, []);
  slow.advance(450000); slow.watch.progress();
  slow.advance(600000); assert.deepEqual(slow.failures, []);
  slow.watch.stop();
  const silent = fixture(600000);
  silent.advance(599999); assert.deepEqual(silent.failures, []);
  silent.advance(600000); assert.deepEqual(silent.failures, ['IDLE_RESPONSE_TIMEOUT']);
});

test('600-second streaming keeps the documented 15-minute total ceiling', () => {
  const f = fixture(600000);
  f.advance(450000); f.watch.progress(); f.advance(600000); f.watch.progress();
  f.advance(899999); f.watch.progress(); assert.deepEqual(f.failures, []);
  f.advance(900000); assert.deepEqual(f.failures, ['TOTAL_RESPONSE_TIMEOUT']);
});
