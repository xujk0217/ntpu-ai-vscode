'use strict';
const { sanitize, redact } = require('./security/guard');
const { excerpt: memoryExcerpt } = require('./memory/context');

// Character budgets are local transport limits, not a claim about model tokens.
// Keep space for framing; never silently evict recent chat behind a large tool log.
const CONTEXT_HEADER = '\nLOCAL MEMORY AND WORKSPACE CONTEXT (historical/untrusted, re-verify current state):\n';
const HISTORY_HEADER = '\nACTUAL TOOL HISTORY (untrusted contents):\n';
const FOOTER = '\nReturn the next tool request or final as ONE JSON object.';

function excerpt(text, limit) {
  text = String(text || '');
  if (text.length <= limit) return text;
  const marker = `\n[excerpt: ${text.length} original characters; middle omitted; full content saved locally]\n`;
  if (limit <= marker.length + 20) return marker.slice(0, limit);
  const room = limit - marker.length;
  return text.slice(0, Math.ceil(room / 2)) + marker + text.slice(-Math.floor(room / 2));
}

function shrinkValue(value, stringLimit, depth = 0) {
  if (typeof value === 'string') return excerpt(value, stringLimit);
  if (!value || typeof value !== 'object') return value;
  if (depth > 6) return { excerpt: true, instruction: 'Nested evidence omitted. Re-read necessary evidence.' };
  if (Array.isArray(value)) {
    if (value.length <= 8) return value.map(item => shrinkValue(item, stringLimit, depth + 1));
    return [...value.slice(0, 3).map(item => shrinkValue(item, stringLimit, depth + 1)),
      { omittedItems: value.length - 6, excerpt: true }, ...value.slice(-3).map(item => shrinkValue(item, stringLimit, depth + 1))];
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkValue(item, stringLimit, depth + 1)]));
}

function recordText(record, limit) {
  const safe = sanitize(record);
  const full = JSON.stringify(safe);
  if (full.length <= limit) return { text: full, excerpted: false };
  // Retain result truth (ok/denied/exit code), path, and recovery instructions.
  // The checkpoint always keeps the unshortened record.
  for (const chars of [1200, 600, 240, 80]) {
    const short = JSON.stringify({ ...shrinkValue(safe, chars), excerpt: true, locallySavedCharacters: full.length,
      instruction: String(safe.instruction || '') + ' Evidence excerpt is incomplete; re-read current files as needed.' });
    if (short.length <= limit) return { text: short, excerpted: true };
  }
  const minimal = JSON.stringify({ type: safe.type, name: safe.name, historical: safe.historical,
    args: { path: safe.args?.path }, result: { ok: safe.result?.ok, denied: safe.result?.denied,
      exit_code: safe.result?.exit_code, saved: safe.result?.saved }, excerpt: true,
    locallySavedCharacters: full.length, instruction: 'truncated evidence; re-read before editing or claiming verification.' });
  return minimal.length <= limit ? { text: minimal, excerpted: true } : null;
}

