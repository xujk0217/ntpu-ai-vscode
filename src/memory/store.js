'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { SessionStore, isEmptySession } = require('../sessions');
const { sanitize } = require('../security/guard');
const SCHEMA = 1;
const projectId = workspace => createHash('sha256').update(workspace || 'no-workspace').digest('hex');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(sanitize(value))); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
}

class MemoryStore {
  constructor(directory) {
    this.directory = directory; this.sessions = []; this.loaded = new Map(); this.tail = Promise.resolve(); this.errors = [];
  }
  file(id) { if (!validId(id)) throw new Error('無效的 Session ID。'); return path.join(this.directory, 'sessions', id + '.json'); }
  async read(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('記憶資料無法讀取，原始檔案已保留：' + path.basename(file)); }
  }
  exclusive(action) {
    const job = this.tail.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = path.join(this.directory, '.write-lock');
      const started = Date.now();
      while (true) {
        try { await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'owner'), String(process.pid)); break; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = await fs.stat(lock).catch(() => null);
          if (stat && Date.now() - stat.mtimeMs > 30000) {
            const pid = Number(await fs.readFile(path.join(lock, 'owner'), 'utf8').catch(() => '0'));
            let alive = true; try { if (!pid) alive = false; else process.kill(pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
            if (!alive) { await fs.rm(lock, { recursive: true, force: true }); continue; }
          }
          if (Date.now() - started > 8000) throw new Error('另一個 VS Code 視窗正在寫入記憶，請稍後再試。');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
      try { return await action(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
    });
    this.tail = job; return job;
  }
  async initialize(legacy = [], migrationKey = 'workspace') {
    await this.exclusive(async () => {
      this.index = await this.read(path.join(this.directory, 'index.json'), { schema: SCHEMA, sessions: [], migrations: [] });
      if (this.index.schema !== SCHEMA) throw new Error('不支援的記憶 Schema，請使用相容版本；沒有修改既有資料。');
      // Recover newly committed session files if a crash occurred before index update.
      for (const name of await fs.readdir(path.join(this.directory, 'sessions')).catch(() => [])) {
        if (this.index.deleted?.includes(name.slice(0, -5))) continue;
        if (!name.endsWith('.json') || !validId(name.slice(0, -5))) continue;
        if (!this.index.sessions.some(item => item.id === name.slice(0, -5))) {
          try { const saved = await this.read(this.file(name.slice(0, -5))); if (saved.schema === SCHEMA && validId(saved.session?.id)) this.index.sessions.push(this.metadata(saved.session)); }
          catch (error) { this.errors.push(error.message); }
        }
      }
      const fingerprint = projectId(migrationKey + JSON.stringify(sanitize(legacy)));
      if (legacy.length && !this.index.migrations.includes(fingerprint)) {
        await atomicJson(path.join(this.directory, 'backups', 'legacy-' + fingerprint + '.json'), { schema: SCHEMA, source: migrationKey, data: legacy });
        for (const value of legacy) {
          if (!validId(value?.id) || !Array.isArray(value.messages)) { this.errors.push('舊 Session 無法轉換，已保留於遷移備份。'); continue; }
          if (this.index.sessions.some(item => item.id === value.id)) continue;
          const normalized = new SessionStore([value]).get(value.id);
          normalized.tasks ||= []; normalized.revision = 1;
          await atomicJson(this.file(value.id), { schema: SCHEMA, session: normalized });
          this.index.sessions.push(this.metadata(normalized));
        }
        this.index.migrations.push(fingerprint);
      }
      await atomicJson(path.join(this.directory, 'index.json'), this.index);
      this.sessions = this.index.sessions;
    });
    return this;
  }
  metadata(session) {
    return sanitize({ id: session.id, title: session.title, workspace: session.workspace, updatedAt: session.updatedAt,
      archived: !!session.archived, empty: isEmptySession(session), tasks: (session.tasks || []).map(task => ({ id: task.id, request: task.request, status: task.status,
        resolvedBy: task.resolvedBy, agent: task.agent,
        endedAt: task.endedAt, startedAt: task.startedAt, files: task.files || [], result: String(task.result || '').slice(0, 1800), pending: task.pending || [] })) });
  }
  create(workspace = '') {
    const session = new SessionStore().create(workspace); session.tasks = []; session.revision = 0;
    this.loaded.set(session.id, session); this.sessions.unshift(this.metadata(session)); return session;
  }
  get(id) { return this.loaded.get(id); }
  async findEmpty(workspace, preferredId) {
    const candidates = this.sessions.filter(item => item.workspace === workspace && !item.archived && item.empty !== false);
    const preferred = candidates.find(item => item.id === preferredId);
    if (preferred) { candidates.splice(candidates.indexOf(preferred), 1); candidates.unshift(preferred); }
    for (const item of candidates) {
      const session = await this.openSession(item.id);
      if (isEmptySession(session)) return session;
    }
    return null;
  }
  async openSession(id) {
    if (this.loaded.has(id)) return this.loaded.get(id);
    const data = await this.read(this.file(id));
    if (!data || data.schema !== SCHEMA) throw new Error('找不到相容的 Session 資料。');
    const session = new SessionStore([data.session]).get(id);
    if (!session) throw new Error('Session 資料不完整，已保留原始檔案。');
    session.tasks ||= [];
    for (const task of session.tasks) if (['running', 'queued'].includes(task.status)) task.status = 'interrupted';
    this.loaded.set(id, session); return session;
  }
  add(session, message) {
    const item = sanitize({ id: randomUUID(), at: Date.now(), ...message }); session.messages.push(item); session.updatedAt = Date.now(); return item;
  }
  update(session, id, patch) { const item = session.messages.find(message => message.id === id); if (item) Object.assign(item, sanitize(patch)); return item; }
  save(session) {
    const snapshot = sanitize(session); const baseRevision = session.revision || 0;
    return this.exclusive(async () => {
      const currentIndex = await this.read(path.join(this.directory, 'index.json'));
      if (currentIndex?.deleted?.includes(session.id)) {
        await atomicJson(path.join(this.directory, 'conflicts', session.id + '-' + randomUUID() + '.json'), snapshot);
        throw new Error('Session 已由另一個視窗刪除；已保留衝突副本，不會重新建立被刪除的工作階段。');
      }
      const disk = await this.read(this.file(session.id));
      // Multiple windows may hold stale sessions. Preserve the incoming revision
      // as a conflict copy, never overwrite another writer's history.
      if ((disk?.session.revision || 0) > (session.revision || baseRevision)) {
        await atomicJson(path.join(this.directory, 'conflicts', session.id + '-' + randomUUID() + '.json'), snapshot);
        throw new Error('Session 已由另一個視窗更新，已保存衝突副本；請重新開啟工作階段。');
      }
      snapshot.revision = (disk?.session.revision || 0) + 1;
      await atomicJson(this.file(session.id), { schema: SCHEMA, session: snapshot }); session.revision = snapshot.revision;
      const index = await this.read(path.join(this.directory, 'index.json'), { schema: SCHEMA, sessions: [], migrations: [] });
      index.sessions = index.sessions.filter(item => item.id !== session.id); index.sessions.unshift(this.metadata(snapshot));
      await atomicJson(path.join(this.directory, 'index.json'), index); this.index = index; this.sessions = index.sessions;
    });
  }
  page(session, before = session.messages.length, size = 50) {
    before = Math.min(session.messages.length, Math.max(0, Number(before) || 0));
    const start = Math.max(0, before - Math.min(100, Math.max(1, size)));
    return { messages: session.messages.slice(start, before), before: start, hasMore: start > 0, total: session.messages.length };
  }
  async remove(id) {
    return this.exclusive(async () => {
      const index = await this.read(path.join(this.directory, 'index.json')); index.sessions = index.sessions.filter(item => item.id !== id);
      index.deleted = [...new Set([...(index.deleted || []), id])];
      await atomicJson(path.join(this.directory, 'index.json'), index);
      this.index = index; this.sessions = index.sessions; this.loaded.delete(id);
      await fs.unlink(this.file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
  }
  async project(workspace) { return this.read(path.join(this.directory, 'projects', projectId(workspace) + '.json'), { schema: SCHEMA, workspace, entries: [], updatedAt: null }); }
  async updateProject(workspace, edit) {
    return this.exclusive(async () => {
      const project = await this.project(workspace); edit(project); project.updatedAt = Date.now();
      await atomicJson(path.join(this.directory, 'projects', projectId(workspace) + '.json'), project); return sanitize(project);
    });
  }
  projectTasks(workspace) { return this.sessions.filter(session => session.workspace === workspace).flatMap(session => (session.tasks || []).map(task => ({ ...task, sessionId: session.id }))); }
  async backup() {
    await this.tail;
    const sessions = [];
    for (const item of this.sessions) { const disk = await this.read(this.file(item.id)); if (disk) sessions.push(disk.session); }
    const projects = [];
    for (const workspace of new Set(this.sessions.map(item => item.workspace))) projects.push(await this.project(workspace));
    return sanitize({ schema: SCHEMA, exportedAt: Date.now(), sessions, projects });
  }
  async restore(backup) {
    if (backup?.schema !== SCHEMA || !Array.isArray(backup.sessions) || !Array.isArray(backup.projects)) throw new Error('不支援的備份格式。');
    for (const source of backup.sessions) {
      if (!validId(source.id) || !Array.isArray(source.messages)) throw new Error('備份 Session 格式無效。');
    }
    // Always import with new IDs: restoring never destroys existing sessions.
    for (const source of backup.sessions) {
      const session = new SessionStore([sanitize(source)]).get(source.id); session.id = randomUUID(); session.revision = 0;
      session.title += '（還原）'; this.loaded.set(session.id, session); await this.save(session);
    }
    for (const source of backup.projects) await this.updateProject(source.workspace, target => {
      for (const entry of source.entries || []) if (!target.entries.some(item => item.id === entry.id)) target.entries.push(sanitize(entry));
    });
  }
}
module.exports = { MemoryStore, atomicJson, projectId, SCHEMA };
