'use strict';
const { randomUUID } = require('node:crypto');
const { runAgent } = require('./agent');
const { isServiceLimit } = require('./parallel-policy');
const { MAX_SUBAGENTS } = require('./adaptive-concurrency');
const { workerTool, DISCOVERY } = require('./tool-discovery');
const { batchNames } = require('./parallel');
const { sanitize, redact } = require('./security/guard');
const { PARENT_RESERVE, MIN_CHILD_ROUNDS, remainingRounds, requestKey, requestShape, explorationEvidence, concreteSingleRationale, delegationState, validateAssessment } = require('./delegation');
const DEFINITIONS = [
  { name: 'delegate_tasks', description: '背景分派獨立唯讀子任務；role 是 explore/research/review。子任務不能修改檔案或執行 shell；主 agent 負責整合、實作與驗證。模型輪數共用父任務預算。', example: '{"tasks":[{"title":"找出入口","role":"explore","request":"檢查專案入口並附檔案行號"}]}' },
  { name: 'get_task_results', description: '等待子任務結束並收集真實結果；ids 可省略。錯誤或取消不能當成完成。', example: '{"ids":["task-id"]}' },
  { name: 'retry_task', description: '主 Agent 判斷失敗子任務對完成需求很重要時，可提供原始 id 與 reason，排回共用 Queue 一次。原失敗紀錄保留；429、登入失效、服務限制、取消或本機保存失敗不能重試。不得改標題或用 delegate_tasks 繞過一次上限。', example: '{"id":"failed-task-id","reason":"這份檔案是完成主要需求所必要的證據"}' },
  { name: 'cancel_task', description: '取消指定唯讀子任務，保留已取得的證據。', example: '{"id":"task-id"}' },
];
function readonly(base) {
  const catalog = options => base.catalog(options).filter(workerTool);
  return { catalog, prepareTools(request) { base.restrictDiscovery?.(workerTool); return base.prepareTools?.(request); }, skills: base.skills, loadedSkills: base.loadedSkills, parallelNames: () => batchNames(catalog()), execute(name, args) {
    if (DISCOVERY.has(name)) base.restrictDiscovery?.(workerTool);
    if (!catalog().some(tool => tool.name === name)) throw new Error('唯讀子任務禁止修改、shell 或再次分派。');
    return base.execute(name, args);
  } };
}
class AgentWorkers {
  constructor({ base, bridge, scheduler, modelBudget, createTools, signal, context = '', workspace = '', profile = {}, timeoutMs, maxWorkers, occupiedSlots = () => 0, onEvent = () => {}, onBeforeCleanup = async () => {}, runner = runAgent }) {
    Object.assign(this, { base, bridge, scheduler, modelBudget, createTools, signal, context, workspace, profile, timeoutMs, occupiedSlots, onEvent, onBeforeCleanup, runner });
    this.maxWorkers = Math.min(MAX_SUBAGENTS, Math.max(1, Math.floor(Number(maxWorkers) || MAX_SUBAGENTS))); this.maxTasks = Math.max(4, this.maxWorkers * 2);
    this.jobs = new Map(); this.closed = false; this.assessment = null; this.reassessmentUsed = false;
  }
  catalog(options) { return this.base.catalog(options).concat(DEFINITIONS.map(tool => tool.name === 'delegate_tasks' ? { ...tool, description: `背景分派 1–${this.maxWorkers} 個獨立唯讀子任務，role 是 explore/research/review；同時最多 ${this.maxWorkers} 個未結束子任務，父任務最多 ${this.maxTasks} 個。提供 expectedOutput 與 independent:true，主 Agent 繼續獨立工作。不能寫檔或執行 shell，最多六輪／子任務且共用父任務模型預算與請求排程，保留主 Agent ${PARENT_RESERVE} 輪整合。一般失敗不影響其他獨立工作；同一失敗內容不能改標題重派，重要的一般失敗只可透過 retry_task 排回 Queue 一次，附具體理由。429／登入／服務限制不得重試。` } : tool)); }
  prepareTools(request) { return this.base.prepareTools?.(request); }
  get skills() { return this.base.skills; }
  get loadedSkills() { return this.base.loadedSkills; }
  parallelNames() { return batchNames(this.base.catalog()); }
  hasPending() { return [...this.jobs.values()].some(job => !job.collected); }
  waitPending() { return this.collect(); }
  delegationState(options = {}) {
    const evidence = explorationEvidence(options.records);
    const reassessment = !!(this.assessment?.mode === 'single' && !this.reassessmentUsed &&
      evidence.length >= 2 && evidence.some(item => !this.assessment.evidence.includes(item)));
    const state = delegationState({ ...options, modelBudget: this.modelBudget, maxWorkers: this.maxWorkers,
      occupiedSlots: this.occupiedSlots() + [...this.jobs.values()].filter(job => !job.endedAt).length,
      closed: this.closed, aborted: this.signal.aborted, blocked: this.scheduler.adaptive?.blocked || [...this.jobs.values()].some(job => job.serviceLimited || job.storageFailed),
      assessed: !!this.assessment && !reassessment, pending: this.jobs.size > 0, tasksRemaining: this.maxTasks - this.jobs.size });
    if (state.required && !readonly(this.base).catalog().some(tool => tool.name !== 'load_skill')) return { ...state, required: false, reason: '沒有可供子 Agent 查證的唯讀工具' };
    if (state.required && reassessment) return { ...state, reassessment: true,
      reason: '探索發現新的獨立範圍，重新評估一次分工', instruction: state.instruction + ' 已新增不同探索來源；依實際證據再評估一次，不可沿用先前泛用理由。' };
    return state;
  }
  recordAssessment(assessment, options) {
    if (this.assessment) this.reassessmentUsed = true;
    this.assessment = { ...assessment, evidence: explorationEvidence(options.records), at: Date.now() };
    return this.assessment;
  }
  assessDelegation(value, options = {}) {
    const state = this.delegationState(options);
    if (this.assessment && !state.reassessment) throw new Error('本次分工已評估；新增獨立工作請使用 delegate_tasks。');
    if (this.closed || this.signal.aborted || this.scheduler.adaptive?.blocked) throw new Error('任務已停止或服務已暫停，不能新增分派。');
    const assessment = validateAssessment(value, state.maxTasks);
    if (assessment.tasks.length) {
      const result = this.delegate(assessment);
      return { ...result, assessment: this.recordAssessment({ mode: 'delegated', taskIds: result.tasks.map(task => task.id) }, options) };
    }
    if (state.required && !concreteSingleRationale(assessment.rationale, options.records)) {
      const fallback = this.fallbackDelegation({ ...options, reason: '分工評估只有未經證據支持的單 Agent 理由' });
      if (fallback) return fallback;
    }
    return { ok: true, assessment: this.recordAssessment({ mode: 'single', rationale: redact(assessment.rationale) }, options),
      instruction: '已記錄無獨立分工的理由，繼續主 Agent 工作；若探索發現新的獨立範圍，再評估一次。' };
  }
  fallbackDelegation(options = {}) {
    const state = this.delegationState(options);
    if (!state.required) return null;
    const catalog = readonly(this.base).catalog();
    const local = catalog.some(tool => ['read_file', 'search_text', 'list_files'].includes(tool.name));
    const web = catalog.some(tool => ['web_search', 'web_fetch', 'ntpu_lookup'].includes(tool.name) || tool.readOnly && ['exa', 'ntpu_ai4x'].includes(tool.server));
    const shape = requestShape(options.request);
    if (!local && !(web && shape.research)) return null;
    const original = redact(String(options.request || ''));
    const scope = original.length <= 4800 ? original : original.slice(0, 3600) + '\n[提問節錄；中段省略，保留結尾限制]\n' + original.slice(-1200);
    const task = local ? { title: '獨立盤點既有測試與風險', role: 'review',
      request: `使用者任務：\n${scope}\n\n你的獨立範圍只有：使用目前可用的唯讀工具，找出與此任務直接相關的既有程式入口、既有測試案例與可能遺漏的回歸邊界。以少量搜尋和重點讀取提供真實檔案位置與證據；若沒有測試，明確回報搜尋範圍與缺口。這是既有證據盤點，不等待主 Agent 修改、不執行測試、不寫檔、不執行 shell，不重做主 Agent 的實作。如果正在讀取的檔案有變動，註明需要主 Agent 重新確認。`,
      expectedOutput: '相關入口與既有測試的檔案行號、實際涵蓋情境、尚缺回歸邊界，以及查證限制；不得宣稱已執行測試。' } : {
      title: '獨立查證官方來源', role: 'research',
      request: `使用者研究任務：\n${scope}\n\n使用目前可用的唯讀研究工具，獨立查證任務中一項重要假設或限制。優先官方來源，提供直接連結、已證實與未能證實的部分。不要重複撰寫主 Agent 的整份答案、不要寫檔或執行 shell。`,
      expectedOutput: '一項重要假設或限制的官方來源連結、具體證據、適用條件與尚待查證處。' };
    const result = this.delegate({ tasks: [{ ...task, independent: true }] }, { evidenceRequired: true });
    return { ...result, assessment: this.recordAssessment({ mode: 'delegated', fallback: true,
      rationale: redact(options.reason || '已辨識可獨立查證的範圍，使用有界唯讀分工'), taskIds: result.tasks.map(item => item.id) }, options) };
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
  delegate({ tasks }, hostOptions = {}) {
    if (this.closed || this.signal.aborted) throw new Error('已停止');
    if (this.scheduler.adaptive?.blocked || [...this.jobs.values()].some(job => job.serviceLimited || job.storageFailed)) throw new Error('服務限制或本機保存失敗，禁止新增分派。');
    if (Array.isArray(tasks) && tasks.some(task => [...this.jobs.values()].some(job => ['error', 'interrupted'].includes(job.status) && requestKey(task?.request) === requestKey(job.request)))) {
      throw new Error('同一失敗或取消的子任務禁止新增分派；重要一般失敗請以原始 id 使用 retry_task 一次。');
    }
    return this.schedule(tasks, { ...(hostOptions.evidenceRequired ? { evidenceRequired: true } : {}) });
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
    try { return this.schedule([{ title: job.title.slice(0, 100) + ' · 重要重試 1/1', role: job.role, request: job.request, expectedOutput: job.expectedOutput, independent: job.independent }], { retryOf: job.id, retryReason: redact(reason.trim()), ...(job.evidenceRequired ? { evidenceRequired: true } : {}) }); }
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
        context: this.context, workspace: this.workspace,
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
      const missingEvidence = job.evidenceRequired && !evidence.some(record => record.name !== 'load_skill' && record.result?.ok === true && !record.result.denied);
      const onlyFailedTools = evidence.some(record => record.result?.ok === false || record.result?.denied) && !evidence.some(record => record.result?.ok === true);
      job.status = job.controller.signal.aborted ? 'interrupted' : result.completed && !onlyFailedTools && !missingEvidence ? 'done' : 'error';
      if (missingEvidence) job.result = (job.result || '') + '\n沒有成功的唯讀工具查證，證據盤點尚未完成。';
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
