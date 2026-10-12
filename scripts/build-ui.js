'use strict';
require('esbuild').buildSync({ entryPoints: ['media/agent-ui.js'], bundle: true, minify: true,
  platform: 'browser', target: ['chrome120'], outfile: 'media/chat.bundle.js', logLevel: 'info' });
