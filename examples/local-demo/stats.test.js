const test = require('node:test');
const assert = require('node:assert/strict');
const mean = require('./stats');

test('mean of [2,4,6] is 4', () => {
  assert.equal(mean([2, 4, 6]), 4);
});

test('mean handles negative numbers', () => {
  assert.equal(mean([-2, -4, -6]), -4);
});

test('mean of empty array returns null', () => {
  assert.equal(mean([]), null);
});
