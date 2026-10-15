'use strict';
function taskStepLimit(configured = 100, depth = 'standard') {
  const value = Number(configured);
  const limit = Number.isFinite(value) ? Math.max(1, Math.min(200, Math.floor(value))) : 100;
  return depth === 'quick' ? Math.min(12, limit) : limit;
}
module.exports = { taskStepLimit };
