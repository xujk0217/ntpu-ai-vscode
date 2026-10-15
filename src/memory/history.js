'use strict';
const { redact } = require('../security/guard');

const MESSAGE_ID = /^[a-zA-Z0-9_-]{1,100}$/;
function integer(value, fallback, minimum, maximum, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} 必須是 ${minimum}–${maximum} 的整數。`);
  return result;
}
function historyMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('目前聊天的本機歷史無法讀取。');
  return messages.map((message, index) => ({ message, index })).filter(({ message }) =>
    message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string' && !message.queued && !message.steeringPending &&
    typeof message.id === 'string' && MESSAGE_ID.test(message.id));
}
function describe({ message, index }, text, offset, limit) {
  const end = Math.min(text.length, offset + limit);
  return { messageId: message.id, role: message.role, index,
    incomplete: !!(message.incomplete || message.interrupted), canceled: !!message.canceled,
    text: text.slice(offset, end), offset, totalCharacters: text.length,
    nextOffset: end < text.length ? end : null, truncated: offset > 0 || end < text.length };
}

function searchHistory(messages, { query, limit } = {}) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 300) throw new Error('query 必須是 2–300 字的非空白搜尋文字。');
  const count = integer(limit, 5, 1, 8, 'limit');
  const needle = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const matches = [];
  // Search the full sanitized source, never the earlier prompt excerpt. Return only
  // local user/assistant messages; tool records and other chats are unavailable.
  for (const item of historyMessages(messages)) {
    const text = redact(item.message.text), match = needle.exec(text);
    if (!match) continue;
    const hit = match.index;
    matches.push({ item, text, hit });
  }
  return { ok: true, matches: matches.slice(-count).reverse().map(({ item, text, hit }) =>
    describe(item, text, Math.max(0, hit - 200), 1000)), totalMatches: matches.length, limit: count,
    coordinates: 'Offsets refer to sanitized message text; use read_history with the returned messageId.' };
}

function readHistory(messages, { messageId, offset, limit } = {}) {
  if (typeof messageId !== 'string' || !MESSAGE_ID.test(messageId)) throw new Error('messageId 必須是目前聊天搜尋結果中的有效訊息 ID。');
  const start = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const count = integer(limit, 4000, 1, 10000, 'limit');
  const item = historyMessages(messages).find(item => item.message.id === messageId);
  if (!item) throw new Error('目前聊天找不到這則使用者或助理訊息；無法讀取其他聊天或內部工具紀錄。');
  // Redact the entire source before slicing so a secret crossing a chunk boundary
  // cannot be disclosed piecemeal. The original local message remains untouched.
  const text = redact(item.message.text);
  if (start > text.length) throw new Error(`offset 超過這則已遮蔽訊息的長度 ${text.length}。`);
  return { ok: true, ...describe(item, text, start, count), coordinates: 'Offsets refer to sanitized message text.' };
}

module.exports = { searchHistory, readHistory };
