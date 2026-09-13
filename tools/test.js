'use strict';
/*
 * Acceptance tests that can run without a GUI. The numbered ones map to the
 * criteria in the build spec; the rest guard the findings from Phase 0.
 *
 *   node tools/test.js
 */

const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Store } = require('../src/store.js');
const { createCollector } = require('../src/collector.js');
const wiring = require('../src/wiring.js');

const ROOT = path.join(__dirname, '..');
const EMIT = path.join(ROOT, 'bin', 'emit.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
async function atest(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const H = (event, payload) => ({ event, payload });
function feed(store, list) {
  for (const { event, payload } of list) store.applyHook(event, payload);
}
const sid = (id, extra) => Object.assign({ session_id: id, cwd: 'C:\\work\\' + id }, extra || {});

/* ============================================================ *
 * 1. The shim must never break Claude Code (collector down)
 * ============================================================ */
console.log('\n[1] shim safety with no collector listening');

function runEmit(args, input) {
  // Port 9 is the discard port: guaranteed nothing is listening.
  const r = spawnSync(process.execPath, [EMIT].concat(args), {
    input,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9' }),
    timeout: 10000,
  });
  return r;
}

test('hook mode exits 0 and writes nothing at all', () => {
  const r = runEmit(['hook', 'PreToolUse'], JSON.stringify({ session_id: 'a' }));
  assert.strictEqual(r.status, 0, 'exit code ' + r.status);
  assert.strictEqual(r.stdout, '', 'stdout was ' + JSON.stringify(r.stdout));
  assert.strictEqual(r.stderr, '', 'stderr was ' + JSON.stringify(r.stderr));
});

test('statusline mode prints exactly one line', () => {
  const r = runEmit(['statusline'], JSON.stringify({
    model: { display_name: 'Opus 5' }, cost: { total_cost_usd: 1.5 },
  }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout.split('\n').filter(Boolean).length, 1, 'got ' + JSON.stringify(r.stdout));
  assert.match(r.stdout, /Opus 5/);
});

test('malformed JSON still yields one line and exit 0', () => {
  const r = runEmit(['statusline'], 'this is not json {{{');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout.split('\n').filter((l) => l.length).length, 1);
});

test('empty stdin exits 0 silently', () => {
  const r = runEmit(['hook', 'Stop'], '');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
});

/* ============================================================ *
 * 2. Two concurrent sessions stay independent
 * ============================================================ */
console.log('\n[2] independent sessions');

test('two sessions keep separate state and cost', () => {
  const s = new Store();
  feed(s, [
    H('SessionStart', sid('alpha')),
    H('SessionStart', sid('beta')),
    H('PreToolUse', sid('alpha', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' })),
  ]);
  s.applyStatus(sid('alpha', { cost: { total_cost_usd: 1.88 }, context_window: { used_percentage: 34 } }));
  s.applyStatus(sid('beta', { cost: { total_cost_usd: 0.53 }, context_window: { used_percentage: 12 } }));

  const snap = s.snapshot();
  const a = snap.sessions.find((x) => x.id === 'alpha');
  const b = snap.sessions.find((x) => x.id === 'beta');
  assert.strictEqual(a.state, 'running');
  assert.strictEqual(b.state, 'idle');
  assert.strictEqual(a.costUsd, 1.88);
  assert.strictEqual(b.costUsd, 0.53);
  assert.strictEqual(a.projectName, 'alpha');
  assert.ok(Math.abs(snap.totalCost - 2.41) < 1e-9, 'total ' + snap.totalCost);
});

/* ============================================================ *
 * 3. blocked: sticky, derived detail, toast exactly once
 * ============================================================ */
console.log('\n[3] blocked detection');

test('blocked names the tool, which Notification does not carry', () => {
  const s = new Store();
  feed(s, [
    H('SessionStart', sid('x')),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { message: 'Claude needs your permission', notification_type: 'permission_prompt' })),
  ]);
  const g = s.sessions.get('x');
  assert.strictEqual(g.state, 'blocked');
  assert.strictEqual(g.stateTool, 'Bash');
  assert.strictEqual(g.stateArg, 'rm -rf ./dist');
});

test('a statusline refresh does NOT clear blocked', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
  ]);
  s.applyStatus(sid('x', { cost: { total_cost_usd: 9 }, context_window: { used_percentage: 50 } }));
  assert.strictEqual(s.sessions.get('x').state, 'blocked');
  assert.strictEqual(s.sessions.get('x').costUsd, 9, 'cost should still update while blocked');
});

