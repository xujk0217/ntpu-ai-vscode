'use strict';
const { sanitize, redact } = require('../security/guard');
const { randomUUID } = require('node:crypto');

function terms(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
}
class MemoryRetriever {
  retrieve(request, items, limit = 8) {
    const query = terms(request);
    return items.map((item, index) => {
      const content = JSON.stringify(item).toLowerCase();
      const relevance = query.reduce((score, term) => score + (content.includes(term) ? 3 : 0), 0);
      return { item, score: relevance + (item.status && item.status !== 'completed' ? 2 : 0) + 1 / (index + 1) };
    }).filter(match => match.score > 1).sort((a, b) => b.score - a.score).slice(0, limit).map(match => match.item);
  }
}
class ContextManager {
  constructor(retriever = new MemoryRetriever()) { this.retriever = retriever; }
  compose({ request, session, project, tasks = [], workspaceContext = '', budget = 12000 }) {
    const candidates = [
      ['CURRENT WORKSPACE (verify against disk)', workspaceContext],
      ['PROJECT MEMORY (historical evidence; re-verify files, dependencies and tests)', JSON.stringify(this.retriever.retrieve(request, (project?.entries || []).filter(entry => !entry.stale)))],
      ['SESSION SUMMARY', session.summary || ''],
      ['RELEVANT PREVIOUS TASKS (do not assume checkpoint files unchanged)', JSON.stringify(this.retriever.retrieve(request, tasks))],
      ['RECENT CONVERSATION', JSON.stringify(session.messages.filter(message => ['user', 'assistant'].includes(message.role)).slice(-8).map(message => ({ role: message.role, text: message.text?.slice(0, 1600) })))],
    ];
    let text = '', omitted = [];
    for (const [label, data] of candidates) {
      const piece = `\n${label}:\n${redact(data)}\n`;
      if (text.length + piece.length <= budget) text += piece;
      else if (budget - text.length > 400) { text += piece.slice(0, budget - text.length - 100) + '\n[context excerpt truncated]\n'; omitted.push(label); }
      else omitted.push(label);
    }
    return { text: text.slice(0, budget), omitted };
  }
}
function summarize(session) {
  const tasks = session.tasks || [];
  session.summary = tasks.slice(-8).map(task => `${task.id}: ${task.request.slice(0, 200)}；${task.status}；${String(task.result || '').slice(0, 300)}`).join('\n');
  return session.summary;
}
async function updateMemory(store, session, task) {
  summarize(session);
  await store.updateProject(session.workspace, project => {
    for (const record of task.records || []) {
      if (!record.result?.ok) continue;
      const file = record.result.path || record.args?.path;
      let kind, text;
      if (['write_file', 'edit_file'].includes(record.name) && record.result.saved) { kind = 'completed'; text = '已儲存檔案：' + file; }
      else if (record.name === 'run_command' && record.result.exit_code === 0) { kind = 'verification'; text = '指令已返回 exit code 0：' + record.args.command; }
      else if (record.name === 'read_file' && file) { kind = 'observed'; text = '已讀取檔案：' + file; }
      if (!kind) continue;
      if (project.entries.some(entry => entry.source?.taskId === task.id && entry.text === text)) continue;
      if (kind === 'completed') for (const entry of project.entries) if (entry.source?.path === file && entry.source.taskId !== task.id) entry.stale = true;
      project.entries.push(sanitize({ id: randomUUID(), kind, text, stale: false, source: { taskId: task.id, path: file, verifiedAt: task.endedAt } }));
    }
  });
}
module.exports = { MemoryRetriever, ContextManager, summarize, updateMemory, terms };
