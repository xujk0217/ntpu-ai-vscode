'use strict';
// Recover only transport failures. Permissions, validation and local writes must
// not be silently repeated. Every recovery is a new budgeted scheduler entry.
function isTransientRequestError(error = {}) {
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN'].includes(error.code) || error.name === 'TimeoutError' ||
    /逾時|timeout|timed out|network|fetch failed|socket hang up|connection (?:closed|reset)|Target.*(?:page|context|browser).*closed|ERR_(?:NETWORK|CONNECTION|INTERNET_DISCONNECTED)/i.test(String(error.message || ''));
}
module.exports = { isTransientRequestError };
