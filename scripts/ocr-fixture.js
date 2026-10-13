'use strict';
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { AttachmentScanner } = require('../src/security/attachments');
function pdf(text) {
  const stream = `BT /F1 18 Tf 40 740 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0]; for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(body); body += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`; return Buffer.from(body);
}
(async () => {
  const scanner = new AttachmentScanner();
  const clean = await sharp(Buffer.from('<svg width="1200" height="200"><rect width="100%" height="100%" fill="white"/><text x="30" y="100" font-size="36" fill="black">Ordinary project diagram</text></svg>')).png().toBuffer();
  assert.equal((await scanner.scan(clean, 'image/png')).pages, 1);
  const secret = await sharp(Buffer.from('<svg width="1800" height="200"><rect width="100%" height="100%" fill="white"/><text x="30" y="100" font-family="Arial" font-size="30" fill="black">Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456</text></svg>')).png().toBuffer();
  await assert.rejects(scanner.scan(secret, 'image/png'), /禁止上傳/);
  assert.equal((await scanner.scan(pdf('Ordinary public document'), 'application/pdf')).pages, 1);
  await assert.rejects(scanner.scan(pdf('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), 'application/pdf'), /禁止上傳/);
  console.log('Actual Tesseract + Poppler: clean image/PDF pass, synthetic credentials blocked; no school upload.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