test('blocked clears only on the next real tool event', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
  ]);
  assert.strictEqual(s.sessions.get('x').state, 'blocked');
  feed(s, [H('PostToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 't1' }))]);
  assert.strictEqual(s.sessions.get('x').state, 'thinking');
});

test('the blocked timer anchor does not drift while blocked', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
  ]);
  const since = s.sessions.get('x').stateSince;
  s.applyStatus(sid('x', { cost: { total_cost_usd: 1 } }));
  feed(s, [H('Notification', sid('x', { notification_type: 'permission_prompt' }))]);
  assert.strictEqual(s.sessions.get('x').stateSince, since, 'stateSince was reset, timer would jump back');
});

test('toast fires once per episode, not per Notification', () => {
  const s = new Store();
  const fired = [];
  s.onBlocked = (x) => fired.push(x);
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
  ]);
  assert.strictEqual(fired.length, 1, 'fired ' + fired.length + ' times');
  // ...and again after it clears and re-blocks.
  feed(s, [
    H('PostToolUse', sid('x', { tool_use_id: 't1' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_use_id: 't2' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
  ]);
  assert.strictEqual(fired.length, 2);
});

test('a non-permission notification must NOT turn the row red', () => {
  const s = new Store();
  feed(s, [
    H('SessionStart', sid('x')),
    H('Notification', sid('x', { notification_type: 'idle_timeout', message: 'Claude is waiting for your input' })),
  ]);
  assert.strictEqual(s.sessions.get('x').state, 'idle', 'idle notification falsely blocked the row');
});

test('an unknown notification with no type falls back to text matching', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { message: 'Claude needs your permission to continue' })),
  ]);
  assert.strictEqual(s.sessions.get('x').state, 'blocked');
});

/* ============================================================ *
 * Phase 0 findings: subagents share the parent session_id
 * ============================================================ */
console.log('\n[*] subagent isolation (docs/payloads.md §4)');

test('a subagent tool call does not overwrite the parent row', () => {
  const s = new Store();
  feed(s, [
    H('UserPromptSubmit', sid('x', { prompt: 'go' })),
    H('PreToolUse', sid('x', { tool_name: 'Agent', tool_input: { description: 'explore' }, tool_use_id: 't1' })),
    H('PostToolUse', sid('x', { tool_use_id: 't1' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'grep -r x' }, tool_use_id: 't2', agent_id: 'ag1', agent_type: 'Explore' })),
  ]);
  const g = s.sessions.get('x');
  assert.strictEqual(g.state, 'thinking', 'parent state was clobbered to ' + g.state);
  assert.strictEqual(g.subagents, 1);
});

test('a subagent PostToolUse does not clear a blocked parent', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 't1' })),
    H('Notification', sid('x', { notification_type: 'permission_prompt' })),
    H('PostToolUse', sid('x', { tool_name: 'Grep', tool_use_id: 't9', agent_id: 'ag1' })),
  ]);
  assert.strictEqual(s.sessions.get('x').state, 'blocked', 'subagent activity cleared the alert');
});

test('subagent count is self-healing (no SubagentStart exists)', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'a', agent_id: 'ag1' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'b', agent_id: 'ag2' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c', agent_id: 'ag1' })),
  ]);
  assert.strictEqual(s.sessions.get('x').subagents, 2, 'duplicate agent double-counted');
  feed(s, [H('SubagentStop', sid('x', { agent_id: 'ag1' }))]);
  assert.strictEqual(s.sessions.get('x').subagents, 1);
  feed(s, [H('SubagentStop', sid('x', { agent_id: 'ag2' }))]);
  assert.strictEqual(s.sessions.get('x').subagents, 0);
});

/* ============================================================ *
 * Eviction
 * ============================================================ */
console.log('\n[*] eviction');

test('SessionEnd removes immediately', () => {
  const s = new Store();
  feed(s, [H('SessionStart', sid('x')), H('SessionEnd', sid('x', { reason: 'other' }))]);
  assert.strictEqual(s.sessions.size, 0);
});

test('stale after 5 min, dropped after 30', () => {
  const s = new Store();
  feed(s, [H('SessionStart', sid('x'))]);
  s.sessions.get('x').lastSeen = Date.now() - 6 * 60 * 1000;
  assert.strictEqual(s.snapshot().sessions[0].stale, true);
  assert.strictEqual(s.sweep(), false, 'dropped too early');

  s.sessions.get('x').lastSeen = Date.now() - 31 * 60 * 1000;
  assert.strictEqual(s.sweep(), true);
  assert.strictEqual(s.sessions.size, 0);
});

test('blocked sorts to the top, stale sinks', () => {
  const s = new Store();
  feed(s, [H('SessionStart', sid('quiet')), H('SessionStart', sid('loud'))]);
  feed(s, [
    H('PreToolUse', sid('loud', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't' })),
    H('Notification', sid('loud', { notification_type: 'permission_prompt' })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].id, 'loud');
});

/* ============================================================ *
 * Header numbers
 * ============================================================ */
console.log('\n[*] header aggregation');

