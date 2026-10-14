'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {AdaptiveConcurrency}=require('../src/adaptive-concurrency');const {RequestScheduler}=require('../src/parallel');const {RequestRateGate}=require('../src/request-rate');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const healthy=(controller,count=8)=>{for(let i=0;i<count;i++)controller.observe({success:true,firstTokenMs:1000,durationMs:5000});};
test('no proof or lease: starts at two, ramps on eight stable samples, caps at four with hysteresis',()=>{
 let time=0;const c=new AdaptiveConcurrency({now:()=>time});assert.equal(c.limit,2);healthy(c,7);assert.equal(c.limit,2);healthy(c,1);assert.equal(c.limit,3);
 healthy(c);assert.equal(c.limit,3);time=10001;healthy(c,1);assert.equal(c.limit,4);time+=10001;healthy(c);assert.equal(c.limit,4);assert.equal(c.state().workerConcurrency,4);
 c.configure(1);assert.equal(c.limit,1);c.configure(99);assert.equal(c.ceiling,4);
});
test('single outlier/error and cancellations do not cause downgrade; repeated latency or failures do',()=>{
 const c=new AdaptiveConcurrency({cooldownMs:0});healthy(c);assert.equal(c.limit,3);
 c.observe({success:true,firstTokenMs:50000,durationMs:150000});healthy(c,5);assert.equal(c.limit,3);
 c.observe({success:false,error:new Error('socket reset')});assert.equal(c.limit,3);
 c.observe({success:false,error:new Error('timeout')});assert.equal(c.limit,2);
 const before=c.samples.length;c.observe({success:false,cancelled:true,error:new Error('aborted')});assert.equal(c.samples.length,before);
 for(let i=0;i<3;i++)c.observe({success:true,firstTokenMs:50000,durationMs:150000});healthy(c,3);assert.equal(c.limit,1);
 healthy(c);assert.equal(c.limit,2);
});
test('service limits latch at one, successes cannot resume, manual resume does not retry',()=>{
 for(const status of [401,403,429,503]){const c=new AdaptiveConcurrency({cooldownMs:0});c.observe({success:false,error:Object.assign(new Error('service'),{status})});assert.equal(c.limit,1);assert.equal(c.blocked,true);healthy(c,30);assert.equal(c.limit,1);c.resume();assert.equal(c.blocked,false);assert.equal(c.limit,1);healthy(c);assert.equal(c.limit,2);}
});
test('large code replies and sequential reasoning do not count as parallel congestion',()=>{
 const large=new AdaptiveConcurrency({cooldownMs:0});healthy(large);
 for(let i=0;i<8;i++)large.observe({success:true,firstTokenMs:85000,durationMs:95000,responseCharacters:10000,promptCharacters:28000,concurrentRequests:2,maxTokenGapMs:500});
 assert.equal(large.limit,4);
 const sequential=new AdaptiveConcurrency({cooldownMs:0});healthy(sequential);
 for(let i=0;i<8;i++)sequential.observe({success:true,firstTokenMs:85000,durationMs:150000,concurrentRequests:1});
 assert.equal(sequential.limit,4);
});
test('repeated real stream stalls and empty provider failures still cause a bounded downgrade',()=>{
 const stalled=new AdaptiveConcurrency({cooldownMs:0});healthy(stalled);
 for(let i=0;i<3;i++)stalled.observe({success:true,firstTokenMs:1000,durationMs:95000,responseCharacters:10000,concurrentRequests:2,maxTokenGapMs:45000});
 healthy(stalled,3);assert.equal(stalled.limit,2);
 const empty=new AdaptiveConcurrency({cooldownMs:0});healthy(empty,4);
 for(let i=0;i<2;i++)empty.observe({success:false,error:Object.assign(new Error('empty'),{code:'EMPTY_MODEL_RESPONSE'})});
 assert.equal(empty.limit,1);assert.match(empty.reason,/模型請求失敗/);
});
test('adaptive downgrade at the floor stays at one instead of wrapping to four',()=>{
 const c=new AdaptiveConcurrency({cooldownMs:0});c.configure(1);
 for(let i=0;i<6;i++)c.observe({success:i>=2,firstTokenMs:i>=2?1000:null,durationMs:i>=2?5000:null,error:i<2?Object.assign(new Error('empty'),{code:'EMPTY_MODEL_RESPONSE'}):undefined});
 assert.equal(c.limit,1);assert.deepEqual(c.decisions.at(-1),{at:c.lastChange,from:1,to:1,reason:'近期多筆模型請求失敗，降低新請求名額'});
});
test('FIFO queue honors a reduced limit without cancelling started calls and cancellation removes only queued job',async()=>{
 const c=new AdaptiveConcurrency({cooldownMs:0}),s=new RequestScheduler(2,()=>{},{adaptive:c});const started=[],release=[];
 const call=i=>s.run(()=>{started.push(i);return new Promise(resolve=>release.push(resolve));});
 const a=call(0),b=call(1);const abort=new AbortController();const cancelled=s.run(()=>started.push('cancelled'),abort.signal);const rejected=assert.rejects(cancelled,/已停止/);const d=call(3);
 await tick();assert.deepEqual(started,[0,1]);assert.equal(s.state().queuedRequests,2);abort.abort();await rejected;c.change(1,'fixture decrease');release[0]();await a;await tick();assert.deepEqual(started,[0,1]);release[1]();await b;await tick();assert.deepEqual(started,[0,1,3]);release[2]();await d;s.close();
});
test('429 blocks new work immediately, preserves already started calls unless caller cancels, no retries',async()=>{
 const c=new AdaptiveConcurrency(),s=new RequestScheduler(2,()=>{},{adaptive:c});let count=0,release;
 const a=s.run(async()=>{count++;throw Object.assign(new Error('rate limited'),{status:429});});const b=s.run(()=>{count++;return new Promise(resolve=>{release=resolve;});});const queued=s.run(()=>{count++;});
 const ra=assert.rejects(a,/rate/),rq=assert.rejects(queued,/rate/);await tick();await Promise.all([ra,rq]);assert.equal(count,2);assert.equal(c.limit,1);assert.equal(s.state().queuedRequests,0);release();await b;await assert.rejects(s.run(()=>count++),/rate/);assert.equal(count,2);s.close();
});
test('rate-waiting head is queued, downgrade during pacing rechecks slot, abort sends no model request',async()=>{
 const gate=new RequestRateGate(1,{windowMs:1000}),c=new AdaptiveConcurrency(),s=new RequestScheduler(2,()=>{},{adaptive:c,rateGate:gate});await gate.acquire();const abort=new AbortController();let attempts=0;
 const p=s.run(()=>attempts++,abort.signal),rejected=assert.rejects(p,/已停止/);await tick();assert.equal(s.active,0);assert.equal(s.state().queuedRequests,1);c.change(1,'slow');abort.abort();await rejected;await tick();assert.equal(attempts,0);assert.equal(s.queue.length,0);s.close();gate.close();
});
test('bridge metrics use send-to-first-token and completion, excluding rate/queue waits',async()=>{
 let time=0;const c=new AdaptiveConcurrency({now:()=>time,cooldownMs:0}),s=new RequestScheduler(2,()=>{},{adaptive:c,now:()=>time});
 const bridge=s.bridge({chat:async(_,options)=>{time+=1000;options.onOpen();options.onToken('token');time+=5000;return {text:'ok'};}});
 for(let i=0;i<8;i++)await bridge.chat('synthetic');assert.equal(c.limit,3);assert.equal(c.baseline.firstTokenMs,1000);assert.equal(c.baseline.durationMs,6000);assert.equal(s.requests,8);s.close();
});

test('increasing the adaptive limit drains existing FIFO work without creating new requests',async()=>{
 const c=new AdaptiveConcurrency({cooldownMs:0}),s=new RequestScheduler(2,()=>{},{adaptive:c});const started=[],release=[];
 const pending=[0,1,2,3].map(i=>s.run(()=>{started.push(i);return new Promise(resolve=>release.push(resolve));}));await tick();assert.deepEqual(started,[0,1]);healthy(c);await tick();assert.deepEqual(started,[0,1,2]);assert.equal(s.queue.length,1);release[0]();await tick();assert.deepEqual(started,[0,1,2,3]);release.slice(1).forEach(resolve=>resolve());await Promise.all(pending);assert.equal(s.requests,4);s.close();
});
test('missing streaming timing cannot cause an optimistic ramp, and manual ceiling is respected',()=>{
 const c=new AdaptiveConcurrency({cooldownMs:0});for(let i=0;i<20;i++)c.observe({success:true,firstTokenMs:null,durationMs:100});assert.equal(c.limit,2);c.configure(2);healthy(c,30);assert.equal(c.limit,2);
});
