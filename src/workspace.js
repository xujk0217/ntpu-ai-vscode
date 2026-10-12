'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_FILE_BYTES = 160000;
const EXCLUDES = '**/{.git,node_modules,.venv,venv,dist,build,.next,.local,__pycache__,coverage,.ssh,.aws,.codex}/**';
const hash = text => createHash('sha256').update(text).digest('hex');

function isBlocked(relative) {
  const parts = relative.replaceAll('\\', '/').split('/');
  return parts.some(part => {
    const name = part.toLowerCase();
    return ['.git', 'node_modules', '.venv', 'venv', '.local', '.ssh', '.aws', '.codex'].includes(name) ||
      (/^\.env(?:\.|$)/.test(name) && !['.env.example', '.env.sample', '.env.template'].includes(name)) ||
      /\.(pem|key|p12|pfx|keystore)$/.test(name) ||
      /^(id_rsa|id_ed25519|credentials|secrets)(?:\.|$)/.test(name);
  });
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') ||
      path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.startsWith('\\')) {
    throw new Error('必須使用工作區內的相對路徑。');
  }
  const normalized = relative.replaceAll('\\', '/');
  if (isBlocked(normalized)) throw new Error('此路徑包含秘密資料或不允許的目錄。');
  const absolute = path.resolve(root, normalized);
  if (!inside(path.resolve(root), absolute)) throw new Error('路徑超出目前工作區。');
  // Also inspect the normalized path: e.g. dir/../.env, and symlink targets.
  if (isBlocked(path.relative(root, absolute))) throw new Error('此路徑包含秘密資料或不允許的目錄。');
  const realRoot = await fs.realpath(root);
  let ancestor = absolute;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(realRoot, real)) throw new Error('符號連結指向工作區外，已拒絕存取。');
      if (isBlocked(path.relative(realRoot, real))) throw new Error('符號連結指向秘密資料或不允許的目錄。');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return absolute;
}

async function diskText(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('此路徑不是一般檔案。');
  if (stat.size > MAX_FILE_BYTES) throw new Error(`檔案超過 ${MAX_FILE_BYTES} bytes，請選取需要的片段。`);
  const bytes = await fs.readFile(file);
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) throw new Error('檔案過大或是二進位檔案。');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function numberedLines(text, start = 1, end, maxCharacters = Infinity) {
  const lines = text.split('\n');
  if (!Number.isInteger(start) || start < 1 || (end !== undefined && (!Number.isInteger(end) || end < start))) {
    throw new Error('行號必須是正整數，end_line 不可小於 start_line。');
  }
  const stop = Math.min(end === undefined ? lines.length : end, lines.length);
  const result = [];
  let size = 0;
  for (let index = start - 1; index < stop; index++) {
    const line = `${index + 1}: ${lines[index]}`;
    if (size + line.length + 1 > maxCharacters) break;
    result.push(line); size += line.length + 1;
  }
  const actualEnd = start - 1 + result.length;
  return { text: result.join('\n'), total_lines: lines.length, start_line: start, end_line: actualEnd, truncated: actualEnd < stop };
}

function fullyRead(snapshot) {
  if (!snapshot?.ranges?.length) return false;
  const sorted = [...snapshot.ranges].sort((a, b) => a[0] - b[0]);
  let next = 1;
  for (const [start, end] of sorted) {
    if (start > next) return false;
    next = Math.max(next, end + 1);
    if (next > snapshot.totalLines) return true;
  }
  return false;
}

module.exports = { MAX_FILE_BYTES, EXCLUDES, hash, isBlocked, safePath, diskText, numberedLines, fullyRead };
