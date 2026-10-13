'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalGate } = require('../src/approval');

test('approval is bound to a single proposal and stale grants cannot authorize another write', async () => {
  const gate = new ApprovalGate(() => {});
  const signal = new AbortController().signal;
  const first = gate.request({ title: 'first', accept: 'apply' }, signal);
  const oldId = gate.state().id;
  assert.equal(gate.decide('foreign-id', true), false);
  assert.equal(gate.decide(oldId, true), true);
  assert.equal(await first, 'apply');
  const second = gate.request({ title: 'second', accept: 'apply' }, signal);
  assert.equal(gate.decide(oldId, true), false);
  assert.equal(gate.decide(gate.state().id, false), true);
  assert.equal(await second, undefined);
});

test('stop clears a pending approval without approving its operation', async () => {
  const controller = new AbortController();
  const gate = new ApprovalGate(() => {});
  const answer = gate.request({ title: 'write', accept: 'apply' }, controller.signal);
  const id = gate.state().id;
  controller.abort();
  assert.equal(await answer, undefined);
  assert.equal(gate.state(), null);
  assert.equal(gate.decide(id, true), false);
});

test('parallel approvals are serialized and stale approval cannot grant the next request', async () => {
  const gate = new ApprovalGate(() => {}), controller = new AbortController();
  const a = gate.request({ title: 'a', accept: 'allow-a' }, controller.signal);
  const old = gate.state().id;
  const b = gate.request({ title: 'b', accept: 'allow-b' }, controller.signal);
  assert.equal(gate.state().title, 'a'); gate.decide(old, true); assert.equal(await a, 'allow-a');
  assert.equal(gate.state().title, 'b'); assert.equal(gate.decide(old, true), false);
  controller.abort(); assert.equal(await b, undefined); assert.equal(gate.state(), null);
});
test('cancelling a queued approval preserves the active request', async () => {
  const gate = new ApprovalGate(() => {}), a = new AbortController(), b = new AbortController();
  const first = gate.request({ title: 'a', accept: 'ok' }, a.signal);
  const second = gate.request({ title: 'b', accept: 'ok' }, b.signal); b.abort();
  assert.equal(await second, undefined); assert.equal(gate.state().title, 'a');
  gate.decide(gate.state().id,true); assert.equal(await first,'ok'); assert.equal(gate.state(),null);
});
