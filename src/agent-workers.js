'use strict';
const { randomUUID } = require('node:crypto');
const { runAgent } = require('./agent');
const { batchNames } = require('./parallel');
const { sanitize, redact } = require('./security/guard');
const SAFE = new Set(['list_files', 'read_file', 'search_text', 'load_skill', 'web_search', 'web_fetch', 'ntpu_lookup']);
const DEFINITIONS = [
  { name: 'delegate_tasks', description: '背景分派 1–2 個獨立唯讀子任務；role 是 explore/research/review。子任務不能修改檔案或執行 shell；主 agent 負責整合、實作與驗證。每次父任務最多 4 個子任務，模型輪數共用父任務預算。', example: '{"tasks":[{"title":"找出入口","role":"explore","request":"檢查專案入口並附檔案行號"}]}' },
  { name: 'get_task_results', description: '等待子任務結束並收集真實結果；ids 可省略。錯誤或取消不能當成完成。', example: '{"ids":["task-id"]}' },
  { name: 'cancel_task', description: '取消指定唯讀子任務，保留已取得的證據。', example: '{"id":"task-id"}' },
];
function readonly(base) {
  const catalog = () => base.catalog().filter(tool => SAFE.has(tool.name) || tool.readOnly && ['exa', 'ntpu_ai4x'].includes(tool.server));
  return { catalog, skills: base.skills, loadedSkills: base.loadedSkills, parallelNames: () => batchNames(catalog()), execute(name, args) {
    if (!catalog().some(tool => tool.name === name)) throw new Error('唯讀子任務禁止修改、shell 或再次分派。');
    return base.execute(name, args);
  } };
}
class AgentWorkers {
  constructor({ base, bridge, scheduler, modelBudget, createTools, signal, context = '', workspace = '', profile = {}, timeoutMs, onEvent = () => {}, onBeforeCleanup = async () => {}, runner = runAgent }) {
    Object.assign(this, { base, bridge, scheduler, modelBudget, createTools, signal, context, workspace, profile, timeoutMs, onEvent, onBeforeCleanup, runner });
    this.jobs = new Map(); this.closed = false;
  }
  catalog() { return this.base.catalog().concat(DEFINITIONS); }
  get skills() { return this.base.skills; }
  get loadedSkills() { return this.base.loadedSkills; }
  parallelNames() { return batchNames(this.base.catalog()); }
  hasPending() { return [...this.jobs.values()].some(job => !job.collected); }
  waitPending() { return this.collect(); }
  async execute(name, args) {
    if (name === 'delegate_tasks') return this.delegate(args);
    if (name === 'get_task_results') return this.collect(args.ids);
    if (name === 'cancel_task') {
      const job = this.jobs.get(args.id); if (!job) throw new Error('找不到子任務。');
      job.controller.abort(); return { ok: true, id: job.id, message: '已要求取消；收集結果時會等待清理。' };
    }
    return this.base.execute(name, args);
  }
  delegate({ tasks }) {
    if (this.closed || this.signal.aborted) throw new Error('已停止');
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 2 || this.jobs.size + tasks.length > 4 || tasks.some(task => !['explore', 'research', 'review'].includes(task?.role) || typeof task.request !== 'string' || !task.request.trim() || task.request.length > 6000 || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 120)) throw new Error('需要 1–2 個有效唯讀子任務；父任務最多 4 個。');
    const pending = [...this.jobs.values()].filter(job => !job.endedAt).length;
    if (pending + tasks.length > 2) throw new Error('最多兩個未結束子任務；請先收集結果。');
    const jobs = tasks.map(task => {
      const controller = new AbortController(); const abort = () => controller.abort();
      this.signal.addEventListener('abort', abort, { once: true });
      const job = { ...sanitize(task), id: randomUUID(), controller, abort, status: 'running', startedAt: Date.now(), records: [], collected: false };
      this.jobs.set(job.id, job); this.emit(job);
      job.promise = this.work(job); return { id: job.id, title: job.title, role: job.role };
    });
    return { ok: true, tasks: jobs, instruction: '子任務正在背景執行。進行獨立工作，並用 get_task_results 收集結果；主 agent 才能修改檔案。' };
  }
  emit(job) { this.onEvent(sanitize({ id: job.id, title: job.title, role: job.role, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, activity: job.activity, result: job.result, records: job.records })); }
  async work(job) {
    let channel;
    try {
      if (job.controller.signal.aborted) throw new Error('已停止');
      channel = await this.bridge.createChannel();
      if (job.controller.signal.aborted) throw new Error('已停止');
      const base = this.createTools(job.controller.signal, this.scheduler.bridge(channel), job.title);
      const result = await this.runner({ bridge: this.scheduler.bridge(channel), tools: readonly(base), signal: job.controller.signal,
        modelBudget: { limit: this.modelBudget.limit, consume: () => this.modelBudget.limit - this.modelBudget.used <= 2 ? null : this.modelBudget.consume() }, maxSteps: 6, budget: 32000, timeoutMs: this.timeoutMs, request: job.request,
        context: this.context.slice(0, 6000), workspace: this.workspace,
        profile: { ...this.profile, agent: job.role === 'explore' ? 'ask' : job.role },
        onActivity: text => { job.activity = text; this.emit(job); },
        onCheckpoint: records => { job.records = sanitize(records).slice(-8); this.emit(job); },
        onFinal: text => { job.result = redact(text).slice(0, 10000); },
      });
      job.status = job.controller.signal.aborted ? 'interrupted' : result.completed ? 'done' : 'error';
    } catch (error) { job.status = job.controller.signal.aborted ? 'interrupted' : 'error'; job.result = redact(error.message); }
    finally {
      this.signal.removeEventListener('abort', job.abort); job.endedAt = Date.now(); this.emit(job);
      let saved = true; try { await this.onBeforeCleanup(); } catch { saved = false; job.status = 'error'; job.result = (job.result || '') + '\n本機保存失敗，已保留校方對話。'; this.emit(job); }
      await channel?.close({ cleanup: saved }).catch(() => {});
    }
  }
  async collect(ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !this.jobs.has(id)))) throw new Error('子任務 ids 不正確。');
    const jobs = ids ? ids.map(id => this.jobs.get(id)) : [...this.jobs.values()].filter(job => !job.collected);
    await Promise.all(jobs.map(job => job.promise));
    jobs.forEach(job => { job.collected = true; });
    return sanitize({ ok: jobs.every(job => job.status === 'done'), tasks: jobs.map(job => ({ id: job.id, title: job.title, status: job.status, result: job.result, evidence: job.records.slice(-4) })) });
  }
  async close() { this.closed = true; for (const job of this.jobs.values()) if (!job.endedAt) job.controller.abort(); await Promise.all([...this.jobs.values()].map(job => job.promise)); }
}
module.exports = { AgentWorkers, readonly };
