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

    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp });
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
    const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: tmp });
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
