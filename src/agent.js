'use strict';
const { parseReply, buildPrompt } = require('./protocol');
const { sanitize, redact, inspectOutboundPayload } = require('./security/guard');
const { runReadBatch } = require('./parallel');
const { isServiceLimit } = require('./parallel-policy');
const { isTransientRequestError } = require('./request-recovery');

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
  initialRecords = [], attachment, profile = {}, modelBudget }) {
  const records = sanitize(initialRecords);
  const repeated = [];
  let consecutiveFailures = 0, recoveryChecks = 0, stagnantRecoveryChecks = 0, lastRecoveryEvidence = '', firstResponse = true;
  let repairs = 0, completionRetries = 0, previousMessage = '', budgetExhausted = false, usedSteps = 0, blockedRepeat = null;
  const checkpoint = async () => onCheckpoint(sanitize(records));
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) throw new Error('已停止');
    const round = modelBudget ? modelBudget.consume() : step + 1;
    if (round === null) { budgetExhausted = true; break; }
    usedSteps++;
    onActivity(`AI 正在處理（${round}/${modelBudget?.limit || maxSteps}）`);
    let characters = 0, lastProgress = 0;
    const catalog = tools.catalog?.();
    const prompt = inspectOutboundPayload(buildPrompt({ request: redact(request), context: redact(context), workspace, records, budget, profile,
      ...(catalog ? { catalog } : {}), parallelTools: [...(tools.parallelNames?.() || [])], skills: tools.skills?.list() || [], loadedSkills: sanitize([...(tools.loadedSkills?.values() || [])]) }));
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
          if (/"kind"\s*:\s*"final"/.test(rawReply)) {
            const match = rawReply.match(/"message"\s*:\s*"((?:\\.|[^"\\])*)/);
            if (match) { try { onStream(JSON.parse('"' + match[1] + '"')); } catch {} }
          }
        }
      },
    });
      consecutiveFailures = 0; firstResponse = false;
    } catch (error) {
      if (signal.aborted || isServiceLimit(error) || !isTransientRequestError(error)) throw error;
      consecutiveFailures++;
      records.push({ type: 'request_error', message: redact(error.message), code: error.code, diagnostics: sanitize(error.diagnostics), attempt: consecutiveFailures,
        instruction: 'No tool executed from this failed response. Continue from saved evidence; verify ambiguous external results before using them.' +
          (error.code === 'EMPTY_MODEL_RESPONSE' ? ' The provider finished without output. Choose a smaller next step: inspect one relevant section or write one small complete module; avoid generating an entire large implementation in one response. Preserve the task scope and existing successful tools.' : '') });
      await checkpoint();
      if (consecutiveFailures >= 3) throw Object.assign(new Error('NTPU AI 連續三次無法完成模型請求，暫判服務不可用。已保留任務檢查點：' + redact(error.message)), { serviceLimited: true });
      onActivity(`回答未完成，排回共用佇列（恢復 ${consecutiveFailures}/2）`);
      onStream('');
      continue;
    } finally { onRequestState(null); }
    if (signal.aborted) throw new Error('已停止');
    let reply;
    try { reply = sanitize(parseReply(response.text, catalog ? new Set(catalog.map(tool => tool.name)) : undefined, tools.parallelNames?.() || new Set())); }
    catch (error) {
      records.push({ type: 'format_error', message: error.message, instruction: 'Return a valid single JSON response. No tool was run.' });
      await checkpoint();
      continue;
    }
    if (reply.kind === 'final') {
      if (tools.hasPending?.()) {
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
      onFinal(reply.message + ((unfinished || noAction || failed) && !denied && reply.completed !== false ? '\n\n本地工具尚未確認全部任務完成；請查看工具結果與未完成項目。' : ''));
      return { completed: !unfinished && !noAction && !failed && !denied && reply.completed !== false, steps: step + 1 };
    }
    if (reply.kind === 'unstructured') {
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
  onFinal((budgetExhausted ? '本次可用的共用模型輪數已用完，已停止。' : `已達這次提問的 ${maxSteps} 輪上限，已停止。`) + '已批准的修改會保留；若要繼續，請說明剩下的工作。');
  return { completed: false, steps: usedSteps };
}

module.exports = { runAgent };
