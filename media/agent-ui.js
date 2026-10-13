/* global acquireVsCodeApi */
'use strict';
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
let memory = { project: { entries: [] }, tasks: [] }, sessionQuery = '', includeArchived = false;
const nodes = new Map();
const names = { list_files: '探索專案', read_file: '讀取檔案', search_text: '搜尋程式碼', write_file: '修改檔案', edit_file: '編輯區段', run_command: '執行指令', web_search: '搜尋網路', web_fetch: '讀取網頁', inspect_image: '分析圖片', create_visual: '繪製圖片', load_skill: '載入 skill', update_plan: '更新計畫', ask_user: '詢問偏好' };
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
function button(text, className, handler, iconName) { const item = element('button', className); item.type = 'button'; if (iconName) item.append(icon(iconName)); if (text) item.append(element('span', '', text)); item.addEventListener('click', handler); return item; }
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
  ]) grid.append(button(name, 'suggestion', () => { send('option', { key: 'agent', value: agent }); $('prompt').value = prompt; $('prompt').focus(); }, image));
  welcome.append(grid); return welcome;
}

function renderMessage(message) {
  const wrapper = element('article', 'message ' + message.role); wrapper.dataset.id = message.id;
  if (message.role === 'tool') {
    const details = element('details', 'tool-card ' + message.status);
    const summary = element('summary', 'tool-summary');
    summary.append(icon(icons[message.name] || 'file'));
    let label = names[message.name] || capabilities.tools.find(tool => tool.name === message.name)?.description?.slice(0, 50) || message.name;
    if (message.status === 'done') label = { read_file: '已讀取', list_files: '已探索專案', search_text: '已搜尋程式碼',
      write_file: message.outcome?.changed === false ? '檔案無需變更' : message.outcome?.created ? '已建立' : '已修改', edit_file: '已修改',
      run_command: '已執行', web_search: '已搜尋網路', web_fetch: '已讀取網頁', create_visual: '已繪製', inspect_image: '已分析圖片',
      load_skill: '已載入 skill', update_plan: '已更新計畫' }[message.name] || label;
    const meta = element('div', 'tool-meta'); meta.append(element('strong', '', label));
    const args = message.args || {}, hint = args.path || args.command || args.query || args.url || args.name;
    if (hint) meta.append(element('span', 'tool-hint', String(hint).slice(0, 180)));
    summary.append(meta, element('span', 'tool-status ' + message.status, { running: '進行中', done: '完成', denied: '未允許', error: '未完成', interrupted: '已中斷' }[message.status] || message.status), element('span', 'tool-chevron', '›'));
    const content = element('div', 'tool-detail');
    if (args.path) content.append(button('開啟 ' + args.path, 'text-button', () => send('openFile', { path: args.path }), 'file'));
    if (args.command) content.append(element('pre', 'command', args.command));
    let result; try { result = JSON.parse(message.result || 'null'); } catch {}
    if (message.name === 'run_command') {
      content.append(element('div', 'execution-meta', '工作目錄：' + (args.cwd || '.') + (result?.approval ? ' · ' + result.approval : '')));
      if (message.liveOutput || result?.output) content.append(element('pre', 'tool-output terminal-output', result?.output || message.liveOutput));
      if (result) content.append(element('div', 'execution-meta', `退出碼：${result.exit_code ?? '—'}${result.timed_out ? ' · 逾時' : ''}${result.truncated ? ' · 輸出已截短' : ''}`));
      if (result?.error || result?.denied) content.append(element('pre', 'tool-output', result.error || result.message));
    } else if (message.result) content.append(element('pre', 'tool-output', message.result));
    else if (Object.keys(args).length) content.append(element('pre', 'tool-output', JSON.stringify(args, null, 2)));
    if (message.finishedAt) content.append(element('span', 'elapsed', '總耗時（含核准等待）：' + ((message.finishedAt - message.startedAt) / 1000).toFixed(1) + ' 秒'));
    details.append(summary, content); wrapper.append(details); return wrapper;
  }
  if (message.role === 'artifact') {
    wrapper.append(element('div', 'artifact-caption', message.text));
    if (message.imageUri) { const image = element('img', 'artifact-image'); image.src = message.imageUri; image.alt = message.text; wrapper.append(image); }
    const actions = element('div', 'artifact-actions'); actions.append(button('檢視圖片', 'text-button', () => send('openArtifact', { id: message.artifactId }), 'image'), button('另存圖片', 'text-button', () => send('saveArtifact', { id: message.artifactId }), 'export')); wrapper.append(actions);
    return wrapper;
  }
  if (['notice', 'error', 'commentary'].includes(message.role)) { wrapper.append(element('div', 'notice-text', message.text)); return wrapper; }
  const top = element('div', 'message-heading');
  if (message.role === 'user') top.append(element('span', '', message.canceled ? '你 · 已取消' : message.queued ? '你 · 已排入佇列' : '你'));
  else { const mark = element('span', 'assistant-mark', 'N'); top.append(mark, element('span', '', 'NTPU AI')); }
  top.append(iconButton('copy', '複製訊息', () => send('copy', { text: message.text || '' })));
  wrapper.append(top, message.role === 'user' ? element('div', 'user-body', message.text) : markdown(message.text));
  if (message.attachment) { const attached = element('div', 'message-attachment'); attached.append(icon('image'), element('span', '', message.attachment.name)); if (message.attachment.preview) { const image = element('img'); image.src = message.attachment.preview; image.alt = message.attachment.name; attached.append(image); } wrapper.append(attached); }
  return wrapper;
}
function nearBottom() { return $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 100; }
function addMessage(message, replace = false) {
  const follow = nearBottom(); const old = nodes.get(message.id); const open = old?.querySelector('details')?.open;
  const item = renderMessage(message);
  if (old && replace) { if (open && item.querySelector('details')) item.querySelector('details').open = true; old.replaceWith(item); }
  else { $('messages').querySelector('.welcome')?.remove(); $('messages').append(item); }
  nodes.set(message.id, item); if (follow) $('messages').scrollTop = $('messages').scrollHeight;
}
function renderSession(value) {
  session = value; nodes.clear(); $('messages').replaceChildren();
  $('rename').textContent = value.title;
  if (!value.messages.length) $('messages').append(empty()); else value.messages.forEach(message => addMessage(message));
  if (value.hasMore) $('messages').prepend(button('載入較早訊息（' + value.before + ' 則）', 'secondary-button history-more', () => send('historyPage', { before: value.before })));
  renderPlan(value.plan || []); renderChanges(value.changes || []); $('messages').scrollTop = $('messages').scrollHeight;
}
function renderPlan(steps) {
  $('plan').hidden = !steps.length; $('planSteps').replaceChildren();
  const done = steps.filter(step => step.status === 'completed').length; $('planCount').textContent = `${done}/${steps.length}`;
  for (const step of steps) { const row = element('div', 'plan-step ' + step.status); row.append(icon(step.status === 'completed' ? 'check' : step.status === 'in_progress' ? 'spark' : 'clock'), element('span', '', step.title)); $('planSteps').append(row); }
}
function renderChanges(changes) {
  $('changes').hidden = !changes.length; $('changeRows').replaceChildren();
  const active = changes.filter(change => !change.reverted);
  $('changesTitle').textContent = `檔案變更 · ${new Set(active.map(change => change.path)).size}`;
  $('changeStats').textContent = active.length && active.every(item => item.binary) ? active.length + ' 張圖片' : '+' + active.reduce((sum, item) => sum + (item.added || 0), 0) + ' −' + active.reduce((sum, item) => sum + (item.removed || 0), 0);
  for (const change of changes.slice(-12)) {
    const row = element('div', 'change-row' + (change.reverted ? ' reverted' : ''));
    row.append(icon(change.binary ? 'image' : 'file'), button(change.path, 'change-name', () => send('change', { id: change.id })),
      element('span', 'added', change.reverted ? '已回復' : change.binary ? 'PNG' : '+' + change.added), element('span', 'removed', change.reverted || change.binary ? '' : '−' + change.removed));
    const undo = iconButton('undo', '回復這次修改', () => send('revert', { id: change.id })); undo.disabled = state.busy || change.reverted; row.append(undo); $('changeRows').append(row);
  }
}

