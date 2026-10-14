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
module.exports = { MAX_CONCURRENCY, concurrencyLimit, isServiceLimit };
