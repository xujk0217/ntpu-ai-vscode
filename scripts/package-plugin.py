"""Portable stdio MCP bundle; contains no machine paths or broker capabilities."""
from pathlib import Path
import json, zipfile
root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text())['version']
source = root / 'plugins/ntpu-ai'
assert json.loads((source / 'plugin.json').read_text())['version'] == version
files = ['plugin.json', 'mcp.json', 'server.bundle.cjs', 'skills/ntpu-ai/SKILL.md']
assert (source / 'server.bundle.cjs').stat().st_size > 100000, 'Run npm run build first'
output = root / f'ntpu-ai-{version}.plugin.zip'
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files: archive.write(source / name, 'ntpu-ai/' + name)
print(output.name)
