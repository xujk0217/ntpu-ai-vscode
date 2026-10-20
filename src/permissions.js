'use strict';

const READ_TOOLS = new Set(['list_files', 'read_file', 'search_text', 'search_history', 'read_history', 'load_skill', 'get_capabilities', 'search_tools', 'describe_tool', 'refresh_skills', 'update_plan', 'ask_user']);
const EDIT_TOOLS = new Set(['expand_mcp', 'computer_open', 'computer_observe', 'computer_action', 'computer_close', 'write_file', 'edit_file', 'create_visual', 'create_chart', 'create_diagram', 'download_file', 'install_skill', 'connect_mcp', 'add_mcp', 'open_browser']);
const READ_ONLY_AGENTS = new Set(['plan', 'review', 'research', 'ask']);
const MODES = ['ask', 'assisted', 'full'];

const { safeCommand, commandApproval } = require('./terminal-policy');

class PermissionPolicy {
  constructor({ mode = 'ask', agent = 'build', terminal = {} } = {}) {
    this.mode = MODES.includes(mode) ? mode : 'ask';
    this.agent = agent;
    this.terminal = terminal;
    this.grants = new Set();
  }
  decision(name, args = {}, metadata = {}) {
    const readonly = READ_ONLY_AGENTS.has(this.agent);
    if (readonly && (EDIT_TOOLS.has(name) || (name === 'run_command' && !safeCommand(args.command)) ||
      (metadata.external && !metadata.readOnly))) return 'deny';
    if (READ_TOOLS.has(name)) return 'allow';
    if (name === 'run_command') {
      const approval = commandApproval(args.command, this.terminal);
      if (approval.explicit) return 'ask';
      if (approval.decision === 'allow') return 'allow';
    }
    if (this.grants.has(name)) return 'allow';
    if (this.mode === 'full') return 'allow';
    if (this.mode === 'assisted' && ((EDIT_TOOLS.has(name) && name !== 'open_browser') || name === 'web_search' || name === 'web_fetch' ||
      name === 'inspect_image' || (name === 'run_command' && safeCommand(args.command)))) return 'allow';
    return 'ask';
  }
  grant(name) { this.grants.add(name); }
  commandExplanation(command) { return commandApproval(command, this.terminal); }
}

module.exports = { PermissionPolicy, MODES, safeCommand, READ_ONLY_AGENTS, EDIT_TOOLS };
