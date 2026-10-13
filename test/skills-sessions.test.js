'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SkillCatalog, parseSkill } = require('../src/skills');
const { SessionStore } = require('../src/sessions');
test('portable skill discovery loads metadata and exact instructions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ntpu-skills-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.agents', 'skills', 'test-skill'); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), '---\nname: test-skill\ndescription: Check a fixture\n---\nRead the file before proposing changes.');
  const catalog = new SkillCatalog(path.join(root, 'builtins'));
  await catalog.discover(root);
  assert.equal(catalog.list().find(item => item.name === 'test-skill').description, 'Check a fixture');
  assert.match(catalog.load('test-skill').body, /Read the file/);
  assert.throws(() => parseSkill('plain text', 'bad'), /frontmatter/);
});
test('sessions survive serialization while full access and interrupted actions reset on reload', () => {
  const store = new SessionStore(); const session = store.create('file:///project'); session.options.permission = 'full';
  store.add(session, { role: 'tool', name: 'run_command', status: 'running' });
  store.add(session, { role: 'stream', text: 'incomplete stream' });
  const restored = new SessionStore(store.serialize()).get(session.id);
  assert.equal(restored.workspace, 'file:///project');
  assert.equal(restored.options.permission, 'ask');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.messages[1].interrupted, true);
  assert.equal(restored.messages[0].status, 'interrupted');
});
