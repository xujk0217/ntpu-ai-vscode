'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSubmitEnter } = require('../media/composer-keys');

const enter = overrides => ({ key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
  isComposing: false, keyCode: 13, repeat: false, ...overrides });

test('Enter mode sends on Enter and leaves Shift+Enter as a newline', () => {
  assert.equal(shouldSubmitEnter(enter(), 'enter'), true);
  assert.equal(shouldSubmitEnter(enter({ shiftKey: true }), 'enter'), false);
  assert.equal(shouldSubmitEnter(enter({ altKey: true }), 'enter'), false);
});

test('modifier mode keeps Enter as a newline and sends on Ctrl or Command Enter', () => {
  assert.equal(shouldSubmitEnter(enter(), 'modifierEnter'), false);
  assert.equal(shouldSubmitEnter(enter({ ctrlKey: true }), 'modifierEnter'), true);
  assert.equal(shouldSubmitEnter(enter({ metaKey: true }), 'modifierEnter'), true);
  assert.equal(shouldSubmitEnter(enter({ metaKey: true, shiftKey: true }), 'modifierEnter'), false);
});

test('IME composition, repeated keydown and non-Enter modifiers never submit', () => {
  for (const event of [enter({ isComposing: true }), enter({ keyCode: 229 }), enter({ repeat: true }), enter({ altKey: true }), { ...enter(), key: 'a' }])
    assert.equal(shouldSubmitEnter(event, 'enter'), false);
});
