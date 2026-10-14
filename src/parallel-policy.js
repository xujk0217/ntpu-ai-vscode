'use strict';
// A bounded diagnostic range, not a claim about the provider's official limit.
const MAX_CONCURRENCY = 5;
function concurrencyLimit(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(MAX_CONCURRENCY, Math.floor(number)) : fallback;
}
function isServiceLimit(error = {}) {
  return [401, 402, 403, 409, 423, 429, 503].includes(Number(error.status)) || error.serviceLimited === true ||
    /429|登入|驗證|captcha|unauthori[sz]ed|forbidden|quota|rate.?limit|capacity|too many requests|resource.?exhausted|limit.?exceeded|service.?unavailable|overloaded|用量|配額|服務限制|限流|超過.*限制|達.*上限/i.test(String(error.message || ''));
}
function parallelPolicy(verification, { scope, now = Date.now(), enabled = true, maxConcurrency = 0, maxSubagents = 0 } = {}) {
  const age = now - Date.parse(verification?.timestamp);
  const fresh = verification?.scope === scope && Number.isFinite(age) && age >= 0 && age < 86400000;
  let proven = 1;
  if (fresh && verification?.verified === true && !verification.serviceLimited && !verification.cancelled) {
    if (verification.schemaVersion === 2) {
      for (const group of verification.groups || []) {
        if (group.concurrency !== proven + 1 || !group.verified || !group.successful || !group.streamOverlap || group.crossTalk || group.requests?.length !== group.concurrency || !group.requests.every(request => request.success && request.matched && !request.crossTalk && !request.error)) break;
        proven = group.concurrency;
      }
      proven = Math.min(proven, concurrencyLimit(verification.recommendedConcurrency));
    } else if (verification.successful && verification.streamOverlap && verification.requests?.every(request => request.matched && !request.error)) {
      proven = concurrencyLimit(verification.requests.length);
    }
  }
  const verified = proven > 1;
  const configured = Number(maxConcurrency) === 0 ? proven : concurrencyLimit(maxConcurrency);
  const effectiveConcurrency = enabled ? Math.min(proven, configured) : 1;
  const autoWorkers = Math.max(1, effectiveConcurrency - 1);
  const workerConcurrency = Math.min(effectiveConcurrency, Number(maxSubagents) === 0 ? autoWorkers : concurrencyLimit(maxSubagents));
  return { enabled, verified, maxConcurrency: Number(maxConcurrency) || 0, maxVerifiedConcurrency: proven, effectiveConcurrency, workerConcurrency };
}
module.exports = { MAX_CONCURRENCY, concurrencyLimit, isServiceLimit, parallelPolicy };
