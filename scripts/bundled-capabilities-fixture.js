'use strict';
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { AttachmentScanner } = require('../src/security/attachments');
const { recognize } = require('../src/security/offline-ocr');
const { chartSvg, diagramSvg } = require('../src/graphics');
const { renderSvg } = require('../src/visuals');

(async () => {
  // Simulate a fresh desktop with no native Tesseract installed. The actual
  // worker forbids fetch and loads only the packaged WASM/language resources.
  const scanner = new AttachmentScanner({ run: async () => { throw Object.assign(new Error('missing native OCR'), { code: 'ENOENT' }); } });
  for (const rendered of [
    chartSvg({ type: 'bar', title: 'Synthetic quarterly revenue', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Revenue', values: [12, 18, 15, 24] }] }),
    diagramSvg({ title: 'Synthetic workflow', nodes: [{ id: 'a', label: 'Build' }, { id: 'b', label: 'Test' }], edges: [{ from: 'a', to: 'b' }] }),
  ]) {
    const image = await renderSvg(rendered.svg, rendered.width, rendered.height);
    assert.equal((await sharp(image).metadata()).format, 'png');
    const proof = await scanner.scan(image, 'image/png');
    assert.equal(proof.checked, true); assert.equal(proof.engine, 'Bundled Tesseract WASM');
  }
  const secret = await sharp(Buffer.from('<svg width="1800" height="200"><rect width="100%" height="100%" fill="white"/><text x="30" y="100" font-family="Arial" font-size="30" fill="black">Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456</text></svg>')).png().toBuffer();
  await assert.rejects(scanner.scan(secret, 'image/png'), /禁止上傳/);
  await assert.rejects(recognize(Buffer.from('invalid image')), /離線 OCR/);
  console.log('Bundled chart/diagram PNG + offline WASM OCR: clean graphics pass, synthetic credential blocked, invalid image cleans up. No external runtime, network or school upload.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
