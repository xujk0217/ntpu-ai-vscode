'use strict';

// Rules describe approval, not OS isolation. Complex shell expressions always
// require approval outside Full Access, even when an allow prefix matches.
function simpleCommand(command) {
  return typeof command === 'string' && command.length <= 2000 && !!command.trim() &&
    !/[;&|><`\n\r$()\\\u0000]/.test(command) &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(command.trim());
}
function safeCommand(command) {
  if (!simpleCommand(command)) return false;
  return /^(?:pwd|whoami|ls(?: -(?:[alh1]+))?|(?:node|npm|python3|git) --version|git status(?: --short| --porcelain| -sb)?|git --no-pager diff --no-ext-diff(?: --stat| --name-only)?)$/.test(command.trim());
}
function matches(pattern, command) {
  if (typeof pattern !== 'string' || pattern.length > 240) return false;
  if (pattern.startsWith('/')) {
    const match = pattern.match(/^\/(.+)\/([i]?)$/);
    // Require an anchored, bounded pattern; avoid common catastrophic repetition.
    if (!match || !match[1].startsWith('^') || /\([^)]*[+*][^)]*\)[+*{]|\\[1-9]|\(\?[=!<]/.test(match[1])) return false;
    try { return new RegExp(match[1], match[2]).test(command); } catch { return false; }
  }
  const prefix = pattern.trim();
  return !!prefix && (command === prefix || (command.startsWith(prefix) && /[\s;&|<>]/.test(command[prefix.length] || '')));
}
function commandApproval(command, { enabled = true, rules = {} } = {}) {
  if (!enabled) return { decision: 'ask', explicit: true, reason: '終端機自動核准已停用' };
  const text = typeof command === 'string' ? command.trim() : '';
  const entries = Object.entries(rules && typeof rules === 'object' && !Array.isArray(rules) ? rules : {}).slice(0, 100);
  // Explicit false rules override allow rules, Full Access and session grants.
  for (const [pattern, value] of entries) if (value === false && [text, ...text.split(/[;&|]+/).map(item => item.trim())].some(part => matches(pattern, part)))
    return { decision: 'ask', explicit: true, reason: '使用者規則要求核准', rule: pattern };
  if (!simpleCommand(text)) return { decision: 'ask', reason: '複合指令、重新導向或 shell 展開需要核准' };
  for (const [pattern, value] of entries) if (value === true && matches(pattern, text))
    return { decision: 'allow', reason: '符合使用者自動核准規則', rule: pattern };
  if (safeCommand(text)) return { decision: 'allow', reason: '內建基本唯讀指令' };
  return { decision: 'ask', reason: '未符合自動核准規則' };
}
module.exports = { simpleCommand, safeCommand, matches, commandApproval };
