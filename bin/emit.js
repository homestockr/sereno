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
function bail() {
  if (exited) return;
  exited = true;
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
  try { process.stdout.write(String(text).split('\n')[0] + '\n'); } catch (_) {}
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
  req.on('error', bail);
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
