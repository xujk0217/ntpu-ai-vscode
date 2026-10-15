'use strict';
const { parseReply, buildPrompt } = require('./protocol');
const { sanitize, redact, inspectOutboundPayload } = require('./security/guard');
const { runReadBatch } = require('./parallel');
const { isServiceLimit } = require('./parallel-policy');
const { isTransientRequestError } = require('./request-recovery');
const { OutputParts, partialOutput, MAX_OUTPUT_BYTES } = require('./output-parts');

const CONTROL_TOOLS = new Set(['update_plan', 'get_capabilities', 'load_skill', 'refresh_skills', 'ask_user']);
function unresolvedToolFailure(records) {
  // Keep failed execution visible while the model reads documentation or updates its plan.
  const index = records.findLastIndex(record => record.type === 'tool' && !CONTROL_TOOLS.has(record.name) && record.result?.ok === false && !record.result.denied);
  if (index < 0) return null;
  const failed = records[index];
  const desktopFailure = failed.name === 'run_command' && /kLSServerCommunicationErr|Launch.?Services|cannot open display|no method available for opening/i.test(failed.result.output || '');
  const resolved = records.slice(index + 1).some(record => record.result?.ok === true &&
    (desktopFailure ? record.name === 'open_browser' && record.result.opened === true : record.name === failed.name));
  return resolved ? null : failed;
}