function renderState(value) {
  state = value;
  if (state.sessionTitle) $('rename').textContent = state.sessionTitle;
  for (const key of ['agent', 'depth', 'permission']) { $(key).value = state.options[key]; $(key).disabled = state.busy || !!approval; }
  $('workspace').querySelector('span').textContent = state.workspace;
  $('connect').classList.toggle('connected', !!state.connection?.ready); $('connect').title = state.connection?.message || '登入 NTPU AI';
  $('connectionLabel').textContent = state.connection?.ready ? '已連線' : '連線 NTPU AI';
  $('connectionActions').hidden = !!state.connection?.ready;
  $('model').textContent = modelNames[state.model] || 'NTPU AI · 自動';
  $('progress').hidden = !state.busy; $('progressText').textContent = state.progress;
  $('budgetLabel').textContent = state.budget?.total ? `脈絡 ${Math.min(100, Math.round(state.budget.used / state.budget.total * 100))}%` : '';
  $('stop').hidden = !state.busy; $('send').title = state.busy ? '排入佇列' : '送出'; $('send').setAttribute('aria-label', state.busy ? '排入佇列' : '送出');
  $('sendHint').textContent = state.busy ? '排入佇列' : '⌘ ↵';
  $('web').classList.toggle('on', state.options.web); $('web').setAttribute('aria-pressed', String(state.options.web)); $('web').disabled = state.busy;
  if (!$('drawer').hidden && tab === 'tools' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) renderDrawer();
  $('skillsCount').textContent = state.options.skills?.length ? state.options.skills.length : '';
  $('new').disabled = state.busy || !!approval;
  $('permission').title = { ask: '專案讀取與基本唯讀指令自動；修改、其他指令及外部工具先確認。', assisted: '工作區修改及公開搜尋自動；只有已辨識的唯讀指令自動執行。', full: '工具自動執行。終端機與 MCP 使用你的使用者權限；檔案工具維持工作區範圍。' }[state.options.permission];
  $('permissionDescription').textContent = { ask: '修改與外部操作先確認', assisted: '工作區自動 · 指令依風險確認', full: '自動執行 · 使用者權限' }[state.options.permission];
  document.body.classList.toggle('full-access', state.options.permission === 'full');
  const chips = $('contextChips'); chips.replaceChildren();
  if (includeEditor && state.editor) { const chip = element('span', 'context-chip'); chip.append(icon('file'), element('span', '', state.editor.name + (state.editor.selected ? ':' + state.editor.line + '–' + state.editor.endLine : '')), iconButton('close', '不帶入目前檔案', () => { includeEditor = false; renderState(state); })); chips.append(chip); }
  for (const file of state.contexts || []) { const chip = element('span', 'context-chip'); chip.append(icon('file'), element('span', '', file.name), iconButton('close', '移除脈絡檔案', () => send('removeContext', { path: file.path }))); chips.append(chip); }
  for (const name of state.options.skills || []) { const chip = element('span', 'context-chip skill-chip'); chip.append(icon('spark'), element('span', '', name)); chips.append(chip); }
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

function openDrawer(nextTab) { tab = nextTab; $('drawer').hidden = false; if (tab === 'memory') send('memory'); renderDrawer(); }
function renderDrawer() {
  $('drawerTitle').textContent = { sessions: '工作階段', skills: 'Skills', tools: '工具與設定', memory: '記憶與隱私' }[tab];
  document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item.dataset.tab === tab));
  const content = $('drawerContent'); content.replaceChildren();
  if (tab === 'sessions') {
    content.append(button('新工作階段', 'primary-button full-width', () => { send('new'); $('drawer').hidden = true; }, 'plus'));
    const search = element('input', 'history-search'); search.placeholder = '搜尋工作階段與任務'; search.value = sessionQuery;
    search.addEventListener('input', () => { sessionQuery = search.value; filterSessions(); }); content.append(search);
    const archived = element('label', 'privacy-option'); const show = element('input'); show.type = 'checkbox'; show.checked = includeArchived;
    show.addEventListener('change', () => { includeArchived = show.checked; filterSessions(); }); archived.append(show, element('span', '', '顯示封存工作階段')); content.append(archived);
    const list = element('div', 'session-list'); content.append(list);
    function filterSessions() {
      list.replaceChildren();
      for (const item of sessions.filter(item => (includeArchived || !item.archived) && ((item.title || '') + ' ' + (item.searchText || '')).toLowerCase().includes(sessionQuery.toLowerCase()))) {
        const card = element('div', 'session-item');
        const row = button('', 'session-row' + (item.id === session.id ? ' current' : ''), () => { if (!state.busy) { send('switch', { id: item.id }); $('drawer').hidden = true; } });
        row.append(element('strong', '', item.title), element('span', '', new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(item.updatedAt) + (item.pending ? ' · ' + item.pending + ' 個未完成任務' : '') + (item.archived ? ' · 已封存' : '')));
        row.disabled = state.busy;
        const actions = element('div', 'session-actions');
        actions.append(button(item.archived ? '取消封存' : '封存', 'text-button', () => send('archiveSession', { id: item.id })), button('刪除', 'text-button', () => send('deleteSession', { id: item.id })));
        card.append(row, actions); list.append(card);
      }
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
    for (const task of (memory.tasks || []).filter(task => task.status !== 'completed')) {
      const card = element('div', 'memory-card'); card.append(element('strong', '', task.request), element('p', 'memory-text', task.status + ' · ' + (task.result || '可從本機檢查點接續')),
        button('接續任務', 'secondary-button', () => { send('resumeTask', { id: task.id }); $('drawer').hidden = true; })); content.append(card);
    }
    content.append(element('p', 'panel-footnote', '儲存位置：' + (memory.storage || '載入中') + '\n最近更新：' + (memory.project?.updatedAt ? new Date(memory.project.updatedAt).toLocaleString('zh-TW') : '尚無') + '\n刪除本機記憶不等於刪除校方伺服器資料。'));
    for (const [text, kind] of [['重新整理記憶', 'refreshMemory'], ['匯出完整 Session', 'export'], ['備份全部本機記憶', 'backupMemory'], ['還原備份', 'restoreMemory'], ['清空此專案記憶', 'clearMemory']]) content.append(button(text, 'secondary-button full-width', () => send(kind)));
    if (memory.error) content.append(element('p', 'warning-text', memory.error));
  } else {
    const account = element('section', 'account-card');
    const accountHeader = element('div', 'account-heading');
    accountHeader.append(element('strong', '', 'NTPU AI 帳號'), element('span', 'badge' + (state.connection?.ready ? ' connected' : ''), state.connection?.ready ? '已登入' : '未登入'));
    account.append(accountHeader, element('p', 'panel-description', state.connection?.message || '登入後即可使用 NTPU AI 模型。'));
    account.append(button(state.connection?.ready ? '登出' : '登入 NTPU AI', state.connection?.ready ? 'secondary-button account-logout' : 'secondary-button', () => {
      send(state.connection?.ready ? 'logout' : 'login');
    }, state.connection?.ready ? 'close' : 'connect'));
    account.lastChild.disabled = state.busy;
    content.append(account);
    const browser = capabilities.browser || {};
    content.append(element('h3', '', '瀏覽器'));
    const browserChoice = element('select', 'history-search'); browserChoice.setAttribute('aria-label', 'Browser');
    for (const [value, label] of [['auto', 'Auto · 自動偵測'], ['chrome', 'Google Chrome'], ['edge', 'Microsoft Edge'], ['chromium', 'Chromium'], ['custom', 'Custom · 自訂 Chromium']]) { const option = element('option', '', label); option.value = value; browserChoice.append(option); }
    browserChoice.value = browser.selection || 'auto'; browserChoice.disabled = state.busy; content.append(browserChoice);
    const customPath = element('input', 'browser-path'); customPath.placeholder = 'Custom Browser Path'; customPath.setAttribute('aria-label', 'Custom Browser Path'); customPath.value = browser.customPath || ''; customPath.disabled = state.busy; content.append(customPath);
    const profileLocation = element('input', 'browser-path'); profileLocation.placeholder = 'Browser Profile Location · 預設使用私有儲存區'; profileLocation.setAttribute('aria-label', 'Browser Profile Location'); profileLocation.value = browser.profileLocation || ''; profileLocation.disabled = state.busy; content.append(profileLocation);
    const apply = button('更換瀏覽器並連線', 'secondary-button full-width', () => send('browserUpdate', { browser: browserChoice.value, customPath: customPath.value, profileLocation: profileLocation.value })); apply.disabled = state.busy; content.append(apply);
    const reconnect = button('重新連線', 'secondary-button full-width', () => send('reconnectBrowser')); reconnect.disabled = state.busy; content.append(reconnect);
    content.append(element('p', 'panel-description', (browser.info?.message || '尚未啟動可控制的瀏覽器') + '\nExtension Host：' + (browser.host || '') + (browser.remoteName ? ' · 工作區連線：' + browser.remoteName : '') + (browser.info?.profile ? '\n專用 Profile：' + browser.info.profile : '')));
    content.append(element('h3', '', '終端機核准規則'), element('p', 'panel-description', '基本唯讀指令可自動執行。可在使用者設定加入指令開頭或正規表示式；false 規則優先要求核准。'), button('設定指令自動核准', 'secondary-button full-width', () => send('terminalSettings'), 'terminal'));
    content.append(element('h3', '', '外部能力'));
    content.append(element('p', 'panel-description', '搜尋、網頁讀取與擴充工具由本地 agent 執行。NTPU AI 負責理解需求和決定下一步。'));
    for (const server of capabilities.servers) {
      const card = element('div', 'server-card'); const heading = element('div', 'server-heading');
      heading.append(icon('connect'), element('strong', '', server.name), element('span', 'badge' + (server.connected ? ' connected' : ''), server.connecting ? '連線中…' : server.connected ? server.tools + ' 個工具' : server.builtin ? '免金鑰 · 有限額' : '未連線'));
      card.append(heading, element('p', 'server-target', server.target));
      if (server.error) card.append(element('p', 'warning-text', server.error));
      const connect = button(server.connecting ? '連線中…' : server.connected ? '中斷連線' : '連線', 'secondary-button', event => { event.currentTarget.disabled = true; event.currentTarget.textContent = '處理中…'; send(server.connected ? 'disconnectMcp' : 'connectMcp', { name: server.name }); }, server.connected ? 'close' : 'connect');
      connect.disabled = state.busy || server.connecting; card.append(connect);
      content.append(card);
    }
    const actions = element('div', 'panel-actions'); actions.append(button('新增 MCP', 'secondary-button', () => send('addMcp'), 'plus'), button('匯入設定', 'secondary-button', () => send('importMcp'), 'file')); content.append(actions);
    if (capabilities.tools.length) { const list = element('details', 'tool-inventory'); list.append(element('summary', '', '已連線工具 · ' + capabilities.tools.length)); for (const tool of capabilities.tools) { const row = element('div'); row.append(element('strong', '', tool.server), element('p', '', tool.description)); list.append(row); } content.append(list); }
    content.append(element('h3', '', '圖像能力'), element('p', 'panel-description', capabilities.image));
    content.append(element('h3', '', '模型與分析深度'), element('p', 'panel-description', capabilities.thinking));
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
  else if (message.kind === 'capabilities') { capabilities = message; if (!$('drawer').hidden) renderDrawer(); }
  else if (message.kind === 'prefill') { $('prompt').value = message.text; includeEditor = true; $('prompt').focus(); renderState(state); }
});