test('worst rate limit across sessions wins, with its reset time', () => {
  const s = new Store();
  s.applyStatus(sid('a', { rate_limits: { five_hour: { used_percentage: 52, resets_at: 111 }, seven_day: { used_percentage: 44, resets_at: 222 } } }));
  s.applyStatus(sid('b', { rate_limits: { five_hour: { used_percentage: 71, resets_at: 333 } } }));
  const snap = s.snapshot();
  assert.strictEqual(snap.windows.five_hour.usedPct, 71);
  assert.strictEqual(snap.windows.five_hour.resetsAt, 333);
  assert.strictEqual(snap.windows.seven_day.usedPct, 44, 'the 7-day window must survive separately');
});

test('every rate-limit window survives separately, not collapsed to the worst', () => {
  // The footer shows one meter per window. Collapsing them to max() hid the one
  // you were not about to hit, which is the one worth seeing before starting
  // something long.
  const s = new Store();
  s.applyStatus(sid('a', {
    rate_limits: {
      five_hour: { used_percentage: 8, resets_at: 1789330800 },
      seven_day: { used_percentage: 55.00000000000001, resets_at: 1789462800 },
    },
  }));
  const w = s.snapshot().windows;
  assert.deepStrictEqual(Object.keys(w).sort(), ['five_hour', 'seven_day']);
  assert.strictEqual(w.five_hour.usedPct, 8);
  assert.strictEqual(w.seven_day.usedPct, 55, 'the float must be rounded, not rendered raw');
  assert.strictEqual(w.five_hour.resetsAt, 1789330800);
  assert.strictEqual(w.seven_day.resetsAt, 1789462800, 'each window keeps its own reset time');
});

test('the footer orders windows for reading, and names only what it knows', () => {
  // Payload key order is not guaranteed, and an unrecognised window must still
  // appear rather than vanish - including any per-model figure that may show up
  // one day, which today's payload does not carry.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(/WINDOW_ORDER\s*=\s*\['five_hour',\s*'seven_day'\]/.test(app),
    'session before weekly, regardless of payload order');
  assert.ok(/five_hour:\s*'5-hour session'/.test(app) && /seven_day:\s*'7-day weekly'/.test(app),
    'both windows must be labelled in the user\'s terms');
  // orderedWindows appends unknown keys rather than dropping them.
  const m = app.match(/function orderedWindows[\s\S]*?\n}/);
  assert.ok(m && /rest/.test(m[0]) && /concat\(rest\)/.test(m[0]),
    'an unrecognised window must still be rendered, after the known ones');
});

test('a reset more than a day out is counted in days', () => {
  // untilReset only ever had to describe a 5-hour window. With the 7-day window
  // on screen it would otherwise count down from "Resets in 167h 59m".
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const src = app.match(/function untilReset[\s\S]*?\n}/)[0];
  // eslint-disable-next-line no-new-func
  const untilReset = new Function('return ' + src)();

  const now = Math.floor(Date.now() / 1000);
  assert.match(untilReset(now + 45 * 60), /^Resets in 45m$/);
  assert.match(untilReset(now + 2 * 3600 + 13 * 60), /^Resets in 2h 13m$/);
  assert.match(untilReset(now + 3 * 86400), /^Resets in (2d 23h|3d 0h)$/);
  assert.match(untilReset(now + 7 * 86400 - 60), /^Resets in 6d 23h$/);
  assert.strictEqual(untilReset(now - 5), 'Resetting now');
  assert.strictEqual(untilReset(null), '');
});

test('float percentages are rounded, never rendered raw', () => {
  // Live payloads carry 57.99999999999999, which rendered verbatim in the header
  // and in the user's own statusline until this was fixed.
  const s = new Store();
  s.applyStatus(sid('a', {
    context_window: { used_percentage: 18.4, current_usage: {} },
    rate_limits: { five_hour: { used_percentage: 57.99999999999999, resets_at: 1 } },
  }));
  const snap = s.snapshot();
  assert.strictEqual(snap.windows.five_hour.usedPct, 58, 'got ' + snap.windows.five_hour.usedPct);
  assert.strictEqual(snap.sessions[0].contextPct, 18);
  assert.ok(!/\./.test(String(snap.windows.five_hour.usedPct)), 'a fraction would reach the UI');
});

test('the statusline shim renders whole percentages', () => {
  const r = spawnSync(process.execPath, [EMIT, 'statusline'], {
    input: JSON.stringify({
      model: { display_name: 'Opus 5' },
      context_window: { used_percentage: 18.4 },
      rate_limits: { five_hour: { used_percentage: 57.99999999999999 } },
    }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9' }),
    timeout: 10000,
  });
  assert.ok(!/\d+\.\d/.test(r.stdout), 'fractional percent in statusline: ' + r.stdout.trim());
  assert.match(r.stdout, /58% limit/);
  assert.match(r.stdout, /18% ctx/);
});

test('counts drive the headline: active vs quiet vs blocked', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('busy', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' })),
    H('UserPromptSubmit', sid('mulling', { prompt: 'go' })),
    H('SessionStart', sid('resting')),
  ]);
  let c = s.snapshot().counts;
  assert.strictEqual(c.active, 2, 'running + thinking are active');
  assert.strictEqual(c.quiet, 1);
  assert.strictEqual(c.blocked, 0);

  feed(s, [H('Notification', sid('busy', { notification_type: 'permission_prompt' }))]);
  c = s.snapshot().counts;
  assert.strictEqual(c.blocked, 1);
  assert.strictEqual(c.active, 1, 'a blocked session is no longer counted active');
});

