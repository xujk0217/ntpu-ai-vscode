/* global acquireVsCodeApi */
'use strict';
const { loginPresentation } = require('./login-state');
const MarkdownIt = require('markdown-it');
const highlight = require('highlight.js/lib/core');
const languages = { javascript: require('highlight.js/lib/languages/javascript'), typescript: require('highlight.js/lib/languages/typescript'),
  python: require('highlight.js/lib/languages/python'), json: require('highlight.js/lib/languages/json'), bash: require('highlight.js/lib/languages/bash'),
  css: require('highlight.js/lib/languages/css'), xml: require('highlight.js/lib/languages/xml'), markdown: require('highlight.js/lib/languages/markdown'),
  cpp: require('highlight.js/lib/languages/cpp'), java: require('highlight.js/lib/languages/java'), yaml: require('highlight.js/lib/languages/yaml') };
for (const [name, language] of Object.entries(languages)) highlight.registerLanguage(name, language);
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const send = (kind, extra = {}) => vscode.postMessage({ kind, ...extra });
let state = { busy: false, options: { agent: 'build', depth: 'standard', permission: 'ask', web: true, skills: [] } };
let session = { messages: [], changes: [] }, sessions = [], capabilities = { skills: [], servers: [], tools: [] }, approval = null, tab = 'sessions';
let includeEditor = true;
let memory = { project: { entries: [] }, tasks: [] }, sessionQuery = '', includeArchived = false, historyEditing = false;
const selectedSessions = new Set();
const nodes = new Map();
const names = { name_session: '背景建立聊天名稱', cleanup_conversations: '已清理校方任務對話', agent_task: '唯讀子任務', delegate_tasks: '分派子任務', retry_task: '重要子任務排回佇列', get_task_results: '收集子任務', cancel_task: '取消子任務', ntpu_lookup: '查詢北大官方研究資料', list_files: '探索專案', read_file: '讀取檔案', search_text: '搜尋程式碼', write_file: '修改檔案', edit_file: '編輯區段', run_command: '執行指令', web_search: '搜尋網路', web_fetch: '讀取網頁', inspect_image: '分析圖片', create_visual: '繪製圖片', load_skill: '載入 skill', update_plan: '更新計畫', ask_user: '詢問偏好' };
const icons = { run_command: 'terminal', web_search: 'globe', web_fetch: 'globe', inspect_image: 'image', create_visual: 'image', load_skill: 'spark', update_plan: 'check', search_text: 'search' };
const modelNames = { 'cloud-small-claude': 'Claude · Small', 'cloud-small-gemini': 'Gemini · Small', 'cloud-medium-claude': 'Claude · Medium', 'cloud-medium-gemini': 'Gemini · Medium', 'cloud-large-claude': 'Claude · Large', 'cloud-large-gemini': 'Gemini · Large' };
const md = new MarkdownIt({ html: false, breaks: false, linkify: false, highlight: (code, language) => {
  if (code.length < 32000 && highlight.getLanguage(language)) { try { return highlight.highlight(code, { language, ignoreIllegals: true }).value; } catch {} }
  return md.utils.escapeHtml(code);
} });
md.validateLink = url => /^https?:\/\//i.test(url) || (!/^[a-z]+:/i.test(url) && !url.startsWith('//'));
md.renderer.rules.image = (tokens, index) => `<span class="image-reference">${md.utils.escapeHtml(tokens[index].content || '圖片')}</span>`;

function element(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; }
function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-' + name); svg.append(use); svg.setAttribute('aria-hidden', 'true'); return svg; }
function button(text, className, handler, iconName) { const item = element('button', className); item.type = 'button'; if (text) item.title = text; if (iconName) item.append(icon(iconName)); if (text) item.append(element('span', '', text)); item.addEventListener('click', handler); return item; }
function iconButton(name, title, handler) { const item = button('', 'icon-button', handler, name); item.title = title; item.setAttribute('aria-label', title); return item; }
function markdown(text) {
  const body = element('div', 'markdown'); body.innerHTML = md.render(String(text || ''));
  for (const pre of body.querySelectorAll('pre')) {
    const code = pre.querySelector('code'); const wrapper = element('div', 'code-block');
    const bar = element('div', 'code-toolbar');
    const language = [...(code?.classList || [])].find(name => name.startsWith('language-'))?.slice(9) || 'code';
    bar.append(element('span', '', language), iconButton('copy', '複製程式碼', () => send('copy', { text: code?.textContent || '' })));
    pre.before(wrapper); wrapper.append(bar, pre);
  }
  body.addEventListener('click', event => { const link = event.target.closest('a'); if (link) { event.preventDefault(); send('openLink', { url: link.getAttribute('href') }); } });
  return body;
}

function empty() {
  const welcome = element('div', 'welcome');
  const mark = element('div', 'welcome-mark'); mark.append(icon('spark'));
  welcome.append(mark, element('h2', '', '今天想完成什麼？'), element('p', '', '把想法交給 agent，從專案脈絡開始。'));
  const grid = element('div', 'suggestions');
  for (const [name, agent, prompt, image] of [
    ['建立功能', 'build', '請先看一下這個專案，協助我新增：', 'code'],
    ['找出問題', 'build', '請幫我追查並修正這個錯誤：', 'terminal'],
    ['檢查程式碼', 'review', '請檢查目前程式碼，找出具體的錯誤與回歸風險。', 'shield'],
    ['查資料', 'research', '請搜尋官方資料，整理並附上來源：', 'globe'],
  ]) grid.append(button(name, 'suggestion', () => { send('option', { key: 'agent', value: agent }); $('prompt').value = prompt; updateComposer(); $('prompt').focus(); }, image));
  welcome.append(grid); return welcome;
}

function readableResult(content, message, result) {
  if (!result || typeof result !== 'object') { content.append(element('pre', 'tool-output', message.result)); return; }
  let readable = false;
  if (message.name === 'agent_task') {
    if (result.activity) content.append(element('div', 'execution-meta', result.activity));
    if (result.retryReason) content.append(element('p', 'result-note', '重試原因：' + result.retryReason));
    if (typeof result.result === 'string' && result.result.trim()) { content.append(markdown(result.result)); readable = true; }
  } else {
    const text = result.error || result.message || result.text || (typeof result.content === 'string' ? result.content : '');
    if (text) { content.append(element('pre', 'tool-output' + (result.ok === false ? ' result-error' : ''), text)); readable = true; }
    if (Array.isArray(result.files)) { content.append(element('pre', 'tool-output', result.files.join('\n') || '沒有符合條件的檔案。')); readable = true; }
    if (Array.isArray(result.matches)) { content.append(element('pre', 'tool-output', result.matches.map(item => `${item.path}:${item.line}  ${item.text}`).join('\n') || '沒有符合條件的結果。')); readable = true; }
    if (Number.isFinite(result.start_line)) content.prepend(element('div', 'execution-meta', `第 ${result.start_line}–${result.end_line} 行${result.truncated ? ' · 已截短' : ' · 完整讀取此區段'}`));
    if (result.saved || result.changed === false) { content.append(element('p', 'result-note', result.changed === false ? '檔案內容無需變更。' : '檔案已儲存，可在「檔案變更」查看或撤回。')); readable = true; }
  }
  if (!readable) { content.append(element('pre', 'tool-output', message.result)); return; }
  const raw = element('details', 'raw-result'); raw.append(element('summary', '', '完整資料'), element('pre', 'tool-output', message.result)); content.append(raw);
}
function updateExecutionGroup(group) {
  if (!group) return;
  const rows = [...group.querySelectorAll('.message.tool')];
  const running = rows.filter(row => ['running', 'approval'].includes(row.dataset.status)).length;
  const issues = rows.filter(row => ['error', 'denied', 'interrupted'].includes(row.dataset.status)).length;
  group.querySelector('.execution-count').textContent = `${rows.length} 項操作`;
  group.querySelector('.execution-state').textContent = running ? `${running} 項進行中` : issues ? `${issues} 項需查看` : '已完成';
  group.classList.toggle('has-issues', !!issues); group.classList.toggle('is-running', !!running);
  if (!group.dataset.manual) group.open = !!running;
}
function executionGroup() {
  const group = element('details', 'execution-group');
  const summary = element('summary', 'execution-summary');
  summary.append(icon('terminal'), element('span', 'execution-label', '執行紀錄'), element('span', 'execution-count'), element('span', 'execution-state'), element('span', 'tool-chevron', '›'));
  summary.addEventListener('click', () => { group.dataset.manual = 'true'; });
  group.addEventListener('click', event => { if (event.target.closest('.tool-card')) group.dataset.manual = 'true'; });
  group.append(summary, element('div', 'execution-rows')); return group;
}