$('composer').addEventListener('submit', event => { event.preventDefault(); const text = $('prompt').value.trim(); if (!text) return; send('ask', { text, includeEditor }); $('prompt').value = ''; $('prompt').style.height = ''; $('slashMenu').hidden = true; });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('composer').requestSubmit(); } if (event.key === 'Escape') $('slashMenu').hidden = true; });
$('prompt').addEventListener('input', () => {
  $('prompt').style.height = 'auto'; $('prompt').style.height = Math.min(200, $('prompt').scrollHeight) + 'px';
  const query = $('prompt').value; $('slashMenu').hidden = !/^\/[a-z-]*$/.test(query); $('slashMenu').replaceChildren();
  if (!$('slashMenu').hidden) for (const [command, description] of [['build', '實作與修正'], ['plan', '先探索，再規劃'], ['review', '唯讀程式碼審查'], ['research', '搜尋與來源整理'], ['ask', '說明與問答']]) if (command.startsWith(query.slice(1))) $('slashMenu').append(button('/' + command + ' · ' + description, 'slash-option', () => { $('prompt').value = '/' + command + ' '; $('slashMenu').hidden = true; $('prompt').focus(); }));
});
for (const key of ['agent', 'depth', 'permission']) $(key).addEventListener('change', event => send('option', { key, value: event.target.value }));
$('web').addEventListener('click', () => send('option', { key: 'web', value: !state.options.web }));
$('history').addEventListener('click', () => openDrawer('sessions')); $('settings').addEventListener('click', () => openDrawer('tools')); $('skills').addEventListener('click', () => openDrawer('skills')); $('model').addEventListener('click', () => openDrawer('tools'));
$('closeDrawer').addEventListener('click', () => { $('drawer').hidden = true; });
document.querySelectorAll('[data-tab]').forEach(item => item.addEventListener('click', () => { tab = item.dataset.tab; if (tab === 'memory') send('memory'); renderDrawer(); }));
for (const [id, kind] of [['new', 'new'], ['rename', 'rename'], ['export', 'export'], ['workspace', 'chooseWorkspace'], ['stop', 'stop'], ['attach', 'attach'], ['addContext', 'addContext']]) $(id).addEventListener('click', () => send(kind));
$('connect').addEventListener('click', () => send(state.connection?.ready ? 'status' : 'login'));
$('deny').addEventListener('click', () => { if (!approval) return; $('deny').disabled = true; $('approve').disabled = true; send('approval', { id: approval.id, approved: false }); });
$('approve').addEventListener('click', () => { if (!approval) return; $('approve').disabled = true; $('deny').disabled = true;
  if (approval.type === 'question') { const answer = $('questionAnswer').value.trim(); if (!answer) { $('approve').disabled = false; $('deny').disabled = false; $('questionAnswer').focus(); return; } send('answer', { id: approval.id, answer }); }
  else send('approval', { id: approval.id, approved: true, scope: $('grantSession').checked ? 'session' : 'once' });
});
send('ready');
