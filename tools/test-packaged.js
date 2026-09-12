'use strict';
/*
 * Verifies a packaged build's shim the way Claude Code actually invokes it:
 * as a single command string through a shell, with the payload on stdin.
 *
 *   node tools/test-packaged.js [path-to-win-unpacked]
 *
 * This is the check that matters for distribution - it proves the shipped app
 * needs no Node on the machine, because the shim runs through Electron itself.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked');
const emitCmd = path.join(root, 'resources', 'emit.cmd');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { console.log('  ok   ' + name); pass++; }
  else { console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); fail++; }
}

function runShim(args, payload, env) {
  return new Promise((resolve) => {
    // Exactly the shape a hook command takes: one quoted string, via the shell.
    const command = `"${emitCmd}" ${args}`;
    const started = Date.now();
    const p = spawn(command, {
      shell: true,
      windowsHide: true,
      env: Object.assign({}, process.env, env || {}),
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
    p.stdin.end(payload);
  });
}

(async function () {
  console.log('\npackaged shim: ' + emitCmd);
  if (!fs.existsSync(emitCmd)) {
    console.log('  FAIL shim not found - run `npm run dist` first');
    process.exit(1);
  }

  // Port 9 (discard) guarantees nothing is listening: the worst case.
  const down = { CLAUDE_HUD_PORT: '9' };

  const sl = await runShim('statusline', JSON.stringify({
    model: { display_name: 'Opus 5' },
    cost: { total_cost_usd: 2.41 },
    context_window: { used_percentage: 34 },
    rate_limits: { five_hour: { used_percentage: 57.99999999999999 } },
  }), down);

  check('statusline exits 0', sl.code === 0, 'exit ' + sl.code);
  check('statusline prints exactly one line',
    sl.out.split('\n').filter((l) => l.trim().length).length === 1,
    JSON.stringify(sl.out));
  check('statusline renders the payload', /Opus 5/.test(sl.out), JSON.stringify(sl.out));
  // Only percentages must be whole; the dollar figure keeps its cents.
  check('statusline rounds percentages', !/\d+\.\d+\s*%/.test(sl.out), JSON.stringify(sl.out));
  check('the .cmd wrapper echoes nothing of its own',
    !/ELECTRON_RUN_AS_NODE|setlocal|emit\.js/i.test(sl.out), JSON.stringify(sl.out));
  check('statusline writes nothing to stderr', sl.err === '', JSON.stringify(sl.err));

  const hk = await runShim('hook PreToolUse', JSON.stringify({ session_id: 'pkg', cwd: 'C:\\w\\pkg' }), down);
  check('hook mode exits 0', hk.code === 0, 'exit ' + hk.code);
  check('hook mode is completely silent', hk.out === '' && hk.err === '',
    'out=' + JSON.stringify(hk.out) + ' err=' + JSON.stringify(hk.err));

  const bad = await runShim('statusline', 'not json at all {{{', down);
  check('malformed JSON still exits 0 with one line',
    bad.code === 0 && bad.out.split('\n').filter((l) => l.length).length === 1,
    'exit ' + bad.code + ' out=' + JSON.stringify(bad.out));

  console.log('  ---  cold-path latency with no collector: ' + hk.ms + 'ms');

  // The unpacked files an external process must be able to read.
  const ps1 = path.join(root, 'resources', 'app.asar.unpacked', 'src', 'focus-window.ps1');
  check('focus-window.ps1 is unpacked (powershell cannot read app.asar)', fs.existsSync(ps1), ps1);
  const js = path.join(root, 'resources', 'app.asar.unpacked', 'bin', 'emit.js');
  check('emit.js is unpacked', fs.existsSync(js), js);

  /* The end-to-end proof: the exact string written into settings.json must run. */
  const os = require('node:os');
  const wiring = require('../src/wiring.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-pkg-'));
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  fs.writeFileSync(path.join(tmp, 'settings.json'), '{\n  "theme": "dark-daltonized"\n}\n');

  try {
    const commands = wiring.buildCommands({ packaged: true, emitCmdPath: emitCmd });
    wiring.wire(commands, { replaceStatusLine: false });

    const written = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    check('wiring writes the packaged .cmd, not a node command',
      /emit\.cmd/i.test(written.statusLine.command) && !/^node /.test(written.statusLine.command),
      written.statusLine.command);
    check('unrelated settings survive wiring', written.theme === 'dark-daltonized');
    check('all nine hook events are wired', Object.keys(written.hooks).length === 9,
      Object.keys(written.hooks).join(','));

    // Run the literal command Claude Code would run.
    const literal = written.statusLine.command;
    const ran = await new Promise((resolve) => {
      const p = spawn(literal, {
        shell: true,
        windowsHide: true,
        env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9' }),
      });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out, err }));
      p.stdin.end(JSON.stringify({ model: { display_name: 'Opus 5' }, cost: { total_cost_usd: 1 } }));
    });
    check('the command string from settings.json actually executes',
      ran.code === 0 && /Opus 5/.test(ran.out), 'exit ' + ran.code + ' out=' + JSON.stringify(ran.out) + ' err=' + JSON.stringify(ran.err));

    // And uninstall must leave nothing behind pointing at a deleted exe.
    wiring.removeEntries();
    const after = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));
    check('uninstall removes every Sereno entry',
      !after.statusLine && !after.hooks, JSON.stringify(after));
    check('uninstall keeps unrelated settings', after.theme === 'dark-daltonized');
  } finally {
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
