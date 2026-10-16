'use strict';
require('esbuild').buildSync({ entryPoints: ['media/agent-ui.js'], bundle: true, minify: true,
  platform: 'browser', target: ['chrome120'], outfile: 'media/chat.bundle.js', logLevel: 'info' });

require('esbuild').buildSync({ entryPoints: ['src/plugin/server.js'], bundle: true, minify: true, platform: 'node', target: ['node20.9'], outfile: 'plugins/ntpu-ai/server.bundle.cjs', logLevel: 'info' });
