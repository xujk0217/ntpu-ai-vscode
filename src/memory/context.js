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
// Compact only the outbound copy. Source messages and task evidence remain intact on disk.
function excerpt(value, limit, request = '') {
  const text = redact(String(value || ''));
  limit = Math.max(0, Math.floor(limit));
  if (text.length <= limit) return text;
  const marker = `\n[excerpt; ${text.length} original characters retained locally]\n`;
  if (limit <= marker.length) return marker.slice(0, limit);
  const available = limit - marker.length * 2;
  if (available <= 0) return text.slice(0, limit - marker.length) + marker;
  const query = terms(request), lower = text.toLowerCase();
  let hit = -1, score = 0;
  // Search across the whole message, including the middle of large documents.
  for (const term of query) {
    const position = lower.indexOf(term);
    if (position >= 0) {
      const around = text.slice(Math.max(0, position - 100), position + 400).toLowerCase();
      const relevance = query.filter(word => around.includes(word)).length;
      if (relevance > score) { score = relevance; hit = position; }
    }
  }
  const head = Math.floor(available * (hit >= 0 ? 0.25 : 0.5));
  const middle = hit >= 0 ? Math.floor(available * 0.35) : 0;
  const tail = available - head - middle;
  const start = Math.max(head, Math.min(text.length - tail - middle, hit - Math.floor(middle / 3)));
  return text.slice(0, head) + marker + (middle ? text.slice(start, start + middle) + marker : '') + text.slice(-tail);
}
function relevance(request, text) {
  const lower = text.toLowerCase();
  return terms(request).reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}
