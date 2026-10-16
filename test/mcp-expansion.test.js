'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { McpRegistry, REGISTRY, normalize, keywords } = require('../src/mcp-registry');
const { registerMcp } = require('../src/mcp-registration');
const { McpManager } = require('../src/mcp');
const { PermissionPolicy } = require('../src/permissions');
const { AgentWorkers } = require('../src/agent-workers');
const { runAgent } = require('../src/agent');
const signal = () => new AbortController().signal;
function entry(extra = {}, meta = {}) { return { server: { name:'io.github.fixture/pdf', version:'1.0.0', description:'Read synthetic PDF', repository:{url:'https://github.com/fixture/pdf'}, remotes:[{type:'streamable-http',url:'https://pdf.example/mcp'}], ...extra }, _meta:{'io.modelcontextprotocol.registry/official':{status:'active',isLatest:true,...meta}} }; }
function fixture(options = {}) {
  let calls=0, checks=0; const value=options.entry || entry();
  const registry = new McpRegistry({ fetchPublic:async url=>{calls++;return {url,body:JSON.stringify(url.includes('/versions/') ? value : {servers:[value],metadata:{}})};}, publicTarget:async url=>{checks++;return {url:new URL(url)};}, ...options });
  return {registry,counts:()=>({calls,checks})};
}
function toolsFor(options = {}, approval = async detail => detail.accept) {
  const file = path.join(__dirname,'../src/tools.js'), mod = new Module(file); mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
  mod.require=name=>name==='vscode'?{workspace:{isTrusted:true}}:Module.prototype.require.call(mod,name);mod._compile(fs.readFileSync(file,'utf8'),file);
  return new mod.exports.WorkspaceTools({fsPath:'/synthetic-expansion'}, {}, signal(), ()=>{}, approval, options);
}
function manager() { return {tools:new Map(),connections:new Map(),catalog(){return [...this.tools.values()];},states:()=>[]}; }
test('registry searches fixed official origin with bounded capability keywords and uses only returned cursors',async()=>{
  const urls=[];const f=fixture({fetchPublic:async(url,_signal,_redirects,options)=>{urls.push(url);assert.equal(options.noRedirect,true);return {url,body:JSON.stringify({servers:[entry()],metadata:urls.length===1?{nextCursor:'opaque:page2'}:{}})};}});
  const first=await f.registry.search({query:'pdf extract'},signal());assert.equal(first.query,'pdf');assert.equal(first.matches[0].status,'review_connection');assert.equal(first.nextCursor,'opaque:page2');
  await f.registry.search({query:'pdf extract'},signal());assert.equal(urls.length,1);
  await assert.rejects(f.registry.search({query:'browser',cursor:first.nextCursor},signal()),/游標/);
  await f.registry.search({query:'pdf',cursor:first.nextCursor},signal());assert.equal(urls.length,2);assert.ok(urls.every(url=>url.startsWith(REGISTRY+'/servers?')));
  for(const q of ['password=private-fixture','user@example.com','/home/private','whole\nchat','x'.repeat(81)])assert.throws(()=>keywords(q));
  assert.equal(keywords('瀏覽器'),'browser');
});
test('candidate version/source are revalidated and unknown, expired, changed or inactive entries cannot connect',async()=>{
  let time=0;const f=fixture({now:()=>time});const found=(await f.registry.search({query:'pdf'},signal())).matches[0];
  await assert.rejects(f.registry.review('invented',signal()),/不存在/);time=600001;await assert.rejects(f.registry.review(found.id,signal()),/10 分鐘/);
  await f.registry.search({query:'pdf'},signal());assert.equal((await f.registry.review(found.id,signal())).version,'1.0.0');
  const changed=fixture();const id=(await changed.registry.search({query:'pdf'},signal())).matches[0].id;changed.registry.options.fetchPublic=async()=>({body:JSON.stringify(entry({remotes:[{type:'streamable-http',url:'https://changed.example/mcp'}]}))});
  await assert.rejects(changed.registry.review(id,signal()),/已變更/);assert.equal(normalize(entry({}, {status:'deleted'})),null);assert.equal(normalize(entry({version:'1\nunsafe'})),null);
});
test('metadata with credentials, templates, auth headers or packages never becomes executable installation commands',async()=>{
  for(const url of ['http://localhost/mcp','https://user:pass@example.com/mcp','https://example.com/mcp?token=private','https://{host}/mcp'])assert.equal(normalize(entry({remotes:[{type:'streamable-http',url}]})).status,'requires_configuration');
  const f=fixture({entry:entry({remotes:[{type:'streamable-http',url:'https://pdf.example/mcp',headers:[{name:'Authorization',isSecret:true}]}]})});let adds=0,approvals=0;
  const tools=toolsFor({mcpRegistry:f.registry,mcp:manager(),addMcp:async()=>adds++},async()=>{approvals++;return 'yes';});const candidate=(await f.registry.search({query:'pdf'},signal())).matches[0];
  const result=await tools.execute('expand_mcp',{id:candidate.id,command:'run malicious metadata'});assert.equal(result.requiresConfiguration,true);assert.equal(result.ready,false);assert.equal(adds,0);assert.equal(approvals,0);
  const pkg=normalize(entry({remotes:[],packages:[{registryType:'npm',identifier:'@fixture/mcp',version:'2.0.0',environmentVariables:[{name:'API_KEY',isSecret:true}],runtimeArguments:[{value:'execute me'}]}]}));assert.equal(pkg.status,'requires_configuration');assert.deepEqual(pkg.packages[0].requiredEnvironment,['API_KEY']);assert.equal(JSON.stringify(pkg).includes('execute me'),false);
});
test('private DNS targets are rejected before approval and never passed to the connector',async()=>{
  const f=fixture({publicTarget:require('../src/network').publicTarget,entry:entry({remotes:[{type:'streamable-http',url:'https://127.0.0.1/mcp'}]})});let adds=0,approvals=0;
  const tools=toolsFor({mcpRegistry:f.registry,mcp:manager(),addMcp:async()=>adds++},async()=>{approvals++;return 'yes';});const item=(await f.registry.search({query:'pdf'},signal())).matches[0];
  const result=await tools.execute('expand_mcp',{id:item.id});assert.equal(result.ok,false);assert.match(result.error,/公開網路/);assert.equal(adds,0);assert.equal(approvals,0);
});
test('empty local tool search automatically discovers candidates, but network-off, readonly child and denied search do not send requests',async()=>{
  const f=fixture(), mcp=manager();const tools=toolsFor({mcpRegistry:f.registry,mcp,addMcp:async()=>{}});const result=await tools.execute('search_tools',{query:'unknownpdf'});assert.equal(result.externalDiscovery.matches.length,1);assert.equal(f.counts().calls,1);
  const off=fixture(), disabled=toolsFor({mcpRegistry:off.registry,mcp:manager(),addMcp:async()=>{},web:false});assert.equal((await disabled.execute('discover_mcp',{query:'pdf'})).denied,true);await disabled.execute('search_tools',{query:'unknownpdf'});assert.equal(off.counts().calls,0);
  const child=fixture(), base=toolsFor({mcpRegistry:child.registry,mcp:manager(),addMcp:async()=>{}});base.restrictDiscovery(require('../src/tool-discovery').workerTool);await base.execute('search_tools',{query:'unknownpdf'});assert.equal(child.counts().calls,0);
  const denied=fixture(), d=toolsFor({mcpRegistry:denied.registry,mcp:manager(),addMcp:async()=>{}},async()=>null);await d.execute('discover_mcp',{query:'pdf'});await d.execute('discover_mcp',{query:'pdf'});assert.equal(denied.counts().calls,0);
});
test('full access still requires expansion approval, rejects guessed IDs and never retries denied candidates',async()=>{
  const f=fixture();let adds=0,approvals=0;const tools=toolsFor({mcpRegistry:f.registry,mcp:manager(),addMcp:async()=>adds++,policy:new PermissionPolicy({mode:'full'})},async()=>{approvals++;return null;});
  const id=(await f.registry.search({query:'pdf'},signal())).matches[0].id;assert.equal((await tools.execute('expand_mcp',{id})).denied,true);assert.equal((await tools.execute('expand_mcp',{id})).ok,false);assert.equal((await tools.execute('expand_mcp',{id:'made-up',url:'https://evil.example'})).ok,false);assert.equal(approvals,1);assert.equal(adds,0);
  const readonly=toolsFor({mcpRegistry:f.registry,mcp:manager(),addMcp:async()=>adds++,policy:new PermissionPolicy({mode:'full',agent:'research'})});assert.equal((await readonly.execute('expand_mcp',{id})).denied,true);assert.equal(adds,0);
});
test('registry cancellation, failures and service limits never trigger duplicate network requests',async()=>{
  let calls=0;const f=fixture({fetchPublic:async()=>{calls++;throw new Error('HTTP 429 rate limit');}});
  await assert.rejects(f.registry.search({query:'pdf'},signal()),/429/);await assert.rejects(f.registry.search({query:'pdf'},signal()),/429/);await assert.rejects(f.registry.search({query:'browser'},signal()),/停止/);assert.equal(calls,1);
  const c=fixture();await assert.rejects(c.registry.search({query:'pdf'},AbortSignal.abort()),/停止/);assert.equal(c.counts().calls,0);
  const ordinary=fixture({fetchPublic:async()=>{throw new Error('offline');}});await assert.rejects(ordinary.registry.search({query:'pdf'},signal()),/offline/);await assert.rejects(ordinary.registry.search({query:'pdf'},signal()),/offline/);assert.equal(ordinary.registry.requests,1);
});
function appFixture(overrides={}) {
  const mcp={connections:new Map(),connect:async function(config){this.connections.set(config.name,{});return {tools:[{name:'echo',inputSchema:{type:'object'}}]};},disconnect:async function(name){this.connections.delete(name);}};
  const saved=[];const app={mcp,servers:[],context:{globalState:{update:async(_key,value)=>saved.push(value)}},capabilities(){},...overrides};return {app,saved};
}
const config={name:'fixture_public',type:'http',url:'https://pdf.example/mcp',agentAdded:true};
test('registration saves only after complete real metadata, and failure/cancellation rolls back and disconnects its own connection',async()=>{
  const good=appFixture();await registerMcp(good.app,config,signal(),async()=>{});assert.equal(good.app.servers.length,1);assert.equal(good.saved.length,1);
  const empty=appFixture();empty.app.mcp.connect=async()=>({tools:[]});await assert.rejects(registerMcp(empty.app,config,signal(),async()=>{}),/有效工具/);assert.equal(empty.saved.length,0);assert.equal(empty.app.mcp.connections.size,0);
  const bad=appFixture();let writes=0;bad.app.context.globalState.update=async()=>{if(++writes===1)throw new Error('disk unavailable');};await assert.rejects(registerMcp(bad.app,config,signal(),async()=>{}),/disk unavailable/);assert.equal(writes,2);assert.equal(bad.app.servers.length,0);assert.equal(bad.app.mcp.connections.size,0);
  const cancelled=appFixture(), abort=new AbortController();cancelled.app.context.globalState.update=async()=>abort.abort();await assert.rejects(registerMcp(cancelled.app,config,abort.signal,async()=>{}),/abort/i);assert.equal(cancelled.app.servers.length,0);assert.equal(cancelled.app.mcp.connections.size,0);
});
test('host asks for actual discovery before accepting a claim that tool capabilities are missing',async()=>{
  let turn=0,finals=[];const replies=[{kind:'final',completed:false,message:'缺少可用工具，無法完成'}, {kind:'tool',name:'search_tools',args:{query:'pdf'}}, {kind:'final',completed:false,message:'目錄離線，無法取得所需工具；本機結果保留。'}];
  const result=await runAgent({bridge:{chat:async()=>({text:JSON.stringify(replies[turn++])})},tools:{catalog:()=>[{name:'search_tools'}],canExpandCapabilities:()=>true,execute:async()=>({ok:true,total:0,externalDiscovery:{ok:false,error:'offline'}})},request:'請處理 PDF 文件',signal:signal(),onFinal:value=>finals.push(value)});
  assert.equal(result.completed,false);assert.equal(turn,3);assert.equal(finals.length,1);assert.match(finals[0],/離線/);
});
test('Agent completes discover → approve → real MCP handshake/paging → schema → actual tool call → resume original task',async t=>{
  const calls=[];const server=http.createServer((req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{const message=JSON.parse(data);calls.push(message.method);if(message.id===undefined){res.writeHead(202).end();return;}let result;
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'actual-local-fixture',version:'1'}};
    else if(message.method==='tools/list')result={tools:[{name:message.params?.cursor?'second':'extract_pdf',description:'Synthetic PDF text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}],...(!message.params?.cursor?{nextCursor:'page-two'}:{})};
    else result={content:[{type:'text',text:'ACTUAL_FIXTURE:'+message.params.arguments.text}]};res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const mcp=new McpManager();t.after(async()=>{await mcp.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const f=fixture(), app={mcp,servers:[],context:{globalState:{update:async()=>{}}},capabilities(){}};let approvals=0;
  const tools=toolsFor({mcpRegistry:f.registry,mcp,servers:app.servers,policy:new PermissionPolicy({mode:'full'}),addMcp:async(c,s)=>{
    // Test-only mapping to a real local SDK transport. Production stays pinned HTTPS.
    await registerMcp(app,{...c,url:'http://127.0.0.1:'+server.address().port,agentAdded:false},s,async()=>{});
  }},async detail=>{approvals++;return detail.accept;});let turn=0,final='';const messages=[];
  const bridge={chat:async()=>{const name=mcp.catalog()[0]?.name;const id=f.registry.candidates.keys().next().value;const replies=[{kind:'tool',name:'search_tools',args:{query:'unknownpdf'}},{kind:'tool',name:'expand_mcp',args:{id}},{kind:'tool',name:'describe_tool',args:{name}},{kind:'tool',name,args:{text:'requested-document'}},{kind:'final',message:'已讀取實際文件結果'}];return {text:JSON.stringify(replies[turn++])};}};
  const wrapped=new AgentWorkers({base:tools,signal:signal()});assert.equal(wrapped.canExpandCapabilities(),true);
  const result=await runAgent({bridge,tools,request:'使用所需 PDF 工具讀取文件',signal:signal(),onFinal:text=>final=text,onTool:event=>messages.push(event)});
  assert.equal(result.completed,true);assert.match(final,/實際文件/);assert.equal(calls.filter(x=>x==='tools/list').length,2);assert.ok(calls.includes('tools/call'));assert.equal(f.registry.states()[0].toolTested,true);assert.equal(f.registry.states()[0].verification,'tool-call');assert.equal(app.servers.length,1);assert.ok(approvals>=2);assert.equal(f.counts().calls,2);
});

test('source redirects and malformed registry pages are rejected without creating candidate IDs',async()=>{
  const redirected=fixture({fetchPublic:async()=>({url:'https://other.example/registry',body:JSON.stringify({servers:[entry()]})})});await assert.rejects(redirected.registry.search({query:'pdf'},signal()),/來源改變/);assert.equal(redirected.registry.candidates.size,0);
  for(const body of ['not json',JSON.stringify({servers:[] ,metadata:{nextCursor:12}}),JSON.stringify({servers:Array.from({length:11},()=>entry())})]){
    const f=fixture({fetchPublic:async()=>({body})});await assert.rejects(f.registry.search({query:'pdf'},signal()));assert.equal(f.registry.candidates.size,0);
  }
});
test('directory capacity and total request budgets fail explicitly without partially applying a new page',async()=>{
  let page=0;const f=fixture({fetchPublic:async()=>{page++;return {body:JSON.stringify({servers:Array.from({length:10},(_,i)=>entry({name:`io.github.fixture/server-${page}-${i}`})),metadata:{nextCursor:'cursor-'+page}})};}});
  let cursor;for(let i=0;i<6;i++)cursor=(await f.registry.search({query:'pdf',...(cursor?{cursor}:{})},signal())).nextCursor;
  assert.equal(f.registry.candidates.size,60);await assert.rejects(f.registry.search({query:'pdf',cursor},signal()),/60 筆/);assert.equal(f.registry.candidates.size,60);
  const budget=fixture({fetchPublic:async()=>({body:'{"servers":[]}'})});for(let i=0;i<8;i++)await budget.registry.search({query:'query'+i},signal());await assert.rejects(budget.registry.search({query:'extra'},signal()),/8 次/);assert.equal(budget.registry.requests,8);
});
test('unauthorized endpoints require SecretStorage configuration, and rate-limited connections are not retried',async()=>{
  for(const error of ['HTTP 401 Unauthorized','HTTP 429 rate limit']){
    const f=fixture();let adds=0;const tools=toolsFor({mcpRegistry:f.registry,mcp:manager(),policy:new PermissionPolicy({mode:'full'}),addMcp:async()=>{adds++;throw new Error(error);}});
    const id=(await f.registry.search({query:'pdf'},signal())).matches[0].id;const first=await tools.execute('expand_mcp',{id});assert.equal(first.ok,false);if(error.includes('401')){assert.equal(first.requiresConfiguration,true);assert.match(first.error,/SecretStorage/);}else assert.equal(f.registry.stopped,true);
    await tools.execute('expand_mcp',{id});assert.equal(adds,1);assert.equal(f.registry.states().length,0);
  }
});
test('cancellation during MCP approval never invokes the connector, and failed calls do not retain verified status',async()=>{
  const f=fixture(), controller=new AbortController();let adds=0;
  const tools=toolsFor({mcpRegistry:f.registry,mcp:manager(),addMcp:async()=>adds++},async()=>{controller.abort();return '核准並連接 MCP';});tools.signal=controller.signal;
  const id=(await f.registry.search({query:'pdf'},signal())).matches[0].id;await assert.rejects(tools.execute('expand_mcp',{id}),/停止/);assert.equal(adds,0);
  f.registry.markConnected({name:'test',registry:{name:'fixture/test',version:'1'}});f.registry.markToolCall('test',true);assert.equal(f.registry.states()[0].verified,true);f.registry.markToolCall('test',false);assert.equal(f.registry.states()[0].verified,false);assert.equal(f.registry.states()[0].verification,'tool-call-failed');
});

test('cancelling an in-flight real MCP initialize closes the transport and never publishes a connection', {timeout:10000}, async t=>{
  let entered;const started=new Promise(resolve=>entered=resolve);const server=http.createServer((req,_res)=>{req.resume();entered();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const mcp=new McpManager();t.after(async()=>{await mcp.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
  const abort=new AbortController(), work=mcp.connect({name:'cancel_fixture',type:'http',url:'http://127.0.0.1:'+server.address().port},abort.signal);
  const rejected=assert.rejects(work,/abort|closed|cancel|stopp/i);await started;abort.abort();await rejected;assert.equal(mcp.connections.size,0);assert.equal(mcp.tools.size,0);
});

test('repeated unverified capability conclusions stop as incomplete instead of inventing discovery or success',async()=>{
  let count=0,final='';const result=await runAgent({bridge:{chat:async()=>{count++;return {text:JSON.stringify({kind:'final',completed:true,message:'沒有可用工具'})};}},tools:{catalog:()=>[{name:'search_tools'}],canExpandCapabilities:()=>true,execute:async()=>{throw new Error('not executed');}},request:'取得文件內容',signal:signal(),onFinal:text=>final=text});
  assert.equal(count,3);assert.equal(result.completed,false);assert.equal(result.capabilityUnverified,true);assert.match(final,/尚未完成實際工具探索/);
});

test('search avoids the slow live combined filter and resolves latest versions from history-only pages',async()=>{
  const urls=[];const f=fixture({fetchPublic:async url=>{urls.push(url);return {url,body:JSON.stringify(url.includes('/versions/latest')?entry({version:'2.0.0'}):{servers:[entry({}, {isLatest:false})],metadata:{}})};}});
  const result=await f.registry.search({query:'pdf'},signal());assert.equal(new URL(urls[0]).searchParams.has('version'),false);assert.match(urls[1],/\/versions\/latest$/);assert.equal(result.matches[0].version,'2.0.0');assert.equal(urls.length,2);
});

test('configured-server tool connection passes cancellation to the actual connector',async()=>{
  const mcp=manager();let passed;
  const tools=toolsFor({mcp,servers:[{name:'configured',type:'http',url:'https://configured.example/mcp'}],connectMcp:async(_config,s)=>passed=s});
  assert.equal((await tools.execute('connect_mcp',{name:'configured'})).ok,true);assert.equal(passed,tools.signal);
});

test('a new MCP tool reporting quota blocks further calls and new expansion instead of retrying or renaming it',async()=>{
  const f=fixture(),mcp=manager();let calls=0;
  const tool={name:'mcp_registry_fixture_read',server:'registry_fixture',external:true,readOnly:false,description:'Read fixture',inputSchema:{type:'object'}};mcp.tools.set(tool.name,tool);mcp.connections.set(tool.server,{config:{url:'https://limited.example/mcp',registry:{name:'fixture/pdf'}}});mcp.call=async()=>{calls++;return {ok:false,content:[{type:'text',text:'HTTP 429 rate limit'}]};};
  f.registry.markConnected({name:tool.server,registry:{name:'fixture/pdf',version:'1'}});
  const tools=toolsFor({mcpRegistry:f.registry,mcp,addMcp:async()=>{},policy:new PermissionPolicy({mode:'full'})});tools.discovery.describe({name:tool.name});
  assert.equal((await tools.execute(tool.name,{})).ok,false);assert.equal((await tools.execute(tool.name,{})).serviceLimited,true);assert.equal(calls,1);assert.equal(tools.canExpandCapabilities(),false);
  assert.equal((await tools.execute('add_mcp',{name:'renamed',url:'https://limited.example/other'})).serviceLimited,true);
  assert.equal((await tools.execute('search_tools',{server:tool.server,refresh:true})).serviceLimited,true);
  assert.equal((await tools.execute('connect_mcp',{name:tool.server})).serviceLimited,true);
  assert.equal(calls,1);
});
