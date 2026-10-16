'use strict';
// Run only on a Linux desktop with X11/XWayland. Own synthetic GTK window only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ComputerController } = require('../src/computer/controller');
async function read(file) {
  for (let i=0;i<100;i++) { try { return JSON.parse(await fs.readFile(file)); } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve=>setTimeout(resolve,50)); } }
  throw new Error('Synthetic GTK fixture timed out');
}
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'ntpu-desktop-'));
  const child = spawn('/usr/bin/python3',[path.join(__dirname,'fixtures/computer-window.py'),directory], { env: {...process.env,GDK_BACKEND:'x11'}, stdio:['ignore','ignore','pipe'] });
  let error=''; child.stderr.on('data',chunk=>{error+=chunk;});
  const controller=new ComputerController({directory,approve:async()=>true,selectWindow:async windows=>windows.find(w=>w.title==='ComputerUseFixture'),image:async buffer=>{assert.equal(buffer.subarray(1,4).toString(),'PNG');return {syntheticImage:true,analysis:"Synthetic fixture capture supplied to verifier"};}});
  const signal=new AbortController().signal;
  try {
    const f=await read(path.join(directory,'ready.json'));
    assert.equal((await controller.open({mode:'desktop'},signal)).controlled,true);
    let seen=await controller.observe({},signal);
    for(const args of [{action:'click',...f.entry},{action:'type',text:'FixtureABC123'},{action:'click',...f.button}]) {
      await controller.action({...args,observation:seen.observation},signal);seen=await controller.observe({},signal);
    }
    const receipt=await read(path.join(directory,'receipt.json'));assert.deepEqual(receipt,{text:'FixtureABC123',clicked:true});
    assert.equal(controller.needsObservation,false);
    console.log(JSON.stringify({fixture:'selected-X11-window',captured:true,verifiedClick:true,verifiedTyping:true,schoolRequests:0}));
  }catch(e){throw new Error(e.message+' '+error);}finally{await controller.dispose();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});await fs.rm(directory,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
