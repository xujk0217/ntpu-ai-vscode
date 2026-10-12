'use strict';
const sharp = require('sharp');
const { SaxesParser } = require('saxes');
const ALLOWED_TAGS = new Set(['svg', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'rect', 'circle', 'ellipse', 'path', 'line', 'polyline', 'polygon', 'text', 'tspan', 'clipPath', 'mask', 'title', 'desc']);
const ALLOWED_ATTRIBUTES = new Set(('xmlns width height viewBox preserveAspectRatio id x y x1 x2 y1 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity font-family font-size font-weight text-anchor dominant-baseline letter-spacing dx dy offset stop-color stop-opacity gradientUnits gradientTransform clip-path mask').split(' '));

function validateSvg(svg) {
  if (typeof svg !== 'string' || svg.length > 100000 || /<!DOCTYPE|<!ENTITY|<\?/i.test(svg)) throw new Error('SVG 內容過大或包含不支援的宣告。');
  let root = false, count = 0;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    if (++count > 4000 || !ALLOWED_TAGS.has(tag.name)) throw new Error('SVG 包含不支援的元素。');
    if (!root) { if (tag.name !== 'svg') throw new Error('圖像必須以 svg 為根元素。'); root = true; }
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (!ALLOWED_ATTRIBUTES.has(name)) throw new Error('SVG 包含不支援的屬性：' + name);
      if (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') throw new Error('SVG 命名空間不正確。');
      if (/url\s*\(/i.test(value) && !/^url\(\s*#[a-zA-Z_][a-zA-Z0-9_-]*\s*\)$/.test(value)) throw new Error('SVG 不可引用外部資源。');
      if (/javascript:|data:|file:|https?:|@import/i.test(value) && name !== 'xmlns') throw new Error('SVG 不可引用外部資源或脚本。');
      if (tag.name === 'svg' && ['width', 'height'].includes(name) && (!/^\d+(?:\.\d+)?(?:px)?$/.test(value) || Number.parseFloat(value) > 2048 || Number.parseFloat(value) < 1)) {
        throw new Error('SVG 畫布尺寸須為 1–2048 px。');
      }
    }
  });
  parser.on('error', error => { throw error; });
  parser.write(svg).close();
  if (!root) throw new Error('SVG 沒有根元素。');
  return svg;
}

async function renderSvg(svg, width = 1024, height = 768) {
  validateSvg(svg);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048) throw new Error('輸出尺寸須為 1–2048 px。');
  return sharp(Buffer.from(svg), { limitInputPixels: 4194304 }).resize(width, height, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  throw new Error('只支援 PNG、JPEG、WebP 與 GIF 圖片。');
}
async function thumbnail(bytes) {
  imageMime(bytes);
  return sharp(bytes, { limitInputPixels: 40000000 }).resize(320, 200, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
module.exports = { validateSvg, renderSvg, imageMime, thumbnail };
