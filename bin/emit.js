#!/usr/bin/env node
'use strict';
/*
 * The shim. Hooks and the statusline both invoke it, so it sits in the critical
 * path of every single tool call in every session on this machine.
 *
 * Its contract, in order of importance:
 *   1. exit 0 on every path, including collector-down, EPIPE and malformed JSON
 *   2. never block Claude Code  -> 250ms hard cap on the request, then abandon
 *   3. never write to stderr    -> it would surface in the user's terminal
 *   4. in statusline mode, print exactly one line no matter what went wrong
 *
 * Fire-and-forget: the response body is never read. The socket is unref'd so the
 * event loop can drain the moment stdin is consumed.
 */

const http = require('node:http');

const PORT = Number(process.env.CLAUDE_HUD_PORT) || 8787;
const MODE = process.argv[2] === 'statusline' ? 'statusline' : 'hook';
const EVENT = process.argv[3] || '';
const REQUEST_TIMEOUT_MS = 250;
const HARD_EXIT_MS = 1500;   // ceiling for the whole process, stdin included

let exited = false;
let printed = false;

function bail() {
  if (exited) return;
  exited = true;
  // Rule 4: in statusline mode exactly one line must reach stdout. If we are
  // leaving before the payload was read - stdin never closed, the hard timeout
  // fired - the line still has to be printed, or the user's statusline shows
  // nothing at all.
  if (MODE === 'statusline' && !printed) {
    printed = true;
    try { process.stdout.write(' \n'); } catch (_) {}
  }
  try { process.exit(0); } catch (_) {}
}

// Nothing below this line may take the process down with a non-zero code.
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);
process.stdout.on('error', () => {});   // statusline redraws can close stdout under us
process.stderr.on('error', () => {});

// Absolute ceiling. If stdin never closes, we still leave cleanly.
const hardExit = setTimeout(bail, HARD_EXIT_MS);
hardExit.unref();

/* ------------------------------------------------------------------ *
 * Statusline rendering
 *
 * We are replacing the user's statusline, so print something worth having.
 * Everything here is optional in the real payload (see docs/payloads.md),
 * hence the defensive reads.
 * ------------------------------------------------------------------ */
function renderStatusline(p) {
  const bits = [];
  const model = p && p.model && p.model.display_name;
  if (model) bits.push(model);

  const ctx = p && p.context_window;
  if (ctx && typeof ctx.used_percentage === 'number') bits.push(Math.round(ctx.used_percentage) + '% ctx');

  const cost = p && p.cost && p.cost.total_cost_usd;
  if (typeof cost === 'number') bits.push('$' + cost.toFixed(2) + ' est.');

  // Rate limit is the number that actually constrains a subscription plan.
  const rl = p && p.rate_limits;
  if (rl) {
    let worst = -1;
    for (const k of Object.keys(rl)) {
      const v = rl[k] && rl[k].used_percentage;
      if (typeof v === 'number' && v > worst) worst = v;
    }
    // Real payloads carry floats here (57.99999999999999), so always round.
    if (worst >= 0) bits.push(Math.round(worst) + '% limit');
  }
  return bits.join('  ·  ') || ' ';
}

function emitLine(text) {
  if (printed) return;
  printed = true;
  try { process.stdout.write(String(text).split('\n')[0] + '\n'); } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Cold start (opt-in)
 *
 * A refused connection on SessionStart means one specific thing: a session is
 * beginning and the collector is not running. If the user asked for it, that is
 * exactly when Sereno should start itself.
 *
 * Only SessionStart may do this. Any other event would turn a deliberate quit
 * into a spawn storm on the user's very next tool call.
 *
 * The paths and shapes here duplicate src/config.js on purpose: this shim runs
 * from the unpacked tree and must never reach into app.asar, and rule 2 says it
 * must not grow anything that can fail or stall on the hook path.
 * ------------------------------------------------------------------ */

const AUTO_LAUNCH_EVENT = 'SessionStart';
const LAUNCH_DEBOUNCE_MS = 20000;

function serenoHome() {
  if (process.env.SERENO_HOME) return process.env.SERENO_HOME;
  return require('node:path').join(require('node:os').homedir(), '.sereno');
}

function readConfig() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    return JSON.parse(fs.readFileSync(path.join(serenoHome(), 'config.json'), 'utf8'));
  } catch (_) { return null; }
}

