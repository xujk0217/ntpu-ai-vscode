'use strict';

function shouldSubmitEnter(event, mode = 'enter') {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229 || event.repeat) return false;
  return mode === 'enter' || !!(event.metaKey || event.ctrlKey);
}

module.exports = { shouldSubmitEnter };