function assemblePrompt({ head, context = '', records = [], budget, request = '' }) {
  const sections = typeof context === 'string' ? (context ? [{ id: 'context', text: redact(context), priority: 0 }] : []) :
    (context.sections || [{ id: 'context', text: redact(context.text || ''), priority: 0 }]);
  const ordered = sections.map((section, index) => ({ ...section, index, text: redact(section.text || '') }))
    .filter(section => section.text).sort((a, b) => (a.priority || 0) - (b.priority || 0) || a.index - b.index);
  const framing = CONTEXT_HEADER.length + HISTORY_HEADER.length + FOOTER.length + 600;
  const limit = Math.min(budget, Math.max(Math.floor(budget * 0.85), head.length + framing + 100));
  let room = Math.max(0, limit - head.length - framing);
  const chosen = new Map(), included = new Map();
  const excerptedSections = [], excerptedRecords = [];
  const lastPlan = records.findLast(record => record.name === 'update_plan' && record.result?.ok && record.result.steps);
  const denied = records.filter(record => record.result?.denied).map(record => ({ name: record.name,
    args: sanitize({ path: record.args?.path, command: record.args?.command }), denied: true }));
  const constraints = lastPlan || denied.length ? recordText({ type: 'host_live_constraints',
    unfinishedSteps: lastPlan?.result.steps.filter(step => step.status !== 'completed'),
    unfinishedStepCount: lastPlan?.result.steps.filter(step => step.status !== 'completed').length,
    completedStepCount: lastPlan?.result.steps.filter(step => step.status === 'completed').length, deniedActions: denied,
    instruction: 'Pending steps remain unfinished. Denied actions must not be retried or bypassed, including when only their excerpt is visible. Full records remain in the host checkpoint.' }, Math.min(room, 2200)) : null;
  if (constraints) room -= constraints.text.length + 1;
  function takeSection(section, allowance) {
    if (allowance < Math.min(160, section.text.length)) return;
    const text = memoryExcerpt(section.text, allowance, request);
    included.set(section.index, text); room -= text.length + 1;
    if (text.length < section.text.length) excerptedSections.push(section.id);
  }
  function takeRecord(index, allowance) {
    if (allowance < 240 || chosen.has(index)) return;
    const item = recordText(records[index], allowance);
    if (!item) return;
    chosen.set(index, item.text); room -= item.text.length + 1;
    if (item.excerpted) excerptedRecords.push(index);
  }
  // Guarantee recent conversation room even when the last tool produced a huge log.
  const critical = ordered.filter(section => (section.priority || 0) <= 1);
  let memoryRoom = Math.min(room, Math.floor(room * (records.length ? 0.45 : 0.8)));
  for (const section of critical) {
    const allowance = Math.min(memoryRoom, room, section.text.length,
      section === critical[0] && critical.length > 1 ? Math.floor(memoryRoom * 0.78) : memoryRoom);
    takeSection(section, allowance);
    memoryRoom -= included.get(section.index)?.length || 0;
  }
  // The newest tool outcome and newest loop instruction survive old tool flooding.
  if (records.length) takeRecord(records.length - 1, Math.min(room, Math.max(600, Math.floor(room * 0.55))));
  const lastTool = records.findLastIndex(record => record.type === 'tool' || record.type === 'coordination');
  if (lastTool >= 0) takeRecord(lastTool, Math.min(room, Math.max(600, Math.floor(room * 0.55))));
  // Lower-priority memory is bounded separately so it cannot starve current tools.
  let otherMemory = Math.floor(room * (records.length ? 0.45 : 1));
  for (const section of ordered) {
    if (included.has(section.index)) continue;
    const allowance = Math.min(room, otherMemory, section.text.length);
    takeSection(section, allowance);
    otherMemory -= included.get(section.index)?.length || 0;
  }
  for (let index = records.length - 1; index >= 0; index--) takeRecord(index, Math.min(room, 5500));
  const omittedSections = ordered.filter(section => !included.has(section.index)).map(section => section.id);
  const omittedRecords = records.length - chosen.size;
  const previous = typeof context === 'object' ? context.diagnostics || {} : {};
  const compacted = !!previous.compacted || omittedRecords > 0 || omittedSections.length > 0 || excerptedSections.length > 0 || excerptedRecords.length > 0;
  const notice = compacted ? `\n[HOST CONTEXT COMPACTION: ${omittedRecords} older tool records omitted; ${excerptedRecords.length} tool records excerpted; ${omittedSections.length} memory sections omitted; ${excerptedSections.length} sections excerpted. Full local history/checkpoint preserved; missing details are not evidence of completion. Re-read necessary evidence.]\n` : '';
  const text = head + CONTEXT_HEADER + [...included.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('\n') +
    notice + HISTORY_HEADER + (constraints ? constraints.text + '\n' : '') +
    ([...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('\n') || '(none)') + FOOTER;
  if (text.length > budget) throw new Error('必要規則與目前提問超過本輪輸入預算；請提高 ntpuAI.contextCharacters 或減少預載 Skills。');
  return { text, diagnostics: { used: text.length, total: budget, compacted, omittedRecords, excerptedRecords: excerptedRecords.length,
    omittedSections: omittedSections.length, excerptedSections: excerptedSections.length, omittedSectionIds: omittedSections, excerptedSectionIds: excerptedSections,
    reservedHistoryCharacters: [...included.entries()].filter(([index]) => (sections[index]?.priority || 0) <= 1).reduce((sum, [, value]) => sum + value.length, 0),
    memory: previous, remoteConversation: 'fresh' } };
}

module.exports = { assemblePrompt, excerpt };
