'use strict';
// Synthetic localhost only; no school service, personal windows or profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { ComputerController } = require('../src/computer/controller');
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-computer-'));
  const server = http.createServer((req,res) => { res.setHeader('content-type','text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><input aria-label="Fixture text"><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Apply</button><output>waiting</output>'); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let approvals = 0, captures = 0;
  const selected = process.env.NTPU_FIXTURE_BROWSER || 'chrome';
  const controller = new ComputerController({ directory, browser: selected, customPath: '', approve: async () => { approvals++; return true; }, image: async buffer => { assert.equal(buffer.subarray(1,4).toString(),'PNG'); captures++; return { syntheticImage: true }; } });
  // The CI Playwright download has no system executable entry; explicitly select it.
  if (selected === 'chromium') { controller.options.browser = 'custom'; controller.options.customPath = chromium.executablePath(); }
  const signal = new AbortController().signal;
  try {
    const opened = await controller.open({ url: `http://127.0.0.1:${server.address().port}` },signal); assert.equal(opened.controlled,true);
    let seen = await controller.observe({},signal);
    const input = seen.controls.find(c => c.tag === 'input').id;
    await controller.action({ observation: seen.observation, action: 'fill', element: input, text: '完整 Unicode 測試 🧪' },signal);
    assert.equal(controller.needsObservation,true);
    await assert.rejects(controller.action({ observation: seen.observation, action: 'click', element: input },signal), /最近一次/);
    seen = await controller.observe({},signal);
    await controller.action({ observation: seen.observation, action: 'click', element: seen.controls.find(c => c.tag === 'button').id },signal);
    seen = await controller.observe({},signal); assert.match(seen.text,/完整 Unicode 測試 🧪/); assert.equal(controller.needsObservation,false);
    await controller.page.setContent('<input type="password" value="synthetic-only">');
    await assert.rejects(controller.observe({},signal),/登入／驗證/); assert.equal(captures,3);
    await controller.page.setContent('<iframe srcdoc="synthetic"></iframe>');
    await assert.rejects(controller.observe({},signal),/嵌入頁面/);
    await controller.close(); assert.equal(controller.context,null);
    console.log(JSON.stringify({ fixture:'computer-browser', controlled:true, unicodeFill:true, verifiedClick:true, captures, approvals, schoolRequests:0 }));
  } finally { await controller.dispose(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory,{recursive:true,force:true}); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
