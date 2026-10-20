'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { chartSvg, diagramSvg } = require('../src/graphics');
const { renderSvg, validateSvg } = require('../src/visuals');
const chart = { type: 'bar', title: '合成季度營收', unit: '萬元', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: '營收', values: [12, 18, 15, 24] }] };
const diagram = { title: '開發流程', nodes: [{ id: 'a', label: '需求確認' }, { id: 'b', label: '開發' }, { id: 'c', label: '測試' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: '提交' }, { from: 'c', to: 'a', label: '修正' }] };
test('bundled bar, line, pie and flow diagrams render real PNG files with source labels and no external resources', async () => {
  for (const graphic of [chartSvg(chart), chartSvg({ ...chart, type: 'line' }), chartSvg({ ...chart, type: 'pie' }), diagramSvg(diagram), diagramSvg({ ...diagram, direction: 'right' })]) {
    assert.equal(validateSvg(graphic.svg), graphic.svg);
    const png = await renderSvg(graphic.svg, graphic.width, graphic.height), metadata = await sharp(png).metadata();
    assert.equal(metadata.format, 'png'); assert.equal(metadata.width, graphic.width); assert.equal(metadata.height, graphic.height);
    assert(png.length > 1000); assert.doesNotMatch(graphic.svg, /NaN|Infinity|<image|<script|href=/);
  }
});
test('charts preserve negative and zero values, escape labels and correctly render a full-circle single slice', async () => {
  const negative = chartSvg({ ...chart, labels: ['A & B', '<script>'], series: [{ name: '合成', values: [-10, 0] }] });
  assert.match(negative.svg, /A &amp; B/); assert.match(negative.svg, /&lt;script&gt;/); validateSvg(negative.svg);
  const zero = chartSvg({ ...chart, series: [{ name: 'zero', values: [0, 0, 0, 0] }] });
  assert.doesNotMatch(zero.svg, /NaN|Infinity/); validateSvg(zero.svg);
  const pie = chartSvg({ ...chart, type: 'pie', labels: ['one'], series: [{ name: '合成', values: [5] }] });
  assert.match(pie.svg, /<circle/); assert.match(pie.svg, /100%/);
});
test('invalid chart data is rejected rather than silently inventing, dropping or coercing values', () => {
  for (const change of [ { type: 'unknown' }, { labels: [] }, { labels: Array(13).fill('x') }, { series: [{ name: 'x', values: ['12', 18, 15, 24] }] },
    { series: [{ name: 'x', values: [NaN, 18, 15, 24] }] }, { series: [{ name: 'x', values: [1] }] }, { type: 'pie', series: [{ name: 'x', values: [-1, 1, 2, 3] }] },
    { type: 'pie', series: [{ name: 'x', values: [0, 0, 0, 0] }] }, { width: 4096 } ]) assert.throws(() => chartSvg({ ...chart, ...change }));
});
test('diagrams validate actual references, bound complexity and reject unreadably small layouts', () => {
  for (const change of [{ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, { edges: [{ from: 'a', to: 'missing' }] }, { edges: [{ from: 'a', to: 'a' }] }, { direction: 'shell' },
    { nodes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: 'label' })), edges: [], direction: 'right', width: 640 },
    { nodes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: 'label' })), edges: [], height: 400 } ]) assert.throws(() => diagramSvg({ ...diagram, ...change }));
});
test('long titles/legends wrap and small nonzero values remain visible instead of rounding to zero', () => {
  const graphic = diagramSvg({ ...diagram, title: '長'.repeat(80), width: 640, height: 1000 });
  assert.equal((graphic.svg.match(/font-size="24"/g) || []).length, 4);
  const pie = chartSvg({ ...chart, type: 'pie', labels: ['very small', 'other'], series: [{ name: 'sample', values: [.0001, .0002] }] });
  assert.match(pie.svg, /1.0e-4/);
  const crowded = { ...chart, type: 'pie', width: 640, height: 400, labels: Array(12).fill('長'.repeat(12)), unit: '長'.repeat(20), series: [{ name: 'sample', values: Array(12).fill(1) }] };
  assert.throws(() => chartSvg(crowded), /圖例/);
});
