'use strict';
const { randomUUID } = require('node:crypto');
const { sanitize } = require('./security/guard');

const DEFAULT_OPTIONS = { agent: 'build', permission: 'ask', depth: 'standard', web: true, skills: [] };
class SessionStore {
  constructor(saved = []) {
    this.sessions = Array.isArray(saved) ? sanitize(saved.filter(item => item?.id && Array.isArray(item.messages))) : [];
    for (const session of this.sessions) {
      session.options = { ...DEFAULT_OPTIONS, ...session.options, permission: 'ask' };
      session.messages = session.messages.map(item => item?.role === 'stream' ? { ...item, role: 'notice', interrupted: true } : item);
      for (const message of session.messages) if (message.role === 'user' && message.queued) { message.queued = false; message.canceled = true; }
      for (const message of session.messages) if (message.role === 'tool' && ['running', 'approval'].includes(message.status)) {
        message.status = 'interrupted'; message.result = '擴充功能重新載入，操作已中斷。';
      }
    }
  }
  create(workspace = '', options = {}) {
    const session = { id: randomUUID(), title: '新工作階段', workspace, createdAt: Date.now(), updatedAt: Date.now(),
      options: { ...DEFAULT_OPTIONS, ...options, permission: 'ask' }, messages: [], turns: [], changes: [], plan: [] };
    this.sessions.unshift(session); return session;
  }
  get(id) { return this.sessions.find(item => item.id === id); }
  add(session, message) { const item = sanitize({ id: randomUUID(), at: Date.now(), ...message }); session.messages.push(item); session.updatedAt = Date.now(); return item; }
  update(session, id, patch) { const item = session.messages.find(message => message.id === id); if (item) Object.assign(item, sanitize(patch)); return item; }
  serialize() {
    return sanitize(this.sessions.map(session => ({ ...session, messages: session.messages.map(item => item.role === 'stream' ? { ...item, role: 'notice', interrupted: true } : item),
      turns: session.turns || [], changes: session.changes || [] }))); 
  }
}
module.exports = { SessionStore, DEFAULT_OPTIONS };