/**
 * One launch per window. A reboot or a restored terminal can start several
 * sessions at once, and each would otherwise spawn its own Electron; the app's
 * single-instance lock makes the extras harmless but not free.
 */
function claimLaunch(fs, path, home) {
  const lock = path.join(home, 'launching');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs < LAUNCH_DEBOUNCE_MS) return false;
  } catch (_) { /* no marker yet, so the slot is ours */ }
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(lock, String(Date.now()));
    return true;
  } catch (_) { return false; }
}

/**
 * Hands the triggering event to the app, which drains it on boot. Electron takes
 * seconds to come up and rule 2 forbids waiting for it, so without this the
 * widget would appear empty and stay empty until the next tool call - the
 * opposite of what starting on a session start is for.
 *
 * Written under a dot-name and renamed into place: rename is atomic, so the app
 * can never read a half-written file.
 */
function queuePending(fs, path, home, payload) {
  try {
    const dir = path.join(home, 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const name = Date.now() + '-' + process.pid + '.json';
    const tmp = path.join(dir, '.' + name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify({
      event: EVENT,
      receivedAt: Date.now(),
      ppid: Number(process.env.CLAUDE_PID) || null,
      payload,
    }));
    fs.renameSync(tmp, path.join(dir, name));
  } catch (_) { /* a lost replay is never worth failing a hook over */ }
}

function autoLaunch(payload) {
  if (MODE !== 'hook' || EVENT !== AUTO_LAUNCH_EVENT) return;

  const cfg = readConfig();
  if (!cfg || cfg.autoLaunch !== true) return;
  const spec = cfg.launch;
  if (!spec || typeof spec.exe !== 'string' || !spec.exe) return;

  const fs = require('node:fs');
  const path = require('node:path');
  const home = serenoHome();
  if (!claimLaunch(fs, path, home)) return;
  queuePending(fs, path, home, payload);

  try {
    const env = Object.assign({}, process.env);
    // emit.cmd sets this so Electron runs as Node. A child inheriting it would
    // come up as a bare Node process with no window at all.
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawn(
      spec.exe,
      Array.isArray(spec.args) ? spec.args : [],
      { detached: true, stdio: 'ignore', windowsHide: true, env },
    );
    child.on('error', () => {});   // a stale exe path must not reach stderr
    child.unref();                 // outlives this process, which exits in ms
  } catch (_) {}
}

/* ------------------------------------------------------------------ */

function post(payload) {
  let body;
  try {
    body = JSON.stringify({
      mode: MODE,
      event: EVENT,
      receivedAt: Date.now(),
      // Claude Code exports its own pid to hooks. process.ppid is NOT it: hooks
      // run through a transient shell that has already exited by the time the
      // widget could use it. Nothing in the payload identifies the process, and
      // the widget needs it to focus a session's terminal.
      ppid: Number(process.env.CLAUDE_PID) || null,
      payload,
    });
  } catch (_) { return bail(); }

  let req;
  try {
    req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: MODE === 'statusline' ? '/status' : '/hook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
  } catch (_) { return bail(); }

  // Collector down, firewalled, mid-restart: all of it is fine, all of it is silent.
  // ECONNREFUSED is the one case worth acting on - nothing is listening, so the
  // app is not merely busy, it is absent. A timeout or a reset means it IS there
  // and struggling, and a second process would not help.
  req.on('error', (err) => {
    if (err && err.code === 'ECONNREFUSED') { try { autoLaunch(payload); } catch (_) {} }
    bail();
  });
  req.setTimeout(REQUEST_TIMEOUT_MS, () => { try { req.destroy(); } catch (_) {} bail(); });
  req.on('response', (res) => { res.resume(); bail(); });  // drain, never parse

  try {
    req.end(body);
    // Let the event loop exit without waiting on the response.
    if (req.socket && req.socket.unref) req.socket.unref();
    else req.on('socket', (s) => s.unref && s.unref());
  } catch (_) { return bail(); }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { if (MODE === 'statusline') emitLine(' '); bail(); });
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let payload = null;
  try { payload = JSON.parse(raw); } catch (_) { payload = null; }

  // Print before doing anything that could fail: the statusline must always render.
  if (MODE === 'statusline') {
    let line = ' ';
    try { line = payload ? renderStatusline(payload) : ' '; } catch (_) {}
    emitLine(line);
  }

  if (payload) post(payload);
  else bail();
});