function renderMessage(message) {
  const wrapper = element('article', 'message ' + message.role); wrapper.dataset.id = message.id; wrapper.dataset.status = message.status || '';
  wrapper.setAttribute('aria-label', message.role === 'user' ? '你的提問' : message.role === 'tool' ? '工具執行' : 'Agent 訊息');
  if (message.role === 'tool') {
    const details = element('details', 'tool-card ' + message.status);
    const summary = element('summary', 'tool-summary');
    summary.append(icon(icons[message.name] || 'file'));
    let label = names[message.name] || capabilities.tools.find(tool => tool.name === message.name)?.description?.slice(0, 50) || message.name;
    if (message.status === 'done') label = { read_file: '已讀取', list_files: '已探索專案', search_text: '已搜尋程式碼',
      write_file: message.outcome?.changed === false ? '檔案無需變更' : message.outcome?.created ? '已建立' : '已修改', edit_file: '已修改',
      run_command: '已執行', web_search: '已搜尋網路', web_fetch: '已讀取網頁', create_visual: '已繪製', inspect_image: '已分析圖片',
      load_skill: '已載入 skill', update_plan: '已更新計畫' }[message.name] || label;
    if (message.name === 'agent_task') label = { explore: '探索子任務', research: '研究子任務', review: '審查子任務' }[message.args?.role] || '子任務';
    const meta = element('div', 'tool-meta'); meta.append(element('strong', '', label));
    const args = message.args || {}, hint = args.path || args.command || args.query || args.url || args.name;
    if (hint) meta.append(element('span', 'tool-hint', String(hint).slice(0, 180)));
    summary.append(meta, element('span', 'tool-status ' + message.status, { running: '進行中', done: '完成', denied: '未允許', error: '未完成', interrupted: '已中斷' }[message.status] || message.status), element('span', 'tool-chevron', '›'));
    const content = element('div', 'tool-detail');
    if (message.name === 'agent_task' && message.status === 'running') content.append(button('停止此子任務', 'text-button', () => send('cancelWorker', { id: message.id }), 'stop'));
    if (args.path) content.append(button('開啟 ' + args.path, 'text-button', () => send('openFile', { path: args.path }), 'file'));
    if (args.command) content.append(element('pre', 'command', args.command));
    let result; try { result = JSON.parse(message.result || 'null'); } catch {}
    if (message.name === 'run_command') {
      content.append(element('div', 'execution-meta', '工作目錄：' + (args.cwd || '.') + (result?.approval ? ' · ' + result.approval : '')));
      if (message.liveOutput || result?.output) content.append(element('pre', 'tool-output terminal-output', result?.output || message.liveOutput));
      if (result) content.append(element('div', 'execution-meta', `退出碼：${result.exit_code ?? '—'}${result.timed_out ? ' · 逾時' : ''}${result.truncated ? ' · 輸出已截短' : ''}`));
      if (result?.error || result?.denied) content.append(element('pre', 'tool-output', result.error || result.message));
    } else if (message.result) readableResult(content, message, result);
    else if (Object.keys(args).length) content.append(element('pre', 'tool-output', JSON.stringify(args, null, 2)));
    if (message.finishedAt && message.startedAt) content.append(element('span', 'elapsed', '總耗時（含核准等待）：' + ((message.finishedAt - message.startedAt) / 1000).toFixed(1) + ' 秒'));
    details.append(summary, content); wrapper.append(details); return wrapper;
  }
  if (message.role === 'artifact') {
    wrapper.append(element('div', 'artifact-caption', message.text));
    if (message.imageUri) { const image = element('img', 'artifact-image'); image.src = message.imageUri; image.alt = message.text; wrapper.append(image); }
    const actions = element('div', 'artifact-actions'); actions.append(button('檢視圖片', 'text-button', () => send('openArtifact', { id: message.artifactId }), 'image'), button('另存圖片', 'text-button', () => send('saveArtifact', { id: message.artifactId }), 'export')); wrapper.append(actions);
    return wrapper;
  }
  if (['notice', 'error', 'commentary'].includes(message.role)) { wrapper.hidden = !message.text?.trim(); if (message.role === 'error') wrapper.append(element('strong', 'notice-title', '需要處理')); wrapper.append(element('div', 'notice-text', message.text)); return wrapper; }
  const top = element('div', 'message-heading');
  if (message.role === 'user') top.append(element('span', '', message.canceled ? '你 · 已取消' : message.queued ? '你 · 已排入佇列' : '你'));
  else { const mark = element('span', 'assistant-mark', 'N'); top.append(mark, element('span', '', 'NTPU AI')); }
  top.append(iconButton('copy', '複製訊息', () => send('copy', { text: message.text || '' })));
  const body = message.role === 'user' ? element('div', 'user-body', message.text) : markdown(message.text);
  wrapper.append(top, body);
  if (message.role === 'user' && (message.text?.length > 500 || message.text?.split('\n').length > 8)) {
    body.classList.add('clamped-request'); body.id = 'request-' + message.id;
    const toggle = button('展開完整提問', 'text-button user-expand', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded)); body.classList.toggle('clamped-request', !expanded); toggle.querySelector('span').textContent = expanded ? '收合提問' : '展開完整提問';
    });
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', body.id); wrapper.append(toggle);
  }
  if (message.attachment) { const attached = element('div', 'message-attachment'); attached.append(icon('image'), element('span', '', message.attachment.name)); if (message.attachment.preview) { const image = element('img'); image.src = message.attachment.preview; image.alt = message.attachment.name; attached.append(image); } wrapper.append(attached); }
  return wrapper;
}
function nearBottom() { return $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100; }
function addMessage(message, replace = false) {
  const follow = nearBottom(); const old = nodes.get(message.id); const open = old?.querySelector('details')?.open; const rawOpen = old?.querySelector('.raw-result')?.open; const userExpanded = old?.querySelector('.user-expand')?.getAttribute('aria-expanded') === 'true';
  const item = renderMessage(message);
  if (old && replace) {
    const group = old.closest('.execution-group');
    if (open && item.querySelector('details')) item.querySelector('details').open = true;
    if (userExpanded) item.querySelector('.user-expand')?.click();
    if (rawOpen && item.querySelector('.raw-result')) item.querySelector('.raw-result').open = true;
    old.replaceWith(item); updateExecutionGroup(group);
  } else {
    $('messages').querySelector('.welcome')?.remove();
    if (message.role === 'tool') {
      let group = $('messages').lastElementChild;
      if (group?.classList.contains('execution-group')) {
        group.querySelector('.execution-rows').append(item); updateExecutionGroup(group);
      } else if (group?.classList.contains('tool')) {
        const previous = group; group = executionGroup(); previous.before(group);
        if (previous.querySelector('.tool-card')?.open) group.dataset.manual = 'true';
        group.querySelector('.execution-rows').append(previous, item); updateExecutionGroup(group);
        if (group.dataset.manual) group.open = true;
      } else $('messages').append(item);
    } else $('messages').append(item);
  }
  nodes.set(message.id, item); if (follow) $('messages').scrollTop = $('messages').scrollHeight;
}
function renderSession(value) {
  const expandedUsers = new Set([...$('messages').querySelectorAll('.user-expand[aria-expanded="true"]')].map(node => node.closest('.message').dataset.id));
  const openRaw = new Set([...$('messages').querySelectorAll('.raw-result[open]')].map(node => node.closest('.message').dataset.id));
  const openTools = new Set([...$('messages').querySelectorAll('.tool-card[open]')].map(node => node.closest('.message').dataset.id));
  const groupChoices = new Map();
  for (const group of $('messages').querySelectorAll('.execution-group[data-manual]')) for (const row of group.querySelectorAll('.message.tool')) groupChoices.set(row.dataset.id, group.open);
  session = value; nodes.clear(); $('messages').replaceChildren();
  $('rename').textContent = value.title;
  if (!value.messages.length) $('messages').append(empty()); else value.messages.forEach(message => addMessage(message));
  for (const id of expandedUsers) nodes.get(id)?.querySelector('.user-expand')?.click();
  for (const id of openRaw) { const details = nodes.get(id)?.querySelector('.raw-result'); if (details) details.open = true; }
  for (const id of openTools) { const details = nodes.get(id)?.querySelector('.tool-card'); if (details) details.open = true; if (openRaw.has(id) && nodes.get(id)?.querySelector('.raw-result')) nodes.get(id).querySelector('.raw-result').open = true; }
  for (const group of $('messages').querySelectorAll('.execution-group')) {
    const saved = [...group.querySelectorAll('.message.tool')].find(row => groupChoices.has(row.dataset.id));
    if (saved) { group.dataset.manual = 'true'; group.open = groupChoices.get(saved.dataset.id); }
    else if ([...group.querySelectorAll('.message.tool')].some(row => openTools.has(row.dataset.id))) { group.dataset.manual = 'true'; group.open = true; }
  }
  if (value.hasMore) $('messages').prepend(button('載入較早訊息（' + value.before + ' 則）', 'secondary-button history-more', () => send('historyPage', { before: value.before })));
  renderPlan(value.plan || []); renderChanges(value.changes || []); $('messages').scrollTop = $('messages').scrollHeight;
}
function renderPlan(steps) {
  $('plan').hidden = !steps.length; $('planSteps').replaceChildren();
  const done = steps.filter(step => step.status === 'completed').length; $('planCount').textContent = `${done}/${steps.length}`;
  for (const step of steps) { const row = element('div', 'plan-step ' + step.status); row.append(icon(step.status === 'completed' ? 'check' : step.status === 'in_progress' ? 'spark' : 'clock'), element('span', '', step.title)); $('planSteps').append(row); }
}
function renderChanges(changes) {
  const openFiles = new Set([...$('changeRows').querySelectorAll('.change-file[open]')].map(node => node.dataset.id));
  const openHunks = new Set([...$('changeRows').querySelectorAll('.change-hunk[open]')].map(node => node.dataset.id));
  $('changes').hidden = !changes.length; $('changeRows').replaceChildren();
  const active = changes.filter(change => !change.reverted);
  $('changesTitle').textContent = `檔案變更 · ${new Set(active.map(change => change.path)).size}`;
  $('changeStats').textContent = active.length && active.every(item => item.binary) ? active.length + ' 張圖片' : '+' + active.reduce((sum, item) => sum + (item.added || 0), 0) + ' −' + active.reduce((sum, item) => sum + (item.removed || 0), 0);
  $('changeRows').append(element('p', 'change-explanation', '變更已套用。可保留檔案，或展開後撤回其中一段；停止任務後即可操作。'));
  for (const change of changes) {
    const card = element('details', 'change-file' + (change.reverted ? ' reverted' : ''));
    card.dataset.id = change.id; card.open = openFiles.has(change.id);
    const row = element('summary', 'change-row');
    row.append(icon(change.binary ? 'image' : 'file'), button(change.path, 'change-name', () => send('change', { id: change.id })),
      element('span', 'change-state', change.reverted ? '已撤回' : change.accepted ? '已保留' : '已套用'),
      element('span', 'added', change.reverted ? '' : change.binary ? 'PNG' : '+' + change.added), element('span', 'removed', change.reverted || change.binary ? '' : '−' + change.removed));
    card.append(row);
    const controls = element('div', 'change-controls');
    for (const [action, label] of [['accept', '保留檔案'], ['revert', '撤回檔案']]) {
      const control = button(label, action === 'revert' ? 'text-button danger-text' : 'text-button', () => send('reviewChange', { id: change.id, action }));
      control.disabled = state.busy || change.reverted || action === 'accept' && change.accepted || action === 'revert' && change.protected;
      controls.append(control);
    }
    card.append(controls);
    for (const part of change.reverted ? [] : change.hunks || []) {
      const detail = element('details', 'change-hunk');
      detail.dataset.id = part.id; detail.open = openHunks.has(part.id);
      detail.append(element('summary', '', `第 ${part.line} 行 · +${part.added} −${part.removed}` + (part.accepted ? ' · 已保留' : '')));
      const preview = element('div', 'hunk-preview');
      if (part.before) preview.append(element('pre', 'hunk-removed', '− ' + part.before));
      if (part.after) preview.append(element('pre', 'hunk-added', '+ ' + part.after));
      if (part.truncated) preview.append(element('span', 'change-state', '預覽已截短；檔案名稱可開啟完整 diff。'));
      detail.append(preview);
      const actions = element('div', 'change-controls');
      for (const [action, label] of [['accept', '保留這段'], ['revert', '撤回這段']]) {
        const control = button(label, action === 'revert' ? 'text-button danger-text' : 'text-button', () => send('reviewChange', { id: change.id, action, hunkId: part.id }));
        control.disabled = state.busy || action === 'accept' && (part.accepted || change.accepted) || action === 'revert' && change.protected;
        actions.append(control);
      }
      detail.append(actions); card.append(detail);
    }
    $('changeRows').append(card);
  }
}

