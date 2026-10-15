'use strict';

// Reserve actual model requests for integration and verification in the parent.
const PARENT_RESERVE = 3;
const MIN_CHILD_ROUNDS = 2;
const ROLES = new Set(['explore', 'research', 'review']);

function remainingRounds(modelBudget) {
  return modelBudget ? Math.max(0, Number(modelBudget.limit) - Number(modelBudget.used)) : 0;
}

function requestKey(request) {
  // Titles and role labels cannot turn the same failed work into a new task.
  return String(request || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function requestShape(request = '') {
  const text = String(request).trim();
  const optedOut = /(?:不要|不需|無需|禁止|停用).{0,12}(?:子\s*agent|subagents?|子代理|子任務)|(?:do not|don't|without|disable)\s+(?:use\s+)?(?:subagents?|delegat)/i.test(text);
  const smallEdit = /(?:錯字|拼字|typo|(?:單一|一個|一行).{0,8}(?:常數|constant|變數|條件|字串)|(?:只|僅|just|only).{0,15}(?:常數|constant))/i.test(text) && !/(?:以及|並|同時|然後|另外|還有|\band\b|\balso\b)/i.test(text);
  const simple = /^(?:你好|嗨|謝謝|hello\b|hi\b|thanks?\b)/i.test(text) && text.length < 80 ||
    /^(?:請)?(?:翻譯|translate\b|列出根目錄|解釋一下|什麼是|what is\b)/i.test(text) && text.length < 100;
  const action = /(?:新增|實作|修復|修正|修改|改善|優化|調查|排查|重構|設計|建立|建置|檢查|測試|研究|審查|分析|整合|串接|比較|review|implement|investigat|refactor|research|debug|fix|migrat|architect|build|optimi[sz]|diagnos|analy[sz]|audit|test)/i.test(text);
  const compound = /\n\s*(?:[-*•]|\d+[.)、])|(?:以及|並|同時|然後|接著|除此之外|另外|而且|一起|還有|also\b|and\b|then\b)/i.test(text);
  const scoped = /(?:專案|功能|系統|登入|架構|模組|全面|完整|整個|跨(?:平台|模組|檔案)|記憶|脈絡|上下文|串流|附件|取消|權限|核准|資料庫|效能|安全|部署|崩潰|失敗|錯誤|問題|測試|codebase|repository|project|feature|architecture|authentication|sign.?in|login|context|memory|stream|database|performance|security|deploy|crash|error|tests?\b|[\w/-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|cpp|c|rb|php))/i.test(text);
  const explicit = /(?:積極|分工|委派|獨立|使用|啟用|use|delegat).{0,20}(?:subagents?|子\s*agent|子代理|子任務)|(?:subagents?|子\s*agent|子代理).{0,20}(?:分工|運作|執行|做|work)/i.test(text);
  return { text, optedOut, simple: smallEdit || simple && !action, complex: !smallEdit && (explicit || action && (scoped || compound || text.length >= 25) || compound && text.length >= 80),
    research: /(?:研究|比較|調研|research|compar)/i.test(text) };
}

function explorationEvidence(records = []) {
  return [...new Set(records.filter(record => record?.type === 'tool' &&
    ['list_files', 'read_file', 'search_text', 'web_search', 'web_fetch', 'ntpu_lookup'].includes(record.name) &&
    record.result?.ok === true && !record.result.denied).map(record => record.name + ':' + JSON.stringify(record.args || {})))];
}

function concreteSingleRationale(rationale, records = []) {
  // A model's unsupported claim that everything depends on its edit is not evidence.
  // Merely listing files or reading an unrelated file does not prove a narrow dependency.
  const referencedEvidence = records.some(record => record?.type === 'tool' && record.result?.ok === true && !record.result.denied &&
    ['read_file', 'search_text', 'web_fetch'].includes(record.name) &&
    [record.args?.path, record.args?.url].filter(value => typeof value === 'string' && value.length > 2)
      .some(value => rationale.includes(value) || value.includes('/') && rationale.includes(value.split(/[\\/]/).at(-1))));
  return referencedEvidence &&
    /(?:[\w./-]+\.[a-z]{1,8}(?::\d+)?|\d+\s*行|一行|小型函式|同一個(?:函式|條件|檔案)|single (?:function|file)|one line)/i.test(rationale) &&
    /(?:依賴|相依|必須先|只需|只有|同一|depend|single|only|one line)/i.test(rationale);
}

function delegationState({ request = '', profile = {}, maxSteps = 12, modelBudget, maxWorkers = 4, occupiedSlots = 0,
  closed = false, aborted = false, blocked = false, pending = false, assessed = false, tasksRemaining = 8 } = {}) {
  const remaining = remainingRounds(modelBudget);
  const capacity = Math.max(0, Math.min(maxWorkers - occupiedSlots, tasksRemaining,
    Math.floor((remaining - PARENT_RESERVE) / MIN_CHILD_ROUNDS)));
  let reason;
  if (closed || aborted) reason = '任務已停止';
  else if (blocked) reason = '服務限制已暫停新的模型請求';
  else if (assessed || pending) reason = '已有分工評估或子任務';
  else if (!capacity || maxSteps <= PARENT_RESERVE) reason = '輪數或子任務名額不足，保留主 Agent 整合與驗證';
  else {
    const shape = requestShape(request);
    const activeMode = ['build', 'plan', 'review', 'research'].includes(profile.agent || 'build');
    if (shape.optedOut) reason = '使用者要求不使用子 Agent';
    else if (shape.simple || !shape.complex || !activeMode) reason = '簡單或單一步驟工作，由主 Agent 直接處理';
    else return { required: true, reason: '可獨立工作的任務優先實際分工', maxTasks: capacity, parentReserve: PARENT_RESERVE,
      instruction: `下一個回覆先使用 kind:delegation。找出 1–${capacity} 個可同時進行的唯讀 explore/research/review 工作，列出各自的 title、role、request、expectedOutput 與 independent:true。把確實不相依的既有程式探索、既有測試範圍調查、文件研究、審查交給子 Agent；主 Agent 繼續獨立實作。只要既有測試／風險盤點可獨立進行，就實際分派，不可因修改與執行測試相依而把全部工作留給自己。若確實沒有可獨立工作，rationale 須引用已讀取的檔案或具體證據，說明相依性或狹小範圍；泛用「單 Agent 比較快」不足以跳過。不可分派寫檔、shell 或依賴尚未完成修改的測試；不得藉此繞過取消、核准、校方節奏或限制。` };
  }
  return { required: false, reason, maxTasks: capacity, parentReserve: PARENT_RESERVE };
}

function validateAssessment(value, maxTasks) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分工評估格式不正確。');
  const tasks = value.tasks;
  if (Array.isArray(tasks) && tasks.length) {
    if (typeof value.rationale === 'string' && value.rationale.trim()) throw new Error('請選擇分派工作或單一 Agent 理由。');
    if (tasks.length > maxTasks || tasks.some(task => !task || !ROLES.has(task.role) || task.independent !== true ||
      typeof task.title !== 'string' || !task.title.trim() || task.title.length > 120 ||
      typeof task.request !== 'string' || !task.request.trim() || task.request.length > 6000 ||
      typeof task.expectedOutput !== 'string' || task.expectedOutput.trim().length < 8 || task.expectedOutput.length > 1200)) {
      throw new Error(`分工須有 1–${maxTasks} 個有效且獨立的唯讀工作，並提供明確 expectedOutput。`);
    }
    const keys = tasks.map(task => requestKey(task.request));
    if (new Set(keys).size !== keys.length) throw new Error('獨立工作不可重複相同內容。');
    return { tasks };
  }
  if (tasks !== undefined && (!Array.isArray(tasks) || tasks.length)) throw new Error('分工 tasks 格式不正確。');
  if (typeof value.rationale !== 'string' || value.rationale.trim().length < 20 || value.rationale.length > 2000) {
    throw new Error('單一 Agent 須提供具體理由（20–2000 字），說明為何沒有可獨立工作。');
  }
  return { tasks: [], rationale: value.rationale.trim() };
}

module.exports = { PARENT_RESERVE, MIN_CHILD_ROUNDS, remainingRounds, requestKey, requestShape, explorationEvidence, concreteSingleRationale, delegationState, validateAssessment };