test('a stale session is not counted active, whatever it was doing', () => {
  const s = new Store();
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'sleep' }, tool_use_id: 't1' }))]);
  assert.strictEqual(s.snapshot().counts.active, 1);
  s.sessions.get('x').lastSeen = Date.now() - 6 * 60 * 1000;
  const snap = s.snapshot();
  assert.strictEqual(snap.sessions[0].stale, true);
  assert.strictEqual(snap.counts.active, 0, 'a stale row must not read as active');
  assert.ok(snap.sessions[0].staleForMs > 5 * 60 * 1000);
});

test('the session pid comes from CLAUDE_PID, not the transient shell', () => {
  // process.ppid is a shell that has already exited; only CLAUDE_PID survives.
  const r = spawnSync(process.execPath, [EMIT, 'hook', 'PreToolUse'], {
    input: JSON.stringify({ session_id: 'p', cwd: 'C:\\w\\p' }),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9', CLAUDE_PID: '4242' }),
    timeout: 10000,
  });
  assert.strictEqual(r.status, 0);
  const src = fs.readFileSync(EMIT, 'utf8');
  assert.ok(/process\.env\.CLAUDE_PID/.test(src), 'emit.js must read CLAUDE_PID');
  assert.ok(!/ppid:\s*process\.ppid/.test(src), 'emit.js must not report process.ppid as the session pid');
});

test('a denied tool cannot leak pending entries forever', () => {
  // Denied tools never produce a PostToolUse, so the map only ever grew.
  const s = new Store();
  for (let i = 0; i < 100; i++) {
    feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'c' + i }, tool_use_id: 't' + i }))]);
  }
  assert.ok(s.sessions.get('x')._pending.size <= 32, 'pending grew to ' + s.sessions.get('x')._pending.size);
  feed(s, [H('Stop', sid('x'))]);
  assert.strictEqual(s.sessions.get('x')._pending.size, 0, 'Stop must clear pending tools');
});

test('subagents cannot outlive the turn', () => {
  // A missed SubagentStop used to leave the row claiming agents were running.
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'a', agent_id: 'ag1' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'b', agent_id: 'ag2' })),
  ]);
  assert.strictEqual(s.sessions.get('x').subagents, 2);
  feed(s, [H('Stop', sid('x'))]);          // no SubagentStop ever arrived
  assert.strictEqual(s.sessions.get('x').subagents, 0, 'phantom subagents survived Stop');
});

test('statusline prints a line even if stdin never closes', () => {
  // Rule 4 of the shim: exactly one line, always. The hard-timeout path used to
  // exit silently, leaving the user with a blank statusline.
  const r = spawnSync(process.execPath, ['-e',
    'const {spawn}=require("child_process");' +
    'const p=spawn(process.execPath,[' + JSON.stringify(EMIT) + ',"statusline"],' +
    '{env:Object.assign({},process.env,{CLAUDE_HUD_PORT:"9"})});' +
    'let o="";p.stdout.on("data",d=>o+=d);' +
    'p.on("close",c=>console.log(JSON.stringify({c,o})));'
  ], { encoding: 'utf8', timeout: 20000 });
  const last = (r.stdout || '').trim().split('\n').pop();
  const got = JSON.parse(last);
  assert.strictEqual(got.c, 0, 'exit code ' + got.c);
  assert.strictEqual(got.o.split('\n').filter((l) => l.length).length, 1,
    'expected exactly one line, got ' + JSON.stringify(got.o));
});

