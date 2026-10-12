'use strict';
const { BrowserBridge } = require('../src/browser');
const fs = require('node:fs/promises');
const path = require('node:path');

const bridge = new BrowserBridge();
(async () => {
  let stopped = false;
  const shutdown = async () => { stopped = true; await bridge.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await bridge.open();
  console.log('LOGIN_REQUIRED: 請在專用 Chrome 完成學校登入，或正常訪客驗證。');
  const deadline = Date.now() + 15 * 60 * 1000;
  while (!stopped && Date.now() < deadline) {
    const status = await bridge.status();
    if (status.ready) {
      console.log('READY: ' + status.message);
      const result = await bridge.chat('請只輸出 JavaScript 程式碼，不要說明：建立函式 add(a, b)，回傳 a + b。', {
        onToken: token => process.stdout.write(token),
        onJudge: judge => console.log('\nMODEL: ' + JSON.stringify(judge)),
      });
      const evidenceDir = path.join(__dirname, '..', '.local');
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, 'browser-smoke.json'), JSON.stringify({
        timestamp: new Date().toISOString(), model: result.model, text: result.text,
        completed: true, transport: 'site-ui-with-observed-sse',
      }, null, 2), { mode: 0o600 });
      console.log('\nSMOKE_OK');
      await bridge.close();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await bridge.close();
  throw new Error('等待登入逾時；本次未完成網站回答驗證。');
})().catch(async error => { console.error(error.message); await bridge.close(); process.exitCode = 1; });