async function runAgent({ bridge, tools, request, context, workspace, signal, maxSteps = 12,
  budget = 48000, timeoutMs = 240000, onActivity = () => {}, onFinal = () => {}, onJudge = () => {},
  onTool = () => {}, onBudget = () => {}, onStream = () => {}, onCheckpoint = () => {}, onResponseMetadata = () => {}, onRequestState = () => {},
  initialRecords = [], attachment, profile = {}, modelBudget, onOutputPart = async () => {} }) {
  const records = sanitize(initialRecords);
  const output = new OutputParts(records);
  const repeated = [];
  let consecutiveFailures = 0, recoveryChecks = 0, stagnantRecoveryChecks = 0, lastRecoveryEvidence = '', firstResponse = true;
  let repairs = 0, completionRetries = 0, previousMessage = '', budgetExhausted = false, usedSteps = 0, blockedRepeat = null, assessmentAttempts = 0;
  let assessed = records.some(record => record.type === 'delegation_assessment');
  const checkpoint = async () => onCheckpoint(sanitize(records));
  const assessmentFailure = message => {
    if (++assessmentAttempts >= 2) {
      assessed = true;
      records.push({ type: 'delegation_assessment', result: { delegated: false, rationale: '模型未回傳有效分工格式，主 Agent 接手；未建立虛構子任務。' } });
    } else records.push({ type: 'coordination_check', message, instruction: 'Assess independent work now with kind:delegation before ordinary tools or a final. Use valid bounded independent tasks or a concrete rationale.' });
  };
  const saveDraft = async raw => {
    let draft = output.preserveDraft(raw);
    if (!draft && String(raw || '').trim()) {
      if (Buffer.byteLength(String(raw)) > MAX_OUTPUT_BYTES) throw Object.assign(new Error('未完成回覆超過 8 MiB 本機保存上限。已完成段落仍保留。'), { code: 'OUTPUT_TOO_LARGE' });
      draft = { type: 'response_draft', id: 'interrupted-response', index: 1, message: redact(String(raw)), partial: true, done: false };
    }
    if (!draft) return false;
    for (let i = records.length - 1; i >= 0; i--) if (records[i].type === draft.type && (draft.type !== 'response_draft' || records[i].id === draft.id)) records.splice(i, 1);
    records.push(draft); await onOutputPart(sanitize(draft)); await checkpoint(); onStream(output.preview(draft.message)); return true;
  };
  const finalText = text => output.parts.length ? output.text + (text && text !== output.text ? '\n\n' + text : '') : text;
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) throw new Error('已停止');
    const round = modelBudget ? modelBudget.consume() : step + 1;
    if (round === null) { budgetExhausted = true; break; }
    usedSteps++;
    onActivity(`AI 正在處理（${round}/${modelBudget?.limit || maxSteps}）`);
    let characters = 0, lastProgress = 0;
    const catalog = tools.catalog?.();
    const delegationState = !assessed ? tools.delegationState?.({ request, profile, maxSteps }) : null;
    const prompt = inspectOutboundPayload(buildPrompt({ request: redact(request), context: redact(context), workspace, records, budget, profile,
      ...(catalog ? { catalog } : {}), outputState: output.promptState(), delegationState,
      parallelTools: [...(tools.parallelNames?.() || [])], skills: tools.skills?.list() || [], loadedSkills: sanitize([...(tools.loadedSkills?.values() || [])]) }));
    onBudget({ used: prompt.length, total: budget });
    let rawReply = '';
    let response;
    let sentAt;
    const requestState = phase => onRequestState({ phase, startedAt: sentAt, lastTokenAt: characters ? Date.now() : undefined,
      characters, round, total: modelBudget?.limit || maxSteps });
    requestState('queued');
    try { response = await bridge.chat(prompt, {
      signal, timeoutMs, onJudge, onResponseMetadata, newConversation: step === 0, attachment: firstResponse ? attachment : undefined,
      onSend: () => { sentAt = Date.now(); requestState('waiting'); },
      onUpload: name => onActivity('正在上傳附件 ' + name),
      onToken: token => {
        rawReply += token;
        characters += token.length;
        if (Date.now() - lastProgress > 500) {
          lastProgress = Date.now();
          onActivity(`AI 正在回答（${characters} 字）`);
          requestState('streaming');
          const partial = partialOutput(rawReply, { allowComplete: true });
          if (partial) onStream(output.preview(partial.message));
        }
      },
    });
      consecutiveFailures = 0; firstResponse = false;
    } catch (error) {
      await saveDraft(rawReply);
      if (signal.aborted || isServiceLimit(error) || !isTransientRequestError(error)) throw error;
      consecutiveFailures++;
      records.push({ type: 'request_error', message: redact(error.message), code: error.code, diagnostics: sanitize(error.diagnostics), attempt: consecutiveFailures,
        instruction: 'No tool executed from this failed response. Continue from saved evidence; verify ambiguous external results before using them.' +
          (error.code === 'EMPTY_MODEL_RESPONSE' ? ' The provider finished without output. Choose a smaller next step: inspect one relevant section or write one small complete module; avoid generating an entire large implementation in one response. Preserve the task scope and existing successful tools.' : '') });
      await checkpoint();
      if (consecutiveFailures >= 3) throw Object.assign(new Error('NTPU AI 連續三次無法完成模型請求，暫判服務不可用。已保留任務檢查點：' + redact(error.message)), { serviceLimited: true });
      onActivity(`回答未完成，排回共用佇列（恢復 ${consecutiveFailures}/2）`);
      if (!output.active) onStream('');
      continue;
    } finally { onRequestState(null); }
    if (signal.aborted) { await saveDraft(rawReply || response.text); throw new Error('已停止'); }
    let reply;
    try { reply = sanitize(parseReply(response.text, catalog ? new Set(catalog.map(tool => tool.name)) : undefined, tools.parallelNames?.() || new Set())); }
    catch (error) {
      await saveDraft(response.text);
      records.push({ type: 'format_error', message: error.message, instruction: 'Return a valid single JSON response. No tool was run.' });
      if (delegationState?.required) assessmentFailure(redact(error.message));
      await checkpoint();
      continue;
    }
    if (reply.kind === 'delegation') {
      if (!tools.assessDelegation || assessed) { records.push({ type: 'format_error', instruction: 'Delegation assessment is unavailable or already complete. Continue using the actual tool catalog.' }); await checkpoint(); continue; }
      try {
        const result = await tools.assessDelegation(reply);
        records.push({ type: 'delegation_assessment', result }); assessed = true;
      } catch (error) {
        if (signal.aborted || isServiceLimit(error)) throw error;
        assessmentFailure(redact(error.message));
      }
      await checkpoint(); continue;
    }
    if (delegationState?.required) {
      assessmentFailure();
      await checkpoint(); continue;
    }
    if (reply.kind === 'output') {
      let part;
      try {
        part = output.accept(reply);
      } catch (error) {
        if (error.code === 'OUTPUT_TOO_LARGE') throw error;
        records.push({ type: 'format_error', message: redact(error.message), instruction: 'Use the exact next part id/index in HOST SAVED OUTPUT STATE. No tool was executed.' });
        await checkpoint(); continue;
      }
      for (let i = records.length - 1; i >= 0; i--) if (records[i].type === 'output_draft') records.splice(i, 1);
      records.push(part); await onOutputPart(sanitize(part)); await checkpoint(); onStream(output.text);
      if (!reply.done) { onActivity(`已保存第 ${reply.index} 段（共 ${output.text.length} 字），正在接續`); continue; }
      reply = { kind: 'final', completed: reply.completed, message: output.text };
    } else if (output.parts.length && !output.done && reply.kind !== 'unstructured') {
      records.push({ type: 'format_error', instruction: 'A document is incomplete. Continue with kind:output at HOST SAVED OUTPUT STATE.nextIndex; do not replace it with a summary/final or execute tools mid-document.' });
      await checkpoint(); continue;
    }
    if (reply.kind === 'final') {
      if (tools.hasPending?.()) {
        if (!output.parts.length && reply.message) {
          const draft = { type: 'response_draft', id: 'provisional-final-' + step, index: 1, message: redact(reply.message), partial: true, provisional: true, done: false };
          records.push(draft); await onOutputPart(sanitize(draft)); await checkpoint();
        }
        records.push({ type: 'coordination', name: 'get_task_results', result: await tools.waitPending(), instruction: 'Subtasks have now settled. Use their actual evidence to finish the parent task; do not claim a failed subtask succeeded.' });
        await checkpoint(); continue;
      }
      const failed = unresolvedToolFailure(records);
      const recoverable = failed || reply.completed === false && records.some(record => record.type === 'request_error' || record.result?.ok === false && !record.result?.denied);
      const denied = records.some(record => record.result?.denied);
      const evidence = JSON.stringify([...new Set(records.filter(record => record.type === 'tool' && !CONTROL_TOOLS.has(record.name))
        .map(record => JSON.stringify({ name: record.name, args: record.args, result: record.result })))]);
      if (recoverable && !denied && recoveryChecks < 6) {
        stagnantRecoveryChecks = evidence === lastRecoveryEvidence ? stagnantRecoveryChecks + 1 : 0;
        lastRecoveryEvidence = evidence;
      }
      if (recoverable && !denied && recoveryChecks < 6 && stagnantRecoveryChecks < 2) {
        recoveryChecks++;
        records.push({ type: 'recovery_check', attempt: recoveryChecks, failedTool: failed?.name,
          instruction: 'An ordinary failure alone is not a blocker. Before finalizing, investigate the actual error with safe local tools, inspect available capabilities/skills, and use enabled web/MCP tools to consult official documentation when uncertain. Summarize the evidence and safe alternatives, then execute a materially different approach and verify the result. A successful read or plan update alone does not resolve a failed execution. For desktop HTML opening failures use open_browser rather than repeating shell open. If an important child failed, use retry_task once with its original ID, or do direct parent work. Preserve successful work and failure evidence. Never bypass a denied permission, protected path, sandbox or service limit. Do not invent attempts. Report a concrete blocker with completed:false only after feasible alternatives are exhausted, naming actual attempts and remaining work.' });
        onActivity('正在檢查失敗原因與替代方法');
        onStream('');
        await checkpoint(); continue;
      }
      const plan = [...records].reverse().find(record => record.name === 'update_plan' && record.result?.ok);
      const unfinished = (profile.agent || 'build') === 'build' && (plan?.result.steps || []).some(item => item.status !== 'completed');
      const implementation = (profile.agent || 'build') === 'build' && /建立|新增|實作|修正|修改|產生|implement|create|build|fix|(?:幫我|替我|直接|請).*(?:執行|啟動|開啟|打開|下載|安裝)/i.test(request) && !/^(?:請)?(?:只(?:說明|解釋|規劃)|(?:不要|不需|無需)(?:修改|實作|建立))/.test(request);
      const noAction = implementation && !records.some(record => record.result?.ok && (['write_file', 'edit_file', 'create_visual', 'run_command', 'open_browser', 'download_file', 'install_skill', 'connect_mcp', 'add_mcp'].includes(record.name) || record.name?.startsWith('mcp_')));
      if (!failed && (unfinished || noAction) && !denied && reply.completed !== false && completionRetries++ < 4) {
        records.push({ type: 'completion_check', instruction: 'Your plan still has unfinished steps or implementation has no actual tool evidence. Complete the task using tools and update_plan, or report a specific blocker with completed:false. Do not stop at a proposal.' });
        await checkpoint(); continue;
      }
      onFinal(finalText(reply.message) + ((unfinished || noAction || failed) && !denied && reply.completed !== false ? '\n\n本地工具尚未確認全部任務完成；請查看工具結果與未完成項目。' : ''));
      return { completed: !unfinished && !noAction && !failed && !denied && reply.completed !== false, steps: step + 1 };
    }
    if (reply.kind === 'unstructured') {
      // Keep malformed envelopes for diagnosis/recovery without treating them as tools.
      // Only a user-facing output draft enters the document continuation state.
      await saveDraft(response.text);
      if (output.draft) {
        records.push({ type: 'format_error', instruction: 'The response was cut or malformed. Its draft was saved. Regenerate only the unfinished part as a smaller complete kind:output JSON object with the next id/index, without summarizing or repeating saved parts.' });
        await checkpoint(); continue;
      }
      if (output.active) { records.push({ type: 'format_error', instruction: 'Continue the saved document with the next kind:output object. Plain text cannot replace committed output.' }); await checkpoint(); continue; }
      if (profile.agent === 'build' && repairs++ < 2) {
        records.push({ type: 'format_error', instruction: 'Your last response was plain text; no tool ran. Resume the task using a single JSON tool response, or a truthful JSON final. Printing code does not create a file.' });
        await checkpoint(); continue;
      }
      onFinal(reply.message + '\n\n此回答未使用本地操作格式，因此沒有執行檔案或終端機工具。');
      return { completed: false, unstructured: true, steps: step + 1 };
    }
    if (reply.kind === 'parallel') {
      records.push(...await runReadBatch(reply.tools, { tools, onTool, signal, message: reply.message || '' }));
      blockedRepeat = null;
      await checkpoint(); continue;
    }
    const callKey = JSON.stringify({ name: reply.name, args: reply.args });
    if (callKey === blockedRepeat) {
      onFinal('已要求調查替代方法，但模型仍提出同一個沒有進展的操作；未再次執行。任務尚未完成，檢查點已保留。');
      return { completed: false, steps: step + 1, loopStopped: true };
    }
    blockedRepeat = null;
    // Model-generated text alone never counts as an executed tool action.
    const id = require('node:crypto').randomUUID();
    const message = typeof reply.message === 'string' ? reply.message.slice(0, 500) : '';
    onTool(sanitize({ id, status: 'running', name: reply.name, args: reply.args, message: message === previousMessage ? '' : message }));
    if (message) previousMessage = message;
    let result;
    try { result = sanitize(await tools.execute(reply.name, reply.args)); }
    catch (error) {
      if (signal.aborted || isServiceLimit(error) || /本機保存|Session 已|寫入.*失敗/i.test(error.message)) { onTool({ id, status: signal.aborted ? 'interrupted' : 'error', result: redact(error.message) }); throw error; }
      result = { ok: false, error: redact(error.message) };
    }
    onTool({ id, status: result.denied ? 'denied' : result.ok === false ? 'error' : 'done', result });
    const args = { ...reply.args };
    if (reply.name === 'write_file') args.content = `(proposed ${reply.args.content?.length || 0} characters; re-read the file for current contents)`;
    if (reply.name === 'create_visual') args.svg = `(rendered SVG: ${reply.args.svg?.length || 0} characters)`;
    records.push({ type: 'tool', at: Date.now(), name: reply.name, args, result });
    await checkpoint();
    const fingerprint = JSON.stringify({ name: reply.name, args, result });
    repeated.push(fingerprint);
    if (repeated.length >= 3 && repeated.slice(-3).every(item => item === fingerprint)) {
      blockedRepeat = callKey;
      records.push({ type: 'loop_check', instruction: 'The same tool call produced identical results three times. Do not repeat it again. Investigate the error, consult available local or official web evidence, and execute a materially different safe approach. Never bypass a denial or sandbox. Preserve evidence and report completed:false if no feasible alternative exists.' });
      onActivity('操作沒有新進展，正在改查其他方法');
      await checkpoint();
    }
  }
  const stopped = (budgetExhausted ? '本次可用的共用模型輪數已用完，已停止。' : `已達這次提問的 ${maxSteps} 輪上限，已停止。`) + '已批准的修改與已保存的原文會保留；可從檢查點接續剩餘工作。';
  onFinal((output.active ? output.preview(output.draft?.message) + '\n\n' : '') + stopped);
  return { completed: false, steps: usedSteps };
}

module.exports = { runAgent };