function updateComposer() {
  $('send').disabled = !$('prompt').value.trim();
  $('send').title = state.busy ? '排入佇列，等待目前任務完成後執行' : '送出';
  $('send').setAttribute('aria-label', state.busy ? '排入佇列' : '送出');
  $('sendLabel').hidden = !state.busy;
  $('sendHint').hidden = !!state.busy;
}

function renderState(value) {
  const busyChanged = !!state.busy !== !!value.busy;
  state = value;
  if (state.sessionTitle) $('rename').textContent = state.sessionTitle;
  for (const key of ['agent', 'depth', 'permission']) { $(key).value = state.options[key]; $(key).disabled = state.busy || !!approval; }
  $('workspace').querySelector('span').textContent = state.workspace;
  $('connect').classList.toggle('connected', !!state.connection?.ready); $('connect').title = state.connection?.message || '登入 NTPU AI';
  $('connectionLabel').textContent = state.connection?.connecting ? '正在連線…' : state.connection?.ready ? '已連線' : state.connection?.loginWindow ? '返回登入視窗' : state.connection?.authentication === 'unknown' ? '重新連線 NTPU AI' : '登入';
  $('connect').disabled = state.busy || !!state.connection?.connecting;
  const login = loginPresentation(state.connection);
  $('loginNotice').hidden = login.hidden;
  $('loginNotice').classList.toggle('needs-login', login.required);
  $('loginNoticeTitle').textContent = login.title;
  $('loginNoticeText').textContent = login.text;
  $('loginPrimary').textContent = login.action;
  $('loginPrimary').hidden = !login.action;
  $('loginPrimary').disabled = state.busy || !!state.connection?.connecting;
  $('connectionActions').hidden = !!state.connection?.ready || !login.hidden;
  $('model').textContent = modelNames[state.model] || 'NTPU AI · 自動';
  const liveParallel = state.parallel;
  $('parallelStatus').hidden = !liveParallel?.enabled;
  $('parallelStatus').textContent = liveParallel ? `並行上限 ${liveParallel.effectiveConcurrency}/4 · 執行中 Agent ${liveParallel.runningAgents} · 模型請求 ${liveParallel.activeRequests} · 排隊 ${liveParallel.queuedRequests}${liveParallel.queuedTasks ? ' · 待執行提問 ' + liveParallel.queuedTasks : ''}${liveParallel.blocked ? ' · 已暫停發送' : ''}` : '';
  $('parallelStatus').title = 'Agent 包含主 Agent 和運作中的唯讀子任務；模型請求排隊共用動態名額與每分鐘節奏。';
  $('progress').hidden = !state.busy; $('progressText').textContent = state.progress;
  $('budgetLabel').textContent = state.budget?.total ? `脈絡 ${Math.min(100, Math.round(state.budget.used / state.budget.total * 100))}%` : '';
  $('stop').hidden = !state.busy; updateComposer();
  if (busyChanged && state.busy) resetHistoryEditing();
  if (busyChanged) renderChanges(session.changes || []);
  $('web').classList.toggle('on', state.options.web); $('web').setAttribute('aria-pressed', String(state.options.web)); $('web').disabled = state.busy; $('web').title = state.options.web ? '網路搜尋已開啟：Agent 可使用 Exa 搜尋和公開網頁讀取；按一下關閉。AI4X 是獨立的官方研究工具。' : '網路搜尋已關閉：按一下允許 Agent 使用 Exa 搜尋和公開網頁讀取。';
  $('skills').title = 'Skills：Agent 可依任務載入適用技能；在此選擇預先載入的技能。技能不會增加工具權限。';
  if (!$('drawer').hidden && ['tools', 'connection', 'security'].includes(tab) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) renderDrawer();
  if (!$('drawer').hidden && tab === 'sessions' && busyChanged) renderDrawer();
  $('skillsCount').textContent = state.options.skills?.length ? state.options.skills.length : '';
  $('new').disabled = state.busy || !!approval;
  $('permission').title = { ask: '專案讀取與基本唯讀指令自動；修改、其他指令及外部工具先確認。', assisted: '工作區修改及公開搜尋自動；只有已辨識的唯讀指令自動執行。', full: '工具自動執行。終端機與 MCP 使用你的使用者權限；檔案工具維持工作區範圍。' }[state.options.permission];
  $('permissionDescription').textContent = { ask: '修改與外部操作先確認', assisted: '工作區自動 · 指令依風險確認', full: '自動執行 · 使用者權限' }[state.options.permission];
  document.body.classList.toggle('full-access', state.options.permission === 'full');
  const chips = $('contextChips'); chips.replaceChildren();
  if (includeEditor && state.editor) { const chip = element('span', 'context-chip'); chip.append(icon('file'), element('span', '', state.editor.name + (state.editor.selected ? ':' + state.editor.line + '–' + state.editor.endLine : '')), iconButton('close', '不帶入目前檔案', () => { includeEditor = false; renderState(state); })); chips.append(chip); }
  for (const file of state.contexts || []) { const chip = element('span', 'context-chip'); chip.append(icon('file'), element('span', '', file.name), iconButton('close', '移除脈絡檔案', () => send('removeContext', { path: file.path }))); chips.append(chip); }

  $('attachment').hidden = !state.attachment; $('attachment').replaceChildren();
  if (state.attachment) {
    if (state.attachment.preview) { const image = element('img'); image.src = state.attachment.preview; image.alt = state.attachment.name; $('attachment').append(image); }
    $('attachment').append(element('span', '', state.attachment.name), iconButton('close', '移除附件', () => send('removeAttachment')));
  }
  $('queue').hidden = !state.queue?.length; $('queue').replaceChildren();
  for (const queued of state.queue || []) { const row = element('div', 'queue-row'); row.append(icon('clock'), element('span', '', queued.request.slice(0, 55)), iconButton('close', '移除佇列提問', () => send('cancelQueue', { id: queued.id }))); $('queue').append(row); }
}

