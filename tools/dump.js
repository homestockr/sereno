#!/usr/bin/env node
'use strict';
/*
 * Phase 0 discovery probe.
 *
 * Reads a hook / statusline payload on stdin and appends it verbatim to
 * ./samples/<slug>.jsonl. Its only contract with Claude Code is the one that
 * matters for every shim in this project: exit 0 no matter what, and print
 * exactly one line so it is safe as a statusLine command.
 */

const fs = require('fs');
const path = require('path');

const SAMPLES = path.join(__dirname, '..', 'samples');

// argv[2..] is how the probe was invoked: ["statusline"] or ["hook","PreToolUse"].
const args = process.argv.slice(2);
const slug = (args.join('-') || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);

let done = false;
function finish() {
  if (done) return;
  done = true;
  // One space: renders as a blank statusline, harmless in hook mode.
  try { process.stdout.write(' \n'); } catch (_) {}
  process.exit(0);
}

// Nothing below may take the process down.
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);
// A closed stdout (statusline redraw races) must not raise EPIPE.
process.stdout.on('error', () => {});

// Hard ceiling: never hold up a tool call, even if stdin never closes.
setTimeout(finish, 2000).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', finish);
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    let payload;
    try { payload = JSON.parse(raw); } catch (_) { payload = { __unparsed: raw }; }
    fs.mkdirSync(SAMPLES, { recursive: true });
    const record = { ts: Date.now(), iso: new Date().toISOString(), argv: args, payload };
    fs.appendFileSync(path.join(SAMPLES, slug + '.jsonl'), JSON.stringify(record) + '\n');
  } catch (_) {
    // Discovery data is expendable; the session is not.
  }
  finish();
});
