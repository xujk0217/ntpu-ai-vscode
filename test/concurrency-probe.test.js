'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeConcurrency, peakStreams } = require('../src/browser/concurrency-probe');
const { concurrencyLimit } = require('../src/parallel-policy');
function fixture(behavior = () => ({})) {
  const created = [], closed = [], calls = []; let count = 0;
  const bridge = { createChannel: async () => {
    const id = created.length; created.push(id);
    return { close: async options => closed.push({ id, ...options }), chat: async (prompt, options) => {
      const marker = prompt.match(/NTPU_PARALLEL_[a-f0-9]+_\d/)?.[0], index = Number(marker.at(-1));
      calls.push({ count, index }); const mode = behavior(count,index);
      if (options.signal.aborted) throw new Error('已停止');
      if (mode.error) throw Object.assign(new Error(mode.error), { status: mode.status });
      if (!mode.lateOpen) { options.onOpen(); options.onToken(); }
      await new Promise((resolve,reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('已停止')); };
        const timer = setTimeout(() => { options.signal.removeEventListener('abort',abort); resolve(); }, 12);
        options.signal.addEventListener('abort',abort,{once:true});
      });
      if (mode.lateOpen) { options.onOpen(); options.onToken(); }
      if (mode.cancel) mode.cancel();
      return { text: mode.crossTalk ? marker + ' ' + marker.slice(0,-1) + ((index+1)%count) : mode.mismatch ? 'wrong reply' : marker };
    } };
  } };
  const options = { groupPauseMs: 0, onProgress: text => { const match=text.match(/正在建立 (\d)/);if(match)count=Number(match[1]); } };
  return { bridge, options, created, closed, calls };
}
test('progressive probe independently verifies 2,3,4,5 streams and stores only bounded metrics', async () => {
  const f=fixture();const groups=[];
  const result=await probeConcurrency(f.bridge,{...f.options,onGroup:async group=>groups.push(group)});
  assert.deepEqual(groups.map(group=>group.concurrency),[2,3,4,5]);assert.equal(f.created.length,14);assert.equal(f.closed.length,14);
  assert.equal(result.recommendedConcurrency,5);assert.equal(result.verified,true);
  for(const group of groups){assert.equal(group.successRate,1);assert.equal(group.observedPeakConcurrency,group.concurrency);assert.equal(group.streamOverlap,true);assert(group.requests.every(request=>request.durationMs>=0&&request.firstTokenMs>=0));}
  assert.doesNotMatch(JSON.stringify(result),/NTPU_PARALLEL_/);
});
test('429 after a successful lower group stops all peers and prevents 4 or 5, forcing safe fallback', async () => {
  const f=fixture((count,index)=>count===3&&index===0?{error:'quota exceeded',status:429}:{});
  const result=await probeConcurrency(f.bridge,f.options);
  assert.deepEqual(result.groups.map(group=>group.concurrency),[2,3]);assert.equal(f.created.length,5);assert.equal(f.closed.length,5);
  assert.equal(result.maxVerifiedConcurrency,2);assert.equal(result.recommendedConcurrency,1);assert.equal(result.verified,false);assert.equal(result.serviceLimited,true);
  assert.equal(result.groups[1].requests[0].httpStatus,429);assert(f.closed.slice(2).every(channel=>channel.cleanup===false));
});
test('login expiry and other provider restrictions halt without retries', async () => {
  for(const status of [401,403,503]){const f=fixture((_,index)=>index===0?{error:'provider failure',status}:{});const result=await probeConcurrency(f.bridge,f.options);assert.equal(result.groups.length,1);assert.equal(result.recommendedConcurrency,1);assert.equal(result.serviceLimited,true);assert.equal(f.calls.length,2);}
});
test('cross-talk cannot raise concurrency and ordinary failure retains only proven lower groups', async () => {
  for(const mode of [{crossTalk:true},{mismatch:true},{error:'connection closed',status:502}]){
    const f=fixture((count,index)=>count===4&&index===0?mode:{});const result=await probeConcurrency(f.bridge,f.options);
    assert.deepEqual(result.groups.map(group=>group.concurrency),[2,3,4]);assert.equal(result.recommendedConcurrency,3);assert.equal(result.verified,true);assert.equal(f.created.length,9);
    assert(result.groups.at(-1).requests.some(request=>request.error));
  }
});
test('all-request overlap is required, not just overlapping promises or two streams', () => {
  assert.equal(peakStreams([{openedAt:10,endedAt:20},{openedAt:20,endedAt:30}]),1);
  assert.equal(peakStreams([{openedAt:10,endedAt:25},{openedAt:20,endedAt:30},{openedAt:27,endedAt:40}]),2);
});
test('cancellation before or during a group closes created pages and never promotes partial proof', async () => {
  const before=new AbortController();before.abort();const f=fixture();let result=await probeConcurrency(f.bridge,{...f.options,signal:before.signal});assert.equal(f.created.length,0);assert.equal(result.recommendedConcurrency,1);
  const controller=new AbortController();const during=fixture((count,index)=>count===3&&index===0?{cancel:()=>controller.abort()}:{});
  result=await probeConcurrency(during.bridge,{...during.options,signal:controller.signal});assert.equal(result.cancelled,true);assert.equal(result.recommendedConcurrency,1);assert.equal(during.closed.length,during.created.length);assert.equal(result.groups.length,2);
});
test('bootstrap failure closes earlier pages; a configured probe ceiling is honored', async () => {
  const f=fixture();const create=f.bridge.createChannel;f.bridge.createChannel=async()=>{if(f.created.length===1)throw Object.assign(new Error('login required'),{status:403});return create();};
  const result=await probeConcurrency(f.bridge,f.options);assert.equal(result.groups.length,1);assert.equal(f.closed.length,1);assert.equal(result.serviceLimited,true);assert.equal(result.groups[0].requests.length,2);
  const short=fixture();const limited=await probeConcurrency(short.bridge,{...short.options,maxConcurrency:3});assert.equal(limited.recommendedConcurrency,3);assert.equal(short.calls.length,5);
});
test('successful replies with non-overlapping streams do not raise the automatic limit', async () => {
  const f=fixture(()=>({lateOpen:true})); const result=await probeConcurrency(f.bridge,f.options);
  assert.equal(result.groups.length,1);assert.equal(result.groups[0].successful,true);assert.equal(result.groups[0].streamOverlap,false);assert.equal(result.recommendedConcurrency,1);assert.equal(result.groups[0].stopReason,'no_overlap');
});

