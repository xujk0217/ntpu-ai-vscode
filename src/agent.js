'use strict';
const { parseReply, buildPrompt } = require('./protocol');

async function runAgent({ bridge, tools, request, context, workspace, signal, maxSteps = 12,
  budget = 48000, timeoutMs = 240000, onActivity = () => {}, onFinal = () => {}, onJudge = () => {},
  onTool = () => {}, onBudget = () => {}, onStream = () => {}, onCheckpoint = () => {},
  initialRecords = [], attachment, profile = {} }) {
  const records = [...initialRecords];
  const repeated = [];
  let repairs = 0, completionRetries = 0, previousMessage = '';
  const checkpoint = () => onCheckpoint(records);
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) throw new Error('已停止');
    onActivity(`AI 正在處理（${step + 1}/${maxSteps}）`);
    let characters = 0, lastProgress = 0;
    const catalog = tools.catalog?.();
    const prompt = buildPrompt({ request, context, workspace, records, budget, profile,
      ...(catalog ? { catalog } : {}), skills: tools.skills?.list() || [], loadedSkills: [...(tools.loadedSkills?.values() || [])] });
    onBudget({ used: prompt.length, total: budget });
    let rawReply = '';
    const response = await bridge.chat(prompt, {
      signal, timeoutMs, onJudge, newConversation: step === 0, attachment: step === 0 ? attachment : undefined,
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
    if (signal.aborted) throw new Error('已停止');
    let reply;
    try { reply = parseReply(response.text, catalog ? new Set(catalog.map(tool => tool.name)) : undefined); }
    catch (error) {
      records.push({ type: 'format_error', message: error.message, instruction: 'Return a valid single JSON response. No tool was run.' });
      checkpoint();
      continue;
    }
    if (reply.kind === 'final') {
      const plan = [...records].reverse().find(record => record.name === 'update_plan' && record.result?.ok);
      const unfinished = (profile.agent || 'build') === 'build' && (plan?.result.steps || []).some(item => item.status !== 'completed');
      const implementation = profile.agent === 'build' && /建立|新增|實作|修正|修改|產生|implement|create|build|fix/i.test(request) && !/^(?:請)?(?:只(?:說明|解釋|規劃)|(?:不要|不需|無需)(?:修改|實作|建立))/.test(request);
      const noAction = implementation && !records.some(record => record.result?.ok && (['write_file', 'edit_file', 'create_visual', 'run_command'].includes(record.name) || record.name?.startsWith('mcp_')));
      const denied = records.some(record => record.result?.denied);
      if ((unfinished || noAction) && !denied && reply.completed !== false && completionRetries++ < 2) {
        records.push({ type: 'completion_check', instruction: 'Your plan still has unfinished steps or implementation has no actual tool evidence. Complete the task using tools and update_plan, or report a specific blocker with completed:false. Do not stop at a proposal.' });
        checkpoint(); continue;
      }
      onFinal(reply.message + ((unfinished || noAction) && reply.completed !== false ? '\n\n本地工具尚未確認全部任務完成；請查看工具結果與未完成項目。' : ''));
      return { completed: !unfinished && !noAction && reply.completed !== false, steps: step + 1 };
    }
    if (reply.kind === 'unstructured') {
      if (profile.agent === 'build' && repairs++ < 2) {
        records.push({ type: 'format_error', instruction: 'Your last response was plain text; no tool ran. Resume the task using a single JSON tool response, or a truthful JSON final. Printing code does not create a file.' });
        checkpoint(); continue;
      }
      onFinal(reply.message + '\n\n此回答未使用本地操作格式，因此沒有執行檔案或終端機工具。');
      return { completed: false, unstructured: true, steps: step + 1 };
    }
    // Model-generated text alone never counts as an executed tool action.
    const id = require('node:crypto').randomUUID();
    const message = typeof reply.message === 'string' ? reply.message.slice(0, 500) : '';
    onTool({ id, status: 'running', name: reply.name, args: reply.args, message: message === previousMessage ? '' : message });
    if (message) previousMessage = message;
    let result;
    try { result = await tools.execute(reply.name, reply.args); }
    catch (error) { onTool({ id, status: signal.aborted ? 'interrupted' : 'error', result: error.message }); throw error; }
    onTool({ id, status: result.denied ? 'denied' : result.ok === false ? 'error' : 'done', result });
    const args = { ...reply.args };
    if (reply.name === 'write_file') args.content = `(proposed ${reply.args.content?.length || 0} characters; re-read the file for current contents)`;
    if (reply.name === 'create_visual') args.svg = `(rendered SVG: ${reply.args.svg?.length || 0} characters)`;
    records.push({ type: 'tool', name: reply.name, args, result });
    checkpoint();
    const fingerprint = JSON.stringify({ name: reply.name, args, result });
    repeated.push(fingerprint);
    if (repeated.length >= 3 && repeated.slice(-3).every(item => item === fingerprint)) {
      onFinal('同一個工具操作連續重複三次且沒有新結果，已停止。請補充條件或調整需求後繼續。');
      return { completed: false, steps: step + 1, loopStopped: true };
    }
  }
  onFinal(`已達這次提問的 ${maxSteps} 輪上限，已停止。已批准的修改會保留；若要繼續，請說明剩下的工作。`);
  return { completed: false, steps: maxSteps };
}

module.exports = { runAgent };
