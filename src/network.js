'use strict';
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { Readable } = require('node:stream');

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

async function fetchPublic(value, signal, redirects = 0, options = {}) {
  if (signal?.aborted) throw new Error('已停止');
  if (redirects > 5) throw new Error('網頁重新導向次數過多。');
  const { url, address } = await publicTarget(value);
  const result = await new Promise((resolve, reject) => {
    // Pin the validated DNS result for the actual connection.
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, timeout: 20000,
      headers: { 'User-Agent': 'NTPU-AI-Coder/0.2 (workspace agent)', Accept: options.binary ? '*/*' : 'text/html,text/plain,application/json' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve({ redirect: new URL(response.headers.location, url).href }); return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`網頁回應 HTTP ${response.statusCode}`)); return; }
      const mime = String(response.headers['content-type'] || 'text/plain');
      if (!options.binary && !/text\/|application\/(json|xml|xhtml)/i.test(mime)) { response.resume(); reject(new Error('這個網址不是支援的文字網頁。')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        const limit = options.binary ? Math.min(10 * 1024 * 1024, options.maxBytes || 10 * 1024 * 1024) : 1500000;
        if (size > limit) { request.destroy(new Error(options.binary ? '下載超過 10 MB 上限。' : '網頁超過 1.5 MB 讀取上限。')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => { const body = Buffer.concat(chunks); resolve({ url: url.href, mime, body: options.binary ? body : body.toString('utf8') }); });
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('網頁讀取逾時。')));
    request.end();
  });
  if (result.redirect) return fetchPublic(result.redirect, signal, redirects + 1, options);
  return result;
}

function pageText(html) {
  return html.replace(/<(script|style|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|section)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (_all, number) => String.fromCodePoint(Math.min(Number(number), 0x10ffff)))
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/g, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]))
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function pinnedPublicFetch() {
  return async (input, init = {}) => {
    const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const { url, address } = await publicTarget(value);
    if (init.signal?.aborted) throw new Error('已停止');
    const headers = Object.fromEntries(new Headers(init.headers || (input instanceof Request ? input.headers : undefined)).entries());
    let body = init.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader(), chunks = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 1500000) throw new Error('MCP 要求超過 1.5 MB 上限。'); chunks.push(Buffer.from(part.value)); } }
      finally { reader.releaseLock(); }
      body = Buffer.concat(chunks);
    } else if (typeof body === 'string') body = Buffer.from(body);
    else if (body instanceof ArrayBuffer) body = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (body && !Buffer.isBuffer(body)) throw new Error('MCP 請求格式不支援。');
    if (body?.length > 1500000) throw new Error('MCP 要求超過 1.5 MB 上限。');
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: init.method || 'GET', headers, signal: init.signal, timeout: 60000,
        lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
      }, response => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const noBody = [204, 205, 304].includes(response.statusCode);
        resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders }));
      });
      request.once('error', reject);
      request.once('timeout', () => request.destroy(new Error('MCP 連線逾時。')));
      if (body) request.write(body);
      request.end();
    });
  };
}
module.exports = { privateAddress, publicTarget, fetchPublic, pageText, pinnedPublicFetch };