function renderApproval(value) {
  approval = value; $('approval').hidden = !value;
  document.body.classList.toggle('has-approval', !!value);
  if (!value) { if (state.options) renderState(state); return; }
  $('drawer').hidden = true;
  $('approvalTitle').textContent = value.title; $('approvalDetail').textContent = value.detail;
  $('approve').textContent = value.accept; $('approve').disabled = false; $('deny').disabled = false; $('grantSession').checked = false;
  $('grantLabel').hidden = !value.tool || value.tool.startsWith('mcp_');
  $('grantText').textContent = value.tool === 'run_command' ? '本工作階段允許所有終端機指令' : ['write_file', 'edit_file'].includes(value.tool) ? '本工作階段自動允許此修改工具' : '本工作階段允許此工具的後續呼叫';
  $('approvalImage').hidden = !value.previewUri; if (value.previewUri) $('approvalImage').src = value.previewUri;
  $('questionAnswer').hidden = value.type !== 'question'; $('questionAnswer').value = ''; $('questionOptions').replaceChildren();
  for (const option of value.options || []) $('questionOptions').append(button(option, 'question-option', () => { $('questionAnswer').value = option; $('questionOptions').querySelectorAll('button').forEach(item => item.classList.toggle('chosen', item.textContent === option)); }));
  renderState(state);
}

