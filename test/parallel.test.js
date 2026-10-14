'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestScheduler, ModelBudget, runReadBatch } = require('../src/parallel');
const { parseReply } = require('../src/protocol');
const { AgentWorkers, readonly } = require('../src/agent-workers');
const { runAgent } = require('../src/agent');
const turn = () => new Promise(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;
test('read batch truly overlaps, retains ordered results and forbids writes', async () => {
  let active = 0, peak = 0; const events = [];
  const tools = { catalog: () => [{ name: 'read_file' }], execute: async (_, args) => { peak = Math.max(peak, ++active); await turn(); active--; return { ok: true, path: args.path }; } };
  const records = await runReadBatch(['a','b'].map(path => ({ name: 'read_file', args: { path } })), { tools, signal: signal(), onTool: event => events.push(event) });
  assert.equal(peak, 2); assert.deepEqual(records.map(record => record.result.path), ['a','b']); assert.equal(events.length, 4);
  await assert.rejects(runReadBatch([{ name: 'write_file' }, { name: 'read_file' }], { tools, signal: signal(), onTool() {} }));
  for (const name of ['write_file','run_command','update_plan','inspect_image','delegate_tasks','mcp_unknown']) assert.throws(() => parseReply(JSON.stringify({ kind: 'parallel', tools: [{ name, args: {} }, { name: 'read_file', args: {} }] }), new Set([name,'read_file']), new Set(['read_file'])));
});
test('global scheduler limits all bridges to two requests and removes cancelled queue entries', async () => {
  const scheduler = new RequestScheduler(2); let active = 0, peak = 0; const releases = [];
  const work = () => new Promise(resolve => { peak = Math.max(peak, ++active); releases.push(() => { active--; resolve(); }); });
  const one = scheduler.run(work), two = scheduler.run(work); const controller = new AbortController();
  const cancelled = scheduler.run(work, controller.signal); const rejection = assert.rejects(cancelled, /已停止/);
  controller.abort(); await turn(); assert.equal(peak, 2); assert.equal(releases.length, 2);
  releases.forEach(release => release()); await Promise.all([one,two,rejection]); await turn(); assert.equal(scheduler.active, 0);
  await assert.rejects(scheduler.run(() => { throw new Error('failure'); })); await scheduler.run(() => 42); assert.equal(scheduler.queue.length, 0);
  const budget = new ModelBudget(3); assert.deepEqual([budget.consume(),budget.consume(),budget.consume(),budget.consume()], [1,2,3,null]);
});
test('readonly worker host blocks writes, shell, nested delegation and arbitrary MCP', async () => {
  let calls = 0; const tools = readonly({ catalog: () => ['read_file','write_file','run_command','delegate_tasks'].map(name => ({ name })), execute: () => { calls++; return { ok: true }; } });
  assert.deepEqual(tools.catalog().map(tool => tool.name), ['read_file']);
  for (const name of ['write_file','run_command','delegate_tasks','mcp_other']) assert.throws(() => tools.execute(name, {}));
  tools.execute('read_file', {}); assert.equal(calls, 1);
});
function fixture(runner) {
  let closed = 0;
  const base = { catalog: () => [{name:'read_file'}], execute: async () => ({ ok:true }) };
  const controller = new AbortController();
  const workers = new AgentWorkers({ base, signal: controller.signal, scheduler: new RequestScheduler(2), modelBudget: new ModelBudget(12),
    bridge: { createChannel: async () => ({ close: async () => { closed++; } }) }, createTools: () => base, runner });
  return { workers, controller, closed: () => closed };
}
test('completed background jobs remain uncollected; parent waits before final answer', async () => {
  const {workers,closed} = fixture(async options => { options.onFinal('actual evidence'); return {completed:true}; });
  workers.delegate({tasks:[{title:'scan',role:'explore',request:'read files'}]});
  await turn(); assert.equal(workers.hasPending(),true); assert.equal(closed(),1);
  const prompts=[];
  const result = await runAgent({tools:workers, bridge:{chat: async prompt => {prompts.push(prompt);return {text:JSON.stringify({kind:'final',message:'done'})};}}, request:'解釋',signal:signal()});
  assert.equal(result.completed,true);assert.equal(prompts.length,2);assert.match(prompts[1],/actual evidence/);assert.equal(workers.hasPending(),false);
  await workers.close();
});
test('cancellation settles all channels, failed tasks cannot report success, bounded delegation', async () => {
  const {workers,controller,closed} = fixture(async options => { await new Promise(resolve => options.signal.addEventListener('abort',resolve,{once:true})); throw new Error('已停止'); });
  const delegated=workers.delegate({tasks:[{title:'a',role:'research',request:'a'},{title:'b',role:'review',request:'b'}]});
  assert.equal(delegated.tasks.length,2);assert.throws(()=>workers.delegate({tasks:[{title:'c',role:'explore',request:'c'}]}));
  await turn();controller.abort();const results=await workers.collect();assert.equal(results.ok,false);assert(results.tasks.every(task=>task.status==='interrupted'));assert.equal(closed(),2);await workers.close();
});
test('parent and child agent share one model-round budget', async () => {
  const budget=new ModelBudget(2);let chats=0;
  const options={bridge:{chat:async()=>{chats++;return {text:JSON.stringify({kind:'final',message:'done'})};}},tools:{execute:async()=>{}},request:'解釋',signal:signal(),modelBudget:budget};
  await Promise.all([runAgent(options),runAgent(options)]);const third=await runAgent(options);assert.equal(chats,2);assert.equal(third.completed,false);
});

test('actual worker agent loop reads through its own tools, reports evidence and closes channel', async () => {
  let closed = 0; const reads = [];
  const replies = [{kind:'tool',name:'read_file',args:{path:'a.js'}},{kind:'final',message:'Found a.js'}];
  const scheduler = new RequestScheduler(1), budget = new ModelBudget(10);
  const base = {catalog:()=>[{name:'read_file'}],execute:async(name,args)=>{reads.push(args.path);return {ok:true,content:'actual file'};}};
  const workers = new AgentWorkers({base,signal:signal(),scheduler,modelBudget:budget,createTools:()=>base,
    bridge:{createChannel:async()=>({chat:async()=>({text:JSON.stringify(replies.shift())}),close:async()=>{closed++;}})}});
  const {tasks}=workers.delegate({tasks:[{title:'scan',role:'explore',request:'讀取 a.js'}]});
  const result=await workers.collect(tasks.map(task=>task.id));assert.equal(result.ok,true);assert.deepEqual(reads,['a.js']);
  assert.match(JSON.stringify(result),/actual file/);assert.equal(closed,1);assert.equal(budget.used,2);await workers.close();
});
test('single-request fallback works and provider failure prevents queued work starting', async () => {
  const controller=new AbortController();let started=0;
  const scheduler=new RequestScheduler(1,error=>{if(error.status===429)controller.abort();});
  const first=scheduler.run(()=>{started++;throw Object.assign(new Error('limit'),{status:429});},controller.signal);
  const second=scheduler.run(()=>{started++;},controller.signal);
  await Promise.all([assert.rejects(first,/limit/),assert.rejects(second,/已停止/)]);assert.equal(started,1);
});

test('worker keeps remote evidence when saving local results fails', async () => {
  const {workers}=fixture(async options=>{options.onFinal('evidence');return {completed:true};});
  const closes=[];workers.bridge.createChannel=async()=>({close:async options=>closes.push(options)});
  workers.onBeforeCleanup=async()=>{throw new Error('disk full');};
  workers.delegate({tasks:[{title:'read',role:'review',request:'read evidence'}]});
  const result=await workers.collect();assert.equal(result.ok,false);assert.match(result.tasks[0].result,/保留校方對話/);assert.equal(closes[0].cleanup,false);await workers.close();
});

test('scheduler supports verified limits 3,4,5 across all callers', async () => {
  for(const limit of [3,4,5]){
    const scheduler=new RequestScheduler(limit);let active=0,peak=0;
    await Promise.all(Array.from({length:limit+2},()=>scheduler.run(async()=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,5));active--;})));
    assert.equal(peak,limit);
  }
});
test('worker catalog and host enforce the selected subagent limit while maintaining read-only access', async () => {
  const {workers,controller}=fixture(async options=>{await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw new Error('stopped');});
  workers.maxWorkers=4;workers.maxTasks=8;
  assert.match(workers.catalog().find(tool=>tool.name==='delegate_tasks').description,/1–4/);
  assert.equal(workers.delegate({tasks:Array.from({length:4},(_,i)=>({title:String(i),request:'read',role:'explore'}))}).tasks.length,4);
  assert.throws(()=>workers.delegate({tasks:[{title:'extra',request:'read',role:'review'}]}),/最多 4/);
  await turn();controller.abort();await workers.close();
});

