'use strict';
/*
 * The collector without Electron. Same routes, same page - open the URL in a
 * browser tab. This is the fallback the spec asks for and the debugging surface.
 *
 *   node tools/serve.js [port]
 */

const { Store } = require('../src/store.js');
const { createCollector } = require('../src/collector.js');
const config = require('../src/config.js');
const { startLedger } = require('../src/ledger-life.js');
const projectsLib = require('../src/projects.js');
const reposLib = require('../src/repos.js');

const port = Number(process.argv[2]) || Number(process.env.CLAUDE_HUD_PORT) || 8787;

const store = new Store();
store.onBlocked = (s) => console.log('[blocked] ' + s.projectName + ': ' + [s.stateTool, s.stateArg].filter(Boolean).join(' \u00b7 '));

const { ledger } = startLedger(config.read(), {
  log: (m) => console.log('sereno ' + m),
  error: (m) => console.error('sereno ' + m),
});
const registry = projectsLib.createRegistry();
const poller = reposLib.createPoller({ registry });
process.on('exit', () => { try { poller.stop(); } catch (_) {} try { if (ledger) ledger.close(); } catch (_) {} });
process.on('SIGINT', () => process.exit(0));

const collector = createCollector(store, port, { ledger, projects: registry, repos: poller });   // no onReview: serve has no terminal to raise
collector.listen((err, addr) => {
  if (err) { console.error('cannot listen on ' + port + ': ' + err.code); process.exit(1); }
  console.log('sereno collector -> http://127.0.0.1:' + addr.port + '/');
  poller.start();
});

setInterval(() => { store.sweep(); collector.broadcast(); }, 30000).unref();