function resetHistoryEditing() { historyEditing = false; includeArchived = false; selectedSessions.clear(); }
function openDrawer(nextTab) { resetHistoryEditing(); tab = nextTab; $('drawer').hidden = false; if (tab === 'memory') send('memory'); renderDrawer(); }
function renderDrawer() {
  $('drawerTitle').textContent = { sessions: '聊天紀錄', skills: 'Skills', connection: '連線', security: '安全與權限', tools: '工具', memory: '記憶與隱私' }[tab];
  $('historyEdit').hidden = tab !== 'sessions'; $('historyEdit').textContent = historyEditing ? '完成' : '編輯';
  $('historyEdit').disabled = !historyEditing && (state.busy || !!approval);
  $('historyEdit').title = historyEditing ? '結束編輯並清除選取' : '選取聊天以進行批次管理';
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item.dataset.tab === tab));
  const content = $('drawerContent'); content.replaceChildren();
  if (tab === 'sessions') {
    const locked = state.busy || !!approval;
    const create = button('新增聊天', 'primary-button full-width', () => { send('new'); $('drawer').hidden = true; }, 'plus'); create.disabled = locked; if (historyEditing) content.append(create);
    const search = element('input', 'history-search'); search.placeholder = '搜尋聊天名稱與任務'; search.setAttribute('aria-label', '搜尋聊天紀錄'); search.value = sessionQuery;
    search.addEventListener('input', () => { sessionQuery = search.value; selectedSessions.clear(); filterSessions(); }); content.append(search);
    const archived = element('label', 'privacy-option'); const show = element('input'); show.type = 'checkbox'; show.checked = includeArchived;
    show.addEventListener('change', () => { includeArchived = show.checked; selectedSessions.clear(); filterSessions(); }); archived.append(show, element('span', '', '顯示已封存的聊天')); if (historyEditing) content.append(archived);
    for (const id of selectedSessions) if (!sessions.some(item => item.id === id)) selectedSessions.delete(id);
    const toolbar = element('div', 'history-toolbar'); if (historyEditing) content.append(toolbar);
    const list = element('div', 'session-list'); content.append(list);
    let visible = [];
    function selectionToolbar() {
      if (!historyEditing) return;
      toolbar.replaceChildren();
      const all = button(selectedSessions.size === visible.length && visible.length ? '取消全選' : '選取全部', 'text-button', () => {
        if (selectedSessions.size === visible.length && visible.length) selectedSessions.clear(); else for (const item of visible) selectedSessions.add(item.id);
        filterSessions();
      }); all.disabled = locked || !visible.length;
      const count = element('span', 'history-count', selectedSessions.size ? `已選 ${selectedSessions.size} 個` : `${visible.length} 個聊天`); count.setAttribute('aria-live', 'polite');
      toolbar.append(all, count);
      for (const [text, action] of [['封存所選', 'archive'], ['取消封存所選', 'unarchive'], ['刪除所選', 'delete']]) {
        const control = button(text, 'text-button' + (action === 'delete' ? ' danger-text' : ''), () => send('sessionsAction', { action, ids: [...selectedSessions] }));
        control.disabled = locked || !selectedSessions.size || action === 'archive' && !visible.some(item => selectedSessions.has(item.id) && !item.archived) || action === 'unarchive' && !visible.some(item => selectedSessions.has(item.id) && item.archived);
        toolbar.append(control);
      }
    }
    function filterSessions() {
      list.replaceChildren();
      visible = sessions.filter(item => (includeArchived || !item.archived) && ((item.title || '') + ' ' + (item.searchText || '')).toLowerCase().includes(sessionQuery.toLowerCase()));
      for (const id of selectedSessions) if (!visible.some(item => item.id === id)) selectedSessions.delete(id);
      for (const item of visible) {
        const card = element('div', 'session-item');
        const heading = element('div', 'session-card-header'); const check = element('input', 'session-select'); check.type = 'checkbox'; check.checked = selectedSessions.has(item.id); check.disabled = locked; check.setAttribute('aria-label', '選取聊天：' + item.title);
        check.addEventListener('change', () => { if (check.checked) selectedSessions.add(item.id); else selectedSessions.delete(item.id); selectionToolbar(); });
        const row = button('', 'session-row' + (item.id === session.id ? ' current' : ''), () => { if (locked) return; if (historyEditing) { if (selectedSessions.has(item.id)) selectedSessions.delete(item.id); else selectedSessions.add(item.id); filterSessions(); } else { send('switch', { id: item.id }); resetHistoryEditing(); $('drawer').hidden = true; } });
        row.append(element('strong', '', item.title), element('span', '', new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.updatedAt) + (item.pending ? ' · ' + item.pending + ' 個未完成任務' : '') + (item.archived ? ' · 已封存' : '')));
        row.disabled = locked; row.title = (historyEditing ? '勾選／取消選取：' : '開啟聊天：') + item.title;
        const menu = element('details', 'session-menu'); const summary = element('summary', '', '⋯'); summary.setAttribute('aria-label', '管理聊天：' + item.title);
        menu.append(summary); const actions = element('div', 'session-menu-actions');
        for (const [text, kind] of [['重新命名', 'renameSession'], ['匯出 Markdown', 'exportSession'], [item.archived ? '取消封存' : '封存', 'archiveSession'], ['刪除', 'deleteSession']]) {
          const control = button(text, 'text-button' + (kind === 'deleteSession' ? ' danger-text' : ''), () => { menu.open = false; send(kind, { id: item.id }); }); control.disabled = locked; actions.append(control);
        }
        menu.addEventListener('toggle', () => { if (menu.open) for (const other of list.querySelectorAll('.session-menu')) if (other !== menu) other.open = false; });
        menu.append(actions); if (historyEditing) heading.append(check, row, menu); else heading.append(row); card.append(heading); list.append(card);
      }
      if (!visible.length) list.append(element('p', 'panel-description', sessionQuery ? '找不到符合的聊天紀錄。' : '目前沒有聊天紀錄。'));
      selectionToolbar();
    }
    filterSessions();
  } else if (tab === 'skills') {
    content.append(element('p', 'panel-description', '把重複的工作方式寫成 SKILL.md。所有已發現的 skills 預設都可按需載入；勾選只代表在這個工作階段預載。'));
    content.append(button('重新掃描 skills', 'secondary-button full-width', () => send('refreshSkills'), 'spark'));
    content.append(button('加入使用者 skills 資料夾', 'secondary-button full-width', () => send('addSkillDirectory'), 'plus'));
    for (const skill of capabilities.skills) {
      const card = element('div', 'skill-card'); const heading = element('label', 'skill-heading'); const check = element('input'); check.type = 'checkbox'; check.checked = state.options.skills?.includes(skill.name); check.disabled = state.busy;
      check.addEventListener('change', () => send('option', { key: 'skills', value: check.checked ? [...state.options.skills, skill.name] : state.options.skills.filter(name => name !== skill.name) }));
      heading.append(check, element('strong', '', skill.name), element('span', 'badge', skill.source));
      card.append(heading, element('p', '', skill.description), button('查看 SKILL.md', 'text-button', () => send('openSkill', { name: skill.name }))); content.append(card);
    }
    if (capabilities.skillErrors?.length) content.append(element('p', 'warning-text', capabilities.skillErrors.join('\n')));
    content.append(element('p', 'panel-footnote', '支援 .agents/skills、.opencode/skills、.claude/skills，以及 ~/.ntpu-ai-coder/skills。'));
  } else if (tab === 'memory') {
    content.append(element('p', 'panel-description', '歷史與檢查點保存在本機。相關記憶會帶入模型請求；舊紀錄不代表目前檔案或測試仍然相同。'));
    for (const [key, label, checked] of [['memory.enableProject', '啟用 Project Memory', memory.enabled], ['memory.autoUpdate', '任務結束後自動整理記憶', memory.autoUpdate]]) {
      const row = element('label', 'privacy-option'), check = element('input'); check.type = 'checkbox'; check.checked = checked !== false; check.disabled = state.busy;
      check.addEventListener('change', () => send('privacySetting', { key, value: check.checked })); row.append(check, element('span', '', label)); content.append(row);
    }
    content.append(element('p', 'panel-description', '敏感路徑保護與秘密遮蔽由主機強制啟用；完整存取也不能繞過。圖片／PDF 請在上傳確認前自行檢查。'));
    content.append(button('設定需確認的檔案規則', 'secondary-button full-width', () => send('privacySettings')));
    content.append(element('h3', '', '專案記憶'));
    content.append(button('新增記憶', 'secondary-button full-width', () => send('editMemory')));
    const labels = { summary: '摘要', architecture: '架構', decision: '決策', preference: '偏好', pending: '待辦', issue: '問題', completed: '完成紀錄', verification: '驗證紀錄', observed: '已讀取' };
    for (const entry of memory.project?.entries || []) {
      const card = element('div', 'memory-card'); card.append(element('strong', '', (labels[entry.kind] || entry.kind || '記憶') + (entry.stale ? ' · 舊證據' : '')), element('p', 'memory-text', entry.text));
      const source = entry.source || {}; card.append(element('p', 'memory-source', (source.taskId ? 'Task ' + source.taskId + (source.path ? ' · ' + source.path : '') : '手動編輯') + ' · ' + new Date(source.verifiedAt || source.userEditedAt || memory.project.updatedAt || 0).toLocaleString('zh-TW')));
      const actions = element('div', 'panel-actions'); actions.append(button('編輯', 'text-button', () => send('editMemory', { id: entry.id })), button('刪除', 'text-button', () => send('deleteMemory', { id: entry.id }))); card.append(actions); content.append(card);
    }
    if (!memory.project?.entries?.length) content.append(element('p', 'panel-description', '尚無專案記憶。成功的工具紀錄會在任務結束後整理，也可手動新增。'));
    content.append(element('h3', '', '未完成任務'));
    for (const task of (memory.tasks || []).filter(task => task.status !== 'completed' && !task.resolvedBy)) {
      const card = element('div', 'memory-card'); card.append(element('strong', '', task.request), element('p', 'memory-text', task.status + ' · ' + (task.result || '可從本機檢查點接續')),
        button('接續任務', 'secondary-button', () => { send('resumeTask', { id: task.id }); $('drawer').hidden = true; })); content.append(card);
    }
    content.append(element('p', 'panel-footnote', '儲存位置：' + (memory.storage || '載入中') + '\n最近更新：' + (memory.project?.updatedAt ? new Date(memory.project.updatedAt).toLocaleString('zh-TW') : '尚無') + '\n刪除本機記憶不等於刪除校方伺服器資料。'));
    for (const [text, kind] of [['重新整理記憶', 'refreshMemory'], ['匯出完整 Session', 'export'], ['備份全部本機記憶', 'backupMemory'], ['還原備份', 'restoreMemory'], ['清空此專案記憶', 'clearMemory']]) content.append(button(text, 'secondary-button full-width', () => send(kind)));
    if (memory.error) content.append(element('p', 'warning-text', memory.error));
  } else if (tab === 'security') {
    content.append(element('h3', '', '執行隔離'), element('p', 'panel-description', (capabilities.sandbox?.label || '待檢查') + ' · 禁止 Shell／stdio MCP 網路'));
    if (capabilities.sandbox?.error) content.append(element('p', 'warning-text', capabilities.sandbox.error));
    content.append(element('h3', '', '附件隱私'), element('p', 'panel-description', '圖片逐格、PDF 逐頁在本機 OCR 並檢查嵌入文字。辨識到已知憑證或檢查失敗即阻止上傳。需要 Tesseract 與 Poppler；OCR 仍可能漏辨，傳送前請自行確認。'));
    content.append(element('h3', '', '指令核准'), element('p', 'panel-description', '核准模式由聊天底部切換。自動核准規則只影響是否詢問，所有指令仍需 OS 隔離。'), button('設定指令自動核准', 'secondary-button full-width', () => send('terminalSettings'), 'terminal'));
    content.append(button('開啟安全設定', 'secondary-button', () => send('settings'), 'gear'));
  } else if (tab === 'connection') {
    const account = element('section', 'account-card');
    const accountHeader = element('div', 'account-heading');
    const needsLogin = ['required', 'signed_out'].includes(state.connection?.authentication);
    accountHeader.append(element('strong', '', 'NTPU AI 帳號'), element('span', 'badge' + (state.connection?.ready ? ' connected' : ''), state.connection?.ready ? '已登入' : state.connection?.loginComplete ? '正在接續' : state.connection?.loginWindow ? '等待登入' : needsLogin ? '未登入' : '未連線'));
    account.append(accountHeader, element('p', 'panel-description', state.connection?.message || '登入後即可使用 NTPU AI 模型。'));
    account.append(element('p', 'panel-description', state.connection?.ready ? '背景連線運作中，無須保持登入視窗開啟。' : '按「登入」開啟專用瀏覽器，完成學校登入後自動切回背景連線。'));
    const accountAction = button(state.connection?.ready ? '登出' : state.connection?.loginWindow ? '返回登入視窗' : needsLogin ? '登入 NTPU AI' : '重新連線 NTPU AI', state.connection?.ready ? 'secondary-button account-logout' : 'secondary-button', () => {
      send(state.connection?.ready ? 'logout' : 'login');
    }, state.connection?.ready ? 'close' : 'connect');
    accountAction.disabled = state.busy || !!state.connection?.connecting; account.append(accountAction);
    account.lastChild.disabled = state.busy;
    content.append(account);
    const browser = capabilities.browser || {};
    content.append(element('h3', '', '瀏覽器'));
    const browserChoice = element('select', 'history-search'); browserChoice.setAttribute('aria-label', 'Browser');
    for (const [value, label] of [['auto', 'Auto · 自動偵測'], ['chrome', 'Google Chrome'], ['edge', 'Microsoft Edge'], ['chromium', 'Chromium'], ['custom', 'Custom · 自訂 Chromium']]) { const option = element('option', '', label); option.value = value; browserChoice.append(option); }
    browserChoice.value = browser.selection || 'auto'; browserChoice.disabled = state.busy; content.append(browserChoice);
    const advanced = element('details', 'settings-advanced'); advanced.append(element('summary', '', '進階：執行檔與專用 Profile')); content.append(advanced);
    const customPath = element('input', 'browser-path'); customPath.placeholder = 'Custom Browser Path'; customPath.setAttribute('aria-label', 'Custom Browser Path'); customPath.value = browser.customPath || ''; customPath.disabled = state.busy; advanced.append(customPath);
    const profileLocation = element('input', 'browser-path'); profileLocation.placeholder = 'Browser Profile Location · 預設使用私有儲存區'; profileLocation.setAttribute('aria-label', 'Browser Profile Location'); profileLocation.value = browser.profileLocation || ''; profileLocation.disabled = state.busy; advanced.append(profileLocation);
    const apply = button('更換瀏覽器並連線', 'secondary-button full-width', () => send('browserUpdate', { browser: browserChoice.value, customPath: customPath.value, profileLocation: profileLocation.value })); apply.disabled = state.busy; content.append(apply);
    const reconnect = button('重新連線', 'secondary-button full-width', () => send('reconnectBrowser')); reconnect.disabled = state.busy; content.append(reconnect);
    content.append(element('p', 'panel-description', (browser.info?.message || '尚未啟動可控制的瀏覽器') + '\nExtension Host：' + (browser.host || '') + (browser.remoteName ? ' · 工作區連線：' + browser.remoteName : '') + (browser.info?.profile ? '\n專用 Profile：' + browser.info.profile : '')));
  } else {
    content.append(element('h3', '', '外部能力'));
    content.append(element('p', 'panel-description', '搜尋、網頁讀取與擴充工具由本地 agent 執行。NTPU AI 負責理解需求和決定下一步。'));
    for (const server of capabilities.servers) {
      const card = element('div', 'server-card'); const heading = element('div', 'server-heading');
      heading.append(icon('connect'), element('strong', '', server.label || server.name), element('span', 'badge' + (server.connected ? ' connected' : ''), server.connecting ? '連線中…' : server.connected ? server.tools + ' 個工具' : server.builtin ? '免金鑰 · 唯讀' : '未連線'));
      card.append(heading); const details = element('details', 'settings-advanced'); details.append(element('summary', '', '連線詳情'), element('p', 'server-target', server.target)); card.append(details);
      if (server.error) card.append(element('p', 'warning-text', server.error));
      const connect = button(server.connecting ? '連線中…' : server.connected ? '中斷連線' : '連線', 'secondary-button', event => { event.currentTarget.disabled = true; event.currentTarget.textContent = '處理中…'; send(server.connected ? 'disconnectMcp' : 'connectMcp', { name: server.name }); }, server.connected ? 'close' : 'connect');
      connect.disabled = state.busy || server.connecting; card.append(connect);
      content.append(card);
    }
    const actions = element('div', 'panel-actions'); actions.append(button('新增 MCP', 'secondary-button', () => send('addMcp'), 'plus'), button('匯入設定', 'secondary-button', () => send('importMcp'), 'file')); content.append(actions);
    content.append(element('h3', '', '官方校務問答'), element('p', 'panel-description', '體育、通識、語言中心與各行政單位問題可直接使用官方 NTPU AI Assistant；此入口不會自動傳送目前聊天或專案內容。'), button('開啟 NTPU AI Assistant', 'secondary-button full-width', () => send('officialAssistant'), 'globe'));
    content.append(element('h3', '', '如何使用 AI4X'), element('p', 'panel-description', '直接在聊天描述需求，Agent 會選用已連線工具或 ntpu_lookup；不需要手動指定 11 個工具。研究資料查詢與 Exa 地球按鈕分開控制，對外傳送參數仍會依權限確認。'));
    for (const prompt of ['請查詢 NTPU AI4X 的中心資訊與合作服務，附官方來源。', '請用 AI4X 找出與人工智慧相關的研究專家及公開計畫，附官方來源。']) {
      const sample = button(prompt, 'secondary-button full-width', () => { $('prompt').value = prompt; $('drawer').hidden = true; updateComposer(); $('prompt').focus(); });
      sample.title = '將範例填入聊天；確認內容後自行送出。'; content.append(sample);
    }
    content.append(element('p', 'panel-description', '工具與 skills 由 Agent 按需求選擇。複雜任務可自動分派探索、研究、審查子任務；單純提問通常直接處理。'));
    if (capabilities.tools.length) { const list = element('details', 'tool-inventory'); list.append(element('summary', '', '已連線工具 · ' + capabilities.tools.length)); for (const tool of capabilities.tools) { const row = element('div'); row.append(element('strong', '', tool.originalName || tool.name), element('p', '', tool.description)); list.append(row); } content.append(list); }
    content.append(element('h3', '', '圖像能力'), element('p', 'panel-description', capabilities.image));
    content.append(element('h3', '', '模型與分析深度'), element('p', 'panel-description', capabilities.thinking));
    const parallel = state.parallel || capabilities.parallel || {};
    content.append(element('h3', '', 'Agent 多工'), element('p', 'panel-description', parallel.enabled === false ? '多工已停用。' : `Adaptive Concurrency：目前名額 ${parallel.effectiveConcurrency ?? 2}/4 · 執行中 Agent ${parallel.runningAgents ?? 0} · 模型請求 ${parallel.activeRequests ?? 0} · 排隊 ${parallel.queuedRequests ?? 0}。最多四個唯讀子任務，不需事先測試。`));
    if (parallel.reason) content.append(element('p', 'panel-description', parallel.reason));
    if (parallel.blocked) { const resume = button('手動恢復發送', 'secondary-button full-width', () => send('resumeParallel')); resume.title = '先處理登入／用量或服務限制；只解除暫停並從單一請求觀察，不重送失敗請求。'; resume.disabled = state.busy || !state.connection?.ready; content.append(resume); }
    for (const [key, label, values, current] of [
      ['maxConcurrency', '模型請求上限', [0,1,2,3,4], parallel.maxConcurrency ?? 0],
      ['probeMaxConcurrency', '選用診斷至', [2,3,4], parallel.maxTestConcurrency ?? 4],
      ['probeIntervalSeconds', '組間等待（秒）', [0,30,60,90,120], parallel.probeIntervalSeconds ?? 60],
      ['requestsPerMinute', '每分鐘請求節奏', [1,2,3,4,5,6,7,8,9,10], parallel.requestsPerMinute ?? 8]
    ]) {
      const row = element('label', 'parallel-setting'); row.append(element('span', '', label));
      const select = element('select', 'history-search'); select.setAttribute('aria-label', label); select.title = label + '：所有主／子任務共用動態排程與請求節奏。';
      for (const value of values) { const option = element('option', '', value === 0 && key !== 'probeIntervalSeconds' ? '自動' : String(value)); option.value = String(value); select.append(option); }
      select.value = String(current); select.disabled = state.busy;
      select.addEventListener('change', () => send('parallelUpdate', { key, value: Number(select.value) })); row.append(select); content.append(row);
    }
    const ceiling = Math.max(2, Math.min(4, parallel.maxTestConcurrency || 4));
    const probe = button(`選用並行診斷（2–${ceiling}）`, 'secondary-button full-width', () => send('testConcurrency'));
    probe.title = `依序測試 2 至 ${ceiling} 個請求，最多 ${ceiling * (ceiling + 1) / 2 - 1} 個小型模型請求；組間等待 ${parallel.probeIntervalSeconds ?? 60} 秒；失敗即停止，可能消耗校方用量。`;
    probe.disabled = state.busy || !state.connection?.ready || parallel.blocked; content.append(probe);
    const groups = parallel.verification?.groups || [];
    if (groups.length) {
      const report = element('details', 'concurrency-report'); report.append(element('summary', '', '各組並行測試結果'));
      for (const group of groups) {
        const card = element('details', 'concurrency-group');
        card.append(element('summary', '', `${group.concurrency} 個請求 · 成功 ${group.successCount}/${group.concurrency}（${Math.round(group.successRate * 100)}%） · ${group.verified ? '已驗證' : '未通過'}`));
        card.append(element('p', 'panel-description', `串流峰值：${group.observedPeakConcurrency} · 全組重疊：${group.streamOverlap ? '是' : '否'} · 串台：${group.crossTalk ? '偵測到' : '未偵測到'} · 平均回應：${group.responseTimes?.averageMs ?? '—'} ms`));
        if (group.stopReason) card.append(element('p', 'warning-text', '停止原因：' + ({ service_limit: '登入或服務限制', cancelled: '使用者停止', cross_talk: '回覆串台', reply_mismatch: '識別碼不匹配', no_overlap: '未確認全組串流重疊', request_failure: '請求失敗', startup_failure: '聊天室啟動失敗' }[group.stopReason] || group.stopReason) + (group.error ? ' · ' + group.error : '')));
        for (const request of group.requests || []) card.append(element('p', 'panel-description', `請求 ${request.index + 1}：${request.durationMs ?? '—'} ms · 首字 ${request.firstTokenMs ?? '—'} ms${request.httpStatus ? ' · HTTP ' + request.httpStatus : ''}${request.error ? ' · ' + request.error : ''}`));
        report.append(card);
      }
      content.append(report);
    }
    content.append(element('p', 'panel-description', 'Agent 模型請求另依本機每分鐘節奏排程（預設 8），等待不等於重試。測試逐組建立獨立聊天室，預設組間等待 60 秒以避免短時間累積請求；降低等待時間可能觸發頻率限制。首次失敗即停止，不自動重試。登入／服務限制或使用者停止會停止目前診斷。診斷是選用功能，不影響動態排程。正式任務從兩個名額開始，依八筆穩定回應升級；多筆延遲或網路錯誤降級，不取消已開始的一般請求。服務限制會鎖住發送，必須手動恢復，不重送失敗請求。'), button('更多多工設定', 'text-button', () => send('parallelSettings'), 'gear'));
    content.append(button('開啟 VS Code 設定', 'text-button', () => send('settings'), 'gear'));
    content.append(element('p', 'panel-footnote', '程式碼、附件與工具結果會傳給 NTPU AI；外部工具也會收到執行它所需的參數。MCP 金鑰保存在 VS Code SecretStorage。'));
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  if (message.kind === 'session') renderSession(message.session);
  else if (message.kind === 'historyPage' && message.sessionId === session.id) { renderSession({ ...session, messages: [...message.messages, ...session.messages], before: message.before, hasMore: message.hasMore }); $('messages').scrollTop = 0; }
  else if (message.kind === 'memory') { memory = message; if (!$('drawer').hidden && tab === 'memory') renderDrawer(); }
  else if (message.kind === 'message') { session.messages.push(message.message); addMessage(message.message); }
  else if (message.kind === 'patch') { const index = session.messages.findIndex(item => item.id === message.message.id); if (index >= 0) session.messages[index] = message.message; addMessage(message.message, true); }
  else if (message.kind === 'state') renderState(message);
  else if (message.kind === 'approval') renderApproval(message.approval);
  else if (message.kind === 'plan') renderPlan(message.steps);
  else if (message.kind === 'changes') { session.changes = message.changes; renderChanges(message.changes); }
  else if (message.kind === 'sessions') { sessions = message.sessions; if (!$('drawer').hidden && tab === 'sessions') renderDrawer(); }
  else if (message.kind === 'capabilities') { capabilities = message; if (!$('drawer').hidden && ['skills', 'tools', 'connection', 'security'].includes(tab) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) renderDrawer(); }
  else if (message.kind === 'prefill') { $('prompt').value = message.text; includeEditor = true; $('prompt').focus(); renderState(state); }
});

