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

console.log('\n[*] background subagents outlive Stop (docs/payloads.md §6)');

const bgStop = (id, tasks) => H('Stop', sid(id, { background_tasks: tasks }));
const bgTask = (id, extra) => Object.assign({ id, type: 'subagent', status: 'running',
  description: 'do a thing', agent_type: 'general-purpose' }, extra || {});

test('Stop keeps a running background subagent listed; the session is active, not quiet', () => {
  const s = new Store();
  feed(s, [
    H('UserPromptSubmit', sid('x', { prompt: 'go' })),
    H('PreToolUse', sid('x', { tool_name: 'Agent', tool_use_id: 't1' })),
    H('SubagentStart', sid('x', { agent_id: 'a9ee', agent_type: 'general-purpose' })),
    H('PostToolUse', sid('x', { tool_name: 'Agent', tool_use_id: 't1' })),
    bgStop('x', [bgTask('a9ee')]),
  ]);
  const snap = s.snapshot();
  const g = snap.sessions[0];
  assert.strictEqual(g.state, 'idle', 'store state stays idle; the label is presentation');
  assert.strictEqual(g.subagents, 1);
  assert.strictEqual(g.subagentList.length, 1);
  assert.strictEqual(g.subagentList[0].type, 'general-purpose');
  assert.strictEqual(snap.counts.active, 1);
  assert.strictEqual(snap.counts.quiet, 0, 'a session is never both active and quiet');
});

test('a background subagent keeps updating after Stop, and SubagentStop ends it', () => {
  const s = new Store();
  feed(s, [
    H('SubagentStart', sid('x', { agent_id: 'a9ee', agent_type: 'general-purpose' })),
    bgStop('x', [bgTask('a9ee')]),
    H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'a9ee',
      agent_type: 'general-purpose', tool_input: { file_path: '/a/b.js' } })),
  ]);
  let g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagentList[0].tool, 'Read');
  assert.strictEqual(g.subagentList[0].arg, '/a/b.js');
  assert.strictEqual(g.state, 'idle', 'tagged events never drive top-level state');
  feed(s, [H('PostToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'a9ee' }))]);
  g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagentList[0].tool, '');
  assert.strictEqual(g.subagents, 1);

  feed(s, [H('SubagentStop', sid('x', { agent_id: 'a9ee', agent_type: 'general-purpose' }))]);
  const snap = s.snapshot();
  assert.strictEqual(snap.sessions[0].subagents, 0);
  assert.deepStrictEqual(snap.sessions[0].subagentList, []);
  assert.strictEqual(snap.counts.active, 0);
  assert.strictEqual(snap.counts.quiet, 1, 'once the subagent is gone the session is quiet');
});

test('Stop without background_tasks still clears every subagent (2.1.270)', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'a', agent_id: 'ag1' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'b', agent_id: 'ag2' })),
    H('Stop', sid('x')),
  ]);
  assert.strictEqual(s.sessions.get('x').subagents, 0);
  feed(s, [H('Stop', sid('x', { background_tasks: 'nope' }))]);
  assert.strictEqual(s.sessions.get('x').subagents, 0, 'a non-array list is treated as absent');
});

test('Stop prunes subagents that its background_tasks does not list as running', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'a', agent_id: 'ag1', agent_type: 'Explore' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'b', agent_id: 'ag2', agent_type: 'Plan' })),
    bgStop('x', [bgTask('ag2', { agent_type: 'Plan' })]),
  ]);
  assert.deepStrictEqual(s.snapshot().sessions[0].subagentList.map((a) => a.id), ['ag2']);
  feed(s, [bgStop('x', [])]);
  assert.strictEqual(s.snapshot().sessions[0].subagents, 0);
});

test('a Stop that lists a running subagent we never saw adds it with its type', () => {
  const s = new Store();
  feed(s, [
    H('UserPromptSubmit', sid('x', { prompt: 'go' })),
    bgStop('x', [bgTask('never-seen', { agent_type: 'Explore' }), bgTask('no-type', { agent_type: undefined })]),
  ]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 2);
  assert.strictEqual(g.subagentList[0].id, 'never-seen');
  assert.strictEqual(g.subagentList[0].type, 'Explore');
  assert.strictEqual(g.subagentList[1].type, 'agent', 'a missing type still renders as something');
  assert.ok(g.subagentList[0].since > 0);
});

test('a Stop ignores background tasks that are not running subagents', () => {
  const s = new Store();
  feed(s, [bgStop('x', [
    { id: 'sh1', type: 'shell', status: 'running', description: 'npm run dev' },
    bgTask('done1', { status: 'completed' }),
    { type: 'subagent', status: 'running' },            // no id
    null,
  ])]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 0);
  assert.deepStrictEqual(g.subagentList, []);
});

test('a SubagentStop for an agent_id never seen creates no row', () => {
  const s = new Store();
  feed(s, [
    bgStop('x', []),
    H('SubagentStop', sid('x', { agent_id: 'internal-1', agent_type: '' })),
    H('SubagentStop', sid('x', { agent_id: 'internal-2', agent_type: '' })),
  ]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 0);
  assert.deepStrictEqual(g.subagentList, []);
});

test('the renderer shows an idle session with background subagents as Running', () => {
  // app.js is a browser script and cannot be required, so the presentation
  // functions are lifted out by source, as the mmss test does.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const grab = (n) => app.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0];
  const R = new Function(['stateLabel', 'activityText', 'symbolFor']
    .map(grab).join('\n') + '\nreturn { stateLabel, activityText, symbolFor };')();
  const idle = { state: 'idle', stale: false, subagents: 1, stateTool: '', stateArgShort: '' };
  assert.strictEqual(R.stateLabel(idle), 'Running');
  assert.strictEqual(R.activityText(idle), 'Background work · ready for your next prompt');
  assert.strictEqual(R.activityText(Object.assign({}, idle, { subagents: 3 })),
    'Background work · ready for your next prompt');
  assert.strictEqual(R.symbolFor(idle), '<i></i><i></i><i></i>');
  assert.strictEqual(R.stateLabel(Object.assign({}, idle, { subagents: 0 })), 'Idle');
  assert.strictEqual(R.activityText(Object.assign({}, idle, { subagents: 0 })), 'Ready for your next prompt');
  assert.strictEqual(R.stateLabel(Object.assign({}, idle, { stale: true })), 'Stale');
  assert.ok(/s\.state === 'idle' && !\(s\.subagents > 0\)/.test(app),
    'the "All quiet" check must not treat background work as quiet');
});


console.log('\n[*] resumed subagents reuse their agent_id');

const STRAGGLER_AGE = 31 * 1000;   // just past STRAGGLER_MS
const ageTombstone = (s, session, id, ms) => s.sessions.get(session)._stopped.set(id, Date.now() - ms);

for (const [label, ageMs] of [['within the straggler window', 0], ['after the straggler window', STRAGGLER_AGE]]) {
  test('a resumed subagent (SubagentStart ' + label + ') is re-admitted and survives the next Stop', () => {
    const s = new Store();
    feed(s, [
      H('SubagentStart', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
      H('SubagentStop', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
      bgStop('x', []),
    ]);
    assert.strictEqual(s.sessions.get('x').subagents, 0);
    if (ageMs) ageTombstone(s, 'x', 'A', ageMs);
    feed(s, [
      H('UserPromptSubmit', sid('x', { prompt: 'resume it' })),
      H('SubagentStart', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
      H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'A',
        agent_type: 'general-purpose', tool_input: { file_path: '/a.js' } })),
      bgStop('x', [bgTask('A')]),
    ]);
    const snap = s.snapshot();
    const g = snap.sessions[0];
    assert.strictEqual(g.subagents, 1);
    assert.strictEqual(g.subagentList[0].id, 'A');
    assert.strictEqual(g.subagentList[0].type, 'general-purpose');
    assert.strictEqual(g.state, 'idle');
    assert.strictEqual(snap.counts.active, 1);
    assert.strictEqual(snap.counts.quiet, 0);
  });
}

test('a SubagentStart starts a fresh entry: new clock, tool and arg cleared', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'A',
      agent_type: 'Explore', tool_input: { command: 'old' } })),
  ]);
  s.sessions.get('x')._agents.get('A').since -= 60 * 1000;
  feed(s, [H('SubagentStart', sid('x', { agent_id: 'A', agent_type: 'Explore' }))]);
  const a = s.snapshot().sessions[0].subagentList[0];
  assert.strictEqual(a.tool, '');
  assert.strictEqual(a.arg, '');
  assert.ok(Date.now() - a.since < 5000, 'the resumed run must not inherit the old clock');
});

test('a resumed subagent without SubagentStart is re-created by its first tagged event', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'A', agent_type: 'Explore' })),
    H('SubagentStop', sid('x', { agent_id: 'A', agent_type: 'Explore' })),
  ]);
  ageTombstone(s, 'x', 'A', STRAGGLER_AGE);
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'c2', agent_id: 'A',
    agent_type: 'Explore', tool_input: { file_path: '/b.js' } }))]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 1);
  assert.strictEqual(g.subagentList[0].tool, 'Read');
  assert.ok(!s.sessions.get('x')._stopped.has('A'), 'the old tombstone must be gone');
});

test('a Stop list is authoritative: it re-adds a listed id however fresh its tombstone', () => {
  const s = new Store();
  feed(s, [
    H('SubagentStop', sid('x', { agent_id: 'old', agent_type: 'Explore' })),
    H('SubagentStop', sid('x', { agent_id: 'fresh', agent_type: 'Explore' })),
    H('SubagentStop', sid('x', { agent_id: 'done', agent_type: 'Explore' })),
  ]);
  ageTombstone(s, 'x', 'old', STRAGGLER_AGE);
  feed(s, [bgStop('x', [bgTask('old', { agent_type: 'Explore' }), bgTask('fresh', { agent_type: 'Explore' })])]);
  const g = s.snapshot().sessions[0];
  assert.deepStrictEqual(g.subagentList.map((a) => a.id).sort(), ['fresh', 'old'],
    'both are resumed runs the Stop reports as running');
  const st = s.sessions.get('x')._stopped;
  assert.ok(!st.has('old') && !st.has('fresh'), 'listed ids lose their tombstones');
  assert.ok(st.has('done'), 'an unlisted id keeps its tombstone');
});

test('a resume within 30 s and without SubagentStart still shows once the Stop lists it', () => {
  const s = new Store();
  feed(s, [
    H('SubagentStart', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
    H('SubagentStop', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
    bgStop('x', []),
    H('UserPromptSubmit', sid('x', { prompt: 'follow up' })),
    // Resumed run, no SubagentStart: inside the window this reads as a straggler.
    H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'r1', agent_id: 'A',
      agent_type: 'general-purpose', tool_input: { file_path: 'a.txt' } })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].subagents, 0, 'hidden until the Stop speaks');
  feed(s, [bgStop('x', [bgTask('A', { agent_type: 'general-purpose' })])]);
  const snap = s.snapshot();
  assert.strictEqual(snap.sessions[0].subagents, 1);
  assert.strictEqual(snap.counts.active, 1);
  // ...and its next tool call is no longer dropped.
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Grep', tool_use_id: 'r2', agent_id: 'A',
    agent_type: 'general-purpose', tool_input: { pattern: 'x' } }))]);
  assert.strictEqual(s.snapshot().sessions[0].subagentList[0].tool, 'Grep');
});

test('a kept subagent keeps its in-flight tool across a Stop that lists it', () => {
  const s = new Store();
  feed(s, [
    H('SubagentStart', sid('x', { agent_id: 'A', agent_type: 'general-purpose' })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'A',
      agent_type: 'general-purpose', tool_input: { command: 'npm test' } })),
  ]);
  const since = s.snapshot().sessions[0].subagentList[0].since;
  feed(s, [bgStop('x', [bgTask('A')])]);
  const a = s.snapshot().sessions[0].subagentList[0];
  assert.strictEqual(a.tool, 'Bash');
  assert.strictEqual(a.arg, 'npm test');
  assert.strictEqual(a.since, since, 'a Stop must not restart a kept subagent\'s clock');
});

test('numeric agent ids compare equal to their string form; object ids are ignored', () => {
  const s = new Store();
  feed(s, [bgStop('x', [{ id: 7, type: 'subagent', status: 'running', agent_type: 'Explore' }])]);
  let g = s.snapshot().sessions[0];
  assert.deepStrictEqual(g.subagentList.map((a) => a.id), ['7']);
  feed(s, [H('SubagentStop', sid('x', { agent_id: 7, agent_type: 'Explore' }))]);
  g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 0, 'a numeric agent_id must match the string id from the list');
  assert.deepStrictEqual(g.subagentList, []);

  feed(s, [bgStop('x', [
    { id: { nested: 1 }, type: 'subagent', status: 'running' },
    { id: true, type: 'subagent', status: 'running' },
    { id: NaN, type: 'subagent', status: 'running' },
  ])]);
  assert.strictEqual(s.snapshot().sessions[0].subagents, 0);
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

test('the longest wait is promoted, not the newest block', () => {
  // The sort used to fall through to lastSeen among blocked sessions. The
  // statusline stops firing while a session is blocked, so lastSeen is roughly
  // when it blocked - which put the FRESHEST block in the alert slot and sank
  // the one that had been ignored longest.
  const s = new Store();
  const block = (id, agoMs) => {
    feed(s, [
      H('PreToolUse', sid(id, { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 't' + id })),
      H('Notification', sid(id, { notification_type: 'permission_prompt' })),
    ]);
    const g = s.sessions.get(id);
    g.stateSince = Date.now() - agoMs;
    g.lastSeen = Date.now() - agoMs;   // nothing heard since it blocked
  };
  block('waited-8m', 8 * 60 * 1000);
  block('waited-2m', 2 * 60 * 1000);
  block('just-now', 3 * 1000);

  const order = s.snapshot().sessions.map((x) => x.id);
  assert.strictEqual(order[0], 'waited-8m', 'the alert block must promote the longest wait');
  assert.deepStrictEqual(order, ['waited-8m', 'waited-2m', 'just-now'],
    'blocked sessions read longest-waiting first');
});

test('blocked still sorts above everything, however long it has waited', () => {
  // The wait ordering must not accidentally let a busy session outrank a
  // blocked one.
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('busy', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'tb' })),
    H('PreToolUse', sid('stuck', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' }, tool_use_id: 'ts' })),
    H('Notification', sid('stuck', { notification_type: 'permission_prompt' })),
  ]);
  s.sessions.get('stuck').stateSince = Date.now() - 30 * 60 * 1000;
  assert.strictEqual(s.snapshot().sessions[0].id, 'stuck');
});

test('a long wait is not mistaken for inactivity', () => {
  // Past five minutes a session goes stale, and stale used to win the row label
  // outright: a session waiting on YOU read "Stale / No activity for 20 minutes"
  // and lost its beacon. Promoting the longest waits put that right at the top.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const pick = (n) => app.match(new RegExp('function ' + n + '[\\s\\S]*?\\n}'))[0];
  const fns = new Function('humanMinutes',
    [pick('stateLabel'), pick('activityText'), pick('symbolFor'),
      'return { stateLabel, activityText, symbolFor };'].join('\n')
  )((ms) => Math.round(ms / 60000) + ' minutes');

  const blocked = { state: 'blocked', stale: true, staleForMs: 20 * 60 * 1000 };
  assert.strictEqual(fns.stateLabel(blocked), 'Blocked', 'stale must not mask blocked');
  assert.strictEqual(fns.activityText(blocked), 'Waiting for approval');
  assert.strictEqual(fns.symbolFor(blocked), '!', 'the beacon must survive going stale');

  // A session that really has gone quiet is still reported as such.
  const idle = { state: 'idle', stale: true, staleForMs: 20 * 60 * 1000 };
  assert.strictEqual(fns.stateLabel(idle), 'Stale');
  assert.strictEqual(fns.activityText(idle), 'No activity for 20 minutes');
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
 * Collapsed = the tray
 * ============================================================ */
console.log('\n[*] tray');

// The tray functions are plain and self-contained, so they are extracted and
// run rather than grepped.
function trayFns() {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const pick = (n) => main.match(new RegExp('function ' + n + '[\\s\\S]*?\\n}'))[0];
  return new Function(
    [pick('trayStateFor'), pick('trayTooltip'),
      'return { trayStateFor, trayTooltip };'].join('\n')
  )();
}

test('the tray mark follows the same precedence as the alert banner', () => {
  const { trayStateFor } = trayFns();
  assert.strictEqual(trayStateFor({ total: 5, blocked: 2, active: 3, quiet: 0 }), 'needs',
    'anything blocked outranks anything running');
  assert.strictEqual(trayStateFor({ total: 3, blocked: 0, active: 3, quiet: 0 }), 'busy');
  assert.strictEqual(trayStateFor({ total: 2, blocked: 0, active: 0, quiet: 2 }), 'quiet');
  assert.strictEqual(trayStateFor({ total: 0, blocked: 0, active: 0, quiet: 0 }), 'quiet',
    'nothing reporting is quiet, not an error state');
});

test('the count survives in the tooltip, since it cannot survive 16px', () => {
  // The puck could show "! 2". A tray icon cannot, so the number has to live
  // somewhere - and the tooltip is the only place left.
  const { trayTooltip } = trayFns();
  assert.match(trayTooltip({ total: 4, blocked: 2, active: 1, quiet: 1 }), /2 sessions need you/);
  assert.match(trayTooltip({ total: 2, blocked: 1, active: 1, quiet: 0 }), /1 session needs you/,
    'singular, not "1 sessions"');
  assert.match(trayTooltip({ total: 3, blocked: 0, active: 3, quiet: 0 }), /3 active/);
  assert.match(trayTooltip({ total: 2, blocked: 0, active: 0, quiet: 2 }), /nothing waiting/i);
  assert.strictEqual(trayTooltip({ total: 0, blocked: 0, active: 0, quiet: 0 }), 'Sereno');
});

// Decoding the committed PNGs back is the only way to assert what they
// actually look like, and the marks are the whole feature.
function decodePng(file) {
  const zlib = require('node:zlib');
  const b = fs.readFileSync(file);
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  return { w, h, at: (x, y) => {
    const i = y * (stride + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  } };
}

const luminance = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
};

test('every state has an icon, at both scales and for both taskbars', () => {
  const gen = require('../tools/make-tray-icons.js');
  const dir = path.join(ROOT, 'src', 'tray');

  for (const state of gen.STATES) {
    for (const theme of Object.keys(gen.PALETTE)) {
      for (const size of [16, 32]) {
        const f = path.join(dir, gen.iconName(state, theme, size));
        assert.ok(fs.existsSync(f), 'missing ' + path.basename(f));
        const b = fs.readFileSync(f);
        assert.deepStrictEqual([...b.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
          path.basename(f) + ' is not a PNG');
        assert.strictEqual(b.readUInt32BE(16), size, 'wrong width in ' + path.basename(f));
        assert.strictEqual(b.readUInt32BE(20), size, 'wrong height in ' + path.basename(f));
      }
    }
  }

  // Nothing ships that nothing asks for, and nothing stale lingers.
  const shipped = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  assert.deepStrictEqual(shipped, [...gen.buildAll().keys()].sort(),
    'src/tray does not match what the generator produces');
});

test('the committed icons are exactly what the generator draws', () => {
  // Otherwise the script can rot, or the assets drift from it, and neither
  // shows up until someone regenerates and gets a surprise diff.
  const gen = require('../tools/make-tray-icons.js');
  for (const [name, buf] of gen.buildAll()) {
    const on = fs.readFileSync(path.join(ROOT, 'src', 'tray', name));
    assert.ok(buf.equals(on), name + ' differs from the generator - re-run tools/make-tray-icons.js');
  }
});

test('a mark stays visible on the taskbar it was drawn for', () => {
  // Windows only auto-inverts template images on macOS. A single light set
  // measured 1.02:1 against Windows 11's light taskbar - invisible - and the
  // state it erased was 'busy', which is the one that means work is happening.
  const gen = require('../tools/make-tray-icons.js');
  const BG = { dark: luminance(0x20, 0x20, 0x20), light: luminance(0xf3, 0xf3, 0xf3) };

  for (const state of gen.STATES) {
    for (const theme of Object.keys(gen.PALETTE)) {
      const img = decodePng(path.join(ROOT, 'src', 'tray', gen.iconName(state, theme, 16)));
      const tally = new Map();
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          const [r, g, b, a] = img.at(x, y);
          if (a < 250) continue;
          const k = r + ',' + g + ',' + b;
          tally.set(k, (tally.get(k) || 0) + 1);
        }
      }
      assert.ok(tally.size, state + '/' + theme + ' drew nothing opaque');
      const [dominant] = [...tally].sort((a, b) => b[1] - a[1])[0];
      const [r, g, b] = dominant.split(',').map(Number);
      const ratio = contrast(luminance(r, g, b), BG[theme]);
      assert.ok(ratio >= 3, state + '/' + theme + ' is ' + ratio.toFixed(2) +
        ':1 against its own taskbar (needs 3:1) - rgb(' + dominant + ')');
    }
  }
});

test('the shapes are told apart with the colour stripped out', () => {
  // The project rule, applied at 16px: needs is solid, quiet is a hollow ring,
  // busy is bars that do not reach the middle. None of that needs colour.
  const gen = require('../tools/make-tray-icons.js');
  for (const theme of Object.keys(gen.PALETTE)) {
    const at = (state, x, y) =>
      decodePng(path.join(ROOT, 'src', 'tray', gen.iconName(state, theme, 16))).at(x, y);
    assert.ok(at('needs', 8, 8)[3] > 200, 'needs must be filled at its centre');
    assert.ok(at('quiet', 8, 8)[3] < 64, 'quiet must be hollow at its centre');
    assert.ok(at('quiet', 8, 2)[3] > 128, 'quiet must have a stroke at its top');
    assert.ok(at('busy', 8, 1)[3] < 64, 'busy bars must not reach the top edge');
  }
});

test('the tray is created once, not per collapse', () => {
  // Windows treats a re-created tray icon as a new one and can drop it back
  // into the overflow flyout, so a tray that came and went would need
  // promoting out of the overflow every single time.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const code = main.split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

  assert.strictEqual((code.match(/new Tray\(/g) || []).length, 1, 'exactly one Tray is constructed');
  const collapse = code.match(/ipcMain\.on\('sereno:collapse'[\s\S]*?\n  \}\);/)[0];
  assert.ok(!/Tray|destroy/.test(collapse), 'collapsing must not touch the tray object');
  assert.ok(/hideWindow\(\)/.test(collapse) && /showWindow\(\)/.test(collapse),
    'collapsing hides the window rather than resizing it');

  // The click handler ran before createWindow existed and dereferenced a null
  // win; and a toggle could leave the user hidden after a double-click, on the
  // one control whose job is getting the window back.
  const click = code.match(/tray\.on\('click'[\s\S]*?\);/)[0];
  assert.ok(!/win\./.test(click), 'the click handler must not touch win directly');
  assert.ok(/showWindow\(\)/.test(click) && !/hideWindow/.test(click),
    'a left click must only ever show');

  // ui has to be loaded before the tray reads it, or a collapsed restart builds
  // the tray against the module defaults.
  // The semicolon matters: without it this finds 'function createTray(store) {',
  // which is defined long before it is called, and the assertion is vacuous.
  assert.ok(code.indexOf('ui = loadUi();') < code.indexOf('createTray(store);'),
    'loadUi must run before createTray');
  assert.ok(/try \{\s*createTray\(store\);/.test(code),
    'a tray that will not construct must not take the collector and window with it');
  assert.ok(!/applySize/.test(collapse), 'nothing is resized any more');

  // But it must be released on quit, or the icon lingers until hovered.
  const quit = code.match(/app\.on\('before-quit'[\s\S]*?\n  \}\);/)[0];
  assert.ok(/tray\.destroy\(\)/.test(quit), 'a tray left behind survives the process');
});

test('the tray keeps up with the store, including the timed sweep', () => {
  // The collector takes store.onChange for its broadcast. Replacing it would
  // silence the widget; not chaining onto it would freeze the tray.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(/const broadcast = store\.onChange;[\s\S]*?store\.onChange = \(\) => \{ broadcast\(\); updateTray/.test(main),
    'the tray must chain onto the broadcast, not replace it');
  // ...but coalesced, like the broadcast it rides beside: building a whole
  // snapshot per statusline tick to read four integers is work nobody asked for.
  const upd = main.match(/function updateTray[\s\S]*?\n}/)[0];
  assert.ok(/BROADCAST_COALESCE_MS/.test(upd), 'the tray update must be coalesced');
  assert.ok(/require\('\.\/collector\.js'\)/.test(main) && !/const BROADCAST_COALESCE_MS =/.test(main),
    'and must share the collector\'s window rather than keeping a second copy');
  // sweep() ages sessions out on a timer, with no event behind it.
  const sweep = main.match(/const sweep = setInterval\([\s\S]*?\}, SWEEP_MS\);/)[0];
  assert.ok(/updateTray/.test(sweep), 'the tray would keep claiming work that has gone quiet');
});

