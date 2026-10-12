'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');

function parseSkill(text, fallbackName) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter。');
  const meta = YAML.parse(match[1], { maxAliasCount: 0 }) || {};
  const name = meta.name || fallbackName;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || typeof meta.description !== 'string') {
    throw new Error('skill 需要有效的 name 與 description。');
  }
  if (text.length > 24000) throw new Error('skill 超過 24000 字。');
  return { name, description: meta.description.slice(0, 400), body: match[2].trim(), metadata: meta.metadata || {} };
}

class SkillCatalog {
  constructor(builtinDirectory, extraDirectories = []) { this.builtinDirectory = builtinDirectory; this.extraDirectories = extraDirectories; this.items = new Map(); this.errors = []; }
  async discover(root) {
    this.items.clear(); this.errors = [];
    const directories = [this.builtinDirectory, path.join(os.homedir(), '.ntpu-ai-coder', 'skills'),
      ...this.extraDirectories, ...['.agents/skills', '.opencode/skills', '.claude/skills'].map(directory => path.join(root, directory))];
    const realRoot = await fs.realpath(root);
    for (const directory of directories) {
      let folders;
      try { folders = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') this.errors.push(error.message); continue; }
      const realDirectory = await fs.realpath(directory);
      if (directory.startsWith(root + path.sep) && !realDirectory.startsWith(realRoot + path.sep)) { this.errors.push('專案 skills 目錄指向工作區外，已略過。'); continue; }
      for (const folder of folders.slice(0, 80)) {
        if (!folder.isDirectory()) continue;
        const file = path.join(directory, folder.name, 'SKILL.md');
        try {
          const real = await fs.realpath(file);
          if (!real.startsWith(realDirectory + path.sep)) throw new Error('skill 符號連結超出選定 skills 資料夾。');
          const stat = await fs.stat(real);
          if (stat.size > 48000) throw new Error('skill 檔案過大。');
          const skill = parseSkill(await fs.readFile(real, 'utf8'), folder.name);
          this.items.set(skill.name, { ...skill, file, source: directory === this.builtinDirectory ? '內建' : '自訂' });
        } catch (error) { this.errors.push(`${folder.name}: ${error.message}`); }
      }
    }
    return this.list();
  }
  list() { return [...this.items.values()].map(({ name, description, source }) => ({ name, description, source })); }
  load(name) { const skill = this.items.get(name); if (!skill) throw new Error('找不到這個 skill。'); return skill; }
}
module.exports = { SkillCatalog, parseSkill };