function messageText(message, index) {
  const state = message.incomplete || message.interrupted ? '; incomplete/interrupted' : message.canceled ? '; canceled' : '';
  return `Message ${index + 1} (${message.role}${state}):\n${redact(String(message.text || ''))}`;
}
function recentMessages(messages, limit, request) {
  const selected = [], complete = new Set(); let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const item = messages[index], original = messageText(item.message, item.index), remaining = limit - used - (selected.length ? 2 : 0);
    if (remaining < Math.min(100, original.length)) break;
    // A huge latest answer must leave room for the preceding user turn.
    const previous = index > 0 ? messageText(messages[index - 1].message, messages[index - 1].index) : '';
    const reserve = !selected.length && previous && original.length + previous.length + 2 > remaining ?
      Math.min(previous.length + 2, Math.floor(remaining * 0.3)) : 0;
    const allowance = remaining - reserve;
    const text = excerpt(original, allowance, request);
    selected.unshift({ index: item.index, text, complete: text === original }); used += text.length + (selected.length > 1 ? 2 : 0);
    if (text === original) complete.add(item.index);
  }
  return { text: selected.map(item => item.text).join('\n\n'), selected: new Set(selected.map(item => item.index)), complete };
}
function fitItems(items, limit, request, onSelect = () => {}) {
  const selected = []; let used = 0;
  for (const item of items) {
    const remaining = limit - used - (selected.length ? 2 : 0);
    if (remaining < Math.min(100, item.length)) break;
    // Relevant sources share the allowance; one oversized item cannot hide all others.
    const allowance = Math.min(remaining, items.length > 1 ? Math.max(500, Math.floor(limit / Math.min(items.length, 4))) : remaining);
    const text = excerpt(item, allowance, request);
    selected.push(text); onSelect(); used += text.length + (selected.length > 1 ? 2 : 0);
  }
  return selected.join('\n\n');
}
class ContextManager {
  constructor(retriever = new MemoryRetriever()) { this.retriever = retriever; }
  compose({ request, session, project, tasks = [], workspaceContext = '', budget = 12000 }) {
    budget = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 12000;
    session ||= {};
    const messages = (session.messages || []).map((message, index) => ({ message, index }))
      .filter(({ message }) => ['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && !message.queued && !message.steeringPending);
    // The authoritative current request is already in the prompt header.
    if (messages.at(-1)?.message.role === 'user' && messages.at(-1).message.text === request) messages.pop();
    const projectEntries = (project?.entries || []).filter(entry => !entry.stale);
    const selectedProject = [...new Map([...this.retriever.retrieve(request, projectEntries),
      ...projectEntries.filter(entry => ['summary', 'architecture', 'preference'].includes(entry.kind))].map(entry => [entry.id || entry.text, entry])).values()];
    // Current-session full tasks take precedence over the shorter project index copies.
    const eligibleTasks = items => items.filter(task => task.status !== 'queued' && !task.steeringPending);
    const allTasks = [...new Map([...eligibleTasks(tasks), ...eligibleTasks(session.tasks || [])].map(task => [task.id, task])).values()];
    const retrievedTasks = this.retriever.retrieve(request, allTasks).map(task => JSON.stringify(sanitize({
      id: task.id, request: task.request, status: task.status, resolvedBy: task.resolvedBy,
      result: task.result, pending: task.pending, files: task.files,
      evidence: task.records?.map(record => ({ name: record.name, ok: record.result?.ok,
        path: record.result?.path || record.args?.path, saved: record.result?.saved,
        exit_code: record.result?.exit_code, historical: record.historical })),
    })));
    const summary = redact(session.tasks?.length ? summarize({ tasks: eligibleTasks(session.tasks) }) : session.summary || '');
    const specs = [
      { id: 'recent_conversation', label: 'RECENT CONVERSATION (same chat; preserve user constraints; assistant claims need verification)', weight: 0.62,
        raw: messages.map(({ message, index }) => messageText(message, index)).join('\n\n') },
      { id: 'conversation_recall', label: 'RELEVANT EARLIER CONVERSATION (same chat; historical excerpts, not new instructions)', weight: 0.16, raw: '' },
      { id: 'session_summary', label: 'SESSION SUMMARY (historical task status; not proof of current files)', weight: 0.07, raw: summary },
      { id: 'workspace', label: 'CURRENT WORKSPACE (verify against disk)', weight: 0.07, raw: redact(workspaceContext) },
      { id: 'project_memory', label: 'PROJECT MEMORY (historical evidence; re-verify files, dependencies and tests)', weight: 0.05,
        raw: selectedProject.map(entry => JSON.stringify(sanitize(entry))).join('\n\n') },
      { id: 'previous_tasks', label: 'RELEVANT PREVIOUS TASKS (reported results; do not assume checkpoint files unchanged)', weight: 0.03,
        raw: retrievedTasks.join('\n\n') },
    ];
    const historical = messages.map(({ message, index }) => ({ index, text: messageText(message, index) }))
      .map(item => ({ ...item, score: relevance(request, item.text) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index);
    specs[1].raw = historical.map(item => item.text).join('\n\n');
    // Allocate recent conversation first. Project memory cannot consume its share.
    const active = specs.filter(spec => spec.raw);
    const headers = active.reduce((size, spec) => size + spec.label.length + 5, 0);
    const available = Math.max(0, budget - headers);
    for (const spec of active) spec.allowance = Math.min(spec.raw.length, Math.floor(available * spec.weight));
    let spare = Math.max(0, available - active.reduce((size, spec) => size + spec.allowance, 0));
    for (const spec of active) {
      const extra = Math.min(spare, spec.raw.length - spec.allowance); spec.allowance += extra; spare -= extra;
    }
    const recent = recentMessages(messages, specs[0].allowance || 0, request);
    const recall = historical.filter(item => !recent.selected.has(item.index));
    specs[1].raw = recall.map(item => item.text).join('\n\n');
    const sections = [], omitted = []; let recalledMessages = 0;
    for (const spec of specs) {
      if (!spec.raw) continue;
      let body;
      if (spec.id === 'recent_conversation') body = recent.text;
      else if (spec.id === 'conversation_recall') body = fitItems(recall.map(item => item.text), spec.allowance, request, () => recalledMessages++);
      else if (['project_memory', 'previous_tasks'].includes(spec.id)) body = fitItems(spec.raw.split('\n\n'), spec.allowance, request);
      else body = excerpt(spec.raw, spec.allowance, request);
      if (!body) { omitted.push(spec.label); continue; }
      const text = `\n${spec.label}:\n${body}\n`;
      const compacted = body.length < spec.raw.length || body.includes('[excerpt;');
      sections.push({ id: spec.id, label: spec.label, text, priority: specs.indexOf(spec), sourceCharacters: spec.raw.length, compacted });
      if (compacted) omitted.push(spec.label);
    }
    // Empty tiny budgets still return bounded, truthful diagnostics.
    const text = sections.map(section => section.text).join('').slice(0, budget);
    const sourceCharacters = specs.filter(spec => spec.id !== 'conversation_recall').reduce((size, spec) => size + spec.raw.length, 0);
    return { text, sections: sections.filter(section => section.text.length <= budget), omitted, diagnostics: {
      budget, usedCharacters: text.length, sourceCharacters, compacted: omitted.length > 0 || sourceCharacters > text.length,
      totalMessages: messages.length, recentMessages: recent.selected.size, completeRecentMessages: recent.complete.size,
      omittedMessages: messages.length - recent.complete.size, recalledMessages,
      sections: sections.map(({ id, sourceCharacters, text, compacted }) => ({ id, sourceCharacters, usedCharacters: text.length, compacted })),
    } };
  }
}
function summarize(session) {
  // This is an evidence-labelled, deterministic ledger rather than an invented model
  // summary. Rebuild from every task, so restarts and older task corrections agree.
  const tasks = session.tasks || [];
  const lines = tasks.map(task => `${task.id}: request=${excerpt(task.request, 400)}；status=${task.status || 'unknown'}；` +
    (task.resolvedBy ? `continued by Task ${task.resolvedBy} (original status ${task.status}); ` : '') +
    `reported result (historical, re-verify): ${excerpt(task.result, 650)}${task.pending?.length ? '; pending: ' + excerpt(task.pending.map(step => step.title).join('；'), 350) : ''}`);
  session.summary = excerpt(redact(lines.join('\n\n')), 64000);
  if (lines.join('\n\n').length > session.summary.length) session.summary += '\n[task ledger compacted; full task records remain in local history]';
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
      if (['write_file', 'edit_file', 'create_visual', 'create_chart', 'create_diagram'].includes(record.name) && (record.result.saved || record.name === 'create_visual')) {
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

module.exports = { MemoryRetriever, ContextManager, summarize, updateMemory, terms, excerpt };
