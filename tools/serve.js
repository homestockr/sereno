'use strict';
/*
 * The collector without Electron. Same routes, same page - open the URL in a
 * browser tab. This is the fallback the spec asks for and the debugging surface.
 *
 *   node tools/serve.js [port]
 */

const { Store } = require('../src/store.js');
const { createCollector } = require('../src/collector.js');

const port = Number(process.argv[2]) || Number(process.env.CLAUDE_HUD_PORT) || 8787;

const store = new Store();
store.onBlocked = (s) => console.log('[blocked] ' + s.projectName + ': ' + [s.stateTool, s.stateArg].filter(Boolean).join(' \u00b7 '));

const collector = createCollector(store, port);
collector.listen((err, addr) => {
  if (err) { console.error('cannot listen on ' + port + ': ' + err.code); process.exit(1); }
  console.log('sereno collector -> http://127.0.0.1:' + addr.port + '/');
});

setInterval(() => { store.sweep(); collector.broadcast(); }, 30000).unref();