test('uninstall never removes another tool\'s hooks', () => {
  // isOurs() once matched any command mentioning emit.js, so uninstalling
  // Sereno deleted unrelated tools' entries and wiring hijacked them.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-ident-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const foreign = {
      statusLine: { type: 'command', command: 'node "C:/other-tool/emit.js" statusline' },
      hooks: { PreToolUse: [{ matcher: '*', hooks: [
        { type: 'command', command: 'node "C:/some/vendor/emit.js" hook PreToolUse' },
      ] }] },
    };
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(foreign, null, 2));

    const r = wiring.removeEntries(['C:/sereno/bin/emit.js']);
    const after = JSON.parse(fs.readFileSync(path.join(tmp, 'settings.json'), 'utf8'));

    assert.ok(after.statusLine, 'deleted an unrelated statusLine');
    assert.strictEqual(after.hooks.PreToolUse.length, 1, 'deleted an unrelated hook');
    assert.strictEqual(r.changed, false);
    assert.ok(r.skipped.length >= 2, 'unrecognised shim entries should be reported, not deleted');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the window is resized with setBounds, never setSize', () => {
  // On Windows a transparent window grows via setSize but silently refuses to
  // shrink, which left the widget stuck at its widest after zooming out.
  // This is runtime behaviour no unit test can exercise, so guard the source.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(/win\.setBounds\(\{\s*width/.test(main), 'applySize must use setBounds');
  assert.ok(!/win\.setSize\(/.test(main),
    'win.setSize cannot shrink a transparent window on Windows - use setBounds');
});

test('focus picks a window by title, not the process-wide MainWindowHandle', () => {
  // Windows Terminal hosts every window it has opened in ONE process, so
  // .MainWindowHandle returns the same arbitrary handle for every session and
  // "Review in terminal" raised whichever window happened to be it. Real
  // window resolution needs a live desktop, so guard the source instead.
  const ps = fs.readFileSync(path.join(ROOT, 'src', 'focus-window.ps1'), 'utf8');

  // Comments are stripped first: the file explains at length why MainWindowHandle
  // is wrong, and that prose must not trip the check that we stopped calling it.
  const code = ps.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');

  assert.ok(/EnumWindows/.test(code), 'must enumerate the terminal\'s windows itself');
  assert.ok(/ConsoleTitleOf/.test(code), 'must read the target console title to disambiguate');
  assert.ok(!/MainWindowHandle/.test(code),
    'MainWindowHandle is process-wide and cannot distinguish two terminal windows');

  // The console probe detaches the caller's own console, so it must stay behind
  // the ambiguity check: with a single window there is nothing to resolve.
  const single = code.indexOf('$windows.Count -eq 1');
  const probe = code.indexOf('ConsoleTitleOf([uint32]$TargetPid)');
  assert.ok(single > -1 && probe > -1 && single < probe,
    'the single-window fast path must come before the console probe');
});

test('window titles compare without their spinner glyph', () => {
  // Claude Code prefixes the title with a spinner that differs between two
  // reads of the same window, so a literal comparison never matches.
  const ps = fs.readFileSync(path.join(ROOT, 'src', 'focus-window.ps1'), 'utf8');
  const m = ps.match(/\$t = \$s -replace '([^']+)', ''/);
  assert.ok(m, 'Normalize must strip a leading non-word run');

  // Exercise the regex itself through JS, which shares the \p{L}\p{N} syntax.
  const strip = new RegExp(m[1].replace(/^\^/, '^'), 'u');
  const norm = (s) => s.replace(strip, '').trim().toLowerCase();
  assert.strictEqual(norm('◐ Installer and taskbar pinning'), 'installer and taskbar pinning');
  assert.strictEqual(norm('◑ Installer and taskbar pinning'), 'installer and taskbar pinning');
  assert.strictEqual(norm('◐ Installer and taskbar pinning'), norm('◑ Installer and taskbar pinning'),
    'two spinner frames of one title must compare equal');
  // A title that is already clean must survive untouched.
  assert.strictEqual(norm('Take the whole list'), 'take the whole list');
});

test('a long tool argument is shortened for the row but kept whole for the command block', () => {
  const s = new Store();
  const long = 'npm run build -- --verbose --output ./dist/some/deeply/nested/path/bundle.js';
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: long }, tool_use_id: 't1' }))]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.stateArg, long, 'the full command must survive for the alert block');
  assert.ok(g.stateArgShort.length <= 44, 'row text too long: ' + g.stateArgShort.length);
  assert.ok(g.stateArgShort.endsWith('…'));
});

test('missing rate_limits degrades instead of throwing', () => {
  const s = new Store();
  s.applyStatus(sid('a', { cost: { total_cost_usd: 1 } }));
  assert.deepStrictEqual(s.snapshot().windows, {});
});

/* ============================================================ *
 * Collector round trip + wire/unwire
 * ============================================================ */
