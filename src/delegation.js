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
    const text = request.trim();
    const simple = text.length < 80 && /^(?:你好|嗨|謝謝|hello|hi\b|thanks?\b|what is\b|什麼是|解釋一下|翻譯|translate\b)/i.test(text) && !/[\n；;]/.test(text);
    const compound = /\n\s*(?:[-*•]|\d+[.)、])|(?:以及|並|同時|然後|接著|除此之外|另外|而且|also\b|and\b|then\b)/i.test(text);
    const substantive = text.length >= 45 && /(?:實作|修復|調查|重構|設計|研究|審查|review|implement|investigat|refactor|research|debug|migrat|architect)/i.test(text);
    const smallEdit = /(?:錯字|拼字|typo|(?:單一|一個|一行).{0,8}(?:常數|constant|變數|條件|字串)|(?:只|僅|just|only).{0,15}(?:常數|constant))/i.test(text);
    const scopedComplex = !smallEdit && /(?:新增|實作|修復|修正|調查|重構|設計|建立|檢查|研究|審查|整合|串接|review|implement|investigat|refactor|research|debug|fix|migrat|architect)/i.test(text) &&
      /(?:專案|功能|系統|登入|架構|模組|全面|完整|整個|跨(?:平台|模組|檔案)|codebase|repository|project|feature|architecture|authentication|sign.?in|login)/i.test(text);
    const activeMode = ['build', 'plan', 'review', 'research'].includes(profile.agent || 'build');
    if ((simple && !scopedComplex) || (!compound && !substantive && !scopedComplex && text.length < 180) || !activeMode) reason = '簡單或單一步驟工作，由主 Agent 直接處理';
    else return { required: true, reason: '複雜工作先評估獨立分工', maxTasks: capacity, parentReserve: PARENT_RESERVE,
      instruction: `下一個回覆先使用 kind:delegation。找出 1–${capacity} 個可同時進行的唯讀 explore/research/review 工作，列出各自的 title、role、request、expectedOutput 與 independent:true。把確實不相依的探索、測試範圍調查、文件研究、審查交給子 Agent；主 Agent 繼續獨立實作。若沒有可獨立工作，改提供具體 rationale 說明相依性、工作太小或為何必須由同一 Agent 執行，不可只寫「不需要」。不可分派寫檔、shell 或依賴尚未完成修改的測試；不得藉此繞過取消、核准、校方節奏或限制。` };
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

module.exports = { PARENT_RESERVE, MIN_CHILD_ROUNDS, remainingRounds, requestKey, delegationState, validateAssessment };