test('the overflow is explained once, and only once', () => {
  // Windows 11 files an unfamiliar tray icon behind the chevron, and an app
  // cannot promote itself out of it - so the only chance to say so is the
  // moment the window disappears and the icon is not where the user looks.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const hint = main.match(/function trayHint[\s\S]*?\n}/)[0];

  assert.ok(/if \(ui\.trayHintShown\) return;/.test(hint), 'it must be said once');
  assert.ok(/ui\.trayHintShown = true;[\s\S]*?saveUi\(\)/.test(hint),
    'and remembered before the toast, so a failed toast does not repeat forever');
  assert.ok(/Notification\.isSupported\(\)/.test(hint), 'guarded like every other toast');

  // It fires on an explicit collapse, not on a restart that happens to be
  // collapsed - otherwise it would greet the user on every launch.
  const hide = main.match(/function hideWindow[\s\S]*?\n}/)[0];
  assert.ok(/trayHint\(\)/.test(hide), 'the hint belongs to the act of hiding');
  const ready = main.match(/win\.once\('ready-to-show'[\s\S]*?\);/)[0];
  assert.ok(!/trayHint/.test(ready), 'a collapsed restart must not re-explain it');

  const loadUi = main.match(/function loadUi[\s\S]*?\n}/)[0];
  assert.ok(/trayHintShown: b\.trayHintShown === true/.test(loadUi),
    'an older window.json must read as not-yet-shown');
});

test('collapsed means hidden, and is remembered', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const loadUi = main.match(/function loadUi[\s\S]*?\n}/)[0];
  const fallback = loadUi.slice(loadUi.lastIndexOf('return {'));
  assert.ok(/collapsed: b\.collapsed === true/.test(loadUi),
    'a window.json written before this feature must read as expanded');
  assert.ok(/collapsed: false/.test(fallback), 'the no-file default is a visible window');

  // Left collapsed, it must not flash on screen and then vanish.
  const ready = main.match(/win\.once\('ready-to-show'[\s\S]*?\);/)[0];
  assert.ok(/if \(!ui\.collapsed\)/.test(ready), 'a collapsed start must not show the window');

  for (const fn of ['showWindow', 'hideWindow']) {
    const body = main.match(new RegExp('function ' + fn + '[\\s\\S]*?\\n}'))[0];
    assert.ok(/saveUi\(\)/.test(body), fn + ' must persist the change');
  }
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

test('a subagent reports which agent it is and what it is running', () => {
  // agent_type and the tagged tool events were both arriving already; the store
  // kept only a count of ids and threw the rest away.
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Agent', tool_use_id: 'p1',
      tool_input: { description: 'audit the wiring module', subagent_type: 'Explore' } })),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'grep -rn "emit" src/' } })),
    H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'c2',
      agent_id: 'b2', agent_type: 'general-purpose', tool_input: { file_path: 'src/wiring.js' } })),
  ]);

  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 2);
  assert.deepStrictEqual(g.subagentList.map((a) => a.type), ['Explore', 'general-purpose'],
    'oldest first, so a subagent does not jump around as siblings come and go');
  assert.strictEqual(g.subagentList[0].tool, 'Bash');
  assert.strictEqual(g.subagentList[0].arg, 'grep -rn "emit" src/');
  assert.strictEqual(g.subagentList[1].tool, 'Read');

  // And none of it disturbed the parent, which is on its own Agent call.
  assert.strictEqual(g.stateTool, 'Agent');
  assert.strictEqual(g.stateArg, 'audit the wiring module');
});

test('between tool calls a subagent is reasoning, not still running', () => {
  // Leaving the finished tool on screen would claim it is still busy.
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'npm test' } })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].subagentList[0].tool, 'Bash');

  feed(s, [H('PostToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
    agent_id: 'a1', agent_type: 'Explore' }))]);
  const a = s.snapshot().sessions[0].subagentList[0];
  assert.strictEqual(a.tool, '', 'the finished tool must not linger');
  assert.strictEqual(a.arg, '');
  assert.strictEqual(s.snapshot().sessions[0].subagents, 1, 'it is still alive, just quiet');
});

test('a subagent keeps its start time as its tools come and go', () => {
  // There is no SubagentStart, so elapsed counts from the first tagged event -
  // the earliest moment the subagent is knowable at all. A later tool call must
  // not restart the clock.
  const s = new Store();
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
    agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'a' } }))]);
  const first = s.snapshot().sessions[0].subagentList[0].since;

  s.sessions.get('x')._agents.get('a1').since = first - 5000;   // pretend 5s passed
  feed(s, [
    H('PostToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'a1' })),
    H('PreToolUse', sid('x', { tool_name: 'Read', tool_use_id: 'c2',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { file_path: 'b.js' } })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].subagentList[0].since, first - 5000,
    'the stopwatch restarted on the next tool call');
});

test('the subagent ceiling drops the stalest, never the arrival', () => {
  // A missed SubagentStop would otherwise accumulate without limit - but the
  // entries filling the map when the ceiling bites ARE those ghosts, so
  // rejecting the newcomer would keep the dead and hide the living.
  //
  // The earlier assertion here was `<= 16`, which passes at zero and never says
  // which entries survived. It was green while the map dropped every live
  // subagent past the sixteenth.
  const s = new Store();
  for (let i = 0; i < 40; i++) {
    feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 't' + i,
      agent_id: 'agent-' + i, agent_type: 'Explore', tool_input: { command: 'x' } }))]);
  }
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 32, 'the ceiling must be reached, not merely respected');
  assert.strictEqual(g.subagentList.length, g.subagents, 'the list and the count must agree');
  assert.ok(g.subagentList.some((a) => a.id === 'agent-39'),
    'the most recent subagent must survive; it is the one most likely alive');
  assert.ok(!g.subagentList.some((a) => a.id === 'agent-0'),
    'the stalest must be the one evicted');
});

test('a straggler after SubagentStop does not resurrect a dead subagent', () => {
  // The shim is fire-and-forget, one connection per hook, so a subagent's last
  // PostToolUse can arrive AFTER its SubagentStop. Re-creating the entry would
  // show a dead agent with a clock started from the moment of the straggler.
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'npm test' } })),
    H('SubagentStop', sid('x', { agent_id: 'a1', agent_type: 'Explore' })),
    H('PostToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1', agent_id: 'a1' })),
  ]);
  let g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 0, 'the straggler brought it back from the dead');
  assert.deepStrictEqual(g.subagentList, []);

  // The tombstone survives Stop on purpose: a background subagent's stragglers
  // can arrive after a later Stop. Inside the straggler window it still holds.
  feed(s, [
    H('Stop', sid('x')),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c9',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'y' } })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].subagents, 0,
    'a straggler within 30s of the SubagentStop must not revive the subagent');

  // But agent_ids are not unique over time (a resume reuses the id), so once the
  // window has passed the same id is a new run and must be admitted.
  s.sessions.get('x')._stopped.set('a1', Date.now() - 31 * 1000);
  feed(s, [
    H('Stop', sid('x')),
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c10',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'z' } })),
  ]);
  assert.strictEqual(s.snapshot().sessions[0].subagents, 1,
    'a later run under a reused agent_id must be visible');
});

test('a stale session stops claiming live subagents', () => {
  // Five minutes without a word. Whatever its subagents were doing, they are
  // not doing it now, and a list of running stopwatches under a row labelled
  // Stale is a claim the widget cannot support.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = app.match(/function sessionHtml[\s\S]*?\n}/)[0];
  assert.ok(/s\.stale \? '' : subagentHtml/.test(fn),
    'a stale row must not render subagent lines');
});

test('the store does not pre-truncate to a width it cannot know', () => {
  // The row is user-resizable, so the renderer's ellipsis is the only mechanism
  // that knows the real width. Cutting to a guessed 28 here put a second
  // ellipsis on top of the first.
  const s = new Store();
  const long = 'grep -rn "emit" src/components/really/deeply/nested/path/file.js';
  feed(s, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
    agent_id: 'a1', agent_type: 'Explore', tool_input: { command: long } }))]);
  const a = s.snapshot().sessions[0].subagentList[0];
  assert.strictEqual(a.arg, long, 'a 64-char command must cross intact');
  assert.ok(!a.arg.includes('…'), 'the store must not add an ellipsis of its own');

  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.css'), 'utf8');
  const rule = css.match(/\.agent-type \{[\s\S]*?\}/)[0];
  assert.ok(/flex: 0 0 86px/.test(rule),
    'flex:none sets the basis to content and never shrinks, so the ellipsis could never fire');
});

test('subagent detail dies with the turn, like the count always did', () => {
  const s = new Store();
  feed(s, [
    H('PreToolUse', sid('x', { tool_name: 'Bash', tool_use_id: 'c1',
      agent_id: 'a1', agent_type: 'Explore', tool_input: { command: 'x' } })),
    H('Stop', sid('x')),
  ]);
  const g = s.snapshot().sessions[0];
  assert.strictEqual(g.subagents, 0);
  assert.deepStrictEqual(g.subagentList, []);
});

test('subagent timers tick in place, against the markup that carries them', () => {
  // Subagents are short-lived. A stopwatch that only moved when some unrelated
  // event arrived would sit frozen for most of their life - but re-rendering
  // every second to move it would throw away scroll position and hover.
  //
  // Both halves are asserted against each other on purpose. Checking only that
  // tick() mentions the class let a rename of the emitted markup pass green
  // while every stopwatch silently froze.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  // Comments are stripped first. tick() now explains in prose why it returns
  // early when collapsed, and that prose names render() - which is exactly the
  // call the assertion below is checking for the absence of.
  const strip = (t) => t.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const fn = strip(app.match(/function tick\(\)[\s\S]*?\n}/)[0]);
  const emit = app.match(/function subagentHtml[\s\S]*?\n}/)[0];

  assert.ok(/class="agent-timer" data-since=/.test(emit),
    'the rendered timer must carry the class and stamp that tick looks for');
  assert.ok(/agent-timer/.test(fn), 'tick must update the subagent timers');
  assert.ok(/dataset\.since/.test(fn), 'timers are driven from their own start stamp');
  assert.ok(!/\brender\s*\(/.test(fn), 'tick must not re-render to do it');

  // And it must stop while the data behind it has stopped arriving - or while
  // render() has stopped updating the DOM it is ticking.
  assert.ok(/ui\.offline\.hidden/.test(fn),
    'timers must hold when the collector is unreachable, not keep climbing');
});

test('a missing timestamp never reaches the DOM as NaN', () => {
  // Math.max(0, NaN) is NaN, and the old mmss rendered it as the literal
  // "NaN:NaN", repainted twice a second forever.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const mmss = new Function('return ' + app.match(/function mmss[\s\S]*?\n}/)[0])();
  assert.strictEqual(mmss(5000), '00:05');
  assert.strictEqual(mmss(0), '00:00');
  assert.strictEqual(mmss(-1), '00:00');
  assert.strictEqual(mmss(NaN), '--:--');
  assert.strictEqual(mmss(undefined), '--:--');
  assert.strictEqual(mmss(Infinity), '--:--');
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
  const prevHome = process.env.SERENO_HOME;
  process.env.SERENO_HOME = tmp;
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
    if (prevHome === undefined) delete process.env.SERENO_HOME;
    else process.env.SERENO_HOME = prevHome;
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

test('every blocked session is answerable, not just the promoted one', () => {
  // Only one blocked session is promoted into the alert block. Any other used to
  // render as a row reading "Blocked" with nothing to press, so with several
  // sessions running you could only ever answer whichever was promoted.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = app.match(/function sessionHtml[\s\S]*?\n}/)[0];

  assert.ok(/s\.state === 'blocked'/.test(fn), 'the row action is conditional on being blocked');
  assert.ok(/row-review/.test(fn), 'a blocked row must offer its own review button');
  assert.ok(/data-pid="\$\{s\.pid \|\| ''\}"/.test(fn), 'the button carries that session\'s own pid');

  // A button that cannot work must not pretend it can - same rule the promoted
  // button already follows when the shim never posted a pid.
  assert.ok(/canFocus/.test(fn) && /disabled/.test(fn),
    'no pid means the row button is disabled, not silently broken');
});

test('one handler serves the promoted button and the row buttons', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(/closest\('#review, \.row-review'\)/.test(app),
    'both kinds of review button go through the same click handler');
  // The failure note has to be the one belonging to the button pressed, or a
  // failure on one row reports itself under a different session.
  assert.ok(/review\.parentElement\.querySelector\('\.row-note'\)/.test(app),
    'a row failure must report under that row');
});

test('a session that is not blocked gets no review button', () => {
  // The button is an answer to a permission prompt; on an idle or running row it
  // would be an action with nothing to act on.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = app.match(/function sessionHtml[\s\S]*?\n}/)[0];
  const m = fn.match(/const action = s\.state === 'blocked'\s*\?([\s\S]*?):\s*('');/);
  assert.ok(m, 'the action must be a conditional with an empty alternative');
  assert.strictEqual(m[2], "''", 'a non-blocked row renders no action at all');
});

test('the window is bounded by the display, not by a fixed number', () => {
  // A hard 1400px ceiling left the footer hanging off the bottom of a long
  // session list on a 1440px screen, with no chrome and nothing scrolled to
  // reach it. Runtime geometry no unit test can exercise, so guard the source.
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const code = main.split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

  assert.ok(!/Math\.min\(1400/.test(code), 'the fixed 1400px ceiling must be gone');
  assert.ok(/workArea/.test(code) && /ceiling/.test(code),
    'applySize must clamp against the display work area');
  assert.ok(/SCREEN_MARGIN/.test(code), 'leave the work area edges clear');

  // A display change moves the ceiling, so the size has to be re-applied, not
  // just the position.
  const reassert = code.match(/function reassertOnTop[\s\S]*?\n}/)[0];
  assert.ok(/applySize\(\)/.test(reassert),
    'reassertOnTop must re-apply the size ceiling when displays change');
});

test('the window can grow from its minimum height', () => {
  // This shipped broken in 1.2.1. The window is created at MIN_HEIGHT and grows
  // ONLY by measuring itself and reporting back, so a measurement that reads the
  // clamped box deadlocks on the first pass: 60px clips every section, measures
  // 60, asks for 60, and stays there. The widget came up as a bare title bar.
  //
  // The earlier version of this test asserted the broken formula, because it was
  // written from the same wrong assumption - that only the row list could ever
  // be the part getting clipped.
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const fn = app.match(/function reportHeight[\s\S]*?\n}/)[0];

  assert.ok(!/ui\.window\.getBoundingClientRect\(\)\.height/.test(fn),
    'measuring the window itself is precisely what deadlocked 1.2.1');
  assert.ok(/for \(const el of ui\.window\.children\)/.test(fn),
    'height must be summed from the children, which keep their natural size');
  assert.ok(/el\.scrollHeight : el\.offsetHeight/.test(fn),
    'the row list contributes its full content, everything else its own height');

  // The children are flex:none, so they keep their natural height even while
  // overflowing a window too short to hold them: the sum cannot depend on the
  // height the window happens to have been given.
  const measure = (fixed, rowsContent, border) =>
    Math.ceil(fixed.reduce((a, b) => a + b, 0) + rowsContent + border);

  const atStartup = measure([117], 0, 2);          // banner only, nothing reporting
  assert.strictEqual(atStartup, 119);
  assert.ok(atStartup > 60, 'must ask for more than MIN_HEIGHT or it can never grow');

  // Same layout, same answer, whatever the window was clamped to.
  assert.strictEqual(measure([117, 130], 1450, 2), 1699);
});

test('only the session list scrolls', () => {
  // The alert, the promoted request and the allowances are the parts you opened
  // the widget to look at; they must not scroll away with the list.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.css'), 'utf8');
  const rows = css.match(/\.rows \{[^}]*flex: 1 1 auto;[^}]*\}/);
  assert.ok(rows, '.rows must be the flexible row of the column');
  assert.ok(/min-height: 0/.test(rows[0]),
    'a flex child will not shrink below its content without min-height:0');
  assert.ok(/overflow-y: auto/.test(rows[0]), '.rows must scroll');
  assert.ok(/#banner, #request, #setup, #footer, #offline \{ flex: none; \}/.test(css),
    'everything outside the list stays put');
});

