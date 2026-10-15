'use strict';
const { randomUUID } = require('node:crypto');
const { runAgent } = require('./agent');
const { isServiceLimit } = require('./parallel-policy');
const { MAX_SUBAGENTS } = require('./adaptive-concurrency');
const { batchNames } = require('./parallel');
const { sanitize, redact } = require('./security/guard');
const { PARENT_RESERVE, MIN_CHILD_ROUNDS, remainingRounds, requestKey, delegationState, validateAssessment } = require('./delegation');
const SAFE = new Set(['list_files', 'read_file', 'search_text', 'load_skill', 'web_search', 'web_fetch', 'ntpu_lookup']);
const DEFINITIONS = [
  { name: 'delegate_tasks', description: '背景分派獨立唯讀子任務；role 是 explore/research/review。子任務不能修改檔案或執行 shell；主 agent 負責整合、實作與驗證。模型輪數共用父任務預算。', example: '{"tasks":[{"title":"找出入口","role":"explore","request":"檢查專案入口並附檔案行號"}]}' },
  { name: 'get_task_results', description: '等待子任務結束並收集真實結果；ids 可省略。錯誤或取消不能當成完成。', example: '{"ids":["task-id"]}' },
  { name: 'retry_task', description: '主 Agent 判斷失敗子任務對完成需求很重要時，可提供原始 id 與 reason，排回共用 Queue 一次。原失敗紀錄保留；429、登入失效、服務限制、取消或本機保存失敗不能重試。不得改標題或用 delegate_tasks 繞過一次上限。', example: '{"id":"failed-task-id","reason":"這份檔案是完成主要需求所必要的證據"}' },
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
  constructor({ base, bridge, scheduler, modelBudget, createTools, signal, context = '', workspace = '', profile = {}, timeoutMs, maxWorkers, occupiedSlots = () => 0, onEvent = () => {}, onBeforeCleanup = async () => {}, runner = runAgent }) {
    Object.assign(this, { base, bridge, scheduler, modelBudget, createTools, signal, context, workspace, profile, timeoutMs, occupiedSlots, onEvent, onBeforeCleanup, runner });
    this.maxWorkers = Math.min(MAX_SUBAGENTS, Math.max(1, Math.floor(Number(maxWorkers) || MAX_SUBAGENTS))); this.maxTasks = Math.max(4, this.maxWorkers * 2);
    this.jobs = new Map(); this.closed = false; this.assessment = null;
  }
  catalog() { return this.base.catalog().concat(DEFINITIONS.map(tool => tool.name === 'delegate_tasks' ? { ...tool, description: `背景分派 1–${this.maxWorkers} 個獨立唯讀子任務，role 是 explore/research/review；同時最多 ${this.maxWorkers} 個未結束子任務，父任務最多 ${this.maxTasks} 個。提供 expectedOutput 與 independent:true，主 Agent 繼續獨立工作。不能寫檔或執行 shell，最多六輪／子任務且共用父任務模型預算與請求排程，保留主 Agent ${PARENT_RESERVE} 輪整合。一般失敗不影響其他獨立工作；同一失敗內容不能改標題重派，重要的一般失敗只可透過 retry_task 排回 Queue 一次，附具體理由。429／登入／服務限制不得重試。` } : tool)); }
  get skills() { return this.base.skills; }
  get loadedSkills() { return this.base.loadedSkills; }
  parallelNames() { return batchNames(this.base.catalog()); }
  hasPending() { return [...this.jobs.values()].some(job => !job.collected); }
  waitPending() { return this.collect(); }
  delegationState(options = {}) {
    return delegationState({ ...options, modelBudget: this.modelBudget, maxWorkers: this.maxWorkers,
      occupiedSlots: this.occupiedSlots() + [...this.jobs.values()].filter(job => !job.endedAt).length,
      closed: this.closed, aborted: this.signal.aborted, blocked: this.scheduler.adaptive?.blocked || [...this.jobs.values()].some(job => job.serviceLimited || job.storageFailed),
      assessed: !!this.assessment, pending: this.jobs.size > 0, tasksRemaining: this.maxTasks - this.jobs.size });
  }
  assessDelegation(value) {
    if (this.assessment) throw new Error('本次分工已評估；新增獨立工作請使用 delegate_tasks。');
    const state = this.delegationState();
    if (this.closed || this.signal.aborted || this.scheduler.adaptive?.blocked) throw new Error('任務已停止或服務已暫停，不能新增分派。');
    const assessment = validateAssessment(value, state.maxTasks);
    if (assessment.tasks.length) {
      const result = this.delegate(assessment);
      this.assessment = { mode: 'delegated', taskIds: result.tasks.map(task => task.id), at: Date.now() };
      return { ...result, assessment: this.assessment };
    }
    this.assessment = { mode: 'single', rationale: redact(assessment.rationale), at: Date.now() };
    return { ok: true, assessment: this.assessment, instruction: '已記錄無獨立分工的理由，繼續主 Agent 工作。' };
  }
  async execute(name, args) {
    if (name === 'delegate_tasks') return this.delegate(args);
    if (name === 'retry_task') return this.retryTask(args);
    if (name === 'get_task_results') return this.collect(args.ids);
    if (name === 'cancel_task') {
      const job = this.jobs.get(args.id); if (!job) throw new Error('找不到子任務。');
      job.controller.abort(); return { ok: true, id: job.id, message: '已要求取消；收集結果時會等待清理。' };
    }
    return this.base.execute(name, args);
  }
  delegate({ tasks }) {
    if (this.closed || this.signal.aborted) throw new Error('已停止');
    if (this.scheduler.adaptive?.blocked || [...this.jobs.values()].some(job => job.serviceLimited || job.storageFailed)) throw new Error('服務限制或本機保存失敗，禁止新增分派。');
    if (Array.isArray(tasks) && tasks.some(task => [...this.jobs.values()].some(job => ['error', 'interrupted'].includes(job.status) && requestKey(task?.request) === requestKey(job.request)))) {
      throw new Error('同一失敗或取消的子任務禁止新增分派；重要一般失敗請以原始 id 使用 retry_task 一次。');
    }
    return this.schedule(tasks);
  }
  retryTask({ id, reason }) {
    if (this.closed || this.signal.aborted) throw new Error('已停止');
    const job = this.jobs.get(id);
    if (!job || job.status !== 'error' || !job.endedAt) throw new Error('只能重試本次已結束的失敗子任務。');
    if (job.retryOf || job.retryAttempted) throw new Error('每個原始子任務最多重試一次。');
    if (job.serviceLimited || this.scheduler.adaptive?.blocked || job.storageFailed) throw new Error('登入、服務限制或本機保存錯誤禁止重試。');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('請提供具體重要性理由（1–500 字）。');
    if (remainingRounds(this.modelBudget) - PARENT_RESERVE < MIN_CHILD_ROUNDS) throw new Error('共用模型預算不足，保留主 Agent 整合回合，不能重試。');
    job.retryAttempted = true;
    try { return this.schedule([{ title: job.title.slice(0, 100) + ' · 重要重試 1/1', role: job.role, request: job.request, expectedOutput: job.expectedOutput, independent: job.independent }], { retryOf: job.id, retryReason: redact(reason.trim()) }); }
    catch (error) { job.retryAttempted = false; throw error; }
  }
  schedule(tasks, retry = {}) {
    if (this.closed || this.signal.aborted) throw new Error('已停止');
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > this.maxWorkers || this.jobs.size + tasks.length > this.maxTasks || tasks.some(task => !['explore', 'research', 'review'].includes(task?.role) || typeof task.request !== 'string' || !task.request.trim() || task.request.length > 6000 || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 120 ||
      task.independent !== undefined && task.independent !== true || task.expectedOutput !== undefined && (typeof task.expectedOutput !== 'string' || task.expectedOutput.trim().length < 8 || task.expectedOutput.length > 1200))) throw new Error(`需要 1–${this.maxWorkers} 個有效唯讀子任務；父任務最多 ${this.maxTasks} 個。`);
    const pending = [...this.jobs.values()].filter(job => !job.endedAt).length;
    if (pending + tasks.length + this.occupiedSlots() > this.maxWorkers) throw new Error(`最多 ${this.maxWorkers} 個未結束子任務；請先收集結果。`);
    const available = remainingRounds(this.modelBudget) - PARENT_RESERVE;
    if (available < (pending + tasks.length) * MIN_CHILD_ROUNDS) throw new Error('共用模型預算不足，保留主 Agent 整合與驗證輪數。');
    const childSteps = Math.min(6, Math.floor(available / (pending + tasks.length)));
    const jobs = tasks.map(task => {
      const controller = new AbortController(); const abort = () => controller.abort();
      this.signal.addEventListener('abort', abort, { once: true });
      const job = { ...sanitize({ title: task.title, role: task.role, request: task.request, expectedOutput: task.expectedOutput, independent: task.independent }),
        ...sanitize(retry), id: randomUUID(), controller, abort, status: 'running', startedAt: Date.now(), records: [], outputParts: [], collected: false, maxSteps: childSteps };
      this.jobs.set(job.id, job); this.emit(job);
      job.promise = this.work(job); return { id: job.id, title: job.title, role: job.role, ...sanitize(retry) };
    });
    return { ok: true, tasks: jobs, instruction: '子任務正在背景執行。進行獨立工作，並用 get_task_results 收集結果；主 agent 才能修改檔案。' };
  }
  emit(job) { this.onEvent(sanitize({ id: job.id, title: job.title, role: job.role, expectedOutput: job.expectedOutput, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, activity: job.activity, retryOf: job.retryOf, retryReason: job.retryReason, result: job.result, partialResult: job.partialResult, outputParts: job.outputParts, outputDraft: job.outputDraft, completedOutput: job.completedOutput, records: job.records })); }
  async work(job) {
    let channel;
    try {
      if (job.controller.signal.aborted) throw new Error('已停止');
      channel = await this.bridge.createChannel();
      if (job.controller.signal.aborted) throw new Error('已停止');
      const base = this.createTools(job.controller.signal, this.scheduler.bridge(channel), job.title);
      const result = await this.runner({ bridge: this.scheduler.bridge(channel), tools: readonly(base), signal: job.controller.signal,
        modelBudget: { limit: this.modelBudget.limit, consume: () => remainingRounds(this.modelBudget) <= PARENT_RESERVE ? null : this.modelBudget.consume() }, maxSteps: job.maxSteps, budget: 32000, timeoutMs: this.timeoutMs,
        request: job.request + (job.expectedOutput ? '\n\nEXPECTED OUTPUT:\n' + job.expectedOutput : ''),
        context: this.context.slice(0, 6000), workspace: this.workspace,
        profile: { ...this.profile, agent: job.role === 'explore' ? 'ask' : job.role },
        onActivity: text => { job.activity = text; this.emit(job); },
        onStream: text => { job.partialResult = redact(text); this.emit(job); },
        onOutputPart: async part => {
          if (part.partial) job.outputDraft = sanitize(part);
          else { job.outputParts.push(sanitize(part)); job.outputDraft = null; }
          job.partialResult = undefined;
          job.completedOutput = !!(part.done && part.completed);
          this.emit(job);
          try { await this.onBeforeCleanup(); }
          catch (error) { job.storageFailed = true; throw error; }
        },
        onCheckpoint: records => { job.records = sanitize(records).slice(-8); this.emit(job); },
        onFinal: text => { job.result = redact(text); job.partialResult = undefined; },
      });
      const evidence = job.records.filter(record => record.type === 'tool');
      const onlyFailedTools = evidence.some(record => record.result?.ok === false || record.result?.denied) && !evidence.some(record => record.result?.ok === true);
      job.status = job.controller.signal.aborted ? 'interrupted' : result.completed && !onlyFailedTools ? 'done' : 'error';
      if (onlyFailedTools) job.result = (job.result || '') + '\n工具證據只有失敗結果，子任務未完成。';
    } catch (error) {
      job.serviceLimited = isServiceLimit(error);
      // Channel startup can fail before a model call reaches the scheduler.
      if (job.serviceLimited && this.scheduler.adaptive && !this.scheduler.adaptive.blocked) { this.scheduler.adaptive.block(error); this.scheduler.onError(error); }
      job.status = job.controller.signal.aborted ? 'interrupted' : 'error';
      job.result = (job.result || job.partialResult || job.outputParts.map(part => part.message || '').join('') + (job.outputDraft?.message || '')) + '\n' + redact(error.message);
    }
    finally {
      this.signal.removeEventListener('abort', job.abort); job.endedAt = Date.now(); this.emit(job);
      let saved = !job.storageFailed; try { await this.onBeforeCleanup(); } catch { saved = false; job.storageFailed = true; }
      if (!saved) { job.status = 'error'; job.result = (job.result || '') + '\n本機保存失敗，已保留校方對話。'; this.emit(job); }
      await channel?.close({ cleanup: saved }).catch(() => {});
    }
  }
  async collect(ids) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => !this.jobs.has(id)))) throw new Error('子任務 ids 不正確。');
    const jobs = ids ? ids.map(id => this.jobs.get(id)) : [...this.jobs.values()].filter(job => !job.collected);
    await Promise.all(jobs.map(job => job.promise));
    jobs.forEach(job => { job.collected = true; });
    return sanitize({ ok: jobs.every(job => job.status === 'done'), tasks: jobs.map(job => ({ id: job.id, title: job.title, status: job.status, result: job.result,
      outputParts: job.outputParts, outputDraft: job.outputDraft, partialResult: job.partialResult, completedOutput: job.completedOutput, evidence: job.records.slice(-4) })) });
  }
  async close({ cancel = true } = {}) { this.closed = true; for (const job of this.jobs.values()) if (cancel && !job.endedAt) job.controller.abort(); await Promise.all([...this.jobs.values()].map(job => job.promise)); }
}
module.exports = { AgentWorkers, readonly };
