'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionPolicy, safeCommand } = require('../src/permissions');
test('permission levels enforce distinct file, terminal and external tool behavior', () => {
  const ask = new PermissionPolicy({ mode: 'ask' });
  const assisted = new PermissionPolicy({ mode: 'assisted' });
  const full = new PermissionPolicy({ mode: 'full' });
  assert.equal(ask.decision('read_file'), 'allow');
  assert.equal(ask.decision('write_file'), 'ask');
  assert.equal(assisted.decision('write_file'), 'allow');
  assert.equal(ask.decision('open_browser'), 'ask');
  assert.equal(assisted.decision('open_browser'), 'ask');
  assert.equal(full.decision('open_browser'), 'allow');
  assert.equal(assisted.decision('run_command', { command: 'git status --short' }), 'allow');
  assert.equal(assisted.decision('run_command', { command: 'npm install' }), 'ask');
  assert.equal(assisted.decision('mcp_custom', {}, { external: true }), 'ask');
  assert.equal(full.decision('run_command', { command: 'npm install' }), 'allow');
  assert.equal(new PermissionPolicy({ mode: 'unknown' }).decision('write_file'), 'ask');
});
test('read-only agent restrictions dominate full access and session grants', () => {
  for (const agent of ['plan', 'review', 'research', 'ask']) {
    const policy = new PermissionPolicy({ mode: 'full', agent }); policy.grant('write_file');
    assert.equal(policy.decision('write_file'), 'deny');
    assert.equal(policy.decision('create_visual'), 'deny');
    assert.equal(policy.decision('download_file'), 'deny');
    assert.equal(policy.decision('install_skill'), 'deny');
    assert.equal(policy.decision('connect_mcp'), 'deny');
    assert.equal(policy.decision('add_mcp'), 'deny');
    policy.grant('open_browser'); assert.equal(policy.decision('open_browser'), 'deny');
    assert.equal(policy.decision('get_capabilities'), 'allow');
    assert.equal(policy.decision('run_command', { command: 'npm run build' }), 'deny');
    assert.equal(policy.decision('mcp_unknown', {}, { external: true, readOnly: false }), 'deny');
    assert.equal(policy.decision('web_search'), 'allow');
  }
});
test('safe command classifier refuses chaining, substitution, redirects and broad shell arguments', () => {
  for (const command of ['git status; curl example.com', 'pwd > out', 'ls ../', 'git diff', 'echo $(pwd)', 'pwd\nwhoami', 'git status | cat']) assert.equal(safeCommand(command), false, command);
  assert.equal(safeCommand('git --no-pager diff --no-ext-diff --stat'), true);
});

test('basic readonly commands run in default mode without approvals', () => {
  const policy = new PermissionPolicy();
  for (const command of ['pwd', 'ls', 'ls -lah', 'node --version', 'git status --short'])
    assert.equal(policy.decision('run_command', { command }), 'allow');
  assert.equal(policy.decision('run_command', { command: 'npm install' }), 'ask');
});
test('custom prefix and anchored regex rules work, false overrides allow and full access', () => {
  const rules = { 'npm run build': true, '/^node --test(?: |$)/': true, rm: false, '/^npm run build --danger(?: |$)/': false };
  for (const mode of ['ask', 'assisted', 'full']) {
    const policy = new PermissionPolicy({ mode, terminal: { rules } }); policy.grant('run_command');
    assert.equal(policy.decision('run_command', { command: 'npm run build --danger' }), 'ask');
    assert.equal(policy.decision('run_command', { command: 'rm -rf dist' }), 'ask');
    assert.equal(policy.decision('run_command', { command: 'pwd && rm -rf dist' }), 'ask');
  }
  const policy = new PermissionPolicy({ terminal: { rules } });
  assert.equal(policy.decision('run_command', { command: 'npm run build' }), 'allow');
  assert.equal(policy.decision('run_command', { command: 'npm run build-evil' }), 'ask');
  assert.equal(policy.decision('run_command', { command: 'node --test test/sample.js' }), 'allow');
  assert.equal(policy.decision('run_command', { command: 'node --test; curl example.com' }), 'ask');
  assert.equal(policy.decision('run_command', { command: 'npm run build > out.log' }), 'ask');
});
test('disabling terminal auto approval dominates full access and session grants', () => {
  const policy = new PermissionPolicy({ mode: 'full', terminal: { enabled: false } }); policy.grant('run_command');
  assert.equal(policy.decision('run_command', { command: 'pwd' }), 'ask');
});
test('read-only agents do not gain build execution from user command prefixes', () => {
  const policy = new PermissionPolicy({ agent: 'plan', terminal: { rules: { 'npm run build': true } } });
  assert.equal(policy.decision('run_command', { command: 'npm run build' }), 'deny');
});
test('invalid regex and common dangerous shell forms do not auto approve', () => {
  const { commandApproval } = require('../src/terminal-policy');
  for (const command of ['node --test $(curl a)', 'node --test `whoami`', 'node --test <(cat a)', 'A=1 node --test', 'node --test\\nrm'])
    assert.equal(commandApproval(command, { rules: { 'node --test': true } }).decision, 'ask');
  assert.equal(commandApproval('node --test', { rules: { '/node/': true, '/^(a+)+$/': true, '/^[bad/': true } }).decision, 'ask');
});