test('group pacing is bounded and can be cancelled without launching the next group', async () => {
  const controller=new AbortController(),f=fixture();const result=await probeConcurrency(f.bridge,{...f.options,signal:controller.signal,groupPauseMs:100,
    onProgress:text=>{f.options.onProgress(text);if(text.includes('等待'))controller.abort();}});
  assert.equal(result.groups.length,1);assert.equal(result.cancelled,true);assert.equal(f.calls.length,2);assert.equal(result.recommendedConcurrency,1);
  const paced=fixture();const starts=[];await probeConcurrency(paced.bridge,{...paced.options,maxConcurrency:3,groupPauseMs:20,onGroup:async()=>starts.push(Date.now())});
  assert(starts[1]-starts[0]>=20);
});

test('focused five-stream test reuses only verified lower groups and does not renew their lease',async()=>{
 const lower=fixture();const initial=await probeConcurrency(lower.bridge,{...lower.options,maxConcurrency:4});
 const focused=fixture();const result=await probeConcurrency(focused.bridge,{...focused.options,initialGroups:initial.groups,responseLines:60});
 assert.equal(focused.calls.length,5);assert.equal(focused.created.length,5);assert.equal(result.recommendedConcurrency,5);assert.equal(result.groups.at(-1).responseLines,60);assert.equal(result.timestamp,initial.groups[0].measuredAt);assert(result.groups.slice(0,3).every(group=>group.reused));
 await assert.rejects(probeConcurrency(focused.bridge,{...focused.options,initialGroups:[initial.groups[1]]}),/不連續/);
});
