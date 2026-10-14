'use strict';
const { randomUUID } = require('node:crypto');
const { redact } = require('../security/guard');
const { MAX_CONCURRENCY, concurrencyLimit, isServiceLimit } = require('../parallel-policy');

function peakStreams(requests) {
  const events = requests.filter(item => item.openedAt !== null && item.endedAt !== null && item.endedAt > item.openedAt)
    .flatMap(item => [[item.openedAt, 1], [item.endedAt, -1]]).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  let active = 0, peak = 0; for (const [, change] of events) { active += change; peak = Math.max(peak, active); } return peak;
}
async function probeGroup(bridge, concurrency, { signal, onProgress, timeoutMs }) {
  const channels = [], controller = new AbortController(); let failure = null;
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const prefix = 'NTPU_PARALLEL_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const markers = Array.from({ length: concurrency }, (_, index) => prefix + '_' + index);
  const requests = markers.map((_, index) => ({ index, startedAt: null, openedAt: null, firstTokenAt: null, endedAt: null, success: false, matched: false, crossTalk: false }));
  try {
    onProgress(`正在建立 ${concurrency} 個獨立測試聊天室`);
    // New pages for every group; no profile cloning, authentication export or retries.
    for (let index = 0; index < concurrency; index++) {
      if (controller.signal.aborted) break;
      channels.push(await bridge.createChannel());
    }
    if (!controller.signal.aborted && channels.length === concurrency) {
      onProgress(`正在測試 ${concurrency} 個同時請求`);
      await Promise.all(channels.map(async (channel, index) => {
        const timing = requests[index]; timing.startedAt = Date.now();
        try {
          if (controller.signal.aborted) throw new Error('已停止');
          const result = await channel.chat(`這是有限的連線測試。請只回覆 ${markers[index]} 作為第一行，再寫 10 行繁體中文簡短問候（每行約 20 字、總長不超過 400 字）。請不要加入其他識別碼。`, {
            signal: controller.signal, timeoutMs, newConversation: true,
            onOpen: () => { timing.openedAt = Date.now(); }, onToken: () => { timing.firstTokenAt ??= Date.now(); } });
          timing.success = true; timing.matched = result.text.includes(markers[index]);
          timing.crossTalk = markers.some((marker, peer) => peer !== index && result.text.includes(marker));
          if (!timing.matched || timing.crossTalk) { timing.error = timing.crossTalk ? '回覆包含其他聊天室識別碼，疑似串台。' : '回覆缺少自己的識別碼。'; failure ||= { reason: timing.crossTalk ? 'cross_talk' : 'reply_mismatch', serviceLimited: false }; controller.abort(); }
        } catch (error) {
          timing.error = redact(error.message); const status = Number(error.status);
          if (Number.isFinite(status)) timing.httpStatus = status;
          timing.cancelled = controller.signal.aborted;
          if (!failure && !signal?.aborted) failure = { reason: isServiceLimit(error) ? 'service_limit' : 'request_failure', serviceLimited: isServiceLimit(error) };
          if (isServiceLimit(error)) failure = { reason: 'service_limit', serviceLimited: true };
          controller.abort();
        } finally { timing.endedAt = Date.now(); }
      }));
    }
  } catch (error) {
    failure = { reason: isServiceLimit(error) ? 'service_limit' : 'startup_failure', serviceLimited: isServiceLimit(error), error: redact(error.message) }; controller.abort();
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled(channels.map(channel => channel.close({ cleanup: !failure?.serviceLimited })));
  }
  for (const timing of requests) {
    timing.durationMs = timing.startedAt !== null && timing.endedAt !== null ? timing.endedAt - timing.startedAt : null;
    timing.firstTokenMs = timing.startedAt !== null && timing.firstTokenAt !== null ? timing.firstTokenAt - timing.startedAt : null;
    if (timing.startedAt === null) timing.error = failure?.error || (signal?.aborted ? '使用者已停止，未送出請求。' : '這組未送出請求。');
  }
  const successCount = requests.filter(item => item.success && item.matched && !item.crossTalk).length;
  const successful = successCount === concurrency;
  const streamOverlap = successful && requests.every(item => item.openedAt !== null && item.firstTokenAt !== null) && peakStreams(requests) === concurrency;
  const crossTalk = requests.some(item => item.crossTalk);
  const times = requests.map(item => item.durationMs).filter(value => value !== null);
  return { concurrency, successCount, successRate: successCount / concurrency, successful, streamOverlap, crossTalk,
    observedPeakConcurrency: peakStreams(requests), verified: successful && streamOverlap && !signal?.aborted && !failure,
    cancelled: signal?.aborted === true, serviceLimited: failure?.serviceLimited === true,
    stopReason: signal?.aborted ? 'cancelled' : failure?.reason || (!streamOverlap ? 'no_overlap' : null), error: failure?.error,
    responseTimes: { averageMs: times.length ? Math.round(times.reduce((a,b)=>a+b,0)/times.length) : null, minMs: times.length ? Math.min(...times) : null, maxMs: times.length ? Math.max(...times) : null }, requests };
}
function waitBetweenGroups(milliseconds, signal, onProgress, next) {
  if (!milliseconds || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const deadline = Date.now() + milliseconds;
    const finish = () => { clearTimeout(timer); clearInterval(progress); signal?.removeEventListener('abort', finish); resolve(); };
    const update = () => onProgress(`上一組已通過，等待 ${Math.max(0, Math.ceil((deadline-Date.now())/1000))} 秒後測試 ${next} 個請求；可停止測試。`);
    const timer = setTimeout(finish, milliseconds), progress = setInterval(update, 1000);
    signal?.addEventListener('abort', finish, { once: true }); update();
  });
}
async function probeConcurrency(bridge, { signal, onProgress = () => {}, timeoutMs = 90000, maxConcurrency = MAX_CONCURRENCY, groupPauseMs = 60000, onGroup = async () => {} } = {}) {
  const groups = []; let maxVerifiedConcurrency = 1;
  const ceiling = Math.max(2, concurrencyLimit(maxConcurrency, MAX_CONCURRENCY));
  const pause = Number.isFinite(groupPauseMs) ? Math.max(0, Math.min(120000, groupPauseMs)) : 60000;
  for (let count = 2; count <= ceiling; count++) {
    if (count > 2) await waitBetweenGroups(pause, signal, onProgress, count);
    if (signal?.aborted) break;
    const group = await probeGroup(bridge, count, { signal, onProgress, timeoutMs });
    groups.push(group); await onGroup(group);
    if (!group.verified) break;
    maxVerifiedConcurrency = count;
  }
  const serviceLimited = groups.some(group => group.serviceLimited), cancelled = signal?.aborted === true;
  const recommendedConcurrency = serviceLimited || cancelled ? 1 : maxVerifiedConcurrency;
  const verified = recommendedConcurrency > 1;
  return { schemaVersion: 2, timestamp: new Date().toISOString(), maxTestConcurrency: ceiling, groupPauseMs: pause, groups, maxVerifiedConcurrency,
    recommendedConcurrency, verified, successful: groups.length > 0 && groups.every(group => group.successful),
    streamOverlap: groups.length > 0 && groups.every(group => group.streamOverlap), serviceLimited, cancelled,
    stopReason: cancelled ? 'cancelled' : groups.at(-1)?.stopReason || null,
    message: serviceLimited ? `較低組已驗證至 ${maxVerifiedConcurrency}；遇到登入失效或服務限制，立即停止並降級為單一請求。較高並行數尚未確認，不會重試或繞過限制。` : cancelled ? '測試已停止，降級為單一請求。' : verified ? `當次環境已驗證最多 ${recommendedConcurrency} 個同時串流請求；非官方上限或永久保證。` : '未確認兩個以上請求可可靠重疊，維持單一請求；沒有自動重試。' };
}
module.exports = { probeConcurrency, probeGroup, peakStreams };
