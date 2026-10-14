'use strict';
const { parseReply, buildPrompt } = require('./protocol');
const { sanitize, redact, inspectOutboundPayload } = require('./security/guard');
const { runReadBatch } = require('./parallel');
const { isServiceLimit } = require('./parallel-policy');
const { isTransientRequestError } = require('./request-recovery');

async function runAgent({ bridge, tools, request, context, workspace, signal, maxSteps = 12,
  budget = 48000, timeoutMs = 240000, onActivity = () => {}, onFinal = () => {}, onJudge = () => {},
  onTool = () => {}, onBudget = () => {}, onStream = () => {}, onCheckpoint = () => {},
  initialRecords = [], attachment, profile = {}, modelBudget }) {
  const records = sanitize(initialRecords);
  const repeated = [];
  let consecutiveFailures = 0, recoveryChecks = 0, firstResponse = true;
  let repairs = 0, completionRetries = 0, previousMessage = '', budgetExhausted = false, usedSteps = 0;
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
    try { response = await bridge.chat(prompt, {
      signal, timeoutMs, onJudge, newConversation: step === 0, attachment: firstResponse ? attachment : undefined,
      onUpload: name => onActivity('正在上傳附件 ' + name),
      onToken: token => {
        rawReply += token;
        characters += token.length;
        if (Date.now() - lastProgress > 500) {
          lastProgress = Date.now();
          onActivity(`AI 正在回答（${characters} 字）`);
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
      records.push({ type: 'request_error', message: redact(error.message), attempt: consecutiveFailures, instruction: 'No tool executed from this failed response. Continue from saved evidence; verify ambiguous external results before using them.' });
      await checkpoint();
      if (consecutiveFailures >= 3) throw Object.assign(new Error('NTPU AI 連續三次無法完成模型請求，暫判服務不可用。已保留任務檢查點：' + redact(error.message)), { serviceLimited: true });
      onActivity(`回答未完成，排回共用佇列（恢復 ${consecutiveFailures}/2）`);
      onStream('');
      continue;
    }
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
      const recoverable = records.some(record => record.type === 'request_error' || record.result?.ok === false && !record.result?.denied);
      if (reply.completed === false && recoverable && !records.some(record => record.result?.denied) && recoveryChecks++ < 2) {
        records.push({ type: 'recovery_check', instruction: 'An ordinary failure alone is not a blocker. Try safe alternative tools or direct parent work; if an important child failed, use retry_task once with its original ID. Preserve failure evidence. Never bypass a denied permission or service limit. Report a concrete blocker only after feasible alternatives are exhausted.' });
        await checkpoint(); continue;
      }
      const plan = [...records].reverse().find(record => record.name === 'update_plan' && record.result?.ok);
      const unfinished = (profile.agent || 'build') === 'build' && (plan?.result.steps || []).some(item => item.status !== 'completed');
      const implementation = profile.agent === 'build' && /建立|新增|實作|修正|修改|產生|implement|create|build|fix/i.test(request) && !/^(?:請)?(?:只(?:說明|解釋|規劃)|(?:不要|不需|無需)(?:修改|實作|建立))/.test(request);
      const noAction = implementation && !records.some(record => record.result?.ok && (['write_file', 'edit_file', 'create_visual', 'run_command', 'download_file', 'install_skill', 'connect_mcp', 'add_mcp'].includes(record.name) || record.name?.startsWith('mcp_')));
      const denied = records.some(record => record.result?.denied);
      if ((unfinished || noAction) && !denied && reply.completed !== false && completionRetries++ < 2) {
        records.push({ type: 'completion_check', instruction: 'Your plan still has unfinished steps or implementation has no actual tool evidence. Complete the task using tools and update_plan, or report a specific blocker with completed:false. Do not stop at a proposal.' });
        await checkpoint(); continue;
      }
      onFinal(reply.message + ((unfinished || noAction) && reply.completed !== false ? '\n\n本地工具尚未確認全部任務完成；請查看工具結果與未完成項目。' : ''));
      return { completed: !unfinished && !noAction && reply.completed !== false, steps: step + 1 };
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
      await checkpoint(); continue;
    }
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
      onFinal('同一個工具操作連續重複三次且沒有新結果，已停止。請補充條件或調整需求後繼續。');
      return { completed: false, steps: step + 1, loopStopped: true };
    }
  }
  onFinal((budgetExhausted ? '本次可用的共用模型輪數已用完，已停止。' : `已達這次提問的 ${maxSteps} 輪上限，已停止。`) + '已批准的修改會保留；若要繼續，請說明剩下的工作。');
  return { completed: false, steps: usedSteps };
}

module.exports = { runAgent };
