'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const renderer = import('../media/markdown-renderer.mjs');
const sample = '核心問題：最大攝氧量（$VO_{2max}$）是衡量**心肺耐力（CRF）**的黃金標準，也是評估健康老化的關鍵生物標記。';
test('Chinese punctuation emphasis and inline math render together without rewriting saved source', async () => {
  const { md } = await renderer, html = md.render(sample);
  assert.match(html, /<strong>心肺耐力（CRF）<\/strong>/); assert.match(html, /<msub>/);
  assert.match(html, /encoding="application\/x-tex">VO_\{2max\}/); assert.doesNotMatch(html, /\*\*|\$VO/);
  assert.match(md.render('中文**「重要。」**接續與*（斜體）*接續'), /<strong>「重要。」<\/strong>接續與<em>（斜體）<\/em>/);
});
test('all common math delimiters work, including nested list display blocks', async () => {
  const { md } = await renderer;
  for (const source of ['$x^2$', '\\(x^2\\)', '$$x^2$$', '\\[x^2\\]', '$$\n\\frac{a}{b}\n$$', '\\[\n\\sum_{i=1}^n i\n\\]']) {
    const html = md.render(source); assert.match(html, /<math/); assert.doesNotMatch(html, /math-source/);
  }
  assert.match(md.render('- 公式\n\n  $$\n  x^2\n  $$'), /<li>[\s\S]*<math/);
  assert.match(md.render('文字\n$$\nx^2\n$$\n後文'), /<\/p>\n<div class="math-block">[\s\S]*<p>後文/);
});
test('tables, nested lists, quotes, strikethrough and highlighted code retain Markdown semantics', async () => {
  const { md } = await renderer;
  const html = md.render('# 標題\n\n> 引用\n\n- 一\n  - 二\n\n~~刪除~~\n\n| A | B |\n| --- | --- |\n| $x$ | **值** |\n\n```javascript\nconst formula = "$x$ **literal**";\n```');
  for (const tag of ['h1', 'blockquote', 'ul', 's', 'table', 'math', 'strong']) assert.match(html, new RegExp('<'+tag+'[ >]'));
  assert.match(html, /hljs-keyword/); assert.match(html, /\$x\$ \*\*literal\*\*/);
  assert.equal((html.match(/<math/g) || []).length, 1);
  assert.match(md.render('`$x$` and \\$x\\$ and $20 and $30'), /<code>\$x\$<\/code> and \$x\$ and \$20 and \$30/);
});
test('partial streams and invalid or hostile formulas preserve readable text without unsafe markup', async () => {
  const { md } = await renderer;
  for (const source of ['$x_{', '\\(partial', '$$\npartial']) assert.doesNotMatch(md.render(source), /<math/);
  for (const source of ['$\\unknown{x}$', '$\\def\\x{\\x}\\x$', '$'+ 'x'.repeat(16001) +'$']) assert.match(md.render(source), /math-source/);
  const html = md.render('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![remote](https://evil.invalid/pixel)\n\n$\\href{javascript:alert(1)}{x}$\n\n$\\includegraphics{https://evil.invalid/pixel}$');
  assert.doesNotMatch(html, /<script|<img|href="javascript:|src="https:/); assert.match(html, /&lt;script/);
  md.render('$\\gdef\\persist{x}$');
  assert.match(md.render('$\\persist$'), /math-source/);
});