test('five read-only workers complete across four shared model slots', async () => {
  const scheduler=new RequestScheduler(4),budget=new ModelBudget(20),controller=new AbortController();let channels=0,closed=0,active=0,peak=0;
  const base={catalog:()=>[{name:'read_file'}],execute:async()=>({ok:true,text:'synthetic fixture'})};
  const workers=new AgentWorkers({base,scheduler,modelBudget:budget,signal:controller.signal,maxWorkers:5,createTools:()=>base,
    bridge:{createChannel:async()=>{channels++;return {chat:async(_,options)=>{options.onOpen?.();peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,5));active--;return {text:'evidence'};},close:async()=>{closed++;}};}},
    runner:async options=>{assert.deepEqual(options.tools.catalog().map(t=>t.name),['read_file']);options.modelBudget.consume();const reply=await options.bridge.chat('synthetic',{signal:options.signal});options.onFinal(reply.text);return {completed:true};}});
  const result=workers.delegate({tasks:Array.from({length:5},(_,i)=>({title:`area ${i}`,role:'explore',request:'read synthetic area'}))});
  assert.equal(result.tasks.length,5);const collected=await workers.collect();
  assert.equal(collected.ok,true);assert(collected.tasks.every(t=>t.status==='done'));assert.equal(peak,4);assert.equal(scheduler.peakStreams,4);assert.equal(channels,5);assert.equal(closed,5);assert.equal(budget.used,5);await workers.close();
});
