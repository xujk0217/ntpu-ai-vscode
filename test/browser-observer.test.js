'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installStreamObserver } = require('../src/browser');

function observer(fetch, receive) {
  const window = { fetch, binding: receive };
  const environment = { window, location: { href: 'https://ai.ntpu.edu.tw/', origin: 'https://ai.ntpu.edu.tw' },
    URL, AbortController, TextDecoder };
  vm.runInNewContext(`(${installStreamObserver.toString()})('binding')`, environment);
  window.__ntpuLocalBridge.active = 'owned-request';
  return window;
}

test('observer preserves website stream and reconstructs split SSE lines including final unterminated line', async () => {
  const events = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const input = 'data: {"type":"token","content":"程式"}\r\n\r\ndata: {"type":"done"}';
  const bytes = new TextEncoder().encode(input);
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 39)); controller.enqueue(bytes.slice(39)); controller.close();
  } }));
  const window = observer(async () => response, async payload => { events.push(payload); if (payload.event?.type === 'done') finish(); });
  const original = await window.fetch('/chat/stream', { method: 'POST' });
  assert.equal(await original.text(), input);
  await done;
  assert.equal(events.map(event => event.event?.content || '').join(''), '程式');
  assert.equal(events.at(-1).id, 'owned-request');
});

test('HTTP auth errors are reported without retrying and unrelated origins are not observed', async () => {
  const events = [];
  let calls = 0;
  const window = observer(async () => { calls++; return new Response('{"detail":"登入失效"}', { status: 403 }); },
    async payload => events.push(payload));
  await window.fetch('/chat/stream', { method: 'POST' });
  assert.equal(calls, 1);
  assert.equal(events[0].status, 403);
  assert.equal(events[0].message, '登入失效');
  events.length = 0;
  await window.fetch('https://other.example/chat/stream');
  assert.equal(events.length, 0);
});
test('reinstalling an observer changes its binding without wrapping fetch a second time', async () => {
  const old = [], next = [];
  const window = observer(async () => new Response('data: {"type":"done"}\n\n'), async payload => old.push(payload));
  const wrapped = window.fetch; window.next = async payload => next.push(payload);
  vm.runInNewContext(`(${installStreamObserver.toString()})('next')`, { window });
  assert.equal(window.fetch, wrapped);
  await (await window.fetch('/chat/stream')).text();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(old.length, 0); assert.equal(next[0].kind, 'opened');
});

test('observer reports only session identity for an owned UI request, never its credentials', async () => {
  const events=[];const window=observer(async()=>new Response('',{status:200}),async payload=>events.push(payload));
  await window.fetch('/chat/stream',{method:'POST',body:JSON.stringify({session_id:'task-owned-1',message:'private prompt'}),headers:{Authorization:'Bearer secret'}});
  assert(events.some(event=>event.kind==='conversation'&&event.sessionId==='task-owned-1'));
  assert.doesNotMatch(JSON.stringify(events),/private prompt|Bearer|secret/);
});
