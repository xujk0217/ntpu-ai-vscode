'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { AttachmentScanner, ensureAttachment } = require('../src/security/attachments');
async function image() { return sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer(); }
test('OCR approves clean image without returning recognized document text', async () => {
  const scanner = new AttachmentScanner({ run: async () => ({ stdout: 'ordinary diagram' }) });
  const result = await scanner.scan(await image(), 'image/png'); assert.equal(result.pages, 1); assert.equal(JSON.stringify(result).includes('ordinary'), false);
});
test('OCR blocks known credentials and redacts parser errors', async () => {
  const bytes = await image();
  await assert.rejects(new AttachmentScanner({ run: async () => ({ stdout: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' }) }).scan(bytes, 'image/png'), /禁止上傳/);
  await assert.rejects(new AttachmentScanner({ run: async () => { throw new Error('SECRET raw OCR stderr'); } }).scan(bytes, 'image/png'), error => !error.message.includes('SECRET') && error.message.includes('未上傳'));
  await assert.rejects(ensureAttachment({ buffer: bytes, mimeType: 'image/png' }), /確認/);
});
test('PDF scans every page and detects a secret on the last page', async () => {
  let ocr = 0;
  const scanner = new AttachmentScanner({ run: async (program, args) => {
    if (program === 'pdfinfo') return { stdout: 'Pages: 2\nEncrypted: no\n' };
    if (program === 'pdftotext') return { stdout: 'ordinary document' };
    if (program === 'pdftoppm') { await fs.writeFile(args.at(-1) + '-1.png', 'mock'); await fs.writeFile(args.at(-1) + '-2.png', 'mock'); return { stdout: '' }; }
    ocr++; return { stdout: ocr === 2 ? 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' : 'ordinary' };
  } });
  await assert.rejects(scanner.scan(Buffer.from('%PDF-fixture'), 'application/pdf'), /禁止上傳/); assert.equal(ocr, 2);
});
test('PDF rejects missing pages and detects selectable hidden secrets before rendering', async () => {
  for (const embedded of [false, true]) {
    const scanner = new AttachmentScanner({ run: async program => ({ stdout: program === 'pdfinfo' ? 'Pages: 2\n' : embedded && program === 'pdftotext' ? 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' : '' }) });
    await assert.rejects(scanner.scan(Buffer.from('%PDF-fixture'), 'application/pdf'), /禁止上傳/);
  }
});
test('OCR cleans up private temporary files on a failed parser', async () => {
  let directory;
  await assert.rejects(new AttachmentScanner({ run: async (_, __, options) => { directory = options.cwd; assert.equal((await fs.stat(directory)).mode & 0o777, 0o700); throw new Error('fail'); } }).scan(await image(), 'image/png'));
  await assert.rejects(fs.access(directory)); assert.ok(path.basename(directory).startsWith('ntpu-ocr-'));
});
test('native OCR failures and explicit language/path settings never silently fall back', async () => {
  for (const options of [{}, { tesseract: 'custom-ocr' }, { language: 'chi_tra' }]) {
    const error = Object.assign(new Error('raw sensitive stderr'), { code: Object.keys(options).length ? 'ENOENT' : 'EACCES' });
    await assert.rejects(new AttachmentScanner({ ...options, run: async () => { throw error; } }).scan(await image(), 'image/png'), failure => /未上傳/.test(failure.message) && !failure.message.includes('sensitive'));
  }
});
