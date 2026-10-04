'use strict';
/*
 * Restores the most recent settings.json backup, byte for byte.
 *
 *   node tools/unwire.js [--yes] [--list]
 *   node tools/unwire.js --telemetry   removes only the telemetry env keys we set
 *                                      (does NOT restore a backup)
 */

const path = require('node:path');
const readline = require('node:readline');
const wiring = require('../src/wiring.js');

const argv = process.argv.slice(2);
const YES = argv.includes('--yes') || argv.includes('-y');
const LIST = argv.includes('--list');
const TELEMETRY = argv.includes('--telemetry');

function ask(q) {
  if (YES) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(q + ' [y/N] ', (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
  });
}

async function main() {
  if (TELEMETRY) {
    const r = wiring.unwireTelemetry();
    if (!r.recorded) { console.log('No telemetry record in wired.json - removed nothing.'); return; }
    console.log(r.removed.length ? 'Removed: ' + r.removed.join(', ') : 'No telemetry keys left to remove.');
    if (r.kept.length) console.log('Kept (you changed them): ' + r.kept.join(', '));
    return;
  }
  const list = wiring.backups();

  if (LIST) {
    if (!list.length) { console.log('No backups in ' + path.dirname(wiring.settingsPath())); return; }
    for (const b of list) console.log(new Date(b.ts).toISOString() + '  ' + b.file);
    return;
  }

  if (!list.length) {
    console.error('No settings.json backup found in ' + path.dirname(wiring.settingsPath()));
    console.error('Nothing to restore. Remove the Sereno entries by hand if they are still there.');
    process.exit(1);
  }

  console.log('Restoring ' + wiring.settingsPath());
  console.log('     from ' + list[0].file + '  (' + new Date(list[0].ts).toLocaleString() + ')');
  if (!(await ask('Proceed?'))) { console.log('Aborted.'); return; }

  const r = wiring.unwire();
  console.log('Restored. Backup consumed.');
  if (r.remaining) console.log(r.remaining + ' older backup(s) remain; see --list.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
