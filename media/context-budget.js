'use strict';

const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

function contextBudgetPresentation(budget) {
  if (!Number.isFinite(budget?.total) || budget.total <= 0 || !Number.isFinite(budget?.used) || budget.used < 0)
    return { text: '', title: '' };
  // Rounding 99.5% up to 100% incorrectly suggests that the input has reached its limit.
  const percent = Math.floor(budget.used / budget.total * 100);
  const text = `本輪輸入 ${percent}%${budget.used > budget.total ? ' · 超出預算' : ''}${budget.compacted ? ' · 已整理' : ''}`;
  const details = [
    `本次送入模型的文字：${count(budget.used)}／${count(budget.total)} 字元。`,
    '這是擴充套件的本機輸入字元預算，不是 Token 數，也不是校方模型上下文使用率。',
  ];
  if (budget.used >= budget.total) details.push(budget.used > budget.total ? '輸入超出本機字元預算，請查看任務訊息。' : '本輪輸入已達本機字元預算上限。');
  if (budget.compacted) details.push('已依預算重新整理本輪輸入；本機完整聊天、任務與工具紀錄仍保留。');
  if (count(budget.excerptedRecords)) details.push(`${count(budget.excerptedRecords)} 筆工具歷史以節錄帶入。`);
  if (count(budget.omittedRecords)) details.push(`${count(budget.omittedRecords)} 筆工具歷史未帶入本輪。`);
  if (budget.memory?.compacted) details.push('聊天記憶也已依預算選取；需要原文時可用歷史回讀工具。');
  if (count(budget.excerptedSections)) details.push(`${count(budget.excerptedSections)} 個其他輸入區段以節錄帶入。`);
  if (count(budget.omittedSections)) details.push(`${count(budget.omittedSections)} 個其他輸入區段未帶入本輪。`);
  if (budget.remoteConversation === 'fresh') details.push('每次模型請求使用新的校方對話，由本機重新帶入所選歷史。');
  return { text, title: details.join('\n') };
}

module.exports = { contextBudgetPresentation };
