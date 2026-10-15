'use strict';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function previouslyDenied(records, name, args) {
  const key = JSON.stringify(canonical(args));
  return records.some(record => record.type === 'tool' && record.name === name && record.result?.denied &&
    JSON.stringify(canonical(record.args)) === key);
}
module.exports = { previouslyDenied };