test('focus picks a window by title, not the process-wide MainWindowHandle', () => {
  // Windows Terminal hosts every window it has opened in ONE process, so
  // .MainWindowHandle returns the same arbitrary handle for every session and
  // "Review in terminal" raised whichever window happened to be it. Real
  // window resolution needs a live desktop, so guard the source instead.
  const ps = fs.readFileSync(path.join(ROOT, 'src', 'focus-window.ps1'), 'utf8');

  // Comments are stripped first: the file explains at length why MainWindowHandle
  // is wrong, and that prose must not trip the check that we stopped calling it.
  // Split on either ending: .gitattributes checks .ps1 out as CRLF, and a
  // trailing \r stops /#.*$/ matching - which let the comment through on CI
  // while still passing on a working copy that happened to hold LF.
  const code = ps.split(/\r?\n/).map((l) => l.replace(/#.*$/, '')).join('\n');

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

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, SERENO_HOME: tmp });
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'wire.js'), '--yes'], { env, encoding: 'utf8' });

    const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.ok(wired.statusLine.command.includes('emit.js'), 'statusLine not wired');
    assert.strictEqual(Object.keys(wired.hooks).length, 11, 'expected 11 hook events');
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

  /* ---- Phase 1 step 0: SubagentStart + StopFailure wiring ---- */
  await atest('wire registers SubagentStart (no matcher) and StopFailure, idempotently', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-wire3-'));
    const settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(settings, '{}\n');
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, SERENO_HOME: tmp });
    const run = () => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'wire.js'), '--yes'], { env, encoding: 'utf8' });
    run(); run();
    const w = JSON.parse(fs.readFileSync(settings, 'utf8'));
    for (const ev of ['SubagentStart', 'StopFailure']) {
      assert.ok(wiring.EVENTS.includes(ev), ev + ' missing from EVENTS');
      assert.strictEqual(w.hooks[ev].length, 1, ev + ' duplicated or missing');
      assert.strictEqual(w.hooks[ev][0].matcher, undefined, ev + ' must have no matcher');
      assert.ok(w.hooks[ev][0].hooks[0].command.endsWith(' hook ' + ev), ev + ' command wrong');
    }
    for (const ev of wiring.EVENTS) assert.strictEqual(w.hooks[ev].length, 1, ev + ' duplicated');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await atest('wire preserves a pre-existing foreign hook', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-wire2-'));
    const settings = path.join(tmp, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2));

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp, SERENO_HOME: tmp });
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

  // The launch slot is decided by identity and usability, never by who wrote it
  // first. These run against a real temp SERENO_HOME and a real exe on disk,
  // because "does this path still exist" is the whole question.
  function slotFixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    // A stand-in for an installed binary: what matters is that it EXISTS.
    const installedExe = path.join(home, 'Sereno.exe');
    fs.writeFileSync(installedExe, 'not really an exe');
    return {
      home,
      INSTALLED: { exe: installedExe, args: [] },
      DEV: { exe: path.join(home, 'repo', 'electron.exe'), args: [path.join(home, 'repo')] },
      MOVED: { exe: path.join(home, 'repo2', 'electron.exe'), args: [path.join(home, 'repo2')] },
    };
  }
  function inHome(home, fn) {
    const prev = process.env.SERENO_HOME;
    process.env.SERENO_HOME = home;
    try { return fn(require('../src/config.js')); }
    finally { if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev; }
  }

  await atest('a run from source must not steal auto-launch from an install', async () => {
    // This actually happened: developing Sereno repointed the author's own
    // auto-launch at the repo's electron.exe, so every later session start
    // opened a dev build instead of the installed app - toasts titled
    // "Electron", clicking one opening the welcome screen.
    const f = slotFixture();
    inHome(f.home, (config) => {
      config.recordLaunch(f.INSTALLED);
      config.recordLaunch(f.DEV, { provisional: true });
      assert.strictEqual(config.read().launch.exe, f.INSTALLED.exe,
        'a dev run displaced a real install that is still there');
    });
    fs.rmSync(f.home, { recursive: true, force: true });
  });

  await atest('installing takes the slot back from a dev seed', async () => {
    // The previous version of this asserted the same thing twice: the slot
    // already held INSTALLED, so the second call hit the no-change
    // short-circuit and wrote nothing. It passed whether or not packaged
    // displacement worked at all.
    const f = slotFixture();
    inHome(f.home, (config) => {
      config.recordLaunch(f.DEV, { provisional: true });
      assert.strictEqual(config.read().launch.exe, f.DEV.exe, 'an empty slot must be seeded');
      config.recordLaunch(f.INSTALLED);
      assert.strictEqual(config.read().launch.exe, f.INSTALLED.exe,
        'a packaged build must displace a provisional seed');
      assert.ok(!config.read().launch.provisional, 'and must not stay marked provisional');
    });
    fs.rmSync(f.home, { recursive: true, force: true });
  });

  await atest('a dev seed still heals when the checkout moves', async () => {
    // Guarding the slot by occupancy alone broke this: a seed could never be
    // replaced by another dev run, so a renamed or moved checkout left
    // auto-launch pointing at a path that no longer existed, permanently.
    // Overwriting used to fix it on the next boot and must keep doing so.
    const f = slotFixture();
    inHome(f.home, (config) => {
      config.recordLaunch(f.DEV, { provisional: true });
      config.recordLaunch(f.MOVED, { provisional: true });
      assert.strictEqual(config.read().launch.exe, f.MOVED.exe,
        'one dev seed must be replaceable by the next');
    });
    fs.rmSync(f.home, { recursive: true, force: true });
  });

  await atest('an install that is no longer there does not lock the slot', async () => {
    // The uninstaller unwires but never touches ~/.sereno, so the recorded
    // target outlives the install. Occupancy-based guarding made that
    // permanent and unreachable - there is no UI that clears it.
    const f = slotFixture();
    inHome(f.home, (config) => {
      config.recordLaunch(f.INSTALLED);
      fs.rmSync(f.INSTALLED.exe);              // uninstalled
      config.recordLaunch(f.DEV, { provisional: true });
      assert.strictEqual(config.read().launch.exe, f.DEV.exe,
        'a target whose exe is gone is not a target worth protecting');
    });
    fs.rmSync(f.home, { recursive: true, force: true });
  });

  await atest('the provisional marker survives an unrelated write', async () => {
    // write() rebuilds the file from read(), so anything read() drops is
    // destroyed by the next unrelated write - and toggling auto-launch in the
    // UI is exactly such a write. Without this the marker silently vanished
    // and a dev seed started masquerading as an install.
    const f = slotFixture();
    inHome(f.home, (config) => {
      config.recordLaunch(f.DEV, { provisional: true });
      config.write({ autoLaunch: true });      // what the settings toggle does
      assert.strictEqual(config.read().launch.provisional, true,
        'the marker was stripped by an unrelated write');
      config.recordLaunch(f.MOVED, { provisional: true });
      assert.strictEqual(config.read().launch.exe, f.MOVED.exe,
        'and the seed is still recognised as replaceable afterwards');
    });
    fs.rmSync(f.home, { recursive: true, force: true });
  });

  await atest('the shim does not queue a replay for a target that is not there', async () => {
    // Trying to spawn a missing exe still took the debounce slot and still
    // wrote a pending file, which only a booting app deletes - and the app
    // never boots. One file leaked per session start, forever.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-home-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      autoLaunch: true,
      launch: { exe: path.join(home, 'gone', 'Sereno.exe'), args: [] },
    }));
    const r = spawnSync(process.execPath, [EMIT, 'hook', 'SessionStart'], {
      input: JSON.stringify({ session_id: 'x', cwd: 'C:/work/x' }),
      encoding: 'utf8',
      env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: '9', SERENO_HOME: home }),
      timeout: 10000,
    });
    assert.strictEqual(r.status, 0, 'the shim must still exit 0');
    assert.strictEqual(r.stderr, '', 'and never write to stderr');
    let queued = [];
    try { queued = fs.readdirSync(path.join(home, 'pending')); } catch (_) { queued = []; }
    assert.strictEqual(queued.length, 0, 'queued a replay nothing will ever drain');
    assert.strictEqual(fs.existsSync(path.join(home, 'launching')), false,
      'and burned the debounce slot for a launch that cannot happen');
    fs.rmSync(home, { recursive: true, force: true });
  });

  await atest('only a build in a temporary place records provisionally', async () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const m = main.match(/config\.recordLaunch\([\s\S]*?\n      \);/);
    assert.ok(m, 'recordLaunch call site not found - did main.js reformat?');
    assert.ok(/provisional: !app\.isPackaged \|\| BUILD_OUTPUT\.test/.test(m[0]),
      'isPackaged is not a proxy for installed: dist/win-unpacked is packaged and disposable');

    // RUN the pattern. The previous version of this only checked that the
    // string "dist ... win-unpacked" appeared somewhere, which was true both
    // before and after the regex was broken - it shipped as /[\/].../, where
    // the escape makes it a plain slash, so it could never match a Windows
    // execPath and the protection it guards did nothing on the only platform
    // Sereno runs on.
    const line = main.split(/\r?\n/).find((l) => l.startsWith('const BUILD_OUTPUT'));
    assert.ok(line, 'BUILD_OUTPUT not found');
    const re = new Function('return ' + line.replace('const BUILD_OUTPUT = ', '').replace(/;$/, ''))();
    const bs = String.fromCharCode(92);
    assert.ok(re.test('C:' + bs + 'src' + bs + 'app' + bs + 'dist' + bs + 'win-unpacked' + bs + 'Sereno.exe'),
      'must match a Windows build-output path');
    assert.ok(re.test('/home/u/app/dist/win-unpacked/Sereno'), 'and a posix one');
    assert.ok(!re.test('C:' + bs + 'Program Files' + bs + 'Sereno' + bs + 'Sereno.exe'),
      'but not an installed path');
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

  /* ---- Phase 1 step 0b: StopFailure ---- */
  {
    const sf = (id, extra) => H('StopFailure', sid(id, extra));
    const running = (st) => feed(st, [H('PreToolUse', sid('x', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }))]);

    test('StopFailure: running -> idle, pending cleared, unknown fields ignored', () => {
      const s = new Store();
      running(s);
      assert.strictEqual(s.sessions.get('x').state, 'running');
      feed(s, [sf('x', { error: 'rate_limit', unknown_field: { a: 1 } })]);
      const r = s.sessions.get('x');
      assert.strictEqual(r.state, 'idle');
      assert.strictEqual(r._pending.size, 0);
      assert.strictEqual(r.stateTool, '');
    });

    test('StopFailure: leaves subagents alone and ignores a background_tasks list', () => {
      const s = new Store();
      feed(s, [
        H('PreToolUse', sid('x', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'u1' })),
        H('PreToolUse', sid('x', { agent_id: 'a2', agent_type: 'Plan', tool_name: 'Read', tool_use_id: 'u2' })),
      ]);
      running(s);
      feed(s, [sf('x')]);
      assert.strictEqual(s.sessions.get('x').subagents, 2);
      feed(s, [sf('x', { background_tasks: [] })]);
      assert.strictEqual(s.sessions.get('x').subagents, 2, 'an empty list must not prune');
      feed(s, [sf('x', { background_tasks: [bgTask('a1'), bgTask('a3')] })]);
      assert.deepStrictEqual([...s.sessions.get('x')._agents.keys()], ['a1', 'a2'], 'a list must not prune or add');
    });

    test('StopFailure: tagged is a no-op for top-level state and admits no ghost subagent', () => {
      const s = new Store();
      running(s);
      feed(s, [H('PreToolUse', sid('x', { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'u1' }))]);
      const r = s.sessions.get('x');
      const before = { state: r.state, tool: r.stateTool, since: r.stateSince, pending: r._pending.size };
      feed(s, [sf('x', { agent_id: 'a1' }), sf('x', { agent_id: 'never-seen' })]);
      assert.strictEqual(r.state, before.state);
      assert.strictEqual(r.stateTool, before.tool);
      assert.strictEqual(r.stateSince, before.since);
      assert.strictEqual(r._pending.size, before.pending);
      assert.deepStrictEqual([...r._agents.keys()], ['a1'], 'unseen agent_id must not become a subagent');
      assert.strictEqual(r.subagents, 1);
      assert.strictEqual(r._agents.get('a1').tool, 'Read', 'existing entry untouched');
    });

    test('StopFailure: never calls onBlocked; blocked -> idle, and a later prompt alerts again', () => {
      const s = new Store();
      const fired = [];
      s.onBlocked = (x) => fired.push(x);
      running(s);
      feed(s, [sf('x')]);
      assert.strictEqual(fired.length, 0, 'StopFailure alone must not alert');
      running(s);
      feed(s, [H('Notification', sid('x', { notification_type: 'permission_prompt' }))]);
      assert.strictEqual(fired.length, 1);
      feed(s, [sf('x')]);
      assert.strictEqual(s.sessions.get('x').state, 'idle');
      assert.strictEqual(s.sessions.get('x')._blockedNotified, false);
      assert.strictEqual(fired.length, 1, 'StopFailure must not alert');
      running(s);
      feed(s, [H('Notification', sid('x', { notification_type: 'permission_prompt' }))]);
      assert.strictEqual(fired.length, 2, 'a new permission prompt after StopFailure alerts again');
    });
  }

  /* ---- Phase 1 step 1: otlp.js ---- */
  {
    const otlp = require('../src/otlp.js');
    const logsFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-logs.json'), 'utf8'));
    const tracesFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-traces.json'), 'utf8'));
    const S = (k, v) => ({ key: k, value: { stringValue: v } });
    const I = (k, v) => ({ key: k, value: { intValue: v } });
    const D = (k, v) => ({ key: k, value: { doubleValue: v } });
    const wrapLog = (...recs) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: recs }] }] });
    const api = (extra) => ({ attributes: [S('event.name', 'api_request')].concat(extra) });
    const LOG_FIELDS = ['requestKey', 'requestId', 'sessionId', 'promptId', 'ts', 'model', 'querySource', 'source',
      'agentName', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costMicros', 'durationMs'];

    test('otlp: bad bodies and missing nested arrays give []', () => {
      for (const b of [null, undefined, 'x', 42, [], [{}], {}, { resourceLogs: 5 }, { resourceLogs: [null, 1] },
        { resourceLogs: [{}] }, { resourceLogs: [{ scopeLogs: [{}] }] }, { resourceLogs: [{ scopeLogs: [{ logRecords: 'no' }] }] }]) {
        assert.deepStrictEqual(otlp.parseLogs(b), []);
      }
      for (const b of [null, 'x', [], {}, { resourceSpans: [{ scopeSpans: [{}] }] }, { resourceSpans: [{ scopeSpans: [{ spans: {} }] }] }]) {
        assert.deepStrictEqual(otlp.parseTraces(b), []);
      }
    });

    test('otlp: a garbled attribute list skips that record only', () => {
      const out = otlp.parseLogs(wrapLog(
        { attributes: 'garbage' }, { attributes: { key: 'x' } }, null, 7,
        { attributes: [null, 5, { key: 3 }, { key: 'model' }, S('event.name', 'api_request'), S('request_id', 'ok1')] }));
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].requestKey, 'ok1');
      assert.deepStrictEqual(otlp.parseTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: 'bad' }] }] }] }), []);
    });

    test('otlp: fixture yields the 5 api_requests, user_prompt dropped', () => {
      const out = otlp.parseLogs(logsFx);
      assert.deepStrictEqual(out.map(r => r.requestId),
        ['req_main_1', 'req_sub_span', 'req_sub_nospan', 'req_aux_title', 'req_aux_suggest']);
      assert.deepStrictEqual(out.map(r => r.source), ['main', 'subagent', 'subagent', 'auxiliary', 'auxiliary']);
      const m = out[0];
      assert.strictEqual(m.sessionId, 'sess-fake-0001');
      assert.strictEqual(m.promptId, 'prompt-fake-01');
      assert.strictEqual(m.ts, 1790000001000);
      assert.strictEqual(m.cacheReadTokens, 900);
      assert.strictEqual(m.cacheCreationTokens, 30);
      assert.strictEqual(m.durationMs, 800);
      assert.strictEqual(out[1].agentName, 'general-purpose');
      assert.strictEqual(m.agentName, null);
    });

    test('otlp: string intValue parsed to a number', () => {
      const out = otlp.parseLogs(logsFx);
      assert.strictEqual(out[1].inputTokens, 2500);
      assert.strictEqual(typeof out[1].inputTokens, 'number');
    });

    test('otlp: costMicros is an integer on both paths', () => {
      const out = otlp.parseLogs(logsFx);
      assert.strictEqual(out[0].costMicros, 12345);          // micros wins over cost_usd
      assert.strictEqual(out[1].costMicros, 3100);           // 0.0031 * 1e6, rounded
      for (const r of out) assert.ok(Number.isInteger(r.costMicros));
      const f = otlp.parseLogs(wrapLog(api([S('request_id', 'a'), D('cost_usd', 0.1 + 0.2)])));
      assert.strictEqual(f[0].costMicros, 300000);
      const none = otlp.parseLogs(wrapLog(api([S('request_id', 'a')])));
      assert.strictEqual(none[0].costMicros, 0);
    });

    test('otlp: source mapping covers main, subagent and auxiliary', () => {
      const src = (qs) => otlp.parseLogs(wrapLog(api([S('request_id', 'r'), S('query_source', qs)])))[0].source;
      assert.strictEqual(src('repl_main_thread'), 'main');
      assert.strictEqual(src('agent:builtin:general-purpose'), 'subagent');
      assert.strictEqual(src('agent:custom'), 'subagent');
      assert.strictEqual(src('generate_session_title'), 'auxiliary');
      assert.strictEqual(src('prompt_suggestion'), 'auxiliary');
      assert.strictEqual(otlp.parseLogs(wrapLog(api([S('request_id', 'r')])))[0].source, 'auxiliary');
    });

    test('otlp: requestKey is request_id, else session.id:event.sequence', () => {
      const a = otlp.parseLogs(wrapLog(api([S('request_id', 'rq1'), S('session.id', 's'), I('event.sequence', 9)])));
      assert.strictEqual(a[0].requestKey, 'rq1');
      const b = otlp.parseLogs(wrapLog(api([S('session.id', 's9'), I('event.sequence', '12')])));
      assert.strictEqual(b[0].requestKey, 's9:12');
      assert.strictEqual(b[0].requestId, null);
      // no way to build a stable key: skipped rather than invented
      assert.deepStrictEqual(otlp.parseLogs(wrapLog(api([S('session.id', 's9')]))), []);
      assert.deepStrictEqual(otlp.parseLogs(wrapLog(api([I('event.sequence', 1)]))), []);
    });

    test('otlp: resource attributes are read, record wins; ts falls back to event.timestamp', () => {
      const body = { resourceLogs: [{ resource: { attributes: [S('session.id', 'res-s'), S('model', 'res-m')] },
        scopeLogs: [{ logRecords: [api([S('request_id', 'r'), S('model', 'rec-m'), S('event.timestamp', '2026-10-04T00:00:00.000Z')])] }] }] };
      const r = otlp.parseLogs(body)[0];
      assert.strictEqual(r.sessionId, 'res-s');
      assert.strictEqual(r.model, 'rec-m');
      assert.strictEqual(r.ts, Date.parse('2026-10-04T00:00:00.000Z'));
    });

    test('otlp: absent or unparseable numbers are 0, never NaN', () => {
      const r = otlp.parseLogs(wrapLog(api([S('request_id', 'r'), S('input_tokens', 'abc'), I('duration_ms', 'zz')])))[0];
      for (const k of ['ts', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costMicros', 'durationMs']) {
        assert.strictEqual(r[k], 0, k);
      }
    });

    test('otlp: other events are dropped', () => {
      const names = ['user_prompt', 'tool_result', 'assistant_response', 'tool_decision', 'hook_registered', 'subagent_completed'];
      const recs = names.map(n => ({ attributes: [S('event.name', n), S('request_id', 'x'), S('session.id', 's')] }));
      assert.deepStrictEqual(otlp.parseLogs(wrapLog(...recs)), []);
    });

    test('otlp: traces keep only llm_request spans, main span has agentId null', () => {
      const out = otlp.parseTraces(tracesFx);
      assert.strictEqual(out.length, 2);
      assert.deepStrictEqual(out[0], { requestId: 'req_main_1', sessionId: 'sess-fake-0001', agentId: null, ts: 1790000001000 });
      assert.deepStrictEqual(out[1], { requestId: 'req_sub_span', sessionId: 'sess-fake-0001', agentId: 'agentfake0000000a1', ts: 1790000002000 });
    });

    test('otlp: output carries exactly the documented keys', () => {
      for (const r of otlp.parseLogs(logsFx)) assert.deepStrictEqual(Object.keys(r), LOG_FIELDS);
      for (const s of otlp.parseTraces(tracesFx)) assert.deepStrictEqual(Object.keys(s), ['requestId', 'sessionId', 'agentId', 'ts']);
    });

    test('otlp: no identifier or prompt content survives parsing', () => {
      const raw = JSON.stringify(logsFx) + JSON.stringify(tracesFx);
      const secrets = ['fake.person@example.invalid', 'fake-user-id-0001', 'fake-acct-id-0002',
        '00000000-fake-0000-0000-account00001', 'fake-org-id-0003', 'fake-term', 'SERENO-CANARY-PROMPT'];
      for (const s of secrets) assert.ok(raw.includes(s), 'fixture must contain ' + s);
      const out = JSON.stringify(otlp.parseLogs(logsFx)) + JSON.stringify(otlp.parseTraces(tracesFx));
      for (const s of secrets) assert.ok(!out.includes(s), 'leaked ' + s);
      const spanOut = otlp.parseTraces({ resourceSpans: [{ scopeSpans: [{ spans: [{ attributes: [
        S('span.type', 'llm_request'), S('request_id', 'r'), S('model', 'm'), S('user.email', 'e@x')] }] }] }] });
      assert.deepStrictEqual(Object.keys(spanOut[0]), ['requestId', 'sessionId', 'agentId', 'ts']);
    });

    test('otlp: module does no I/O (requires nothing)', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'otlp.js'), 'utf8');
      assert.ok(!/\brequire\(/.test(src), 'otlp.js should require nothing');
      assert.ok(!/\bfetch\(|process\.std/.test(src));
    });
  }

  /* ---- Phase 1 step 2: ledger.js ---- */
  {
    const { openLedger, LedgerUnavailableError } = require('../src/ledger.js');
    const otlp = require('../src/otlp.js');
    const logsFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-logs.json'), 'utf8'));
    const tracesFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-traces.json'), 'utf8'));
    // shift fixture timestamps to "now" so prune-on-open never eats them as the calendar moves
    const BASE = Date.now() - 60000;
    const shiftReqs = () => otlp.parseLogs(logsFx).map((r, i) => Object.assign({}, r, { ts: BASE + i * 1000 }));
    const shiftSpans = () => otlp.parseTraces(tracesFx).map((s, i) => Object.assign({}, s, { ts: BASE + i * 1000 }));
    const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-ledger-')), 'sereno.db');
    const rmDir = f => fs.rmSync(path.dirname(f), { recursive: true, force: true });
    const mem = () => openLedger({ file: ':memory:' });
    const rq = (o) => Object.assign({ requestKey: 'k', requestId: 'r', sessionId: 's', promptId: null, ts: Date.now(),
      model: 'm', querySource: null, source: 'main', agentName: null, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 100, durationMs: 0 }, o);
    const row = (l, id) => l._db.prepare('SELECT * FROM requests WHERE request_id=?').get(id);

    test('ledger: LedgerUnavailableError is typed', () => {
      const e = new LedgerUnavailableError('x');
      assert.ok(e instanceof Error); assert.strictEqual(e.code, 'LEDGER_UNAVAILABLE');
    });

    test('ledger: WAL mode and user_version 1 on a file db', () => {
      const f = tmpFile();
      try {
        const l = openLedger({ file: f });
        assert.strictEqual(l._db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.strictEqual(l._db.prepare('PRAGMA user_version').get().user_version, 1);
        l.close();
      } finally { rmDir(f); }
    });

    test('ledger: default file lives under SERENO_HOME', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-ledger-home-'));
      const prev = process.env.SERENO_HOME;
      process.env.SERENO_HOME = dir;
      try {
        const l = openLedger();
        assert.strictEqual(l.file, path.join(dir, 'sereno.db'));
        l.close();
        assert.ok(fs.existsSync(path.join(dir, 'sereno.db')));
      } finally {
        if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('ledger: replaying the same fixtures twice leaves totals unchanged', () => {
      const l = mem();
      l.ingestRequests(shiftReqs()); l.ingestSpans(shiftSpans());
      const a = JSON.stringify(l.totals());
      l.ingestRequests(shiftReqs()); l.ingestSpans(shiftSpans());
      assert.strictEqual(JSON.stringify(l.totals()), a);
      const t = l.totals();
      assert.strictEqual(t.requests, 5);
      assert.strictEqual(t.costMicros, 12345 + 3100 + 777 + 500 + 7611);
      assert.strictEqual(t.byAttribution.explicit, 12345 + 3100 + 500 + 7611);
      assert.strictEqual(t.byAttribution.unknown, 777);
      assert.strictEqual(t.bySource.subagent, 3100 + 777);
      assert.ok(Number.isInteger(t.costMicros));
      l.close();
    });

    test('ledger: close + reopen preserves totals', () => {
      const f = tmpFile();
      try {
        const l = openLedger({ file: f });
        l.ingestRequests(shiftReqs()); l.ingestSpans(shiftSpans());
        const a = JSON.stringify(l.totals());
        l.close();
        const l2 = openLedger({ file: f });
        assert.strictEqual(JSON.stringify(l2.totals()), a);
        l2.close();
      } finally { rmDir(f); }
    });

    test('ledger: methods throw a clear error after close', () => {
      const l = mem(); l.close();
      assert.throws(() => l.totals(), /closed/);
    });

    test('ledger: request-before-span and span-before-request both end explicit with agent_id', () => {
      const l = mem();
      l.ingestRequests([rq({ requestKey: 'a', requestId: 'ra', source: 'subagent' })]);
      assert.strictEqual(row(l, 'ra').attribution, 'unknown');
      l.ingestSpans([{ requestId: 'ra', sessionId: 's', agentId: 'ag1', ts: 1 }]);
      assert.strictEqual(row(l, 'ra').attribution, 'explicit');
      assert.strictEqual(row(l, 'ra').agent_id, 'ag1');
      l.ingestSpans([{ requestId: 'rb', sessionId: 's', agentId: 'ag2', ts: 1 }]);
      l.ingestRequests([rq({ requestKey: 'b', requestId: 'rb', source: 'subagent' })]);
      assert.strictEqual(row(l, 'rb').attribution, 'explicit');
      assert.strictEqual(row(l, 'rb').agent_id, 'ag2');
      l.close();
    });

    test('ledger: subagent without span stays unknown; main-thread span does not change it', () => {
      const l = mem();
      l.ingestRequests([rq({ requestKey: 'a', requestId: 'ra', source: 'subagent' })]);
      l.ingestSpans([{ requestId: 'ra', sessionId: 's', agentId: null, ts: 1 }]);
      assert.strictEqual(row(l, 'ra').attribution, 'unknown');
      assert.strictEqual(row(l, 'ra').agent_id, null);
      l.ingestSpans([{ requestId: null, sessionId: 's', agentId: 'x', ts: 1 }]);
      assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM spans').get().n, 1);
      l.close();
    });

    test('ledger: spans never reassign an already-explicit row', () => {
      const l = mem();
      l.ingestRequests([rq({ requestKey: 'a', requestId: 'ra', source: 'main' })]);
      l.ingestSpans([{ requestId: 'ra', sessionId: 's', agentId: 'ag', ts: 1 }]);
      assert.strictEqual(row(l, 'ra').agent_id, null);
      assert.strictEqual(row(l, 'ra').attribution, 'explicit');
      l.close();
    });

    test('ledger: telemetry without hooks creates a session row; null session creates none', () => {
      const l = mem();
      l.ingestRequests(shiftReqs());
      const s = l._db.prepare('SELECT * FROM sessions').all();
      assert.strictEqual(s.length, 1);
      assert.strictEqual(s[0].session_id, 'sess-fake-0001');
      assert.strictEqual(s[0].first_seen, BASE);
      assert.strictEqual(s[0].last_seen, BASE + 4000);
      l.ingestRequests([rq({ requestKey: 'n', requestId: 'rn', sessionId: null })]);
      assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
      assert.strictEqual(l.totals().requests, 6);
      l.close();
    });

    test('ledger: SessionStart sets cwd/project/model; telemetry does not clobber them', () => {
      const l = mem();
      l.recordHook('SessionStart', { session_id: 's', cwd: 'C:\\work\\proj-a', model: 'opus' });
      l.ingestRequests([rq({ requestId: 'r1' })]);
      const s = l._db.prepare('SELECT * FROM sessions WHERE session_id=?').get('s');
      assert.strictEqual(s.cwd, 'C:\\work\\proj-a');
      assert.strictEqual(s.project, 'proj-a');
      assert.strictEqual(s.model, 'opus');
      assert.strictEqual(l.totals().sessions[0].project, 'proj-a');
      l.close();
    });

    test('ledger: recordHook ignores forbidden fields (canary absent from db and wal bytes)', () => {
      const f = tmpFile();
      try {
        const l = openLedger({ file: f });
        const canary = 'SERENO-CANARY-LEDGER-9f3a';
        const forbidden = { prompt: canary + 'p', tool_input: { command: canary + 'c' }, tool_response: canary + 'r',
          transcript_path: canary + 't', last_assistant_message: canary + 'm', user_email: canary + 'e' };
        l.recordHook('SessionStart', Object.assign({ session_id: 's', cwd: 'C:\\w\\p', model: 'm' }, forbidden));
        l.recordHook('SubagentStart', Object.assign({ session_id: 's', agent_id: 'a1', agent_type: 'builder' }, forbidden));
        l.recordHook('SubagentStop', Object.assign({ session_id: 's', agent_id: 'a1', agent_type: 'builder' }, forbidden));
        l.recordHook('UserPromptSubmit', Object.assign({ session_id: 's' }, forbidden));
        assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM agents').get().n, 1);
        l.close();
        for (const p of [f, f + '-wal']) {
          if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p).includes(canary), 'canary leaked into ' + p);
        }
      } finally { rmDir(f); }
    });

    test('ledger: agents upsert; resume clears stopped; stop for unseen id with empty type ignored', () => {
      const l = mem();
      l.recordHook('SubagentStop', { session_id: 's', agent_id: 'ghost', agent_type: '' });
      assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
      l.recordHook('SubagentStart', { session_id: 's', agent_id: 'a1', agent_type: 'builder' });
      let a = l._db.prepare('SELECT * FROM agents').get();
      assert.strictEqual(a.agent_type, 'builder'); assert.strictEqual(a.stopped, null);
      assert.ok(a.started > 0);
      l.recordHook('SubagentStop', { session_id: 's', agent_id: 'a1', agent_type: '' });
      a = l._db.prepare('SELECT * FROM agents').get();
      assert.ok(a.stopped > 0); assert.strictEqual(a.agent_type, 'builder');
      l.recordHook('SubagentStart', { session_id: 's', agent_id: 'a1', agent_type: 'builder' });
      assert.strictEqual(l._db.prepare('SELECT stopped FROM agents').get().stopped, null);
      l.close();
    });

    test('ledger: recordStatus stores micros and dedupes unchanged cost', () => {
      const l = mem();
      l.recordStatus('s', 1.234567, 1000);
      l.recordStatus('s', 1.234567, 2000);
      let st = l._db.prepare('SELECT * FROM status').get();
      assert.strictEqual(st.cost_micros, 1234567); assert.strictEqual(st.ts, 1000);
      l.recordStatus('s', 2, 3000);
      st = l._db.prepare('SELECT * FROM status').get();
      assert.strictEqual(st.cost_micros, 2000000); assert.strictEqual(st.ts, 3000);
      l.recordStatus('s', NaN, 4000);
      assert.strictEqual(l._db.prepare('SELECT ts FROM status').get().ts, 3000);
      l.close();
    });

    test('ledger: reconcile ok, lag (later request excluded), drift, and no-status cases', () => {
      const l = mem();
      assert.deepStrictEqual(l.reconcile('s'), { ledgerMicros: 0, statusMicros: null, deltaPct: null, ok: false });
      l.ingestRequests([rq({ requestKey: 'a', requestId: 'a', ts: 1000, costMicros: 600000 }),
        rq({ requestKey: 'b', requestId: 'b', ts: 2000, costMicros: 400000 })]);
      assert.strictEqual(l.reconcile('s').ledgerMicros, 1000000);
      assert.strictEqual(l.reconcile('s').ok, false);
      l.recordStatus('s', 1.0, 2000);
      assert.deepStrictEqual(l.reconcile('s'), { ledgerMicros: 1000000, statusMicros: 1000000, deltaPct: 0, ok: true });
      l.ingestRequests([rq({ requestKey: 'c', requestId: 'c', ts: 3000, costMicros: 900000 })]);
      assert.strictEqual(l.reconcile('s').ledgerMicros, 1000000, 'request after status.ts excluded');
      assert.strictEqual(l.reconcile('s').ok, true);
      l.recordStatus('s', 0.9, 4000);
      const d = l.reconcile('s');
      assert.strictEqual(d.deltaPct, 111.1); assert.strictEqual(d.ok, false);
      l.recordStatus('s', 1.019, 5000);
      const e = l.reconcile('s');
      assert.strictEqual(e.deltaPct, 86.5);
      l.close();
    });

    test('ledger: reconcile rounds deltaPct to 1 decimal and allows 2 percent', () => {
      const l = mem();
      l.ingestRequests([rq({ ts: 1, costMicros: 1000000 })]);
      l.recordStatus('s', 1.02, 10);
      const r = l.reconcile('s');
      assert.strictEqual(r.deltaPct, -2); assert.strictEqual(r.ok, true);
      l.recordStatus('s', 1.03, 11);
      const r2 = l.reconcile('s');
      assert.strictEqual(r2.deltaPct, -2.9); assert.strictEqual(r2.ok, false);
      l.close();
    });

    test('ledger: totals respects since (inclusive) and until (exclusive), sessions sorted desc', () => {
      const l = mem();
      l.ingestRequests([
        rq({ requestKey: 'a', requestId: 'a', sessionId: 's1', ts: 1000, costMicros: 10 }),
        rq({ requestKey: 'b', requestId: 'b', sessionId: 's2', ts: 2000, costMicros: 30 }),
        rq({ requestKey: 'c', requestId: 'c', sessionId: 's1', ts: 3000, costMicros: 5 })]);
      assert.strictEqual(l.totals({ since: 1000, until: 3000 }).costMicros, 40);
      assert.strictEqual(l.totals({ since: 2000 }).costMicros, 35);
      const t = l.totals();
      assert.deepStrictEqual(t.sessions.map(s => s.sessionId), ['s2', 's1']);
      assert.strictEqual(t.sessions[1].costMicros, 15);
      l.close();
    });

    test('ledger: prune removes old requests and spans, keeps sessions and recent rows', () => {
      const l = mem();
      const old = Date.now() - 100 * 86400000;
      l.ingestRequests([rq({ requestKey: 'o', requestId: 'o', ts: old }), rq({ requestKey: 'n', requestId: 'n', ts: Date.now() - 1000 })]);
      l.ingestSpans([{ requestId: 'o', sessionId: 's', agentId: 'a', ts: old }, { requestId: 'n', sessionId: 's', agentId: 'a', ts: Date.now() }]);
      l.prune();
      assert.strictEqual(l.totals().requests, 1);
      assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM spans').get().n, 1);
      assert.strictEqual(l._db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 1);
      l.prune(0);
      assert.strictEqual(l.totals().requests, 0);
      l.close();
    });

    test('ledger: ts 0 is stored as ingest time and survives close + reopen', () => {
      const f = tmpFile();
      try {
        const l = openLedger({ file: f });
        l.ingestRequests([rq({ requestKey: 'z', requestId: 'z', ts: 0, costMicros: 42 })]);
        l.ingestSpans([{ requestId: 'z', sessionId: 's', agentId: 'a', ts: 0 }]);
        assert.ok(l._db.prepare('SELECT ts FROM spans').get().ts > 0);
        l.close();
        const l2 = openLedger({ file: f });
        assert.strictEqual(l2.totals().costMicros, 42);
        l2.close();
      } finally { rmDir(f); }
    });

    test('ledger: retentionDays option drives prune-on-open; bad values fall back to 90', () => {
      const f = tmpFile();
      try {
        const l = openLedger({ file: f });
        const d = n => Date.now() - n * 86400000;
        l.ingestRequests([rq({ requestKey: 'a', requestId: 'a', ts: d(10) }), rq({ requestKey: 'b', requestId: 'b', ts: d(2) })]);
        l.close();
        for (const bad of [NaN, 0, -5, Infinity, undefined]) {
          const x = openLedger({ file: f, retentionDays: bad }); assert.strictEqual(x.totals().requests, 2); x.close();
        }
        const l3 = openLedger({ file: f, retentionDays: 5 });
        assert.strictEqual(l3.totals().requests, 1);
        l3.close();
      } finally { rmDir(f); }
    });

    test('ledger: schema has no prompt/response/command/tool_input/email columns', () => {
      const l = mem();
      const tables = l._db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      assert.deepStrictEqual(tables.sort(), ['agents', 'requests', 'sessions', 'spans', 'status']);
      for (const t of tables) {
        for (const c of l._db.prepare('PRAGMA table_info(' + t + ')').all()) {
          assert.ok(c.name === 'prompt_id' || !/prompt|response|command|tool_input|email/i.test(c.name), t + '.' + c.name);
        }
      }
      const idx = l._db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requests' AND name NOT LIKE 'sqlite_%'").all();
      assert.strictEqual(idx.length, 3);
      l.close();
    });
  }

  /* ---- Phase 1 step 3: collector /v1 ---- */
  {
    const zlib = require('node:zlib');
    const { openLedger } = require('../src/ledger.js');
    const logsFx = fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-logs.json'), 'utf8');
    const tracesFx = fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-traces.json'), 'utf8');
    const PORT = 8798;
    const rq = (opts, body) => new Promise((resolve) => {
      const r = http.request(Object.assign({ host: '127.0.0.1', port: PORT, agent: false }, opts), (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end(body);
    });
    const J = { 'content-type': 'application/json' };
    const postJ = (p, body, headers) => rq({ method: 'POST', path: p, headers: Object.assign({}, J, headers) }, body);
    const getJ = async (p) => JSON.parse((await rq({ method: 'GET', path: p })).body);
    const start = async (ledger) => {
      const st = new Store();
      const c = createCollector(st, PORT, { ledger });
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      return { st, c };
    };
    const stop = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });

    await atest('collector /v1: fixtures posted twice leave totals unchanged', async () => {
      const ledger = openLedger({ file: ':memory:' });
      const { c } = await start(ledger);
      try {
        for (let i = 0; i < 2; i++) {
          const a = await postJ('/v1/logs', logsFx);
          assert.strictEqual(a.status, 200); assert.strictEqual(a.body, '{}');
          assert.strictEqual((await postJ('/v1/traces', tracesFx)).status, 200);
          if (i === 0) {
            const t1 = await getJ('/ledger/summary');
            assert.strictEqual(t1.enabled, true);
            assert.strictEqual(t1.requests, 5);
            assert.ok(t1.costMicros > 0);
          }
        }
        const t2 = await getJ('/ledger/summary');
        assert.strictEqual(t2.requests, 5);
        assert.strictEqual(t2.costMicros, ledger.totals().costMicros);
        const none = await getJ('/ledger/summary?since=' + (Date.now() + 1e9) + '&until=bogus');
        assert.strictEqual(none.requests, 0);
      } finally { await stop(c); ledger.close(); }
    });

    await atest('collector /v1: Host 403, Origin 403, text/plain and protobuf 415', async () => {
      const ledger = openLedger({ file: ':memory:' });
      const { c } = await start(ledger);
      try {
        assert.strictEqual((await rq({ method: 'POST', path: '/v1/logs', headers: Object.assign({ host: 'evil.example' }, J) }, logsFx)).status, 403);
        assert.strictEqual((await postJ('/v1/logs', logsFx, { origin: 'https://evil.example' })).status, 403);
        assert.strictEqual((await rq({ method: 'GET', path: '/ledger/summary', headers: { host: 'evil.example' } })).status, 403);
        const t = await rq({ method: 'POST', path: '/v1/logs', headers: { 'content-type': 'text/plain' } }, logsFx);
        assert.strictEqual(t.status, 415);
        const pb = await rq({ method: 'POST', path: '/v1/logs', headers: { 'content-type': 'application/x-protobuf' } }, Buffer.from([1, 2, 3]));
        assert.strictEqual(pb.status, 415);
        assert.ok(/protobuf/i.test(pb.body));
        assert.strictEqual(ledger.totals().requests, 0, 'rejected requests must not write');
      } finally { await stop(c); ledger.close(); }
    });

    await atest('collector /v1: gzip accepted, charset suffix allowed, bad gzip and bad json 400', async () => {
      const ledger = openLedger({ file: ':memory:' });
      const { c } = await start(ledger);
      try {
        const gz = await postJ('/v1/logs', zlib.gzipSync(logsFx), { 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip' });
        assert.strictEqual(gz.status, 200);
        assert.strictEqual(ledger.totals().requests, 5);
        assert.strictEqual((await postJ('/v1/logs', 'not gzip', { 'content-encoding': 'gzip' })).status, 400);
        assert.strictEqual((await postJ('/v1/logs', '{nope')).status, 400);
        assert.strictEqual((await postJ('/v1/logs', '{"hello":1}')).status, 200, 'valid json without records is fine');
        assert.strictEqual((await postJ('/v1/logs', '{}', { 'content-encoding': 'br' })).status, 415);
        assert.strictEqual((await rq({ method: 'POST', path: '/v1/metrics', headers: J }, '{}')).status, 404);
      } finally { await stop(c); ledger.close(); }
    });

    await atest('collector /v1: oversized raw body is 413', async () => {
      const { c } = await start(openLedger({ file: ':memory:' }));
      try {
        const big = Buffer.alloc(8 * 1024 * 1024 + 1024, 32);
        const r = await rq({ method: 'POST', path: '/v1/logs', headers: Object.assign({ 'content-length': big.length }, J) }, big);
        assert.ok(r.status === 413 || r.status === 0, 'got ' + r.status);
      } finally { await stop(c); }
    });

    await atest('collector /v1: a throwing ledger gives 503 so the exporter retries', async () => {
      const boom = () => { throw new Error('disk full'); };
      const { c } = await start({ ingestRequests: boom, ingestSpans: boom, totals: boom });
      try {
        assert.strictEqual((await postJ('/v1/logs', logsFx)).status, 503);
        assert.strictEqual((await postJ('/v1/traces', tracesFx)).status, 503);
        assert.strictEqual((await rq({ method: 'GET', path: '/ledger/summary' })).status, 503);
      } finally { await stop(c); }
    });

    await atest('collector /v1: ledger off accepts and drops; summary says disabled', async () => {
      const { c } = await start(null);
      try {
        const r = await postJ('/v1/logs', logsFx);
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body, '{}');
        assert.strictEqual((await postJ('/v1/traces', tracesFx)).status, 200);
        assert.deepStrictEqual(await getJ('/ledger/summary'), { enabled: false });
      } finally { await stop(c); }
    });

    await atest('collector: /hook and /status feed the ledger; a throwing ledger never affects them', async () => {
      const calls = [];
      const stub = { recordHook: (e, p) => calls.push(['hook', e, p.session_id]), recordStatus: (s, usd) => calls.push(['status', s, usd]) };
      const a = await start(stub);
      try {
        assert.strictEqual((await postJ('/hook', JSON.stringify({ event: 'SessionStart', payload: sid('lg1', {}) }))).status, 204);
        assert.strictEqual((await postJ('/status', JSON.stringify({ payload: sid('lg1', { cost: { total_cost_usd: 1.25 } }) }))).status, 204);
        await new Promise((r) => setTimeout(r, 30));
        assert.deepStrictEqual(calls, [['hook', 'SessionStart', 'lg1'], ['status', 'lg1', 1.25]]);
      } finally { await stop(a.c); }
      const boom = () => { throw new Error('ledger down'); };
      const b = await start({ recordHook: boom, recordStatus: boom });
      try {
        assert.strictEqual((await postJ('/hook', JSON.stringify({ event: 'PreToolUse', payload: sid('lg2', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' }) }))).status, 204);
        assert.strictEqual((await postJ('/status', JSON.stringify({ payload: sid('lg2', { cost: { total_cost_usd: 2 } }) }))).status, 204);
        await new Promise((r) => setTimeout(r, 30));
        const s = b.st.snapshot().sessions.find((x) => x.id === 'lg2');
        assert.ok(s, 'store must still update'); assert.strictEqual(s.costUsd, 2);
      } finally { await stop(b.c); }
    });
  }

  /* ---- Phase 1 step 4: config + ledger lifecycle ---- */
  {
    const cfgMod = require('../src/config.js');
    const life = require('../src/ledger-life.js');
    const { LedgerUnavailableError } = require('../src/ledger.js');
    const withHome = (fn) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-life-'));
      const prev = process.env.SERENO_HOME;
      process.env.SERENO_HOME = dir;
      try { return fn(dir); } finally {
        if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const rawCfg = (dir, o) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(o));

    test('config: no ledger key reads as not-asked with 90 days', () => withHome(() => {
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: null, retentionDays: 90 });
    }));

    test('config: ledger is validated on read', () => withHome((dir) => {
      rawCfg(dir, { ledger: { enabled: 'yes', retentionDays: -5 } });
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: null, retentionDays: 90 });
      rawCfg(dir, { ledger: { enabled: 1, retentionDays: 'x' } });
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: null, retentionDays: 90 });
      rawCfg(dir, { ledger: { enabled: false, retentionDays: 30 } });
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: false, retentionDays: 30 });
      rawCfg(dir, { ledger: 'garbage' });
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: null, retentionDays: 90 });
    }));

    test('config: patching ledger.enabled keeps retentionDays and unrelated writes keep ledger', () => withHome((dir) => {
      rawCfg(dir, { ledger: { enabled: null, retentionDays: 30 } });
      assert.deepStrictEqual(cfgMod.write({ ledger: { enabled: true } }).ledger, { enabled: true, retentionDays: 30 });
      cfgMod.write({ autoLaunch: true });
      assert.deepStrictEqual(cfgMod.read().ledger, { enabled: true, retentionDays: 30 });
      assert.strictEqual(cfgMod.read().autoLaunch, true);
      cfgMod.write({ ledger: { enabled: 'bogus' } });
      assert.strictEqual(cfgMod.read().ledger.enabled, null);
    }));

    test('opt-in: Yes/Not now map to true/false, dismissal stays null', () => {
      assert.deepStrictEqual(life.OPT_IN_BUTTONS, ['Yes', 'Not now']);
      assert.strictEqual(life.optInAnswer(0), true);
      assert.strictEqual(life.optInAnswer(1), false);
      assert.strictEqual(life.optInAnswer(2), null);
      assert.strictEqual(life.optInAnswer(-1), null);
      assert.strictEqual(life.optInAnswer(undefined), null);
    });

    test('startLedger: null or false opens nothing and creates no database file', () => withHome((dir) => {
      for (const enabled of [null, false]) {
        let opened = 0;
        const r = life.startLedger({ ledger: { enabled, retentionDays: 90 } }, { open: () => { opened++; } });
        assert.deepStrictEqual(r, { ledger: null, unavailable: false });
        assert.strictEqual(opened, 0);
      }
      // The real opener too: still nothing on disk.
      assert.strictEqual(life.startLedger({ ledger: { enabled: null, retentionDays: 90 } }).ledger, null);
      for (const f of ['sereno.db', 'sereno.db-wal', 'sereno.db-shm']) {
        assert.ok(!fs.existsSync(path.join(dir, f)), f + ' must not exist');
      }
    }));

    test('startLedger: enabled opens the real ledger; close leaves an empty WAL', () => withHome((dir) => {
      const r = life.startLedger({ ledger: { enabled: true, retentionDays: 30 } });
      assert.strictEqual(r.unavailable, false);
      assert.ok(r.ledger);
      assert.ok(fs.existsSync(path.join(dir, 'sereno.db')));
      r.ledger.close();
      const wal = path.join(dir, 'sereno.db-wal');
      assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'wal checkpointed');
    }));

    test('startLedger: retentionDays is passed to open', () => {
      let got = null;
      life.startLedger({ ledger: { enabled: true, retentionDays: 7 } }, { open: (o) => { got = o; return {}; } });
      assert.strictEqual(got.retentionDays, 7);
    });

    test('startLedger: open failure is logged once and reported unavailable', () => {
      for (const err of [new LedgerUnavailableError('no sqlite'), new Error('disk full')]) {
        const logged = [];
        const r = life.startLedger({ ledger: { enabled: true, retentionDays: 90 } },
          { open: () => { throw err; }, error: (m) => logged.push(m) });
        assert.deepStrictEqual(r, { ledger: null, unavailable: true });
        assert.strictEqual(logged.length, 1);
        assert.ok(logged[0].includes(err.message));
      }
    });

    await atest('collector.setLedger: /ledger/summary flips at runtime without a restart', async () => {
      const { openLedger } = require('../src/ledger.js');
      const PORT = 8799;
      const get = () => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/ledger/summary', agent: false }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d)));
        });
      });
      const c = createCollector(new Store(), PORT);
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      const l = openLedger({ file: ':memory:' });
      try {
        assert.deepStrictEqual(await get(), { enabled: false });
        c.setLedger(l);
        assert.strictEqual((await get()).enabled, true);
        c.setLedger(null);
        assert.deepStrictEqual(await get(), { enabled: false });
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); l.close(); }
    });
  }

  /* ---- Phase 1 step 5: telemetry wiring ---- */
  {
    const withTmp = (initial, fn) => {
      const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-tw-claude-'));
      const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-tw-home-'));
      const prevC = process.env.CLAUDE_CONFIG_DIR; const prevH = process.env.SERENO_HOME;
      process.env.CLAUDE_CONFIG_DIR = cdir; process.env.SERENO_HOME = hdir;
      const file = path.join(cdir, 'settings.json');
      if (initial !== null) fs.writeFileSync(file, initial);
      try { return fn({ file, cdir, hdir }); } finally {
        if (prevC === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevC;
        if (prevH === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prevH;
        fs.rmSync(cdir, { recursive: true, force: true }); fs.rmSync(hdir, { recursive: true, force: true });
      }
    };
    const noLogKeys = (file) => {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(!Object.keys(s.env || {}).some((k) => /^OTEL_LOG_/.test(k)), 'OTEL_LOG_* key written');
    };
    const nBackups = (cdir) => fs.readdirSync(cdir).filter((f) => f.includes('.bak.')).length;

    test('wireTelemetry merges env, preserving unrelated env keys and settings, with a backup', () => withTmp(
      JSON.stringify({ theme: 'dark', env: { FOO: 'bar' } }, null, 2) + '\n', ({ file, cdir }) => {
        const r = wiring.wireTelemetry({ traces: true });
        assert.strictEqual(r.conflict, null);
        assert.ok(r.backup && fs.existsSync(r.backup));
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(s.theme, 'dark');
        assert.deepStrictEqual(s.env, Object.assign({ FOO: 'bar' }, {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp',
          OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:8787',
          OTEL_TRACES_EXPORTER: 'otlp', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
        }));
        noLogKeys(file);
        assert.strictEqual(nBackups(cdir), 1);
      }));

    test('wireTelemetry is idempotent: second call makes no backup and no change', () => withTmp('{}\n', ({ file, cdir }) => {
      wiring.wireTelemetry();
      const bytes = fs.readFileSync(file, 'utf8');
      const r = wiring.wireTelemetry();
      assert.deepStrictEqual(r.changes, []);
      assert.strictEqual(r.backup, null);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), bytes);
      assert.strictEqual(nBackups(cdir), 1);
      noLogKeys(file);
    }));

    test('wireTelemetry conflict: a different OTEL value changes nothing at all', () => {
      const orig = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://corp.example' } }) + '\n';
      withTmp(orig, ({ file, cdir, hdir }) => {
        const r = wiring.wireTelemetry();
        assert.deepStrictEqual(r.conflict, ['OTEL_EXPORTER_OTLP_ENDPOINT']);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), orig);
        assert.strictEqual(nBackups(cdir), 0);
        assert.ok(!fs.existsSync(path.join(hdir, 'wired.json')));
        assert.ok(/OTEL_EXPORTER_OTLP_ENDPOINT/.test(wiring.conflictMessage(r.conflict)));
      });
    });

    test('wireTelemetry conflict: foreign OTEL_* keys we do not set (incl. OTEL_LOG_*) also block', () => {
      for (const key of ['OTEL_METRICS_EXPORTER', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_LOG_USER_PROMPTS']) {
        const orig = JSON.stringify({ env: { [key]: '1' } }) + '\n';
        withTmp(orig, ({ file, cdir }) => {
          assert.deepStrictEqual(wiring.wireTelemetry().conflict, [key]);
          assert.strictEqual(fs.readFileSync(file, 'utf8'), orig);
          assert.strictEqual(nBackups(cdir), 0);
        });
      }
    });

    test('wireTelemetry: traces:false omits the two trace keys', () => withTmp('{}\n', ({ file }) => {
      wiring.wireTelemetry({ traces: false });
      const env = JSON.parse(fs.readFileSync(file, 'utf8')).env;
      assert.ok(!('OTEL_TRACES_EXPORTER' in env));
      assert.ok(!('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA' in env));
      assert.strictEqual(env.OTEL_LOGS_EXPORTER, 'otlp');
      noLogKeys(file);
    }));

    test('wireTelemetry: creates settings.json when absent; dryRun writes nothing', () => withTmp(null, ({ file, hdir }) => {
      const d = wiring.wireTelemetry({ dryRun: true });
      assert.ok(d.dryRun && d.changes.length);
      assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(hdir, 'wired.json')));
      wiring.wireTelemetry();
      assert.ok(fs.existsSync(file));
      noLogKeys(file);
    }));

    test('unwireTelemetry removes ours, keeps a user-changed key and unrelated keys, clears the record', () => withTmp(
      JSON.stringify({ theme: 'dark', env: { FOO: 'bar' } }) + '\n', ({ file, hdir }) => {
        wiring.wireTelemetry();
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        s.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://mine.example';
        fs.writeFileSync(file, JSON.stringify(s));
        const r = wiring.unwireTelemetry();
        assert.deepStrictEqual(r.kept, ['OTEL_EXPORTER_OTLP_ENDPOINT']);
        const after = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepStrictEqual(after.env, { FOO: 'bar', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://mine.example' });
        assert.strictEqual(after.theme, 'dark');
        assert.ok(!('telemetry' in JSON.parse(fs.readFileSync(path.join(hdir, 'wired.json'), 'utf8'))));
        noLogKeys(file);
      }));

    test('unwireTelemetry drops an emptied env; a pre-existing identical key is not ours to remove', () => {
      withTmp('{}\n', ({ file }) => {
        wiring.wireTelemetry();
        wiring.unwireTelemetry();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
      });
      withTmp(JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }), ({ file }) => {
        wiring.wireTelemetry();
        wiring.unwireTelemetry();
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).env, { CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
      });
    });

    test('unwireTelemetry with no wired.json record removes nothing and says so', () => {
      const orig = JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'otlp' } }) + '\n';
      withTmp(orig, ({ file }) => {
        const r = wiring.unwireTelemetry();
        assert.strictEqual(r.recorded, false);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), orig);
      });
    });

    test('wired.json keeps the shim ledger keys when telemetry is recorded and cleared', () => withTmp('{}\n', ({ hdir }) => {
      const rec = path.join(hdir, 'wired.json');
      fs.writeFileSync(rec, JSON.stringify({ shims: ['c:/x/emit.js'] }));
      wiring.wireTelemetry();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(rec, 'utf8')).shims, ['c:/x/emit.js']);
      wiring.unwireTelemetry();
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(rec, 'utf8')), { shims: ['c:/x/emit.js'] });
    }));

    test('wire() after wireTelemetry keeps the telemetry record; unwireTelemetry still removes our keys', () => withTmp('{}\n', ({ file, hdir }) => {
      wiring.wireTelemetry();
      wiring.wire(wiring.buildCommands({ packaged: false, emitJsPath: 'C:/x/bin/emit.js' }));
      const rec = JSON.parse(fs.readFileSync(path.join(hdir, 'wired.json'), 'utf8'));
      assert.ok(rec.telemetry && rec.shims.length === 1, 'record or shims lost');
      const r = wiring.unwireTelemetry();
      assert.ok(r.recorded && r.removed.length === 6);
      assert.ok(!('env' in JSON.parse(fs.readFileSync(file, 'utf8'))));
    }));

    test('wireTelemetry after wire() keeps the shims', () => withTmp('{}\n', ({ hdir }) => {
      wiring.wire(wiring.buildCommands({ packaged: false, emitJsPath: 'C:/x/bin/emit.js' }));
      wiring.wireTelemetry();
      const rec = JSON.parse(fs.readFileSync(path.join(hdir, 'wired.json'), 'utf8'));
      assert.deepStrictEqual(rec.shims, ['c:/x/bin/emit.js']);
      assert.ok(rec.telemetry);
    }));

    test('CLI: wire --telemetry wires env only; unwire --telemetry reverses; plain unwire still restores bytes', () => withTmp(
      '{\n  "theme": "dark"\n}\n', ({ file, cdir, hdir }) => {
        const orig = fs.readFileSync(file, 'utf8');
        const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: cdir, SERENO_HOME: hdir });
        const run = (script, args) => execFileSync(process.execPath, [path.join(ROOT, 'tools', script)].concat(args), { env, encoding: 'utf8' });
        run('wire.js', ['--telemetry', '--dry-run', '--yes']);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), orig, 'dry-run wrote');
        run('wire.js', ['--telemetry', '--yes']);
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(s.env.OTEL_LOGS_EXPORTER && !s.hooks && !s.statusLine, 'telemetry flag must not wire hooks');
        noLogKeys(file);
        run('unwire.js', ['--telemetry']);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });
        run('wire.js', ['--telemetry', '--yes']);
        run('unwire.js', ['--yes']);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), orig, 'plain unwire must restore the newest backup byte for byte');
      }));
  }

  /* ---- [ledger exit] ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const life = require('../src/ledger-life.js');
    const otlp = require('../src/otlp.js');
    const fxDir = path.join(__dirname, 'fixtures');
    const logsRaw = fs.readFileSync(path.join(fxDir, 'otlp-logs.json'), 'utf8');
    const tracesRaw = fs.readFileSync(path.join(fxDir, 'otlp-traces.json'), 'utf8');
    const PORT = 8800;
    const rq = (opts, body) => new Promise((resolve) => {
      const r = http.request(Object.assign({ host: '127.0.0.1', port: PORT, agent: false }, opts), (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end(body);
    });
    const post = (p, body) => rq({ method: 'POST', path: p, headers: { 'content-type': 'application/json' } }, typeof body === 'string' ? body : JSON.stringify(body));
    const start = async (ledger) => {
      const c = createCollector(new Store(), PORT, { ledger });
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      return c;
    };
    const stop = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });
    const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-exit-'));
    const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true });
    const open = (file) => openLedger({ file, retentionDays: 36500 });   // fixtures are dated; never prune them
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const withHome = async (fn) => {
      const dir = tmpDir(); const prev = process.env.SERENO_HOME;
      process.env.SERENO_HOME = dir;
      try { return await fn(dir); } finally {
        if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
        rmDir(dir);
      }
    };
    // every identifier value in a fixture, collected from its JSON rather than hard-coded
    const ID_KEYS = new Set(['user.email', 'user.account_id', 'user.account_uuid', 'user.id', 'organization.id']);
    const idValues = (...raws) => {
      const out = new Set();
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== 'object') return;
        if (ID_KEYS.has(v.key) && v.value && typeof v.value.stringValue === 'string') out.add(v.value.stringValue);
        Object.values(v).forEach(walk);
      };
      raws.forEach((r) => walk(JSON.parse(r)));
      return [...out];
    };
    const reqs = () => otlp.parseLogs(JSON.parse(logsRaw));
    const spans = () => otlp.parseTraces(JSON.parse(tracesRaw));
    const sessionIds = () => {
      const ids = new Set();
      for (const r of reqs()) if (r.sessionId) ids.add(r.sessionId);
      for (const s of spans()) { if (s.sessionId) ids.add(s.sessionId); if (s.agentId) ids.add(s.agentId); }
      return [...ids];
    };

    test('ledger exit 1: replaying the same OTLP input twice leaves every total unchanged', () => {
      const l = openLedger({ file: ':memory:', retentionDays: 36500 });
      l.ingestRequests(reqs()); l.ingestSpans(spans());
      const first = l.totals();
      assert.strictEqual(first.requests, 5);
      assert.ok(first.costMicros > 0);
      l.ingestRequests(reqs()); l.ingestSpans(spans());
      assert.deepStrictEqual(l.totals(), first);
      l.close();
    });

    test('ledger exit 2: closing and reopening the ledger preserves spend', () => {
      const d = tmpDir(); const file = path.join(d, 'sereno.db');
      try {
        const a = open(file);
        a.ingestRequests(reqs()); a.ingestSpans(spans());
        const before = a.totals();
        assert.ok(before.costMicros > 0);
        a.close();
        const b = open(file);
        assert.deepStrictEqual(b.totals(), before);
        b.close();
      } finally { rmDir(d); }
    });

    test('ledger exit 3: telemetry with no hooks still creates a session row', () => {
      const l = openLedger({ file: ':memory:', retentionDays: 36500 });
      l.ingestRequests(reqs());
      const sid = reqs()[0].sessionId;
      assert.ok(l._db.prepare('SELECT session_id FROM sessions WHERE session_id=?').get(sid), 'session row missing');
      assert.strictEqual(l.totals().sessions.length, 1);
      l.close();
    });

    await atest('ledger exit 4: an unmatched subagent request stays unknown across re-posts, a main-thread span and reopen', async () => {
      const d = tmpDir(); const file = path.join(d, 'sereno.db');
      let l = open(file);
      const c = await start(l);
      const want = { attribution: 'unknown', agent_id: null };
      const get = (lg) => Object.assign({}, lg._db.prepare("SELECT attribution, agent_id FROM requests WHERE request_id='req_sub_nospan'").get());
      try {
        assert.strictEqual((await post('/v1/logs', logsRaw)).status, 200);
        assert.strictEqual((await post('/v1/traces', tracesRaw)).status, 200);
        assert.deepStrictEqual(get(l), want);
        assert.strictEqual((await post('/v1/traces', tracesRaw)).status, 200);
        l.ingestSpans([{ requestId: 'req_sub_nospan', sessionId: reqs()[0].sessionId, agentId: null, ts: 1790000003000 }]);
        assert.deepStrictEqual(get(l), want);
        await stop(c); l.close();
        l = open(file);
        assert.deepStrictEqual(get(l), want);
        assert.strictEqual(l.totals().byAttribution.unknown, 777);
      } finally { try { l.close(); } catch (_) { /* already closed */ } rmDir(d); }
    });

    await atest('ledger exit 5: raw sereno.db, -wal and -shm never contain identifiers, prompts or tool inputs', async () => {
      const d = tmpDir(); const file = path.join(d, 'sereno.db');
      const ids = idValues(logsRaw, tracesRaw);
      assert.ok(ids.length >= 5, 'expected the fixtures to carry >= 5 identifier values, got ' + ids.length);
      const needles = ids.concat(['SERENO-CANARY-PROMPT', 'SERENO-CANARY-TOOLINPUT']);
      const scan = (when) => {
        for (const suffix of ['', '-wal', '-shm']) {
          const f = file + suffix;
          if (!fs.existsSync(f)) continue;
          const bytes = fs.readFileSync(f);
          for (const n of needles) {
            assert.ok(!bytes.includes(Buffer.from(n, 'utf8')), when + ': ' + path.basename(f) + ' contains a forbidden value (' + n.slice(0, 6) + '...)');
            assert.ok(!bytes.includes(Buffer.from(n, 'utf16le')), when + ': ' + path.basename(f) + ' contains a utf16 forbidden value');
          }
        }
      };
      const l = open(file);
      const c = await start(l);
      try {
        const sid = reqs()[0].sessionId;
        assert.strictEqual((await post('/v1/logs', logsRaw)).status, 200);
        assert.strictEqual((await post('/v1/traces', tracesRaw)).status, 200);
        assert.strictEqual((await post('/hook', { event: 'SessionStart', payload: { session_id: sid, cwd: 'C:\\work\\proj', model: 'm' } })).status, 204);
        assert.strictEqual((await post('/hook', { event: 'UserPromptSubmit', payload: { session_id: sid, prompt: 'SERENO-CANARY-PROMPT' } })).status, 204);
        assert.strictEqual((await post('/hook', { event: 'PreToolUse', payload: { session_id: sid, tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo SERENO-CANARY-TOOLINPUT' } } })).status, 204);
        assert.strictEqual((await post('/status', { payload: { session_id: sid, cost: { total_cost_usd: 0.0243 } } })).status, 204);
        await wait(80);
        assert.ok(l._db.prepare('SELECT COUNT(*) n FROM sessions').get().n >= 1);
        scan('while open');
        await stop(c); l.close();
        scan('after close');
      } finally { try { l.close(); } catch (_) { /* closed */ } rmDir(d); }
    });

    await atest('ledger exit 6: ledger disabled (null and false) never creates a database file', async () => {
      for (const enabled of [null, false]) {
        await withHome(async (dir) => {
          const r = life.startLedger({ ledger: { enabled, retentionDays: 90 } });
          assert.strictEqual(r.ledger, null);
          const c = await start(r.ledger);
          try {
            assert.strictEqual((await post('/v1/logs', logsRaw)).status, 200);
            assert.strictEqual((await post('/v1/traces', tracesRaw)).status, 200);
            assert.strictEqual((await post('/hook', { event: 'SessionStart', payload: { session_id: 'x', cwd: 'C:\\w' } })).status, 204);
            assert.strictEqual((await post('/status', { payload: { session_id: 'x', cost: { total_cost_usd: 1 } } })).status, 204);
            await wait(50);
          } finally { await stop(c); }
          const found = fs.readdirSync(dir).filter((f) => /^sereno\.db/.test(f));
          assert.deepStrictEqual(found, [], 'enabled=' + enabled + ' created ' + found.join(','));
        });
      }
    });

    test('replay --otlp --fixtures exits 0, is idempotent and prints no identifiers', () => {
      const home = tmpDir();
      try {
        const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'replay.js'), '--otlp', '--fixtures'],
          { env: Object.assign({}, process.env, { SERENO_HOME: home }), encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('replay idempotent: yes'));
        assert.ok(/est\. \$/.test(r.stdout), 'dollar figure must be labelled est.');
        const forbidden = idValues(logsRaw, tracesRaw).concat(sessionIds());
        assert.ok(forbidden.length >= 7);
        for (const v of forbidden) assert.ok(!r.stdout.includes(v), 'stdout leaked ' + v.slice(0, 6) + '...');
        assert.deepStrictEqual(fs.readdirSync(home), [], 'replay must not touch SERENO_HOME');
      } finally { rmDir(home); }
    });
  }
  /* ---- Phase 1: red-team fixes ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const tmpF = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-rt-')), 'sereno.db');
    const rmF = f => fs.rmSync(path.dirname(f), { recursive: true, force: true });
    const mkReq = (o) => Object.assign({ requestKey: 'k', requestId: 'r', sessionId: 's', promptId: null, ts: Date.now(),
      model: 'm', querySource: null, source: 'main', agentName: null, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 100, durationMs: 0 }, o);

    test('ledger: two handles on one file both open and ingest, totals agree', () => {
      const f = tmpF();
      try {
        const a = openLedger({ file: f });
        const b = openLedger({ file: f });
        a.ingestRequests([mkReq({ requestKey: 'k1', requestId: 'r1', costMicros: 100 })]);
        b.ingestRequests([mkReq({ requestKey: 'k2', requestId: 'r2', costMicros: 250 })]);
        for (const h of [a, b]) assert.strictEqual(Number(h._db.prepare('PRAGMA busy_timeout').get().timeout), 2000);
        assert.strictEqual(a.totals().costMicros, 350);
        assert.strictEqual(b.totals().costMicros, 350);
        a.close(); b.close();
      } finally { rmF(f); }
    });

    test('ledger prune: old session with status and agents is fully removed, recent kept', () => {
      const f = tmpF();
      try {
        const l = openLedger({ file: f });
        const old = Date.now() - 200 * 86400000, now = Date.now();
        const ins = (sql, ...a) => l._db.prepare(sql).run(...a);
        for (const [id, t] of [['old', old], ['new', now]]) {
          ins('INSERT INTO sessions (session_id, first_seen, last_seen) VALUES (?,?,?)', id, t, t);
          ins('INSERT INTO agents (session_id, agent_id, agent_type, started, stopped) VALUES (?,?,?,?,NULL)', id, 'a1', 't', t);
          ins('INSERT INTO status (session_id, ts, cost_micros) VALUES (?,?,?)', id, t, 5);
        }
        ins('INSERT INTO agents (session_id, agent_id, agent_type, started, stopped) VALUES (?,?,?,?,?)', 'new', 'a2', 't', old, old);
        l.prune(90);
        const n = (t, id) => l._db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE session_id=?`).get(id).c;
        for (const t of ['sessions', 'agents', 'status']) { assert.strictEqual(n(t, 'old'), 0, t); assert.strictEqual(n(t, 'new'), t === 'agents' ? 1 : 1, t); }
        assert.deepStrictEqual(l.reconcile('old'), { ledgerMicros: 0, statusMicros: null, deltaPct: null, ok: false });
        assert.strictEqual(l.reconcile('new').statusMicros, 5);
        l.close();
      } finally { rmF(f); }
    });

    const twTmp = (initial, fn) => {
      const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-rt-claude-'));
      const hdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-rt-home-'));
      const prevC = process.env.CLAUDE_CONFIG_DIR; const prevH = process.env.SERENO_HOME;
      process.env.CLAUDE_CONFIG_DIR = cdir; process.env.SERENO_HOME = hdir;
      const file = path.join(cdir, 'settings.json');
      if (initial !== null) fs.writeFileSync(file, initial);
      try { return fn({ file, cdir, hdir }); } finally {
        if (prevC === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevC;
        if (prevH === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prevH;
        fs.rmSync(cdir, { recursive: true, force: true }); fs.rmSync(hdir, { recursive: true, force: true });
      }
    };

    test('wireTelemetry: a non-object env (array, string, number, null) is a conflict; file untouched, no backup', () => {
      for (const bad of [[1, 2], 'x', 7, null]) {
        const raw = JSON.stringify({ theme: 'dark', env: bad }, null, 2) + '\n';
        twTmp(raw, ({ file, cdir }) => {
          const r = wiring.wireTelemetry();
          assert.deepStrictEqual(r.conflict, ['env']);
          assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
          assert.deepStrictEqual(fs.readdirSync(cdir).filter((x) => x.includes('.bak.')), []);
        });
      }
    });

    test('telemetryWired reflects the wired.json record', () => twTmp('{}\n', () => {
      assert.strictEqual(wiring.telemetryWired(), false);
      wiring.wireTelemetry();
      assert.strictEqual(wiring.telemetryWired(), true);
      wiring.unwireTelemetry();
      assert.strictEqual(wiring.telemetryWired(), false);
    }));

    test('collector server sets requestTimeout 30s and headersTimeout 15s', () => {
      const c = createCollector(new Store(), 0);
      assert.strictEqual(c.server.requestTimeout, 30000);
      assert.strictEqual(c.server.headersTimeout, 15000);
      c.close();
    });
  }

  /* ---- setup copy: hook count ---- */
  test('wiring.status() reports hookCount from EVENTS', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-hc-'));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmp;
    try {
      assert.strictEqual(wiring.status().hookCount, wiring.EVENTS.length);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('setup copy takes the hook count from status, with a numberless fallback', () => {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const setupCopy = new Function('return ' + app.match(/function setupCopy[\s\S]*?\n}/)[0])();
    assert.match(setupCopy({ hookCount: 11 }), /a statusline and 11 hooks/);
    assert.match(setupCopy({ hookCount: 11, foreignStatusLine: { command: 'x' } }), /11 hooks.*connecting replaces it/);
    for (const bad of [undefined, 0, -1, 1.5, '11', null]) {
      assert.match(setupCopy({ hookCount: bad }), /a statusline and its hooks/);
      assert.match(setupCopy({ hookCount: bad, foreignStatusLine: {} }), /its hooks.*replaces it/);
    }
    assert.ok(!/nine/.test(app), 'hard-coded count is gone');
  });

  /* ---- Phase 2 step 0: spend queries ---- */
  {
    const st = require('../src/spendtime.js');
    const { openLedger } = require('../src/ledger.js');
    const HR = 3600000;

    test('spendtime: 23:59 and 00:01 land on different local days', () => {
      const a = st.dayBounds(new Date(2026, 5, 10, 23, 59).getTime());
      const b = st.dayBounds(new Date(2026, 5, 11, 0, 1).getTime());
      assert.strictEqual(a.day, '2026-06-10'); assert.strictEqual(b.day, '2026-06-11');
      assert.strictEqual(a.until, b.since);
      assert.strictEqual(a.since, new Date(2026, 5, 10).getTime());
      assert.strictEqual(st.dayStart(new Date(2026, 5, 10, 23, 59).getTime()), a.since);
    });

    test('spendtime: day string is zero-padded local, not UTC', () => {
      assert.strictEqual(st.dayBounds(new Date(2026, 0, 5, 0, 30).getTime()).day, '2026-01-05');
    });

    test('spendtime: lastNDays(30) is 30 contiguous days ending today', () => {
      const now = new Date(2026, 2, 15, 13, 7).getTime();
      const d = st.lastNDays(30, now);
      assert.strictEqual(d.length, 30);
      for (let i = 1; i < d.length; i++) assert.strictEqual(d[i - 1].until, d[i].since);
      const last = d[29];
      assert.ok(last.since <= now && now < last.until);
      assert.strictEqual(last.day, '2026-03-15');
      assert.strictEqual(d[0].day, '2026-02-14');
    });

    test('spendtime: hourBuckets is 24 contiguous hours ending with the current one', () => {
      const now = new Date(2026, 5, 10, 13, 45).getTime();
      const h = st.hourBuckets(now);
      assert.strictEqual(h.length, 24);
      for (let i = 1; i < h.length; i++) assert.strictEqual(h[i - 1].until, h[i].since);
      assert.ok(h[23].since <= now && now < h[23].until);
      assert.strictEqual(h[23].key, '2026-06-10T13');
      assert.strictEqual(h[0].key, '2026-06-09T14');
      assert.strictEqual(h[23].since, new Date(2026, 5, 10, 13).getTime());
    });

    test('spendtime: monthStart is local midnight on the 1st', () => {
      assert.strictEqual(st.monthStart(new Date(2026, 8, 30, 23, 59).getTime()), new Date(2026, 8, 1).getTime());
      assert.strictEqual(st.monthStart(new Date(2026, 0, 1, 0, 0).getTime()), new Date(2026, 0, 1).getTime());
    });

    test('spendtime: DST day is 23 hours in America/New_York (skipped if TZ is not honoured)', () => {
      const code = `const s=require(${JSON.stringify(path.join(ROOT, 'src', 'spendtime.js'))});` +
        `const b=s.dayBounds(new Date(2026,2,8,12).getTime());const f=s.dayBounds(new Date(2026,10,1,12).getTime());` +
        `console.log((b.until-b.since)/3600000,(f.until-f.since)/3600000)`;
      const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { TZ: 'America/New_York' }), encoding: 'utf8' });
      const out = (r.stdout || '').trim();
      if (out !== '23 25') { console.log('       (note: TZ=America/New_York not honoured here, got "' + out + '"; DST test skipped)'); return; }
      assert.strictEqual(out, '23 25');
    });

    const tmpF = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-sq-')), 'sereno.db');
    const rmF = f => fs.rmSync(path.dirname(f), { recursive: true, force: true });
    const openL = (file) => openLedger({ file: file || ':memory:', retentionDays: 36500 });
    let kn = 0;
    const R = (o) => Object.assign({ requestKey: 'k' + (++kn), requestId: 'r' + kn, sessionId: 's1', promptId: null, ts: Date.now(),
      model: 'm', querySource: null, source: 'main', agentName: null, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 100, durationMs: 0 }, o);
    const sess = (l, id, cwd) => l.recordHook('SessionStart', { session_id: id, cwd });

    test('ledger.series: buckets sum to totals() over the same range; boundary goes to the later bucket', () => {
      const l = openL();
      const now = new Date(2026, 5, 10, 13, 45).getTime();
      const b = st.hourBuckets(now);
      l.ingestRequests([
        R({ ts: b[0].since, costMicros: 10 }),                       // exactly at first bucket start
        R({ ts: b[5].since, costMicros: 20, source: 'subagent' }),   // exactly on a boundary: bucket 5, not 4
        R({ ts: b[5].since - 1, costMicros: 30 }),                   // last ms of bucket 4
        R({ ts: b[23].until - 1, costMicros: 40, source: 'auxiliary' }),
        R({ ts: b[0].since - 1, costMicros: 999 }),                  // before range
        R({ ts: b[23].until, costMicros: 777 }),                     // at the end bound: excluded
      ]);
      const s = l.series(b);
      assert.strictEqual(s.length, 24);
      assert.deepStrictEqual(s.map(x => x.key), b.map(x => x.key));
      assert.strictEqual(s[4].costMicros, 30); assert.strictEqual(s[5].costMicros, 20);
      assert.deepStrictEqual(s[5].bySource, { subagent: 20 });
      assert.deepStrictEqual(s[5].byAttribution, { unknown: 20 });
      assert.strictEqual(s[0].costMicros, 10); assert.strictEqual(s[23].costMicros, 40);
      const t = l.totals({ since: b[0].since, until: b[23].until });
      assert.strictEqual(s.reduce((a, x) => a + x.costMicros, 0), t.costMicros);
      assert.strictEqual(s.reduce((a, x) => a + x.requests, 0), t.requests);
      assert.strictEqual(t.costMicros, 100);
      l.close();
    });

    test('ledger.series: empty ledger and empty bucket list give zeros and {}', () => {
      const l = openL();
      const s = l.series(st.lastNDays(3, Date.now()));
      assert.strictEqual(s.length, 3);
      for (const x of s) assert.deepStrictEqual(x, { key: x.key, costMicros: 0, requests: 0, bySource: {}, byAttribution: {} });
      assert.deepStrictEqual(l.series([]), []);
      l.close();
    });

    test('ledger.series: 23/25 hour day buckets keep 23:59 and 00:01 on different days', () => {
      const l = openL();
      const days = st.lastNDays(2, new Date(2026, 5, 11, 12).getTime());
      l.ingestRequests([R({ ts: new Date(2026, 5, 10, 23, 59).getTime(), costMicros: 5 }), R({ ts: new Date(2026, 5, 11, 0, 1).getTime(), costMicros: 7 })]);
      const s = l.series(days);
      assert.deepStrictEqual(s.map(x => x.costMicros), [5, 7]);
      l.close();
    });

    test('ledger.projects: sorted desc, null project, unattributed included in project totals', () => {
      const l = openL();
      sess(l, 'sa', 'C:\\w\\alpha'); sess(l, 'sb', 'C:\\w\\beta');
      const t = 1000000;
      l.ingestRequests([
        R({ sessionId: 'sa', ts: t, costMicros: 100 }),
        R({ sessionId: 'sa', ts: t + 1, costMicros: 50, source: 'subagent' }),   // no span: unknown
        R({ sessionId: 'sb', ts: t + 2, costMicros: 500 }),
        R({ sessionId: 'sx', ts: t + 3, costMicros: 20, source: 'subagent' }),   // session without project: null
        R({ sessionId: 'sa', ts: t + 100, costMicros: 9999 }),                   // out of range
      ]);
      const p = l.projects({ since: t, until: t + 10 });
      assert.deepStrictEqual(p.rows.map(r => r.project), ['beta', 'alpha', null]);
      assert.strictEqual(p.rows[1].costMicros, 150); assert.strictEqual(p.rows[1].requests, 2);
      assert.deepStrictEqual(p.rows[1].bySource, { main: 100, subagent: 50 });
      assert.deepStrictEqual(p.rows[1].byAttribution, { explicit: 100, unknown: 50 });
      assert.deepStrictEqual(p.unattributed, { costMicros: 70, requests: 2 });
      assert.strictEqual(p.rows.reduce((a, r) => a + r.costMicros, 0), l.totals({ since: t, until: t + 10 }).costMicros);
      assert.deepStrictEqual(l.projects({ since: 5, until: 6 }), { rows: [], unattributed: { costMicros: 0, requests: 0 } });
      l.close();
    });

    test('ledger.trend: one value per bucket, null project matches IS NULL', () => {
      const l = openL();
      sess(l, 'sa', 'C:\\w\\alpha');
      const days = st.lastNDays(14, new Date(2026, 5, 20, 9).getTime());
      l.ingestRequests([
        R({ sessionId: 'sa', ts: days[13].since + 5, costMicros: 30 }),
        R({ sessionId: 'sa', ts: days[13].since + 6, costMicros: 20 }),
        R({ sessionId: 'sa', ts: days[0].since, costMicros: 4 }),
        R({ sessionId: 'sx', ts: days[3].since + 1, costMicros: 8 }),
        R({ sessionId: null, ts: days[3].since + 2, costMicros: 2, requestKey: 'nos' }),
      ]);
      const a = l.trend({ project: 'alpha', buckets: days });
      assert.strictEqual(a.length, 14); assert.strictEqual(a[13], 50); assert.strictEqual(a[0], 4);
      assert.strictEqual(a.reduce((x, y) => x + y, 0), 54);
      const n = l.trend({ project: null, buckets: days });
      assert.strictEqual(n.length, 14); assert.strictEqual(n[3], 10); assert.strictEqual(n.reduce((x, y) => x + y, 0), 10);
      assert.deepStrictEqual(l.trend({ project: 'nope', buckets: days }), new Array(14).fill(0));
      l.close();
    });

    test('ledger.topPrompts: groups by prompt_id, falls back to request_key, models, attribution, order, limit', () => {
      const l = openL();
      sess(l, 'abcdefghijkl', 'C:\\w\\alpha');
      const t = 2000000;
      const S = 'abcdefghijkl';
      l.ingestRequests([
        R({ sessionId: S, promptId: 'p1', ts: t + 5, costMicros: 100, model: 'b-model' }),
        R({ sessionId: S, promptId: 'p1', ts: t + 3, costMicros: 100, model: 'a-model' }),
        R({ sessionId: S, promptId: 'p1', ts: t + 4, costMicros: 50, model: 'a-model' }),          // all explicit, 2 distinct models
        R({ sessionId: S, promptId: 'p2', ts: t + 1, costMicros: 100, source: 'subagent' }),       // unknown
        R({ sessionId: S, promptId: 'p2', ts: t + 2, costMicros: 100, source: 'subagent' }),       // all unknown
        R({ sessionId: S, promptId: 'p3', ts: t + 6, costMicros: 10 }),
        R({ sessionId: S, promptId: 'p3', ts: t + 7, costMicros: 10, source: 'subagent' }),        // mixed
        R({ sessionId: S, promptId: null, requestKey: 'solo', ts: t + 8, costMicros: 250 }),       // fallback group
        R({ sessionId: S, promptId: null, requestKey: 'tie', ts: t + 0, costMicros: 250 }),        // ties solo; earlier ts first
        R({ sessionId: S, promptId: 'out', ts: t + 999, costMicros: 5000 }),
      ]);
      const top = l.topPrompts({ since: t, until: t + 100 });
      assert.deepStrictEqual(top.map(x => x.costMicros), [250, 250, 250, 200, 20]);
      assert.strictEqual(top[0].ts, t);                 // 'tie' (250, earliest) before 'solo' (250, t+8)
      const p1 = top.find(x => x.costMicros === 250 && x.models.length === 2);
      assert.deepStrictEqual(p1.models, ['a-model', 'b-model']); assert.strictEqual(p1.attribution, 'explicit');
      assert.strictEqual(p1.sessionShort, 'abcdefgh'); assert.strictEqual(p1.project, 'alpha');
      assert.strictEqual(top[3].attribution, 'unknown'); assert.strictEqual(top[4].attribution, 'mixed');
      assert.strictEqual(top[3].models.length, 1);
      assert.strictEqual(l.topPrompts({ since: t, until: t + 100, limit: 2 }).length, 2);
      assert.strictEqual(l.topPrompts({ since: t, until: t + 100, limit: 0 }).length, 1);
      assert.strictEqual(l.topPrompts({ since: t, until: t + 100, limit: -5 }).length, 1);
      assert.strictEqual(l.topPrompts({ since: t, until: t + 100, limit: 1000 }).length, 5);
      assert.deepStrictEqual(l.topPrompts({ since: 1, until: 2 }), []);
      l.close();
    });

    test('ledger.topPrompts: a session-less request has null sessionShort and project', () => {
      const l = openL();
      l.ingestRequests([R({ sessionId: null, ts: 50, costMicros: 3 })]);
      const [x] = l.topPrompts({ since: 0, until: 100 });
      assert.strictEqual(x.sessionShort, null); assert.strictEqual(x.project, null);
      l.close();
    });

    test('ledger.today: equals totals() for its local day, counts unattributed', () => {
      const l = openL();
      const now = new Date(2026, 5, 10, 13, 45).getTime();
      const b = st.dayBounds(now);
      l.ingestRequests([
        R({ ts: new Date(2026, 5, 10, 0, 1).getTime(), costMicros: 100 }),
        R({ ts: new Date(2026, 5, 10, 12).getTime(), costMicros: 40, source: 'subagent' }),
        R({ ts: new Date(2026, 5, 9, 23, 59).getTime(), costMicros: 900 }),
        R({ ts: new Date(2026, 5, 11, 0, 1).getTime(), costMicros: 800 }),
      ]);
      const td = l.today(now), t = l.totals({ since: b.since, until: b.until });
      assert.strictEqual(td.day, '2026-06-10'); assert.strictEqual(td.since, b.since); assert.strictEqual(td.until, b.until);
      assert.strictEqual(td.costMicros, 140); assert.strictEqual(td.costMicros, t.costMicros);
      assert.strictEqual(td.requests, t.requests);
      assert.deepStrictEqual(td.bySource, t.bySource); assert.deepStrictEqual(td.byAttribution, t.byAttribution);
      assert.strictEqual(td.unattributedN, 1);
      assert.deepStrictEqual(l.today(new Date(2020, 0, 1).getTime()).bySource, {});
      assert.strictEqual(l.today(new Date(2020, 0, 1).getTime()).costMicros, 0);
      l.close();
    });

    test('ledger.today: survives close and reopen of a file ledger', () => {
      const f = tmpF();
      try {
        const now = Date.now();
        const l = openL(f);
        l.ingestRequests([R({ ts: now, costMicros: 321 })]);
        const a = l.today(now);
        l.close();
        const l2 = openL(f);
        assert.deepStrictEqual(l2.today(now), a);
        assert.strictEqual(l2.today(now).costMicros, 321);
        l2.close();
      } finally { rmF(f); }
    });

    test('ledger: new read methods throw once closed', () => {
      const l = openL(); l.close();
      for (const fn of [() => l.series([]), () => l.projects({ since: 0, until: 1 }), () => l.trend({ project: null, buckets: [] }),
        () => l.topPrompts({ since: 0, until: 1 }), () => l.today(Date.now())]) assert.throws(fn, /closed/);
    });
  }

  /* ---- Phase 2 step 1: spend API ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const PORT = 8801;
    const NOW0 = new Date(2026, 5, 10, 13, 45).getTime();
    let clock = NOW0;
    const rq = (opts, body) => new Promise((resolve) => {
      const r = http.request(Object.assign({ host: '127.0.0.1', port: PORT, agent: false }, opts), (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d, type: res.headers['content-type'] }));
      });
      r.on('error', () => resolve({ status: 0, body: '', type: '' }));
      r.end(body);
    });
    const get = (p, headers) => rq({ method: 'GET', path: p, headers: headers || {} });
    const getJ = async (p) => { const r = await get(p); return Object.assign({ status: r.status }, r.status === 200 ? JSON.parse(r.body) : {}); };
    const post = (p, body) => rq({ method: 'POST', path: p, headers: { 'content-type': 'application/json' } }, JSON.stringify(body));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const sv = (k, v) => ({ key: k, value: { stringValue: v } });
    const logs = (recs) => ({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: 'x' }, logRecords: recs.map((r) => ({
      timeUnixNano: String(BigInt(r.ts) * 1000000n),
      attributes: [sv('event.name', 'api_request'), sv('request_id', r.id), sv('session.id', r.sess || 'sess-aaaaaaaa-1111'),
        sv('prompt.id', r.prompt || 'p-' + r.id), sv('model', r.model || 'claude-fake'), sv('query_source', r.qs || 'repl_main_thread'),
        { key: 'cost_usd_micros', value: { intValue: r.micros } }],
    })) }] }] });
    const FIX = () => logs([
      { id: 'r1', ts: NOW0 - 60000, micros: 5000 },
      { id: 'r2', ts: NOW0 - 120000, micros: 3000, qs: 'agent:Explore' },
      { id: 'r3', ts: NOW0 - 3 * 86400000, micros: 7000, qs: 'compact', sess: 'sess-bbbbbbbb-2222' },
    ]);
    const mkLedger = () => openLedger({ file: ':memory:', retentionDays: 36500 });
    const start = async (ledger) => {
      const c = createCollector(new Store(), PORT, { ledger, now: () => clock });
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      return c;
    };
    const stop = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });
    const boom = () => { throw new Error('boom'); };
    const throwing = { today: boom, series: boom, projects: boom, trend: boom, topPrompts: boom, totals: boom,
      ingestRequests: boom, ingestSpans: boom, recordHook() {}, recordStatus() {} };
    const checkKeys = (o, allowed, where) => {
      for (const k of Object.keys(o)) assert.ok(allowed.includes(k), where + ': unexpected key ' + k);
      for (const k of allowed) assert.ok(k in o, where + ': missing key ' + k);
    };
    const ROUTES = ['/api/spend/today', '/api/spend/series', '/api/spend/projects', '/api/spend/top-prompts'];

    await atest('spend api: ledger on returns data for every route, with only documented keys', async () => {
      clock = NOW0;
      const l = mkLedger();
      const c = await start(l);
      try {
        l.recordHook('SessionStart', { session_id: 'sess-aaaaaaaa-1111', cwd: 'C:\\work\\proj' });
        assert.strictEqual((await post('/v1/logs', FIX())).status, 200);

        const t = await getJ('/api/spend/today');
        checkKeys(t, ['status', 'enabled', 'asOf', 'day', 'costMicros', 'requests', 'bySource', 'byAttribution', 'unattributedN'], 'today');
        assert.strictEqual(t.enabled, true); assert.strictEqual(t.asOf, NOW0); assert.strictEqual(t.day, '2026-06-10');
        assert.strictEqual(t.costMicros, 8000); assert.strictEqual(t.requests, 2);
        assert.strictEqual(t.unattributedN, 1);

        const s = await getJ('/api/spend/series?range=7d');
        checkKeys(s, ['status', 'enabled', 'asOf', 'range', 'buckets'], 'series');
        assert.strictEqual(s.buckets.length, 7);
        for (const b of s.buckets) checkKeys(b, ['key', 'since', 'until', 'costMicros', 'requests', 'bySource', 'byAttribution'], 'series bucket');
        assert.strictEqual(s.buckets.reduce((a, b) => a + b.costMicros, 0), 15000);
        assert.strictEqual(s.buckets[6].costMicros, 8000);

        const h = await getJ('/api/spend/series?range=24h');
        assert.strictEqual(h.buckets.length, 24);
        assert.strictEqual(h.buckets.reduce((a, b) => a + b.costMicros, 0), 8000);

        const p = await getJ('/api/spend/projects');
        checkKeys(p, ['status', 'enabled', 'asOf', 'range', 'rows', 'unattributed'], 'projects');
        checkKeys(p.unattributed, ['costMicros', 'requests'], 'projects.unattributed');
        assert.strictEqual(p.range, 'month');
        assert.ok(p.rows.length >= 1);
        for (const r of p.rows) {
          checkKeys(r, ['project', 'costMicros', 'requests', 'bySource', 'byAttribution', 'trend'], 'projects row');
          assert.strictEqual(r.trend.length, 14);
        }
        assert.strictEqual(p.rows.reduce((a, r) => a + r.costMicros, 0), 15000);

        const tp = await getJ('/api/spend/top-prompts');
        checkKeys(tp, ['status', 'enabled', 'asOf', 'range', 'rows'], 'top-prompts');
        assert.strictEqual(tp.range, 'month'); assert.strictEqual(tp.rows.length, 3);
        for (const r of tp.rows) {
          checkKeys(r, ['ts', 'project', 'sessionShort', 'costMicros', 'models', 'attribution'], 'top-prompts row');
          assert.strictEqual(r.sessionShort.length, 8);
        }
        assert.strictEqual(tp.rows[0].costMicros, 7000);
      } finally { await stop(c); l.close(); }
    });

    await atest('spend api: default ranges, range validation and limit passthrough', async () => {
      clock = NOW0;
      const l = mkLedger();
      const c = await start(l);
      try {
        await post('/v1/logs', FIX());
        assert.strictEqual((await getJ('/api/spend/series')).range, '30d');
        assert.strictEqual((await getJ('/api/spend/series')).buckets.length, 30);
        assert.strictEqual((await getJ('/api/spend/top-prompts?range=7d')).range, '7d');
        assert.strictEqual((await getJ('/api/spend/projects?range=30d')).range, '30d');
        assert.strictEqual((await get('/api/spend/series?range=90d')).status, 400);
        assert.strictEqual((await get('/api/spend/series?range=month')).status, 400);
        assert.strictEqual((await get('/api/spend/projects?range=24h')).status, 400);
        assert.strictEqual((await get('/api/spend/top-prompts?range=bogus')).status, 400);
        assert.strictEqual((await getJ('/api/spend/top-prompts?limit=1')).rows.length, 1);
        assert.strictEqual((await getJ('/api/spend/top-prompts?limit=2')).rows.length, 2);
        assert.strictEqual((await getJ('/api/spend/top-prompts?limit=abc')).rows.length, 3);
        assert.strictEqual((await get('/api/spend/nope')).status, 404);
        assert.strictEqual((await get('/api/other')).status, 404);
      } finally { await stop(c); l.close(); }
    });

    await atest('spend api: ledger off answers enabled:false (200) on every route; ledger throwing answers 503', async () => {
      const c = await start(null);
      try {
        for (const r of ROUTES) {
          const x = await get(r);
          assert.strictEqual(x.status, 200, r); assert.deepStrictEqual(JSON.parse(x.body), { enabled: false }, r);
        }
      } finally { await stop(c); }
      const c2 = await start(throwing);
      try {
        for (const r of ROUTES) assert.strictEqual((await get(r)).status, 503, r);
        assert.strictEqual((await get('/state')).status, 200);   // a broken ledger never breaks the snapshot
      } finally { await stop(c2); }
    });

    await atest('spend api: non-GET on /api/spend/* is not served', async () => {
      const c = await start(mkLedger());
      try {
        const r = await post('/api/spend/today', {});
        assert.ok(r.status === 404 || r.status === 403 || r.status === 405, 'got ' + r.status);
        assert.ok(!/costMicros/.test(r.body));
      } finally { await stop(c); }
    });

    await atest('spend exit 7: foreign Host or Origin gets 403 on /console and /api/spend/today', async () => {
      const c = await start(mkLedger());
      try {
        for (const p of ['/console', '/api/spend/today']) {
          assert.strictEqual((await get(p, { host: 'evil.example' })).status, 403, p + ' host');
          assert.strictEqual((await get(p, { origin: 'http://evil.example' })).status, 403, p + ' origin');
          assert.notStrictEqual((await get(p)).status, 403, p + ' ok');
        }
      } finally { await stop(c); }
    });

    await atest('console route: serves the placeholder as html and blocks traversal', async () => {
      const c = await start(null);
      try {
        for (const p of ['/console', '/console/', '/console/index.html']) {
          const r = await get(p);
          assert.strictEqual(r.status, 200, p);
          assert.match(r.type, /^text\/html/); assert.match(r.body, /<title>Sereno console<\/title>/);
        }
        assert.strictEqual((await get('/console/missing.js')).status, 404);
        for (const p of ['/console/../collector.js', '/console/%2e%2e%2fcollector.js', '/console/%2e%2e/%2e%2e/package.json', '/console/..%5c..%5cpackage.json']) {
          const r = await get(p);
          assert.ok(r.status === 403 || r.status === 404, p + ' -> ' + r.status);
          assert.ok(!/createCollector|"name"/.test(r.body), p + ' leaked a file');
        }
        assert.strictEqual((await get('/')).status, 200);   // widget route still works
      } finally { await stop(c); }
    });

    await atest('snapshot spend: disabled without a ledger; updates after /v1/logs; not recomputed by /status or /hook', async () => {
      clock = NOW0;
      const c0 = await start(null);
      try {
        const st = JSON.parse((await get('/state')).body);
        assert.deepStrictEqual(st.spend, { enabled: false });
      } finally { await stop(c0); }

      const l = mkLedger();
      let calls = 0;
      const orig = l.today;
      l.today = (n) => { calls++; return orig(n); };
      const c = await start(l);
      const spend = async () => JSON.parse((await get('/state')).body).spend;
      try {
        const a = await spend();
        assert.deepStrictEqual(Object.keys(a).sort(), ['bySource', 'byAttribution', 'enabled', 'hasTelemetry', 'todayMicros', 'unattributedN'].sort());
        assert.strictEqual(a.enabled, true); assert.strictEqual(a.todayMicros, 0); assert.strictEqual(a.hasTelemetry, false);
        assert.strictEqual(calls, 1);
        await spend(); await spend();
        assert.strictEqual(calls, 1, 'snapshots must not recompute');

        assert.strictEqual((await post('/v1/logs', FIX())).status, 200);
        const b = await spend();
        assert.strictEqual(b.todayMicros, 8000); assert.strictEqual(b.hasTelemetry, true);
        assert.strictEqual(b.bySource.main, 5000);
        assert.strictEqual(calls, 2);

        await post('/status', { payload: { session_id: 's-x', cost: { total_cost_usd: 1.5 } } });
        await post('/hook', { event: 'SessionStart', payload: { session_id: 's-x', cwd: 'C:\\work\\x' } });
        await wait(60);
        await spend();
        assert.strictEqual(calls, 2, '/status and /hook must not recompute spend');
        // an empty logs post inserts nothing and must not recompute either
        await post('/v1/logs', { resourceLogs: [] });
        assert.strictEqual(calls, 2);
      } finally { await stop(c); l.close(); }
    });

    await atest('snapshot spend: SSE frames carry spend; setLedger recomputes; day rollover recomputes via the tick', async () => {
      clock = NOW0;
      const l = mkLedger();
      let calls = 0;
      const orig = l.today;
      l.today = (n) => { calls++; return orig(n); };
      const c = await start(l);
      try {
        await post('/v1/logs', FIX());
        const first = await new Promise((resolve) => {
          const r = http.get({ host: '127.0.0.1', port: PORT, path: '/events', agent: false }, (res) => {
            let d = '';
            res.on('data', (ch) => {
              d += ch;
              const m = /data: (.*)\n\n/.exec(d);
              if (m) { r.destroy(); resolve(JSON.parse(m[1])); }
            });
          });
          r.on('error', () => {});
        });
        assert.strictEqual(first.spend.todayMicros, 8000);
        const before = calls;
        c._tickSpend();
        assert.strictEqual(calls, before, 'same day: tick does nothing');
        clock = NOW0 + 24 * 3600000;   // past midnight
        c._tickSpend();
        assert.strictEqual(calls, before + 1, 'new day: tick recomputes');
        const st = JSON.parse((await get('/state')).body);
        assert.strictEqual(st.spend.todayMicros, 0); assert.strictEqual(st.spend.hasTelemetry, false);
        c._tickSpend();
        assert.strictEqual(calls, before + 1, 'the tick recomputes once per day');
        c.setLedger(null);
        assert.deepStrictEqual(JSON.parse((await get('/state')).body).spend, { enabled: false });
        c.setLedger(l);
        assert.strictEqual(JSON.parse((await get('/state')).body).spend.enabled, true);
        // a throwing today() keeps the previous cache
        const keep = JSON.parse((await get('/state')).body).spend;
        l.today = () => { throw new Error('boom'); };
        c.setLedger(l);
        assert.deepStrictEqual(JSON.parse((await get('/state')).body).spend, keep);
      } finally { await stop(c); l.close(); }
    });

    await atest('snapshot spend: traces ingest with spans recomputes (attribution upgrade); empty traces does not', async () => {
      clock = NOW0;
      const l = mkLedger();
      let calls = 0;
      const orig = l.today;
      l.today = (n) => { calls++; return orig(n); };
      const c = await start(l);
      const spend = async () => JSON.parse((await get('/state')).body).spend;
      try {
        await post('/v1/logs', FIX());
        const a = await spend();
        assert.strictEqual(a.unattributedN, 1); assert.strictEqual(a.byAttribution.unknown, 3000);
        const n = calls;
        await post('/v1/traces', { resourceSpans: [] });
        assert.strictEqual(calls, n, 'empty traces must not recompute');
        const span = { startTimeUnixNano: String(BigInt(NOW0 - 120000) * 1000000n), attributes: [sv('span.type', 'llm_request'),
          sv('request_id', 'r2'), sv('session.id', 'sess-aaaaaaaa-1111'), sv('agent_id', 'agent-1')] };
        assert.strictEqual((await post('/v1/traces', { resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] })).status, 200);
        const b = await spend();
        assert.strictEqual(calls, n + 1);
        assert.strictEqual(b.unattributedN, 0); assert.strictEqual(b.byAttribution.unknown, undefined);
      } finally { await stop(c); l.close(); }
    });

    await atest('snapshot spend: first-use failure is {enabled:true, unavailable:true}; a later success clears it', async () => {
      clock = NOW0;
      const l = mkLedger();
      const orig = l.today;
      l.today = () => { throw new Error('boom'); };
      const c = await start(l);
      try {
        const st = JSON.parse((await get('/state')).body).spend;
        assert.deepStrictEqual(st, { enabled: true, unavailable: true });
        l.today = orig;
        c.setLedger(l);
        const ok = JSON.parse((await get('/state')).body).spend;
        assert.strictEqual(ok.enabled, true); assert.ok(!('unavailable' in ok));
        assert.strictEqual(ok.todayMicros, 0);
      } finally { await stop(c); l.close(); }
    });
  }

  /* ---- Phase 2 step 2: widget footer ---- */
  {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const lift = (name) => app.match(new RegExp('function ' + name + '[\\s\\S]*?\\n}'))[0];
    const fns = new Function([lift('estMoney'), lift('largestRemainder'), lift('sourceSegments'),
      lift('barAriaLabel'), lift('cumulativePoints'), lift('spendMode'),
      'return { estMoney, largestRemainder, sourceSegments, barAriaLabel, cumulativePoints, spendMode };'].join('\n'))();

    test('estMoney: two decimals, always est., bad input is $0.00', () => {
      assert.strictEqual(fns.estMoney(12340000), '$12.34 est.');
      assert.strictEqual(fns.estMoney(0), '$0.00 est.');
      assert.strictEqual(fns.estMoney(4000), '$0.00 est.');
      assert.strictEqual(fns.estMoney(1250000000), '$1250.00 est.');
      for (const bad of [NaN, Infinity, undefined, null, 'x', -5]) assert.strictEqual(fns.estMoney(bad), '$0.00 est.');
    });

    test('largestRemainder sums to exactly 100, or all zero', () => {
      for (const v of [[1, 1, 1], [1, 2, 3, 4], [33, 33, 34], [1, 0, 0], [5, 5], [0.1, 0.2, 0.7], [1, 1, 1, 1, 1, 1, 1]]) {
        const r = fns.largestRemainder(v);
        assert.strictEqual(r.reduce((a, b) => a + b, 0), 100, JSON.stringify(v));
        assert.ok(r.every(Number.isInteger));
      }
      assert.deepStrictEqual(fns.largestRemainder([1, 1, 1]), [34, 33, 33]);
      assert.deepStrictEqual(fns.largestRemainder([0, 0]), [0, 0]);
      assert.deepStrictEqual(fns.largestRemainder([]), []);
    });

    test('sourceSegments: ordered, unattributed last and carved out of source', () => {
      const segs = fns.sourceSegments({
        todayMicros: 10000000,
        bySource: { main: 6000000, subagent: 3000000, auxiliary: 1000000 },
        byAttribution: { explicit: 8000000, unknown: 2000000 },
      });
      assert.deepStrictEqual(segs.map((x) => x.key), ['main', 'subagent', 'auxiliary', 'unattributed']);
      assert.deepStrictEqual(segs.map((x) => x.micros), [6000000, 1000000, 1000000, 2000000]);
      assert.strictEqual(segs.reduce((a, b) => a + b.pct, 0), 100);
      assert.strictEqual(segs.reduce((a, b) => a + b.micros, 0), 10000000);
      assert.deepStrictEqual(fns.sourceSegments({ todayMicros: 0, bySource: {}, byAttribution: {} }), []);
      assert.deepStrictEqual(fns.sourceSegments(undefined), []);
      const only = fns.sourceSegments({ bySource: { main: 5 }, byAttribution: { explicit: 5 } });
      assert.deepStrictEqual(only.map((x) => [x.key, x.pct]), [['main', 100]]);
    });

    test('cumulativePoints: monotonic, in range, today only, hours after now undrawn', () => {
      const mid = new Date(2026, 9, 4).getTime();
      const H = 3600000;
      const mk = (hr, c) => ({ since: mid + hr * H, until: mid + (hr + 1) * H, costMicros: c });
      const buckets = [mk(-3, 9000000), mk(1, 1000000), mk(0, 2000000), mk(5, 0), mk(6, 3000000)];
      const asOf = mid + 6.5 * H;
      const pts = fns.cumulativePoints(buckets, mid, asOf, 360, 40)
        .split(' ').map((p) => p.split(',').map(Number));
      assert.strictEqual(pts[0][0], 0);
      assert.strictEqual(pts[0][1], 40);                      // nothing spent at 00:00
      for (let i = 1; i < pts.length; i++) {
        assert.ok(pts[i][1] <= pts[i - 1][1], 'y never rises (cumulative never falls)');
        assert.ok(pts[i][0] >= pts[i - 1][0]);
      }
      for (const [x, y] of pts) { assert.ok(x >= 0 && x <= 360); assert.ok(y >= 0 && y <= 40); }
      const last = pts[pts.length - 1];
      assert.strictEqual(last[1], 0);                         // yesterday's bucket is not in the total
      assert.ok(Math.abs(last[0] - 360 * 6.5 / 24) < 0.2);    // ends at "now", not at 24:00
      const empty = fns.cumulativePoints([], mid, asOf, 360, 40);
      assert.ok(empty.split(' ').every((p) => p.endsWith(',40.0')));
    });

    test('every money string the footer can produce ends in est.', () => {
      for (const m of [0, 1, 999, 10000, 12340000, 987654321, NaN, undefined]) {
        assert.match(fns.estMoney(m), /^\$\d+\.\d\d est\.$/);
      }
      const segs = fns.sourceSegments({ bySource: { main: 3000000, subagent: 1500000, auxiliary: 12 }, byAttribution: { unknown: 700000 } });
      const label = fns.barAriaLabel(segs);
      for (const part of label.split('; ')) assert.match(part, /est\.$/);
      assert.strictEqual((label.match(/\$/g) || []).length, (label.match(/est\./g) || []).length);
      assert.strictEqual(fns.barAriaLabel([]), 'No estimated spend today');
      // the list-price line and the Today header are both labelled at the source
      assert.match(app, /money\(snapshot\.totalCost\) \+ ' list-price est\.'/);
      assert.match(app, /esc\(estMoney\(total\)\)/);
    });

    test('footer fallback: copy, gating and a single fetch path', () => {
      assert.match(app, /Waiting for telemetry from new Claude Code sessions/);
      assert.match(app, /Spend history unavailable/);
      assert.strictEqual(fns.spendMode(undefined), 'off');
      assert.strictEqual(fns.spendMode({ enabled: false }), 'off');
      assert.strictEqual(fns.spendMode({ enabled: true, unavailable: true }), 'unavailable');
      assert.strictEqual(fns.spendMode({ enabled: true, hasTelemetry: false }), 'waiting');
      assert.strictEqual(fns.spendMode({ enabled: true, hasTelemetry: true }), 'on');
      assert.strictEqual((app.match(/fetch\(/g) || []).length, 1);
      assert.match(app, /fetch\('\/api\/spend\/series\?range=24h'\)/);
    });

    test('open console: main builds the URL, preload only signals, tray item exists', () => {
      const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
      assert.match(main, /http:\/\/127\.0\.0\.1:\$\{PORT\}\/console/);
      assert.match(main, /ipcMain\.on\('sereno:open-console'/);
      assert.match(main, /label: 'Open console'/);
      assert.match(main, /if \(isWebUrl\(url\)\) shell\.openExternal\(url\)/);
      assert.match(pre, /openConsole: \(\) => ipcRenderer\.send\('sereno:open-console'\)/);
      const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
      assert.match(html, /<a id="open-console"[^>]*href="\/console"[^>]*target="_blank"[^>]*rel="noopener"/);
    });
  }

  /* ---- Phase 2 step 3: console Spend tab ---- */
  {
    const cdir = path.join(ROOT, 'src', 'renderer', 'console');
    const cjs = fs.readFileSync(path.join(cdir, 'console.js'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const names = ['estMoney', 'esc', 'largestRemainder', 'niceTicks', 'tickLabel', 'segmentsOf', 'barGeometry',
      'summaryLine', 'attributionSplit', 'formatTime', 'projectLabel', 'syncLabel', 'sparkPoints', 'pageState'];
    const lifted = (src) => names.filter((n) => new RegExp('function ' + n + '\\(').test(src))
      .map((n) => src.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0]);
    const C = new Function(lifted(cjs).join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
    const W = new Function(lifted(app).join('\n') + '\nreturn { estMoney };')();

    test('console estMoney matches the widget and always ends in est.', () => {
      for (const v of [0, 1, 4000, 12340000, 1250000000, 999999, NaN, Infinity, undefined, null, 'x', -5, '7500000']) {
        assert.strictEqual(C.estMoney(v), W.estMoney(v));
        assert.match(C.estMoney(v), /^\$\d+\.\d\d est\.$/);
      }
    });

    test('esc neutralises markup and quotes', () => {
      assert.strictEqual(C.esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
      assert.strictEqual(C.esc("a'b&c"), 'a&#39;b&amp;c');
      assert.strictEqual(C.esc(null), '');
      assert.strictEqual(C.esc(5), '5');
    });

    test('niceTicks: 3-4 increasing dollar ticks covering the max', () => {
      for (const m of [0, 1, 40000, 1230000, 9990000, 27400000, 31000000, 412000000, 1e9, 2500000, 3e6]) {
        const t = C.niceTicks(m);
        assert.ok(t.length >= 3 && t.length <= 4, JSON.stringify([m, t]));
        for (let i = 1; i < t.length; i++) assert.ok(t[i] > t[i - 1]);
        assert.strictEqual(t[0], 0);
        assert.ok(t[t.length - 1] * 1e6 >= m, JSON.stringify([m, t]));
      }
      assert.deepStrictEqual(C.niceTicks(27400000), [0, 10, 20, 30]);
      assert.deepStrictEqual(C.niceTicks(NaN), [0, 1, 2, 3]);
      assert.strictEqual(C.tickLabel(10), '$10');
      assert.strictEqual(C.tickLabel(2.5), '$2.50');
    });

    test('barGeometry: stacked, unattributed on top, heights sum to scaled total, no NaN', () => {
      const bs = [
        { key: 'a', costMicros: 10e6, bySource: { main: 6e6, subagent: 3e6, auxiliary: 1e6 }, byAttribution: { explicit: 8e6, unknown: 2e6 } },
        { key: 'b', costMicros: 0, bySource: {}, byAttribution: {} },
        { key: 'c', costMicros: 5e6, bySource: { main: 5e6 }, byAttribution: { unknown: 5e6 } },
      ];
      const g = C.barGeometry(bs, 300, 100, 20e6);
      assert.strictEqual(g.length, 3);
      const a = g[0];
      assert.deepStrictEqual(a.segs.map((s) => s.key), ['main', 'subagent', 'auxiliary', 'unattributed']);
      assert.ok(Math.abs(a.segs.reduce((x, s) => x + s.h, 0) - 50) < 1e-9);
      assert.strictEqual(a.total, 10e6);
      assert.strictEqual(a.segs[3].micros, 2e6);
      assert.ok(a.segs[3].y <= a.segs[0].y);   // unattributed is the topmost (smallest y)
      assert.ok(Math.abs(a.segs[0].y + a.segs[0].h - 100) < 1e-9);   // stack starts at the baseline
      assert.strictEqual(g[1].total, 0);
      assert.strictEqual(g[2].segs[3].micros, 5e6);   // all unattributed
      for (const b of g) for (const s of b.segs) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(s[k]), k);
      for (const bad of [[], null, undefined]) assert.deepStrictEqual(C.barGeometry(bad, 300, 100, 0), []);
      const z = C.barGeometry([{ costMicros: 0 }], 0, 0, 0);
      for (const s of z[0].segs) for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(s[k]), k);
    });

    test('summaryLine: exact string with est. and n', () => {
      const today = { costMicros: 27400000 };
      const projects = { rows: [{ costMicros: 300e6 }, { costMicros: 112e6 }], unattributed: { costMicros: 24720000, requests: 742 } };
      assert.strictEqual(C.summaryLine(today, projects),
        '$27.40 est. today · $412.00 est. this month · 6% unattributed (n=742)');
      assert.strictEqual(C.summaryLine({ costMicros: 0 }, { rows: [], unattributed: { costMicros: 0, requests: 0 } }),
        '$0.00 est. today · $0.00 est. this month · 0% unattributed (n=0)');
      assert.match(C.summaryLine(null, null), /est\. today · .* est\. this month/);
    });

    test('attributionSplit sums to 100 and carries n', () => {
      const s = C.attributionSplit({ explicit: 1, unknown: 1 }, 3);
      assert.strictEqual(s.explicitPct + s.unattributedPct, 100);
      assert.strictEqual(s.n, 3);
      const t = C.attributionSplit({ explicit: 90e6, unknown: 3.9e6 }, 386);
      assert.strictEqual(t.explicitPct + t.unattributedPct, 100);
      assert.deepStrictEqual(C.attributionSplit({ explicit: 5 }, 2), { explicitPct: 100, unattributedPct: 0, n: 2 });
      assert.deepStrictEqual(C.attributionSplit({}, 0), { explicitPct: 0, unattributedPct: 0, n: 0 });
    });

    test('formatTime, projectLabel, syncLabel, sparkPoints, pageState', () => {
      assert.strictEqual(C.formatTime(new Date(2026, 8, 28, 9, 4).getTime()), 'Sep 28 09:04');
      assert.strictEqual(C.formatTime(new Date(2026, 0, 5, 23, 59).getTime()), 'Jan 05 23:59');
      assert.strictEqual(C.formatTime(NaN), '');
      assert.strictEqual(C.projectLabel(null), 'Unknown project');
      assert.strictEqual(C.projectLabel(undefined), 'Unknown project');
      assert.strictEqual(C.projectLabel('sereno'), 'sereno');
      assert.strictEqual(C.syncLabel(1000, 2000), 'Synced just now');
      assert.strictEqual(C.syncLabel(0, 40000), 'Synced 40s ago');
      assert.strictEqual(C.syncLabel(0, 190000), 'Synced 3m ago');
      assert.strictEqual(C.syncLabel(null, 5), 'Not synced yet');
      assert.ok(!/NaN/.test(C.sparkPoints([0, 0, 0], 100, 20)));
      assert.ok(!/NaN/.test(C.sparkPoints([1, 5, 2], 100, 20)));
      assert.strictEqual(C.sparkPoints([], 100, 20), '');
      assert.strictEqual(C.pageState([{ status: 200, body: { enabled: false } }]), 'off');
      assert.strictEqual(C.pageState([{ status: 503, body: null }, { status: 200, body: { enabled: false } }]), 'unavailable');
      assert.strictEqual(C.pageState([{ status: 200, body: { enabled: true } }]), null);
    });

    test('console.js: no prompt text, one innerHTML write, est. labels, empty-state copy', () => {
      assert.ok(!/\.prompt\b|\['prompt|prompt_text|promptText|\.text\b|\.body\.text/.test(cjs));
      assert.strictEqual((cjs.match(/\.innerHTML\s*=/g) || []).length, 1);
      assert.match(cjs, /function setHtml\(el, html\) \{ el\.innerHTML = html; \}/);
      assert.match(cjs, /Prompt text is never stored/);
      assert.match(cjs, /Spend history is off/);
      assert.match(cjs, /Turn it on from the Sereno tray: Keep spend history\./);
      assert.match(cjs, /No spend recorded yet/);
      assert.match(cjs, /Wire telemetry/);
      assert.match(cjs, /No spend in this range/);
      assert.match(cjs, /Spend history is unavailable right now/);
      assert.match(cjs, /No subagent could be confirmed for these requests\./);
      assert.ok(!/first tool/i.test(cjs));
      assert.match(cjs, /location\.host \+ '\/console'/);
      // API strings that reach markup are escaped
      for (const f of ['esc(projectLabel(r.project))', 'esc(r.sessionShort)', "esc((r.models || []).join(', '))", 'esc(formatTime(r.ts))']) {
        assert.ok(cjs.includes(f), f);
      }
    });

    test('console: strict CSP, no inline style attributes in generated markup', () => {
      const html = fs.readFileSync(path.join(cdir, 'index.html'), 'utf8');
      assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"/);
      assert.ok(!/style=/.test(cjs.replace(/el.style./g, '')), 'style= found in console.js');
      assert.ok(!/style=/.test(html));
      assert.match(cjs, /el.style.width/);
    });

    test('console page: absolute /console/ assets, nav is Spend only, source colours match the widget', () => {
      const html = fs.readFileSync(path.join(cdir, 'index.html'), 'utf8');
      const css = fs.readFileSync(path.join(cdir, 'console.css'), 'utf8');
      const appcss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.css'), 'utf8');
      assert.match(html, /href="\/console\/console\.css"/);
      assert.match(html, /src="\/console\/console\.js"/);
      assert.match(html, /LOCAL WORKSPACE/);
      assert.match(html, /Local only/);
      assert.strictEqual((html.match(/class="nav-item/g) || []).length, 1);
      for (const v of ['--src-main', '--src-subagent', '--src-auxiliary', '--src-unattributed', '--src-hatch']) {
        const re = new RegExp(v + ':\\s*(#[0-9a-f]{6})', 'i');
        assert.strictEqual(css.match(re)[1].toLowerCase(), appcss.match(re)[1].toLowerCase(), v);
      }
      assert.match(css, /prefers-color-scheme: light/);
      for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
    });
  }

  /* ---- Phase 2: render fixes ---- */
  {
    const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const cjs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
    const lf = (src, n) => src.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0];
    const W = new Function('const SPEND_W = 324, SPEND_H = 30, SPEND_TOP = 12;\n' + [lf(app, 'segmentWidths'), lf(app, 'nowPosition'),
      'return { segmentWidths, nowPosition };'].join('\n'))();

    test('widget: no inline style attributes in generated markup; geometry via data-* + CSSOM', () => {
      const spendBlock = app.slice(app.indexOf('function spendHtml'), app.indexOf('function renderSpend'));
      assert.ok(!/style=/.test(spendBlock), 'style= in spendHtml');
      assert.match(spendBlock, /data-w="/);
      assert.match(app, /el\.style\.width = /);
      assert.match(app, /el\.style\.left = /);
      assert.match(app, /applySpendLayout\(ui\.spend\)/);
    });

    test('segmentWidths and nowPosition: pure geometry', () => {
      assert.deepStrictEqual(W.segmentWidths([{ micros: 78 }, { micros: 22 }]), ['78.000', '22.000']);
      assert.deepStrictEqual(W.segmentWidths([{ micros: 0 }]), ['0.000']);
      const p = W.nowPosition(162, 10);
      assert.strictEqual(p.left, '50.00');
      assert.strictEqual(p.top, (22 / 44 * 100).toFixed(2));
    });

    test('widget chart: non-scaling strokes and an HTML dot of fixed size', () => {
      assert.ok((app.match(/vector-effect="non-scaling-stroke"/g) || []).length >= 2);
      assert.ok(!/<circle/.test(app));
      assert.match(app, /class="spend-dot"/);
    });

    test('console chart title and subtitle follow the range', () => {
      const t = new Function(lf(cjs, 'chartTitle') + '\nreturn chartTitle;')();
      assert.deepStrictEqual(t('24h'), { title: 'Hourly usage cost', sub: 'hourly · estimated' });
      for (const r of ['7d', '30d']) assert.deepStrictEqual(t(r), { title: 'Daily usage cost', sub: 'daily · estimated' });
      assert.match(cjs, /getElementById\('chart-title'\)/);
    });

    test('console main column is capped at 1180px', () => {
      const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.css'), 'utf8');
      assert.match(css, /\.main \{[^}]*max-width: 1180px/);
    });

    await atest('static responses: nosniff everywhere, frame-ancestors header on html', async () => {
      const PORT = 8796;
      const c = createCollector(new Store(), PORT);
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      const get = (p) => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: p, agent: false }, (r) => { r.resume(); r.on('end', () => resolve(r)); })
          .on('error', () => resolve({ statusCode: 0, headers: {} }));
      });
      try {
        for (const p of ['/', '/console']) {
          const r = await get(p);
          assert.strictEqual(r.statusCode, 200, p);
          assert.strictEqual(r.headers['content-security-policy'], "frame-ancestors 'none'", p);
          assert.strictEqual(r.headers['x-content-type-options'], 'nosniff', p);
        }
        const js = await get('/console/console.js');
        assert.strictEqual(js.statusCode, 200);
        assert.strictEqual(js.headers['x-content-type-options'], 'nosniff');
        assert.ok(!js.headers['content-security-policy']);
      } finally {
        await new Promise((res) => { c.server.close(() => res()); c.close(); });
      }
    });
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
