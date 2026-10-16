'use strict';
const fs = require('node:fs/promises');
const http = require('node:http');
const { redact } = require('../security/guard');
async function callBroker(file, message, signal) {
  if (!file) throw new Error('請先在 VS Code 執行「NTPU AI: 啟用外部 Agent 橋接」，再匯出 plugin／MCP 設定。');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 1024 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error('橋接連線檔案權限或格式不安全。');
  const connection = JSON.parse(await fs.readFile(file, 'utf8'));
  if (connection.version !== 1 || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.secret)) throw new Error('橋接連線格式無效。');
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: connection.port, path: '/rpc', method: 'POST', signal, timeout: 10000, agent: false,
      headers: { authorization: 'Bearer ' + connection.secret, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 128000) request.destroy(new Error('橋接回應過大。')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (response.statusCode !== 200 || value.error && !value.id) reject(new Error(redact(value.error || '橋接請求失敗'))); else resolve(value); } catch (error) { reject(error); } });
    });
    request.on('error', () => reject(new Error('本機 NTPU 橋接無法連線或已取消；請確認 VS Code 已啟用橋接。')));
    request.on('timeout', () => request.destroy()); request.end(body);
  });
}
module.exports = { callBroker };
