import MarkdownIt from 'markdown-it';
import cjkFriendly from 'markdown-it-cjk-friendly';
import katex from 'katex';
import highlight from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import yaml from 'highlight.js/lib/languages/yaml';
const languages = { javascript, typescript, python, json, bash, css, xml, markdown, cpp, java, yaml };
for (const [name, language] of Object.entries(languages)) highlight.registerLanguage(name, language);
const md = new MarkdownIt({ html: false, breaks: false, linkify: false, highlight: (code, language) => {
  if (code.length < 32000 && highlight.getLanguage(language)) { try { return highlight.highlight(code, { language, ignoreIllegals: true }).value; } catch {} }
  return md.utils.escapeHtml(code);
} });
md.validateLink = url => /^https?:\/\//i.test(url) || (!/^[a-z]+:/i.test(url) && !url.startsWith('//'));
md.renderer.rules.image = (tokens, index) => `<span class="image-reference">${md.utils.escapeHtml(tokens[index].content || '圖片')}</span>`;

md.use(cjkFriendly);

// Parse math before Markdown escapes/emphasis, so TeX and code never interfere.
// Render native MathML: offline, accessible, and compatible with the webview CSP.
function renderMath(source, display) {
  try {
    if (source.length > 16000) throw new Error('Formula too large');
    return katex.renderToString(source, { displayMode: display, output: 'mathml',
      trust: false, throwOnError: true, strict: 'ignore', maxExpand: 1000, maxSize: 20 });
  } catch {
    return `<code class="math-source">${md.utils.escapeHtml(source)}</code>`;
  }
}
function escaped(source, position) {
  let count = 0;
  while (position > 0 && source[--position] === '\\') count++;
  return count % 2 === 1;
}
md.inline.ruler.before('escape', 'math', (state, silent) => {
  const start = state.pos, source = state.src;
  let open, close, display = false;
  if (source.startsWith('\\(', start)) { open = '\\('; close = '\\)'; }
  else if (source.startsWith('\\[', start)) { open = '\\['; close = '\\]'; display = true; }
  else if (source.startsWith('$$', start)) { open = close = '$$'; display = true; }
  else if (source[start] === '$' && !/\s/.test(source[start + 1] || ' ') && !/\d/.test(source[start - 1] || '')) open = close = '$';
  else return false;
  let end = start + open.length;
  while ((end = source.indexOf(close, end)) >= 0 && end < state.posMax) {
    if (!escaped(source, end) && (close !== '$' || (!/\s/.test(source[end - 1]) && !/\d/.test(source[end + 1] || '')))) break;
    end += close.length;
  }
  if (end < 0 || end >= state.posMax || end === start + open.length) return false;
  const content = source.slice(start + open.length, end);
  if (!display && content.includes('\n')) return false;
  if (!silent) { const token = state.push('math', '', 0); token.content = content; token.meta = { display }; }
  state.pos = end + close.length;
  return true;
});
md.renderer.rules.math = (tokens, index) => renderMath(tokens[index].content, tokens[index].meta.display);
md.block.ruler.before('paragraph', 'math_block', (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const first = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
  const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
  if (!open) return false;
  const close = open === '$$' ? '$$' : '\\]';
  let content = first.slice(open.length), next = start;
  while (true) {
    const finish = content.lastIndexOf(close);
    if (finish >= 0 && !escaped(content, finish) && !content.slice(finish + close.length).trim()) {
      if (silent) return true;
      const token = state.push('math_block', '', 0); token.block = true; token.map = [start, next + 1];
      token.content = content.slice(0, finish).trim(); state.line = next + 1; return true;
    }
    if (++next >= end || state.sCount[next] < state.blkIndent) return false;
    content += '\n' + state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
    if (content.length > 32000) return false;
  }
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
md.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${renderMath(tokens[index].content, true)}</div>\n`;
export { md };