$('composer').addEventListener('submit', event => { event.preventDefault(); const text = $('prompt').value.trim(); if (!text) return; send('ask', { text, includeEditor }); $('prompt').value = ''; updateComposer(); $('prompt').style.height = ''; $('slashMenu').hidden = true; });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('composer').requestSubmit(); } if (event.key === 'Escape') $('slashMenu').hidden = true; });
$('prompt').addEventListener('input', () => {
  updateComposer();
  $('prompt').style.height = 'auto'; $('prompt').style.height = Math.min(200, $('prompt').scrollHeight) + 'px';
  const query = $('prompt').value; $('slashMenu').hidden = !/^\/[a-z-]*$/.test(query); $('slashMenu').replaceChildren();
  if (!$('slashMenu').hidden) for (const [command, description] of [['build', '實作與修正'], ['plan', '先探索，再規劃'], ['review', '唯讀程式碼審查'], ['research', '搜尋與來源整理'], ['ask', '說明與問答']]) if (command.startsWith(query.slice(1))) $('slashMenu').append(button('/' + command + ' · ' + description, 'slash-option', () => { $('prompt').value = '/' + command + ' '; updateComposer(); $('slashMenu').hidden = true; $('prompt').focus(); }));
});
for (const key of ['agent', 'depth', 'permission']) $(key).addEventListener('change', event => send('option', { key, value: event.target.value }));
$('web').addEventListener('click', () => send('option', { key: 'web', value: !state.options.web }));
$('history').addEventListener('click', () => openDrawer('sessions')); $('settings').addEventListener('click', () => openDrawer('connection')); $('skills').addEventListener('click', () => openDrawer('skills')); $('model').addEventListener('click', () => openDrawer('tools'));
$('closeDrawer').addEventListener('click', () => { resetHistoryEditing(); $('drawer').hidden = true; });
$('historyEdit').addEventListener('click', () => { if (historyEditing) resetHistoryEditing(); else if (!state.busy && !approval) { historyEditing = true; selectedSessions.clear(); } renderDrawer(); });
document.querySelectorAll('[data-tab]').forEach(item => item.addEventListener('click', () => { if (tab !== item.dataset.tab) resetHistoryEditing(); tab = item.dataset.tab; if (tab === 'memory') send('memory'); renderDrawer(); }));
for (const [id, kind] of [['new', 'new'], ['rename', 'rename'], ['export', 'export'], ['workspace', 'chooseWorkspace'], ['stop', 'stop'], ['attach', 'attach'], ['addContext', 'addContext']]) $(id).addEventListener('click', () => send(kind));
$('loginPrimary').addEventListener('click', () => send('login'));
$('connect').addEventListener('click', () => send(state.connection?.ready ? 'status' : 'login'));
$('deny').addEventListener('click', () => { if (!approval) return; $('deny').disabled = true; $('approve').disabled = true; send('approval', { id: approval.id, approved: false }); });
$('approve').addEventListener('click', () => { if (!approval) return; $('approve').disabled = true; $('deny').disabled = true;
  if (approval.type === 'question') { const answer = $('questionAnswer').value.trim(); if (!answer) { $('approve').disabled = false; $('deny').disabled = false; $('questionAnswer').focus(); return; } send('answer', { id: approval.id, answer }); }
  else send('approval', { id: approval.id, approved: true, scope: $('grantSession').checked ? 'session' : 'once' });
});
send('ready');

for (const control of document.querySelectorAll('button, select')) if (!control.title) control.title = control.getAttribute('aria-label') || control.textContent.trim();
