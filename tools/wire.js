'use strict';
/*
 * Installs Sereno into Claude Code's settings.json (development checkout).
 *
 * Packaged builds do this from inside the app instead - see src/wiring.js, which
 * holds the logic both paths share.
 *
 *   node tools/wire.js [--yes] [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const wiring = require('../src/wiring.js');

const argv = process.argv.slice(2);
const YES = argv.includes('--yes') || argv.includes('-y');
const DRY = argv.includes('--dry-run');

const emitJs = path.resolve(__dirname, '..', 'bin', 'emit.js');

function ask(question) {
  if (YES) return Promise.resolve(true);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question + ' [y/N] ', (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
  });
}

async function main() {
  if (!fs.existsSync(wiring.configDir())) {
    console.error('Claude Code config dir not found: ' + wiring.configDir());
    console.error('Set CLAUDE_CONFIG_DIR, or run Claude Code once to create it.');
    process.exit(1);
  }
  if (!fs.existsSync(emitJs)) {
    console.error('bin/emit.js not found at ' + emitJs);
    process.exit(1);
  }

  const commands = wiring.buildCommands({ packaged: false, emitJsPath: emitJs });

  // Ask before displacing someone else's statusLine.
  let replaceStatusLine = false;
  const st = wiring.status();
  if (st.foreignStatusLine) {
    console.log('\nA statusLine is already configured:\n  ' + JSON.stringify(st.foreignStatusLine) + '\n');
    replaceStatusLine = await ask('Replace it with the Sereno statusline?');
    if (!replaceStatusLine) {
      console.log('Keeping yours - Sereno will have no cost, model or context data.');
    }
  }

  let result;
  try {
    result = wiring.wire(commands, { replaceStatusLine, dryRun: DRY });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (!result.changes.length) {
    console.log('\nNothing to do - Sereno is already wired in ' + wiring.settingsPath());
    return;
  }

  if (DRY) {
    console.log('\n--dry-run, nothing written. Would change:');
    for (const c of result.changes) console.log('  - ' + c);
    return;
  }

  console.log('\nWired Sereno.');
  console.log('  config : ' + wiring.settingsPath());
  if (result.backup) console.log('  backup : ' + result.backup);
  console.log('  shim   : ' + emitJs);
  console.log('\nChanges:');
  for (const c of result.changes) console.log('  - ' + c);
  console.log('\nRestart any running Claude Code session to pick this up.');
  console.log('Undo with: npm run unwire');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
