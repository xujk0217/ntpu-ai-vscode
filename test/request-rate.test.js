'use strict';
const { test }=require('node:test');const assert=require('node:assert/strict');
const { RequestRateGate }=require('../src/request-rate');const { RequestScheduler }=require('../src/parallel');
test('shared rate gate defers later requests instead of retrying or exceeding the window',async()=>{
 const gate=new RequestRateGate(2,{windowMs:30});const waits=[];await gate.acquire();await gate.acquire();const start=Date.now();await gate.acquire(undefined,1,ms=>waits.push(ms));assert(Date.now()-start>=20);assert(waits.length);assert(gate.timestamps.length>=1&&gate.timestamps.length<=2);gate.close();
});
test('rate reservation is atomic for a diagnostic group and waiting cancellation sends nothing',async()=>{
 const gate=new RequestRateGate(5,{windowMs:100});await gate.acquire(undefined,3);const controller=new AbortController();let started=false;
 const pending=gate.acquire(controller.signal,3).then(()=>{started=true;});const rejection=assert.rejects(pending,/已停止/);controller.abort();await rejection;assert.equal(started,false);assert.equal(gate.timestamps.length,3);await assert.rejects(gate.acquire(undefined,6),/本機/);gate.close();
});
test('five agent requests share both concurrency and pacing, with accurate stream counters',async()=>{
 const gate=new RequestRateGate(5,{windowMs:25}),scheduler=new RequestScheduler(5,()=>{},{rateGate:gate});let attempts=0,active=0,peak=0;
 const bridge=scheduler.bridge({chat:async(_,options)=>{attempts++;peak=Math.max(peak,++active);options.onOpen();await new Promise(resolve=>setTimeout(resolve,8));active--;return {text:'ok'};}});
 await Promise.all(Array.from({length:7},()=>bridge.chat('fixture')));assert.equal(attempts,7);assert.equal(peak,4);assert.equal(scheduler.peakStreams,4);assert.equal(scheduler.streamActive,0);assert.equal(scheduler.requests,7);gate.close();
});
test('aborting a task while pacing prevents queued model calls and cleanup rejects waiting entries',async()=>{
 const gate=new RequestRateGate(1,{windowMs:100}),controller=new AbortController();await gate.acquire();let calls=0;
 const scheduler=new RequestScheduler(5,()=>{},{rateGate:gate});const pending=scheduler.run(()=>{calls++;},controller.signal);const rejection=assert.rejects(pending,/已停止/);
 await new Promise(resolve=>setImmediate(resolve));controller.abort();await rejection;assert.equal(calls,0);
 const waiting=gate.acquire();const closed=assert.rejects(waiting,/已停止/);gate.close();await closed;
});