(async function () {
  console.log('\n[*] collector round trip');

  const store = new Store();
  const collector = createCollector(store, 8799);
  await new Promise((res, rej) => collector.listen((e) => (e ? rej(e) : res())));

  function post(p, body) {
    return new Promise((res) => {
      const b = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: 8799, path: p, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) },
      }, (r) => { r.resume(); r.on('end', res); });
      req.on('error', res);
      req.end(b);
    });
  }
  const get = (p) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port: 8799, path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
    }).on('error', () => res(''));
  });

  await atest('POST /hook then GET /state reflects the event', async () => {
    await post('/hook', { mode: 'hook', event: 'PreToolUse', payload: sid('rt', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_use_id: 't1' }) });
    await new Promise((r) => setTimeout(r, 60));
    const snap = JSON.parse(await get('/state'));
    const s = snap.sessions.find((x) => x.id === 'rt');
    assert.ok(s, 'session missing from /state');
    assert.strictEqual(s.state, 'running');
    assert.strictEqual(s.stateTool, 'Bash');
    assert.strictEqual(s.stateArg, 'ls -la');
  });

  await atest('POST /status merges cost into the same session', async () => {
    await post('/status', { mode: 'statusline', payload: sid('rt', { cost: { total_cost_usd: 3.25 }, model: { display_name: 'Opus 5' } }) });
    await new Promise((r) => setTimeout(r, 60));
    const snap = JSON.parse(await get('/state'));
    const s = snap.sessions.find((x) => x.id === 'rt');
    assert.strictEqual(s.costUsd, 3.25);
    assert.strictEqual(s.model, 'Opus 5');
  });

  await atest('a body sent after the headers is not dropped', async () => {
    // Regression: the collector used to answer 204 before consuming the request
    // stream, so any body that did not share a packet with the headers vanished.
    const body = JSON.stringify({
      event: 'PreToolUse',
      payload: sid('slowbody', { tool_name: 'Bash', tool_input: { command: 'sleep 1' }, tool_use_id: 't1' }),
    });
    await new Promise((res) => {
      const req = http.request({
        host: '127.0.0.1', port: 8799, path: '/hook', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (r) => { r.resume(); r.on('end', res); });
      req.on('error', res);
      req.flushHeaders();
      setTimeout(() => req.end(body), 120);   // deliberate gap
    });
    await new Promise((r) => setTimeout(r, 80));
    const snap = JSON.parse(await get('/state'));
    assert.ok(snap.sessions.find((x) => x.id === 'slowbody'), 'the delayed body was dropped');
  });

  /* ---- hardening: the collector trusts the local user, not the network ---- */

  function raw(opts, body) {
    return new Promise((resolve) => {
      const r = http.request(Object.assign({ host: '127.0.0.1', port: 8799 }, opts), (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
      });
      r.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
      r.end(body);
    });
  }

  await atest('a cross-origin POST cannot inject sessions', async () => {
    // text/plain is a CORS "simple request": no preflight, so any page the user
    // visits could once fire fake permission alerts into the widget.
    const res = await raw({
      method: 'POST', path: '/hook',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    }, JSON.stringify({ event: 'Notification', payload: sid('evil', { notification_type: 'permission_prompt' }) }));
    assert.ok(res.status === 403 || res.status === 415, 'accepted with ' + res.status);
    await new Promise((r) => setTimeout(r, 60));
    const snap = JSON.parse(await get('/state'));
    assert.ok(!snap.sessions.find((s) => s.id === 'evil'), 'a foreign page injected a session');
  });

  await atest('a foreign Host header is refused (DNS rebinding)', async () => {
    const res = await raw({ method: 'GET', path: '/state', headers: { host: 'attacker.example.com' } });
    assert.strictEqual(res.status, 403, 'served state to a rebound hostname');
  });

  await atest('no CORS headers, so a foreign page cannot read state', async () => {
    const res = await raw({ method: 'GET', path: '/state', headers: { origin: 'https://evil.example' } });
    assert.ok(!res.headers['access-control-allow-origin'], 'state is readable cross-origin');
  });

  await atest('traversal into a sibling directory is refused', async () => {
    // path.join + startsWith once matched "…/renderer-anything" as being inside
    // "…/renderer", which served files from outside the served directory.
    const probe = path.join(ROOT, 'src', 'renderer-regression-probe');
    fs.mkdirSync(probe, { recursive: true });
    fs.writeFileSync(path.join(probe, 'x.txt'), 'ESCAPED');
    try {
      const res = await raw({ method: 'GET', path: '/../renderer-regression-probe/x.txt' });
      assert.ok(!/ESCAPED/.test(res.body), 'escaped the renderer directory (HTTP ' + res.status + ')');
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  });

  await atest('the shim POST still works (guards did not break ingest)', async () => {
    await post('/hook', { mode: 'hook', event: 'SessionStart', payload: sid('guarded') });
    await new Promise((r) => setTimeout(r, 60));
    const snap = JSON.parse(await get('/state'));
    assert.ok(snap.sessions.find((s) => s.id === 'guarded'), 'legitimate shim traffic was rejected');
  });

  await atest('garbage body does not kill the collector', async () => {
    await new Promise((res) => {
      const req = http.request({ host: '127.0.0.1', port: 8799, path: '/hook', method: 'POST' }, (r) => { r.resume(); r.on('end', res); });
      req.on('error', res);
      req.end('<<<not json>>>');
    });
    await new Promise((r) => setTimeout(r, 40));
    const snap = JSON.parse(await get('/state'));
    assert.ok(Array.isArray(snap.sessions), 'collector stopped serving state');
  });

  await atest('the widget page is served', async () => {
    const html = await get('/');
    assert.match(html, /Sereno/);
  });

  await atest('path traversal is refused', async () => {
    const body = await get('/../package.json');
    assert.ok(!/"name": "claude-hud"/.test(body), 'served a file outside the renderer dir');
  });

  await atest('the real emit.js reaches a live collector', async () => {
    execFileSync(process.execPath, [EMIT, 'hook', 'Notification'], {
      input: JSON.stringify(sid('shim', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })),
      env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '8799' }),
      timeout: 10000,
    });
    await new Promise((r) => setTimeout(r, 250));
    const snap = JSON.parse(await get('/state'));
    const s = snap.sessions.find((x) => x.id === 'shim');
    assert.ok(s, 'the shim never reached the collector');
    assert.strictEqual(s.state, 'blocked');
  });

  collector.close();

  /* ---------------- wire / unwire ---------------- */
  console.log('\n[7] wire then unwire is byte-identical');

  await atest('unwire restores settings.json exactly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-wire-'));
    const settings = path.join(tmp, 'settings.json');
    const original = '{\n  "theme": "dark-daltonized",\n  "tui": "fullscreen"\n}\n';
    fs.writeFileSync(settings, original);

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp });
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'wire.js'), '--yes'], { env, encoding: 'utf8' });

    const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.ok(wired.statusLine.command.includes('emit.js'), 'statusLine not wired');
    assert.strictEqual(Object.keys(wired.hooks).length, 9, 'expected 9 hook events');
    assert.strictEqual(wired.theme, 'dark-daltonized', 'existing settings were lost');

    // Idempotent: a second wire must not duplicate anything.
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'wire.js'), '--yes'], { env, encoding: 'utf8' });
    const twice = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(twice.hooks.PreToolUse.length, 1, 'wiring twice duplicated hooks');

    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'unwire.js'), '--yes'], { env, encoding: 'utf8' });
    const restored = fs.readFileSync(settings, 'utf8');
    assert.strictEqual(restored, original, 'settings.json is not byte-identical after unwire');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await atest('wire preserves a pre-existing foreign hook', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-wire2-'));
    const settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2));

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp });
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'wire.js'), '--yes'], { env, encoding: 'utf8' });

    const w = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.strictEqual(w.hooks.PreToolUse.length, 2, 'foreign hook was dropped or merged over');
    assert.strictEqual(w.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /* ============================================================ *
   * 8. Auto-launch: the shim starting the app on a cold session
   * ============================================================ */
  console.log('\n[8] auto-launch on a cold SessionStart');

  // Every case here runs against a throwaway SERENO_HOME, so the suite can
  // never read the developer's real config or spawn their real widget.
  function launchFixture(cfg) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    const marker = path.join(home, 'launched.txt');
    if (cfg) {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(Object.assign({
        // A stand-in for Sereno.exe: it records that it ran, and what it
        // inherited, then exits. What the real app would do is beside the point.
        launch: {
          exe: process.execPath,
          args: ['-e', 'require("fs").writeFileSync(process.argv[1], String(process.env.ELECTRON_RUN_AS_NODE))', marker],
        },
      }, cfg)));
    }
    return { home, marker };
  }

  function emitIn(home, args, input, extraEnv) {
    // Port 9 again: the discard port refuses instantly, which is exactly the
    // cold-start signal the shim keys off.
    return spawnSync(process.execPath, [EMIT].concat(args), {
      input,
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9', SERENO_HOME: home }, extraEnv || {}),
      timeout: 10000,
    });
  }

  const waitFor = async (file, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (fs.existsSync(file)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };

  const pendingOf = (home) => {
    try { return fs.readdirSync(path.join(home, 'pending')).filter((f) => f.endsWith('.json')); }
    catch (_) { return []; }
  };

  const drainIn = (home) => {
    const prev = process.env.SERENO_HOME;
    process.env.SERENO_HOME = home;
    try { return require('../src/config.js').drainPending(); }
    finally { if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev; }
  };

  await atest('opted out (no config at all) never spawns anything', async () => {
    const { home, marker } = launchFixture(null);
    const r = emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')));
    assert.strictEqual(r.status, 0, 'exit code ' + r.status);
    assert.strictEqual(await waitFor(marker, 400), false, 'launched without being asked to');
    assert.strictEqual(pendingOf(home).length, 0, 'queued an event with auto-launch off');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('autoLaunch false is respected even with a launch command on file', async () => {
    const { home, marker } = launchFixture({ autoLaunch: false });
    emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')));
    assert.strictEqual(await waitFor(marker, 400), false, 'launched while switched off');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('autoLaunch true starts the app on SessionStart', async () => {
    const { home, marker } = launchFixture({ autoLaunch: true });
    const r = emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')));
    assert.strictEqual(r.status, 0, 'exit code ' + r.status);
    assert.strictEqual(r.stderr, '', 'shim wrote to stderr: ' + r.stderr);
    assert.ok(await waitFor(marker, 5000), 'the app was never started');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('the launched app does not inherit ELECTRON_RUN_AS_NODE', async () => {
    // emit.cmd sets it so Electron runs as Node. Passing it on would start
    // Sereno headless: a node process, no widget, and no way to tell why.
    const { home, marker } = launchFixture({ autoLaunch: true });
    emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')), { ELECTRON_RUN_AS_NODE: '1' });
    assert.ok(await waitFor(marker, 5000), 'the app was never started');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'undefined', 'ELECTRON_RUN_AS_NODE leaked into the app');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('the triggering event is queued so the widget does not come up empty', async () => {
    const { home } = launchFixture({ autoLaunch: true });
    emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')), { CLAUDE_PID: '4242' });

    const queued = pendingOf(home);
    assert.strictEqual(queued.length, 1, 'expected exactly one queued event, got ' + queued.length);
    const rec = JSON.parse(fs.readFileSync(path.join(home, 'pending', queued[0]), 'utf8'));
    assert.strictEqual(rec.event, 'SessionStart');
    assert.strictEqual(rec.payload.session_id, 'cold');
    assert.strictEqual(rec.ppid, 4242, 'the pid needed to focus the terminal was lost');

    // And the app picks it up: this is the half that makes the replay worth doing.
    const drained = drainIn(home);
    assert.strictEqual(drained.length, 1, 'drainPending did not return the queued event');
    assert.strictEqual(pendingOf(home).length, 0, 'drainPending left the queue behind');

    const store = new Store();
    store.applyHook(drained[0].event, drained[0].payload, { ppid: drained[0].ppid });
    assert.strictEqual(store.snapshot().sessions.length, 1, 'the replayed event did not reach the store');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('several sessions starting at once launch the app only once', async () => {
    const { home } = launchFixture({ autoLaunch: true });
    for (let i = 0; i < 4; i++) emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('s' + i)));
    assert.strictEqual(pendingOf(home).length, 1, 'the debounce let a spawn storm through');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('only SessionStart may launch: no other event spawns', async () => {
    for (const ev of ['PreToolUse', 'Notification', 'Stop', 'SessionEnd']) {
      const { home, marker } = launchFixture({ autoLaunch: true });
      emitIn(home, ['hook', ev], JSON.stringify(sid('cold')));
      assert.strictEqual(await waitFor(marker, 300), false, ev + ' launched the app');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await atest('statusline mode never launches, and still prints its one line', async () => {
    const { home, marker } = launchFixture({ autoLaunch: true });
    const r = emitIn(home, ['statusline'], JSON.stringify({ model: { display_name: 'Opus' } }));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.split('\n').length, 2, 'expected exactly one line');
    assert.strictEqual(await waitFor(marker, 300), false, 'the statusline launched the app');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('a stale queue is discarded rather than replayed into a new boot', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    const dir = path.join(home, 'pending');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, Date.now() + '-1.json');
    fs.writeFileSync(file, JSON.stringify({ event: 'SessionStart', payload: sid('old'), ppid: null }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(file, old, old);

    assert.strictEqual(drainIn(home).length, 0, 'an hour-old session was replayed as live');
    assert.strictEqual(pendingOf(home).length, 0, 'the stale entry was left to rot');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('what the app records is what the shim can launch', async () => {
    // The seam most likely to drift in silence: main.js writes the launch spec
    // through src/config.js, bin/emit.js reads it back with its own inlined copy
    // of those paths, and nothing else connects the two halves.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    const marker = path.join(home, 'launched.txt');
    const config = require('../src/config.js');

    const prev = process.env.SERENO_HOME;
    process.env.SERENO_HOME = home;
    try {
      config.recordLaunch({
        exe: process.execPath,
        args: ['-e', 'require("fs").writeFileSync(process.argv[1], "up")', marker],
      });
      config.write({ autoLaunch: true });
    } finally {
      if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
    }

    emitIn(home, ['hook', 'SessionStart'], JSON.stringify(sid('cold')));
    assert.ok(await waitFor(marker, 5000), 'the shim could not launch what the app recorded');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('the app clears the debounce marker once it is up', async () => {
    // Otherwise quitting and starting a session inside the window would be
    // swallowed by a lock this very launch left behind.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    const config = require('../src/config.js');
    const prev = process.env.SERENO_HOME;
    process.env.SERENO_HOME = home;
    try {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(config.launchLock(), String(Date.now()));
      config.clearLaunchLock();
      assert.strictEqual(fs.existsSync(config.launchLock()), false, 'the marker outlived the launch');
      config.clearLaunchLock();   // absent is not an error
    } finally {
      if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
