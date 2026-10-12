'use strict';
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

function privateAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  // IPv6 web targets must be global unicast; this also rejects mapped IPv4,
  // loopback, link-local, ULA, unspecified and multicast addresses.
  return net.isIP(ip) !== 6 || !/^[23][0-9a-f]{3}:/.test(ip) || ip.startsWith('2001:db8:');
}

async function publicTarget(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('網頁讀取只接受公開 HTTP(S) 網址，不接受帳密或自訂連接埠。');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('不能用網頁工具存取本機或內部網路。');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('此網址解析到非公開網路，已拒絕存取。');
  return { url, address: addresses.find(item => item.family === 4) || addresses[0] };
}

async function fetchPublic(value, signal, redirects = 0) {
  if (signal?.aborted) throw new Error('已停止');
  if (redirects > 5) throw new Error('網頁重新導向次數過多。');
  const { url, address } = await publicTarget(value);
  const result = await new Promise((resolve, reject) => {
    // Pin the validated DNS result for the actual connection.
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, timeout: 20000,
      headers: { 'User-Agent': 'NTPU-AI-Coder/0.2 (documentation reader)', Accept: 'text/html,text/plain,application/json' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve({ redirect: new URL(response.headers.location, url).href }); return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`網頁回應 HTTP ${response.statusCode}`)); return; }
      const mime = String(response.headers['content-type'] || 'text/plain');
      if (!/text\/|application\/(json|xml|xhtml)/i.test(mime)) { response.resume(); reject(new Error('這個網址不是支援的文字網頁。')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1500000) { request.destroy(new Error('網頁超過 1.5 MB 讀取上限。')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve({ url: url.href, mime, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('網頁讀取逾時。')));
    request.end();
  });
  if (result.redirect) return fetchPublic(result.redirect, signal, redirects + 1);
  return result;
}

function pageText(html) {
  return html.replace(/<(script|style|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (_all, number) => String.fromCodePoint(Math.min(Number(number), 0x10ffff)))
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]))
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
module.exports = { privateAddress, publicTarget, fetchPublic, pageText };
