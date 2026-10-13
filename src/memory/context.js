'use strict';
const { sanitize, redact } = require('../security/guard');
const { randomUUID, createHash } = require('node:crypto');

function terms(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9_./-]{2,}|[\p{Script=Han}]{2,}/gu) || [];
  return [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word) ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]))];
}
class MemoryRetriever {
  retrieve(request, items, limit = 8) {
    const query = terms(request);
    return items.map(item => {
      const content = JSON.stringify(item).toLowerCase();
      const relevance = query.reduce((score, term) => score + (content.includes(term) ? 3 : 0), 0);
      const timestamp = item.endedAt || item.updatedAt || item.startedAt || item.source?.verifiedAt || item.source?.userEditedAt || 0;
      const recency = 1 / (1 + Math.max(0, Date.now() - timestamp) / (7 * 86400000));
      return { item, score: relevance + (item.status && item.status !== 'completed' && !item.resolvedBy ? 2 : 0) + recency };
    }).filter(match => match.score > 1).sort((a, b) => b.score - a.score).slice(0, limit).map(match => match.item);
  }
}
class ContextManager {
  constructor(retriever = new MemoryRetriever()) { this.retriever = retriever; }
  compose({ request, session, project, tasks = [], workspaceContext = '', budget = 12000 }) {
    const candidates = [
      ['PROJECT MEMORY (historical evidence; re-verify files, dependencies and tests)', JSON.stringify([...new Map([...(project?.entries || []).filter(entry => !entry.stale && ['summary', 'architecture', 'preference'].includes(entry.kind)), ...this.retriever.retrieve(request, (project?.entries || []).filter(entry => !entry.stale))].map(entry => [entry.id || entry.text, entry])).values()])],
      ['SESSION SUMMARY', session.summary || ''],
      ['RELEVANT PREVIOUS TASKS (do not assume checkpoint files unchanged)', JSON.stringify(this.retriever.retrieve(request, tasks))],
      ['RECENT CONVERSATION', JSON.stringify(session.messages.filter(message => ['user', 'assistant'].includes(message.role)).slice(-8).map(message => ({ role: message.role, text: message.text?.slice(0, 1600) })))],
      ['CURRENT WORKSPACE (verify against disk)', workspaceContext],
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
  session.summary = tasks.slice(-8).map(task => `${task.id}: ${task.request.slice(0, 200)}；${task.resolvedBy ? '已由 Task ' + task.resolvedBy + ' 接續完成（原狀態 ' + task.status + '）' : task.status}；${String(task.result || '').slice(0, 300)}`).join('\n');
  return session.summary;
}
async function updateMemory(store, session, task) {
  summarize(session);
  await store.updateProject(session.workspace, project => {
    const add = (kind, text, file, verifiedAt = task.endedAt) => {
      const source = { taskId: task.id, path: file, verifiedAt };
      const equivalent = project.entries.find(entry => entry.kind === kind && entry.text === text && entry.source?.path === file);
      const newerWrite = file && ['architecture', 'summary', 'observed'].includes(kind) && project.entries.some(entry => entry.kind === 'completed' && entry.source?.path === file && entry.source.verifiedAt > verifiedAt);
      if (equivalent) {
        if ((equivalent.source.verifiedAt || 0) <= verifiedAt && !newerWrite) { equivalent.source = source; equivalent.stale = false; }
        return;
      }
      if (file && ['architecture', 'summary'].includes(kind)) for (const entry of project.entries) {
        if (entry.kind === kind && entry.source?.path === file && entry.text !== text && (entry.source.verifiedAt || 0) <= verifiedAt) entry.stale = true;
      }
      project.entries.push(sanitize({ id: randomUUID(), kind, text, stale: !!newerWrite, source }));
    };
    project.taskRevisions ||= {};
    const revision = createHash('sha256').update(JSON.stringify(sanitize({ records: task.records, status: task.status, pending: task.pending }))).digest('hex');
    if (project.taskRevisions[task.id] !== revision) for (const record of task.records || []) {
      if (!record.result?.ok || record.historical) continue;
      const file = record.result.path || record.args?.path, verifiedAt = record.at || task.endedAt;
      if (['write_file', 'edit_file', 'create_visual'].includes(record.name) && (record.result.saved || record.name === 'create_visual')) {
        for (const entry of project.entries) if (entry.source?.path === file && (entry.source.verifiedAt || 0) <= verifiedAt &&
          !(entry.kind === 'completed' && entry.source.taskId === task.id && entry.source.verifiedAt === verifiedAt)) entry.stale = true;
        add('completed', '已儲存檔案：' + file, file, verifiedAt);
      } else if (record.name === 'run_command' && record.result.exit_code === 0) {
        add('verification', '指令已返回 exit code 0：' + record.args.command, undefined, verifiedAt);
      } else if (record.name === 'read_file' && file) {
        add('observed', '已讀取檔案：' + file, file, verifiedAt);
        if (file.endsWith('package.json') && record.result.start_line === 1 && !record.result.truncated && record.result.end_line >= record.result.total_lines) {
          try {
            const metadata = JSON.parse(record.result.text.replace(/^\d+: ?/gm, ''));
            if (typeof metadata.name === 'string') add('summary', 'package.json 宣告專案名稱：' + metadata.name, file, verifiedAt);
            const declared = { ...metadata.dependencies, ...metadata.devDependencies };
            const technologies = ['next', 'react', 'vue', 'svelte', '@angular/core', 'express', 'fastify', '@nestjs/core', 'typescript', 'tailwindcss', 'firebase'];
            const facts = technologies.filter(name => typeof declared[name] === 'string').map(name => name + '@' + declared[name]);
            if (facts.length) add('architecture', 'package.json 宣告依賴（使用前重新驗證）：' + facts.join('、'), file, verifiedAt);
          } catch {}
        }
      }
    }
    project.taskRevisions[task.id] = revision;
    for (const previous of session.tasks || []) if (previous.resolvedBy) {
      for (const entry of project.entries) if (entry.kind === 'pending' && entry.source?.taskId === previous.id) entry.stale = true;
    }
    if (task.status !== 'completed' && !task.resolvedBy) add('pending', '尚未完成（' + task.status + '）：' + task.request.slice(0, 600) +
      ((task.pending || []).length ? '\n待辦：' + task.pending.map(step => step.title).join('；') : ''), undefined);
  });
}

module.exports = { MemoryRetriever, ContextManager, summarize, updateMemory, terms };
