'use strict';
const { randomUUID } = require('node:crypto');
const { redact } = require('../security/guard');

async function probeConcurrency(bridge, { signal, onProgress = () => {}, timeoutMs = 90000 } = {}) {
  const channels = []; const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  try {
    if (controller.signal.aborted) throw new Error('已停止');
    onProgress('正在建立兩個獨立測試聊天室');
    // Startup is sequential; only the two actual UI-initiated requests overlap.
    for (let i = 0; i < 2; i++) { if (controller.signal.aborted) throw new Error('已停止'); channels.push(await bridge.createChannel()); }
    const prefix = 'NTPU_PARALLEL_' + randomUUID().replaceAll('-', '').slice(0, 8);
    const timings = [];
    const requests = channels.map(async (channel, index) => {
      const marker = prefix + '_' + index;
      const timing = { index, startedAt: Date.now(), openedAt: null, firstTokenAt: null, endedAt: null, matched: false }; timings.push(timing);
      try {
        onProgress('兩個聊天室正在同時呼叫 NTPU AI');
        const result = await channel.chat(`這是有限的連線測試。請只回覆 ${marker}，並加上一行簡短的繁體中文問候。`, {
          signal: controller.signal, timeoutMs, onOpen: () => { timing.openedAt = Date.now(); }, onToken: () => { timing.firstTokenAt ||= Date.now(); }, newConversation: true });
        timing.matched = result.text.includes(marker) && !result.text.includes(prefix + '_' + (1 - index));
      } catch (error) {
        timing.error = redact(error.message); controller.abort();
      } finally { timing.endedAt = Date.now(); }
    });
    await Promise.all(requests);
    const successful = timings.every(item => item.matched && !item.error);
    // Overlapping local promises alone do not prove overlapping model streams.
    const streamOverlap = successful && timings.every(item => item.openedAt && item.firstTokenAt) &&
      Math.max(...timings.map(item => item.openedAt)) < Math.min(...timings.map(item => item.endedAt));
    return { timestamp: new Date().toISOString(), successful, streamOverlap, verified: successful && streamOverlap,
      requests: timings.map(item => ({ ...item, durationMs: item.endedAt - item.startedAt })),
      message: successful && streamOverlap ? '兩個真實聊天室回覆完成，串流時間重疊，未觀察到回覆串台。' :
        successful ? '兩個聊天室均成功，但未確認串流重疊；維持序列模型請求。' : '並行測試未通過；維持序列模型請求，沒有自動重試。' };
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(channels.map(channel => channel.close()));
  }
}
module.exports = { probeConcurrency };
