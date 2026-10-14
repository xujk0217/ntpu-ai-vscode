'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { validateSvg, renderSvg, imageMime } = require('../src/visuals');
const { privateAddress, publicTarget, pageText } = require('../src/network');
test('SVG drawing produces an actual PNG of the requested size', async () => {
  const bytes = await renderSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#2b70e4"/><circle cx="50" cy="50" r="25" fill="#ffffff"/></svg>', 320, 320);
  assert.equal(imageMime(bytes), 'image/png');
  const meta = await sharp(bytes).metadata(); assert.equal(meta.width, 320); assert.equal(meta.height, 320);
});
test('SVG parsing refuses active content, external references, XML entities and oversized canvases', () => {
  for (const svg of ['<svg><script>alert(1)</script></svg>', '<svg><image href="file:///etc/passwd"/></svg>',
    '<svg><rect fill="url(https://evil.test)"/></svg>', '<svg onload="x()"/>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>', '<svg width="99999" height="100"/>']) assert.throws(() => validateSvg(svg));
});
test('web reader rejects private and mapped networks before issuing requests', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1']) assert.equal(privateAddress(ip), true, ip);
  assert.equal(privateAddress('8.8.8.8'), false);
  for (const url of ['http://127.0.0.1/', 'file:///etc/passwd', 'https://user:password@example.com/', 'http://10.0.0.1/', 'https://localhost/']) await assert.rejects(publicTarget(url));
  assert.equal(pageText('<script>ignore()</script><h1>Title</h1><p>A &amp; B</p>'), 'Title\nA & B');
});

test('agent-added MCP fetch rejects loopback targets before opening a connection', async () => {
  const { pinnedPublicFetch } = require('../src/network');
  await assert.rejects(pinnedPublicFetch()('https://127.0.0.1/mcp'), /不能用網頁工具存取本機|非公開網路/);
});
