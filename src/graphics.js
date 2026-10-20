'use strict';
// Structured graphics use the bundled SVG renderer; no service, shell, or extra runtime.
const COLORS = ['#2563eb', '#0f766e', '#c2410c', '#7c3aed', '#be185d', '#4d7c0f'];
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function label(value, maximum, name) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error(`${name} 需要 1–${maximum} 字文字。`);
  return value.trim();
}
function dimension(value, fallback, minimum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < minimum || result > 2048) throw new Error(`畫布尺寸需為 ${minimum}–2048 整數。`);
  return result;
}
const text = (x, y, value, size = 16, color = '#334155', anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${xml(value)}</text>`;
const frame = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
function heading(width, title) {
  const chars = Array.from(title), size = Math.max(1, Math.floor((width - 80) / 24));
  let svg = '';
  for (let i = 0; i < chars.length; i += size) svg += text(40, 42 + i / size * 27, chars.slice(i, i + size).join(''), 24, '#0f172a');
  return { svg, bottom: 42 + Math.floor((chars.length - 1) / size) * 27 };
}
const number = value => value !== 0 && (Math.abs(value) < .01 || Math.abs(value) >= 1e6) ? value.toExponential(1) : new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
function wrapped(x, y, value, columns, size, color = '#334155', anchor = 'start') {
  const chars = Array.from(value); let svg = '';
  for (let i = 0; i < chars.length; i += columns) svg += text(x, y + i / columns * (size + 3), chars.slice(i, i + columns).join(''), size, color, anchor);
  return svg;
}
function chartSvg(args) {
  if (!['bar', 'line', 'pie'].includes(args.type)) throw new Error('圖表 type 需為 bar、line 或 pie。');
  const title = label(args.title, 80, 'title'), unit = args.unit === undefined ? '' : label(args.unit, 20, 'unit');
  if (!Array.isArray(args.labels) || !args.labels.length || args.labels.length > 12) throw new Error('labels 需要 1–12 個標籤。');
  const labels = args.labels.map(value => label(value, 12, 'label'));
  if (!Array.isArray(args.series) || !args.series.length || args.series.length > 4) throw new Error('series 需要 1–4 組資料。');
  const series = args.series.map(item => {
    if (!item || !Array.isArray(item.values) || item.values.length !== labels.length || item.values.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12)) throw new Error('每組 values 必須與 labels 等長，且為有限數值（絕對值不超過 1e12）。');
    return { name: label(item.name, 30, 'series.name'), values: item.values };
  });
  const width = dimension(args.width, 1000, 640), height = dimension(args.height, 640, 400);
  const titleBlock = heading(width, title); let body = titleBlock.svg;
  if (args.type === 'pie') {
    if (series.length !== 1 || series[0].values.some(value => value < 0)) throw new Error('圓餅圖只接受一組非負資料。');
    const values = series[0].values, sum = values.reduce((a, b) => a + b, 0);
    if (!sum) throw new Error('圓餅圖總和必須大於零。');
    const radius = Math.min(width * .23, (height - titleBlock.bottom - 70) / 2), cx = width * .31, cy = (height + titleBlock.bottom) / 2;
    const legends = values.map((value, index) => `${labels[index]}: ${number(value)}${unit} (${number(value / sum * 100)}%)`);
    const columns = Math.floor((width * .39 - 50) / 11), rowHeights = legends.map(value => Math.ceil(Array.from(value).length / columns) * 14 + 7);
    if (rowHeights.reduce((a, b) => a + b, 0) > height - titleBlock.bottom - 45) throw new Error('畫布太小無法清楚呈現圖例，請增加尺寸或縮短標籤／單位。');
    let angle = -Math.PI / 2, legendY = titleBlock.bottom + 35;
    values.forEach((value, index) => {
      const next = angle + value / sum * Math.PI * 2, color = COLORS[index % COLORS.length];
      if (value === sum) body += `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}"/>`;
      else if (value > 0) body += `<path d="M ${cx} ${cy} L ${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)} A ${radius} ${radius} 0 ${value / sum > .5 ? 1 : 0} 1 ${cx + radius * Math.cos(next)} ${cy + radius * Math.sin(next)} Z" fill="${color}"/>`;
      body += `<rect x="${width * .61}" y="${legendY - 10}" width="12" height="12" fill="${color}"/>` + wrapped(width * .61 + 20, legendY, legends[index], columns, 11);
      legendY += rowHeights[index];
      angle = next;
    });
  } else {
    const values = series.flatMap(item => item.values), low = Math.min(0, ...values), rawHigh = Math.max(0, ...values), high = rawHigh === low ? low + 1 : rawHigh;
    const span = high - low || 1, left = 105, right = width - 35, top = titleBlock.bottom + 50, bottom = height - 105;
    const y = value => top + (high - value) / span * (bottom - top), slot = (right - left) / labels.length;
    for (let i = 0; i <= 4; i++) {
      const value = low + span * i / 4, py = y(value);
      body += `<line x1="${left}" x2="${right}" y1="${py}" y2="${py}" stroke="#e2e8f0"/>` + text(left - 9, py + 5, Math.abs(value) >= 1e6 ? value.toExponential(1) : number(value), 12, '#64748b', 'end');
    }
    if (unit) body += text(left, top - 18, unit, 12);
    body += `<line x1="${left}" x2="${right}" y1="${y(0)}" y2="${y(0)}" stroke="#64748b"/>`;
    labels.forEach((value, index) => { const chars = Array.from(value), perLine = Math.max(1, Math.floor(slot / 12)); for (let offset = 0; offset < chars.length; offset += perLine) body += text(left + (index + .5) * slot, bottom + 22 + offset / perLine * 14, chars.slice(offset, offset + perLine).join(''), 12, '#475569', 'middle'); });
    series.forEach((item, group) => {
      const color = COLORS[group];
      if (args.type === 'line') body += `<polyline points="${item.values.map((value, index) => `${left + (index + .5) * slot},${y(value)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="3"/>`;
      item.values.forEach((value, index) => {
        if (args.type === 'bar') {
          const bar = slot * .72 / series.length, x = left + (index + .14) * slot + group * bar;
          body += `<rect x="${x}" y="${Math.min(y(value), y(0))}" width="${bar * .9}" height="${Math.abs(y(value) - y(0))}" fill="${color}"/>`;
        } else body += `<circle cx="${left + (index + .5) * slot}" cy="${y(value)}" r="4" fill="${color}"/>`;
      });
      const lx = 45 + group * (width - 90) / series.length;
      const columns = Math.max(1, Math.floor(((width - 90) / series.length - 25) / 11));
      body += `<rect x="${lx}" y="${height - 39}" width="12" height="12" fill="${color}"/>` + wrapped(lx + 20, height - 28, item.name, columns, 11);
    });
  }
  return { svg: frame(width, height, body), width, height, summary: { type: args.type, title, labels: labels.length, series: series.length, points: labels.length * series.length } };
}
function diagramSvg(args) {
  const title = label(args.title, 80, 'title'), direction = args.direction || 'down';
  if (!['down', 'right'].includes(direction)) throw new Error('direction 需為 down 或 right。');
  if (!Array.isArray(args.nodes) || !args.nodes.length || args.nodes.length > 10) throw new Error('nodes 需要 1–10 個節點。');
  const nodes = args.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(node.id)) throw new Error('節點 id 需為 1–32 個英數字、_ 或 -。');
    return { id: node.id, label: label(node.label, 60, 'node.label') };
  });
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error('節點 id 不可重複。');
  if (!Array.isArray(args.edges) || args.edges.length > 20) throw new Error('edges 需要最多 20 條連線。');
  const edges = args.edges.map(edge => {
    if (!edge || !nodes.some(node => node.id === edge.from) || !nodes.some(node => node.id === edge.to) || edge.from === edge.to) throw new Error('連線需指向有效且不同的節點 id。');
    return { ...edge, label: edge.label === undefined ? '' : label(edge.label, 24, 'edge.label') };
  });
  const vertical = direction === 'down';
  const width = dimension(args.width, vertical ? 900 : Math.max(640, nodes.length * 190 + 100), 640);
  const height = dimension(args.height, vertical ? Math.max(400, nodes.length * 160 + 120) : 520, 400);
  const boxW = vertical ? Math.min(420, width * .58) : Math.min(160, (width - 100) / nodes.length - 22), boxH = 96;
  const titleBlock = heading(width, title), start = titleBlock.bottom + 50, spacing = (height - start - 50) / nodes.length;
  if (boxW < 110 || vertical && spacing < 126) throw new Error('畫布太小無法清楚呈現全部節點，請增加尺寸或減少節點。');
  const positions = nodes.map((node, index) => ({ ...node, x: vertical ? (width - boxW) / 2 : 50 + index * (width - 100) / nodes.length,
    y: vertical ? start + index * spacing : Math.max(180, start) }));
  let body = titleBlock.svg;
  edges.forEach((edge, index) => {
    const from = positions.find(node => node.id === edge.from), to = positions.find(node => node.id === edge.to);
    const x1 = vertical ? from.x + boxW / 2 : from.x + boxW, y1 = vertical ? from.y + boxH : from.y + boxH / 2;
    const x2 = vertical ? to.x + boxW / 2 : to.x, y2 = vertical ? to.y : to.y + boxH / 2;
    const adjacent = positions.indexOf(to) === positions.indexOf(from) + 1;
    const lane = vertical ? width - 20 - index * Math.max(1, ((width - boxW) / 2 - 35) / Math.max(1, edges.length)) : height - 40 - index * 7;
    const points = adjacent ? `${x1},${y1} ${x2},${y2}` : vertical ? `${x1},${y1} ${x1},${y1 + 10} ${lane},${y1 + 10} ${lane},${y2 - 12} ${x2},${y2 - 12} ${x2},${y2}` : `${x1},${y1} ${x1 + 10},${y1} ${x1 + 10},${lane} ${x2 - 12},${lane} ${x2 - 12},${y2} ${x2},${y2}`;
    body += `<polyline points="${points}" fill="none" stroke="#64748b" stroke-width="2"/>`;
    body += `<polygon points="${vertical ? `${x2},${y2} ${x2 - 5},${y2 - 9} ${x2 + 5},${y2 - 9}` : `${x2},${y2} ${x2 - 9},${y2 - 5} ${x2 - 9},${y2 + 5}`}" fill="#64748b"/>`;
    if (edge.label) body += text(adjacent ? (x1 + x2) / 2 + (vertical ? 12 : 0) : vertical ? lane + 4 : x1 + 16, adjacent ? (y1 + y2) / 2 - 5 : vertical ? (y1 + y2) / 2 : lane - 5, edge.label, 12);
  });
  positions.forEach((node, index) => {
    body += `<rect x="${node.x}" y="${node.y}" width="${boxW}" height="${boxH}" rx="10" fill="#eff6ff" stroke="${COLORS[index % COLORS.length]}" stroke-width="2"/>`;
    const chars = Array.from(node.label); let font = 15;
    while (font > 8 && Math.ceil(chars.length / Math.floor((boxW - 24) / font)) * (font + 4) > boxH - 18) font--;
    const length = Math.max(1, Math.floor((boxW - 24) / font));
    for (let i = 0; i < chars.length; i += length) body += text(node.x + boxW / 2, node.y + 22 + i / length * (font + 4), chars.slice(i, i + length).join(''), font, '#0f172a', 'middle');
  });
  return { svg: frame(width, height, body), width, height, summary: { type: 'diagram', title, nodes: nodes.length, edges: edges.length } };
}
module.exports = { chartSvg, diagramSvg };
