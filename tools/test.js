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
  let collPort = 0;   // port 0: the OS picks a free one
  const collector = createCollector(store, 0);
  await new Promise((res, rej) => collector.listen((e, a) => (e ? rej(e) : (collPort = a.port, res()))));

  function post(p, body) {
    return new Promise((res) => {
      const b = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: collPort, path: p, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) },
      }, (r) => { r.resume(); r.on('end', res); });
      req.on('error', res);
      req.end(b);
    });
  }
  const get = (p) => new Promise((res) => {
    http.get({ host: '127.0.0.1', port: collPort, path: p }, (r) => {
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
        host: '127.0.0.1', port: collPort, path: '/hook', method: 'POST',
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
      const r = http.request(Object.assign({ host: '127.0.0.1', port: collPort }, opts), (res) => {
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
      const req = http.request({ host: '127.0.0.1', port: collPort, path: '/hook', method: 'POST' }, (r) => { r.resume(); r.on('end', res); });
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
      env: Object.assign({}, process.env, { CLAUDE_HUD_PORT: String(collPort) }),
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
    let PORT = 0;   // port 0: the OS picks a free one
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
      const c = createCollector(st, 0, { ledger });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
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
      let PORT = 0;   // port 0: the OS picks a free one
      const get = () => new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/ledger/summary', agent: false }, (res) => {
          let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d)));
        });
      });
      const c = createCollector(new Store(), 0);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
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
    let PORT = 0;   // port 0: the OS picks a free one
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
      const c = createCollector(new Store(), 0, { ledger });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
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
    let PORT = 0;   // port 0: the OS picks a free one
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
      const c = createCollector(new Store(), 0, { ledger, now: () => clock });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
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
        checkKeys(t, ['status', 'enabled', 'asOf', 'day', 'costMicros', 'requests', 'bySource', 'byAttribution', 'unattributedN', 'hasTelemetry'], 'today');
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
        assert.strictEqual(st.spend.todayMicros, 0); assert.strictEqual(st.spend.hasTelemetry, true);   // telemetry has arrived, just none today
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
      'summaryLine', 'attributionSplit', 'formatTime', 'projectLabel', 'syncLabel', 'sparkPoints', 'pageState', 'noSpendYet'];
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

    test('console page: absolute /console/ assets, nav is Projects then Spend, source colours match the widget', () => {
      const html = fs.readFileSync(path.join(cdir, 'index.html'), 'utf8');
      const css = fs.readFileSync(path.join(cdir, 'console.css'), 'utf8');
      const appcss = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.css'), 'utf8');
      assert.match(html, /href="\/console\/console\.css"/);
      assert.match(html, /src="\/console\/console\.js"/);
      assert.match(html, /LOCAL WORKSPACE/);
      assert.match(html, /Local only/);
      assert.strictEqual((html.match(/class="nav-item/g) || []).length, 2);
      assert.ok(html.indexOf('data-route="projects"') < html.indexOf('data-route="spend"'));
      for (const v of ['--src-main', '--src-subagent', '--src-auxiliary', '--src-unattributed', '--src-hatch']) {
        const re = new RegExp(v + ':\\s*(#[0-9a-f]{6})', 'i');
        assert.strictEqual(css.match(re)[1].toLowerCase(), appcss.match(re)[1].toLowerCase(), v);
      }
      assert.match(css, /prefers-color-scheme: light/);
      for (const m of css.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 11, m[0]);
    });
  }

  /* ---- Phase 2 step 4: attention panel ---- */
  {
    const cdir = path.join(ROOT, 'src', 'renderer', 'console');
    const cjs = fs.readFileSync(path.join(cdir, 'console.js'), 'utf8');
    const names = ['esc', 'projectLabel', 'pillText', 'attentionState', 'waitLabel', 'ringIcon', 'pillHtml', 'waitWhat', 'reviewControl', 'attentionHtml'];
    const lifted = names.map((n) => cjs.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0]);
    const A = new Function(lifted.join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
    const sess = (o) => Object.assign({ projectName: 'sereno', state: 'idle', stateTool: '', stateArgShort: '', stateSince: 1000 }, o);

    test('attentionState: amber only for top-level blocked sessions', () => {
      for (const st of ['idle', 'running', 'thinking', 'compacting', 'stale', 'bogus', undefined, null, '']) {
        const r = A.attentionState({ sessions: [sess({ state: st })] });
        assert.deepStrictEqual([r.amber, r.count, r.items.length], [false, 0, 0], String(st));
      }
      assert.strictEqual(A.attentionState({ sessions: [sess({ state: 'running', stale: true })] }).amber, false);
      assert.strictEqual(A.attentionState({ sessions: [sess({ state: 'blocked', agent_id: 'a1' })] }).amber, false);
      for (const bad of [null, undefined, {}, { sessions: 'x' }, { sessions: [null, 5] }]) assert.strictEqual(A.attentionState(bad).amber, false);
      const r = A.attentionState({ sessions: [sess({ state: 'blocked', projectName: 'api', stateTool: 'Bash', stateArgShort: 'npm test', stateSince: 5000 }), sess()] });
      assert.deepStrictEqual(r, { amber: true, count: 1, items: [{ project: 'api', tool: 'Bash', arg: 'npm test', since: 5000 }] });
    });

    test('pillText singular and plural', () => {
      assert.strictEqual(A.pillText(1), '1 decision needs you');
      assert.strictEqual(A.pillText(2), '2 decisions need you');
      assert.strictEqual(A.pillText(5), '5 decisions need you');
      assert.strictEqual(A.pillHtml(0), '');
      assert.match(A.pillHtml(2), /2 decisions need you/);
    });

    test('attentionHtml: amber single, several, calm, unavailable', () => {
      const one = A.attentionHtml(A.attentionState({ sessions: [sess({ state: 'blocked', projectName: 'api', stateTool: 'Bash', stateArgShort: 'npm test', stateSince: 1000 })] }), 91000);
      assert.match(one, /attn-amber/);
      assert.match(one, /NEEDS YOUR ATTENTION/);
      assert.match(one, /api is waiting for permission\./);
      assert.match(one, /Bash npm test/);
      assert.match(one, /waiting 1m/);
      assert.match(one, /Answer it in the terminal\. Sereno only points you there\./);
      assert.ok(!/<button|<a /.test(one));
      const two = A.attentionHtml(A.attentionState({ sessions: [sess({ state: 'blocked', projectName: 'a' }), sess({ state: 'blocked', projectName: 'b', stateTool: 'Edit', stateSince: null })] }), 5000);
      assert.match(two, /2 sessions are waiting for permission\./);
      assert.match(two, /<strong>a<\/strong>/);
      assert.match(two, /<strong>b<\/strong>/);
      const calm = A.attentionHtml(A.attentionState({ sessions: [sess()] }), 1);
      assert.match(calm, /ALL CLEAR/);
      assert.match(calm, /Nothing needs you right now\./);
      assert.ok(!/Latest activity/i.test(calm + one));
      const off = A.attentionHtml({ unavailable: true }, 1);
      assert.match(off, /Live status unavailable/);
      for (const m of [calm, off]) assert.ok(!/amber|NEEDS YOUR/i.test(m), m);
      assert.ok(!/amber/i.test(A.attentionHtml(null, 1)));
    });

    test('attentionHtml escapes every API string and emits no style attribute', () => {
      const evil = '<img src=x onerror=alert(1)>';
      const st = A.attentionState({ sessions: [
        sess({ state: 'blocked', projectName: evil, stateTool: evil, stateArgShort: evil }),
      ] });
      const st2 = A.attentionState({ sessions: [
        sess({ state: 'blocked', projectName: evil, stateTool: evil, stateArgShort: evil }),
        sess({ state: 'blocked', projectName: evil, stateTool: evil, stateArgShort: '"x"' }),
      ] });
      for (const m of [A.attentionHtml(st, 5000), A.attentionHtml(st2, 5000)]) {
        assert.ok(!m.includes('<img'), m);
        assert.ok(m.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(!/style=/.test(m));
      }
      assert.ok(!/style=/.test(A.pillHtml(3)));
    });

    test('waitLabel', () => {
      assert.strictEqual(A.waitLabel(null, 1), '');
      assert.strictEqual(A.waitLabel(1000, 46000), 'waiting 45s');
      assert.strictEqual(A.waitLabel(0, 181000), 'waiting 3m');
      assert.strictEqual(A.waitLabel(0, 3700000), 'waiting 1h 1m');
      assert.strictEqual(A.waitLabel(9000, 1000), 'waiting 0s');
    });

    test('console: /state fetched on refresh and every 10s while the stream is not open; page has the aside, no action', () => {
      const html = fs.readFileSync(path.join(cdir, 'index.html'), 'utf8');
      const css = fs.readFileSync(path.join(cdir, 'console.css'), 'utf8');
      assert.match(cjs, /getJson\('\/state'\)/);
      assert.match(cjs, /!streamOpen\(\)\) refreshAttention\(\);\n  \}, 10000\)/);
      assert.match(cjs, /refreshAttention\(\);\n  const token = \+\+state\.token/);
      assert.match(html, /<aside class="attn-col" id="attn"/);
      assert.match(css, /@media \(max-width: 1359px\)/);
      assert.strictEqual((cjs.match(/\.innerHTML\s*=/g) || []).length, 1);
    });
  }

  /* ---- Phase 3 step 5: Projects tab ---- */
  {
    const cdir = path.join(ROOT, 'src', 'renderer', 'console');
    const cjs = fs.readFileSync(path.join(cdir, 'console.js'), 'utf8');
    const names = ['estMoney', 'esc', 'sparkPoints', 'projectLabel', 'pillText', 'attentionState', 'waitLabel', 'ringIcon', 'pillHtml',
      'waitWhat', 'reviewControl', 'attentionHtml', 'parseRoute', 'initialRoute', 'relTime', 'staleDaysOf', 'freshnessChip', 'hasBlocker',
      'topSessions', 'isActive', 'visibleProjects', 'filterCounts', 'selectProjects', 'projectsSummary', 'gitLine', 'sparkSvg',
      'isLiveSession', 'liveState', 'liveShape', 'branchRows', 'cardHtml', 'liveStrip', 'hiddenSection', 'filterBar', 'projectsBody', 'actionRequest', 'reviewRequest'];
    const lifted = names.map((n) => cjs.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0]);
    const P = new Function(lifted.join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
    const NOW = 1_800_000_000_000;
    const MIN = 60000, DAY = 86400000;
    const mk = (o) => Object.assign({
      id: 'p1', name: 'alpha', hidden: false, freshness: 'fresh',
      brief: { now: 'Doing x', next: 'Then y', blocked: 'None', generatedAt: NOW - DAY },
      git: { defaultBranch: 'main', ahead: 2, behind: 0, dirty: false, lastCommitAt: NOW - 8 * MIN },
      prs: 2, branches: [], spend14: { costMicros: 68_200_000, trend: new Array(14).fill(1) },
      lastActivity: NOW - 8 * MIN, error: false,
    }, o);
    const evil = '<img src=x onerror=alert(1)>';

    test('route parsing: #spend, #projects, junk and no hash', () => {
      assert.strictEqual(P.parseRoute('#spend'), 'spend');
      assert.strictEqual(P.parseRoute('#projects'), 'projects');
      for (const j of ['', '#', '#nope', '#spend/../x', null, undefined, '#<script>']) assert.strictEqual(P.parseRoute(j), 'projects', String(j));
      assert.strictEqual(P.initialRoute('', 'spend'), 'spend');
      assert.strictEqual(P.initialRoute('', null), 'projects');
      assert.strictEqual(P.initialRoute('', 'junk'), 'projects');
      assert.strictEqual(P.initialRoute('#projects', 'spend'), 'projects');
      assert.strictEqual(P.initialRoute('#spend', 'projects'), 'spend');
      assert.match(cjs, /localStorage\.getItem\('sereno\.console\.tab'\)/);
      assert.match(cjs, /try \{ localStorage\.setItem\('sereno\.console\.tab', r\)/);
    });

    test('projectsSummary: counts and the decision clause', () => {
      const ps = [mk({}), mk({ id: 'b', brief: { now: 'a', next: 'b', blocked: 'Production key' } }),
        mk({ id: 'c', freshness: 'stale', brief: { now: 'a', next: 'b', blocked: 'none' } }),
        mk({ id: 'd', hidden: true, freshness: 'stale', brief: { blocked: 'x' } }), mk({ id: 'e', brief: null, freshness: 'none' })];
      assert.strictEqual(P.projectsSummary(ps, 0), '4 projects · 1 with blockers · 1 stale · nothing needs a decision');
      assert.match(P.projectsSummary(ps, 1), /· 1 session needs you$/);
      assert.match(P.projectsSummary(ps, 3), /· 3 sessions need you$/);
      assert.match(P.projectsSummary([], 0), /^0 projects · 0 with blockers/);
      assert.strictEqual(P.hasBlocker({ brief: { blocked: '' } }), false);
      assert.strictEqual(P.hasBlocker({ brief: null }), false);
      assert.strictEqual(P.hasBlocker({ brief: { blocked: 'None.' } }), false);
    });

    test('filterCounts / isActive / selectProjects: live session or commit in 24h, sorted by activity, hidden excluded', () => {
      const a = mk({ id: 'a', name: 'alpha', git: { lastCommitAt: NOW - 3 * DAY }, lastActivity: NOW - 3 * DAY });
      const b = mk({ id: 'b', name: 'beta', git: { lastCommitAt: NOW - 2 * 3600000 }, lastActivity: NOW - 2 * 3600000 });
      const c = mk({ id: 'c', name: 'gamma', git: { lastCommitAt: null }, lastActivity: null });
      const h = mk({ id: 'h', name: 'hid', hidden: true });
      const live = [{ projectName: 'gamma', state: 'running' }, { projectName: 'alpha', state: 'idle' }];
      assert.strictEqual(P.isActive(a, [], NOW), false);
      assert.strictEqual(P.isActive(a, live, NOW), false, 'an idle session alone does not make a project active');
      assert.strictEqual(P.isActive(a, [{ projectName: 'alpha', state: 'running', stale: true }], NOW), false);
      for (const st of ['running', 'thinking', 'blocked']) assert.strictEqual(P.isActive(a, [{ projectName: 'alpha', state: st }], NOW), true, st);
      assert.strictEqual(P.isActive(b, [], NOW), true);
      assert.strictEqual(P.isActive(c, live, NOW), true);
      assert.deepStrictEqual(P.filterCounts([a, b, c, h], live, NOW), { all: 3, active: 2, quiet: 1 });
      assert.deepStrictEqual(P.selectProjects([a, b, c, h], 'all', live, NOW).map((p) => p.id), ['b', 'a', 'c']);
      assert.deepStrictEqual(P.selectProjects([a, b, c, h], 'active', live, NOW).map((p) => p.id), ['b', 'c']);
      assert.deepStrictEqual(P.selectProjects([a, b, c, h], 'quiet', live, NOW).map((p) => p.id), ['a']);
    });

    test('liveState: best non-stale top-level session; shapes per state', () => {
      const a = mk({});
      const S = (state, o) => Object.assign({ projectName: 'alpha', state }, o);
      assert.strictEqual(P.liveState(a, []), null);
      assert.strictEqual(P.liveState(a, [S('idle')]), 'idle');
      assert.strictEqual(P.liveState(a, [S('idle'), S('thinking'), S('running')]), 'running');
      assert.strictEqual(P.liveState(a, [S('running'), S('blocked')]), 'blocked');
      assert.strictEqual(P.liveState(a, [S('blocked', { stale: true })]), null);
      assert.strictEqual(P.liveState(a, [S('blocked', { agent_id: 'x' })]), null);
      assert.strictEqual(P.liveState(a, [{ projectName: 'other', state: 'running' }]), null);
      assert.match(P.liveShape('blocked'), /pshape-need/);
      assert.match(P.liveShape('running'), /pshape-live/);
      assert.match(P.liveShape('thinking'), /stroke-dasharray/);
      for (const q of ['idle', null]) assert.ok(!/pshape-live|pshape-need|dasharray/.test(P.liveShape(q)));
      assert.match(P.cardHtml(a, { now: NOW, state: 'blocked' }), /pshape-need/);
    });

    test('freshnessChip: one shape per state, stale wording from the mockup', () => {
      assert.deepStrictEqual(P.freshnessChip('fresh'), { label: 'fresh', cls: 'chip-fresh' });
      assert.deepStrictEqual(P.freshnessChip('behind'), { label: 'behind', cls: 'chip-behind' });
      assert.deepStrictEqual(P.freshnessChip('stale', 9), { label: 'Brief is 9 days behind', cls: 'chip-stale' });
      assert.strictEqual(P.freshnessChip('stale', 1).label, 'Brief is 1 day behind');
      assert.strictEqual(P.freshnessChip('stale', null).label, 'stale');
      assert.deepStrictEqual(P.freshnessChip('none'), { label: 'No brief', cls: 'chip-none' });
      assert.deepStrictEqual(P.freshnessChip('unknown'), { label: 'Brief source not found', cls: 'chip-unknown' });
      assert.strictEqual(P.freshnessChip('whatever').label, 'No brief');
      assert.strictEqual(P.staleDaysOf(NOW - 9 * DAY - 5 * MIN, NOW), 9);
      assert.strictEqual(P.staleDaysOf(NOW - 25 * 3600000, NOW), 1);
      assert.strictEqual(P.staleDaysOf(NOW - 3600000, NOW), 1);
      assert.strictEqual(P.staleDaysOf(null, NOW), null);
      assert.strictEqual(P.staleDaysOf(undefined, NOW), null);
    });

    test('gitLine: arrows, PRs and last commit are each left out when null', () => {
      assert.strictEqual(P.gitLine({ defaultBranch: 'main', ahead: 2, behind: 0, lastCommitAt: NOW - 8 * MIN }, 2, NOW),
        'main ↑2 ↓0 · 2 open PRs · Last commit 8 min ago');
      assert.strictEqual(P.gitLine({ defaultBranch: 'main', ahead: 0, behind: 3, lastCommitAt: NOW - 2 * DAY }, 1, NOW),
        'main ↑0 ↓3 · 1 open PR · Last commit 2 days ago');
      assert.strictEqual(P.gitLine({ defaultBranch: 'main', ahead: null, behind: null, lastCommitAt: NOW - 8 * MIN }, null, NOW),
        'main · Last commit 8 min ago');
      assert.strictEqual(P.gitLine({ defaultBranch: 'main', ahead: 1, behind: null, lastCommitAt: null }, 0, NOW), 'main · 0 open PRs');
      assert.strictEqual(P.gitLine(null, null, NOW), '');
      assert.strictEqual(P.relTime(NOW - 5 * 3600000, NOW), '5 hours ago');
      assert.strictEqual(P.relTime(null, NOW), '');
      assert.ok(!/NaN/.test(P.gitLine({ defaultBranch: 'main', ahead: NaN, behind: 1, lastCommitAt: NaN }, undefined, NOW)));
    });

    test('cardHtml: escapes the project name and brief lines, no style attribute', () => {
      const html = P.cardHtml(mk({
        name: evil, id: evil,
        brief: { now: evil, next: '<b>x</b>', blocked: '"q" & <i>', generatedAt: NOW },
        branches: [{ name: evil, freshness: 'fresh', now: evil }],
      }), { now: NOW, state: 'running' });
      assert.ok(!html.includes('<img'), html);
      assert.ok(!html.includes('<b>') && !html.includes('<i>'));
      assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
      assert.ok(!/style=/.test(html));
      assert.match(html, /<span class="k">Now<\/span>/);
      assert.match(html, /Hide project/);
      assert.match(html, /14-day spend/);
      assert.match(html, /\$68\.20 est\./);
      assert.ok(/pshape-live/.test(html));
      assert.ok(!/pshape-live/.test(P.cardHtml(mk({}), { now: NOW, state: 'idle' })));
    });

    test('cardHtml: spend via estMoney, column omitted when spend14 is null, dirty marker, no-brief copy', () => {
      const plain = P.cardHtml(mk({ spend14: null, git: { defaultBranch: 'main', ahead: 0, behind: 0, dirty: true, lastCommitAt: NOW - MIN } }), { now: NOW });
      assert.ok(!/14-day spend|est\./.test(plain));
      assert.match(plain, /class="dirty"/);
      assert.ok(!/class="dirty"/.test(P.cardHtml(mk({}), { now: NOW })));
      const nb = P.cardHtml(mk({ brief: null, freshness: 'none' }), { now: NOW });
      assert.match(nb, /No brief yet — run \/brief in a session/);
      assert.match(nb, /chip-none/);
      assert.ok(!/class="kv"/.test(nb));
      assert.match(P.cardHtml(mk({ brief: null, freshness: 'unknown' }), { now: NOW }), /Brief source not found/);
      const stale = P.cardHtml(mk({ freshness: 'stale', brief: { now: 'a', next: 'b', blocked: 'c', generatedAt: NOW, behindSince: NOW - 9 * DAY - MIN } }), { now: NOW });
      assert.match(stale, /chip-stale">Brief is 9 days behind</);
      const beh = P.cardHtml(mk({ freshness: 'behind', brief: { now: 'a', next: 'b', blocked: 'c', generatedAt: NOW - 30 * DAY, behindSince: NOW - 2 * 3600000 } }), { now: NOW });
      assert.match(beh, /chip-behind">behind</);
      assert.ok(!/days? behind/.test(beh), 'wording counts from behindSince, not generatedAt');
      assert.match(cjs, /esc\(estMoney\(p\.spend14\.costMicros\)\)/);
    });

    test('cardHtml: git error is a quiet line, never amber; calm markup has no amber class', () => {
      const err = P.cardHtml(mk({ error: true }), { now: NOW });
      assert.match(err, /Git status unavailable/);
      assert.ok(!/open PR|Last commit/.test(err));
      const calm = P.projectsBody([mk({}), mk({ id: 'z', name: 'zed', error: true, freshness: 'none', brief: null })],
        [{ projectName: 'alpha', state: 'idle', stateSince: NOW - MIN }], 'all', false, NOW);
      for (const m of [err, calm]) assert.ok(!/amber|pill-amber|attn-amber/i.test(m), m);
    });

    test('branchRows: chip and brief now, or "No brief"', () => {
      const h = P.branchRows([{ name: 'feat/a', freshness: 'behind', now: 'Sync queue' }, { name: 'feat/b', freshness: 'none', now: null },
        { name: 'feat/c', freshness: 'stale', now: 'Last known' }]);
      assert.match(h, /↳ feat\/a/);
      assert.match(h, /chip-behind">behind</);
      assert.match(h, /Sync queue/);
      assert.match(h, /quiet-text">No brief</);
      assert.match(h, /chip-stale">stale</);
      const d = P.branchRows([{ name: 'main', freshness: 'fresh', now: 'dup' }, { name: 'feat/s', freshness: 'stale', now: 'x', behindSince: NOW - 4 * DAY - MIN }], 'main', NOW);
      assert.ok(!/main|dup/.test(d), 'the default branch is not a branch row');
      assert.match(d, /chip-stale">Brief is 4 days behind</);
      assert.ok(!/\u21b3 main/.test(P.cardHtml(mk({ branches: [{ name: 'main', freshness: 'fresh', now: 'dup' }] }), { now: NOW })));
      assert.strictEqual(P.branchRows(null), '');
      assert.strictEqual(P.branchRows([]), '');
      assert.ok(!/<img/.test(P.branchRows([{ name: evil, freshness: 'fresh', now: evil }])));
    });

    test('liveStrip: project / state with relative time; omitted when none', () => {
      const h = P.liveStrip([{ projectName: 'alpha', state: 'running', stateSince: NOW - 8 * MIN }, { projectName: evil, state: 'blocked', stateSince: null }], NOW);
      assert.match(h, /LIVE SESSIONS/);
      assert.match(h, /alpha \/ running/);
      assert.match(h, /8 min ago/);
      assert.ok(!h.includes('<img') && !/style=/.test(h));
      assert.ok(h.indexOf('alpha') < h.indexOf('&lt;img'), 'newest first');
      const mkS = (i, o) => Object.assign({ projectName: 'p' + i, state: 'running', stateSince: NOW - i * MIN }, o);
      const nine = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkS(i));
      const capped = P.liveStrip(nine, NOW);
      assert.strictEqual((capped.match(/class="live-item"/g) || []).length, 6);
      assert.match(capped, /\+3 more/);
      assert.ok(!/p6 \//.test(capped));
      assert.ok(!/more/.test(P.liveStrip(nine.slice(0, 6), NOW)));
      assert.strictEqual(P.liveStrip([mkS(1, { state: 'idle' }), mkS(2, { stale: true }), mkS(3, { agent_id: 'a' })], NOW), '', 'idle, stale and subagent rows are omitted');
      assert.match(P.liveStrip([mkS(1, { state: 'thinking' }), mkS(2, { state: 'idle' })], NOW), /p1 \/ thinking/);
      assert.ok(!/p2/.test(P.liveStrip([mkS(1, { state: 'thinking' }), mkS(2, { state: 'idle' })], NOW)));
      assert.strictEqual(P.liveStrip([], NOW), '');
      assert.strictEqual(P.liveStrip(null, NOW), '');
      assert.ok(!/LIVE SESSIONS/.test(P.projectsBody([mk({})], [], 'all', false, NOW)));
    });

    test('projectsBody: empty state, filters, hidden toggle with Unhide', () => {
      assert.match(P.projectsBody([], [], 'all', false, NOW), /Projects appear when a Claude Code session runs in a git repo\./);
      const ps = [mk({}), mk({ id: 'h1', name: 'secret', hidden: true })];
      const closed = P.projectsBody(ps, [], 'all', false, NOW);
      assert.match(closed, /1 hidden · show/);
      assert.ok(!/Unhide|secret/.test(closed));
      const open = P.projectsBody(ps, [], 'all', true, NOW);
      assert.match(open, /1 hidden · hide/);
      assert.match(open, /data-act="unhide" data-id="h1">Unhide</);
      assert.match(open, /All 1/);
      assert.match(open, /Active 1/);
      assert.match(open, /Quiet 0/);
      assert.ok(!/hidden/.test(P.projectsBody([mk({})], [], 'all', false, NOW).replace(/aria-hidden/g, '')));
    });

    test('attention panel: Review in terminal only when amber, with a session id and opts.review', () => {
      const st = P.attentionState({ sessions: [{ id: 's-1', projectName: 'alpha', state: 'blocked', stateTool: 'Bash', stateSince: NOW }] });
      assert.strictEqual(st.items[0].sessionId, 's-1');
      const btn = P.attentionHtml(st, NOW, { review: true });
      assert.match(btn, /<button type="button" class="btn-review" data-act="review" data-sid="s-1">Review in terminal ↗<\/button>/);
      assert.ok(!/<button/.test(P.attentionHtml(st, NOW)));
      assert.match(P.attentionHtml(st, NOW, { review: true, msgs: { 's-1': 'ok' } }), /Raised the terminal/);
      assert.match(P.attentionHtml(st, NOW, { review: true, msgs: { 's-1': 'na' } }), /Open the widget to review/);
      assert.ok(!/<button/.test(P.attentionHtml(st, NOW, { review: true, na: true })));
      assert.match(P.attentionHtml(st, NOW, { review: true, msgs: { 's-1': 'err' } }), /Could not raise the terminal/);
      const two = P.attentionState({ sessions: [{ id: 'a', projectName: 'x', state: 'blocked' }, { id: 'b', projectName: 'y', state: 'blocked' }] });
      assert.strictEqual((P.attentionHtml(two, NOW, { review: true }).match(/<button/g) || []).length, 2);
      const calm = P.attentionHtml(P.attentionState({ sessions: [{ id: 'a', projectName: 'x', state: 'idle' }] }), NOW, { review: true });
      assert.ok(!/<button|amber/i.test(calm));
      const bad = P.attentionHtml(P.attentionState({ sessions: [{ id: '"><img src=x>', projectName: 'x', state: 'blocked' }] }), NOW, { review: true });
      assert.ok(!bad.includes('<img'));
    });

    test('reviewRequest: exactly the two headers and one body key', () => {
      const r = P.reviewRequest('s-1', 'tok');
      assert.strictEqual(r.method, 'POST');
      assert.deepStrictEqual(Object.keys(r.headers).sort(), ['content-type', 'x-sereno-token']);
      assert.strictEqual(r.headers['content-type'], 'application/json');
      assert.strictEqual(r.headers['x-sereno-token'], 'tok');
      assert.deepStrictEqual(JSON.parse(r.body), { sessionId: 's-1' });
      assert.deepStrictEqual(Object.keys(r), ['method', 'headers', 'body']);
      assert.deepStrictEqual(JSON.parse(P.actionRequest({ hidden: true }, 't').body), { hidden: true });
    });

    test('console.js: token cached and refetched on 403, 501 handled, one innerHTML write, refresh cadence', () => {
      assert.strictEqual((cjs.match(/\.innerHTML\s*=/g) || []).length, 1);
      assert.match(cjs, /getJson\('\/api\/token'\)/);
      assert.match(cjs, /attempt > 0/);
      assert.match(cjs, /status === 501/);
      assert.match(cjs, /'\/api\/projects\/' \+ encodeURIComponent\(id\) \+ '\/hide'/);
      assert.match(cjs, /getJson\('\/api\/projects'\)/);
      assert.match(cjs, /refreshProjects\(\); \}, 30000\)/);
      assert.match(cjs, /addEventListener\('focus'/);
      assert.ok(!/style=/.test(cjs.replace(/el.style./g, '')));
      assert.ok(!/prompt_text|promptText/.test(cjs));
      const css = fs.readFileSync(path.join(cdir, 'console.css'), 'utf8');
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
      let PORT = 0;   // port 0: the OS picks a free one
      const c = createCollector(new Store(), 0);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
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

  /* ---- [spend exit] Phase 2 exit criteria, one end-to-end test each ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const life = require('../src/ledger-life.js');
    const otlpLogsFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-logs.json'), 'utf8'));
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const conSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
    const lf = (src, n) => src.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0];
    const W = new Function(['estMoney', 'spendMode'].map((n) => lf(appSrc, n)).join('\n') + '\nreturn { estMoney, spendMode };')();
    const CN = ['estMoney', 'esc', 'largestRemainder', 'niceTicks', 'tickLabel', 'segmentsOf', 'barGeometry', 'summaryLine',
      'attributionSplit', 'formatTime', 'projectLabel', 'sparkPoints', 'sw', 'dayLabel', 'chartSvg', 'legendHtml', 'chartTitle',
      'chartSection', 'projectsSection', 'promptsSection'];
    const mkCon = (state) => new Function('state', "const RANGES = ['24h', '7d', '30d'];\n"
      + "const SRC_LABEL = { main: 'Main', subagent: 'Subagent', auxiliary: 'Auxiliary', unattributed: 'Unattributed' };\n"
      + "const ATTR_LABEL = { explicit: 'Explicit', unknown: 'Unattributed', mixed: 'Mixed' };\n"
      + CN.map((n) => lf(conSrc, n)).join('\n') + '\nreturn { ' + CN.join(', ') + ' };')(state);
    const WN = ['estMoney', 'esc', 'largestRemainder', 'sourceSegments', 'barAriaLabel', 'cumulativePoints', 'segmentWidths',
      'nowPosition', 'nowMarkerX', 'spendHtml'];
    const widget = new Function('const SPEND_W = 324, SPEND_H = 30, SPEND_TOP = 12;\n'
      + WN.map((n) => lf(appSrc, n)).join('\n') + '\nreturn { spendHtml };')();

    const T0 = new Date(2026, 5, 10, 13, 45).getTime();
    let clock = T0;
    const portMap = new Map();   // the logical id each test passes -> the port the OS gave
    const rqx = (port, opts) => new Promise((resolve) => {
      const r = http.request(Object.assign({ host: '127.0.0.1', port: portMap.get(port) || port, agent: false }, opts), (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end(opts.body);
    });
    const getX = (port, p, headers) => rqx(port, { method: 'GET', path: p, headers: headers || {} });
    const jsonX = async (port, p) => JSON.parse((await getX(port, p)).body);
    // the otlp fixture with every record's timestamp replaced, in document order
    const fixtureAt = (tsFor) => {
      const fx = JSON.parse(JSON.stringify(otlpLogsFx));
      let i = 0;
      for (const rl of fx.resourceLogs) for (const sl of rl.scopeLogs) for (const rec of sl.logRecords) {
        rec.timeUnixNano = String(BigInt(tsFor(i++)) * 1000000n);
      }
      return fx;
    };
    const postLogs = (port, fx) => rqx(port, { method: 'POST', path: '/v1/logs', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fx) });
    const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-exit-')), 'sereno.db');
    const open = (file) => openLedger({ file, retentionDays: 36500 });
    const boot = async (port, ledger) => {
      const c = createCollector(new Store(), 0, { ledger, now: () => clock });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (portMap.set(port, a.port), res()))));
      return c;
    };
    const halt = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });
    const SPEND_ROUTES = ['/api/spend/today', '/api/spend/series?range=7d', '/api/spend/series?range=24h',
      '/api/spend/projects', '/api/spend/top-prompts'];
    // every key that may appear in an /api/spend/* body at any depth (the Step 1 documented shapes)
    const ALLOWED = new Set(['status', 'enabled', 'hasTelemetry', 'asOf', 'day', 'costMicros', 'requests', 'bySource', 'byAttribution',
      'unattributedN', 'range', 'buckets', 'key', 'since', 'until', 'rows', 'unattributed', 'project', 'trend', 'ts',
      'sessionShort', 'models', 'attribution']);
    const LEAF_MAPS = { bySource: ['main', 'subagent', 'auxiliary'], byAttribution: ['explicit', 'unknown'] };
    const walkKeys = (o, where) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walkKeys(x, where + '[' + i + ']')); return; }
      if (!o || typeof o !== 'object') return;
      for (const k of Object.keys(o)) {
        assert.ok(ALLOWED.has(k), where + ': key outside the allowlist: ' + k);
        if (LEAF_MAPS[k]) {
          for (const lk of Object.keys(o[k])) assert.ok(LEAF_MAPS[k].includes(lk), where + '.' + k + ': unexpected ' + lk);
        } else walkKeys(o[k], where + '.' + k);
      }
    };
    const withTmpHome = async (fn) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-exit-home-'));
      const prev = process.env.SERENO_HOME;
      process.env.SERENO_HOME = dir;
      try { await fn(dir); } finally {
        if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    await atest('[spend exit 1] widget today, /api/spend/today and the Spend tab show one figure', async () => {
      clock = T0;
      const file = tmpDb();
      const l = open(file);
      const c = await boot(8802, l);
      try {
        l.recordHook('SessionStart', { session_id: 'sess-exit-1111', cwd: 'C:\\work\\exit' });
        assert.strictEqual((await postLogs(8802, fixtureAt((i) => T0 - (i + 1) * 60000))).status, 200);
        const st = await jsonX(8802, '/state');
        const today = await jsonX(8802, '/api/spend/today');
        const projects = await jsonX(8802, '/api/spend/projects');
        assert.ok(today.costMicros > 0, 'fixture should produce spend');
        assert.strictEqual(st.spend.todayMicros, today.costMicros);
        const CN1 = mkCon({});
        const line = CN1.summaryLine(today, projects);
        assert.ok(line.startsWith(CN1.estMoney(st.spend.todayMicros) + ' today'), line);
        assert.strictEqual(CN1.estMoney(st.spend.todayMicros), W.estMoney(st.spend.todayMicros));
        assert.ok(widget.spendHtml(st.spend, null).includes(W.estMoney(today.costMicros)));
      } finally { await halt(c); l.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    });

    await atest('[spend exit 2] today survives closing and reopening the ledger on the same file', async () => {
      clock = T0;
      const file = tmpDb();
      let l = open(file);
      let c = await boot(8803, l);
      let before;
      try {
        await postLogs(8803, fixtureAt((i) => T0 - (i + 1) * 60000));
        before = await jsonX(8803, '/api/spend/today');
        assert.ok(before.costMicros > 0);
      } finally { await halt(c); l.close(); }
      l = open(file);
      c = await boot(8803, l);
      try {
        assert.deepStrictEqual(await jsonX(8803, '/api/spend/today'), before);
      } finally { await halt(c); l.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    });

    await atest('[spend exit 3] 23:59 and 00:01 land on different days and different hour buckets', async () => {
      const day1 = new Date(2026, 5, 10, 23, 59).getTime();
      const day2 = new Date(2026, 5, 11, 0, 1).getTime();
      clock = new Date(2026, 5, 11, 0, 30).getTime();
      const file = tmpDb();
      const l = open(file);
      const c = await boot(8804, l);
      try {
        // fixture record 0 at 23:59, the rest at 00:01
        await postLogs(8804, fixtureAt((i) => (i === 0 ? day1 : day2)));
        const nonzero = (s) => s.buckets.map((b, i) => [i, b.costMicros]).filter((x) => x[1] > 0).map((x) => x[0]);
        const week = await jsonX(8804, '/api/spend/series?range=7d');
        const wi = nonzero(week);
        assert.deepStrictEqual(wi, [5, 6], 'two adjacent local days, got ' + JSON.stringify(wi));
        assert.notStrictEqual(week.buckets[5].key, week.buckets[6].key);
        const hours = await jsonX(8804, '/api/spend/series?range=24h');
        const hi = nonzero(hours);
        assert.strictEqual(hi.length, 2, 'two hour buckets, got ' + JSON.stringify(hi));
        assert.strictEqual(hours.buckets[hi[1]].since - hours.buckets[hi[0]].since, 3600000);
        assert.ok(day1 >= hours.buckets[hi[0]].since && day1 < hours.buckets[hi[0]].until);
        assert.ok(day2 >= hours.buckets[hi[1]].since && day2 < hours.buckets[hi[1]].until);
      } finally { await halt(c); l.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    });

    await atest('[spend exit 4] ledger off: every spend route is { enabled:false }, widget mode off, no database file', async () => {
      await withTmpHome(async (dir) => {
        const r = life.startLedger({ ledger: { enabled: false, retentionDays: 90 } });
        assert.strictEqual(r.ledger, null);
        const c = await boot(8805, null);
        try {
          for (const p of SPEND_ROUTES) {
            const res = await getX(8805, p);
            assert.strictEqual(res.status, 200, p);
            assert.deepStrictEqual(JSON.parse(res.body), { enabled: false }, p);
          }
          const st = await jsonX(8805, '/state');
          assert.deepStrictEqual(st.spend, { enabled: false });
          assert.strictEqual(W.spendMode(st.spend), 'off');
        } finally { await halt(c); }
        const left = fs.readdirSync(dir).filter((f) => /^sereno\.db/.test(f));
        assert.deepStrictEqual(left, [], 'database files: ' + left.join(', '));
      });
    });

    await atest('[spend exit 5] every /api/spend/* response uses only allowlisted keys; sessionShort is at most 8 chars', async () => {
      clock = T0;
      const file = tmpDb();
      const l = open(file);
      const c = await boot(8806, l);
      try {
        l.recordHook('SessionStart', { session_id: 'sess-exit-5555-long-session-id', cwd: 'C:\\work\\exit5' });
        await postLogs(8806, fixtureAt((i) => T0 - (i + 1) * 60000));
        let shorts = 0;
        for (const p of SPEND_ROUTES) {
          const body = await jsonX(8806, p);
          assert.strictEqual(body.enabled, true, p);
          walkKeys(body, p);
          for (const r of body.rows || []) if ('sessionShort' in r) { shorts++; assert.ok(r.sessionShort.length <= 8, r.sessionShort); }
        }
        assert.ok(shorts > 0, 'top-prompts should have produced rows');
      } finally { await halt(c); l.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    });

    await atest('[spend exit 6] every money string in widget and console markup ends in est. (y-axis ticks excepted)', async () => {
      clock = T0;
      const file = tmpDb();
      const l = open(file);
      const c = await boot(8807, l);
      try {
        l.recordHook('SessionStart', { session_id: 'sess-exit-6666', cwd: 'C:\\work\\exit6' });
        await postLogs(8807, fixtureAt((i) => T0 - (i + 1) * 60000));
        const st = await jsonX(8807, '/state');
        const h24 = await jsonX(8807, '/api/spend/series?range=24h');
        const state = { range: '7d', series: await jsonX(8807, '/api/spend/series?range=7d'),
          today: await jsonX(8807, '/api/spend/today'), projects: await jsonX(8807, '/api/spend/projects'),
          top: await jsonX(8807, '/api/spend/top-prompts') };
        const CN6 = mkCon(state);
        const markups = {
          widget: widget.spendHtml(st.spend, h24),
          'console summary': CN6.summaryLine(state.today, state.projects),
          'console sidebar': CN6.estMoney(state.today.costMicros) + ' today',
          'console chart 7d': CN6.chartSvg(state.series, 640),
          'console chart 24h': CN6.chartSvg(h24, 640),
          'console projects': CN6.projectsSection(),
          'console prompts': CN6.promptsSection(),
        };
        // The one exception: y-axis tick labels are bare dollar amounts ("$10") inside <text ... text-anchor="end">
        // elements in the chart svg; the chart caption says "USD · estimated" and tooltips carry est. figures.
        const TICK = /<text [^>]*text-anchor="end">\$[0-9][0-9.]*<\/text>/g;
        let money = 0, ticks = 0;
        for (const [name, html] of Object.entries(markups)) {
          const rest = html.replace(TICK, () => { ticks++; return ''; });
          for (const m of rest.matchAll(/\$[0-9][0-9.,]*/g)) {
            money++;
            assert.strictEqual(rest.slice(m.index + m[0].length, m.index + m[0].length + 5), ' est.',
              name + ': ' + rest.slice(Math.max(0, m.index - 20), m.index + 30));
          }
        }
        assert.ok(money >= 10, 'expected a populated state, saw ' + money + ' money strings');
        assert.ok(ticks >= 6, 'the tick exception should have been exercised, saw ' + ticks);
      } finally { await halt(c); l.close(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
    });

    await atest('[spend exit 7] foreign Host and foreign Origin get 403 on /console, its script and every /api/spend/* route', async () => {
      clock = T0;
      const l = open(':memory:');
      const c = await boot(8808, l);
      try {
        const paths = ['/console', '/console/console.js'].concat(SPEND_ROUTES);
        for (const p of paths) {
          assert.strictEqual((await getX(8808, p)).status, 200, 'control ' + p);
          assert.strictEqual((await getX(8808, p, { host: 'evil.example' })).status, 403, 'host ' + p);
          assert.strictEqual((await getX(8808, p, { origin: 'http://evil.example' })).status, 403, 'origin ' + p);
        }
      } finally { await halt(c); l.close(); }
    });
  }

  /* ---- Phase 2: red-team fixes ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const spendtime = require('../src/spendtime.js');
    const rawGet = (port, p) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: p, agent: false }, (r) => {
        let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', () => resolve({ status: 0, body: '' }));
    });
    const lf = (src, n) => src.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0];
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const conSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');

    await atest('static: NUL bytes and bad encodings answer 4xx and the server survives', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      const c = createCollector(new Store(), 0);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      try {
        for (const p of ['/%00', '/console/%00', '/console/index.html%00.js', '/%E0%A4%A']) {
          const r = await rawGet(PORT, p);
          assert.ok(r.status >= 400 && r.status < 500, p + ' -> ' + r.status);
          assert.strictEqual((await rawGet(PORT, '/state')).status, 200, 'alive after ' + p);
        }
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
    });

    await atest('snapshot spend: a failing ledger never shows yesterday as today (stale only within the day)', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      let clock = new Date(2026, 5, 10, 13, 0).getTime();
      const l = openLedger({ file: ':memory:' });
      l.ingestRequests([{ requestKey: 'k1', requestId: 'r1', sessionId: 's1', promptId: 'p1', ts: clock - 1000, model: 'm',
        querySource: 'repl_main_thread', source: 'main', agentName: null, inputTokens: 1, outputTokens: 1,
        cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 5000, durationMs: 1 }]);
      const c = createCollector(new Store(), 0, { ledger: l, now: () => clock });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      const spend = async () => JSON.parse((await rawGet(PORT, '/state')).body).spend;
      try {
        assert.strictEqual((await spend()).todayMicros, 5000);
        l.today = () => { throw new Error('boom'); };
        clock += 3600000;
        c.setLedger(l);   // same day: keep the last good figure
        const same = await spend();
        assert.strictEqual(same.todayMicros, 5000); assert.ok(!same.unavailable);
        clock += 24 * 3600000;
        c._tickSpend();   // next day: yesterday must not be presented
        assert.deepStrictEqual(await spend(), { enabled: true, unavailable: true });
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); l.close(); }
    });

    // Grouped results vs a per-row reference; self-contained so a TZ child process can run it too.
    function groupingCheck(ledgerPath, spendtimePath) {
      const assert = require('node:assert');
      const { openLedger } = require(ledgerPath);
      const st = require(spendtimePath);
      const l = openLedger({ file: ':memory:', retentionDays: 36500 });
      const asOf = new Date(2026, 5, 10, 13, 0).getTime();
      const at = (dd, h, m, s, ms) => new Date(2026, 5, 10 + dd, h, m, s, ms).getTime();
      const stamps = [];
      for (const dd of [-1, 0]) {
        stamps.push(at(dd, 0, 0, 0, 0), at(dd, 0, 14, 59, 999), at(dd, 0, 15, 0, 0), at(dd, 23, 59, 59, 999),
          at(dd, 12, 0, 0, 0), at(dd, 12, 59, 59, 999));
      }
      const rows = stamps.map((ts, i) => ({
        requestKey: 'k' + i, requestId: 'r' + i, sessionId: 's' + (i % 3), promptId: i % 4 === 0 ? null : 'p' + (i % 4),
        ts, model: 'm' + (i % 2), querySource: 'x', source: ['main', 'subagent', 'auxiliary'][i % 3], agentName: null,
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 1000 + i * 7, durationMs: 1,
      }));
      l.ingestRequests(rows);
      l.recordHook('SessionStart', { session_id: 's0', cwd: '/x/alpha' });
      l.recordHook('SessionStart', { session_id: 's1', cwd: '/x/beta' });   // s2 has no project
      const raw = l._db.prepare('SELECT r.ts AS ts, r.source AS source, r.attribution AS attribution, r.cost_micros AS c, s.project AS p FROM requests r LEFT JOIN sessions s ON s.session_id = r.session_id').all()
        .map((r) => ({ ts: Number(r.ts), source: r.source, attribution: r.attribution, c: Number(r.c), p: r.p ?? null }));
      const idx = (bk, ts) => bk.findIndex((b) => ts >= b.since && ts < b.until);
      const refSeries = (bk) => {
        const out = bk.map((b) => ({ key: b.key, costMicros: 0, requests: 0, bySource: {}, byAttribution: {} }));
        for (const r of raw) {
          const i = idx(bk, r.ts);
          if (i < 0) continue;
          const o = out[i];
          o.costMicros += r.c; o.requests++;
          o.bySource[r.source] = (o.bySource[r.source] || 0) + r.c;
          o.byAttribution[r.attribution] = (o.byAttribution[r.attribution] || 0) + r.c;
        }
        return out;
      };
      const norm = (bk) => bk.map((b) => ({ key: b.key || b.day, since: b.since, until: b.until }));
      for (const spec of [st.hourBuckets(asOf), st.lastNDays(3, asOf)]) {
        const bk = norm(spec);
        assert.deepStrictEqual(l.series(bk), refSeries(bk));
        const days = spec.map((b) => ({ since: b.since, until: b.until }));
        const tr = l.trends({ buckets: days });
        for (const proj of ['alpha', 'beta', null]) {
          const exp = days.map(() => 0);
          for (const r of raw) if (r.p === proj) { const i = idx(days, r.ts); if (i >= 0) exp[i] += r.c; }
          assert.deepStrictEqual(tr.get(proj) || days.map(() => 0), exp, 'trends ' + proj);
          assert.deepStrictEqual(l.trend({ project: proj, buckets: days }), exp, 'trend ' + proj);
        }
      }
      const g = new Map();
      for (const r of rows) {
        const k = r.promptId || r.requestKey;
        const e = g.get(k) || { ts: Infinity, c: 0 };
        e.ts = Math.min(e.ts, r.ts); e.c += r.costMicros; g.set(k, e);
      }
      const exp = [...g.values()].sort((a, b) => b.c - a.c || a.ts - b.ts).slice(0, 5).map((e) => [e.c, e.ts]);
      const got = l.topPrompts({ since: at(-1, 0, 0, 0, 0), until: at(1, 0, 0, 0, 0), limit: 5 }).map((e) => [e.costMicros, e.ts]);
      assert.deepStrictEqual(got, exp);
      l.close();
      return new Date().getTimezoneOffset();
    }

    test('ledger: 15-minute slot grouping equals the per-row result at slot edges', () => {
      groupingCheck(path.join(ROOT, 'src', 'ledger.js'), path.join(ROOT, 'src', 'spendtime.js'));
    });

    test('ledger: slot grouping is exact in Asia/Kolkata (+05:30) when TZ is honoured', () => {
      const env = Object.assign({}, process.env, { TZ: 'Asia/Kolkata' });
      const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(new Date().getTimezoneOffset()))'], { env, encoding: 'utf8' });
      if (probe.stdout !== '-330') { console.log('  note: TZ not honoured here (offset ' + probe.stdout + '); skipping the Kolkata check'); return; }
      const code = '(' + groupingCheck.toString() + ')(' + JSON.stringify(path.join(ROOT, 'src', 'ledger.js')) + ','
        + JSON.stringify(path.join(ROOT, 'src', 'spendtime.js')) + ')';
      const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(' + code + '))'], { env, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(r.stdout, '-330');
    });

    test('ledger perf guard: 50k requests, 15 projects: every read under 250 ms', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-perf-'));
      const l = openLedger({ file: path.join(dir, 'sereno.db'), retentionDays: 36500 });
      try {
        const now = Date.now(), N = 50000;
        const rows = [];
        for (let i = 0; i < N; i++) {
          rows.push({ requestKey: 'k' + i, requestId: 'r' + i, sessionId: 's' + (i % 150), promptId: 'p' + Math.floor(i / 3),
            ts: now - ((i * 7919) % (30 * 86400000)), model: 'm' + (i % 3), querySource: 'x',
            source: ['main', 'subagent', 'auxiliary'][i % 3], agentName: null, inputTokens: 1, outputTokens: 1,
            cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 100 + (i % 977), durationMs: 1 });
        }
        l.ingestRequests(rows);
        for (let s = 0; s < 150; s++) l.recordHook('SessionStart', { session_id: 's' + s, cwd: '/x/proj' + (s % 15) });
        const days = spendtime.lastNDays(14, now);
        const since = spendtime.monthStart(now), until = spendtime.dayBounds(now).until;
        const time = (name, fn) => {
          const t = process.hrtime.bigint();
          const r = fn();
          const ms = Number(process.hrtime.bigint() - t) / 1e6;
          console.log('  perf ' + name + ': ' + ms.toFixed(1) + ' ms');
          assert.ok(ms < 250, name + ' took ' + ms.toFixed(1) + ' ms');
          return r;
        };
        const p = time('projects+trends(month)', () => { const r = l.projects({ since, until }); l.trends({ buckets: days }); return r; });
        assert.ok(p.rows.length >= 1);
        time('series 30d', () => l.series(spendtime.lastNDays(30, now)));
        time('series 24h', () => l.series(spendtime.hourBuckets(now)));
        time('topPrompts 30d', () => l.topPrompts({ since: spendtime.lastNDays(30, now)[0].since, until, limit: 10 }));
      } finally { l.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    });

    test('widget: nowMarkerX follows the clock, clamped to the day', () => {
      const f = new Function(lf(appSrc, 'nowMarkerX') + '\nreturn nowMarkerX;')();
      const mid = new Date(2026, 5, 10).getTime();
      assert.strictEqual(f(mid + 12 * 3600000, mid, 324), 162);
      assert.strictEqual(f(mid - 5, mid, 324), 0);
      assert.strictEqual(f(mid + 48 * 3600000, mid, 324), 324);
      assert.strictEqual(f(NaN, mid, 324), 0);
      assert.match(appSrc, /setInterval\(\(\) => \{ if \(spendMode\(snapshot\.spend\) === 'on'\) renderSpend\(\); \}, 60000\)/);
    });

    test('widget and console: no inline style attributes anywhere in either renderer script', () => {
      for (const [name, src] of [['app.js', appSrc], ['console.js', conSrc]]) {
        assert.ok(!/\bstyle\s*=/.test(src), 'style= found in ' + name);
      }
      assert.match(appSrc, /<i data-w="\$\{s\.contextPct\}"><\/i>/);
      assert.match(appSrc, /applySpendLayout\(ui\.rows\)/);
    });
  }

  /* ---- Phase 2: red-team re-run fixes ---- */
  {
    const { openLedger } = require('../src/ledger.js');
    const lf2 = (src, n) => { const a = src.indexOf('function ' + n + '('); return src.slice(a, src.indexOf('\n}', a) + 2); };
    const app2 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const con2 = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
    const rawGet2 = (port, p) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: p, agent: false }, (r) => {
        let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }).on('error', () => resolve({ status: 0, body: '' }));
    });

    test('spendtime: hourBuckets keeps nowMs in the newest bucket on DST fall-back days (skipped if TZ is not honoured)', () => {
      for (const [tz, iso] of [['America/New_York', '2026-11-01T06:30:00Z'], ['Europe/London', '2026-10-25T01:30:00Z']]) {
        const code = 'const s=require(' + JSON.stringify(path.join(ROOT, 'src', 'spendtime.js')) + ');'
          + 'const n=Date.parse(' + JSON.stringify(iso) + ');const b=s.hourBuckets(n);const l=b[b.length-1];'
          + 'let ok=b.length===24&&n>=l.since&&n<l.until;'
          + 'for(let i=1;i<b.length;i++)if(b[i].since!==b[i-1].until)ok=false;'
          + 'const p=s.dayBounds(Date.parse("2026-03-08T12:00:00Z"));console.log(ok,(p.until-p.since)/3600000)';
        const r = spawnSync(process.execPath, ['-e', code], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
        const out = (r.stdout || '').trim();
        const probe = spawnSync(process.execPath, ['-e', 'console.log(new Date(2026,0,15).getTimezoneOffset())'],
          { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' }).stdout.trim();
        const want = tz === 'Europe/London' ? '0' : '300';
        if (probe !== want) { console.log('       (note: TZ=' + tz + ' not honoured here, offset "' + probe + '"; DST bucket check skipped)'); continue; }
        assert.ok(out.startsWith('true'), tz + ': nowMs outside the newest bucket or buckets not contiguous: ' + out);
      }
    });

    await atest('collector: /state answers 500, not an empty 200, when snapshot throws', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      const store = new Store();
      store.snapshot = () => { throw new Error('boom'); };
      const c = createCollector(store, 0);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      try {
        const r = await rawGet2(PORT, '/state');
        assert.strictEqual(r.status, 500);
        const e = await rawGet2(PORT, '/events');
        assert.strictEqual(e.status, 500);
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
    });

    await atest('spend: ledger with only yesterday rows is telemetry-on with a $0.00 est. widget footer', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      const clock = new Date(2026, 5, 10, 13, 0).getTime();
      const l = openLedger({ file: ':memory:', retentionDays: 36500 });
      const c = createCollector(new Store(), 0, { ledger: l, now: () => clock });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      try {
        assert.strictEqual(l.hasAny(), false);
        let st = JSON.parse((await rawGet2(PORT, '/state')).body);
        assert.strictEqual(st.spend.hasTelemetry, false);
        l.ingestRequests([{ requestKey: 'y1', requestId: 'y1', sessionId: 's', promptId: null, ts: clock - 86400000,
          model: 'm', querySource: null, source: 'main', agentName: null, inputTokens: 1, outputTokens: 1,
          cacheReadTokens: 0, cacheCreationTokens: 0, costMicros: 5000, durationMs: 0 }]);
        assert.strictEqual(l.hasAny(), true);
        c.setLedger(l);   // same trigger as a settings change; recomputes the cached figure
        st = JSON.parse((await rawGet2(PORT, '/state')).body);
        assert.strictEqual(st.spend.hasTelemetry, true);
        assert.strictEqual(st.spend.todayMicros, 0);
        const t = JSON.parse((await rawGet2(PORT, '/api/spend/today')).body);
        assert.strictEqual(t.hasTelemetry, true); assert.strictEqual(t.requests, 0);

        const W = new Function('const SPEND_W = 324, SPEND_H = 30, SPEND_TOP = 12;\n'
          + ['estMoney', 'esc', 'largestRemainder', 'sourceSegments', 'barAriaLabel', 'cumulativePoints', 'segmentWidths',
            'nowPosition', 'nowMarkerX', 'spendMode', 'spendHtml'].map((n) => lf2(app2, n)).join('\n')
          + '\nreturn { spendMode, spendHtml };')();
        assert.strictEqual(W.spendMode(st.spend), 'on');
        const series = JSON.parse((await rawGet2(PORT, '/api/spend/series?range=24h')).body);
        assert.ok(W.spendHtml(st.spend, series, clock).includes('$0.00 est.'));
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); l.close(); }
    });

    test('console: noSpendYet is true only for a ledger with no requests at all', () => {
      const C = new Function(['pageState', 'noSpendYet'].map((n) => lf2(con2, n)).join('\n') + '\nreturn { pageState, noSpendYet };')();
      const zero = { enabled: true, hasTelemetry: false, requests: 0 };
      assert.strictEqual(C.noSpendYet(zero, { buckets: [{ requests: 0 }] }, { rows: [] }), true);
      assert.strictEqual(C.noSpendYet(zero, { buckets: [] }, { rows: [{ requests: 0 }] }), true);
      // month empty (new month), 30d series has requests: normal page
      assert.strictEqual(C.noSpendYet(zero, { buckets: [{ requests: 0 }, { requests: 3 }] }, { rows: [] }), false);
      assert.strictEqual(C.noSpendYet({ enabled: true, hasTelemetry: true, requests: 0 }, { buckets: [] }, { rows: [] }), false);
      assert.strictEqual(C.pageState([{ status: 200, body: zero }]), null);
    });
  }

  /* ---- Phase 3 step 0: project registry ---- */
  {
    const projects = require('../src/projects.js');
    const gitEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe', windowsHide: true });
    const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-proj-')));
    const mkRepo = () => {
      const d = mk();
      git(d, 'init', '-q');
      git(d, 'commit', '-q', '--allow-empty', '-m', 'init');
      return d;
    };
    const same = (a, b) => projects.normalizePath(a) === projects.normalizePath(b);
    const withHome = async (fn) => {
      const home = mk(); const prev = process.env.SERENO_HOME;
      process.env.SERENO_HOME = home;
      try { await fn(home); }
      finally { if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev; }
    };

    await atest('projects: plain repo resolves to its root', async () => {
      const d = mkRepo();
      const r = await projects.resolveRepo(d);
      assert.ok(r && same(r.root, d) && same(r.worktree, d));
    });

    await atest('projects: a nested folder resolves to the same root', async () => {
      const d = mkRepo();
      fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
      const r = await projects.resolveRepo(path.join(d, 'a', 'b'));
      assert.ok(r && same(r.root, d) && same(r.worktree, d));
    });

    await atest('projects: a worktree is the same project with a different worktree', async () => {
      await withHome(async () => {
        const d = mkRepo();
        const wt = path.join(mk(), 'wt');
        git(d, 'worktree', 'add', '-q', '-b', 'side', wt);
        const reg = projects.createRegistry();
        await reg.noteCwd(d);
        await reg.noteCwd(wt);
        assert.strictEqual(reg.list().length, 1, 'one project, not two');
        const a = await projects.resolveRepo(d); const b = await projects.resolveRepo(wt);
        assert.ok(a && b && same(a.root, b.root));
        assert.ok(!same(b.worktree, b.root), 'worktree path differs from the root');
        assert.ok(same(b.worktree, wt));
        assert.strictEqual(projects.projectId(a.root), projects.projectId(b.root));
      });
    });

    await atest('projects: not a repo and a missing dir resolve to null', async () => {
      assert.strictEqual(await projects.resolveRepo(mk()), null);
      assert.strictEqual(await projects.resolveRepo(path.join(mk(), 'nope')), null);
      assert.strictEqual(await projects.resolveRepo(''), null);
    });

    await atest('projects: git missing (ENOENT) resolves to null and never throws', async () => {
      const exec = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }));
      assert.strictEqual(await projects.resolveRepo(mk(), { exec }), null);
      await withHome(async () => {
        const reg = projects.createRegistry({ exec });
        await reg.noteCwd(mk());
        assert.deepStrictEqual(reg.list(), []);
      });
    });

    await atest('projects: results are cached per cwd for 10 minutes (injected clock)', async () => {
      const d = mkRepo(); let calls = 0; let t = 1000;
      const exec = (f, a, o) => { calls++; return Promise.resolve({ stdout: execFileSync(f, a, { cwd: o.cwd, encoding: 'utf8', windowsHide: true }) }); };
      const cache = new Map();
      await projects.resolveRepo(d, { exec, cache, now: () => t });
      const first = calls;
      await projects.resolveRepo(d, { exec, cache, now: () => t + 9 * 60 * 1000 });
      assert.strictEqual(calls, first, 'served from cache');
      await projects.resolveRepo(d, { exec, cache, now: () => t + 11 * 60 * 1000 });
      assert.ok(calls > first, 'expired after 10 minutes');
    });

    await atest('projects: case and separators do not change identity', async () => {
      assert.strictEqual(projects.projectId('C:\\X\\Repo'), projects.projectId('c:/x/repo'));
      assert.notStrictEqual(projects.projectId('C:\\X\\Repo'), projects.projectId('c:/x/other'));
      assert.strictEqual(projects.projectId('C:\\X\\Repo').length, 12);
      await withHome(async () => {
        const reg = projects.createRegistry();
        const a = reg.register('C:\\X\\Repo'); const b = reg.register('c:/x/repo');
        assert.strictEqual(a.id, b.id);
        assert.strictEqual(reg.list().length, 1);
        assert.strictEqual(reg.list()[0].name, 'Repo', 'display keeps the original casing');
      });
    });

    await atest('projects: a corrupt projects.json reads as empty and is untouched until a change', async () => {
      await withHome(async (home) => {
        const f = path.join(home, 'projects.json');
        fs.writeFileSync(f, '{ not json');
        const reg = projects.createRegistry();
        assert.deepStrictEqual(reg.list(), []);
        assert.strictEqual(fs.readFileSync(f, 'utf8'), '{ not json', 'reading must not overwrite');
        reg.register(mk());
        const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
        assert.strictEqual(saved.projects.length, 1);
        assert.deepStrictEqual(Object.keys(saved.projects[0]).sort(), ['firstSeen', 'hidden', 'id', 'name', 'repoPath']);
        assert.ok(!fs.existsSync(f + '.tmp'));
      });
    });

    await atest('projects: hide and unhide persist across a reload', async () => {
      await withHome(async () => {
        const reg = projects.createRegistry();
        const p = reg.register(mk());
        assert.strictEqual(reg.hide(p.id), true);
        assert.strictEqual(projects.createRegistry().list()[0].hidden, true);
        assert.strictEqual(reg.unhide(p.id), true);
        assert.strictEqual(projects.createRegistry().list()[0].hidden, false);
        assert.strictEqual(reg.hide('nope'), false);
      });
    });

    await atest('projects: concurrent noteCwd for one cwd resolves once', async () => {
      await withHome(async () => {
        const d = mkRepo(); let calls = 0;
        const exec = (f, a, o) => { calls++; return Promise.resolve({ stdout: execFileSync(f, a, { cwd: o.cwd, encoding: 'utf8', windowsHide: true }) }); };
        const reg = projects.createRegistry({ exec });
        await Promise.all([reg.noteCwd(d), reg.noteCwd(d), reg.noteCwd(d)]);
        assert.strictEqual(calls, 2, 'one resolve = toplevel + common-dir, not three');
        assert.strictEqual(reg.list().length, 1);
      });
    });

    await atest('projects: /hook answers 204 promptly while noteCwd never resolves; /status never notes', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      const noted = [];
      const stub = { noteCwd: (c) => { noted.push(c); return new Promise(() => {}); } };
      const c = createCollector(new Store(), 0, { projects: stub });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      const send = (p, body) => new Promise((resolve, reject) => {
        const b = JSON.stringify(body);
        const req = http.request({
          host: '127.0.0.1', port: PORT, path: p, method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) },
        }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
        req.on('error', reject); req.end(b);
      });
      try {
        const t0 = Date.now();
        assert.strictEqual(await send('/hook', { event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 'p0', cwd: 'C:\\x\\repo' } }), 204);
        assert.ok(Date.now() - t0 < 1000);
        assert.strictEqual(await send('/hook', { event: 'Stop', payload: { hook_event_name: 'Stop', session_id: 'p0' } }), 204);
        assert.strictEqual(await send('/hook', { event: 'Stop', payload: { hook_event_name: 'Stop', session_id: 'p0', cwd: '' } }), 204);
        assert.strictEqual(await send('/status', { payload: { session_id: 'p0', cwd: 'C:\\x\\status' } }), 204);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(noted, ['C:\\x\\repo'], 'only a non-empty cwd on /hook is noted');
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
    });
  }

  /* ---- Phase 3 step 1: repo poller ---- */
  {
    const repos = require('../src/repos.js');
    const { gitExec } = require('../src/gitexec.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const gitAt = (cwd, unix, ...args) => execFileSync('git', args, {
      cwd, windowsHide: true, stdio: 'pipe',
      env: Object.assign({}, baseEnv, { GIT_AUTHOR_DATE: unix + ' +0000', GIT_COMMITTER_DATE: unix + ' +0000' }),
    });
    const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-poll-')));
    const mkRepo = (branch) => {
      const d = mk();
      git(d, 'init', '-q', '-b', branch || 'main');
      git(d, 'commit', '-q', '--allow-empty', '-m', 'init');
      return d;
    };
    const fake = (dirs) => ({ list: () => dirs.map((d, i) => ({ id: 'p' + i, name: path.basename(d), repoPath: d, hidden: false })) });
    const pollOnce = async (d, o) => {
      const p = repos.createPoller(Object.assign({ registry: fake([d]) }, o || {}));
      await p.pollNow();
      return p.snapshot().p0;
    };
    const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

    await atest('repos: ahead/behind against a local bare origin; no upstream is null', async () => {
      const origin = mk(); git(origin, 'init', '-q', '--bare', '-b', 'main');
      const a = mk(); git(a, 'clone', '-q', origin, a);
      git(a, 'checkout', '-q', '-b', 'main');
      git(a, 'commit', '-q', '--allow-empty', '-m', 'one');
      git(a, 'push', '-q', '-u', 'origin', 'main');
      let s = await pollOnce(a);
      assert.strictEqual(s.defaultBranch, 'main');
      assert.strictEqual(s.ahead, 0); assert.strictEqual(s.behind, 0);
      git(a, 'commit', '-q', '--allow-empty', '-m', 'local');
      s = await pollOnce(a);
      assert.strictEqual(s.ahead, 1); assert.strictEqual(s.behind, 0);
      const b = mk(); git(b, 'clone', '-q', origin, b);
      git(b, 'commit', '-q', '--allow-empty', '-m', 'remote'); git(b, 'push', '-q', 'origin', 'main');
      git(a, 'fetch', '-q', 'origin');
      s = await pollOnce(a);
      assert.strictEqual(s.ahead, 1); assert.strictEqual(s.behind, 1);
      s = await pollOnce(mkRepo());
      assert.strictEqual(s.ahead, null); assert.strictEqual(s.behind, null);
      assert.strictEqual(s.error, false);
    });

    await atest('repos: default branch from origin/HEAD, then main, master, then the current branch', async () => {
      const origin = mk(); git(origin, 'init', '-q', '--bare', '-b', 'trunk');
      const seed = mkRepo('trunk');
      git(seed, 'push', '-q', origin, 'trunk');
      const c = mk(); git(c, 'clone', '-q', origin, c);
      git(c, 'checkout', '-q', '-b', 'main');          // a local "main" exists too: origin/HEAD still wins
      assert.strictEqual((await pollOnce(c)).defaultBranch, 'trunk');
      const m = mkRepo('main'); git(m, 'checkout', '-q', '-b', 'work');
      assert.strictEqual((await pollOnce(m)).defaultBranch, 'main');
      assert.strictEqual((await pollOnce(mkRepo('master'))).defaultBranch, 'master');
      assert.strictEqual((await pollOnce(mkRepo('dev'))).defaultBranch, 'dev');
    });

    await atest('repos: dirty is a tracked change only; untracked files do not count', async () => {
      const d = mkRepo();
      fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', 'a.txt'); git(d, 'commit', '-q', '-m', 'a');
      assert.strictEqual((await pollOnce(d)).dirty, false);
      fs.writeFileSync(path.join(d, 'new.txt'), 'x');
      assert.strictEqual((await pollOnce(d)).dirty, false, 'untracked only');
      fs.writeFileSync(path.join(d, 'a.txt'), '2');
      const s = await pollOnce(d);
      assert.strictEqual(s.dirty, true);
      assert.strictEqual(s.worktrees[0].dirty, true);
    });

    await atest('repos: a worktree on another branch reports its branch and dirty separately; detached has null', async () => {
      const d = mkRepo();
      fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', 'a.txt'); git(d, 'commit', '-q', '-m', 'a');
      const wt = path.join(mk(), 'wt'); git(d, 'worktree', 'add', '-q', '-b', 'side', wt);
      const det = path.join(mk(), 'det'); git(d, 'worktree', 'add', '-q', '--detach', det);
      fs.writeFileSync(path.join(wt, 'a.txt'), 'changed');
      const s = await pollOnce(d);
      assert.strictEqual(s.worktrees.length, 3);
      const find = (p) => s.worktrees.find((w) => samePath(w.path, p));
      assert.strictEqual(find(d).branch, 'main'); assert.strictEqual(find(d).dirty, false);
      assert.strictEqual(find(wt).branch, 'side'); assert.strictEqual(find(wt).dirty, true);
      assert.strictEqual(find(det).branch, null); assert.strictEqual(find(det).dirty, false);
      assert.strictEqual(s.dirty, true);
      assert.deepStrictEqual(Object.keys(s.worktrees[0]).sort(), ['branch', 'dirty', 'path']);
    });

    await atest('repos: shown branches are the default plus the last 14 days, at most 8, newest first', async () => {
      const day = 86400; const T0 = 1700000000;
      const d = mk(); git(d, 'init', '-q', '-b', 'main');
      gitAt(d, T0, 'commit', '-q', '--allow-empty', '-m', 'base');
      for (let i = 0; i < 10; i++) {
        git(d, 'checkout', '-q', '-b', 'b' + i, 'main');
        gitAt(d, T0 + (10 + i) * day, 'commit', '-q', '--allow-empty', '-m', 'c' + i);
      }
      git(d, 'checkout', '-q', 'main');
      git(d, 'branch', 'old', 'main');
      const now = () => (T0 + 20 * day) * 1000;
      const s = await pollOnce(d, { now });
      const names = s.branches.map((b) => b.name);
      assert.strictEqual(names.length, 8);
      assert.ok(names.includes('main'), 'default always shown');
      assert.ok(!names.includes('old'));
      assert.deepStrictEqual(names.slice(0, 3), ['b9', 'b8', 'b7']);
      for (let i = 1; i < s.branches.length; i++) assert.ok(s.branches[i - 1].lastCommitAt >= s.branches[i].lastCommitAt);
      assert.strictEqual(s.lastCommitAt, (T0 + 19 * day) * 1000);
      assert.ok(/^[0-9a-f]{40}/.test(s.branches[0].head));
      const s2 = await pollOnce(d, { now: () => (T0 + 60 * day) * 1000 });
      assert.deepStrictEqual(s2.branches.map((b) => b.name), ['main']);
    });

    await atest('repos: a git failure keeps the last good state and sets error; no good data yet is error with nulls', async () => {
      const d = mkRepo(); let fail = false;
      const exec = (f, a, o) => (fail ? Promise.reject(new Error('boom')) : gitExec(f, a, o));
      const p = repos.createPoller({ registry: fake([d]), exec });
      await p.pollNow();
      const good = p.snapshot().p0;
      assert.strictEqual(good.error, false); assert.strictEqual(good.defaultBranch, 'main');
      fail = true; await p.pollNow();
      const bad = p.snapshot().p0;
      assert.strictEqual(bad.error, true);
      assert.strictEqual(bad.defaultBranch, 'main'); assert.deepStrictEqual(bad.branches, good.branches);
      fail = false; await p.pollNow();
      assert.strictEqual(p.snapshot().p0.error, false);
      const q = repos.createPoller({ registry: fake([d]), exec: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) });
      await q.pollNow();
      const n = q.snapshot().p0;
      assert.strictEqual(n.error, true); assert.strictEqual(n.defaultBranch, null);
      assert.strictEqual(n.dirty, null); assert.strictEqual(n.polledAt, null); assert.deepStrictEqual(n.branches, []);
    });

    await atest('repos: hidden projects are skipped and overlapping pollNow calls share one run', async () => {
      const d = mkRepo(); let calls = 0;
      const exec = (f, a, o) => { calls++; return gitExec(f, a, o); };
      const reg = { list: () => [
        { id: 'p0', name: 'x', repoPath: d, hidden: false },
        { id: 'h', name: 'hid', repoPath: d, hidden: true }] };
      const p = repos.createPoller({ registry: reg, exec });
      await p.pollNow(); const single = calls;
      assert.ok(single > 0);
      assert.deepStrictEqual(Object.keys(p.snapshot()), ['p0']);
      calls = 0;
      // (a second poll of an unchanged repo is cheap by design, so the overlap check uses a fresh poller)
      const p2 = repos.createPoller({ registry: reg, exec });
      const rs = [p2.pollNow(), p2.pollNow(), p2.pollNow()];
      await Promise.all(rs);
      assert.strictEqual(calls, single, 'three overlapping calls ran git once');
      await p2.pollNow();
      assert.ok(calls > single, 'a later call runs again (cheaply: nothing changed)');
    });

    await atest('repos: stop() leaves no timer, and a started poller never keeps the process alive', async () => {
      const code = 'const r=require(' + JSON.stringify(path.join(ROOT, 'src', 'repos.js')) + ');' +
        'const p=r.createPoller({registry:{list:()=>[]},intervalMs:50});p.start();p.stop();p.stop();' +
        'const q=r.createPoller({registry:{list:()=>[]},intervalMs:50});q.start();';
      const out = spawnSync(process.execPath, ['-e', code], { timeout: 10000, windowsHide: true });
      assert.strictEqual(out.status, 0, 'child exited by itself');
    });

    await atest('repos: a clean filter in repo config never runs during the dirty check', async () => {
      const d = mkRepo();
      fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', 'a.txt'); git(d, 'commit', '-q', '-m', 'a');
      fs.writeFileSync(path.join(d, '.gitattributes'), '* filter=evil\n');
      const marker = path.join(mk(), 'filtered').replace(/\\/g, '/');
      git(d, 'config', 'filter.evil.clean', 'sh -c "touch \'' + marker + '\'; cat"');
      git(d, 'config', 'filter.evil.required', 'true');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(d, 'a.txt'), later, later);   // stat-dirty: git must compare content
      git(d, 'status', '--porcelain', '--untracked-files=no');
      assert.ok(fs.existsSync(marker), 'control: unprotected git should have run the clean filter');
      fs.rmSync(marker, { force: true });
      const later2 = new Date(Date.now() + 9000);
      fs.utimesSync(path.join(d, 'a.txt'), later2, later2);
      const s = await pollOnce(d);
      assert.strictEqual(s.error, false);
      assert.strictEqual(fs.existsSync(marker), false, 'dirty check must not run filter.clean');
    });

    await atest('repos: a submodule with its own clean filter is never entered by the dirty check', async () => {
      const subSrc = mkRepo();
      fs.writeFileSync(path.join(subSrc, 'f.txt'), '1'); git(subSrc, 'add', 'f.txt'); git(subSrc, 'commit', '-q', '-m', 'f');
      const d = mkRepo();
      git(d, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSrc, 'sub');
      git(d, 'commit', '-q', '-m', 'sub');
      const sub = path.join(d, 'sub');
      fs.writeFileSync(path.join(sub, '.gitattributes'), '* filter=evil\n');
      const marker = path.join(mk(), 'subfiltered').replace(/\\/g, '/');
      git(sub, 'config', 'filter.evil.clean', 'sh -c "touch \'' + marker + '\'; cat"');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(sub, 'f.txt'), later, later);
      git(d, 'status', '--porcelain', '--untracked-files=no');
      assert.ok(fs.existsSync(marker), 'control: unprotected git should have entered the submodule');
      fs.rmSync(marker, { force: true });
      const later2 = new Date(Date.now() + 9000);
      fs.utimesSync(path.join(sub, 'f.txt'), later2, later2);
      const s = await pollOnce(d);
      assert.strictEqual(s.error, false);
      assert.strictEqual(fs.existsSync(marker), false, 'dirty check must not enter the submodule');
    });

    await atest('repos: a repo whose config sets core.fsmonitor never runs it (nor does project resolve)', async () => {
      const d = mkRepo();
      fs.writeFileSync(path.join(d, 'a.txt'), '1'); git(d, 'add', 'a.txt'); git(d, 'commit', '-q', '-m', 'a');
      const marker = path.join(mk(), 'pwned').replace(/\\/g, '/');
      git(d, 'config', 'core.fsmonitor', 'touch "' + marker + '"');
      // control: an unprotected git runs it, so the assertions below are not vacuous
      git(d, 'status', '--porcelain');
      assert.ok(fs.existsSync(marker), 'control: unprotected git should have fired fsmonitor');
      fs.rmSync(marker, { force: true });
      const s = await pollOnce(d);
      assert.strictEqual(s.error, false);
      assert.strictEqual(fs.existsSync(marker), false, 'poller must not trigger core.fsmonitor');
      await require('../src/projects.js').resolveRepo(d);
      assert.strictEqual(fs.existsSync(marker), false, 'resolveRepo must not trigger core.fsmonitor');
    });
  }

  /* ---- Phase 3 step 2: briefs ---- */
  {
    const briefs = require('../src/briefs.js');
    const repos = require('../src/repos.js');
    const { gitExec } = require('../src/gitexec.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const gitAt = (cwd, unix, ...args) => execFileSync('git', args, {
      cwd, windowsHide: true, stdio: 'pipe',
      env: Object.assign({}, baseEnv, { GIT_AUTHOR_DATE: unix + ' +0000', GIT_COMMITTER_DATE: unix + ' +0000' }),
    }).toString();
    const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-brief-')));
    const T0 = 1700000000;
    const mkRepo = () => {
      const d = mk();
      git(d, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(d, 'a.js'), '1');
      git(d, 'add', 'a.js');
      gitAt(d, T0, 'commit', '-q', '-m', 'init');
      return d;
    };
    const head = (d, ref) => git(d, 'rev-parse', ref || 'HEAD').trim();
    const briefText = (o) => [
      '---',
      'branch: ' + (o.branch === undefined ? 'main' : o.branch),
      'worktree: ' + (o.worktree || 'C:/x/repo'),
      'version: ' + (o.version === undefined ? 1 : o.version),
      'source_commit: ' + (o.sc || 'abcd1234'),
      'task: ' + (o.task || 'Ship it'),
      'generated_at: ' + (o.at || '2026-10-01T10:00:00Z'),
      '---',
      'Now: ' + (o.now || 'Writing the parser'),
      'Next: ' + (o.next || 'Tests'),
      'Blocked: ' + (o.blocked || 'none'),
      '',
    ].join('\n');
    const putBrief = (wt, branch, o) => {
      const dir = path.join(wt, '.sereno', 'briefs'); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, encodeURIComponent(branch) + '.md');
      fs.writeFileSync(f, briefText(Object.assign({ branch }, o || {}))); return f;
    };
    const fake = (dirs) => ({ list: () => dirs.map((d, i) => ({ id: 'p' + i, name: path.basename(d), repoPath: d, hidden: false })) });

    test('briefs: parseBrief round trip of the spec example', () => {
      const b = briefs.parseBrief(briefText({ branch: 'feat/barcode-scan', version: 3, sc: 'AbCd1234' }));
      assert.deepStrictEqual(b, {
        branch: 'feat/barcode-scan', worktree: 'C:/x/repo', version: 3, sourceCommit: 'AbCd1234',
        task: 'Ship it', generatedAt: '2026-10-01T10:00:00Z', now: 'Writing the parser', next: 'Tests', blocked: 'none',
      });
      const k = briefs.parseBrief('---\nbranch: m\nmystery: 1\n---\nnow: lower\nNOW: second ignored\n');
      assert.strictEqual(k.now, 'lower'); assert.strictEqual(k.next, null); assert.strictEqual(k.version, null);
    });

    test('briefs: malformed input returns null or null fields, never throws', () => {
      assert.strictEqual(briefs.parseBrief('Now: x\nNext: y\n'), null, 'no front matter');
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\nNow: x\n'), null, 'unterminated front matter');
      assert.strictEqual(briefs.parseBrief('---\ntask: t\n---\nNow: x\n'), null, 'missing branch');
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\n---\njust prose\n'), null, 'no body lines');
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\nversion: -1\nsource_commit: zz\n---\nNow: x\n').version, null);
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\nversion: 1.5\n---\nNow: x\n').version, null);
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\nversion: 2\nsource_commit: xyz\n---\nNow: x\n').sourceCommit, null);
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\nsource_commit: abc\n---\nNow: x\n').sourceCommit, null, 'too short');
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\n---\nNow: ' + 'x'.repeat(17000)), null, '>16 KB');
      for (const bad of [null, undefined, 5, {}, '']) assert.strictEqual(briefs.parseBrief(bad), null);
    });

    test('briefs: control characters and bidi overrides are stripped; lines cap at 200 with an ellipsis', () => {
      const b = briefs.parseBrief('---\nbranch: m\ntask: a\u0007b\n---\nNow: he\u0000l\u001blo \u202eevil\u2066x\u2069 \u007f\u0085end\nNext: ' + 'y'.repeat(300) + '\n');
      assert.strictEqual(b.now, 'hello evilx end');
      assert.strictEqual(b.task, 'ab');
      assert.strictEqual(b.next.length, 200);
      assert.ok(b.next.endsWith('\u2026'));
      assert.strictEqual(briefs.parseBrief('---\nbranch: m\n---\nNow: ' + 'z'.repeat(200)).now.length, 200, 'exactly 200 is kept whole');
    });

    test('briefs: decodeBriefName', () => {
      assert.strictEqual(briefs.decodeBriefName('feat%2Fbarcode-scan.md'), 'feat/barcode-scan');
      assert.strictEqual(briefs.decodeBriefName('main.md'), 'main');
      assert.strictEqual(briefs.decodeBriefName('bad%E0%A4%A.md'), null);
      assert.strictEqual(briefs.decodeBriefName('noext'), null);
      assert.strictEqual(briefs.decodeBriefName('.md'), null);
    });

    await atest('briefs: readBriefs skips symlinks, counts a filename that disagrees with its branch, ignores non-md', async () => {
      const wt = mk(); const dir = path.join(wt, '.sereno', 'briefs'); fs.mkdirSync(dir, { recursive: true });
      const outside = path.join(mk(), 'secret.md');
      fs.writeFileSync(outside, briefText({ branch: 'linked' }));
      let linked = true;
      try { fs.symlinkSync(outside, path.join(dir, 'linked.md')); } catch (_) { linked = false; }
      putBrief(wt, 'good');
      fs.writeFileSync(path.join(dir, 'other.md'), briefText({ branch: 'not-other' }));   // name/branch mismatch
      fs.writeFileSync(path.join(dir, 'junk.md'), 'nothing here');
      fs.writeFileSync(path.join(dir, 'notes.txt'), briefText({ branch: 'txt' }));
      fs.mkdirSync(path.join(dir, 'sub.md'));
      const r = await briefs.readBriefs([wt, path.join(wt, 'does-not-exist')]);
      assert.deepStrictEqual(Array.from(r.byBranch.keys()), ['good']);
      assert.strictEqual(r.malformed, 2, 'mismatch + junk');
      assert.strictEqual(r.byBranch.get('good').file, 'good.md');
      if (!linked) console.log('    (symlink not permitted here; link case not exercised)');
      { const m1 = await briefs.readBriefs([wt], { maxFiles: 1 }); assert.strictEqual(m1.byBranch.size + m1.malformed <= 1, true); }
    });

    await atest('briefs: a junctioned or symlinked .sereno or briefs dir is never read', async () => {
      const target = mk(); putBrief(target, 'evil');
      const realBriefs = path.join(target, '.sereno', 'briefs');
      const w1 = mk(); fs.mkdirSync(path.join(w1, '.sereno'));
      fs.symlinkSync(realBriefs, path.join(w1, '.sereno', 'briefs'), 'junction');
      assert.strictEqual((await briefs.readBriefs([w1])).byBranch.size, 0, 'briefs dir junction');
      const w2 = mk();
      fs.symlinkSync(path.join(target, '.sereno'), path.join(w2, '.sereno'), 'junction');
      assert.strictEqual((await briefs.readBriefs([w2])).byBranch.size, 0, '.sereno junction');
      assert.strictEqual((await briefs.readBriefs([target])).byBranch.size, 1, 'control: the real dir reads');
    });

    await atest('briefs: the highest version wins across two worktrees; ties go to the later generated_at', async () => {
      const a = mk(); const b = mk();
      putBrief(a, 'feat/x', { version: 2, now: 'from a' });
      putBrief(b, 'feat/x', { version: 5, now: 'from b' });
      assert.strictEqual((await briefs.readBriefs([a, b])).byBranch.get('feat/x').now, 'from b');
      assert.strictEqual((await briefs.readBriefs([b, a])).byBranch.get('feat/x').now, 'from b');
      putBrief(a, 'feat/x', { version: 5, now: 'later', at: '2026-10-02T10:00:00Z' });
      assert.strictEqual((await briefs.readBriefs([b, a])).byBranch.get('feat/x').now, 'later');
      assert.strictEqual((await briefs.readBriefs([a, b])).byBranch.get('feat/x').now, 'later');
    });

    await atest('briefs: freshness from real commits, and .sereno / STATUS.md commits never make a brief behind', async () => {
      const d = mkRepo(); const src = head(d);
      const fr = (o) => briefs.freshness(Object.assign({ brief: { branch: 'main', sourceCommit: src }, exec: gitExec, cwd: d, now: (T0 + 100) * 1000 }, o || {}));
      assert.strictEqual(await fr(), 'fresh', 'at source_commit');
      putBrief(d, 'main'); git(d, 'add', '-f', '.sereno/briefs/main.md'); gitAt(d, T0 + 10, 'commit', '-q', '-m', 'brief');
      assert.strictEqual(await fr(), 'fresh', 'a brief-only commit');
      fs.writeFileSync(path.join(d, 'STATUS.md'), 's'); git(d, 'add', 'STATUS.md'); gitAt(d, T0 + 20, 'commit', '-q', '-m', 'status');
      assert.strictEqual(await fr(), 'fresh', 'a STATUS.md-only commit');
      fs.writeFileSync(path.join(d, 'a.js'), '2'); git(d, 'add', 'a.js'); gitAt(d, T0 + 30, 'commit', '-q', '-m', 'code');
      assert.strictEqual(await fr(), 'behind', 'a code commit');
      assert.strictEqual(await fr({ now: (T0 + 30 + 24 * 3600) * 1000 }), 'behind', 'exactly 24 h is not over 24 h');
      assert.strictEqual(await fr({ now: (T0 + 30 + 25 * 3600) * 1000 }), 'stale', '25 h after');
      assert.strictEqual(await fr({ brief: { branch: 'main', sourceCommit: 'deadbeefdeadbeef' } }), 'unknown', 'source not in repo');
      assert.strictEqual(await fr({ brief: { branch: 'main', sourceCommit: null } }), 'unknown');
      assert.strictEqual(await fr({ brief: { branch: 'nope', sourceCommit: src } }), 'unknown', 'branch not in repo');
    });

    await atest('briefs: a hostile branch name never reaches git as an option', async () => {
      const d = mkRepo(); const calls = [];
      const exec = (f, a, o) => { calls.push(a); return gitExec(f, a, o); };
      for (const name of ['--output=x', '-x', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '', 'a.lock']) {
        const r = await briefs.freshness({ brief: { branch: name, sourceCommit: head(d) }, exec, cwd: d, now: 0 });
        assert.strictEqual(r, 'unknown', JSON.stringify(name));
      }
      assert.strictEqual(calls.length, 0, 'git was never run for an invalid name');
      await briefs.freshness({ brief: { branch: 'main', sourceCommit: head(d) }, exec, cwd: d, now: 0 });
      for (const a of calls) assert.ok(!a.some((x) => x.startsWith('--output')));
      assert.strictEqual(fs.existsSync(path.join(d, 'x')), false);
    });

    await atest('briefs: poller adds brief, freshness, briefsMalformed; no brief is none; headline mirrors the default branch', async () => {
      const d = mkRepo(); const src = head(d);
      git(d, 'branch', 'feat/y');
      let p = repos.createPoller({ registry: fake([d]), now: () => (T0 + 3600) * 1000 });
      await p.pollNow();
      let s = p.snapshot().p0;
      assert.strictEqual(s.freshness, 'none'); assert.strictEqual(s.brief, null); assert.strictEqual(s.briefsMalformed, 0);
      assert.ok(s.branches.every((b) => b.freshness === 'none' && b.brief === null));
      putBrief(d, 'main', { sc: src }); putBrief(d, 'feat/y', { sc: 'deadbeefdeadbeef' });
      fs.writeFileSync(path.join(d, '.sereno', 'briefs', 'junk.md'), 'x');
      fs.writeFileSync(path.join(d, 'a.js'), '2'); git(d, 'add', 'a.js'); gitAt(d, T0 + 60, 'commit', '-q', '-m', 'code');
      p = repos.createPoller({ registry: fake([d]), now: () => (T0 + 3600) * 1000 });
      await p.pollNow(); s = p.snapshot().p0;
      assert.strictEqual(s.freshness, 'behind');
      assert.strictEqual(s.behindSince, (T0 + 60) * 1000, 'oldest code commit after source_commit');
      assert.strictEqual(s.branches.find((b) => b.name === 'main').behindSince, (T0 + 60) * 1000);
      assert.strictEqual(s.branches.find((b) => b.name === 'feat/y').behindSince, null);
      assert.strictEqual(s.brief.now, 'Writing the parser');
      assert.strictEqual(s.briefsMalformed, 1);
      assert.strictEqual(s.branches.find((b) => b.name === 'main').freshness, 'behind');
      assert.strictEqual(s.branches.find((b) => b.name === 'feat/y').freshness, 'unknown');
      p = repos.createPoller({ registry: fake([d]), now: () => (T0 + 60 + 25 * 3600) * 1000 });
      await p.pollNow();
      assert.strictEqual(p.snapshot().p0.freshness, 'stale');
      assert.strictEqual(p.snapshot().p0.behindSince, (T0 + 60) * 1000);
    });

    await atest('briefs: branches with a brief are always shown, within the 8 cap, ahead of plain recent ones', async () => {
      const day = 86400;
      const d = mk(); git(d, 'init', '-q', '-b', 'main');
      gitAt(d, T0, 'commit', '-q', '--allow-empty', '-m', 'base');
      for (let i = 0; i < 10; i++) {
        git(d, 'checkout', '-q', '-b', 'b' + i, 'main');
        gitAt(d, T0 + (10 + i) * day, 'commit', '-q', '--allow-empty', '-m', 'c' + i);
      }
      git(d, 'checkout', '-q', 'main'); git(d, 'branch', 'old', 'main');
      putBrief(d, 'old', { sc: head(d) }); putBrief(d, 'b0', { sc: head(d) });
      const p = repos.createPoller({ registry: fake([d]), now: () => (T0 + 20 * day) * 1000 });
      await p.pollNow();
      const names = p.snapshot().p0.branches.map((b) => b.name);
      assert.strictEqual(names.length, 8);
      assert.ok(names.includes('main') && names.includes('old') && names.includes('b0'), names.join());
      assert.ok(names.includes('b9') && names.includes('b8') && !names.includes('b1'));
    });

    await atest('briefs: freshness is cached per branch head and brief; an unchanged head runs no git log', async () => {
      const d = mkRepo(); putBrief(d, 'main', { sc: head(d) });
      let logs = 0;
      const exec = (f, a, o) => { if (a.includes('--timestamp')) logs++; return gitExec(f, a, o); };
      const p = repos.createPoller({ registry: fake([d]), exec });
      await p.pollNow();
      assert.strictEqual(logs, 1); assert.strictEqual(p.snapshot().p0.freshness, 'fresh');
      await p.pollNow();
      assert.strictEqual(logs, 1, 'second poll, same head: no git log');
      fs.writeFileSync(path.join(d, 'a.js'), '2'); git(d, 'add', 'a.js'); git(d, 'commit', '-q', '-m', 'more');
      await p.pollNow();
      assert.strictEqual(logs, 2, 'head moved: recomputed');
      assert.strictEqual(p.snapshot().p0.freshness, 'behind');
      putBrief(d, 'main', { sc: head(d), version: 2 });
      await p.pollNow();
      assert.strictEqual(logs, 3, 'new source commit: recomputed');
      assert.strictEqual(p.snapshot().p0.freshness, 'fresh');
    });
  }

  /* ---- Phase 3 step 3: /brief command ---- */
  {
    const briefs = require('../src/briefs.js');
    const TPL = path.join(ROOT, 'templates', 'commands', 'brief.md');
    const tplText = fs.readFileSync(TPL, 'utf8');
    const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');
    const mkEnv = () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-cmd-'));
      const prev = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.SERENO_HOME };
      process.env.CLAUDE_CONFIG_DIR = tmp;
      process.env.SERENO_HOME = tmp;
      return {
        tmp,
        target: path.join(tmp, 'commands', 'brief.md'),
        done() {
          if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
          if (prev.h === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev.h;
          fs.rmSync(tmp, { recursive: true, force: true });
        },
      };
    };
    const rec = (e) => JSON.parse(fs.readFileSync(path.join(e.tmp, 'wired.json'), 'utf8'));

    test('commands: install writes the template, creates the dir, records the sha256', () => {
      const e = mkEnv();
      try {
        assert.strictEqual(wiring.commandsStatus(), 'not-installed');
        const dry = wiring.installCommands({ dryRun: true });
        assert.ok(dry.dryRun && dry.changes.length === 1);
        assert.ok(!fs.existsSync(path.join(e.tmp, 'commands')), 'dry run wrote something');
        const r = wiring.installCommands();
        assert.strictEqual(r.conflict, null);
        assert.strictEqual(fs.readFileSync(e.target, 'utf8'), tplText);
        assert.strictEqual(rec(e).commands['commands/brief.md'], sha(fs.readFileSync(TPL)));
        assert.strictEqual(wiring.commandsStatus(), 'installed');
        assert.ok(wiring.commandsInstalled());
        assert.deepStrictEqual(fs.readdirSync(path.dirname(e.target)), ['brief.md'], 'tmp file left behind');
      } finally { e.done(); }
    });

    test('commands: installing again is a no-op (same bytes, same mtime)', () => {
      const e = mkEnv();
      try {
        wiring.installCommands();
        const old = new Date(Date.now() - 3600 * 1000);
        fs.utimesSync(e.target, old, old);
        const before = fs.statSync(e.target).mtimeMs;
        const r = wiring.installCommands();
        assert.deepStrictEqual(r.changes, []);
        assert.strictEqual(r.conflict, null);
        assert.strictEqual(fs.statSync(e.target).mtimeMs, before, 'file was rewritten');
      } finally { e.done(); }
    });

    test('commands: a different existing brief.md is a conflict and stays byte-identical', () => {
      const e = mkEnv();
      try {
        fs.mkdirSync(path.dirname(e.target), { recursive: true });
        const mine = Buffer.from('# my own /brief\r\nkeep me\n');
        fs.writeFileSync(e.target, mine);
        const r = wiring.installCommands();
        assert.deepStrictEqual(r.conflict, ['commands/brief.md']);
        assert.ok(fs.readFileSync(e.target).equals(mine));
        assert.strictEqual(wiring.commandsStatus(), 'conflict');
        assert.strictEqual(wiring.commandsInstalled(), false);
        assert.ok(!fs.existsSync(path.join(e.tmp, 'wired.json')), 'a conflict must not record anything');
        assert.deepStrictEqual(wiring.uninstallCommands().removed, [], 'must not remove a file we never wrote');
        assert.ok(fs.readFileSync(e.target).equals(mine));
      } finally { e.done(); }
    });

    test('commands: uninstall removes an unchanged file and the record; keeps an edited one', () => {
      const e = mkEnv();
      try {
        wiring.installCommands();
        const r = wiring.uninstallCommands();
        assert.deepStrictEqual(r.removed, ['commands/brief.md']);
        assert.ok(!fs.existsSync(e.target));
        assert.strictEqual(rec(e).commands, undefined);

        wiring.installCommands();
        fs.appendFileSync(e.target, '\nmy edit\n');
        const edited = fs.readFileSync(e.target);
        const k = wiring.uninstallCommands();
        assert.deepStrictEqual(k.kept, ['commands/brief.md']);
        assert.deepStrictEqual(k.removed, []);
        assert.ok(fs.readFileSync(e.target).equals(edited), 'edited file was touched');
        assert.strictEqual(rec(e).commands, undefined, 'record should be dropped either way');
        assert.strictEqual(wiring.uninstallCommands().recorded, false);
      } finally { e.done(); }
    });

    test('commands: an unedited older copy is update-available and is replaced; an edited one stays a conflict', () => {
      const e = mkEnv();
      try {
        const oldTpl = path.join(e.tmp, 'old-template.md');
        fs.writeFileSync(oldTpl, 'old version of the command\n');
        wiring.installCommands({ templatePath: oldTpl });
        assert.strictEqual(wiring.commandsStatus({ templatePath: oldTpl }), 'installed');
        // The bundled template moves on.
        assert.strictEqual(wiring.commandsStatus(), 'update-available');
        assert.strictEqual(wiring.commandsInstalled(), false);
        const dry = wiring.installCommands({ dryRun: true });
        assert.deepStrictEqual(dry.changes, ['commands/brief.md: updated']);
        assert.strictEqual(fs.readFileSync(e.target, 'utf8'), 'old version of the command\n');
        const r = wiring.installCommands();
        assert.strictEqual(r.conflict, null);
        assert.strictEqual(fs.readFileSync(e.target, 'utf8'), tplText);
        assert.strictEqual(rec(e).commands['commands/brief.md'], sha(fs.readFileSync(TPL)));
        assert.strictEqual(wiring.commandsStatus(), 'installed');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(e.target)), ['brief.md']);

        // User-edited older copy: matches neither the record nor the bundle.
        wiring.uninstallCommands();
        wiring.installCommands({ templatePath: oldTpl });
        fs.appendFileSync(e.target, 'my edit\n');
        const edited = fs.readFileSync(e.target);
        assert.strictEqual(wiring.commandsStatus(), 'conflict');
        assert.deepStrictEqual(wiring.installCommands().conflict, ['commands/brief.md']);
        assert.ok(fs.readFileSync(e.target).equals(edited));
      } finally { e.done(); }
    });

    test('commands: wired.json keeps shim and telemetry records intact', () => {
      const e = mkEnv();
      try {
        fs.writeFileSync(path.join(e.tmp, 'settings.json'), '{}\n');
        wiring.wire(wiring.buildCommands({ packaged: false, emitJsPath: path.join(ROOT, 'bin', 'emit.js') }));
        wiring.wireTelemetry({ traces: true });
        const before = rec(e);
        assert.ok(before.shims.length && before.telemetry);
        wiring.installCommands();
        const mid = rec(e);
        assert.deepStrictEqual(mid.shims, before.shims);
        assert.deepStrictEqual(mid.telemetry, before.telemetry);
        wiring.uninstallCommands();
        const after = rec(e);
        assert.deepStrictEqual(after, before);
        // And the other direction: telemetry/shim writes keep the commands record.
        wiring.installCommands();
        wiring.unwireTelemetry();
        assert.ok(rec(e).commands['commands/brief.md']);
      } finally { e.done(); }
    });

    await atest('commands: CLI --commands honours --dry-run, installs, prints conflict and exits 0, unwires', async () => {
      const e = mkEnv();
      try {
        const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: e.tmp, SERENO_HOME: e.tmp });
        const run = (script, ...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', script), ...a], { env, encoding: 'utf8' });
        let r = run('wire.js', '--commands', '--dry-run');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(/dry-run/.test(r.stdout) && !fs.existsSync(e.target));
        r = run('wire.js', '--commands', '--yes');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.strictEqual(fs.readFileSync(e.target, 'utf8'), tplText);
        assert.ok(!fs.existsSync(path.join(e.tmp, 'settings.json')), 'the commands flag must not touch settings.json');
        r = run('wire.js', '--commands', '--yes');
        assert.ok(/already installed/.test(r.stdout), r.stdout);
        r = run('unwire.js', '--commands');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(!fs.existsSync(e.target));
        fs.mkdirSync(path.dirname(e.target), { recursive: true });
        fs.writeFileSync(e.target, 'someone else\n');
        r = run('wire.js', '--commands', '--yes');
        assert.strictEqual(r.status, 0, r.stderr);
        assert.ok(/different commands\/brief\.md/.test(r.stdout), r.stdout);
        assert.strictEqual(fs.readFileSync(e.target, 'utf8'), 'someone else\n');
      } finally { e.done(); }
    });

    test('commands: the template ships in the build and is reachable from wiring', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      assert.ok(pkg.build.files.includes('templates/**/*'), 'templates/ missing from build.files');
      assert.strictEqual(path.resolve(wiring.commandTemplatePath()), path.resolve(TPL));
    });

    test('commands: the template names every front-matter key and line key the parser reads', () => {
      for (const k of ['branch', 'worktree', 'version', 'source_commit', 'task', 'generated_at']) {
        assert.ok(new RegExp('^' + k + ':', 'm').test(tplText), 'template lacks front-matter key ' + k);
      }
      for (const k of ['Now', 'Next', 'Blocked']) {
        assert.ok(new RegExp('^' + k + ':', 'm').test(tplText), 'template lacks line ' + k);
      }
      assert.ok(tplText.includes('feat%2Fx.md'), 'the encoding example is missing');
      assert.ok(/^description: .+/m.test(tplText.split('\n---')[0]));
      assert.ok(tplText.includes('$ARGUMENTS'));
      for (const c of ['git branch --show-current', 'git rev-parse --show-toplevel', 'git rev-parse HEAD']) {
        assert.ok(tplText.includes(c), 'missing ' + c);
      }
    });

    test('commands: the format the template shows parses, and so does a brief rendered by its rules', () => {
      const m = /```\n(---\n[\s\S]*?\n---\n[\s\S]*?)\n```/.exec(tplText);
      assert.ok(m, 'no format example in the template');
      const b = briefs.parseBrief(m[1]);
      assert.ok(b, 'the template example does not parse');
      assert.strictEqual(b.branch, 'feat/x');
      assert.strictEqual(b.version, 3);
      assert.ok(b.sourceCommit && b.sourceCommit.length === 40);
      assert.ok(b.now && b.next && b.blocked === 'None');

      // Rendered by hand following the template: CRLF-free, forward-slash worktree, kebab task, UTC time.
      const branch = 'feat/projects-briefs';
      const sample = [
        '---', 'branch: ' + branch, 'worktree: C:/Users/me/code/sereno', 'version: 1',
        'source_commit: ' + 'a1b2c3d4'.repeat(5), 'task: brief-command', 'generated_at: 2026-10-11T14:05:00Z', '---',
        'Now: Adding the /brief command template and its installer.',
        'Next: Wire the install button into the settings panel.',
        'Blocked: None', '',
      ].join('\n');
      const p = briefs.parseBrief(sample);
      assert.ok(p, 'rendered brief rejected');
      assert.deepStrictEqual([p.branch, p.worktree, p.version, p.task, p.generatedAt, p.blocked],
        [branch, 'C:/Users/me/code/sereno', 1, 'brief-command', '2026-10-11T14:05:00Z', 'None']);
      // The file name rule: encodeURIComponent, which the reader decodes back.
      const name = encodeURIComponent(branch) + '.md';
      assert.strictEqual(name, 'feat%2Fprojects-briefs.md');
      assert.strictEqual(briefs.decodeBriefName(name), branch);
    });

    test('commands: neither template tells Claude to commit or stage', () => {
      const scribe = fs.readFileSync(path.join(ROOT, 'templates', 'agents', 'sereno-scribe.md'), 'utf8');
      for (const [n, t] of [['brief.md', tplText], ['sereno-scribe.md', scribe]]) {
        assert.ok(!/git\s+(commit|add|stage|push|reset|checkout)\b/i.test(t), n + ' mentions a git write command');
        assert.ok(/do not commit|not commit/i.test(t), n + ' should forbid committing');
      }
    });

    test('commands: sereno-scribe is a haiku agent that points at the same brief rules', () => {
      const scribe = fs.readFileSync(path.join(ROOT, 'templates', 'agents', 'sereno-scribe.md'), 'utf8');
      assert.ok(/^name: sereno-scribe$/m.test(scribe) && /^model: haiku$/m.test(scribe));
      for (const k of ['branch', 'worktree', 'version', 'source_commit', 'task', 'generated_at', 'Now:', 'Next:', 'Blocked:']) {
        assert.ok(scribe.includes(k), 'sereno-scribe lacks ' + k);
      }
      assert.ok(scribe.includes('.sereno/briefs/'));
      // The Phase 1 scribe is untouched.
      assert.ok(fs.existsSync(path.join(ROOT, 'templates', 'agents', 'scribe.md')));
    });

    test('commands: the settings row is wired through preload and main, hidden without preload', () => {
      const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
      const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
      const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
      assert.ok(html.includes('id="brief-row"') && /id="brief-row"[^>]*hidden/.test(html));
      assert.ok(/if \(!api \|\| !api\.commandsStatus\) \{ ui\.briefRow\.hidden = true/.test(app));
      assert.ok(pre.includes('sereno:commands-status') && pre.includes('sereno:commands-toggle'));
      // The confirmation lives in main, defaults to Cancel, and precedes the write.
      const i = main.indexOf("'sereno:commands-toggle'");
      const seg = main.slice(i, i + 1800);
      assert.ok(/defaultId: 1/.test(seg) && /Cancel/.test(seg));
      assert.ok(seg.indexOf('showMessageBox') < seg.indexOf('installCommands'));
      assert.ok(seg.includes('Sereno writes one file and changes nothing else.'));
    });
  }

  /* ---- Phase 3 step 4: projects API ---- */
  {
    const projects = require('../src/projects.js');
    const repos = require('../src/repos.js');
    const { openLedger } = require('../src/ledger.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-api-')));
    const mkRepo = () => {
      const d = mk();
      git(d, 'init', '-q', '-b', 'main');
      git(d, 'commit', '-q', '--allow-empty', '-m', 'secret commit message');
      return d;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const withHome = async (fn) => {
      const home = mk(); const prev = process.env.SERENO_HOME;
      const prevCfg = process.env.CLAUDE_CONFIG_DIR;
      process.env.SERENO_HOME = home;
      process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
      try { await fn(home); }
      finally {
        if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev;
        if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
      }
    };
    const rq = (port, o) => new Promise((resolve, reject) => {
      const body = o.body === undefined ? null : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
      const headers = Object.assign({}, o.headers || {});
      if (body !== null) headers['content-length'] = Buffer.byteLength(body);
      const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method || 'GET', headers }, (r) => {
        let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; });
        r.on('end', () => resolve({ status: r.statusCode, text: t }));
      });
      req.on('error', reject);
      req.end(body === null ? undefined : body);
    });
    const boot = async (store, port, opts) => {
      const c = createCollector(store, 0, opts);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (c.port = a.port, res()))));
      return c;
    };
    const halt = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });
    const getJson = async (port, p) => JSON.parse((await rq(port, { path: p })).text);

    const PROJECT_KEYS = ['id', 'name', 'hidden', 'freshness', 'brief', 'git', 'prs', 'branches', 'spend14', 'lastActivity', 'live', 'error', 'briefsMalformed'];
    const FORBIDDEN_KEYS = new Set(['repoPath', 'worktree', 'worktrees', 'worktreePath', 'cwd', 'path', 'head', 'sourceCommit', 'file', 'message']);
    const walk = (o, where, cb) => {
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, where + '[' + i + ']', cb)); return; }
      if (o && typeof o === 'object') { for (const k of Object.keys(o)) { cb(k, o[k], where + '.' + k); walk(o[k], where + '.' + k, cb); } }
    };

    await atest('projects api: /api/projects shape, explicit keys, and nothing path- or hash-like anywhere (exit 6)', async () => {
      await withHome(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const d = mkRepo();
        const sha = git(d, 'rev-parse', 'HEAD').trim();
        fs.mkdirSync(path.join(d, '.sereno', 'briefs'), { recursive: true });
        fs.writeFileSync(path.join(d, '.sereno', 'briefs', 'main.md'),
          '---\nbranch: main\nversion: 1\nsource_commit: ' + sha + '\ngenerated_at: 2026-10-11T10:00:00Z\n---\nNow: wire the api\nNext: draw the cards\nBlocked: nothing\n');
        const reg = projects.createRegistry();
        reg.register(d);
        const hiddenRepo = mkRepo();
        const hid = reg.register(hiddenRepo).id;
        reg.hide(hid);
        const poller = repos.createPoller({ registry: reg, ghExec: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) });
        await poller.pollNow();
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          const r = await getJson(PORT, '/api/projects');
          assert.deepStrictEqual(Object.keys(r).sort(), ['asOf', 'projects']);
          assert.strictEqual(typeof r.asOf, 'number');
          assert.strictEqual(r.projects.length, 2, 'hidden projects are included, flagged');
          const p = r.projects.find((x) => !x.hidden);
          assert.deepStrictEqual(Object.keys(p).sort(), PROJECT_KEYS.slice().sort());
          assert.deepStrictEqual(Object.keys(p.git).sort(), ['ahead', 'behind', 'defaultBranch', 'dirty', 'lastCommitAt']);
          assert.deepStrictEqual(Object.keys(p.brief).sort(), ['behindSince', 'blocked', 'generatedAt', 'next', 'now']);
          assert.strictEqual(p.brief.behindSince, null, 'fresh brief: no behindSince');
          assert.strictEqual(p.freshness, 'fresh');
          assert.strictEqual(p.brief.now, 'wire the api');
          assert.strictEqual(p.git.defaultBranch, 'main');
          assert.strictEqual(p.spend14, null, 'ledger off: absent, not zero');
          assert.strictEqual(p.prs, null);
          assert.ok(p.branches.length >= 1 && Object.keys(p.branches[0]).sort().join() === 'behindSince,freshness,name,now');
          assert.ok(typeof p.lastActivity === 'number');
          const h = r.projects.find((x) => x.hidden);
          assert.strictEqual(h.id, hid);
          assert.strictEqual(h.freshness, 'none');
          assert.strictEqual(h.brief, null);
          // exit 6: no path, hash, commit message anywhere in the body
          const body = JSON.stringify(r);
          assert.ok(!/secret commit message/.test(body));
          assert.ok(!body.includes(sha), 'no commit hash');
          walk(r, '$', (k, v, where) => {
            assert.ok(!FORBIDDEN_KEYS.has(k), 'forbidden key ' + where);
            if (typeof v === 'string') {
              assert.ok(!/[a-zA-Z]:[\\/]/.test(v) && !v.startsWith('/') && !v.includes('\\'), 'path-like value at ' + where + ': ' + v);
              assert.ok(!/\b[0-9a-f]{40}\b/i.test(v), 'hash-like value at ' + where);
            }
          });
          assert.ok(!body.includes(d.replace(/\\/g, '\\\\')) && !body.toLowerCase().includes(path.basename(path.dirname(d)).toLowerCase() + '\\'));
        } finally { await halt(c); }
      });
    });

    await atest('projects api: spend14 joins ledger sessions by cwd under any worktree, case-insensitively; null with the ledger off', async () => {
      let PORT = 0;   // port 0: the OS picks a free one
      const clock = Date.now();
      const d = mk(); const wt = mk(); const other = mk();
      const flip = (s) => (process.platform === 'win32' ? s.toUpperCase() : s);
      const ledger = openLedger({ file: ':memory:' });
      const addSess = (id, cwd) => ledger._db.prepare('INSERT INTO sessions (session_id, first_seen, last_seen, cwd, project) VALUES (?,?,?,?,?)').run(id, clock, clock, cwd, 'x');
      const addReq = (k, id, micros, ts) => ledger._db.prepare(`INSERT INTO requests (request_key, request_id, session_id, ts, source, attribution, cost_micros)
        VALUES (?,?,?,?,?,?,?)`).run(k, k, id, ts, 'main', 'explicit', micros);
      addSess('s-main', path.join(d, 'sub')); addSess('s-wt', flip(wt)); addSess('s-other', other);
      addReq('r1', 's-main', 1000, clock - 60000); addReq('r2', 's-wt', 2500, clock - 5000); addReq('r3', 's-other', 9999, clock - 5000);
      const reg = { list: () => [{ id: 'p1', name: 'proj', repoPath: d, hidden: false, firstSeen: 0 }], noteCwd: () => Promise.resolve() };
      const stub = { snapshot: () => ({ p1: { id: 'p1', worktrees: [{ path: wt, branch: 'x' }], branches: [], error: false, freshness: 'none', brief: null, lastCommitAt: null } }) };
      const c = await boot(new Store(), PORT, { ledger, projects: reg, repos: stub, now: () => clock });
      PORT = c.port;
      try {
        const p = (await getJson(PORT, '/api/projects')).projects[0];
        assert.strictEqual(p.spend14.costMicros, 3500, 'main repo subfolder + worktree, not the other dir');
        assert.strictEqual(p.spend14.trend.length, 14);
        assert.strictEqual(p.spend14.trend.reduce((a, b) => a + b, 0), 3500);
        assert.strictEqual(p.lastActivity, clock - 5000, 'last request time counts as activity');
        c.setLedger(null);
        assert.strictEqual((await getJson(PORT, '/api/projects')).projects[0].spend14, null);
      } finally { await halt(c); ledger.close(); }
    });

    await atest('projects exit 3: sessions in the main repo and in a worktree make one project', async () => {
      await withHome(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const d = mkRepo();
        const wt = path.join(mk(), 'wt');
        git(d, 'worktree', 'add', '-q', '-b', 'side', wt);
        const reg = projects.createRegistry();
        const poller = repos.createPoller({ registry: reg });
        const store = new Store();
        const c = await boot(store, PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          const hook = (id, cwd) => rq(PORT, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' },
            body: { event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: id, cwd } } });
          assert.strictEqual((await hook('a1', d)).status, 204);
          assert.strictEqual((await hook('a2', wt)).status, 204);
          for (let i = 0; i < 60 && reg.list().length < 1; i++) await sleep(100);
          await sleep(500);
          await poller.pollNow();
          const r = await getJson(PORT, '/api/projects');
          assert.strictEqual(r.projects.length, 1, 'one project, not two');
          assert.ok(r.projects[0].lastActivity !== null);
        } finally { await halt(c); }
      });
    });

    await atest('projects exit 4: /hook answers while a slow git (3 s) is in flight', async () => {
      await withHome(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        let started = 0;
        const slow = () => { started++; return new Promise((res) => setTimeout(() => res({ stdout: '' }), 3000)); };
        const reg = projects.createRegistry({ exec: slow });
        const c = await boot(new Store(), PORT, { projects: reg });
        PORT = c.port;
        try {
          const t0 = Date.now();
          const r = await rq(PORT, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' },
            body: { event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 'slow1', cwd: mk() } } });
          assert.strictEqual(r.status, 204);
          assert.ok(Date.now() - t0 < 1000, 'hook waited on git: ' + (Date.now() - t0) + ' ms');
          await sleep(100);
          assert.ok(started >= 1, 'the slow git really was in flight');
          assert.strictEqual((await rq(PORT, { path: '/state' })).status, 200);
        } finally { await halt(c); }
      });
    });

    await atest('projects exit 5: POST /api/review and /api/projects/<id>/hide reject every guard failure; valid calls pass', async () => {
      await withHome(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const store = new Store();
        store.applyHook('SessionStart', { session_id: 'live1', cwd: 'C:\\work\\live1' }, { ppid: 4242 });
        const reg = projects.createRegistry();
        const pid = reg.register(mk()).id;
        let refreshes = 0;
        const stubRepos = { snapshot: () => ({}), refresh: () => { refreshes++; return Promise.resolve(); } };
        const reviewed = [];
        const c = await boot(store, PORT, { projects: reg, repos: stubRepos, onReview: (s) => { reviewed.push(s); return true; } });
        PORT = c.port;
        const ORIGIN = 'http://127.0.0.1:' + PORT;
        try {
          const tokRes = await rq(PORT, { path: '/api/token' });
          assert.strictEqual(tokRes.status, 200);
          const token = JSON.parse(tokRes.text).token;
          assert.ok(typeof token === 'string' && token.length >= 32);
          assert.strictEqual((await rq(PORT, { path: '/api/token', headers: { origin: 'http://evil.example' } })).status, 403, 'token is behind the Origin rule');
          assert.strictEqual((await rq(PORT, { path: '/api/token', headers: { host: 'evil.example' } })).status, 403, 'and the Host rule');

          const good = { origin: ORIGIN, 'content-type': 'application/json', 'x-sereno-token': token };
          const routes = [
            { name: 'review', path: '/api/review', body: { sessionId: 'live1' }, bad: { sessionId: 'nope' } },
            { name: 'hide', path: '/api/projects/' + pid + '/hide', body: { hidden: true }, bad: null },
          ];
          for (const r of routes) {
            const post = (headers, body) => rq(PORT, { method: 'POST', path: r.path, headers, body });
            const hdr = (o) => { const h = Object.assign({}, good, o); for (const k of Object.keys(h)) if (h[k] === null) delete h[k]; return h; };
            const before = reviewed.length;
            const expect = async (label, res, code) => assert.strictEqual((await res).status, code, r.name + ': ' + label);
            await expect('foreign Origin', post(hdr({ origin: 'http://evil.example' }), r.body), 403);
            await expect('foreign Origin, right port', post(hdr({ origin: 'http://127.0.0.1:1' }), r.body), 403);
            await expect('missing Origin', post(hdr({ origin: null }), r.body), 403);
            await expect('wrong token', post(hdr({ 'x-sereno-token': token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') }), r.body), 403);
            await expect('short token', post(hdr({ 'x-sereno-token': 'x' }), r.body), 403);
            await expect('missing token', post(hdr({ 'x-sereno-token': null }), r.body), 403);
            await expect('text/plain', post(hdr({ 'content-type': 'text/plain' }), r.body), 403);
            await expect('missing content-type', post(hdr({ 'content-type': null }), r.body), 403);
            await expect('oversize body', post(hdr({}), '{"x":"' + 'a'.repeat(5000) + '"}'), 400);
            await expect('extra key', post(hdr({}), Object.assign({ extra: 1 }, r.body)), 400);
            await expect('not json', post(hdr({}), 'nope'), 400);
            await expect('array body', post(hdr({}), []), 400);
            await expect('wrong value type', post(hdr({}), { [Object.keys(r.body)[0]]: 7 }), 400);
            assert.strictEqual(reviewed.length, before, 'nothing was raised by a rejected call');
            assert.strictEqual(reg.list()[0].hidden, false, 'nothing was hidden by a rejected call');
            if (r.bad) await expect('unknown session', post(hdr({}), r.bad), 404);
          }
          // review never takes a pid
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/review', headers: good, body: { sessionId: 'live1', pid: 1 } })).status, 400);
          assert.strictEqual(reviewed.length, 0);
          // unknown project
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/projects/deadbeef0000/hide', headers: good, body: { hidden: true } })).status, 404);
          // valid
          const ok = await rq(PORT, { method: 'POST', path: '/api/review', headers: good, body: { sessionId: 'live1' } });
          assert.strictEqual(ok.status, 204);
          assert.strictEqual(reviewed.length, 1);
          assert.strictEqual(reviewed[0].id, 'live1');
          assert.strictEqual(reviewed[0].pid, 4242, 'the pid is the store\'s');
          // localhost origin is accepted too (localOnly accepts that Host)
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/projects/' + pid + '/hide', headers: Object.assign({}, good, { origin: 'http://localhost:' + PORT }), body: { hidden: true } })).status, 204);
          assert.strictEqual(reg.list()[0].hidden, true);
          assert.strictEqual(refreshes, 1, 'hide asks the poller to refresh');
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/projects/' + pid + '/hide', headers: good, body: { hidden: false } })).status, 204);
          assert.strictEqual(reg.list()[0].hidden, false);
          assert.strictEqual(refreshes, 2);
          // a failed raise is not a success
          const c2 = await boot(store, 0, { projects: reg, onReview: () => false });
          try {
            const t2 = JSON.parse((await rq(c2.port, { path: '/api/token' })).text).token;
            const r2 = await rq(c2.port, { method: 'POST', path: '/api/review', headers: { origin: 'http://127.0.0.1:' + c2.port, 'content-type': 'application/json', 'x-sereno-token': t2 }, body: { sessionId: 'live1' } });
            assert.strictEqual(r2.status, 502);
            // the first collector's token means nothing to the second
            const r3 = await rq(c2.port, { method: 'POST', path: '/api/review', headers: { origin: 'http://127.0.0.1:' + c2.port, 'content-type': 'application/json', 'x-sereno-token': token }, body: { sessionId: 'live1' } });
            assert.strictEqual(r3.status, 403);
          } finally { await halt(c2); }
        } finally { await halt(c); }
      });
    });

    await atest('projects exit 5: under serve (no onReview) review answers 501 after the guard and the session lookup', async () => {
      await withHome(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const store = new Store();
        store.applyHook('SessionStart', { session_id: 'live2', cwd: 'C:\\work\\live2' }, { ppid: 99 });
        const c = await boot(store, PORT, { projects: projects.createRegistry() });
        PORT = c.port;
        try {
          const token = JSON.parse((await rq(PORT, { path: '/api/token' })).text).token;
          const h = { origin: 'http://127.0.0.1:' + PORT, 'content-type': 'application/json', 'x-sereno-token': token };
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/review', headers: h, body: { sessionId: 'live2' } })).status, 501);
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/review', headers: Object.assign({}, h, { origin: 'http://evil.example' }), body: { sessionId: 'live2' } })).status, 403);
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/review', headers: h, body: { sessionId: 'ghost' } })).status, 404);
        } finally { await halt(c); }
      });
    });

    test('projects api: main and serve both wire the registry and poller; the focus code path is shared', () => {
      const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
      const serve = fs.readFileSync(path.join(ROOT, 'tools', 'serve.js'), 'utf8');
      assert.ok(/createRegistry\(\)/.test(main) && /createPoller\(/.test(main) && /projects: registry, repos: poller/.test(main));
      assert.ok(/poller\.start\(\)/.test(main) && /poller\.stop\(\)/.test(main));
      assert.ok(/onReview: \(session\) => raiseTerminal\(session\.pid\)/.test(main));
      assert.ok(/ipcMain\.handle\('sereno:focus', \(_e, pid\) => raiseTerminal\(pid\)\)/.test(main));
      assert.ok(/createRegistry\(\)/.test(serve) && /projects: registry, repos: poller/.test(serve) && /poller\.start\(\)/.test(serve) && /poller\.stop\(\)/.test(serve));
      assert.ok(!/onReview/.test(serve.replace(/\/\/.*$/gm, '')), 'serve passes no onReview');
    });

    // ---- gh PR counts ----
    const ghRepoList = (n) => ({ list: () => Array.from({ length: n }, (_, i) => ({ id: 'g' + i, name: 'g' + i, repoPath: 'C:\\x\\g' + i, hidden: false })) });
    const failGit = () => Promise.reject(new Error('no git'));
    const remoteGit = (url) => (f, a) => (a[0] === 'config' ? Promise.resolve({ stdout: url + '\n' }) : Promise.reject(new Error('no git')));
    const ghPoller = (n, gh, clock, extra) => repos.createPoller(Object.assign({
      registry: ghRepoList(n), exec: remoteGit('https://github.com/o/n.git'), ghExec: gh, now: () => clock.t,
    }, extra || {}));

    await atest('gh: counts open PRs with the documented command, env-safe options, and one call per project', async () => {
      const clock = { t: 1000 }; const calls = [];
      const p = ghPoller(2, (args, o) => { calls.push({ args, cwd: o.cwd }); return Promise.resolve({ stdout: '[{"number":3},{"number":9}]' }); }, clock);
      await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls.length, 2);
      assert.deepStrictEqual(calls[0].args, ['pr', 'list', '--repo', 'o/n', '--state', 'open', '--json', 'number', '--limit', '100']);
      assert.strictEqual(calls[0].cwd, os.tmpdir(), 'gh never runs inside the repo');
      assert.strictEqual(p.snapshot().g0.prs, 2);
      assert.strictEqual(p.snapshot().g1.prs, 2);
      const src = fs.readFileSync(path.join(ROOT, 'src', 'repos.js'), 'utf8');
      for (const k of ['GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'windowsHide: true', 'GH_TIMEOUT_MS = 10000']) assert.ok(src.includes(k), k);
    });

    await atest('gh: not installed (ENOENT) turns gh off for the run; signed out or odd output gives null for that project', async () => {
      const clock = { t: 1000 };
      let calls = 0;
      const missing = ghPoller(3, () => { calls++; return Promise.reject(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })); }, clock);
      await missing.pollNow(); await missing.pollGh();
      assert.strictEqual(calls, 1, 'stops at the first ENOENT');
      clock.t += 10 * 60 * 1000;
      await missing.pollGh();
      assert.strictEqual(calls, 1, 'off for the rest of the run');
      assert.ok(Object.values(missing.snapshot()).every((s) => s.prs === null));

      const outs = [
        () => Promise.reject(Object.assign(new Error('exit 1'), { code: 1 })),   // signed out / not a GitHub repo
        () => Promise.resolve({ stdout: 'not json' }),
        () => Promise.resolve({ stdout: '{"number":1}' }),
        () => Promise.resolve({ stdout: '[]' }),
      ];
      let i = 0;
      const odd = ghPoller(4, () => outs[i++](), clock);
      await odd.pollNow(); await odd.pollGh();
      const s = odd.snapshot();
      assert.deepStrictEqual([s.g0.prs, s.g1.prs, s.g2.prs, s.g3.prs], [null, null, null, 0]);
    });

    test('gh: remote URL parsing, credentials dropped, hostile or non-GitHub gives null', () => {
      const P = repos.parseGithubRemote;
      for (const u of ['https://github.com/o/n', 'https://github.com/o/n.git', 'git@github.com:o/n.git', 'ssh://git@github.com/o/n.git', 'https://user:tok@github.com/o/n']) {
        assert.deepStrictEqual(P(u), { owner: 'o', name: 'n' }, u);
      }
      for (const u of ['https://gitlab.com/o/n', 'https://evilgithub.com/o/n', '-o/x', 'https://github.com/-o/x', 'git@github.com:-o/x.git', 'https://github.com/o/n/extra', 'https://github.com/o/n x', '', null]) {
        assert.strictEqual(P(u), null, String(u));
      }
    });

    await atest('gh: the URL token never reaches gh; no remote or a non-GitHub remote means null and gh is not called', async () => {
      const clock = { t: 1 }; const calls = [];
      const gh = (args, o) => { calls.push({ args, o }); return Promise.resolve({ stdout: '[]' }); };
      const p = ghPoller(1, gh, clock, { exec: remoteGit('https://user:tok@github.com/o/n') });
      await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls.length, 1);
      assert.ok(!JSON.stringify(calls).includes('tok'), 'credentials stay out of the gh call');
      for (const exec of [failGit, remoteGit('https://gitlab.com/o/n'), remoteGit('')]) {
        const q = ghPoller(1, gh, clock, { exec });
        await q.pollNow(); await q.pollGh();
        assert.strictEqual(q.snapshot().g0.prs, null);
      }
      assert.strictEqual(calls.length, 1, 'gh was not called for them');
    });

    await atest('gh: polled every 5 minutes on its own, not with the 30 s git poll; hidden projects are skipped', async () => {
      const clock = { t: 1000 }; let calls = 0;
      const hiddenReg = { list: () => [{ id: 'a', name: 'a', repoPath: 'C:\\x\\a', hidden: false }, { id: 'b', name: 'b', repoPath: 'C:\\x\\b', hidden: true }] };
      const p = repos.createPoller({ registry: hiddenReg, exec: remoteGit('git@github.com:o/n.git'), now: () => clock.t, ghExec: () => { calls++; return Promise.resolve({ stdout: '[]' }); } });
      await p.pollGh(); assert.strictEqual(calls, 1, 'first poll, hidden project skipped');
      clock.t += 30 * 1000; await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls, 1, 'a git poll 30 s later does not poll gh');
      clock.t += 4 * 60 * 1000; await p.pollGh();
      assert.strictEqual(calls, 1, 'still inside 5 minutes');
      clock.t += 60 * 1000; await p.pollGh();
      assert.strictEqual(calls, 2, 'due at 5 minutes');
      assert.strictEqual(repos.GH_INTERVAL_MS, 5 * 60 * 1000);
    });
  }

    /* ---- [projects exit] Phase 3 exit criteria, one end-to-end test each ---- */
  {
    const projects = require('../src/projects.js');
    const repos = require('../src/repos.js');
    const briefsLib = require('../src/briefs.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const HOUR = 3600 * 1000;
    const git = (cwd, args, at) => execFileSync('git', args, {
      cwd, stdio: 'pipe', windowsHide: true,
      env: at === undefined ? baseEnv : Object.assign({}, baseEnv, { GIT_COMMITTER_DATE: new Date(at).toISOString(), GIT_AUTHOR_DATE: new Date(at).toISOString() }),
    }).toString().trim();
    const mkd = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-ex-' + tag + '-')));
    /** a repo on `main` with one commit; returns { d, c0 } */
    const repoWith = (tag, at, msg) => {
      const d = mkd(tag);
      git(d, ['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(d, 'README.md'), 'readme\n');
      git(d, ['add', '-A']);
      git(d, ['commit', '-q', '-m', msg || 'SERENO-COMMIT-CANARY first'], at);
      return { d, c0: git(d, ['rev-parse', 'HEAD']) };
    };
    const commitFile = (d, rel, content, msg, at) => {
      fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
      fs.writeFileSync(path.join(d, rel), content);
      git(d, ['add', '-A']);
      git(d, ['commit', '-q', '-m', msg], at);
      return git(d, ['rev-parse', 'HEAD']);
    };
    const briefDoc = (branch, sc, o) => [
      '---', 'branch: ' + branch, 'worktree: C:/somewhere/secret', 'version: 1', 'source_commit: ' + sc,
      'task: SERENO-TASK-CANARY', 'generated_at: 2026-10-01T10:00:00Z', '---',
      'Now: ' + ((o && o.now) || 'doing the thing'), 'Next: the next thing', 'Blocked: none', '',
    ].join('\n');
    const putBriefFile = (d, branch, sc, o) => {
      const f = path.join(d, '.sereno', 'briefs', encodeURIComponent(branch) + '.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, briefDoc(branch, sc, o));
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const withEnv = async (fn) => {
      const home = mkd('home'); const prev = { h: process.env.SERENO_HOME, c: process.env.CLAUDE_CONFIG_DIR };
      process.env.SERENO_HOME = home;
      process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
      try { await fn(home); }
      finally {
        if (prev.h === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev.h;
        if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
      }
    };
    const rq = (port, o) => new Promise((resolve, reject) => {
      const body = o.body === undefined ? null : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
      const headers = Object.assign({}, o.headers || {});
      if (body !== null) headers['content-length'] = Buffer.byteLength(body);
      const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method || 'GET', headers, agent: false }, (r) => {
        let t = ''; r.setEncoding('utf8'); r.on('data', (c) => { t += c; });
        r.on('end', () => resolve({ status: r.statusCode, text: t }));
      });
      req.on('error', reject);
      req.end(body === null ? undefined : body);
    });
    const boot = async (store, port, opts) => {
      const c = createCollector(store, 0, opts);
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (c.port = a.port, res()))));
      return c;
    };
    const halt = (c) => new Promise((res) => { c.server.close(() => res()); c.close(); });
    const apiProjects = async (port) => JSON.parse((await rq(port, { path: '/api/projects' })).text);
    const hookStart = (port, id, cwd) => rq(port, { method: 'POST', path: '/hook', headers: { 'content-type': 'application/json' },
      body: { event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: id, cwd } } });
    const waitFor = async (cond, ms) => { for (let i = 0; i < (ms || 8000) / 50 && !cond(); i++) await sleep(50); };
    const byName = (r, tag) => r.projects.find((p) => p.name.startsWith('sereno-ex-' + tag + '-'));

    await atest('[projects exit 1] fresh, behind, stale, none and unknown repos each show exactly the expected freshness in /api/projects', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const T = Date.parse('2026-10-11T12:00:00Z');   // the injected poller clock
        const fresh = repoWith('fr', T - 30 * HOUR);
        putBriefFile(fresh.d, 'main', fresh.c0);
        const behind = repoWith('bh', T - 30 * HOUR);
        putBriefFile(behind.d, 'main', behind.c0);
        commitFile(behind.d, 'src/a.js', 'x\n', 'code change', T - 1 * HOUR);
        const stale = repoWith('st', T - 40 * HOUR);
        putBriefFile(stale.d, 'main', stale.c0);
        commitFile(stale.d, 'src/a.js', 'x\n', 'code change', T - 25 * HOUR);   // the poller clock is 25 h later
        const none = repoWith('no', T - 30 * HOUR);
        const unknown = repoWith('un', T - 30 * HOUR);
        putBriefFile(unknown.d, 'main', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
        const reg = projects.createRegistry();
        const poller = repos.createPoller({ registry: reg, now: () => T });
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          const all = [fresh, behind, stale, none, unknown];
          for (let i = 0; i < all.length; i++) assert.strictEqual((await hookStart(PORT, 's' + i, all[i].d)).status, 204);
          await waitFor(() => reg.list().length === 5);
          assert.strictEqual(reg.list().length, 5);
          await poller.pollNow();
          const r = await apiProjects(PORT);
          assert.strictEqual(r.projects.length, 5);
          const got = {};
          for (const t of ['fr', 'bh', 'st', 'no', 'un']) got[t] = byName(r, t).freshness;
          assert.deepStrictEqual(got, { fr: 'fresh', bh: 'behind', st: 'stale', no: 'none', un: 'unknown' });
          for (const p of r.projects) assert.ok(['fresh', 'behind', 'stale', 'none', 'unknown'].includes(p.freshness));
          assert.strictEqual(byName(r, 'no').brief, null);
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 2] brief-only, STATUS-only and mixed brief+STATUS commits stay fresh; a source commit makes it behind, then stale 25 h later', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const { d, c0 } = repoWith('c2');
        putBriefFile(d, 'main', c0);
        const clock = { t: Date.now() };
        const reg = projects.createRegistry();
        const poller = repos.createPoller({ registry: reg, now: () => clock.t });
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          await hookStart(PORT, 'x', d);
          await waitFor(() => reg.list().length === 1);
          const fr = async () => { await poller.pollNow(); return byName(await apiProjects(PORT), 'c2'); };
          assert.strictEqual((await fr()).freshness, 'fresh');
          commitFile(d, '.sereno/briefs/x.md', briefDoc('x', c0), 'brief only');
          assert.strictEqual((await fr()).freshness, 'fresh', 'a commit touching only .sereno/briefs/x.md');
          commitFile(d, 'STATUS.md', 'status\n', 'status only');
          assert.strictEqual((await fr()).freshness, 'fresh', 'a commit touching only STATUS.md');
          fs.writeFileSync(path.join(d, 'STATUS.md'), 'status 2\n');
          commitFile(d, '.sereno/briefs/x.md', briefDoc('x', c0, { now: 'again' }), 'both');
          let p = await fr();
          assert.strictEqual(p.freshness, 'fresh', 'a commit touching both');
          assert.strictEqual(p.brief.behindSince, null);
          commitFile(d, 'src/a.js', 'x\n', 'code', Date.now());
          p = await fr();
          assert.strictEqual(p.freshness, 'behind');
          assert.ok(typeof p.brief.behindSince === 'number');
          clock.t += 25 * HOUR;
          assert.strictEqual((await fr()).freshness, 'stale');
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 3] sessions in a repo and in its git worktree (other path casing) make one project', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const { d } = repoWith('c3');
        const wt = path.join(mkd('c3wt'), 'wt');
        git(d, ['worktree', 'add', '-q', '-b', 'side', wt]);
        const reg = projects.createRegistry();
        const poller = repos.createPoller({ registry: reg });
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          const flipped = process.platform === 'win32' ? wt.toUpperCase() : wt;
          assert.strictEqual((await hookStart(PORT, 'a1', d)).status, 204);
          assert.strictEqual((await hookStart(PORT, 'a2', flipped)).status, 204);
          await waitFor(() => reg.list().length >= 1);
          await sleep(1000);   // give a (wrongly) separate second registration time to land
          await poller.pollNow();
          const r = await apiProjects(PORT);
          assert.strictEqual(r.projects.length, 1, 'one project, not two');
          assert.strictEqual(reg.list().length, 1);
          assert.ok(r.projects[0].branches.length >= 1);
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 4] /hook and /api/projects answer in under 1 s while the registry git is stubbed to take 3 s', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        let started = 0;
        const slow = () => { started++; return new Promise((res) => setTimeout(() => res({ stdout: '' }), 3000)); };
        const reg = projects.createRegistry({ exec: slow });
        const poller = repos.createPoller({ registry: reg });
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          const t0 = Date.now();
          const r = await hookStart(PORT, 'slow1', mkd('c4'));
          const dt = Date.now() - t0;
          assert.strictEqual(r.status, 204);
          assert.ok(dt < 1000, 'the hook waited on git: ' + dt + ' ms');
          await waitFor(() => started >= 1, 2000);
          assert.ok(started >= 1, 'the slow git really was in flight');
          const t1 = Date.now();
          assert.strictEqual((await rq(PORT, { path: '/api/projects' })).status, 200);
          assert.ok(Date.now() - t1 < 1000, 'the API waited on git');
          const t2 = Date.now();
          assert.strictEqual((await hookStart(PORT, 'slow2', mkd('c4'))).status, 204);
          assert.ok(Date.now() - t2 < 1000, 'a second hook waited on git');
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 5] both guarded POST routes reject every guard failure with the documented 4xx; valid calls reach the stub and the registry', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const { d } = repoWith('c5');
        const store = new Store();
        store.applyHook('SessionStart', { session_id: 'live1', cwd: 'C:\\work\\live1' }, { ppid: 4242 });
        const reg = projects.createRegistry();
        const pid = reg.register(d).id;
        const poller = repos.createPoller({ registry: reg });
        await poller.pollNow();
        const reviewed = [];
        const c = await boot(store, PORT, { projects: reg, repos: poller, onReview: (s) => { reviewed.push(s); return true; } });
        PORT = c.port;
        const ORIGIN = 'http://127.0.0.1:' + PORT;
        try {
          const token = JSON.parse((await rq(PORT, { path: '/api/token' })).text).token;
          const good = { origin: ORIGIN, 'content-type': 'application/json', 'x-sereno-token': token };
          const hdr = (o) => { const h = Object.assign({}, good, o); for (const k of Object.keys(h)) if (h[k] === null) delete h[k]; return h; };
          const flipTok = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
          const routes = [
            { name: 'review', path: '/api/review', body: { sessionId: 'live1' }, unknown: { sessionId: 'ghost' }, extra: { sessionId: 'live1', pid: 1 } },
            { name: 'hide', path: '/api/projects/' + pid + '/hide', body: { hidden: true }, unknown: null, extra: { hidden: true, extra: 1 } },
          ];
          for (const r of routes) {
            const post = (h, b) => rq(PORT, { method: 'POST', path: r.path, headers: h, body: b });
            const expect = async (label, res, code) => assert.strictEqual((await res).status, code, r.name + ': ' + label);
            await expect('foreign Origin', post(hdr({ origin: 'http://evil.example' }), r.body), 403);
            await expect('missing Origin', post(hdr({ origin: null }), r.body), 403);
            await expect('wrong token', post(hdr({ 'x-sereno-token': flipTok }), r.body), 403);
            await expect('missing token', post(hdr({ 'x-sereno-token': null }), r.body), 403);
            await expect('text/plain', post(hdr({ 'content-type': 'text/plain' }), r.body), 403);
            await expect('oversize body', post(hdr({}), '{"x":"' + 'a'.repeat(5000) + '"}'), 400);
            await expect('extra key', post(hdr({}), r.extra), 400);
            if (r.unknown) await expect('unknown session', post(hdr({}), r.unknown), 404);
          }
          const ghost = await rq(PORT, { method: 'POST', path: '/api/projects/deadbeef0000/hide', headers: good, body: { hidden: true } });
          assert.strictEqual(ghost.status, 404, 'unknown project');
          assert.strictEqual(reviewed.length, 0, 'no rejected call reached onReview');
          assert.strictEqual((await apiProjects(PORT)).projects[0].hidden, false, 'no rejected call hid anything');
          // valid
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/review', headers: good, body: { sessionId: 'live1' } })).status, 204);
          assert.strictEqual(reviewed.length, 1);
          assert.strictEqual(reviewed[0].id, 'live1');
          assert.strictEqual(reviewed[0].pid, 4242, 'the pid comes from the store');
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/projects/' + pid + '/hide', headers: good, body: { hidden: true } })).status, 204);
          assert.strictEqual((await apiProjects(PORT)).projects[0].hidden, true);
          assert.strictEqual((await rq(PORT, { method: 'POST', path: '/api/projects/' + pid + '/hide', headers: good, body: { hidden: false } })).status, 204);
          assert.strictEqual((await apiProjects(PORT)).projects[0].hidden, false);
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 6] /api/projects carries no commit message, file content, path, hash or path key; brief lines are stripped and capped', async () => {
      await withEnv(async () => {
        let PORT = 0;   // port 0: the OS picks a free one
        const { d, c0 } = repoWith('c6', undefined, 'SERENO-COMMIT-CANARY one');
        const sha = commitFile(d, 'notes.txt', 'SERENO-FILE-CANARY contents\n', 'SERENO-COMMIT-CANARY two');
        const hostile = 'visible\u0000\u0007\u001b[31m\u0085\u202e\u2066\u2069text' + 'Z'.repeat(300);
        putBriefFile(d, 'main', c0, { now: hostile });
        const reg = projects.createRegistry();
        const poller = repos.createPoller({ registry: reg });
        const c = await boot(new Store(), PORT, { projects: reg, repos: poller });
        PORT = c.port;
        try {
          await hookStart(PORT, 'x', d);
          await waitFor(() => reg.list().length === 1);
          await poller.pollNow();
          const text = (await rq(PORT, { path: '/api/projects' })).text;
          const r = JSON.parse(text);
          const p = byName(r, 'c6');
          assert.ok(p && p.brief, 'the project and its brief are present');
          assert.ok(!/SERENO-FILE-CANARY/.test(text), 'file content');
          assert.ok(!/SERENO-TASK-CANARY/.test(text), 'brief front matter other than the lines');
          assert.ok(!/SERENO-COMMIT-CANARY/.test(text), 'commit message');
          assert.ok(!/\b[0-9a-f]{40}\b/i.test(text) && !text.includes(sha) && !text.includes(c0), 'no hash');
          assert.ok(!text.toLowerCase().includes(os.tmpdir().toLowerCase().replace(/\\/g, '\\\\')), 'no path');
          assert.ok(!text.includes('somewhere/secret'), 'no brief worktree path');
          const bad = new Set(['cwd', 'worktree', 'worktrees', 'repoPath', 'worktreePath', 'path', 'sourceCommit', 'head']);
          (function walk(o, where) {
            if (Array.isArray(o)) return o.forEach((x, i) => walk(x, where + '[' + i + ']'));
            if (o && typeof o === 'object') for (const k of Object.keys(o)) {
              assert.ok(!bad.has(k), 'forbidden key ' + where + '.' + k);
              walk(o[k], where + '.' + k);
            }
          })(r, '$');
          const now = p.brief.now;
          assert.ok(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(now), 'control and bidi characters stripped');
          assert.ok(now.startsWith('visible[31mtext'), 'the visible text survives: ' + JSON.stringify(now.slice(0, 20)));
          assert.ok(now.length <= briefsLib.MAX_LINE && now.length < 300, 'capped at ' + now.length);
          assert.ok(now.endsWith('\u2026'));
        } finally { await halt(c); }
      });
    });

    await atest('[projects exit 7] /brief install never overwrites a different brief.md (bytes unchanged); Sereno\'s own unedited older copy is updated', async () => {
      const tmp = mkd('c7');
      const prev = { c: process.env.CLAUDE_CONFIG_DIR, h: process.env.SERENO_HOME };
      process.env.CLAUDE_CONFIG_DIR = tmp; process.env.SERENO_HOME = tmp;
      try {
        const target = path.join(tmp, 'commands', 'brief.md');
        const tpl = fs.readFileSync(wiring.commandTemplatePath(), 'utf8');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const theirs = Buffer.from('---\ndescription: mine\n---\nSomebody else wrote this brief command.\r\n');
        fs.writeFileSync(target, theirs);
        assert.strictEqual(wiring.commandsStatus(), 'conflict');
        const r = wiring.installCommands();
        assert.deepStrictEqual(r.conflict, ['commands/brief.md']);
        assert.ok(fs.readFileSync(target).equals(theirs), 'bytes unchanged');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(target)), ['brief.md'], 'no temp or backup file left');
        // Sereno's own older copy, never edited
        fs.rmSync(target);
        const oldTpl = path.join(tmp, 'old-template.md');
        fs.writeFileSync(oldTpl, 'an older Sereno brief command\n');
        wiring.installCommands({ templatePath: oldTpl });
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'an older Sereno brief command\n');
        assert.strictEqual(wiring.commandsStatus(), 'update-available');
        const up = wiring.installCommands();
        assert.strictEqual(up.conflict, null);
        assert.deepStrictEqual(up.changes, ['commands/brief.md: updated']);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), tpl);
        assert.strictEqual(wiring.commandsStatus(), 'installed');
      } finally {
        if (prev.c === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev.c;
        if (prev.h === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev.h;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  /* ---- Phase 3: red-team fixes ---- */
  {
    const briefs = require('../src/briefs.js');
    const repos = require('../src/repos.js');
    const projects = require('../src/projects.js');
    const { gitExec, isLocalPath, SAFE_ARGS } = require('../src/gitexec.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const mkd = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-rt-' + tag + '-')));
    const mkRepo = (branch) => {
      const d = mkd('repo');
      git(d, 'init', '-q', '-b', branch || 'main');
      fs.writeFileSync(path.join(d, 'a.js'), '1');
      git(d, 'add', 'a.js');
      git(d, 'commit', '-q', '-m', 'init');
      return d;
    };
    const fake = (dirs) => ({ list: () => dirs.map((d, i) => ({ id: 'p' + i, name: path.basename(d), repoPath: d, hidden: false })) });
    const putBrief = (wt, branch, sc) => {
      const dir = path.join(wt, '.sereno', 'briefs'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, encodeURIComponent(branch) + '.md'),
        '---\nbranch: ' + branch + '\nversion: 1\nsource_commit: ' + sc + '\ngenerated_at: 2026-10-01T10:00:00Z\n---\nNow: x\nNext: y\nBlocked: none\n');
    };
    const UNCS = ['\\\\127.0.0.1\\share\\repo', '//host/share/repo', '\\\\?\\UNC\\host\\share\\repo', '\\\\.\\pipe\\x', '\\\\?\\C:\\x', 'relative/dir', '/mnt/c/x', 'C:rel'];

    test('rt1: isLocalPath accepts drive-letter paths only', () => {
      assert.ok(isLocalPath('C:\\Users\\x') && isLocalPath('d:/work/repo'));
      for (const u of UNCS.concat(['', null, undefined, 'C:\\' + 'a'.repeat(1100)])) assert.strictEqual(isLocalPath(u), false, String(u));
    });

    test('rt1: SAFE_ARGS blank every signature-display setting', () => {
      const j = SAFE_ARGS.join(' ');
      for (const k of ['log.showSignature=false', 'gpg.program=', 'gpg.ssh.program=', 'gpg.x509.program=']) assert.ok(j.includes(k), k);
    });

    // A forged commit with a gpgsig header, after the brief's source commit, in a repo whose config
    // runs a marker program on signature display.
    for (const variant of ['gpg.program', 'gpg.ssh.program']) {
      await atest('rt1: forged gpgsig commit + ' + variant + ' marker: plain git log runs it (control); Sereno freshness does not', async () => {
        const d = mkRepo();
        const c0 = git(d, 'rev-parse', 'HEAD').trim();
        putBrief(d, 'main', c0);
        const marker = path.join(mkd('marker'), 'ran.txt');
        // Git for Windows runs a shebang script given as the whole program value.
        const script = path.join(path.dirname(marker), 'marker-prog');
        fs.writeFileSync(script, '#!/bin/sh\necho ran > "' + marker.replace(/\\/g, '/') + '"\n');
        const sigKind = variant === 'gpg.program' ? 'PGP' : 'SSH';
        // the commit that will be forged: a real change, so path-limited history keeps it
        fs.writeFileSync(path.join(d, 'b.js'), '2'); git(d, 'add', 'b.js'); git(d, 'commit', '-q', '-m', 'real');
        const tree = git(d, 'rev-parse', 'HEAD^{tree}').trim();
        const raw = 'tree ' + tree + '\nparent ' + c0 + '\nauthor t <t@example.invalid> 1700000000 +0000\ncommitter t <t@example.invalid> 1700000000 +0000\n'
          + 'gpgsig -----BEGIN ' + sigKind + ' SIGNATURE-----\n \n U1NIU0lH\n -----END ' + sigKind + ' SIGNATURE-----\n\nforged\n';
        const forged = execFileSync('git', ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], { cwd: d, input: raw, env: baseEnv }).toString().trim();
        git(d, 'update-ref', 'refs/heads/main', forged);
        const prog = script.replace(/\\/g, '/');
        git(d, 'config', 'log.showSignature', 'true');
        if (variant === 'gpg.program') git(d, 'config', 'gpg.program', prog);
        else {
          const signers = path.join(path.dirname(marker), 'signers'); fs.writeFileSync(signers, '');
          git(d, 'config', 'gpg.format', 'ssh'); git(d, 'config', 'gpg.ssh.program', prog);
          git(d, 'config', 'gpg.ssh.allowedSignersFile', signers.replace(/\\/g, '/'));
        }
        // control: what the old `git log` did
        execFileSync('git', ['log', '-1', 'main'], { cwd: d, env: baseEnv, stdio: 'pipe' });
        assert.ok(fs.existsSync(marker), 'control: the plain git log must run the marker program');
        fs.rmSync(marker);
        // Sereno: no marker, and the right answer
        const f = await briefs.freshness({ brief: { branch: 'main', sourceCommit: c0 }, exec: gitExec, cwd: d, now: Date.now() });
        assert.ok(f === 'behind' || f === 'stale', 'forged commit past the source is behind: ' + f);
        const p = repos.createPoller({ registry: fake([d]) });
        await p.pollNow();
        assert.ok(!fs.existsSync(marker), 'Sereno never ran the signature program');
        assert.ok(['behind', 'stale'].includes(p.snapshot().p0.freshness), p.snapshot().p0.freshness);
      });
    }

    await atest('rt1: freshness uses rev-list --timestamp with an exclude pathspec; oldest is the minimum', async () => {
      const calls = [];
      const exec = async (f, a) => {
        calls.push(a);
        if (a[0] === 'rev-list') return { stdout: '2000 aaaa\n1000 bbbb\n3000 cccc\n' };
        return { stdout: '' };
      };
      const r = await briefs.inspectFreshness({ brief: { branch: 'main', sourceCommit: 'abcd1234' }, exec, cwd: 'C:/x' });
      assert.deepStrictEqual(r, { oldest: 1000 * 1000 });
      const rl = calls.find((a) => a[0] === 'rev-list');
      assert.ok(rl.includes('--timestamp') && rl.includes(':(exclude).sereno') && rl.includes(':(exclude)STATUS.md'));
      assert.ok(!calls.some((a) => a[0] === 'log'), 'no porcelain log');
      for (const a of calls) assert.ok(a.indexOf('--end-of-options') !== -1, 'end-of-options in ' + a.join(' '));
      assert.ok(rl.indexOf('--end-of-options') < rl.findIndex((x) => x.includes('..')), 'before the revision');
    });

    await atest('rt2: HEAD on refs/heads/--output=zzz: plain rev-list writes a file (control); a poll writes nothing and the branch is skipped', async () => {
      const d = mkRepo('trunk');
      git(d, 'update-ref', 'refs/heads/--output=zzz', 'HEAD');
      git(d, 'symbolic-ref', 'HEAD', 'refs/heads/--output=zzz');
      git(d, 'update-ref', '-d', 'refs/heads/trunk');
      const listing = () => fs.readdirSync(d).filter((n) => n !== '.git').sort();
      const before = listing();
      // control: the unvalidated command line the red team found
      try { execFileSync('git', ['rev-list', '--left-right', '--count', '--output=zzz...--output=zzz@{upstream}'], { cwd: d, env: baseEnv, stdio: 'pipe' }); } catch (_) {}
      assert.ok(listing().length > before.length, 'control: the unprotected command creates a file');
      for (const n of listing()) if (!before.includes(n)) fs.rmSync(path.join(d, n), { force: true });
      const spied = [];
      const exec = (f, a, o) => { spied.push(a); return gitExec(f, a, o); };
      const p = repos.createPoller({ registry: fake([d]), exec });
      await p.pollNow();
      assert.deepStrictEqual(listing(), before, 'no file written into the repo');
      const s = p.snapshot().p0;
      assert.strictEqual(s.error, false);
      assert.strictEqual(s.defaultBranch, null);
      assert.ok(!s.branches.some((b) => b.name.startsWith('-')), 'invalid branch row skipped');
      assert.ok(!s.worktrees.some((w) => w.branch && w.branch.startsWith('-')));
      for (const a of spied) if (a[0] === 'rev-list') assert.ok(a.includes('--end-of-options'));
    });

    await atest('rt2: for-each-ref is count-limited and newest first', async () => {
      const seen = [];
      const d = mkRepo();
      const p = repos.createPoller({ registry: fake([d]), exec: (f, a, o) => { seen.push(a); return gitExec(f, a, o); } });
      await p.pollNow();
      const fe = seen.find((a) => a[0] === 'for-each-ref');
      assert.ok(fe.includes('--count=2000') && fe.includes('--sort=-committerdate'));
    });

    await atest('rt3: UNC-shaped cwds never reach exec (registry), including over the /hook path', async () => {
      const calls = [];
      const exec = async (f, a, o) => { calls.push(o && o.cwd); return { stdout: '' }; };
      const home = mkd('home'); const prev = process.env.SERENO_HOME; process.env.SERENO_HOME = home;
      try {
        const reg = projects.createRegistry({ exec, file: path.join(home, 'projects.json') });
        for (const u of UNCS.concat(['C:\\' + 'a'.repeat(1100)])) { await reg.noteCwd(u); assert.strictEqual(await reg.resolve(u), null); }
        assert.strictEqual(calls.length, 0, 'exec never called');
        let PORT = 0;   // port 0: the OS picks a free one
        const c = createCollector(new Store(), 0, { projects: reg });
        await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
        try {
          for (const u of UNCS) {
            await new Promise((resolve, reject) => {
              const body = JSON.stringify({ event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 's-unc', cwd: u } });
              const rq = http.request({ host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST', headers: { 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', resolve); });
              rq.on('error', reject); rq.end(body);
            });
          }
          await new Promise((r) => setTimeout(r, 100));
        } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
        assert.strictEqual(calls.length, 0, 'still no exec after /hook');
        assert.deepStrictEqual(reg.list(), []);
        // control: a local path does reach exec
        await reg.noteCwd('C:\\somewhere\\local');
        assert.ok(calls.length > 0, 'control: a drive-letter cwd runs git');
      } finally { if (prev === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prev; }
    });

    await atest('rt3: a UNC repoPath, a UNC worktree and a prunable worktree are never passed to exec or fs; the real worktree still works', async () => {
      const d = mkRepo();
      const ghost = 'C:/definitely/not/here/ghost';
      const porcelain = [
        'worktree ' + d.replace(/\\/g, '/'), 'HEAD ' + '0'.repeat(40), 'branch refs/heads/main', '',
        'worktree \\\\evil.example\\share\\wt', 'HEAD ' + '1'.repeat(40), 'branch refs/heads/evil', '',
        'worktree //evil2.example/share/wt', 'HEAD ' + '2'.repeat(40), 'detached', '',
        'worktree C:/prunable/one', 'HEAD ' + '3'.repeat(40), 'detached', 'prunable gitdir file points to non-existent location', '',
        'worktree ' + ghost, 'HEAD ' + '4'.repeat(40), 'branch refs/heads/ghost', '',
      ].join('\n');
      const cwds = [];
      const exec = async (f, a, o) => {
        cwds.push(o && o.cwd);
        if (a[0] === 'worktree') return { stdout: porcelain };
        if (a[0] === 'for-each-ref') return { stdout: 'main\t1700000000\t' + '0'.repeat(40) + '\n' };
        if (a[0] === 'config') throw Object.assign(new Error('none'), { code: 1 });
        if (a[0] === 'status') return { stdout: '' };
        throw new Error('n/a');
      };
      const fsCalls = [];
      const real = fs.promises;
      const fsp = new Proxy(real, { get: (t, k) => (typeof t[k] === 'function' ? (...args) => { fsCalls.push(String(args[0])); return t[k](...args); } : t[k]) });
      const p = repos.createPoller({ registry: fake([d]), exec, fsp });
      await p.pollNow();
      const s = p.snapshot().p0;
      assert.strictEqual(s.error, false);
      assert.deepStrictEqual(s.worktrees.map((w) => w.branch), ['main'], 'only the real worktree survives');
      assert.ok(!cwds.some((c) => /evil|prunable|ghost/.test(String(c))), 'exec cwd: ' + cwds.join());
      assert.ok(!fsCalls.some((c) => /evil|prunable/.test(c)), 'fs: ' + fsCalls.join());
      assert.ok(fsCalls.some((c) => c.includes('ghost')), 'the vanished local path is stat-ed (and skipped)');
      // a UNC repoPath: polled as an error, with no exec and no fs at all
      const cw2 = []; const fs2 = [];
      const u = repos.createPoller({
        registry: { list: () => [{ id: 'u', name: 'u', repoPath: '\\\\evil.example\\share\\repo', hidden: false }] },
        exec: async (f, a, o) => { cw2.push(o && o.cwd); return { stdout: '' }; },
        fsp: new Proxy(real, { get: (t, k) => (typeof t[k] === 'function' ? (...args) => { fs2.push(String(args[0])); return t[k](...args); } : t[k]) }),
      });
      await u.pollNow();
      assert.strictEqual(u.snapshot().u.error, true);
      assert.strictEqual(cw2.length + fs2.length, 0);
    });

    await atest('rt3: readBriefs is async, skips non-local paths without touching fs, and reads at most 16 KB + 1 per file', async () => {
      const pr = briefs.readBriefs([]);
      assert.ok(pr instanceof Promise, 'returns a promise');
      await pr;
      const touched = [];
      const spy = new Proxy(fs.promises, { get: (t, k) => (typeof t[k] === 'function' ? (...args) => { touched.push(String(args[0])); return t[k](...args); } : t[k]) });
      const r = await briefs.readBriefs(UNCS, { fsp: spy });
      assert.strictEqual(r.byBranch.size, 0);
      assert.strictEqual(touched.length, 0, 'fs untouched for ' + UNCS.length + ' non-local paths');
      // bounded read: a file that lstat says is small but reads big is cut at the cap and counted malformed
      const wt = mkd('big'); putBrief(wt, 'good', 'abcd1234');
      const dir = path.join(wt, '.sereno', 'briefs');
      fs.writeFileSync(path.join(dir, 'huge.md'), 'x'.repeat(200 * 1024));
      const bufLens = [];
      const bounded = {
        lstat: (p) => fs.promises.lstat(p).then((st) => (/huge/.test(p) ? Object.assign(Object.create(st), { size: 5, isFile: () => true, isSymbolicLink: () => false }) : st)),
        realpath: (p) => fs.promises.realpath(p),
        opendir: (p) => fs.promises.opendir(p),
        open: async (p, fl) => {
          const h = await fs.promises.open(p, fl);
          return { read: (buf, ...rest) => { bufLens.push(buf.length); return h.read(buf, ...rest); }, close: () => h.close() };
        },
      };
      const r2 = await briefs.readBriefs([wt], { fsp: bounded });
      assert.deepStrictEqual(Array.from(r2.byBranch.keys()), ['good']);
      assert.strictEqual(r2.malformed, 1, 'the oversize file is malformed');
      assert.ok(bufLens.length >= 2 && bufLens.every((n) => n <= briefs.MAX_BRIEF_BYTES + 1), 'read buffers: ' + bufLens.join());
      // control: the file cap on plain stat size
      const r3 = await briefs.readBriefs([wt]);
      assert.strictEqual(r3.malformed, 1);
      const many = mkd('many'); const md = path.join(many, '.sereno', 'briefs'); fs.mkdirSync(md, { recursive: true });
      for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(md, 'f' + i + '.md'), 'junk');
      const r4 = await briefs.readBriefs([many], { maxFiles: 5 });
      assert.ok(r4.malformed <= 5, 'file count capped: ' + r4.malformed);
    });

    await atest('rt4: /api/projects carries live { state, sessionIds } for a subfolder session and a worktree session', async () => {
      const home = mkd('home'); const prevH = process.env.SERENO_HOME; process.env.SERENO_HOME = home;
      try {
        const d = mkRepo();
        const wtDir = path.join(mkd('wt'), 'feature');
        git(d, 'worktree', 'add', '-q', '-b', 'feature', wtDir);
        const sub = path.join(d, 'packages', 'app'); fs.mkdirSync(sub, { recursive: true });
        const other = mkRepo();
        const reg = projects.createRegistry({ file: path.join(home, 'projects.json') });
        reg.register(d); reg.register(other);
        const poller = repos.createPoller({ registry: reg, ghExec: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) });
        await poller.pollNow();
        const store = new Store();
        store.applyHook('SessionStart', { session_id: 'sub-1', cwd: sub });
        store.applyHook('SessionStart', { session_id: 'wt-1', cwd: wtDir });
        store.applyHook('SessionStart', { session_id: 'old-1', cwd: sub });
        store.sessions.get('sub-1').state = 'thinking';
        store.sessions.get('wt-1').state = 'blocked';
        store.sessions.get('old-1').state = 'running';
        store.sessions.get('old-1').lastSeen = Date.now() - 60 * 60 * 1000;   // stale
        let PORT = 0;   // port 0: the OS picks a free one
        const c = createCollector(store, 0, { projects: reg, repos: poller });
        await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
        try {
          const j = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects' }, (r) => { let t = ''; r.on('data', (x) => { t += x; }); r.on('end', () => resolve(JSON.parse(t))); }).on('error', reject);
          });
          const byName = (n) => j.projects.find((p) => p.name === n);
          const mine = byName(path.basename(d));
          assert.deepStrictEqual(Object.keys(mine.live).sort(), ['sessionIds', 'state']);
          assert.strictEqual(mine.live.state, 'blocked', 'blocked wins over thinking');
          assert.deepStrictEqual(mine.live.sessionIds.sort(), ['sub-1', 'wt-1'], 'stale sessions are not listed');
          const idle = byName(path.basename(other));
          assert.deepStrictEqual(idle.live, { state: null, sessionIds: [] });
        } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
      } finally { if (prevH === undefined) delete process.env.SERENO_HOME; else process.env.SERENO_HOME = prevH; }
    });

    {
      const cjs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
      const names = ['esc', 'topSessions', 'liveState', 'isActive', 'visibleProjects', 'filterCounts', 'selectProjects', 'projectsSummary'];
      const lifted = names.map((n) => cjs.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0]);
      const P = new Function(lifted.join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
      test('rt4: the console takes live state from p.live, not from the project name', () => {
        const p = { id: 'a', name: 'alpha', hidden: false, git: { lastCommitAt: null }, lastActivity: null, live: { state: 'blocked', sessionIds: ['x'] } };
        const sessions = [{ id: 'x', projectName: 'packages-app', state: 'blocked' }];   // cwd basename != project name
        assert.strictEqual(P.liveState(p, sessions), 'blocked');
        assert.strictEqual(P.isActive(p, sessions, 1e12), true);
        assert.strictEqual(P.liveState(Object.assign({}, p, { live: { state: null, sessionIds: [] } }), [{ projectName: 'alpha', state: 'running' }]), null, 'a name match no longer counts when p.live says none');
        assert.strictEqual(P.isActive(Object.assign({}, p, { live: { state: 'idle', sessionIds: ['x'] } }), sessions, 1e12), false);
      });
    }

    test('rt5: the resolve cache evicts expired entries on insert and caps at 500, dropping the oldest', () => {
      const cache = new Map();
      for (let i = 0; i < 700; i++) projects.cacheSet(cache, 'k' + i, null, 1000 + i);
      assert.strictEqual(cache.size, projects.CACHE_MAX);
      assert.strictEqual(projects.CACHE_MAX, 500);
      assert.ok(!cache.has('k0') && !cache.has('k199') && cache.has('k200') && cache.has('k699'));
      projects.cacheSet(cache, 'late', null, 1000 + 700 + projects.CACHE_TTL_MS);
      assert.ok(cache.size < 500 && cache.has('late'), 'expired entries evicted on insert: ' + cache.size);
    });

    await atest('rt5: a cwd over 1024 chars is rejected before anything else', async () => {
      let n = 0;
      const exec = async () => { n++; return { stdout: 'C:/x\n' }; };
      assert.strictEqual(await projects.resolveRepo('C:\\' + 'a'.repeat(1030), { exec }), null);
      assert.strictEqual(n, 0);
      assert.ok(await projects.resolveRepo('C:\\short', { exec }), 'control: a short local cwd resolves');
    });

    await atest('rt6: a maxBuffer overflow on the freshness listing gives behind with no behindSince, not an error', async () => {
      const seen = [];
      const exec = async (f, a, o) => {
        seen.push(o);
        if (a[0] === 'rev-list') throw Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        return { stdout: '' };
      };
      const b = { branch: 'main', sourceCommit: 'abcd1234' };
      assert.strictEqual(await briefs.inspectFreshness({ brief: b, exec, cwd: 'C:/x' }), 'behind');
      assert.strictEqual(await briefs.freshness({ brief: b, exec, cwd: 'C:/x' }), 'behind');
      assert.ok(seen.some((o) => o && o.maxBuffer === 8 * 1024 * 1024), 'rev-list asks for an 8 MB buffer');
      // an ordinary failure stays unknown
      const bad = async (f, a) => { if (a[0] === 'rev-list') throw new Error('boom'); return { stdout: '' }; };
      assert.strictEqual(await briefs.freshness({ brief: b, exec: bad, cwd: 'C:/x' }), 'unknown');
      // end to end through the poller
      const d = mkRepo(); const c0 = git(d, 'rev-parse', 'HEAD').trim(); putBrief(d, 'main', c0);
      const p = repos.createPoller({ registry: fake([d]), exec: (f, a, o) => (a[0] === 'rev-list' && a.includes('--timestamp') ? exec(f, a, o) : gitExec(f, a, o)) });
      await p.pollNow();
      const s = p.snapshot().p0;
      assert.strictEqual(s.error, false);
      assert.strictEqual(s.freshness, 'behind');
      assert.strictEqual(s.behindSince, null);
    });

    test('rt7: README states the precise protections and the local-drive limit', () => {
      const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      assert.ok(!/repo-supplied programs disabled/.test(md), 'the over-broad claim is gone');
      assert.ok(!/never touches the network\./.test(md));
      assert.match(md, /never runs a network git command/);
      assert.match(md, /Projects on network drives or inside WSL are not tracked/);
      assert.match(md, /signature programs/);
    });
  }

  /* ---- Phase 3: red-team round 2 ---- */
  {
    const repos = require('../src/repos.js');
    const { gitExec, SAFE_ARGS, safeEnv } = require('../src/gitexec.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const mkd = (tag) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-rt2-' + tag + '-')));
    const fw = (p) => p.split(path.sep).join('/');
    const mkRepo = (branch) => {
      const d = mkd('repo');
      git(d, 'init', '-q', '-b', branch || 'main');
      fs.writeFileSync(path.join(d, 'a.js'), 'one');
      git(d, 'add', 'a.js');
      git(d, 'commit', '-q', '-m', 'init');
      return d;
    };
    const fake = (dirs) => ({ list: () => dirs.map((d, i) => ({ id: 'p' + i, name: path.basename(d), repoPath: d, hidden: false })) });

    test('rt2: SAFE_ARGS turn off every transport protocol, and the env turns off lazy fetch', () => {
      const j = SAFE_ARGS.join(' ');
      for (const k of ['file', 'ssh', 'http', 'https', 'git', 'ext']) assert.ok(j.includes('protocol.' + k + '.allow=never'), k);
      assert.strictEqual(safeEnv({}).GIT_NO_LAZY_FETCH, '1');
    });

    test('rt2: gitexec header states the threat model and README drops the false claims', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'gitexec.js'), 'utf8');
      assert.match(src, /Threat model/);
      assert.match(src, /does NOT/);
      const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      assert.ok(!/cannot make those run programs/.test(md));
      assert.ok(!/never opens a share on a path a repo points to/.test(md));
      assert.match(md, /Treat a repo's \.git folder like you would for git itself/);
      assert.match(md, /Threat model/);
    });

    // A promisor repo with one missing blob and an uploadpack that runs a marker program.
    await atest('rt2: promisor repo: plain git lazy-fetches (runs the marker); Sereno git, freshness and the poller do not', async () => {
      const d = mkRepo();
      const blob = git(d, 'rev-parse', 'HEAD:a.js').trim();
      const prog = path.join(mkd('mk'), 'marker.js');
      fs.writeFileSync(prog, "require('fs').appendFileSync(process.argv[2], 'x');");
      const marker = path.join(path.dirname(prog), 'ran.txt');
      git(d, 'config', 'core.repositoryformatversion', '1');
      for (const [k, v] of [['extensions.partialclone', 'origin'], ['remote.origin.promisor', 'true'],
        ['remote.origin.partialclonefilter', 'blob:none'], ['protocol.file.allow', 'always'], ['remote.origin.url', d],
        ['remote.origin.uploadpack', 'node ' + fw(prog) + ' ' + fw(marker) + ' #']]) git(d, 'config', k, v);
      fs.unlinkSync(path.join(d, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
      const ran = () => { const r = fs.existsSync(marker); try { fs.unlinkSync(marker); } catch (_) {} return r; };
      for (const a of [['cat-file', '-p', blob], ['rev-list', '--objects', 'HEAD']]) {
        try { git(d, ...a); } catch (_) {}
        assert.ok(ran(), 'control: plain git ' + a[0] + ' must run the marker');
      }
      const fut = new Date(Date.now() + 3600000);
      fs.writeFileSync(path.join(d, 'a.js'), 'one'); fs.utimesSync(path.join(d, 'a.js'), fut, fut);   // stat-dirty on purpose
      for (const a of [['cat-file', '-p', blob], ['rev-list', '--objects', 'HEAD'], ['status', '--porcelain', '--ignore-submodules=all'],
        ['for-each-ref', 'refs/heads', '--format=%(refname)']]) {
        try { await gitExec('git', a, { cwd: d }); } catch (_) { /* may fail: fine */ }
        assert.ok(!ran(), 'Sereno git ' + a[0] + ' ran the marker');
      }
      const p = repos.createPoller({ registry: fake([d]) });
      await p.pollNow();
      assert.ok(!ran(), 'the poller ran the marker');
    });

    await atest('rt2: a git call killed by the timeout backs the project off (5 min, doubling), others keep polling, success resets', async () => {
      const a = mkRepo(); const b = mkRepo();
      const clock = { t: 1000000 };
      const calls = { a: 0, b: 0 };
      let killA = true;
      const exec = (f, args, o) => {
        if (o.cwd === a) {
          calls.a++;
          if (killA) return Promise.reject(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }));
        }
        if (o.cwd === b) calls.b++;
        return gitExec(f, args, o);
      };
      const p = repos.createPoller({ registry: fake([a, b]), exec, now: () => clock.t });
      const MIN = 60000;
      await p.pollNow();
      assert.strictEqual(p.snapshot().p0.error, true);
      assert.strictEqual(p.snapshot().p1.error, false);
      const a1 = calls.a; const b1 = calls.b;
      clock.t += 1 * MIN; await p.pollNow();
      assert.strictEqual(calls.a, a1, 'A is skipped while backed off');
      assert.ok(calls.b > b1, 'B keeps polling');
      assert.strictEqual(p.snapshot().p0.error, true);
      clock.t += 4 * MIN + 1; await p.pollNow();
      assert.ok(calls.a > a1, 'A polled again after 5 minutes');
      const a2 = calls.a;
      clock.t += 9 * MIN; await p.pollNow();
      assert.strictEqual(calls.a, a2, 'second backoff is 10 minutes');
      killA = false;
      clock.t += 1 * MIN + 1; await p.pollNow();
      assert.ok(calls.a > a2);
      assert.strictEqual(p.snapshot().p0.error, false, 'a good poll clears the error');
      killA = true;
      const a3 = calls.a;
      clock.t += 1; await p.pollNow();
      assert.ok(calls.a > a3, 'backoff was reset by the success');
      const a4 = calls.a;
      clock.t += 4 * MIN; await p.pollNow();
      assert.strictEqual(calls.a, a4, 'and starts again at 5 minutes, not 20');
    });

    await atest('rt2: a session counts only for the project with the longest matching worktree path (nested repos)', async () => {
      const outer = mkd('outer'); const inner = path.join(outer, 'inner');
      fs.mkdirSync(path.join(inner, 'sub'), { recursive: true });
      const store = new Store();
      store.applyHook('SessionStart', { session_id: 'n1', cwd: path.join(inner, 'sub') });
      store.applyHook('Notification', { session_id: 'n1', cwd: path.join(inner, 'sub'), notification_type: 'permission_prompt' });
      const reg = { list: () => [
        { id: 'out', name: 'outer', repoPath: outer, hidden: false },
        { id: 'in', name: 'inner', repoPath: inner, hidden: false }] };
      let PORT = 0;   // port 0: the OS picks a free one
      const c = createCollector(store, 0, { projects: reg, repos: { snapshot: () => ({}) } });
      await new Promise((res, rej) => c.listen((e, a) => (e ? rej(e) : (PORT = a.port, res()))));
      try {
        const r = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects', agent: false }, (rs) => {
            let t = ''; rs.setEncoding('utf8'); rs.on('data', (x) => { t += x; }); rs.on('end', () => resolve(JSON.parse(t)));
          }).on('error', reject);
        });
        const o = r.projects.find((x) => x.id === 'out'); const i = r.projects.find((x) => x.id === 'in');
        assert.strictEqual(i.live.state, 'blocked');
        assert.deepStrictEqual(i.live.sessionIds, ['n1']);
        assert.strictEqual(o.live.state, null);
        assert.deepStrictEqual(o.live.sessionIds, []);
        assert.ok(typeof i.lastActivity === 'number');
        assert.strictEqual(o.lastActivity, null, 'the outer repo gets no lastActivity from the inner session');
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
    });

    await atest('rt2: a branch named like a tag still shows its brief (refname, not refname:short)', async () => {
      const d = mkRepo();
      const sc = git(d, 'rev-parse', 'HEAD').trim();
      git(d, 'branch', 'tagged'); git(d, 'tag', 'tagged');
      git(d, 'checkout', '-q', 'tagged');
      const dir = path.join(d, '.sereno', 'briefs'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'tagged.md'),
        '---\nbranch: tagged\nversion: 1\nsource_commit: ' + sc + '\ngenerated_at: 2026-10-01T10:00:00Z\n---\nNow: tagged work\nNext: y\nBlocked: none\n');
      const p = repos.createPoller({ registry: fake([d]) });
      await p.pollNow();
      const row = p.snapshot().p0.branches.find((x) => x.name === 'tagged');
      assert.ok(row, 'branch row is named tagged');
      assert.ok(row.brief && row.brief.now === 'tagged work');
      assert.deepStrictEqual(repos.parseBranches('refs/heads/feat/x\t100\tabc\nmain\t5\tdef').map((b) => b.name), ['feat/x', 'main']);
    });
  }

  /* ---- Phase 3: final fixes ---- */
  {
    const projects = require('../src/projects.js');
    const repos = require('../src/repos.js');
    const briefsLib = require('../src/briefs.js');
    const { gitExec } = require('../src/gitexec.js');
    const baseEnv = Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    });
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, stdio: 'pipe', windowsHide: true }).toString();
    const mk = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-ff-')));
    const mkRepo = () => {
      const d = mk();
      git(d, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(d, 'a.txt'), 'one');
      git(d, 'add', 'a.txt');
      git(d, 'commit', '-q', '-m', 'init');
      return d;
    };
    const fake = (dirs) => ({ list: () => dirs.map((d, i) => ({ id: 'p' + i, name: path.basename(d), repoPath: d, hidden: false })) });
    const counting = () => {
      const c = { n: 0, args: [] };
      c.exec = (f, a, o) => { c.n++; c.args.push(a.join(' ')); return gitExec(f, a, o); };
      return c;
    };

    await atest('ff-gh: a project registered after start gets its gh lookup on the next git poll, then keeps the 5 minute cadence', async () => {
      const clock = { t: 1000 }; let calls = 0;
      const list = [];
      const p = repos.createPoller({
        registry: { list: () => list }, now: () => clock.t,
        exec: (f, a) => (a[0] === 'config' ? Promise.resolve({ stdout: 'https://github.com/o/n.git' }) : Promise.reject(new Error('no git'))),
        ghExec: () => { calls++; return Promise.resolve({ stdout: '[{"number":1}]' }); },
      });
      await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls, 0, 'empty registry: nothing to look up');
      list.push({ id: 'late', name: 'late', repoPath: 'C://x//late', hidden: false });
      clock.t += 30 * 1000;
      await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls, 1, 'first gh lookup on the next git poll');
      assert.strictEqual(p.snapshot().late.prs, 1);
      clock.t += 30 * 1000;
      await p.pollNow(); await p.pollGh();
      assert.strictEqual(calls, 1, 'inside 5 minutes: no second gh call');
    });

    await atest('ff1: noteCwd runs at most 2 resolves at once and holds at most 50 distinct cwds', async () => {
      let live = 0; let maxLive = 0; let started = 0; let maxPending = 0;
      const gate = [];
      let reg;
      const exec = () => {
        started++; live++; maxLive = Math.max(maxLive, live); maxPending = Math.max(maxPending, reg.pendingCount());
        return new Promise((res) => { gate.push(() => { live--; res({ stdout: '' }); }); });
      };
      reg = projects.createRegistry({ exec, file: path.join(mk(), 'projects.json') });
      const all = [];
      for (let i = 0; i < 300; i++) {
        all.push(reg.noteCwd('C:\\ff1\\dir' + i));
        maxPending = Math.max(maxPending, reg.pendingCount());
      }
      assert.strictEqual(reg.pendingCount(), 50, 'distinct cwds beyond 50 are dropped while the queue is full');
      // drain: release whatever is running until nothing is left
      for (let spins = 0; spins < 200 && (gate.length || reg.pendingCount()); spins++) {
        while (gate.length) gate.shift()();
        await new Promise((r) => setImmediate(r));
      }
      await Promise.all(all);
      assert.strictEqual(reg.pendingCount(), 0);
      assert.ok(maxLive >= 1 && maxLive <= 2, 'concurrent execs: ' + maxLive);
      assert.ok(maxPending <= 50, 'pending: ' + maxPending);
      assert.ok(started <= 100, 'only the accepted cwds reached exec: ' + started);
      // after it drains, new cwds are accepted again
      const before = started;
      const more = reg.noteCwd('C:\\ff1\\after');
      for (let spins = 0; spins < 20 && !gate.length; spins++) await new Promise((r) => setImmediate(r));
      while (gate.length) gate.shift()();
      await more;
      assert.ok(started > before);
    });

    await atest('ff1: an already-cached cwd still answers instantly while the queue is full', async () => {
      let n = 0; const gate = [];
      const exec = (f, a) => {
        n++;
        if (a.includes('--show-toplevel') && n === 1) return Promise.resolve({ stdout: 'C:/ff1c/repo\n' });
        if (a.includes('--git-common-dir') && n === 2) return Promise.resolve({ stdout: 'C:/ff1c/repo/.git\n' });
        return new Promise((res) => { gate.push(() => res({ stdout: '' })); });
      };
      const reg = projects.createRegistry({ exec, file: path.join(mk(), 'projects.json') });
      await reg.noteCwd('C:\\ff1c\\repo');
      assert.strictEqual(reg.list().length, 1);
      for (let i = 0; i < 80; i++) reg.noteCwd('C:\\ff1c\\other' + i);
      assert.strictEqual(reg.pendingCount(), 50);
      await new Promise((r) => setImmediate(r));
      const execBefore = n;
      await reg.noteCwd('C:\\ff1c\\repo');   // cached: resolves although every slot is busy
      assert.strictEqual(n, execBefore, 'no git for a cached cwd');
      while (gate.length) gate.shift()();
    });

    await atest('ff2: an unchanged repo is not re-read: the second poll spawns at most 2 git processes', async () => {
      const d = mkRepo();
      let clock = Date.now();
      const c = counting();
      const p = repos.createPoller({ registry: fake([d]), exec: c.exec, now: () => clock });
      await p.pollNow();
      assert.ok(c.n > 4, 'first poll reads everything: ' + c.n);
      const first = p.snapshot().p0;
      c.n = 0; clock += 1000;
      await p.pollNow();
      assert.ok(c.n <= 2, 'second poll spawned ' + c.n + ': ' + c.args.join(' | '));
      const second = p.snapshot().p0;
      assert.strictEqual(second.defaultBranch, first.defaultBranch);
      assert.strictEqual(second.dirty, false);
      assert.ok(second.polledAt > first.polledAt, 'still stamped as polled');
    });

    await atest('ff2: touching the index, committing, or editing a brief forces a re-check; so does 5 minutes', async () => {
      const d = mkRepo();
      let clock = Date.now();
      const c = counting();
      const p = repos.createPoller({ registry: fake([d]), exec: c.exec, now: () => clock });
      await p.pollNow();
      const settle = async () => { clock += 1000; c.n = 0; await p.pollNow(); const n = c.n; return n; };
      assert.ok(await settle() <= 2);
      // index touched: stage a real new file so the index changes now (never a future mtime)
      fs.writeFileSync(path.join(d, 'staged.txt'), 'staged file one');
      git(d, 'add', 'staged.txt');
      assert.ok(await settle() > 2, 'index mtime change re-reads');
      assert.ok(await settle() <= 2, 'and then it is quiet again');
      // a commit
      const before = p.snapshot().p0.lastCommitAt;
      fs.writeFileSync(path.join(d, 'a.txt'), 'second version, longer');
      git(d, 'commit', '-q', '-a', '-m', 'second');
      assert.ok(await settle() > 2, 'commit re-reads');
      assert.ok(p.snapshot().p0.lastCommitAt >= before);
      assert.ok(await settle() <= 2);
      // a brief file appears
      const dir = path.join(d, '.sereno', 'briefs'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.md'), '---\nbranch: main\nversion: 1\n---\nNow: x\nNext: y\nBlocked: none\n');
      assert.ok(await settle() > 2, 'new brief re-reads');
      assert.ok(await settle() <= 2);
      // dirty tracked file: invisible until the forced full re-check
      fs.writeFileSync(path.join(d, 'a.txt'), 'third version, longer still');
      assert.ok(await settle() <= 2);
      clock += 5 * 60 * 1000;
      c.n = 0; await p.pollNow();
      assert.ok(c.n > 2, 'full re-check after 5 minutes');
      assert.strictEqual(p.snapshot().p0.dirty, true);
    });

    await atest('ff2: tiers: a quiet repo is polled every 5 min, a hot one every 30 s, hidden never', async () => {
      const d = mkRepo(); const h = mkRepo();
      let clock = Date.now() + 3 * 24 * 3600 * 1000;   // the commits are then older than a day
      const c = counting();
      let hot = [];
      const list = [{ id: 'q', name: 'q', repoPath: d, hidden: false }, { id: 'h', name: 'h', repoPath: h, hidden: false },
        { id: 'x', name: 'x', repoPath: mkRepo(), hidden: true }];
      const p = repos.createPoller({ registry: { list: () => list }, exec: c.exec, now: () => clock, hotIds: () => hot });
      await p.tick();
      assert.ok(c.n > 0); assert.ok(!p.snapshot().x, 'hidden never polled');
      c.n = 0; clock += 60 * 1000;
      await p.tick();
      assert.strictEqual(c.n, 0, 'nothing is due after 60 s');
      hot = ['h'];
      clock += 31 * 1000;
      await p.tick();
      const hotCalls = c.n;
      assert.ok(hotCalls > 0 && hotCalls <= 2, 'only the hot repo, and cheaply: ' + hotCalls + ' ' + c.args.join(' | '));
      c.n = 0; clock += 31 * 1000;
      await p.tick();
      assert.ok(c.n > 0 && c.n <= 2, 'hot again 30 s later');
      hot = [];
      c.n = 0; clock += 5 * 60 * 1000;
      await p.tick();
      assert.ok(c.n > 0, 'the quiet repo is due after 5 minutes');
    });

    await atest('ff2: a repo with a commit in the last 24 h is hot without any session', async () => {
      const d = mkRepo();
      let clock = Date.now();
      const c = counting();
      const p = repos.createPoller({ registry: fake([d]), exec: c.exec, now: () => clock });
      await p.tick();
      c.n = 0; clock += 31 * 1000;
      await p.tick();
      assert.ok(c.n > 0, 'recent commit: due at 30 s');
    });

    test('ff3: aggregateDirty is true if any, false only if every worktree is clean, else null', () => {
      const a = repos.aggregateDirty;
      assert.strictEqual(a([{ dirty: true }, { dirty: false }]), true);
      assert.strictEqual(a([{ dirty: null }, { dirty: true }]), true);
      assert.strictEqual(a([{ dirty: false }, { dirty: false }]), false);
      assert.strictEqual(a([{ dirty: false }, { dirty: null }]), null);
      assert.strictEqual(a([{ dirty: null }]), null);
      assert.strictEqual(a([]), null);
    });

    await atest('ff3: a worktree whose status cannot be read leaves the project dirty flag unknown, not clean', async () => {
      const d = mkRepo();
      const wt = path.join(mk(), 'wt');
      git(d, 'worktree', 'add', '-q', '-b', 'side', wt);
      const wtKey = wt.split(path.sep).join('/').toLowerCase();
      const exec = (f, a, o) => {
        if (a.includes('status') && String(o.cwd).split(path.sep).join('/').toLowerCase() === wtKey) return Promise.reject(new Error('boom'));
        return gitExec(f, a, o);
      };
      const p = repos.createPoller({ registry: fake([d]), exec });
      await p.pollNow();
      assert.strictEqual(p.snapshot().p0.dirty, null);
      const q = repos.createPoller({ registry: fake([d]) });
      await q.pollNow();
      assert.strictEqual(q.snapshot().p0.dirty, false);
      fs.writeFileSync(path.join(wt, 'a.txt'), 'changed');
      const r = repos.createPoller({ registry: fake([d]) });
      await r.pollNow();
      assert.strictEqual(r.snapshot().p0.dirty, true);
    });

    test('ff3: the console shows no dirty marker unless dirty is exactly true', () => {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
      assert.ok(/p\.git\.dirty === true/.test(src));
    });

    await atest('ff4: /hook is answered before noteCwd (and so before any git) starts', async () => {
      const order = [];
      const reg = projects.createRegistry({ exec: () => { order.push('exec'); return Promise.resolve({ stdout: '' }); }, file: path.join(mk(), 'projects.json') });
      const real = reg.noteCwd;
      reg.noteCwd = (cwd) => { order.push('noteCwd'); return real(cwd); };
      const c = createCollector(new Store(), 0, { projects: reg });
      await new Promise((res, rej) => c.listen((e) => (e ? rej(e) : res())));
      c.server.on('request', (req, res) => {
        const end = res.end.bind(res);
        res.end = (...a) => { order.push('end'); return end(...a); };
      });
      try {
        const port = c.server.address().port;
        const body = JSON.stringify({ event: 'SessionStart', payload: { hook_event_name: 'SessionStart', session_id: 'ord1', cwd: 'C:\\ff4\\work' } });
        const status = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
          req.on('error', reject); req.end(body);
        });
        assert.strictEqual(status, 204);
        await new Promise((r) => setTimeout(r, 50));
        assert.deepStrictEqual(order.slice(0, 3), ['end', 'noteCwd', 'exec']);
      } finally { await new Promise((res) => { c.server.close(() => res()); c.close(); }); }
    });

    test('ff5: README threat model says filters are blanked for status and submodules are never entered', () => {
      const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
      assert.ok(/blanked for `status`, the only call Sereno makes that can run them/.test(md));
      assert.ok(/submodules are never entered/.test(md));
    });

    test('ff6: branch names with bidi, zero-width, BOM or control characters are rejected', () => {
      const v = briefsLib.validBranchName;
      assert.strictEqual(v('main'), true);
      assert.strictEqual(v('feat/x-1'), true);
      for (const bad of ['main\u{e0061}', 'ma\u2060in', 'main\u061c', 'main\u202e', 'ma\u200bin', 'ma\u200fin', '\u202ablah', 'a\u2066b', 'a\u2069b', '\ufeffmain', 'ma\u0085in', 'ma\u009fin', 'ma\u0007in', 'ma\u007fin']) {
        assert.strictEqual(v(bad), false, JSON.stringify(bad));
      }
    });

    test('final: ZWNJ/ZWJ joiners and non-Latin names stay valid', () => {
      const v = briefsLib.validBranchName;
      for (const ok of ['ویژگی\u200cجدید', 'a\u200db', 'функция', '機能', 'feat-\u{1F680}']) assert.strictEqual(v(ok), true, ok);
    });

    test('final: hotProjectIds ignores empty and non-local cwds, matches repo and worktree roots', () => {
      const projects = [{ id: 'a', repoPath: 'C:\\hot\\repo' }, { id: 'b', repoPath: 'D:\\other' }];
      const snap = { b: { worktrees: [{ path: 'D:\\wt\\b' }] } };
      assert.deepStrictEqual(repos.hotProjectIds(['', '\\\\srv\\share\\x', null, 'relative'], projects, snap), []);
      assert.deepStrictEqual(repos.hotProjectIds(['C:\\hot\\repo\\sub', 'D:\\wt\\b'], projects, snap).sort(), ['a', 'b']);
    });

    await atest('final: runPoll asks for hot ids once per run, not per project', async () => {
      const a = mkRepo(); const b = mkRepo();
      let calls = 0;
      const p = repos.createPoller({ registry: fake([a, b]), hotIds: () => { calls++; return []; } });
      await p.tick(); calls = 0;
      await p.tick();
      assert.ok(calls <= 1, 'hotIds calls: ' + calls);
    });

    await atest('ff6: a worktree on a disguised branch name is shown without a branch', async () => {
      const d = mkRepo();
      const wt = path.join(mk(), 'wt');
      git(d, 'worktree', 'add', '-q', '-b', 'side', wt);
      const exec = async (f, a, o) => {
        const r = await gitExec(f, a, o);
        if (a[0] === 'worktree') return { stdout: r.stdout.replace('refs/heads/side', 'refs/heads/side\u202e') };
        return r;
      };
      const p = repos.createPoller({ registry: fake([d]), exec });
      await p.pollNow();
      const w = p.snapshot().p0.worktrees.find((x) => x.path.toLowerCase().endsWith('wt'));
      assert.ok(w && w.branch === null);
    });

    test('ff7: the suite binds no fixed listen port', () => {
      const src = fs.readFileSync(__filename, 'utf8');
      assert.ok(!/createCollector\([^;]*?,\s*(PORT|port|\d{4,5})\b/.test(src.replace(/test\('ff7[\s\S]*$/, '')), 'every collector in the suite listens on port 0');
    });

    {
      const cj = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'console.js'), 'utf8');
      const names = ['esc', 'projectLabel', 'pillText', 'ringIcon', 'pillHtml', 'attentionState', 'topSessions', 'isLiveSession', 'deriveLiveStates', 'liveDiff', 'withLive',
        'unknownSessionIds', 'hasBlocker', 'visibleProjects', 'projectsSummary'];
      const lifted = names.map((n) => cj.match(new RegExp('function ' + n + '\\([\\s\\S]*?\\n}'))[0]);
      const S = new Function("const LIVE_RANK = ['idle', 'thinking', 'running', 'blocked'];\n" + lifted.join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
      const proj = [{ id: 'pa', name: 'alpha', live: { state: 'idle', sessionIds: ['s1'] } }, { id: 'pb', name: 'beta', live: { state: null, sessionIds: [] } }];
      const blockedSnap = { sessions: [{ id: 's1', state: 'blocked', projectName: 'alpha', stateTool: 'Bash', stateSince: 5 }, { id: 'sub', state: 'blocked', agent_id: 'a1' }] };
      const calmSnap = { sessions: [{ id: 's1', state: 'running', projectName: 'alpha' }] };

      test('final: a pushed blocked snapshot turns the attention state amber, with pill and summary clause, no /api/projects refetch', () => {
        const a = S.attentionState(blockedSnap);
        assert.strictEqual(a.amber, true);
        assert.strictEqual(a.count, 1);
        assert.ok(S.pillHtml(a.count).includes('1 decision needs you'));
        const map = S.deriveLiveStates(proj, blockedSnap.sessions);
        assert.strictEqual(map.pa, 'blocked');
        const live = S.withLive(proj, map);
        assert.strictEqual(live[0].live.state, 'blocked');
        const blocked = S.topSessions(blockedSnap).filter((s) => s.state === 'blocked' && !s.stale).length;
        assert.ok(S.projectsSummary(live, blocked).endsWith('1 session needs you'));
        assert.deepStrictEqual(S.unknownSessionIds(proj, blockedSnap.sessions, new Set()), [], 'no new session, so no refetch');
      });

      test('final: a resolved snapshot returns to calm', () => {
        const a = S.attentionState(calmSnap);
        assert.strictEqual(a.amber, false);
        assert.strictEqual(a.count, 0);
        assert.ok(S.projectsSummary(proj, 0).endsWith('nothing needs a decision'));
        assert.strictEqual(S.deriveLiveStates(proj, calmSnap.sessions).pa, 'running');
      });

      test('final: the live-state diff reports only changed projects; a new session id is reported once', () => {
        const a = S.deriveLiveStates(proj, calmSnap.sessions);
        assert.deepStrictEqual(S.liveDiff(a, S.deriveLiveStates(proj, calmSnap.sessions)), []);
        assert.deepStrictEqual(S.liveDiff(a, S.deriveLiveStates(proj, blockedSnap.sessions)), ['pa']);
        assert.deepStrictEqual(S.deriveLiveStates(proj, [{ id: 's1', state: 'blocked', stale: true }]).pa, null);
        const seen = new Set();
        const withNew = calmSnap.sessions.concat([{ id: 's9', state: 'running' }]);
        assert.deepStrictEqual(S.unknownSessionIds(proj, withNew, seen), ['s9']);
        seen.add('s9');
        assert.deepStrictEqual(S.unknownSessionIds(proj, withNew, seen), []);
      });

      test('final: console.js opens exactly one EventSource(/events) and closes it on pagehide', () => {
        assert.strictEqual((cj.match(/new EventSource\(/g) || []).length, 1);
        assert.match(cj, /new EventSource\('\/events'\)/);
        assert.match(cj, /addEventListener\('pagehide', \(\) => \{ if \(stream\) \{ stream\.close\(\)/);
        const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'console', 'index.html'), 'utf8');
        assert.match(html, /connect-src 'self'/);
      });
    }
  }


  /* ---- Phase 4a step 0: plugin manifests ---- */
  {
    const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    const mj = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const entry = (mj.plugins || [])[0] || {};

    test('plugin manifest: name is sereno, kebab-case, version set', () => {
      assert.strictEqual(pj.name, 'sereno');
      assert.match(pj.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.match(pj.version, /^\d+\.\d+\.\d+$/);
    });
    test('plugin README version sentence equals plugin.json version', () => {
      const readme = fs.readFileSync(path.join(ROOT, 'plugin', 'README.md'), 'utf8');
      const m = readme.match(/Version (\d+\.\d+\.\d+)/);
      assert.ok(m, 'README has a "Version X.Y.Z" sentence');
      assert.strictEqual(m[1], pj.version);
    });
    test('marketplace: required fields and entry matches the plugin manifest', () => {
      assert.strictEqual(mj.name, 'sereno');
      assert.ok(mj.owner && mj.owner.name);
      assert.strictEqual(mj.plugins.length, 1);
      assert.strictEqual(entry.name, pj.name);
      assert.strictEqual(entry.version, pj.version);
    });
    test('marketplace source ./plugin resolves to a dir with .claude-plugin/plugin.json', () => {
      assert.strictEqual(entry.source, './plugin');
      assert.ok(fs.existsSync(path.join(ROOT, entry.source, '.claude-plugin', 'plugin.json')));
    });
    test('plugin/ has no package.json (no dependencies, no install step)', () => {
      assert.ok(!fs.existsSync(path.join(ROOT, 'plugin', 'package.json')));
    });
    test('Electron build files do not include plugin/ or .claude-plugin/ (except the 4b bundled rules)', () => {
      const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).build.files;
      const bundledRules = ['plugin/bin/lib/**/*', 'plugin/agents/*.md'];
      for (const f of files) {
        if (bundledRules.includes(f)) continue;
        assert.ok(!/^!?\.?\/?(plugin|\.claude-plugin)(\/|$)/.test(f) || f.startsWith('!'), 'packages ' + f);
        assert.ok(!/^\*\*/.test(f), 'broad glob ' + f);
      }
    });
    const hasClaude = spawnSync('claude', ['--version'], { shell: true, timeout: 30000 }).status === 0;
    for (const target of ['plugin', '.']) {
      if (!hasClaude) { console.log('  skip claude plugin validate ' + target + ' (claude not on PATH)'); continue; }
      test('claude plugin validate ' + target + ' passes', () => {
        const r = spawnSync('claude', ['plugin', 'validate', target], { cwd: ROOT, shell: true, timeout: 30000, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
      });
    }
  }

  /* ---- Phase 4a step 1: sereno.js core ---- */
  {
    const SERENO = path.join(ROOT, 'plugin', 'bin', 'sereno.js');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4a-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    function mkRepo() {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'task/demo');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
      git(dir, 'commit', '-q', '-am', 'head');
      fs.mkdirSync(path.join(dir, '.sereno', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'specs', 'demo.md'), '# spec\n');
      return { dir, base, head: git(dir, 'rev-parse', 'HEAD'), home: mk() };
    }
    function run(r, args, input) {
      const res = spawnSync(process.execPath, [SERENO, ...args], {
        cwd: r.dir, input, encoding: 'utf8', timeout: 30000,
        env: Object.assign({}, process.env, { HOME: r.home, USERPROFILE: r.home }),
      });
      const raw = res.stdout;
      assert.strictEqual(raw.trim().split('\n').length, 1, 'stdout is one line: ' + raw);
      return { status: res.status, out: JSON.parse(raw), raw, stderr: res.stderr };
    }
    const setCfg = (r, obj) => { fs.mkdirSync(path.join(r.dir, '.sereno'), { recursive: true }); fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), JSON.stringify(obj)); };
    const gateArgs = (r, extra) => ['gate', '--stdin', '--task', 'demo', '--base', r.base, '--head', r.head, '--session', 's-1', '--agent', 'a_1', '--model', 'claude-opus-5-5', '--tests-passed', 'true'].concat(extra || []);
    const readJson = (r, rel) => JSON.parse(fs.readFileSync(path.join(r.dir, rel), 'utf8'));

    test('[4a1] config: built-in default preset, source builtin, hash format', () => {
      const r = mkRepo(); const { status, out } = run(r, ['config', '--json']);
      assert.strictEqual(status, 0); assert.strictEqual(out.ok, true); assert.strictEqual(out.source, 'builtin');
      assert.strictEqual(out.config.preset, 'default');
      assert.strictEqual(out.config.roles.redTeam.agent, 'red-team');
      assert.strictEqual(out.config.roles.redTeam.fallback, 'red-team-lean');
      assert.strictEqual(out.config.roles.builder.options.opus.maxTurns, 120);
      assert.match(out.config_hash, /^sha256:[0-9a-f]{64}$/);
    });
    test('[4a1] config: lean preset expands and roles.* keys override it; unknown keys kept', () => {
      const r = mkRepo();
      setCfg(r, { preset: 'lean', roles: { redTeam: { maxBlockedRuns: 5 } }, futureThing: { x: 1 } });
      const { status, out } = run(r, ['config']);
      assert.strictEqual(status, 0);
      assert.strictEqual(out.config.roles.redTeam.agent, 'red-team-lean');
      assert.strictEqual(out.config.roles.redTeam.fallback, null);
      assert.strictEqual(out.config.roles.redTeam.maxBlockedRuns, 5);
      assert.strictEqual(out.config.roles.builder.default, 'sonnet');
      assert.deepStrictEqual(out.config.futureThing, { x: 1 });
      assert.ok(out.source.endsWith('pipeline.json') && out.source.includes('.sereno'));
    });
    test('[4a1] config: repo file beats ~/.sereno, which beats the built-in default', () => {
      const r = mkRepo();
      fs.mkdirSync(path.join(r.home, '.sereno'));
      fs.writeFileSync(path.join(r.home, '.sereno', 'pipeline.json'), JSON.stringify({ preset: 'lean' }));
      assert.strictEqual(run(r, ['config']).out.config.preset, 'lean');
      setCfg(r, { preset: 'default' });
      assert.strictEqual(run(r, ['config']).out.config.preset, 'default');
    });
    test('[4a1] config: invalid values give config_invalid with every error listed (exit 3)', () => {
      const r = mkRepo();
      setCfg(r, { roles: { builder: { options: { sonnet: { agent: 'evil', maxTurns: -1 } } }, redTeam: { onFallback: 'sometimes', maxBlockedRuns: 1.5 } } });
      const { status, out } = run(r, ['config']);
      assert.strictEqual(status, 3); assert.strictEqual(out.ok, false); assert.strictEqual(out.code, 'config_invalid');
      assert.ok(out.errors.length >= 4, JSON.stringify(out.errors));
      assert.ok(out.errors.some((e) => /sonnet\.agent/.test(e)) && out.errors.some((e) => /onFallback/.test(e)));
      setCfg(r, { preset: 'nope' }); assert.strictEqual(run(r, ['config']).out.code, 'config_invalid');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), '{ not json');
      assert.strictEqual(run(r, ['config']).out.code, 'config_invalid');
    });
    test('[4a1] config_hash is stable across key order and changes with content', () => {
      const a = mkRepo(), b = mkRepo(), c = mkRepo();
      setCfg(a, { recovery: { repairs: 1, infraRetries: 3 }, preset: 'lean' });
      setCfg(b, { preset: 'lean', recovery: { infraRetries: 3, repairs: 1 } });
      setCfg(c, { preset: 'lean', recovery: { infraRetries: 4, repairs: 1 } });
      const h = (r) => run(r, ['config']).out.config_hash;
      assert.strictEqual(h(a), h(b)); assert.notStrictEqual(h(a), h(c));
    });
    test('[4a1] run-id: rr_<UTC stamp>_<7 hex>; bad sha is refused', () => {
      const r = mkRepo(); const { status, out } = run(r, ['run-id', '--head', r.head]);
      assert.strictEqual(status, 0);
      assert.match(out.review_run_id, /^rr_\d{8}T\d{6}Z_[0-9a-f]{7}$/);
      assert.ok(out.review_run_id.endsWith('_' + r.head.slice(0, 7)));
      const bad = run(r, ['run-id', '--head', 'zzz']); assert.strictEqual(bad.out.ok, false); assert.notStrictEqual(bad.status, 0);
    });
    test('[4a1] gate: file has exactly the schema keys and the right values', () => {
      const r = mkRepo();
      const verdict = { outcome: 'needs-context', evil: 'x', findings: [{ severity: 'high', kind: 'bug', file: 'a.txt', line: 3, summary: 'x', extra: 1 }], context_requests: ['a.txt'] };
      const { status, out } = run(r, gateArgs(r), JSON.stringify(verdict));
      assert.strictEqual(status, 0); assert.strictEqual(out.ok, true);
      const gate = readJson(r, out.path);
      assert.deepStrictEqual(Object.keys(gate), ['review_run_id', 'task_id', 'spec', 'spec_hash', 'branch', 'base_commit', 'head_commit', 'session_id', 'agent_id', 'model', 'outcome', 'tests_passed', 'findings', 'context_requests', 'reviewed_at', 'config_hash']);
      assert.strictEqual(out.path, '.sereno/gates/' + gate.review_run_id + '.json');
      assert.strictEqual(gate.outcome, 'needs_context'); assert.strictEqual(gate.tests_passed, true);
      assert.strictEqual(gate.base_commit, r.base); assert.strictEqual(gate.head_commit, r.head);
      assert.strictEqual(gate.branch, 'task/demo'); assert.strictEqual(gate.spec, '.sereno/specs/demo.md');
      assert.match(gate.spec_hash, /^sha256:[0-9a-f]{64}$/); assert.match(gate.config_hash, /^sha256:[0-9a-f]{64}$/);
      assert.ok(!isNaN(Date.parse(gate.reviewed_at)) && gate.reviewed_at.endsWith('Z'));
      assert.deepStrictEqual(gate.findings, [{ severity: 'high', kind: 'bug', file: 'a.txt', line: 3, summary: 'x' }]);
      assert.deepStrictEqual(gate.context_requests, ['a.txt']);
      assert.deepStrictEqual(fs.readdirSync(path.join(r.dir, '.sereno', 'gates')), [path.basename(out.path)], 'no tmp file left behind');
    });
    test('[4a1] gate: unknown enums become "unknown"; --file works and unwraps a fenced block', () => {
      const r = mkRepo();
      const RID = 'rr_20260101T000000Z_' + r.head.slice(0, 7);
      fs.mkdirSync(path.join(r.dir, '.sereno', 'cache'), { recursive: true });
      const vf = '.sereno/cache/verdict-' + RID + '.json';
      fs.writeFileSync(path.join(r.dir, vf), '```json\n' + JSON.stringify({ outcome: 'maybe', findings: [{ severity: 'catastrophic', kind: 7, file: 'a.txt', line: 'x', summary: 's' }] }) + '\n```');
      const { out } = run(r, gateArgs(r).filter((x) => x !== '--stdin').concat(['--file', vf, '--run-id', RID]));
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      assert.ok(!fs.existsSync(path.join(r.dir, vf)));
      const gate = readJson(r, out.path);
      assert.strictEqual(gate.outcome, 'unknown'); assert.strictEqual(gate.findings[0].severity, 'unknown');
      assert.strictEqual(gate.findings[0].kind, 'unknown'); assert.strictEqual(gate.findings[0].line, null);
    });
    test('[4a1] gate: findings capped at 50, summaries stripped and capped, outside paths dropped', () => {
      const r = mkRepo();
      const many = [];
      for (let i = 0; i < 60; i++) many[many.length] = { severity: 'low', kind: 'style', file: 'a.txt', line: i + 1, summary: 'n' + i };
      many[0] = { severity: 'high', kind: 'bug', file: 'a.txt', line: 1, summary: 'ev\u202eil\u0007 \u200bt\nx' + 'y'.repeat(500) };
      many[1] = { severity: 'low', kind: 'k', file: '../../etc/passwd', line: 4, summary: 'up' };
      many[2] = { severity: 'low', kind: 'k', file: 'C:\\Windows\\win.ini', line: 4, summary: 'abs' };
      many[3] = { severity: 'low', kind: 'k', file: '/etc/passwd', line: 4, summary: 'abs2' };
      many[4] = { severity: 'low', kind: 'k', file: 'src\\..\\..\\x', line: 4, summary: 'sneaky' };
      many[5] = { severity: 'low', kind: 'k', file: 'src\\sub\\f.js', line: 0, summary: 'ok-win-path' };
      const { out } = run(r, gateArgs(r), JSON.stringify({ outcome: 'block', findings: many, context_requests: ['a.txt', '../secret', '/abs'] }));
      const gate = readJson(r, out.path);
      assert.strictEqual(gate.findings.length, 50);
      assert.ok(gate.findings[0].summary.length <= 300);
      assert.ok(!/[\u202e\u0007\u200b\n]/.test(gate.findings[0].summary), JSON.stringify(gate.findings[0].summary));
      for (const i of [1, 2, 3, 4]) { assert.strictEqual(gate.findings[i].file, null); assert.strictEqual(gate.findings[i].line, null); }
      assert.strictEqual(gate.findings[5].file, 'src/sub/f.js'); assert.strictEqual(gate.findings[5].line, null);
      assert.deepStrictEqual(gate.context_requests, ['a.txt']);
    });
    test('[4a1] gate: bad inputs fail cleanly (option-shaped ref, bad JSON, missing input, unknown flag)', () => {
      const r = mkRepo();
      const nc = run(r, ['gate', '--stdin', '--task', 'demo', '--base', '--upload-pack=x', '--head', r.head], '{}');
      assert.strictEqual(nc.out.ok, false); assert.notStrictEqual(nc.status, 0);
      const nc2 = run(r, ['gate', '--stdin', '--task', 'demo', '--base=--output=x', '--head', r.head], '{}');
      assert.strictEqual(nc2.out.code, 'invalid_arg');
      assert.strictEqual(run(r, gateArgs(r), 'not json').out.code, 'invalid_arg');
      assert.strictEqual(run(r, ['gate', '--task', 'demo']).out.code, 'usage');
      assert.strictEqual(run(r, ['gate', '--stdin', '--bogus', '1']).out.code, 'usage');
      assert.strictEqual(run(r, ['nope']).out.code, 'usage');
    });
    test('[4a1] attempt: numbers continue from the highest existing; exact keys; enums fall back to unknown', () => {
      const r = mkRepo();
      const args = ['attempt', '--task', 'demo', '--project', 'p1', '--builder', 'sonnet', '--agent', 'ag_1', '--kind', 'telepathy', '--diagnosis', 'defect', '--outcome', 'pass', '--started-at', '2026-10-13T10:00:00Z'];
      assert.strictEqual(run(r, args).out.attempt, 1);
      assert.strictEqual(run(r, args).out.attempt, 2);
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'demo-7.json'), '{}');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'demo-9-x.json'), '{}');
      const third = run(r, args.concat(['--fixes', 'earlier', '--review-run-id', 'rr_20261013T100000Z_abcdef0']));
      assert.strictEqual(third.out.attempt, 8); assert.strictEqual(third.out.path, '.sereno/attempts/demo-8.json');
      const a = readJson(r, third.out.path);
      assert.deepStrictEqual(Object.keys(a), ['project_id', 'task_id', 'spec_revision', 'attempt', 'builder_requested', 'agent_id', 'config_hash', 'kind', 'fixes', 'diagnosis', 'outcome', 'review_run_id', 'started_at', 'ended_at']);
      assert.strictEqual(a.kind, 'unknown'); assert.strictEqual(a.builder_requested, 'sonnet'); assert.strictEqual(a.diagnosis, 'defect');
      assert.strictEqual(a.attempt, 8); assert.strictEqual(a.spec_revision, 1); assert.strictEqual(a.fixes, 'earlier');
      assert.strictEqual(a.started_at, '2026-10-13T10:00:00.000Z'); assert.strictEqual(a.ended_at, null);
      assert.match(a.config_hash, /^sha256:[0-9a-f]{64}$/);
      git(r.dir, 'checkout', '-q', '-b', 'task/other'); // --task must match the task/<x> branch (round 4)
      const other = run(r, ['attempt', '--task', 'other', '--builder', 'gpt']);
      assert.strictEqual(other.out.attempt, 1); assert.strictEqual(readJson(r, other.out.path).builder_requested, 'unknown');
    });
    test('[4a1] paths: prints the .sereno layout', () => {
      const r = mkRepo(); const { out } = run(r, ['paths']);
      assert.strictEqual(out.ok, true); assert.strictEqual(out.layout.gates, '.sereno/gates/<review_run_id>.json');
      assert.strictEqual(path.resolve(out.repo_root).toLowerCase(), path.resolve(r.dir).toLowerCase());
    });
    test('[4a1] writers refuse task names that are paths (path_refused, exit 6)', () => {
      const r = mkRepo();
      for (const t of ['../x', '..\\x', '/abs/x', 'C:\\x', 'a/b']) {
        const att = run(r, ['attempt', '--task', t]);
        assert.strictEqual(att.status, 6, t); assert.strictEqual(att.out.code, 'path_refused');
        assert.strictEqual(run(r, gateArgs(r).map((x) => (x === 'demo' ? t : x)), '{}').out.code, 'path_refused');
      }
      const sp = run(r, gateArgs(r, ['--spec', '../outside.md']), '{}');
      assert.strictEqual(sp.status, 6); assert.strictEqual(sp.out.code, 'path_refused');
      // A shared path (the temp dir's own x) may exist from another process: compare before/after, never absence.
      assert.deepStrictEqual(fs.readdirSync(r.dir).sort(), ['.sereno', 'a.txt'].concat(fs.existsSync(path.join(r.dir, '.git')) ? ['.git'] : []).sort());
      assert.deepStrictEqual(fs.readdirSync(r.home), []);
    });
    test('[4a1] fsafe: only paths under .sereno/ are writable', () => {
      const { createSafeFs } = require('../plugin/bin/lib/fsafe.js');
      const r = mkRepo(); const f = createSafeFs(r.dir);
      for (const p of ['../x', '..\\x', path.join(r.dir, 'abs.txt'), '/etc/x', 'C:/x', 'a.txt', 'src/x.js', '.sereno', '.sereno/../a.txt', '.sereno/gates/../../a.txt', '.sereno//x', '.sereno/a:b', '.sereno/x.', '']) {
        assert.throws(() => f.writeFile(p, 'x'), (e) => e.code === 'path_refused', JSON.stringify(p));
      }
      assert.strictEqual(fs.readFileSync(path.join(r.dir, 'a.txt'), 'utf8'), 'two\n');
      f.writeJson('.sereno/gates/ok.json', { a: 1 });
      assert.deepStrictEqual(readJson(r, '.sereno/gates/ok.json'), { a: 1 });
    });
    test('[4a1] fsafe: a symlinked or junctioned .sereno (or subdir) is refused, nothing escapes (exit 6)', () => {
      const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
      const r = mkRepo(); const outside = mk();
      fs.rmSync(path.join(r.dir, '.sereno'), { recursive: true });
      link(outside, path.join(r.dir, '.sereno'));
      const a = run(r, ['attempt', '--task', 'demo']);
      assert.strictEqual(a.status, 6); assert.strictEqual(a.out.code, 'path_refused');
      assert.strictEqual(run(r, gateArgs(r), '{}').out.ok, false);
      assert.deepStrictEqual(fs.readdirSync(outside), []);
      const r2 = mkRepo(); const outside2 = mk();
      link(outside2, path.join(r2.dir, '.sereno', 'attempts'));
      const b = run(r2, ['attempt', '--task', 'demo']);
      assert.strictEqual(b.status, 6); assert.strictEqual(b.out.code, 'path_refused');
      assert.deepStrictEqual(fs.readdirSync(outside2), []);
    });
    test('[4a1] not inside a git repo: writers fail with not_a_repo, config still works', () => {
      const r = { dir: mk(), home: mk() };
      const a = run(r, ['attempt', '--task', 'demo']);
      assert.strictEqual(a.status, 5); assert.strictEqual(a.out.code, 'not_a_repo');
      assert.strictEqual(run(r, ['config']).out.ok, true);
    });
    test('[4a1] plugin/ contains no "push" anywhere (the plugin never pushes)', () => {
      const hits = [];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/push/i.test(fs.readFileSync(p, 'utf8')) || /push/i.test(e.name)) hits[hits.length] = path.relative(ROOT, p);
        }
      })(path.join(ROOT, 'plugin'));
      assert.deepStrictEqual(hits, []);
    });
    test('[4a1] plugin/bin requires only node: built-ins and its own ./ modules', () => {
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          if (!p.endsWith('.js')) continue;
          for (const m of fs.readFileSync(p, 'utf8').matchAll(/require\('([^']+)'\)/g)) {
            assert.ok(m[1].startsWith('node:') || (m[1].startsWith('./') && !m[1].includes('..')), p + ' requires ' + m[1]);
          }
        }
      })(path.join(ROOT, 'plugin', 'bin'));
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a step 2: sereno.js test ---- */
  {
    const SERENO = path.join(ROOT, 'plugin', 'bin', 'sereno.js');
    const testrun = require('../plugin/bin/lib/testrun.js');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4a2-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    // t.js: a tiny TAP test script driven by spec.json (committed, so base and head can differ).
    const T_JS = [
      "const fs=require('fs');",
      "const s=JSON.parse(fs.readFileSync('spec.json','utf8'));",
      "const inBase=process.cwd().includes('sereno-base-');",
      "if(s.cwdlog) fs.appendFileSync(s.cwdlog, process.cwd()+'\\n');",
      "if(s.req) require(s.req);",
      "if(s.sleep){ fs.writeFileSync(s.sleep+(inBase?'.b':'.h'), String(process.pid)); setInterval(()=>{},1000); }",
      "else {",
      "if(s.crash) throw new Error('boom');",
      "let hang=false; const fails=(s.fails||[]).slice();",
      "if(s.flaky && !inBase){ let n=0; try{n=+fs.readFileSync(s.flaky.counter,'utf8')}catch(e){} fs.writeFileSync(s.flaky.counter,String(n+1)); if(n===0) fails.push(s.flaky.name); if(n>=1 && s.sleepOnSecond){ fs.writeFileSync(s.sleepOnSecond+'.h', String(process.pid)); hang=true; setInterval(()=>{},1000); } }",
      "const all=(s.tests||[]).concat(s.flaky?[s.flaky.name]:[]);",
      "if(!s.quiet){ console.log('TAP version 13'); all.forEach((t,i)=>console.log((fails.includes(t)?'not ok ':'ok ')+(i+1)+' - '+t)); if(s.plan) console.log('1..'+all.length); }",
      "if(!hang) process.exit(fails.length?2:0);",
      "}",
    ].join('\n');
    function mkSuite(baseSpec, headSpec, cfg) {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'task/demo');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't');
      git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 't.js'), T_JS);
      fs.writeFileSync(path.join(dir, 'setup.js'), "const fs=require('fs');const s=JSON.parse(fs.readFileSync('spec.json','utf8'));if(s.setuplog)fs.appendFileSync(s.setuplog,process.cwd()+'|');process.exit(s.setupFail?1:0);");
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(baseSpec));
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(headSpec));
      git(dir, 'commit', '-q', '-am', 'head');
      fs.mkdirSync(path.join(dir, '.sereno'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: Object.assign({ command: 'node t.js' }, cfg || {}) }));
      return { dir, base, head: git(dir, 'rev-parse', 'HEAD'), home: mk() };
    }
    function runT(r, extra, headArg) {
      const res = spawnSync(process.execPath, [SERENO, 'test', '--base', r.base, '--head', headArg || r.head, '--json'].concat(extra || []), {
        cwd: r.dir, encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, { HOME: r.home, USERPROFILE: r.home }),
      });
      assert.strictEqual(res.stdout.trim().split('\n').length, 1, 'stdout is one line: ' + res.stdout);
      return { status: res.status, out: JSON.parse(res.stdout), stderr: res.stderr };
    }
    const wtCount = (r) => git(r.dir, 'worktree', 'list').split('\n').filter(Boolean).length;
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_e) { return false; } };

    test('[4a2] test: a failure already failing at base is not counted (exit criterion 2)', () => {
      const r = mkSuite({ tests: ['A', 'C'], fails: ['A'], plan: true }, { tests: ['A', 'C'], fails: ['A'], plan: true });
      const { status, out } = runT(r);
      assert.strictEqual(status, 0); assert.strictEqual(out.ok, true);
      assert.strictEqual(out.passed, true); assert.strictEqual(out.mode, 'names');
      assert.deepStrictEqual(out.baseFailures, ['A']); assert.deepStrictEqual(out.newFailures, []);
      assert.deepStrictEqual(out.flaky, []); assert.strictEqual(out.diagnosis, 'none');
      assert.strictEqual(out.baseCached, false); assert.strictEqual(out.timedOut, false);
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: a newly failing test is a defect; logs are stored, stdout carries no test output', () => {
      const r = mkSuite({ tests: ['A', 'B'], fails: ['A'] }, { tests: ['A', 'B'], fails: ['A', 'B'] });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'defect');
      assert.deepStrictEqual(out.newFailures, ['B']); assert.deepStrictEqual(out.baseFailures, ['A']);
      assert.ok(/^\.sereno\/cache\/test-rr_\d{8}T\d{6}Z_[0-9a-f]{7}\.log$/.test(out.log), out.log);
      const log = fs.readFileSync(path.join(r.dir, out.log), 'utf8');
      assert.ok(log.includes('not ok 2 - B') && log.includes('===== head'));
      assert.ok(!JSON.stringify(out).includes('TAP version'));
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: a flaky head failure goes to flaky[] and is not counted', () => {
      const counter = path.join(mk(), 'count.txt');
      const spec = { tests: ['A'], flaky: { name: 'F', counter } };
      const r = mkSuite(spec, spec);
      const { out } = runT(r);
      assert.strictEqual(out.passed, true); assert.deepStrictEqual(out.flaky, ['F']);
      assert.deepStrictEqual(out.newFailures, []); assert.strictEqual(out.diagnosis, 'none');
      assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2');
    });
    test('[4a2] test: exit-code mode when names are not parseable (head fails, base passes = defect)', () => {
      const r = mkSuite({ quiet: true, tests: ['A'] }, { quiet: true, tests: ['A'], fails: ['A'] });
      const { out } = runT(r);
      assert.strictEqual(out.mode, 'exit-code'); assert.strictEqual(out.passed, false);
      assert.strictEqual(out.diagnosis, 'defect'); assert.strictEqual(out.baseFailing, false);
    });
    test('[4a2] test: exit-code mode with both failing is unknown_baseline, never a silent pass', () => {
      const r = mkSuite({ crash: true }, { crash: true });
      const { out } = runT(r);
      assert.strictEqual(out.mode, 'exit-code'); assert.strictEqual(out.passed, false);
      assert.strictEqual(out.baseFailing, true); assert.ok(/base too/.test(out.note));
      assert.strictEqual(out.diagnosis, 'unknown_baseline'); assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: a base that crashed (no results) while head reports failures does not excuse them', () => {
      const r = mkSuite({ crash: true }, { tests: ['A'], fails: ['A'] });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'environment');
      assert.strictEqual(out.note, 'baseline could not run'); assert.strictEqual(out.baseUsable, false);
      assert.deepStrictEqual(out.baseFailures, []);
      assert.ok(!fs.existsSync(path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json')), 'unusable baseline is not cached');
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: the repo node_modules is linked into the base worktree and left intact afterwards', () => {
      const cwdlog = path.join(mk(), 'cwd.log');
      const spec = { tests: ['A'], req: 'fakemod', cwdlog };
      const r = mkSuite(spec, spec);
      const nm = path.join(r.dir, 'node_modules', 'fakemod');
      fs.mkdirSync(nm, { recursive: true });
      fs.writeFileSync(path.join(nm, 'index.js'), 'module.exports = 1;');
      const { out } = runT(r);
      assert.strictEqual(out.passed, true); assert.strictEqual(out.baseUsable, true);
      assert.strictEqual(out.exit_codes.base, 0, 'base found the module through the link');
      const lines = fs.readFileSync(cwdlog, 'utf8').split(/\r?\n/).filter(Boolean);
      assert.ok(lines[0].includes('sereno-base-') && lines[0].toLowerCase() !== r.dir.toLowerCase());
      assert.strictEqual(fs.readFileSync(path.join(nm, 'index.js'), 'utf8'), 'module.exports = 1;', 'real node_modules intact');
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: tests.setup runs in the base worktree; a failing setup is an environment failure', () => {
      const setuplog = path.join(mk(), 'setup.log');
      const spec = { tests: ['A'], setuplog };
      const r = mkSuite(spec, spec, { setup: 'node setup.js' });
      assert.strictEqual(runT(r).out.passed, true);
      const dirs = fs.readFileSync(setuplog, 'utf8').split('|').filter(Boolean);
      assert.strictEqual(dirs.length, 1); assert.ok(dirs[0].includes('sereno-base-'));
      const bad = mkSuite({ tests: ['A'], setupFail: true }, { tests: ['A'], fails: ['A'] }, { setup: 'node setup.js' });
      const { out } = runT(bad);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'environment');
      assert.strictEqual(wtCount(bad), 1);
    });
    test('[4a2] test: timeout kills the process tree, reports environment, and removes the worktree', () => {
      const pidBase = path.join(mk(), 'pid');
      const r = mkSuite({ sleep: pidBase }, { sleep: pidBase }, { timeoutSec: 1 });
      const { status, out } = runT(r);
      assert.strictEqual(status, 0); assert.strictEqual(out.passed, false);
      assert.strictEqual(out.timedOut, true); assert.strictEqual(out.diagnosis, 'environment');
      for (const suffix of ['.b', '.h']) {
        const pid = parseInt(fs.readFileSync(pidBase + suffix, 'utf8'), 10);
        assert.ok(pid > 0 && !alive(pid), 'suite process ' + suffix + ' was killed');
      }
      assert.strictEqual(wtCount(r), 1);
      assert.ok(!fs.existsSync(path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json')), 'an environment failure is not cached');
    });
    test('[4a2] test: --deadline-sec stops the run, kills the suite, leaves no worktree, base cache or sereno-base dir', () => {
      const pidBase = path.join(mk(), 'pid');
      const r = mkSuite({ sleep: pidBase }, { sleep: pidBase });
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sereno-base-'));
      const { status, out } = runT(r, ['--deadline-sec', '2']);
      assert.strictEqual(status, 20); assert.strictEqual(out.ok, false);
      assert.strictEqual(out.status, 'deadline'); assert.strictEqual(out.code, 'deadline'); assert.strictEqual(out.passed, false);
      const pid = parseInt(fs.readFileSync(pidBase + '.b', 'utf8'), 10);
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
      assert.ok(pid > 0 && gone, 'suite process was killed');
      assert.strictEqual(wtCount(r), 1);
      assert.ok(!fs.existsSync(path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json')), 'no base cache');
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sereno-base-') && !before.includes(n));
      assert.deepStrictEqual(after, [], 'no leftover sereno-base dir');
      assert.strictEqual(runT(r, ['--deadline-sec', '0']).out.code, 'invalid_arg');
      assert.ok(!('diagnosis' in out), 'a deadline result carries no diagnosis');
    });
    test('[4a2] test: --deadline-sec value check: 540 and 60 accepted, 5dd refused', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] });
      for (const v of ['540', '60']) { const x = runT(r, ['--deadline-sec', v]); assert.strictEqual(x.out.ok, true, v + ' ' + JSON.stringify(x.out)); assert.strictEqual(x.status, 0); }
      const bad = runT(r, ['--deadline-sec', '5dd']);
      assert.strictEqual(bad.out.code, 'invalid_arg');
    });
    const deadlineAt = (label, mkR, sleepName, expectCache) => test('[4a2] test: deadline during ' + label + ' leaves no live pid, no worktree, one stdout line', () => {
      const pidBase = path.join(mk(), 'pid');
      const r = mkR(pidBase);
      const { status, out } = runT(r, ['--deadline-sec', '3']);
      assert.strictEqual(status, 20); assert.strictEqual(out.status, 'deadline'); assert.ok(!('diagnosis' in out));
      const pid = parseInt(fs.readFileSync(pidBase + sleepName, 'utf8'), 10);
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid); if (!gone) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); }
      assert.ok(pid > 0 && gone, 'suite process was killed');
      assert.strictEqual(wtCount(r), 1);
      assert.strictEqual(fs.existsSync(path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json')), expectCache);
    });
    deadlineAt('the head suite (base cache kept)', (pb) => mkSuite({ tests: ['A'], plan: true }, { sleep: pb }), '.h', true);
    deadlineAt('the flaky re-run (base cache kept)', (pb) => {
      const counter = path.join(mk(), 'n');
      // head run 1 fails a new test, then the re-run hangs
      return mkSuite({ tests: ['A'], plan: true }, { tests: ['A'], plan: true, flaky: { counter, name: 'F' }, sleepOnSecond: pb });
    }, '.h', true);
    test('[4a2] test: a missing test command is an environment failure, not a defect', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] }, { command: 'sereno-no-such-command-xyz' });
      const { status, out } = runT(r);
      assert.strictEqual(status, 0); assert.strictEqual(out.ok, true);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'environment');
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: no tests.command and no package.json test script gives no_test_command', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] });
      fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), '{}');
      const { status, out } = runT(r);
      assert.strictEqual(out.ok, false); assert.strictEqual(out.code, 'no_test_command'); assert.notStrictEqual(status, 0);
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: falls back to npm test when package.json has a test script', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] });
      fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), '{}');
      fs.writeFileSync(path.join(r.dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node t.js' } }));
      git(r.dir, 'add', 'package.json'); git(r.dir, 'commit', '-q', '-m', 'pkg');
      const head = git(r.dir, 'rev-parse', 'HEAD');
      const { out } = runT(Object.assign({}, r, { head }));
      assert.strictEqual(out.ok, true, JSON.stringify(out)); assert.strictEqual(out.command, 'npm test');
      assert.strictEqual(out.passed, true);
    });
    test('[4a2] test: base runs in its own worktree (never the working copy); cached base is reused without a new worktree', () => {
      const cwdlog = path.join(mk(), 'cwd.log');
      const spec = { tests: ['A'], cwdlog };
      const r = mkSuite(spec, spec);
      const first = runT(r).out;
      assert.strictEqual(first.baseCached, false);
      let lines = fs.readFileSync(cwdlog, 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 2);
      assert.notStrictEqual(lines[0].toLowerCase(), r.dir.toLowerCase(), 'base suite did not run in the repo');
      assert.ok(lines[0].includes('sereno-base-') && !lines[0].toLowerCase().startsWith(r.dir.toLowerCase()));
      assert.strictEqual(lines[1].toLowerCase(), r.dir.toLowerCase(), 'head suite ran in the working tree');
      const cache = path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json');
      assert.ok(fs.existsSync(cache));
      const second = runT(r).out;
      assert.strictEqual(second.baseCached, true); assert.strictEqual(second.passed, true);
      lines = fs.readFileSync(cwdlog, 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 3, 'only the head suite ran the second time');
      assert.strictEqual(wtCount(r), 1);
      // a different test command invalidates the cache
      fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'node t.js ' } }));
      assert.strictEqual(runT(r).out.baseCached, false);
    });
    test('[4a2] test: parallel runs base and head, and a dirty tracked tree or wrong --head is head_mismatch', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] }, { parallel: true });
      assert.strictEqual(runT(r).out.passed, true);
      const bad = runT(r, [], r.base);
      assert.strictEqual(bad.out.ok, false); assert.strictEqual(bad.out.code, 'head_mismatch');
      fs.writeFileSync(path.join(r.dir, 'a.txt'), 'dirty\n');
      const dirty = runT(r);
      assert.strictEqual(dirty.out.code, 'head_mismatch'); assert.notStrictEqual(dirty.status, 0);
      fs.writeFileSync(path.join(r.dir, 'untracked.txt'), 'x');
      git(r.dir, 'checkout', '--', 'a.txt');
      assert.strictEqual(runT(r).out.ok, true, 'untracked files do not block');
      assert.strictEqual(wtCount(r), 1);
    });
    test('[4a2] test: tests.parallel and tests.timeoutSec are validated', () => {
      const r = mkSuite({ tests: ['A'] }, { tests: ['A'] }, { parallel: 'yes', timeoutSec: 0 });
      const { out } = runT(r);
      assert.strictEqual(out.code, 'config_invalid'); assert.strictEqual(out.errors.length, 2);
    });
    test('[4a2] test: parseFailures reads TAP, FAIL, cross marks, mocha lines and ANSI-coloured output', () => {
      const out = [
        'TAP version 13', 'ok 1 - fine', 'not ok 2 - tap one', 'not ok 3 - skipped # SKIP later',
        '  FAIL repo own format', 'FAIL jest/file.test.js', '✗ cross one', '✕ cross two',
        '  1) mocha suite test', '\u001b[31mnot ok 9 - coloured\u001b[0m', 'FAILED is not a match', 'not ok 2 - tap one',
      ].join('\n');
      assert.deepStrictEqual(testrun.parseFailures(out), ['tap one', 'repo own format', 'jest/file.test.js', 'cross one', 'cross two', 'mocha suite test', 'coloured']);
      assert.deepStrictEqual(testrun.parseFailures('all good\n'), []);
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a step 3: agents and skills ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4a3-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const runS = (cwd, args, input) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: input || '', encoding: 'utf8' });
      return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
    };
    // Minimal front matter reader: key: value lines between the first two --- fences.
    const front = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      assert.ok(m, file + ' has front matter');
      const fm = {};
      for (const line of m[1].split(/\r?\n/)) { const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(line); assert.ok(k, 'front matter line: ' + line); fm[k[1]] = k[2].trim(); }
      return { fm, body: text.slice(m[0].length) };
    };
    const agentFiles = fs.readdirSync(path.join(PLUGIN, 'agents')).filter((f) => f.endsWith('.md'));
    const skillDirs = fs.readdirSync(path.join(PLUGIN, 'skills'));
    const AGENT_SPEC = {
      'builder': { model: 'claude-sonnet-5-5', maxTurns: '80' },
      'builder-haiku': { model: 'claude-haiku-4-5-20251001', maxTurns: '40' },
      'builder-opus': { model: 'claude-opus-5-5', maxTurns: '120' },
      'red-team': { model: 'claude-fable-5-1' },
      'red-team-lean': { model: 'claude-opus-5-5' },
      'scribe': { model: 'claude-haiku-4-5-20251001' },
    };
    const IGNORED_KEYS = ['permissionMode', 'hooks', 'mcpServers'];
    const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const subcommands = (() => {
      const r = spawnSync(process.execPath, [SERENO, 'no-such-command'], { encoding: 'utf8' });
      const m = /<([a-z|-]+)>/.exec(JSON.parse(r.stdout).error);
      assert.ok(m); return m[1].split('|');
    })();

    test('[4a3] agents: exactly the six expected, with the fixed models and turn caps', () => {
      assert.deepStrictEqual(agentFiles.map((f) => f.replace(/\.md$/, '')).sort(), Object.keys(AGENT_SPEC).sort());
      for (const f of agentFiles) {
        const name = f.replace(/\.md$/, '');
        const { fm, body } = front(path.join(PLUGIN, 'agents', f));
        assert.strictEqual(fm.name, name);
        assert.ok(fm.description && fm.description.length > 20, name + ' description');
        assert.strictEqual(fm.model, AGENT_SPEC[name].model, name + ' model');
        if (AGENT_SPEC[name].maxTurns) assert.strictEqual(fm.maxTurns, AGENT_SPEC[name].maxTurns, name + ' maxTurns');
        else assert.ok(/^[1-9]\d*$/.test(fm.maxTurns), name + ' has a maxTurns');
        for (const k of IGNORED_KEYS) assert.ok(!(k in fm), name + ' must not set ' + k + ' (plugin agents ignore it)');
        assert.ok(body.trim().length > 200, name + ' has a real prompt');
      }
    });
    test('[4a3] agents: red teams are read-only; builders never edit .sereno or send commits out', () => {
      for (const name of ['red-team', 'red-team-lean']) {
        const { fm, body } = front(path.join(PLUGIN, 'agents', name + '.md'));
        assert.deepStrictEqual(list(fm.tools), ['Read', 'Grep', 'Glob', 'Bash']);
        for (const t of ['Write', 'Edit', 'NotebookEdit']) assert.ok(list(fm.disallowedTools).includes(t), name + ' disallows ' + t);
        assert.ok(!list(fm.tools).some((t) => /^(Write|Edit|NotebookEdit)/.test(t)));
        for (const key of ['"outcome"', 'needs_context', 'context_requests', '```json', 'Insufficient context is never a pass']) assert.ok(body.includes(key), name + ' mentions ' + key);
      }
      for (const name of ['builder', 'builder-haiku', 'builder-opus']) {
        const { body } = front(path.join(PLUGIN, 'agents', name + '.md'));
        assert.ok(/Never edit `\.sereno\/`/.test(body) && /remote/.test(body) && /\.sereno\/specs\/<task>\.md/.test(body), name);
        assert.ok(/findings/.test(body), name + ' handles repair findings');
      }
      const scribe = front(path.join(PLUGIN, 'agents', 'scribe.md'));
      assert.ok(scribe.body.includes('sereno.js') && scribe.body.includes('`brief`'));
    });
    test('[4a3] skills: name matches dir, description present, task and build are user-only', () => {
      assert.ok(skillDirs.includes('task') && skillDirs.includes('build'));
      for (const d of skillDirs) {
        const { fm } = front(path.join(PLUGIN, 'skills', d, 'SKILL.md'));
        assert.strictEqual(fm.name, d);
        assert.ok(fm.description && fm.description.length > 10, d + ' description');
        if (d === 'task' || d === 'build') assert.strictEqual(fm['disable-model-invocation'], 'true', d);
        assert.ok('argument-hint' in fm, d + ' argument-hint');
      }
    });
    test('[4a3] skills: reference only existing agents and sereno.js subcommands; no npm, npx or shell plugin-root variable', () => {
      const agents = new Set(agentFiles.map((f) => f.replace(/\.md$/, '')));
      for (const d of skillDirs) {
        const { body } = front(path.join(PLUGIN, 'skills', d, 'SKILL.md'));
        for (const m of body.matchAll(/`sereno:([a-z][a-z-]*)`/g)) assert.ok(agents.has(m[1]), d + ' references unknown agent sereno:' + m[1]);
        for (const m of body.matchAll(/\/sereno:([a-z][a-z-]*)/g)) assert.ok(skillDirs.includes(m[1]) || ['ship', 'brief'].includes(m[1]), d + ' references unknown skill /sereno:' + m[1]);
        const calls = [...body.matchAll(/sereno\.js"? +([A-Za-z-]+)/g)].map((m) => m[1]);
        assert.ok(calls.length > 0, d + ' calls sereno.js');
        for (const c of calls) assert.ok(subcommands.includes(c), d + ' calls unknown subcommand ' + c);
        for (const m of body.matchAll(/^.*sereno\.js.*$/gm)) assert.ok(m[0].includes('node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js"'), d + ': ' + m[0]);
        assert.ok(!/\bnpm\b|\bnpx\b/.test(body), d + ' uses npm/npx');
        assert.ok(!/\$CLAUDE_PLUGIN_ROOT|\$env:CLAUDE_PLUGIN_ROOT|%CLAUDE_PLUGIN_ROOT%/.test(body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '')), d + ' uses a shell plugin-root variable');
        // The gate's --model records which model reviewed; it is not an Agent parameter.
        assert.ok(!/--model\b/.test(body.replace(/^.*sereno\.js" gate .*$/gm, '')), d + ' must not pass a model');
      }
      const build = front(path.join(PLUGIN, 'skills', 'build', 'SKILL.md')).body;
      for (const a of ['sereno:builder', 'sereno:builder-haiku', 'sereno:builder-opus']) assert.ok(build.includes('`' + a + '`'));
      assert.ok(/attempt --task/.test(build) && /--outcome running/.test(build) && /--outcome <built\|error>/.test(build));
      const task = front(path.join(PLUGIN, 'skills', 'task', 'SKILL.md')).body;
      assert.ok(/spec --task/.test(task) && /branch --task/.test(task) && /--body-file/.test(task) && /authentication/.test(task));
    });
    test('[4a3] plugin: no git push anywhere under plugin/', () => {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const f of walk(PLUGIN)) {
        if (!/\.(md|js|json)$/.test(f)) continue;
        assert.ok(!/\bgit\b[^\n]{0,40}\bpush\b|'push'/.test(fs.readFileSync(f, 'utf8')), f + ' mentions git push');
      }
    });
    test('[4a3] spec + branch round trip: revision bump, hash, branch created, dirty and bad names refused', () => {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const body = '## Goal\nDo the thing.\n\n## Acceptance criteria\n- it works\n';
      const spec = (task, extra, input) => runS(dir, ['spec', '--task', task, '--builder', 'sonnet', '--kind', 'feature', '--reason', 'ordinary feature work', '--stdin', ...(extra || [])], input === undefined ? body : input);

      const first = spec('demo');
      assert.strictEqual(first.status, 0); assert.strictEqual(first.out.ok, true);
      assert.strictEqual(first.out.path, '.sereno/specs/demo.md'); assert.strictEqual(first.out.spec_revision, 1);
      const file = path.join(dir, '.sereno', 'specs', 'demo.md');
      assert.strictEqual(first.out.spec_hash, 'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
      const { fm, body: written } = front(file);
      assert.strictEqual(fm.task, '"demo"'); assert.strictEqual(fm.builder, 'sonnet'); assert.strictEqual(fm.kind, 'feature');
      assert.strictEqual(fm.reason, '"ordinary feature work"'); assert.strictEqual(fm.fixes, 'null'); assert.strictEqual(fm.spec_revision, '1');
      assert.ok(!isNaN(Date.parse(JSON.parse(fm.created_at))));
      assert.strictEqual(written, body);

      const second = spec('demo', ['--fixes', 'earlier'], body + '- more\n');
      assert.strictEqual(second.out.spec_revision, 2); assert.notStrictEqual(second.out.spec_hash, first.out.spec_hash);
      assert.strictEqual(front(file).fm.fixes, '"earlier"');
      // Free text cannot break the front matter.
      const inj = runS(dir, ['spec', '--task', 'inj', '--builder', 'haiku', '--kind', 'fix', '--reason', 'x\n---\nbuilder: opus', '--stdin'], body);
      assert.strictEqual(inj.out.ok, true);
      assert.strictEqual(front(path.join(dir, '.sereno', 'specs', 'inj.md')).fm.builder, 'haiku');

      // Validation.
      assert.strictEqual(runS(dir, ['spec', '--task', 'v', '--builder', 'gpt', '--kind', 'fix', '--reason', 'r', '--stdin'], body).out.code, 'invalid_arg');
      assert.strictEqual(runS(dir, ['spec', '--task', 'v', '--builder', 'haiku', '--kind', 'oops', '--reason', 'r', '--stdin'], body).out.code, 'invalid_arg');
      assert.strictEqual(runS(dir, ['spec', '--task', 'v', '--builder', 'haiku', '--kind', 'fix', '--stdin'], body).out.code, 'invalid_arg');
      assert.strictEqual(spec('v', [], '  \n').out.code, 'invalid_arg');
      assert.strictEqual(runS(dir, ['spec', '--task', 'v', '--builder', 'haiku', '--kind', 'fix', '--reason', 'r'], body).out.code, 'usage');
      assert.strictEqual(spec('../evil').out.ok, false);
      assert.ok(!fs.existsSync(path.join(dir, '.sereno', 'specs', 'v.md')));

      // Branch: created at HEAD without switching; untracked .sereno files do not count as dirty.
      const head = git(dir, 'rev-parse', 'HEAD');
      const br = runS(dir, ['branch', '--task', 'demo']);
      assert.strictEqual(br.status, 0, JSON.stringify(br.out));
      assert.strictEqual(br.out.branch, 'task/demo'); assert.strictEqual(br.out.base_commit, head);
      assert.strictEqual(git(dir, 'rev-parse', 'task/demo'), head); assert.strictEqual(git(dir, 'branch', '--show-current'), 'main');
      const again = runS(dir, ['branch', '--task', 'demo']);
      assert.strictEqual(again.out.code, 'exists'); assert.notStrictEqual(again.status, 0);
      for (const bad of ['..', 'a/b', '-x', 'x.lock', 'a..b', '.hid', 'sp ace', 'a:b', 'x.']) {
        const r = runS(dir, ['branch', '--task', bad]);
        assert.strictEqual(r.out.ok, false, 'refused ' + bad); assert.notStrictEqual(r.status, 0);
      }
      assert.strictEqual(git(dir, 'branch', '--list', 'task/*').split('\n').length, 1);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
      const dirty = runS(dir, ['branch', '--task', 'other']);
      assert.strictEqual(dirty.out.code, 'dirty_tree'); assert.notStrictEqual(dirty.status, 0);
      assert.strictEqual(git(dir, 'branch', '--list', 'task/other'), '');
      assert.strictEqual(runS(dir, ['branch']).out.ok, false);
    });
    test('[4a3] spec.validBranchName agrees with the app copy', () => {
      const mine = require('../plugin/bin/lib/spec.js').validBranchName, app = require('../src/briefs.js').validBranchName;
      for (const n of ['task/a', 'feat/x-1', '', '-a', 'a b', 'a..b', 'a.lock', 'a/.b', '@', 'a@{1}', 'a​b', 'a‮b', 'a‍b', 'x/', 'a\\b', 'a~1']) assert.strictEqual(mine(n), app(n), JSON.stringify(n));
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a step 4: ship ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const recoveryLib = require('../plugin/bin/lib/recovery.js');
    const { loadConfig } = require('../plugin/bin/lib/config.js');
    const { spawnSync } = require('node:child_process');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4a4-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const home = mk();
    const runS = (cwd, args, input) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: input || '', encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'one line of stdout: ' + r.stdout);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    const initRepo = (branch) => {
      const dir = mk();
      git(dir, 'init', '-q', '-b', branch || 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      return dir;
    };
    const RR = (n) => 'rr_20261013T00000' + n + 'Z_abcdef' + n;
    const readAttempt = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, '.sereno', 'attempts', 'demo-' + n + '.json'), 'utf8'));

    /* recovery helper: table-driven over hand-written attempt and gate files */
    const A = (outcome, diagnosis, extra) => Object.assign({ outcome, diagnosis: diagnosis || 'none', review_run_id: null }, extra || {});
    const gateFile = (id, outcome, findings) => ({ review_run_id: id, task_id: 'demo', branch: 'task/demo', outcome, tests_passed: true, findings: findings || [] });
    const F = (kind, severity) => ({ severity: severity || 'high', kind, file: 'a.js', line: 1, summary: 'x' });
    function decide(attempts, gates, cfgOver) {
      const dir = mk();
      fs.mkdirSync(path.join(dir, '.sereno', 'attempts'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.sereno', 'gates'), { recursive: true });
      attempts.forEach((a, i) => fs.writeFileSync(path.join(dir, '.sereno', 'attempts', 'demo-' + (i + 1) + '.json'), JSON.stringify(a)));
      for (const [id, g] of Object.entries(gates || {})) fs.writeFileSync(path.join(dir, '.sereno', 'gates', id + '.json'), JSON.stringify(g));
      const config = loadConfig(null).config;
      if (cfgOver) cfgOver(config);
      return recoveryLib.decide({ root: dir, task: 'demo', config, listAttempts: () => fs.readdirSync(path.join(dir, '.sereno', 'attempts')) });
    }
    const BLOCK_DEFECT = [A('block', 'defect', { review_run_id: RR(1) })];
    const G_DEFECT = { [RR(1)]: gateFile(RR(1), 'block', [F('defect')]) };
    const TABLE = [
      ['built attempt is reviewed', [A('built')], {}, null, 'review', 0, 0],
      ['environment failure retries, repair untouched', [A('error', 'environment')], {}, null, 'retry', 0, 0],
      ['second environment failure still retries', [A('error', 'environment'), A('error', 'environment')], {}, null, 'retry', 0, 1],
      ['infraRetries used up goes to decide', [A('error', 'environment'), A('error', 'environment'), A('error', 'environment')], {}, null, 'decide', 0, 2],
      ['infraRetries 0 never retries', [A('error', 'environment')], {}, (c) => { c.recovery.infraRetries = 0; }, 'decide', 0, 0],
      ['first test defect repairs', [A('block', 'defect')], {}, null, 'repair', 0, 0],
      ['first gate block on a defect repairs', BLOCK_DEFECT, G_DEFECT, null, 'repair', 0, 0],
      ['security finding is a defect', [A('block', 'defect', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'block', [F('security')]) }, null, 'repair', 0, 0],
      ['second defect goes to decide', [A('block', 'defect'), A('block', 'defect', { review_run_id: RR(1) })], G_DEFECT, null, 'decide', 1, 0],
      ['a third defect is still decide, never another repair', [A('block', 'defect'), A('block', 'defect'), A('block', 'defect')], {}, null, 'decide', 2, 0],
      ['environment failure during the repair retries without a second repair', [A('block', 'defect'), A('error', 'environment')], {}, null, 'retry', 1, 0],
      ['defect, env failure, defect: the repair was used', [A('block', 'defect'), A('error', 'environment'), A('block', 'defect')], {}, null, 'decide', 1, 1],
      ['repairs 0 never repairs', [A('block', 'defect')], {}, (c) => { c.recovery.repairs = 0; }, 'decide', 0, 0],
      ['gate block of kind spec (spec violation) repairs', [A('block', 'defect', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'block', [F('spec')]) }, null, 'repair', 0, 0],
      ['second spec-violation block goes to decide', [A('block', 'defect', { review_run_id: RR(1) }), A('block', 'defect', { review_run_id: RR(2) })], { [RR(1)]: gateFile(RR(1), 'block', [F('spec')]), [RR(2)]: gateFile(RR(2), 'block', [F('spec-violation')]) }, null, 'decide', 1, 0],
      ['gate block of an unknown kind goes to decide', [A('block', 'spec', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'block', [F('vibes')]) }, null, 'decide', 0, 0],
      ['gate block with only low defect findings goes to decide', [A('block', 'defect', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'block', [F('defect', 'low')]) }, null, 'decide', 0, 0],
      ['maxBlockedRuns 1 caps the first block', BLOCK_DEFECT, G_DEFECT, (c) => { c.roles.redTeam.maxBlockedRuns = 1; }, 'decide', 0, 0],
      ['needs_context goes to decide', [A('needs_context')], {}, null, 'decide', 0, 0],
      ['unknown baseline (needs_context, no review) goes to decide', [A('needs_context', 'none')], {}, null, 'decide', 0, 0],
      ['error that is not environment (turn cap, review error) goes to decide', [A('error', 'none')], {}, null, 'decide', 0, 0],
      ['a running attempt goes to decide', [A('running')], {}, null, 'decide', 0, 0],
      ['pass with a passing gate merges', [A('pass', 'none', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'pass') }, null, 'merge', 0, 0],
      ['pass without a gate record does not merge', [A('pass', 'none', { review_run_id: RR(1) })], {}, null, 'decide', 0, 0],
      ['pass whose gate says block does not merge', [A('pass', 'none', { review_run_id: RR(1) })], { [RR(1)]: gateFile(RR(1), 'block', [F('defect')]) }, null, 'decide', 0, 0],
      ['repair then pass merges', [A('block', 'defect'), A('pass', 'none', { review_run_id: RR(2) })], { [RR(2)]: gateFile(RR(2), 'pass') }, null, 'merge', 1, 0],
      ['gate disabled: skipped with a recorded head merges', [A('skipped', 'none', { head_commit: 'c'.repeat(40) })], {}, (c) => { c.roles.redTeam.enabled = false; }, 'merge', 0, 0],
      ['skipped while the red team is enabled does not merge', [A('skipped')], {}, null, 'decide', 0, 0],
      ['stopped is done', [A('stopped')], {}, null, 'done', 0, 0],
    ];
    for (const [name, attempts, gates, cfg, next, repairs, infra] of TABLE) {
      test('[4a4] recovery: ' + name, () => {
        const r = decide(attempts, gates, cfg);
        assert.strictEqual(r.next, next, JSON.stringify(r));
        assert.strictEqual(r.repairsUsed, repairs); assert.strictEqual(r.infraRetriesUsed, infra);
        assert.ok(typeof r.reason === 'string' && r.reason.length > 5);
      });
    }
    test('[4a4] recovery CLI: JSON shape, no attempts is not_found, a bad task is refused', () => {
      const dir = initRepo();
      const none = runS(dir, ['recovery', '--task', 'demo']);
      assert.strictEqual(none.out.code, 'not_found'); assert.notStrictEqual(none.status, 0);
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running']).out.ok, true);
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'built', '--ended-at', 'now']).out.ok, true);
      const r = runS(dir, ['recovery', '--task', 'demo']);
      assert.strictEqual(r.status, 0);
      assert.deepStrictEqual(Object.keys(r.out).sort(), ['attempt', 'gate_enabled', 'infraRetriesUsed', 'next', 'ok', 'reason', 'repairsUsed']);
      assert.strictEqual(r.out.next, 'review');
      assert.strictEqual(runS(dir, ['recovery', '--task', '../x']).out.ok, false);
    });

    /* attempt update mode */
    test('[4a4] attempt --update merges fields into one record; final records are refused', () => {
      const dir = initRepo();
      const first = runS(dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--spec-revision', '3', '--outcome', 'running', '--started-at', '2026-10-13T10:00:00Z']);
      assert.strictEqual(first.out.attempt, 1);
      const before = readAttempt(dir, 1);
      assert.strictEqual(before.outcome, 'running'); assert.strictEqual(before.ended_at, null);
      const built = runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'built', '--ended-at', 'now']);
      assert.strictEqual(built.status, 0, JSON.stringify(built.out)); assert.strictEqual(built.out.outcome, 'built');
      const mid = readAttempt(dir, 1);
      assert.strictEqual(mid.outcome, 'built'); assert.ok(!isNaN(Date.parse(mid.ended_at)));
      for (const k of ['project_id', 'task_id', 'spec_revision', 'attempt', 'builder_requested', 'agent_id', 'config_hash', 'kind', 'fixes', 'started_at']) assert.deepStrictEqual(mid[k], before[k], k + ' unchanged');
      assert.strictEqual(fs.readdirSync(path.join(dir, '.sereno', 'attempts')).length, 1, 'one attempt = one record');
      const fin = runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'pass', '--diagnosis', 'none', '--review-run-id', RR(1), '--ended-at', '2026-10-13T11:00:00Z']);
      assert.strictEqual(fin.status, 0); assert.strictEqual(fin.out.diagnosis, 'none');
      const done = readAttempt(dir, 1);
      assert.strictEqual(done.outcome, 'pass'); assert.strictEqual(done.review_run_id, RR(1)); assert.strictEqual(done.ended_at, '2026-10-13T11:00:00.000Z');
      for (const o of ['pass', 'block', 'needs_context', 'error', 'skipped', 'stopped']) {
        const r = initRepo();
        runS(r, ['attempt', '--task', 'demo', '--outcome', o]);
        const u = runS(r, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'built']);
        assert.strictEqual(u.out.code, 'record_final', o); assert.notStrictEqual(u.status, 0);
        assert.strictEqual(readAttempt(r, 1).outcome, o);
      }
      const bad = (args) => runS(dir, ['attempt', '--task', 'demo', ...args]);
      assert.strictEqual(bad(['--update', '9', '--outcome', 'built']).out.code, 'not_found');
      assert.strictEqual(bad(['--update', 'x']).out.code, 'invalid_arg');
      const d2 = initRepo(); runS(d2, ['attempt', '--task', 'demo', '--outcome', 'running']);
      const up = (args) => runS(d2, ['attempt', '--task', 'demo', '--update', '1', ...args]);
      assert.strictEqual(up(['--outcome', 'weird']).out.code, 'invalid_arg');
      assert.strictEqual(up(['--diagnosis', 'weird']).out.code, 'invalid_arg');
      assert.strictEqual(up(['--review-run-id', 'nope']).out.code, 'invalid_arg');
      assert.strictEqual(up(['--builder', 'opus']).out.code, 'usage');
      assert.strictEqual(up(['--ended-at', 'yesterday-ish']).out.code, 'invalid_arg');
      assert.strictEqual(readAttempt(d2, 1).outcome, 'running');
    });
    test('[4a4] attempt: built is a valid outcome at creation too', () => {
      const dir = initRepo();
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--outcome', 'built']).out.ok, true);
      assert.strictEqual(readAttempt(dir, 1).outcome, 'built');
    });

    /* spec base_branch */
    test('[4a4] spec records base_branch and keeps it across revisions', () => {
      const dir = initRepo('main');
      fs.writeFileSync(path.join(dir, 'a.txt'), '1\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const body = '## Goal\nx\n';
      const spec = (extra) => runS(dir, ['spec', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--stdin', ...(extra || [])], body);
      const br = runS(dir, ['branch', '--task', 'demo']);
      assert.strictEqual(br.out.from_branch, 'main');
      assert.strictEqual(spec(['--base-branch', br.out.from_branch]).out.ok, true);
      const text = () => fs.readFileSync(path.join(dir, '.sereno', 'specs', 'demo.md'), 'utf8');
      assert.ok(/^base_branch: "main"$/m.test(text()));
      assert.strictEqual(spec().out.spec_revision, 2);
      assert.ok(/^base_branch: "main"$/m.test(text()), 'kept on revision');
      assert.strictEqual(spec(['--base-branch=--evil']).out.code, 'invalid_arg');
      assert.ok(/^base_branch: "main"$/m.test(text()));
      assert.strictEqual(runS(dir, ['spec', '--task', 'other', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--stdin'], body).out.ok, true);
      assert.ok(/^base_branch: null$/m.test(fs.readFileSync(path.join(dir, '.sereno', 'specs', 'other.md'), 'utf8')));
    });

    /* context */
    test('[4a4] context: reads from git at head, caps sizes, flags binary and truncation', () => {
      const dir = initRepo();
      fs.writeFileSync(path.join(dir, 'small.txt'), 'hello\n');
      fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(40 * 1024));
      fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
      fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'ünï.js'), 'ok\n');
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one');
      const head = git(dir, 'rev-parse', 'HEAD');
      const r = runS(dir, ['context', '--head', head, 'small.txt', 'big.txt', 'bin.dat', 'src/ünï.js', 'nope.txt']);
      assert.strictEqual(r.status, 0, JSON.stringify(r.out));
      const by = Object.fromEntries(r.out.files.map((f) => [f.path, f]));
      assert.deepStrictEqual(by['small.txt'], { path: 'small.txt', content: 'hello\n', truncated: false });
      assert.strictEqual(by['big.txt'].content.length, 32 * 1024); assert.strictEqual(by['big.txt'].truncated, true);
      assert.deepStrictEqual(by['bin.dat'], { path: 'bin.dat', content: null, truncated: false });
      assert.strictEqual(by['src/ünï.js'].content, 'ok\n');
      assert.deepStrictEqual(r.out.missing, ['nope.txt']);
      assert.strictEqual(runS(dir, ['context', 'small.txt', '--head', head]).out.files[0].content, 'hello\n', 'flags may follow the files');
      fs.writeFileSync(path.join(dir, 'small.txt'), 'edited\n');
      assert.strictEqual(runS(dir, ['context', '--head', head, 'small.txt']).out.files[0].content, 'hello\n', 'the file as committed');
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), String(i).repeat(40 * 1024));
      git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'two');
      const h2 = git(dir, 'rev-parse', 'HEAD');
      const t = runS(dir, ['context', '--head', h2, 'f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
      const total = t.out.files.reduce((n, f) => n + (f.content ? Buffer.byteLength(f.content) : 0), 0);
      assert.ok(total <= 96 * 1024, 'total ' + total);
      assert.strictEqual(t.out.files.length, 5);
      assert.strictEqual(t.out.files[3].content, null); assert.strictEqual(t.out.files[3].truncated, true);
    });
    test('[4a4] context: refusals', () => {
      const dir = initRepo();
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one');
      const head = git(dir, 'rev-parse', 'HEAD');
      for (const bad of ['/etc/passwd', 'C:\\Windows\\win.ini', '../a.txt', 'src/../../a.txt', '..', '.', 'a\u0001b', '\\\\server\\share\\x']) {
        const r = runS(dir, ['context', '--head', head, bad]);
        assert.strictEqual(r.out.ok, false, JSON.stringify(bad)); assert.strictEqual(r.out.code, 'path_refused', JSON.stringify(bad)); assert.notStrictEqual(r.status, 0);
      }
      assert.strictEqual(runS(dir, ['context', '--head', head, 'a', 'b', 'c', 'd', 'e', 'f']).out.code, 'invalid_arg', 'more than five files');
      assert.strictEqual(runS(dir, ['context', '--head', head]).out.code, 'usage');
      assert.strictEqual(runS(dir, ['context', 'a.txt']).out.code, 'invalid_arg');
      assert.strictEqual(runS(dir, ['context', '--head', '--evil', 'a.txt']).out.ok, false);
      assert.strictEqual(runS(dir, ['context', '--head', 'deadbeef', 'a.txt']).out.code, 'invalid_arg');
      assert.strictEqual(runS(mk(), ['context', '--head', head, 'a.txt']).out.code, 'not_a_repo');
    });
    test('[4a4] context: a symlink in the worktree pointing outside is not followed; a committed symlink is not read', () => {
      const dir = initRepo();
      const outside = path.join(mk(), 'secret.txt');
      fs.writeFileSync(outside, 'TOP-SECRET\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'one');
      const head = git(dir, 'rev-parse', 'HEAD');
      let linked = true;
      fs.rmSync(path.join(dir, 'a.txt'));
      try { fs.symlinkSync(outside, path.join(dir, 'a.txt')); } catch (_e) { linked = false; }
      if (!linked) { console.log('  skip worktree symlink part (cannot create symlinks here)'); fs.writeFileSync(path.join(dir, 'a.txt'), 'committed\n'); }
      const r = runS(dir, ['context', '--head', head, 'a.txt']);
      assert.strictEqual(r.out.files[0].content, 'committed\n');
      assert.ok(!JSON.stringify(r.out).includes('TOP-SECRET'));
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: outside, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', '120000,' + blob + ',link.txt'], { cwd: dir });
      git(dir, 'commit', '-q', '-m', 'two');
      const s = runS(dir, ['context', '--head', git(dir, 'rev-parse', 'HEAD'), 'link.txt']);
      assert.deepStrictEqual(s.out.files, []); assert.deepStrictEqual(s.out.missing, ['link.txt']);
    });

    /* the skill text */
    const SHIP = fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8');
    const SHIP1 = SHIP.replace(/\s+/g, ' ');
    test('[4a4] ship skill: front matter, subcommands in order, decision label, no push, asks before merging', () => {
      const fmm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(SHIP);
      assert.ok(fmm && /^name: ship$/m.test(fmm[1]) && /^disable-model-invocation: true$/m.test(fmm[1]) && /^argument-hint:/m.test(fmm[1]));
      const order = [];
      for (const m of SHIP.matchAll(/sereno\.js" ([a-z-]+)/g)) if (!order.includes(m[1])) order[order.length] = m[1];
      assert.deepStrictEqual(order, ['clean', 'config', 'test', 'attempt', 'run-id', 'context', 'paths', 'gate', 'brief', 'recovery']);
      const at = (s) => SHIP.indexOf(s);
      const seq = ['bin/sereno.js" test --task', 'bin/sereno.js" run-id --head', 'bin/sereno.js" context --head', 'bin/sereno.js" gate --file', '--review-run-id <review_run_id> --diagnosis', 'bin/sereno.js" recovery --task', '## 6. Merge prompt'];
      for (let i = 1; i < seq.length; i++) assert.ok(at(seq[i - 1]) >= 0 && at(seq[i]) > at(seq[i - 1]), seq[i] + ' after ' + seq[i - 1]);
      assert.ok(SHIP.includes('Review needs a decision'));
      for (const s of ['clarify the spec', 'stronger Builder', 'stop']) assert.ok(SHIP.includes(s), s);
      assert.ok(!/push/i.test(SHIP), 'no push');
      assert.ok(/Run `\/sereno:merge <task>` to merge `task\/<task>` into `<base_branch>`/.test(SHIP1) && /never merge/.test(SHIP1));
      assert.ok(/git merge-base task\/<task> <base_branch>/.test(SHIP));
      assert.ok(/roles.redTeam.fallback/.test(SHIP) && /onFallback/.test(SHIP) && /One round only/.test(SHIP));
      assert.ok(/--tests-passed true/.test(SHIP) && /--run-id <review_run_id>/.test(SHIP));
      assert.ok(/pass no `model`\s+parameter/.test(SHIP1.replace('`model` parameter', '`model` parameter')) || /pass no `model` parameter/.test(SHIP1));
      assert.ok(/SAME Builder/.test(SHIP) && /never change which Builder is used by yourself/.test(SHIP1));
    });
    test('[4a4] ship skill: spawns the red team by configured agent name only', () => {
      const names = [...SHIP.matchAll(/`sereno:([^`]*)`/g)].map((m) => m[1]);
      for (const n of names) assert.ok(['red-team-lean', 'scribe', ''].includes(n), 'only the fallback and the scribe are named: ' + n);
      assert.ok(/`sereno:` plus `roles\.redTeam\.agent`/.test(SHIP1));
      assert.ok(!/sereno:red-team`/.test(SHIP) && !/sereno:builder/.test(SHIP), 'no hard-coded red team or builder');
      assert.ok(!/\bnpm\b|\bnpx\b/.test(SHIP));
    });
    test('[4a4] build skill: running record before the Builder, then update to built or error', () => {
      const B = fs.readFileSync(path.join(PLUGIN, 'skills', 'build', 'SKILL.md'), 'utf8');
      const run = B.indexOf('--outcome running'), spawn = B.indexOf('## 4. Spawn the Builder'), upd = B.indexOf('--update <attempt> --outcome <built|error>');
      assert.ok(run > 0 && spawn > run && upd > spawn, 'running, then spawn, then update');
      assert.ok(/--diagnosis environment/.test(B) && /StopFailure/.test(B));
    });

    /* ---- cheaper orchestration: skill models, /sereno:merge, recovery head and spec guards ---- */
    const fmOf = (name) => { const t = fs.readFileSync(path.join(PLUGIN, 'skills', name, 'SKILL.md'), 'utf8'); const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(t); assert.ok(m, name); return { fm: m[1], text: t }; };
    test('[4a-cost] every orchestration skill runs on Sonnet', () => {
      for (const n of ['task', 'build', 'ship', 'brief', 'merge']) assert.ok(/^model: claude-sonnet-5-5$/m.test(fmOf(n).fm), n);
    });
    test('[4a-cost] merge skill: user-only, scribe is the only agent, recovery before git merge, ship never merges', () => {
      const { fm, text } = fmOf('merge');
      assert.ok(/^name: merge$/m.test(fm) && /^disable-model-invocation: true$/m.test(fm));
      const tools = (/^allowed-tools: (.*)$/m.exec(fm) || [])[1] || '';
      assert.deepStrictEqual(tools.split(',').map((x) => x.trim()), ['Bash', 'Read', 'Agent(sereno:scribe)']);
      const rIdx = text.indexOf('sereno.js" recovery --task'), cIdx = text.indexOf('sereno.js" clean');
      assert.ok(rIdx > 0 && rIdx < text.indexOf('git merge --no-ff'));
      assert.ok(text.includes(`git merge --no-ff -m "Merge branch 'task/<task>'" <head_commit>`) && !/git merge --no-ff task\//.test(text), 'merges the reviewed sha');
      assert.ok(text.indexOf('git rev-parse refs/heads/task/<task>') > cIdx && text.indexOf('git rev-parse refs/heads/task/<task>') < text.indexOf('git merge --no-ff'), 'tip re-checked right before the merge');
      assert.ok(/head_moved[^\n]*\/sereno:build <task>/.test(text) && /spec_changed[^\n]*\/sereno:task <task>/.test(text) && /\/sereno:ship <task>/.test(text));
      assert.ok(cIdx > rIdx && cIdx < text.indexOf('git switch <base_branch>'));
      assert.ok(/git merge --abort/.test(text) && /## How to run commands/.test(text) && !/push/i.test(text));
      for (const n of [...text.matchAll(/`sereno:([^`]*)`/g)].map((m) => m[1])) assert.strictEqual(n, 'scribe');
      assert.ok(!/git merge(?!-base)/.test(SHIP), 'ship never runs git merge');
    });
    {
      const SPEC1 = 'sha256:' + '1'.repeat(64), TIP = 'a'.repeat(40);
      const G = (over) => Object.assign({ review_run_id: RR(1), task_id: 'demo', branch: 'task/demo', outcome: 'pass', tests_passed: true, findings: [], head_commit: TIP, spec_hash: SPEC1 }, over || {});
      const guarded = (attempts, gates, cfg, tip, spec) => {
        const dir = mk();
        fs.mkdirSync(path.join(dir, '.sereno', 'attempts'), { recursive: true }); fs.mkdirSync(path.join(dir, '.sereno', 'gates'), { recursive: true });
        attempts.forEach((a, i) => fs.writeFileSync(path.join(dir, '.sereno', 'attempts', 'demo-' + (i + 1) + '.json'), JSON.stringify(a)));
        for (const [id, g] of Object.entries(gates || {})) fs.writeFileSync(path.join(dir, '.sereno', 'gates', id + '.json'), JSON.stringify(g));
        const config = loadConfig(null).config; if (cfg) cfg(config);
        return recoveryLib.decide({ root: dir, task: 'demo', config, listAttempts: () => fs.readdirSync(path.join(dir, '.sereno', 'attempts')), currentHead: () => tip, currentSpecHash: () => spec });
      };
      const PASS = [A('pass', 'none', { review_run_id: RR(1) })];
      test('[4a-cost] recovery: head moved after the gate goes back to review', () => {
        const r = guarded(PASS, { [RR(1)]: G() }, null, 'b'.repeat(40), SPEC1);
        assert.strictEqual(r.next, 'review'); assert.ok(/^head_moved/.test(r.reason));
      });
      test('[4a-cost] recovery: spec changed after the gate goes to decide', () => {
        const r = guarded(PASS, { [RR(1)]: G() }, null, TIP, 'sha256:' + '2'.repeat(64));
        assert.strictEqual(r.next, 'decide'); assert.ok(/^spec_changed/.test(r.reason));
      });
      test('[4a-cost] recovery: head and spec both match still merges', () => {
        assert.strictEqual(guarded(PASS, { [RR(1)]: G() }, null, TIP, SPEC1).next, 'merge');
      });
      test('[4a-cost] recovery: a missing branch tip, spec or gate field never merges', () => {
        assert.strictEqual(guarded(PASS, { [RR(1)]: G() }, null, null, SPEC1).next, 'review');
        assert.strictEqual(guarded(PASS, { [RR(1)]: G() }, null, TIP, null).next, 'decide');
        assert.strictEqual(guarded(PASS, { [RR(1)]: G({ head_commit: undefined }) }, null, TIP, SPEC1).next, 'review');
      });
      test('[4a-cost] recovery: skipped gate needs the recorded head and the spec pin', () => {
        const off = (c) => { c.roles.redTeam.enabled = false; };
        const pin = 'sha256:' + '3'.repeat(64), B = 'b'.repeat(40);
        const sk = (extra) => [A('skipped', 'none', Object.assign({ spec_hash: pin, head_commit: B }, extra || {}))];
        const ok = guarded(sk(), {}, off, B, pin);
        assert.strictEqual(ok.next, 'merge'); assert.strictEqual(ok.head_commit, B);
        let r = guarded(sk(), {}, off, 'd'.repeat(40), pin);
        assert.strictEqual(r.next, 'review'); assert.ok(/^head_moved/.test(r.reason));
        r = guarded(sk(), {}, off, B, 'sha256:' + '4'.repeat(64));
        assert.strictEqual(r.next, 'decide'); assert.ok(/^spec_changed/.test(r.reason));
        r = guarded([A('skipped', 'none', { spec_hash: pin })], {}, off, B, pin);
        assert.strictEqual(r.next, 'decide'); assert.ok(/^head_unknown/.test(r.reason), 'a skipped attempt without a head fails closed');
      });
      test('[4a-cost] recovery: merge output carries head_commit and base_commit; a gate from another task or branch never merges', () => {
        const r = guarded(PASS, { [RR(1)]: G({ base_commit: 'e'.repeat(40) }) }, null, TIP, SPEC1);
        assert.strictEqual(r.next, 'merge'); assert.strictEqual(r.head_commit, TIP); assert.strictEqual(r.base_commit, 'e'.repeat(40));
        assert.strictEqual(guarded(PASS, { [RR(1)]: G({ task_id: 'other' }) }, null, TIP, SPEC1).next, 'decide');
        assert.strictEqual(guarded(PASS, { [RR(1)]: G({ branch: 'task/other' }) }, null, TIP, SPEC1).next, 'decide');
      });
      test('[4a-cost] attempt --update --head records the tested commit for skipped only', () => {
        const dir = initRepo('main');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'c');
        const head = git(dir, 'rev-parse', 'HEAD');
        runS(dir, ['attempt', '--task', 'demo', '--outcome', 'running']);
        assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--outcome', 'running', '--head', head]).out.code, 'usage');
        assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--head', head]).out.code, 'usage', 'not while the outcome is not skipped');
        assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'skipped', '--head', 'zzz']).out.ok, false);
        assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'skipped', '--diagnosis', 'none', '--head', head.slice(0, 10), '--ended-at', 'now']).out.ok, true);
        assert.strictEqual(readAttempt(dir, 1).head_commit, head, 'stored as 40 hex');
      });
      test('[4a-cost] ship, build, merge, task and brief run everything in the foreground', () => {
        for (const n of ['ship', 'build', 'merge', 'task', 'brief']) {
          const t = fmOf(n).text.replace(/\s+/g, ' ');
          assert.ok(/in the foreground and wait for it in this turn/.test(t) && /Never use `run_in_background`/.test(t) && /`timeout` of 600000/.test(t), n);
        }
        assert.strictEqual((fmOf('ship').text.match(/run_in_background: true/g) || []).length, 1, 'ship has exactly one background exception'); assert.ok(/except the one retry this skill describes/.test(fmOf('ship').text) && /A `deadline` result is not a test result: don't update the attempt; run the retry\./.test(fmOf('ship').text) && /Bash call itself times out[^\n]*\n?[^\n]*--outcome needs_context --diagnosis none[^\n]*test run killed without cleanup; check for leftover test processes/.test(fmOf('ship').text) && !/once more with `run_in_background: true`[^.]*Bash call/.test(fmOf('ship').text) && /--deadline-sec 540/.test(fmOf('ship').text) && /"status":"deadline"/.test(fmOf('ship').text) && !/You are the architect/.test(fmOf('ship').text));
        assert.ok(/--outcome skipped --diagnosis none --head <head>/.test(fmOf('ship').text));
      });
      test('[4a-cost] recovery CLI: editing the spec or moving the branch after a gate pass stops the merge', () => {
        const dir = initRepo('main');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
        fs.mkdirSync(path.join(dir, '.sereno'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'node -e "process.exit(0)"' } }));
        runS(dir, ['branch', '--task', 'demo']);
        runS(dir, ['spec', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--base-branch', 'main', '--stdin'], '## Goal\nchange a\n');
        git(dir, 'switch', '-q', 'task/demo');
        runS(dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running', '--started-at', 'now', '--spec', '.sereno/specs/demo.md']);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); git(dir, 'commit', '-q', '-am', 'work');
        const base = git(dir, 'merge-base', 'task/demo', 'main'), head = git(dir, 'rev-parse', 'HEAD'), rid = runS(dir, ['run-id', '--head', head]).out.review_run_id;
        const v = '```json\n{"outcome":"pass","findings":[],"context_requests":[]}\n```\n';
        assert.strictEqual(runS(dir, ['gate', '--stdin', '--task', 'demo', '--spec', '.sereno/specs/demo.md', '--base', base, '--head', head, '--branch', 'task/demo', '--run-id', rid, '--model', 'claude-fable-5-1', '--tests-passed', 'true'], v).out.outcome, 'pass');
        runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'pass', '--review-run-id', rid, '--diagnosis', 'none', '--ended-at', 'now']);
        assert.strictEqual(runS(dir, ['recovery', '--task', 'demo']).out.next, 'merge');
        const specFile = path.join(dir, '.sereno', 'specs', 'demo.md'), original = fs.readFileSync(specFile, 'utf8');
        fs.writeFileSync(specFile, original + '\nextra\n');
        let r = runS(dir, ['recovery', '--task', 'demo']).out;
        assert.ok(r.next === 'decide' && /^spec_changed/.test(r.reason), JSON.stringify(r));
        fs.writeFileSync(specFile, original);
        assert.strictEqual(runS(dir, ['recovery', '--task', 'demo']).out.next, 'merge');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n'); git(dir, 'commit', '-q', '-am', 'late');
        r = runS(dir, ['recovery', '--task', 'demo']).out;
        assert.ok(r.next === 'review' && /^head_moved/.test(r.reason), JSON.stringify(r));
      });
    }

    /* exit criterion 6: a full simulated ship writes only under .sereno/ */
    test('[plugin exit 6] a simulated ship (test, gate, attempts, recovery) changes only .sereno/; the local merge follows', () => {
      const dir = initRepo('main');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      fs.mkdirSync(path.join(dir, '.sereno'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'node -e "process.exit(0)"' } }));
      const br = runS(dir, ['branch', '--task', 'demo']);
      assert.strictEqual(br.out.from_branch, 'main');
      assert.strictEqual(runS(dir, ['spec', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--base-branch', 'main', '--stdin'], '## Goal\nchange a\n').out.ok, true);
      git(dir, 'switch', '-q', 'task/demo');
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running', '--started-at', 'now']).out.attempt, 1);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n'); git(dir, 'commit', '-q', '-am', 'builder work');
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'built', '--ended-at', 'now']).out.ok, true);
      assert.strictEqual(runS(dir, ['recovery', '--task', 'demo']).out.next, 'review');
      const base = git(dir, 'merge-base', 'task/demo', 'main'), head = git(dir, 'rev-parse', 'HEAD');
      assert.notStrictEqual(base, head);
      const tr = runS(dir, ['test', '--task', 'demo', '--base', base, '--head', head]);
      assert.strictEqual(tr.out.passed, true, JSON.stringify(tr.out));
      const rid = runS(dir, ['run-id', '--head', head]).out.review_run_id;
      const verdict = '```json\n{"outcome":"pass","findings":[],"context_requests":[]}\n```\n';
      const g = runS(dir, ['gate', '--stdin', '--task', 'demo', '--spec', '.sereno/specs/demo.md', '--base', base, '--head', head, '--branch', 'task/demo', '--run-id', rid, '--model', 'claude-fable-5-1', '--tests-passed', 'true'], verdict);
      assert.strictEqual(g.out.outcome, 'pass', JSON.stringify(g.out));
      assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', '1', '--outcome', 'pass', '--review-run-id', rid, '--diagnosis', 'none', '--ended-at', 'now']).out.ok, true);
      const rec = runS(dir, ['recovery', '--task', 'demo']);
      assert.strictEqual(rec.out.next, 'merge', JSON.stringify(rec.out));
      const status = git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
      assert.ok(status.length > 0);
      for (const line of status) assert.ok(/^\?\? \.sereno\//.test(line), 'only .sereno/ changed: ' + line);
      assert.strictEqual(git(dir, 'rev-parse', 'HEAD'), head, 'the scripts made no commits');
      assert.strictEqual(git(dir, 'branch', '--show-current'), 'task/demo');
      assert.strictEqual(git(dir, 'worktree', 'list').split('\n').length, 1, 'the base worktree is gone');
      git(dir, 'switch', '-q', 'main'); git(dir, 'merge', '-q', '--no-ff', '-m', 'merge task/demo', 'task/demo');
      assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'two\n');
      assert.strictEqual(git(dir, 'remote'), '');
    });
    test('[plugin exit 3 and 4] attempts driven through sereno.js: environment retry keeps the repair, second defect stops at decide', () => {
      const dir = initRepo('main');
      const add = (outcome, diagnosis) => {
        const n = runS(dir, ['attempt', '--task', 'demo', '--outcome', 'running']).out.attempt;
        assert.strictEqual(runS(dir, ['attempt', '--task', 'demo', '--update', String(n), '--outcome', outcome, '--diagnosis', diagnosis, '--ended-at', 'now']).out.ok, true);
      };
      add('error', 'environment');
      let r = runS(dir, ['recovery', '--task', 'demo']).out;
      assert.deepStrictEqual([r.next, r.repairsUsed, r.infraRetriesUsed], ['retry', 0, 0]);
      add('error', 'environment');
      r = runS(dir, ['recovery', '--task', 'demo']).out;
      assert.deepStrictEqual([r.next, r.repairsUsed, r.infraRetriesUsed], ['retry', 0, 1]);
      for (const n of [1, 2]) assert.ok(readAttempt(dir, n).diagnosis === 'environment' && readAttempt(dir, n).outcome === 'error');
      add('block', 'defect');
      assert.strictEqual(runS(dir, ['recovery', '--task', 'demo']).out.next, 'repair');
      add('block', 'defect');
      r = runS(dir, ['recovery', '--task', 'demo']).out;
      assert.strictEqual(r.next, 'decide'); assert.ok(r.repairsUsed >= 1);
      assert.strictEqual(fs.readdirSync(path.join(dir, '.sereno', 'attempts')).length, 4, 'no third repair attempt was suggested or created');
    });

    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a step 5: brief and doctor ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const appBriefs = require('../src/briefs.js');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4a5-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const home = mk();
    const runS = (cwd, args) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: '', encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'one line of stdout: ' + r.stdout);
      return { status: r.status, stderr: r.stderr, out: JSON.parse(r.stdout) };
    };
    const initRepo = (branch) => {
      const dir = mk();
      git(dir, 'init', '-q', '-b', branch || 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'init');
      return dir;
    };
    const brief = (dir, branch, extra) => runS(dir, ['brief', '--branch', branch, '--now', 'Wiring the button', '--next', 'Add tests', '--blocked', 'None'].concat(extra || []));
    const briefFile = (dir, branch) => path.join(dir, '.sereno', 'briefs', encodeURIComponent(branch) + '.md');

    test('[4a5] brief: written file parses with the app parseBrief, identical fields', () => {
      const dir = initRepo('feat/x');
      const r = brief(dir, 'feat/x', ['--task', 'add-export']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
      assert.strictEqual(r.out.path, '.sereno/briefs/feat%2Fx.md');
      assert.strictEqual(r.out.version, 1);
      const head = git(dir, 'rev-parse', 'HEAD');
      assert.strictEqual(r.out.source_commit, head);
      const text = fs.readFileSync(briefFile(dir, 'feat/x'), 'utf8');
      const b = appBriefs.parseBrief(text);
      assert.ok(b, 'app parser accepts it');
      assert.strictEqual(b.branch, 'feat/x');
      assert.strictEqual(b.version, 1);
      assert.strictEqual(b.sourceCommit, head);
      assert.strictEqual(b.task, 'add-export');
      assert.strictEqual(b.worktree, dir.replace(/\\/g, '/'));
      assert.match(b.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      assert.deepStrictEqual([b.now, b.next, b.blocked], ['Wiring the button', 'Add tests', 'None']);
      assert.strictEqual(appBriefs.decodeBriefName(path.basename(briefFile(dir, 'feat/x'))), 'feat/x');
    });
    test('[4a5] brief: a brief in the app template format is read by the plugin version check', () => {
      const dir = initRepo('feat/x');
      fs.mkdirSync(path.join(dir, '.sereno', 'briefs'), { recursive: true });
      const tpl = ['---', 'branch: feat/x', 'worktree: C:/Users/me/code/app', 'version: 3', 'source_commit: 0123456789abcdef0123456789abcdef01234567',
        'task: add-export-button', 'generated_at: 2026-10-11T14:05:00Z', '---', 'Now: Wiring it.', 'Next: Tests.', 'Blocked: None', ''].join('\n');
      fs.writeFileSync(briefFile(dir, 'feat/x'), tpl);
      assert.strictEqual(appBriefs.parseBrief(tpl).version, 3);
      const r = brief(dir, 'feat/x', ['--expect-version', '3']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out)); assert.strictEqual(r.out.version, 4);
      assert.strictEqual(appBriefs.parseBrief(fs.readFileSync(briefFile(dir, 'feat/x'), 'utf8')).version, 4);
    });
    test('[4a5] brief: version bumps; version_conflict writes nothing and exits 14', () => {
      const dir = initRepo('main');
      assert.strictEqual(brief(dir, 'main', ['--expect-version', '0']).out.version, 1);
      assert.strictEqual(brief(dir, 'main', ['--expect-version', '1']).out.version, 2);
      const before = fs.readFileSync(briefFile(dir, 'main'), 'utf8');
      const r = brief(dir, 'main', ['--expect-version', '1']);
      assert.deepStrictEqual([r.out.ok, r.out.code, r.out.current, r.status], [false, 'version_conflict', 2, 14]);
      assert.strictEqual(fs.readFileSync(briefFile(dir, 'main'), 'utf8'), before);
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.sereno', 'briefs')), ['main.md'], 'no tmp file left');
      assert.strictEqual(brief(dir, 'main').out.version, 3, 'no --expect-version: just bumps');
    });
    test('[4a5] brief: 120-char cap, control and bidi stripped, empty blocked is None', () => {
      const dir = initRepo('main');
      const long = 'x'.repeat(300);
      const r = runS(dir, ['brief', '--branch', 'main', '--now', long, '--next', 'a\u202eb\u0007c\u200bd\u2066e', '--blocked', '   ']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
      const text = fs.readFileSync(briefFile(dir, 'main'), 'utf8');
      const lines = text.split('\n');
      const now = lines.find((l) => l.startsWith('Now: ')).slice(5);
      assert.strictEqual(now.length, 120); assert.ok(now.endsWith('\u2026'));
      assert.strictEqual(lines.find((l) => l.startsWith('Next: ')), 'Next: abcde');
      assert.strictEqual(lines.find((l) => l.startsWith('Blocked: ')), 'Blocked: None');
      assert.ok(!/[\u202e\u0007\u200b\u2066]/.test(text));
      const b = appBriefs.parseBrief(text); assert.ok(b && b.now.length === 120);
    });
    test('[4a5] brief: invalid branch and detached HEAD are refused; nothing is written', () => {
      const dir = initRepo('main');
      for (const bad of ['-x', 'a..b', 'a b', 'x/', '@', 'a\u202eb']) {
        const r = brief(dir, bad);
        assert.deepStrictEqual([r.out.ok, r.out.code], [false, 'invalid_arg'], JSON.stringify(bad));
      }
      assert.ok(!fs.existsSync(path.join(dir, '.sereno')));
      git(dir, 'checkout', '-q', '--detach');
      const r = brief(dir, 'main');
      assert.deepStrictEqual([r.out.ok, r.out.code, r.status], [false, 'detached_head', 15]);
      assert.ok(!fs.existsSync(path.join(dir, '.sereno')));
      assert.strictEqual(runS(dir, ['brief', '--branch', 'main', '--now', 'x']).out.code, 'usage');
    });

    test('[4a5] brief: a branch other than the checked-out one is refused (branch_mismatch, exit 16), nothing written', () => {
      const dir = initRepo('main');
      git(dir, 'branch', 'other');
      const r = brief(dir, 'other');
      assert.deepStrictEqual([r.out.ok, r.out.code, r.status], [false, 'branch_mismatch', 16]);
      assert.ok(!fs.existsSync(path.join(dir, '.sereno')));
    });

    const doctor = (dir) => runS(dir, ['doctor']);
    const byName = (r, n) => r.out.checks.find((c) => c.name === n);
    test('[4a5] doctor: all ok in a repo with a test command', () => {
      const dir = initRepo('main');
      fs.mkdirSync(path.join(dir, '.sereno'));
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'node t.js' } }));
      const r = doctor(dir);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out)); assert.strictEqual(r.status, 0);
      assert.deepStrictEqual(r.out.checks.map((c) => c.name), ['node', 'git', 'git repo', 'pipeline.json', 'test command', '.sereno writable', 'red-team agents']);
      assert.ok(r.out.checks.every((c) => c.ok && typeof c.detail === 'string'));
      assert.match(byName(r, 'pipeline.json').detail, /sha256:[0-9a-f]{64}/);
      assert.match(byName(r, 'test command').detail, /tests\.command: node t\.js/);
      assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.sereno', 'cache')), [], 'probe file removed');
    });
    test('[4a5] doctor: package.json test script counts; the npm default does not', () => {
      const dir = initRepo('main');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
      let r = doctor(dir);
      assert.deepStrictEqual([r.out.ok, byName(r, 'test command').ok, r.status], [false, false, 1]);
      assert.strictEqual(r.out.checks.filter((c) => !c.ok).length, 1, 'only the test command fails');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
      r = doctor(dir);
      assert.strictEqual(r.out.ok, true); assert.match(byName(r, 'test command').detail, /package\.json/);
    });
    test('[4a5] doctor: invalid config and a missing repo are reported without throwing', () => {
      const dir = initRepo('main');
      fs.mkdirSync(path.join(dir, '.sereno'));
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), '{"preset":"nope"');
      let r = doctor(dir);
      assert.strictEqual(r.out.ok, false);
      assert.strictEqual(byName(r, 'pipeline.json').ok, false); assert.match(byName(r, 'pipeline.json').detail, /JSON|invalid/i);
      assert.strictEqual(byName(r, 'test command').ok, false);
      assert.strictEqual(byName(r, 'red-team agents').ok, false);
      assert.strictEqual(byName(r, 'git repo').ok, true);
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ roles: { redTeam: { enabled: 'yes' } } }));
      r = doctor(dir);
      assert.strictEqual(byName(r, 'pipeline.json').ok, false); assert.match(byName(r, 'pipeline.json').detail, /enabled/);
      const bare = mk();
      r = doctor(bare);
      assert.strictEqual(r.out.ok, false);
      assert.strictEqual(byName(r, 'git repo').ok, false); assert.strictEqual(byName(r, '.sereno writable').ok, false);
      assert.ok(!fs.existsSync(path.join(bare, '.sereno')));
      assert.ok(!/at .*\.js:\d+/.test(JSON.stringify(r.out)) && r.stderr === '');
    });
    test('[4a5] doctor: a red-team agent name with no file under plugin/agents is reported', () => {
      const dir = initRepo('main');
      fs.mkdirSync(path.join(dir, '.sereno'));
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'x' } }));
      const agentFile = path.join(PLUGIN, 'agents', 'red-team-lean.md');
      assert.ok(fs.existsSync(agentFile));
      const { runDoctor } = require('../plugin/bin/lib/doctor.js');
      const realExists = fs.existsSync;
      fs.existsSync = (p) => (String(p) === agentFile ? false : realExists(p));
      let d;
      try { d = runDoctor(dir); } finally { fs.existsSync = realExists; }
      const c = d.checks.find((x) => x.name === 'red-team agents');
      assert.deepStrictEqual([c.ok, d.ok], [false, false]); assert.match(c.detail, /red-team-lean/);
    });
    test('[4a5] lint: brief skill and scribe agent use only existing subcommands; no npm/npx; plugin needs nothing outside plugin/', () => {
      const sub = (() => {
        const r = spawnSync(process.execPath, [SERENO, 'no-such-command'], { encoding: 'utf8' });
        return /<([a-z|-]+)>/.exec(JSON.parse(r.stdout).error)[1].split('|');
      })();
      assert.ok(sub.includes('brief') && sub.includes('doctor'));
      const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'brief', 'SKILL.md'), 'utf8');
      const scribe = fs.readFileSync(path.join(PLUGIN, 'agents', 'scribe.md'), 'utf8');
      assert.match(skill, /^---\nname: brief\n/); assert.match(skill, /disable-model-invocation: true/);
      assert.match(skill, /brief --branch/); assert.match(skill, /--expect-version/); assert.match(skill, /version_conflict/);
      assert.match(scribe, /`brief` subcommand/); assert.match(scribe, /--expect-version/);
      for (const [n, t] of [['skill', skill], ['scribe', scribe]]) {
        assert.ok(!/\bnpm\b|\bnpx\b/.test(t), n + ' uses npm/npx');
        for (const m of t.matchAll(/sereno\.js"? +([A-Za-z-]+)/g)) assert.ok(sub.includes(m[1]), n + ' calls unknown subcommand ' + m[1]);
      }
      for (const f of ['brief.js', 'doctor.js']) {
        const src = fs.readFileSync(path.join(PLUGIN, 'bin', 'lib', f), 'utf8');
        for (const m of src.matchAll(/require\('([^']+)'\)/g)) assert.ok(m[1].startsWith('node:') || (m[1].startsWith('./') && !m[1].startsWith('../')), f + ' requires ' + m[1]);
      }
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a: e2e fixes ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4ae-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const home = mk();
    const S = (cwd, args, input) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: input || '', encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'one line of stdout: ' + r.stdout);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    const initRepo = () => {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'init');
      return dir;
    };
    const readAll = (dir) => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

    test('[4a-e2e] skills delegate with the literal substituted command; agents hard-code no path', () => {
      for (const sk of ['ship', 'build', 'task', 'brief']) {
        const t = fs.readFileSync(path.join(PLUGIN, 'skills', sk, 'SKILL.md'), 'utf8');
        for (const m of t.matchAll(/.*sereno\.js.*/g)) assert.ok(m[0].includes('node "${CLAUDE_PLUGIN_ROOT}/bin/sereno.js"'), sk + ': ' + m[0]);
      }
      const ship = fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8');
      assert.match(ship, /Run exactly: node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/sereno\.js" brief /);
      assert.match(ship, /verbatim and never construct a path/);
      for (const t of readAll(path.join(PLUGIN, 'agents'))) {
        assert.ok(!/plugin\//.test(t) && !/bin\/sereno\.js/.test(t), 'agent file hard-codes a path');
      }
    });
    test('[4a-e2e] scribe.md carries the Now/Next/Blocked rules', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'agents', 'scribe.md'), 'utf8');
      assert.match(t, /do not\s+guess paths/i);
      assert.match(t, /facts from the spec, `git log`,\s+the\s+gate and the attempts/);
      assert.match(t, /never new\s+scope/);
      assert.match(t, /Next: None planned/);
    });
    test('[4a-e2e] gate: model comes from the agent definition; --model wins; session recorded', () => {
      const dir = initRepo();
      fs.mkdirSync(path.join(dir, '.sereno', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'specs', 'x.md'), '---\ntask_id: x\n---\nspec\n');
      const head = git(dir, 'rev-parse', 'HEAD');
      const g = (extra) => S(dir, ['gate', '--stdin', '--task', 'x', '--base', head, '--head', head, '--branch', 'main', '--tests-passed', 'true'].concat(extra), '{"outcome":"pass","findings":[]}');
      const read = (r) => JSON.parse(fs.readFileSync(path.join(dir, r.out.path), 'utf8'));
      const fm = (n) => /^model:\s*(\S+)/m.exec(fs.readFileSync(path.join(PLUGIN, 'agents', n + '.md'), 'utf8'))[1];
      let r = g(['--agent-name', 'red-team-lean', '--session', '5f6c0d3e-1111-4222-8333-944455556666']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
      assert.strictEqual(read(r).model, fm('red-team-lean'));
      assert.strictEqual(read(r).session_id, '5f6c0d3e-1111-4222-8333-944455556666');
      r = g(['--agent-name', 'red-team']);
      assert.strictEqual(read(r).model, fm('red-team'));
      r = g(['--agent-name', 'red-team', '--model', 'custom-model']);
      assert.strictEqual(read(r).model, 'custom-model');
      assert.strictEqual(g(['--agent-name', '../x']).out.ok, false);
      assert.strictEqual(read(g([])).model, null);
    });
    test('[4a-e2e] attempt: --agent-id on update; project_id is the app id', () => {
      const dir = initRepo();
      let r = S(dir, ['attempt', '--task', 't1', '--builder', 'sonnet', '--kind', 'feature', '--diagnosis', 'none', '--outcome', 'running', '--started-at', 'now']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
      const file = path.join(dir, r.out.path);
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).project_id, require('../src/projects.js').projectId(dir));
      r = S(dir, ['attempt', '--task', 't1', '--update', '1', '--outcome', 'built', '--agent-id', 'a1b2c3d4e5']);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).agent_id, 'a1b2c3d4e5');
      assert.strictEqual(S(dir, ['attempt', '--task', 't1', '--update', '1', '--agent-id', 'bad id!']).out.ok, false);
    });
    test('[4a-e2e] projectid: plugin copy matches the app, drive-letter case included', () => {
      const a = require('../src/projects.js'), p = require('../plugin/bin/lib/projectid.js');
      for (const x of [ROOT, os.tmpdir(), 'C:\\Users\\Me\\Repo', 'c:/users/me/repo/', 'D:\\x\\', '/usr/local/proj/']) assert.strictEqual(p.projectId(x), a.projectId(x), x);
      assert.strictEqual(p.projectId('C:\\Users\\Me\\Repo'), p.projectId('c:/users/me/REPO'));
    });
    test('[4a-e2e] config lists inert keys; doctor notes them without failing', () => {
      const dir = initRepo();
      fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"test":"node -e 0"}}');
      let r = S(dir, ['config']);
      assert.deepStrictEqual(r.out.inert, []);
      fs.mkdirSync(path.join(dir, '.sereno'));
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ roles: { builder: { options: { opus: { model: 'claude-x', maxTurns: 7 } } } }, recovery: { taskBudgetUsd: 5 } }));
      r = S(dir, ['config']);
      assert.deepStrictEqual(r.out.inert.slice().sort(), ['recovery.taskBudgetUsd', 'roles.builder.options.opus.maxTurns', 'roles.builder.options.opus.model']);
      r = S(dir, ['doctor']);
      const c = r.out.checks.find((x) => x.name === 'pipeline.json');
      assert.strictEqual(c.ok, true); assert.match(c.detail, /note, no effect yet:.*taskBudgetUsd/);
      assert.strictEqual(r.out.ok, true, JSON.stringify(r.out.checks));
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- [plugin exit] ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-pexit-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const home = mk();
    const S = (cwd, args, input) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: input || '', encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'one line of stdout: ' + r.stdout);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    const T_JS = [
      "const fs=require('fs');const s=JSON.parse(fs.readFileSync('spec.json','utf8'));",
      "if(s.cwdlog) fs.appendFileSync(s.cwdlog, process.cwd()+'\\n');",
      "console.log('TAP version 13');",
      "s.tests.forEach((t,i)=>console.log(((s.fails||[]).includes(t)?'not ok ':'ok ')+(i+1)+' - '+t));",
      "if(s.plan) console.log('1..'+s.tests.length);",
      "process.exit((s.fails||[]).length?2:0);",
    ].join('\n');
    /** repo on branch main with a base commit, optionally a head commit with another suite spec. */
    function mkRepo(baseSpec, headSpec, cmd) {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 't.js'), T_JS);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(baseSpec || { tests: ['A'] }));
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      if (headSpec) {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
        fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(headSpec));
        git(dir, 'commit', '-q', '-am', 'head');
      }
      fs.mkdirSync(path.join(dir, '.sereno'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: cmd || 'node t.js' } }));
      return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
    }
    const attempt = (dir, args) => S(dir, ['attempt', '--task', 'demo', ...args]);
    const recovery = (dir) => S(dir, ['recovery', '--task', 'demo']).out;
    const readJ = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

    test('[plugin exit 1] both manifests are valid (claude plugin validate, else a JSON-shape check)', () => {
      const has = spawnSync('claude', ['--version'], { shell: true, timeout: 30000 }).status === 0;
      if (has) {
        console.log('  [plugin exit 1] path: claude plugin validate');
        for (const target of ['plugin', '.']) {
          const r = spawnSync('claude', ['plugin', 'validate', target], { cwd: ROOT, shell: true, timeout: 60000, encoding: 'utf8' });
          assert.strictEqual(r.status, 0, target + ': ' + (r.stdout || '') + (r.stderr || ''));
        }
        return;
      }
      console.log('  [plugin exit 1] path: JSON-shape check (claude not on PATH)');
      const pj = readJ(ROOT, 'plugin/.claude-plugin/plugin.json'), mj = readJ(ROOT, '.claude-plugin/marketplace.json');
      for (const k of ['name', 'version', 'description']) assert.ok(typeof pj[k] === 'string' && pj[k], 'plugin.json ' + k);
      assert.match(pj.name, /^[a-z0-9]+(-[a-z0-9]+)*$/); assert.match(pj.version, /^\d+\.\d+\.\d+/);
      assert.ok(typeof mj.name === 'string' && mj.name && mj.owner && typeof mj.owner.name === 'string');
      assert.ok(Array.isArray(mj.plugins) && mj.plugins.length === 1);
      const e = mj.plugins[0];
      assert.strictEqual(e.name, pj.name); assert.strictEqual(e.version, pj.version);
      assert.ok(typeof e.source === 'string' && e.source.startsWith('./'));
      assert.ok(fs.existsSync(path.join(ROOT, e.source, '.claude-plugin', 'plugin.json')), 'source resolves');
    });

    test('[plugin exit 2] a test failing at base is not a defect, and the base suite ran in its own worktree', () => {
      const cwdlog = path.join(mk(), 'cwd.log');
      const spec = { tests: ['A', 'B'], fails: ['A'], cwdlog, plan: true };
      const r = mkRepo(spec, spec);
      const t = S(r.dir, ['test', '--base', r.base, '--head', r.head, '--json']);
      assert.strictEqual(t.out.ok, true); assert.strictEqual(t.out.passed, true);
      assert.deepStrictEqual(t.out.baseFailures, ['A']); assert.deepStrictEqual(t.out.newFailures, []);
      assert.strictEqual(t.out.diagnosis, 'none');
      const lines = fs.readFileSync(cwdlog, 'utf8').split('\n').filter(Boolean);
      assert.strictEqual(lines.length, 2);
      assert.ok(lines[0].includes('sereno-base-'), 'base cwd is a base worktree');
      assert.notStrictEqual(lines[0].toLowerCase(), r.dir.toLowerCase());
      assert.strictEqual(lines[1].toLowerCase(), r.dir.toLowerCase());
      assert.strictEqual(git(r.dir, 'worktree', 'list').split('\n').filter(Boolean).length, 1, 'worktree removed');
    });

    test('[plugin exit 3] an environment failure retries without using the repair (CLI sequence as /sereno:ship)', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] }, 'sereno-no-such-command-xyz');
      const t = S(r.dir, ['test', '--base', r.base, '--head', r.head, '--json']);
      assert.strictEqual(t.out.passed, false); assert.strictEqual(t.out.diagnosis, 'environment');
      assert.strictEqual(attempt(r.dir, ['--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running']).out.attempt, 1);
      assert.strictEqual(attempt(r.dir, ['--update', '1', '--outcome', 'error', '--diagnosis', t.out.diagnosis, '--ended-at', 'now']).out.ok, true);
      assert.strictEqual(readJ(r.dir, '.sereno/attempts/demo-1.json').diagnosis, 'environment');
      let rec = recovery(r.dir);
      assert.deepStrictEqual([rec.next, rec.repairsUsed, rec.infraRetriesUsed], ['retry', 0, 0]);
      attempt(r.dir, ['--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running']);
      attempt(r.dir, ['--update', '2', '--outcome', 'error', '--diagnosis', 'environment', '--ended-at', 'now']);
      rec = recovery(r.dir);
      assert.deepStrictEqual([rec.next, rec.repairsUsed, rec.infraRetriesUsed], ['retry', 0, 1]);
      attempt(r.dir, ['--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running']);
      attempt(r.dir, ['--update', '3', '--outcome', 'error', '--diagnosis', 'environment', '--ended-at', 'now']);
      rec = recovery(r.dir);
      assert.deepStrictEqual([rec.next, rec.repairsUsed, rec.infraRetriesUsed], ['decide', 0, 2], 'infraRetries used up');
    });

    test('[plugin exit 4] a second defect goes to decide and no third attempt is suggested', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'], fails: ['A'] });
      const t = S(r.dir, ['test', '--base', r.base, '--head', r.head, '--json']);
      assert.strictEqual(t.out.passed, false); assert.deepStrictEqual(t.out.newFailures, ['A']);
      const defect = (n) => {
        assert.strictEqual(attempt(r.dir, ['--builder', 'sonnet', '--kind', n === 1 ? 'feature' : 'repair', '--outcome', 'running']).out.attempt, n);
        assert.strictEqual(attempt(r.dir, ['--update', String(n), '--outcome', 'block', '--diagnosis', 'defect', '--ended-at', 'now']).out.ok, true);
        return recovery(r.dir);
      };
      let rec = defect(1);
      assert.deepStrictEqual([rec.next, rec.repairsUsed], ['repair', 0]);
      rec = defect(2);
      assert.deepStrictEqual([rec.next, rec.repairsUsed], ['decide', 1]);
      rec = defect(3);
      assert.strictEqual(rec.next, 'decide');
    });

    test('[plugin exit 5] gate and attempt files match the spec fields exactly; unknown enums are "unknown"; config_hash is stable', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      fs.mkdirSync(path.join(r.dir, '.sereno', 'specs'), { recursive: true }); fs.writeFileSync(path.join(r.dir, '.sereno', 'specs', 'demo.md'), '# spec\n');
      const g = S(r.dir, ['gate', '--stdin', '--task', 'demo', '--base', r.base, '--head', r.head, '--session', 's-1', '--agent', 'a_1', '--model', 'claude-opus-5-5', '--tests-passed', 'true'],
        JSON.stringify({ outcome: 'maybe', findings: [{ severity: 'catastrophic', kind: 7, file: 'a.txt', line: 2, summary: 's', extra: 1 }], context_requests: [], evil: 1 }));
      assert.strictEqual(g.out.ok, true, JSON.stringify(g.out));
      const gate = readJ(r.dir, g.out.path);
      assert.deepStrictEqual(Object.keys(gate), ['review_run_id', 'task_id', 'spec', 'spec_hash', 'branch', 'base_commit', 'head_commit', 'session_id', 'agent_id', 'model', 'outcome', 'tests_passed', 'findings', 'context_requests', 'reviewed_at', 'config_hash']);
      assert.strictEqual(gate.outcome, 'unknown');
      assert.deepStrictEqual(Object.keys(gate.findings[0]), ['severity', 'kind', 'file', 'line', 'summary']);
      assert.strictEqual(gate.findings[0].severity, 'unknown'); assert.strictEqual(gate.findings[0].kind, 'unknown');
      const a = attempt(r.dir, ['--builder', 'gpt', '--kind', 'telepathy', '--diagnosis', 'vibes', '--outcome', 'sideways']);
      assert.strictEqual(a.out.ok, true, JSON.stringify(a.out));
      const att = readJ(r.dir, a.out.path);
      assert.deepStrictEqual(Object.keys(att), ['project_id', 'task_id', 'spec_revision', 'attempt', 'builder_requested', 'agent_id', 'config_hash', 'kind', 'fixes', 'diagnosis', 'outcome', 'review_run_id', 'started_at', 'ended_at']);
      for (const k of ['builder_requested', 'kind', 'diagnosis', 'outcome']) assert.strictEqual(att[k], 'unknown', k);
      const h = (obj) => { const x = mkRepo(); fs.writeFileSync(path.join(x.dir, '.sereno', 'pipeline.json'), JSON.stringify(obj)); return S(x.dir, ['config']).out.config_hash; };
      assert.strictEqual(h({ preset: 'lean', recovery: { repairs: 1, infraRetries: 3 } }), h({ recovery: { infraRetries: 3, repairs: 1 }, preset: 'lean' }));
      assert.notStrictEqual(h({ preset: 'lean' }), h({ preset: 'default' }));
    });

    test('[plugin exit 6] a full simulated ship writes only under .sereno/ (plus the Builder commit); plugin/ never pushes or touches a remote', () => {
      const r = mkRepo({ tests: ['A'] });
      const br = S(r.dir, ['branch', '--task', 'demo']);
      assert.strictEqual(br.out.ok, true, JSON.stringify(br.out));
      assert.strictEqual(S(r.dir, ['spec', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--base-branch', br.out.from_branch, '--stdin'], '## Goal\nx\n').out.ok, true);
      git(r.dir, 'switch', '-q', 'task/demo');
      attempt(r.dir, ['--builder', 'sonnet', '--kind', 'feature', '--outcome', 'running']);
      fs.writeFileSync(path.join(r.dir, 'a.txt'), 'two\n'); git(r.dir, 'commit', '-q', '-am', 'builder work');
      const head = git(r.dir, 'rev-parse', 'HEAD');
      const t = S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', head, '--json']);
      assert.strictEqual(t.out.passed, true, JSON.stringify(t.out));
      attempt(r.dir, ['--update', '1', '--outcome', 'built', '--ended-at', 'now']);
      const g = S(r.dir, ['gate', '--stdin', '--task', 'demo', '--base', r.base, '--head', head, '--session', 's', '--agent', 'a', '--model', 'm', '--tests-passed', 'true'], JSON.stringify({ outcome: 'pass', findings: [] }));
      assert.strictEqual(g.out.ok, true, JSON.stringify(g.out));
      attempt(r.dir, ['--update', '1', '--outcome', 'pass', '--diagnosis', 'none', '--review-run-id', g.out.review_run_id, '--ended-at', 'now']);
      assert.strictEqual(recovery(r.dir).next, 'merge');
      const lines = git(r.dir, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
      assert.ok(lines.length > 0);
      for (const l of lines) assert.ok(/^\?\? "?\.sereno\//.test(l), 'outside .sereno/: ' + l);
      assert.strictEqual(git(r.dir, 'remote'), '', 'no remote configured or added');
      const bad = [];
      const RX = [/\bgit\b[^\n]*\b(push|fetch|pull|ls-remote)\b/i, /\bgit\b[^\n]*\bremote\s+(add|set-url)\b/i, /['"`](push|fetch|pull|ls-remote)['"`]/, /['"`]remote['"`]\s*,\s*['"`]add['"`]/];
      (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { walk(p); continue; }
          let txt = fs.readFileSync(p, 'utf8');
          // prose saying the plugin never does it is fine; an invocation is not
          if (/\.md$/i.test(p)) txt = txt.replace(/\b(never|not|nothing|no|without)\b[^.]*\./gi, '');
          if (RX.some((x) => x.test(txt))) bad[bad.length] = path.relative(ROOT, p);
        }
      })(PLUGIN);
      assert.deepStrictEqual(bad, []);
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
  }

  /* ---- Phase 4a: heredoc stdin ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const skills = fs.readdirSync(path.join(PLUGIN, 'skills')).map((n) => [n, fs.readFileSync(path.join(PLUGIN, 'skills', n, 'SKILL.md'), 'utf8')]);
    const fenced = (t) => { const out = []; let on = false; for (const l of t.split('\n')) { if (/^\s*```/.test(l)) { on = !on; continue; } if (on) out.push(l); } return out; };
    test('[4a-heredoc] skills pass no JSON via stdin, heredoc or echo; use cache files', () => {
      for (const [n, t] of skills) {
        for (const l of fenced(t)) {
          assert.ok(!/--stdin/.test(l) && !/<</.test(l), n + ': stdin/heredoc in a command: ' + l);
          assert.ok(!/^\s*(echo|printf|cat)\b/.test(l) && !/\|\s*node\b/.test(l), n + ': pipe into node: ' + l);
          assert.ok(!l.includes('{"'), n + ': {" inside a command block: ' + l);
        }
        assert.ok(!/--stdin/.test(t), n + ': mentions --stdin');
        const fm = /^allowed-tools:(.*)$/m.exec(t)[1];
        if (n !== 'ship' && n !== 'task') assert.ok(!/Write|Edit/.test(fm), n + ': unexpected write grant');
      }
      const ship = skills.find((x) => x[0] === 'ship')[1];
      const task = skills.find((x) => x[0] === 'task')[1];
      assert.match(ship, /gate --file <cacheDir>\/verdict-<review_run_id>\.json /);
      assert.match(task, /spec --task <name>[^\n]*--body-file <cacheDir>\/spec-<name>\.md/);
      assert.match(ship, /^allowed-tools:.*Edit\(\.sereno\/cache\/verdict-\*\.json\)/m);
      assert.match(ship, /<cacheDir>\/verdict-<review_run_id>\.json/); assert.match(ship, /sereno\.js" paths/);
      assert.match(task, /^allowed-tools:.*Edit\(\.sereno\/cache\/spec-\*\.md\)/m);
      assert.match(task, /<cacheDir>\/spec-<name>\.md/); assert.match(task, /sereno\.js" paths/);
    });
    test('[4a-heredoc] gate and spec read a bash heredoc body', () => {
      const probe = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' });
      if (probe.error || probe.status !== 0) return; // no bash on this machine
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4hd-')));
      try {
        const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
        const head = g('rev-parse', 'HEAD');
        const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4hdh-')));
        const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
        const sh = (cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8', env }); return JSON.parse(r.stdout); };
        const node = '"' + process.execPath.replace(/\\/g, '/') + '" "' + SERENO.replace(/\\/g, '/') + '"';
        const sp = sh(node + " spec --task hd --builder sonnet --kind feature --reason r --stdin <<'SERENO_SPEC'\n## Goal\nchange a\nSERENO_SPEC");
        assert.strictEqual(sp.ok, true);
        assert.match(fs.readFileSync(path.join(dir, '.sereno', 'specs', 'hd.md'), 'utf8'), /change a/);
        const gt = sh(node + ' gate --stdin --task hd --base ' + head + ' --head ' + head + " --branch main --tests-passed true <<'SERENO_VERDICT'\n{\"outcome\":\"pass\",\"findings\":[]}\nSERENO_VERDICT");
        assert.strictEqual(gt.outcome, 'pass');
        fs.rmSync(home, { recursive: true, force: true });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }

  /* ---- Phase 4a: cache-file handoff ---- */
  {
    const SERENO = path.join(ROOT, 'plugin', 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4cf-')));
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4cfh-')));
    const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
    const head = g('rev-parse', 'HEAD');
    const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
    const run = (...a) => { const r = spawnSync(process.execPath, [SERENO, ...a], { cwd: dir, encoding: 'utf8', env }); return JSON.parse(r.stdout); };
    const cache = path.join(dir, '.sereno', 'cache');
    fs.mkdirSync(cache, { recursive: true });
    const h7 = head.slice(0, 7);
    const PASS = JSON.stringify({ outcome: 'pass', findings: [] });
    const put = (name, data) => { fs.writeFileSync(path.join(cache, name), data); return '.sereno/cache/' + name; };
    const gateArgs = (file, id) => ['gate', '--file', file, '--task', 'cf', '--base', head, '--head', head, '--branch', 'main', '--run-id', id, '--tests-passed', 'true'];
    const specBase = ['--task', 'cf', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r'];
    test('[4a-cachefile] spec --body-file writes the spec and deletes the file', () => {
      const f = put('spec-cf.md', '## Goal\nchange a\n');
      const r = run('spec', ...specBase, '--body-file', f);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.match(fs.readFileSync(path.join(dir, '.sereno', 'specs', 'cf.md'), 'utf8'), /change a/);
      assert.ok(!fs.existsSync(path.join(dir, f)));
    });
    test('[4a-cachefile] gate --file writes the gate and deletes the file', () => {
      const f = put('verdict-rr_20260101T000000Z_' + h7 + '.json', PASS);
      const r = run(...gateArgs(f, 'rr_20260101T000000Z_' + h7));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.outcome, 'pass');
      assert.ok(!fs.existsSync(path.join(dir, f)));
      assert.ok(fs.existsSync(path.join(dir, '.sereno', 'gates', 'rr_20260101T000000Z_' + h7 + '.json')));
    });
    test('[4a-cachefile] gate --file refuses wrong dir, wrong name, mismatched id, absolute, oversize', () => {
      fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'other', 'verdict-rr_x1.json'), PASS);
      fs.mkdirSync(path.join(dir, '.sereno', 'gates'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'gates', 'verdict-rr_x1.json'), PASS);
      const notes = put('notes.json', PASS);
      const other = put('verdict-rr_other.json', PASS);
      const big = put('verdict-rr_big.json', JSON.stringify({ outcome: 'pass', findings: [], pad: 'x'.repeat(65 * 1024) }));
      const cases = [
        ['other/verdict-rr_x1.json', 'rr_20260101T000000Z_' + h7], ['.sereno/gates/verdict-rr_x1.json', 'rr_20260101T000000Z_' + h7], [notes, 'rr_20260101T000000Z_' + h7],
        [other, 'rr_20260101T000000Z_' + h7], [big, 'rr_20260101T000000Z_' + h7], [path.join(cache, 'verdict-rr_other.json'), 'rr_20260101T000000Z_' + h7],
        ['.sereno/cache/../cache/verdict-rr_other.json', 'rr_20260101T000000Z_' + h7],
      ];
      for (const [f, id] of cases) {
        const r = run(...gateArgs(f, id));
        assert.strictEqual(r.ok, false, f);
        assert.strictEqual(r.code, 'path_refused', f + ' -> ' + JSON.stringify(r));
      }
      assert.ok(!fs.existsSync(path.join(dir, '.sereno', 'gates', 'rr_big.json')));
      assert.ok(fs.existsSync(path.join(dir, other)), 'refused file is left alone');
    });
    test('[4a-cachefile] gate --file refuses a symlinked verdict and a junctioned cache dir', () => {
      const real = path.join(dir, 'realverdict.json');
      fs.writeFileSync(real, PASS);
      const link = path.join(cache, 'verdict-rr_link.json');
      let made = false;
      try { fs.symlinkSync(real, link, 'file'); made = true; } catch (_e) { /* no symlink privilege */ }
      if (made) {
        const r = run(...gateArgs('.sereno/cache/verdict-rr_link.json', 'rr_20260101T000000Z_' + h7));
        assert.strictEqual(r.code, 'path_refused');
        assert.ok(fs.existsSync(real));
      }
      const alt = path.join(dir, 'altcache');
      fs.mkdirSync(alt, { recursive: true });
      fs.writeFileSync(path.join(alt, 'verdict-rr_dir.json'), PASS);
      const saved = path.join(dir, '.sereno', 'cache-real');
      fs.renameSync(cache, saved);
      try {
        let linked = false;
        try { fs.symlinkSync(alt, cache, 'junction'); linked = true; } catch (_e) { /* skip */ }
        if (linked) {
          const r = run(...gateArgs('.sereno/cache/verdict-rr_dir.json', 'rr_20260101T000000Z_' + h7));
          assert.strictEqual(r.code, 'path_refused');
          fs.rmSync(cache, { recursive: true, force: true });
        }
      } finally {
        try { fs.rmSync(cache, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
        fs.renameSync(saved, cache);
      }
    });
    test('[4a-cachefile] spec --body-file refuses wrong dir, name, task mismatch, oversize; needs one source', () => {
      fs.writeFileSync(path.join(dir, 'spec-cf.md'), '## Goal\nx\n');
      const notes = put('notes.md', '## Goal\nx\n');
      const other = put('spec-zz.md', '## Goal\nx\n');
      const bad = put('spec-a b.md', '## Goal\nx\n');
      const big = put('spec-cf.md', '## Goal\n' + 'x'.repeat(65 * 1024));
      for (const f of ['spec-cf.md', '.sereno/specs/spec-cf.md', notes, other, bad, big, '../spec-cf.md']) {
        const r = run('spec', ...specBase, '--body-file', f);
        assert.strictEqual(r.code, 'path_refused', f + ' -> ' + JSON.stringify(r));
      }
      assert.strictEqual(run('spec', ...specBase).code, 'usage');
      assert.strictEqual(run('spec', ...specBase, '--body-file', big, '--stdin').code, 'usage');
    });
    test('[4a-cachefile] cleanup', () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });
  }

  /* ---- Phase 4a: red-team fixes ---- */
  {
    const PLUGIN = path.join(ROOT, 'plugin');
    const SERENO = path.join(PLUGIN, 'bin', 'sereno.js');
    const testrun = require('../plugin/bin/lib/testrun.js');
    const gitlib = require('../plugin/bin/lib/git.js');
    const { loadConfig } = require('../plugin/bin/lib/config.js');
    const { spawnSync } = require('node:child_process');
    const tmps = [];
    const mk = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4arf-'))); tmps.push(d); return d; };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const home = mk();
    const S = (cwd, args, input) => {
      const r = spawnSync(process.execPath, [SERENO, ...args], { cwd, input: input || '', encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, { HOME: home, USERPROFILE: home }) });
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'one line of stdout: ' + r.stdout);
      return { status: r.status, out: JSON.parse(r.stdout) };
    };
    // t2.js: prints TAP lines for spec.tests; spec.crashAfter stops after N lines with exit 1; spec.plan prints 1..N at the end.
    const T2 = [
      "const fs=require('fs');const s=JSON.parse(fs.readFileSync('spec.json','utf8'));",
      "const fails=s.fails||[];const n=s.crashAfter===undefined?s.tests.length:s.crashAfter;",
      "console.log('TAP version 13');",
      "s.tests.slice(0,n).forEach((t,i)=>console.log((fails.includes(t)?'not ok ':'ok ')+(i+1)+' - '+t));",
      "if(s.crashAfter!==undefined) process.exit(1);",
      "if(s.plan) console.log('1..'+s.tests.length);",
      "process.exit(fails.length?2:0);",
    ].join('\n');
    function mkRepo(baseSpec, headSpec, extraCfg, files) {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'task/demo');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 't2.js'), T2);
      for (const k of Object.keys(files || {})) fs.writeFileSync(path.join(dir, k), files[k]);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(baseSpec));
      git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
      const base = git(dir, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
      fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(headSpec));
      git(dir, 'commit', '-q', '-am', 'head');
      fs.mkdirSync(path.join(dir, '.sereno'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: Object.assign({ command: 'node t2.js' }, extraCfg || {}) }));
      return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
    }
    const runT = (r) => S(r.dir, ['test', '--base', r.base, '--head', r.head, '--json']);
    const cacheFile = (r) => path.join(r.dir, '.sereno', 'cache', 'base-' + r.base + '.json');

    test('[4a-rf1] a head that crashes after one failing test no longer passes (completion evidence)', () => {
      const tests = ['A', 'B', 'C'];
      const r = mkRepo({ tests, fails: ['A'] }, { tests, fails: ['A'], crashAfter: 1 });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.strictEqual(out.note, 'head suite did not complete');
    });
    test('[4a-rf1] the same single failing test at base and head, full run, still passes; a plan missing at head does not', () => {
      const tests = ['A', 'B', 'C'];
      // Round 4 (intended behaviour change): with no plan and no TAP summary, a matching result count
      // is not proof of completion, so the same-failure plan-less run now goes to a decision.
      const ok = runT(mkRepo({ tests, fails: ['A'] }, { tests, fails: ['A'] })).out;
      assert.strictEqual(ok.passed, false); assert.strictEqual(ok.diagnosis, 'unknown_baseline');
      assert.strictEqual(ok.note, 'cannot confirm the head suite completed');
      const okPlan = runT(mkRepo({ tests, fails: ['A'], plan: true }, { tests, fails: ['A'], plan: true })).out;
      assert.strictEqual(okPlan.passed, true);
      const noPlan = runT(mkRepo({ tests, fails: ['A'], plan: true }, { tests, fails: ['A'], crashAfter: 3 })).out;
      assert.strictEqual(noPlan.passed, false); assert.strictEqual(noPlan.diagnosis, 'unknown_baseline');
    });
    test('[4a-rf1] non-TAP runner (FAIL lines, no counts or plan): a crashing head is unknown_baseline, never passed; exit 0 still passes', () => {
      const mkF = (crash) => {
        const r = mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node f.js' });
        fs.writeFileSync(path.join(r.dir, 'f.js'), "console.log('FAIL known one');" + (crash ? 'process.exit(1);' : 'process.exit(0);'));
        return r;
      };
      // base and head run the same f.js: FAIL known one, then exit 1
      const r = mkF(true);
      git(r.dir, 'add', 'f.js'); git(r.dir, 'commit', '-q', '-m', 'f');
      const head = git(r.dir, 'rev-parse', 'HEAD');
      // put f.js at the base too, by testing head against itself as the base
      const out = S(r.dir, ['test', '--base', head, '--head', head, '--json']).out;
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.strictEqual(out.note, 'cannot confirm the head suite completed');
      assert.deepStrictEqual(out.baseFailures, ['known one']);
      const ok = mkF(false);
      git(ok.dir, 'add', 'f.js'); git(ok.dir, 'commit', '-q', '-m', 'f');
      const h2 = git(ok.dir, 'rev-parse', 'HEAD');
      assert.strictEqual(S(ok.dir, ['test', '--base', h2, '--head', h2, '--json']).out.passed, true);
    });
    test('[4a-rf2] a planted failing base cache is ignored and the base recomputed', () => {
      const tests = ['A'];
      const r = mkRepo({ tests }, { tests, fails: ['A'] });
      assert.strictEqual(runT(r).out.diagnosis, 'defect');
      const planted = JSON.parse(fs.readFileSync(cacheFile(r), 'utf8'));
      assert.strictEqual(planted.suite.exitCode, 0, 'a passing base is what gets cached');
      planted.suite = { exitCode: 2, failures: ['A'], parsed: true, count: 1, plan: null };
      fs.writeFileSync(cacheFile(r), JSON.stringify(planted));
      const { out } = runT(r);
      assert.strictEqual(out.baseCached, false, 'the planted failing cache was ignored');
      assert.strictEqual(out.passed, false); assert.deepStrictEqual(out.newFailures, ['A']);
    });
    test('[4a-rf2] a failing base is never cached; a planted passing cache makes head failures count (defect)', () => {
      const tests = ['A'];
      const donor = mkRepo({ tests }, { tests, fails: ['A'] });
      runT(donor);
      const r = mkRepo({ tests, fails: ['A'], plan: true }, { tests, fails: ['A'], plan: true });
      assert.strictEqual(runT(r).out.passed, true);
      assert.ok(!fs.existsSync(cacheFile(r)), 'a failing base writes no cache');
      const planted = JSON.parse(fs.readFileSync(cacheFile(donor), 'utf8'));
      planted.sha = r.base;
      fs.writeFileSync(cacheFile(r), JSON.stringify(planted));
      const { out } = runT(r);
      assert.strictEqual(out.baseCached, true);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'defect');
    });
    test('[4a-rf3] gate --session: empty, unsubstituted, valid and junk values', () => {
      const dir = mk();
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'user.email', 't@example.invalid'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'init');
      fs.mkdirSync(path.join(dir, '.sereno', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.sereno', 'specs', 'x.md'), '---\ntask_id: x\n---\nspec\n');
      const head = git(dir, 'rev-parse', 'HEAD');
      const sess = (v) => {
        const r = S(dir, ['gate', '--stdin', '--task', 'x', '--base', head, '--head', head, '--branch', 'main', '--tests-passed', 'true', '--session', v], '{"outcome":"pass","findings":[]}');
        assert.strictEqual(r.out.ok, true, JSON.stringify(r.out));
        return JSON.parse(fs.readFileSync(path.join(dir, r.out.path), 'utf8')).session_id;
      };
      const uuid = '5f6c0d3e-1111-4222-8333-944455556666';
      assert.strictEqual(sess(''), null);
      assert.strictEqual(sess('${CLAUDE_SESSION_ID}'), null);
      assert.strictEqual(sess(uuid), uuid);
      assert.strictEqual(sess('a b;rm -rf'), null);
      assert.strictEqual(sess('x'.repeat(65)), null);
      assert.match(fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8'), /--session "\$\{CLAUDE_SESSION_ID\}"/);
    });
    test('[4a-rf4] a committed .sereno/ file that is modified does not wedge test or branch; a modified source file still does', () => {
      const tests = ['A'];
      const r = mkRepo({ tests }, { tests });
      fs.mkdirSync(path.join(r.dir, '.sereno', 'attempts'), { recursive: true });
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'x-1.json'), '{"a":1}\n');
      git(r.dir, 'add', '-f', '.sereno/attempts/x-1.json'); git(r.dir, 'commit', '-q', '-m', 'oops committed .sereno');
      const head = git(r.dir, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'x-1.json'), '{"a":2}\n');
      const t = S(r.dir, ['test', '--base', r.base, '--head', head, '--json']);
      assert.strictEqual(t.out.ok, true, JSON.stringify(t.out)); assert.strictEqual(t.out.passed, true);
      assert.strictEqual(S(r.dir, ['branch', '--task', 'again']).out.ok, true);
      fs.writeFileSync(path.join(r.dir, 'a.txt'), 'dirty\n');
      const t2 = S(r.dir, ['test', '--base', r.base, '--head', head, '--json']);
      assert.strictEqual(t2.out.ok, false); assert.strictEqual(t2.out.code, 'head_mismatch');
      assert.strictEqual(S(r.dir, ['branch', '--task', 'other']).out.code, 'dirty_tree');
    });
    test('[4a-rf4] builder agents forbid blanket staging and .sereno/; skills ignore .sereno/ in clean-tree checks; README advises', () => {
      for (const n of ['builder', 'builder-haiku', 'builder-opus']) {
        const t = fs.readFileSync(path.join(PLUGIN, 'agents', n + '.md'), 'utf8');
        assert.match(t, /Stage only the files you changed/); assert.match(t, /Never `git add -A`/); assert.match(t, /never stage anything under `\.sereno\/`/);
      }
      for (const n of ['build', 'ship']) {
        const t = fs.readFileSync(path.join(PLUGIN, 'skills', n, 'SKILL.md'), 'utf8');
        assert.ok(t.includes('/bin/sereno.js" clean'), n + ' uses sereno.js clean (round 2 replaced the raw git status)');
        assert.ok(!/status --porcelain --untracked-files=no`/.test(t), n + ' still has an unexcluded status check');
      }
      const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
      assert.match(readme, /\.sereno\/attempts\//); assert.match(readme, /add `\.sereno\/` to `\.gitignore`/);
    });
    await atest('[4a-rf5] the "parsed" regex has its backslashes: plain TAP lines are recognised', async () => {
      const d = mk();
      fs.writeFileSync(path.join(d, 'ok.js'), "console.log('ok 1 - fine');");
      const s = await testrun.runSuite('node ok.js', d, 30);
      assert.strictEqual(s.exitCode, 0); assert.strictEqual(s.parsed, true);
      assert.deepStrictEqual(testrun.parseCounts('TAP version 13\nok 1 - a\nnot ok 2 - b\n    ok 1 - nested\n1..2\n'), { count: 3, top: 2, plan: 2 });
    });
    await atest('[4a-rf6] worktree add/remove/prune use the longer timeout; prune runs after the temp dir is gone; a failed add leaves nothing', async () => {
      const calls = [];
      let wtPath = null;
      const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sereno-base-')).length;
      gitlib.setExec((cmd, args, opts) => {
        const i = args.indexOf('worktree');
        const sub = args[i + 1];
        const rec = { sub, timeout: opts.timeout };
        if (sub === 'add') {
          wtPath = args[args.indexOf('--detach') + 1];
          fs.mkdirSync(wtPath, { recursive: true }); // a partial checkout left by the slow add
          const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e;
        }
        if (sub === 'prune') rec.tmpGone = !fs.existsSync(path.dirname(wtPath));
        calls[calls.length] = rec;
        return '';
      });
      try {
        await assert.rejects(testrun.runAtBase(ROOT, 'a'.repeat(40), 'node -v', 5, null, 120), /worktree add failed/);
        await assert.rejects(testrun.runAtBase(ROOT, 'a'.repeat(40), 'node -v', 5, null), /worktree add failed/);
      } finally { gitlib.setExec(null); }
      assert.deepStrictEqual(calls.map((c) => c.sub), ['remove', 'prune', 'remove', 'prune']);
      assert.deepStrictEqual(calls.map((c) => c.timeout), [120000, 120000, 300000, 300000]);
      assert.ok(calls.filter((c) => c.sub === 'prune').every((c) => c.tmpGone), 'prune ran after the temp dir was removed');
      assert.strictEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sereno-base-')).length, before);
    });
    test('[4a-rf7] tests.timeoutSec and tests.worktreeTimeoutSec are capped at 2147483', () => {
      const cfg = (tests) => { const d = mk(); fs.mkdirSync(path.join(d, '.sereno')); fs.writeFileSync(path.join(d, '.sereno', 'pipeline.json'), JSON.stringify({ tests })); return d; };
      assert.strictEqual(loadConfig(cfg({ command: 'x', timeoutSec: 2147483, worktreeTimeoutSec: 2147483 })).config.tests.timeoutSec, 2147483);
      for (const k of ['timeoutSec', 'worktreeTimeoutSec']) {
        assert.throws(() => loadConfig(cfg({ command: 'x', [k]: 2147484 })), (e) => e.code === 'config_invalid');
        assert.throws(() => loadConfig(cfg({ command: 'x', [k]: 0 })), (e) => e.code === 'config_invalid');
      }
    });
    test('[4a-rf8] docs: node_modules link and .gitattributes trust are stated; auto-update wording', () => {
      const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
      assert.match(readme, /link \(a junction on Windows\) to the head working tree's `node_modules`/);
      assert.match(readme, /\.gitattributes` filters using your own git config/);
      assert.ok(readme.includes("Claude Code turns auto-update on by default only for Anthropic's own marketplaces, so for this one it is off unless you enable it in /plugin › Marketplaces."));
      const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', 'phase-4a-plugin.md'), 'utf8');
      assert.match(plan, /link\s+to the head working tree's `node_modules`/); assert.match(plan, /\.gitattributes/);
    });
    test('[4a-rf9] ship skill takes the fallback from roles.redTeam.fallback; null means never', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8');
      assert.ok(!/sereno:red-team-lean/.test(t), 'no hard-coded fallback agent');
      assert.match(t, /`roles\.redTeam\.fallback`/); assert.match(t, /is `null` there is no fallback: behave as `never`/);
    });
    test('[4a-rf10] git.js header lists the commands it runs', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'bin', 'lib', 'git.js'), 'utf8').split('*/')[0];
      for (const c of ['rev-parse', 'symbolic-ref', 'status', 'ls-tree', 'show', 'worktree add']) assert.ok(t.includes(c), c);
    });
    test('[4a-rf11] build skill step 5 requires the current branch to be task/<task>', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'skills', 'build', 'SKILL.md'), 'utf8');
      assert.match(t, /git branch --show-current/); assert.match(t, /current branch\nis still `task\/<task>`/);
    });

    /* ---- Phase 4a: red-team round 2 ---- */
    const commitAll = (dir, msg) => { git(dir, 'add', '-f', '.'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
    test('[4a-r2-1] a flaky "re-run" where the head crashes both times is not passed (headCompletion on both runs)', () => {
      const FLK = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - X\\nnot ok 2 - M\\nok 3 - Y\\n1..3');process.exit(1);}",
        "let n=0;try{n=+fs.readFileSync('counter.txt','utf8')}catch(e){}fs.writeFileSync('counter.txt',String(n+1));",
        "if(n===0){console.log('ok 1 - X\\nnot ok 2 - M\\nnot ok 3 - N');process.exit(1);}",
        "console.log('not ok 2 - M');process.exit(1);",
      ].join('\n');
      const r = mkRepo({ tests: ['X'] }, { tests: ['X'] }, { command: 'node flk.js' }, { 'flk.js': FLK });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.strictEqual(out.note, 'head suite did not complete');
    });
    test('[4a-r2-1] a genuinely flaky failure (both head runs complete, re-run passes) still passes', () => {
      const FLK = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - X\\nok 2 - Y\\n1..2');process.exit(0);}",
        "let n=0;try{n=+fs.readFileSync('counter.txt','utf8')}catch(e){}fs.writeFileSync('counter.txt',String(n+1));",
        "if(n===0){console.log('ok 1 - X\\nnot ok 2 - Y\\n1..2');process.exit(1);}",
        "console.log('ok 1 - X\\nok 2 - Y\\n1..2');",
      ].join('\n');
      const r = mkRepo({ tests: ['X', 'Y'] }, { tests: ['X', 'Y'] }, { command: 'node flk.js' }, { 'flk.js': FLK });
      const { out } = runT(r);
      assert.strictEqual(out.passed, true, JSON.stringify(out)); assert.deepStrictEqual(out.flaky, ['Y']);
    });
    test('[4a-r2-2] clean check: tracked .sereno/pipeline.json and specs/ count; generated dirs do not', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      fs.mkdirSync(path.join(r.dir, '.sereno', 'attempts'), { recursive: true });
      fs.mkdirSync(path.join(r.dir, '.sereno', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'x-1.json'), '{"a":1}\n');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'specs', 'x.md'), 'spec one\n');
      const head = commitAll(r.dir, 'track .sereno');
      assert.strictEqual(S(r.dir, ['clean']).out.clean, true);
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'x-1.json'), '{"a":2}\n');
      assert.strictEqual(S(r.dir, ['clean']).out.clean, true, 'generated dir change ignored');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'pipeline.json'), JSON.stringify({ tests: { command: 'node t2.js', timeoutSec: 5 } }));
      const c = S(r.dir, ['clean']).out;
      assert.strictEqual(c.clean, false); assert.deepStrictEqual(c.files, ['.sereno/pipeline.json']);
      const t = S(r.dir, ['test', '--base', r.base, '--head', head, '--json']);
      assert.strictEqual(t.out.code, 'head_mismatch');
      assert.strictEqual(S(r.dir, ['branch', '--task', 'zz']).out.code, 'dirty_tree');
      git(r.dir, 'checkout', '--', '.sereno/pipeline.json');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'specs', 'x.md'), 'spec two\n');
      assert.deepStrictEqual(S(r.dir, ['clean']).out.files, ['.sereno/specs/x.md']);
    });
    test('[4a-r2-2] spec pin: attempt records spec_hash; test and gate refuse spec_changed after an edit', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      const specPath = path.join(r.dir, '.sereno', 'specs', 'demo.md');
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, 'criteria one\n');
      const at = S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'built', '--spec', '.sereno/specs/demo.md']).out;
      assert.strictEqual(at.ok, true, JSON.stringify(at));
      const hash = 'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(specPath)).digest('hex');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, at.path), 'utf8')).spec_hash, hash);
      const VERDICT = JSON.stringify({ outcome: 'pass', findings: [], context_requests: [] });
      const gateArgs = ['gate', '--stdin', '--task', 'demo', '--base', r.base, '--head', r.head, '--branch', 'task/demo', '--tests-passed', 'true'];
      const g = S(r.dir, gateArgs, VERDICT).out;
      assert.strictEqual(g.ok, true, JSON.stringify(g));
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, g.path), 'utf8')).spec_hash, hash, 'gate records the pinned hash');
      assert.strictEqual(S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]).out.ok, true);
      fs.writeFileSync(specPath, 'criteria two\n');
      const t = S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]);
      assert.strictEqual(t.out.code, 'spec_changed'); assert.notStrictEqual(t.status, 0);
      assert.strictEqual(S(r.dir, gateArgs, VERDICT).out.code, 'spec_changed');
      assert.strictEqual(S(r.dir, ['attempt', '--task', 'demo', '--spec-hash', 'zz']).out.code, 'invalid_arg');
    });
    test('[4a-r2-3] sereno.js clean from a subdirectory reports a dirty tracked file at the repo root', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      const sub = path.join(r.dir, 'deep', 'er'); fs.mkdirSync(sub, { recursive: true });
      assert.strictEqual(S(sub, ['clean', '--json']).out.clean, true);
      fs.writeFileSync(path.join(r.dir, 'a.txt'), 'dirty\n');
      const c = S(sub, ['clean', '--json']).out;
      assert.strictEqual(c.ok, true); assert.strictEqual(c.clean, false); assert.deepStrictEqual(c.files, ['a.txt']);
    });
    test('[4a-r2-3] build and ship skills use sereno.js clean, not a raw git status', () => {
      for (const n of ['build', 'ship']) {
        const t = fs.readFileSync(path.join(PLUGIN, 'skills', n, 'SKILL.md'), 'utf8');
        assert.ok(t.includes('/bin/sereno.js" clean'), n); assert.ok(!/git [^\n]*status/.test(t), n + ' still has git status');
      }
      assert.match(fs.readFileSync(path.join(PLUGIN, 'skills', 'build', 'SKILL.md'), 'utf8'), /--spec \.sereno\/specs\/<task>\.md/);
    });
    await atest('[4a-r2-4] the sequential path passes tests.worktreeTimeoutSec to the base worktree git calls', async () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] }, { worktreeTimeoutSec: 77 });
      const { createSafeFs } = require('../plugin/bin/lib/fsafe.js');
      const seen = [];
      gitlib.setExec((cmd, args, opts) => {
        if (args.includes('worktree')) {
          seen[seen.length] = opts.timeout;
          if (args.includes('add')) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
          return '';
        }
        return execFileSync(cmd, args, opts);
      });
      try {
        const { config, config_hash } = loadConfig(r.dir);
        await assert.rejects(testrun.runTests({ root: r.dir, fsafe: createSafeFs(r.dir), config, configHash: config_hash, base: r.base, head: r.head, runId: 'rr_20260101T000000Z_abcdef0' }), /worktree add failed/);
      } finally { gitlib.setExec(null); }
      assert.ok(seen.length >= 2 && seen.every((t) => t === 77000), JSON.stringify(seen));
    });
    test('[4a-r2-5] tapValid: repeated numbers, a plan with results after it, and two plans are not completion evidence', () => {
      assert.strictEqual(testrun.tapValid('ok 1 - a\nok 2 - b\n1..2\n'), true);
      assert.strictEqual(testrun.tapValid('1..2\nok 1 - a\nok 2 - b\n'), true);
      assert.strictEqual(testrun.tapValid('ok 1 - a\nok 1 - b\n'), false);
      assert.strictEqual(testrun.tapValid('ok 1 - a\n1..2\nok 2 - b\n'), false);
      assert.strictEqual(testrun.tapValid('ok 1 - a\n1..1\n1..1\n'), false);
      assert.strictEqual(testrun.tapValid('ok 1 - a\n    ok 1 - nested\nok 2 - b\n1..2\n'), true, 'nested numbering is not top level');
    });
    test('[4a-r2-5] a failing head with repeated test numbers is never passed, even when its failures are known at base', () => {
      const DUP = [
        "if(process.cwd().includes('sereno-base-')){console.log('not ok 1 - A\\nok 2 - B\\nok 3 - C');process.exit(1);}",
        "console.log('not ok 1 - A\\nok 1 - B\\nok 1 - C');process.exit(1);",
      ].join('\n');
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node dup.js' }, { 'dup.js': DUP });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.match(fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8'), /deliberately prints fake\s+TAP lines can still mislead the count/);
    });
    test('[4a-r2-6] sweepStale removes an old plugin base dir without following its node_modules junction; fresh and unmarked dirs stay', () => {
      const sentinel = mk(); fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'keep');
      const tmpRoot = fs.realpathSync.native(os.tmpdir());
      const mkBase = (marked) => {
        const d = fs.mkdtempSync(path.join(tmpRoot, 'sereno-base-'));
        fs.mkdirSync(path.join(d, 'wt'));
        if (marked) fs.writeFileSync(path.join(d, '.sereno-plugin-base'), 'x');
        return d;
      };
      const stale = mkBase(true), fresh = mkBase(true), unmarked = mkBase(false);
      fs.symlinkSync(sentinel, path.join(stale, 'wt', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const old = new Date(Date.now() - 2 * 3600 * 1000);
      fs.utimesSync(path.join(stale, '.sereno-plugin-base'), old, old);
      fs.utimesSync(path.join(unmarked, 'wt'), old, old);
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      try {
        assert.ok(testrun.sweepStale(r.dir) >= 1);
        assert.strictEqual(fs.existsSync(stale), false, 'stale dir gone');
        assert.strictEqual(fs.readFileSync(path.join(sentinel, 'keep.txt'), 'utf8'), 'keep', 'the junction target survives');
        assert.strictEqual(fs.existsSync(fresh), true); assert.strictEqual(fs.existsSync(unmarked), true);
      } finally { for (const d of [stale, fresh, unmarked]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } } }
    });
    test('[4a-r2-6] ship skill runs sereno.js test with a task (the Bash timeout advice moved to round 3: background run)', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8');
      assert.match(t, /test --task <task> --base/);
    });
    test('[4a-r2-7] git.js header lists every git verb the plugin runs', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'bin', 'lib', 'git.js'), 'utf8').split('*/')[0];
      for (const c of ['rev-parse', 'symbolic-ref', 'status', 'merge-base', 'ls-tree', 'show-ref', 'branch', 'worktree add', 'list', 'remove', 'prune', '--version']) assert.ok(t.includes(c), c);
    });
    /* ---- Phase 4a: red-team round 3 ---- */
    const COUNTER = "let n=0;try{n=+fs.readFileSync('counter.txt','utf8')}catch(e){}fs.writeFileSync('counter.txt',String(n+1));";
    test('[4a-r3-1] alternating failures (run1 not ok A, run2 not ok B, both complete, base clean) are a defect with both names', () => {
      const ALT = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - A\\nok 2 - B\\n1..2');process.exit(0);}",
        COUNTER,
        "if(n===0){console.log('not ok 1 - A\\nok 2 - B\\n1..2');process.exit(1);}",
        "console.log('ok 1 - A\\nnot ok 2 - B\\n1..2');process.exit(1);",
      ].join('\n');
      const r = mkRepo({ tests: ['A', 'B'] }, { tests: ['A', 'B'] }, { command: 'node alt.js' }, { 'alt.js': ALT });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false, JSON.stringify(out)); assert.strictEqual(out.diagnosis, 'defect');
      assert.deepStrictEqual(out.newFailures, ['A', 'B']); assert.deepStrictEqual(out.flaky, []);
    });
    test('[4a-r3-1] a genuinely flaky test (fails once, whole re-run clean and complete) passes with flaky [A]', () => {
      const FL = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - A\\nok 2 - B\\n1..2');process.exit(0);}",
        COUNTER,
        "if(n===0){console.log('not ok 1 - A\\nok 2 - B\\n1..2');process.exit(1);}",
        "console.log('ok 1 - A\\nok 2 - B\\n1..2');",
      ].join('\n');
      const r = mkRepo({ tests: ['A', 'B'] }, { tests: ['A', 'B'] }, { command: 'node fl.js' }, { 'fl.js': FL });
      const { out } = runT(r);
      assert.strictEqual(out.passed, true, JSON.stringify(out)); assert.deepStrictEqual(out.flaky, ['A']); assert.deepStrictEqual(out.newFailures, []);
    });
    test('[4a-r3-1] a re-run that exits 0 but did not complete is not a pass', () => {
      const CUT = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - A\\nok 2 - B\\n1..2');process.exit(0);}",
        COUNTER,
        "if(n===0){console.log('not ok 1 - A\\nok 2 - B\\n1..2');process.exit(1);}",
        "console.log('ok 1 - A');",
      ].join('\n');
      const r = mkRepo({ tests: ['A', 'B'] }, { tests: ['A', 'B'] }, { command: 'node cut.js' }, { 'cut.js': CUT });
      const { out } = runT(r);
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
    });
    test('[4a-r3-1] a base-known failure that persists in a complete head run passes; an incomplete one does not', () => {
      const tests = ['A', 'B', 'C'];
      const ok = runT(mkRepo({ tests, fails: ['A'], plan: true }, { tests, fails: ['A'], plan: true })).out;
      assert.strictEqual(ok.passed, true); assert.deepStrictEqual(ok.baseFailures, ['A']);
      const cut = runT(mkRepo({ tests, fails: ['A'], plan: true }, { tests, fails: ['A'], crashAfter: 2 })).out;
      assert.strictEqual(cut.passed, false); assert.strictEqual(cut.diagnosis, 'unknown_baseline');
    });
    test('[4a-r3-2] parseFailures: U+2716 marker, trailing durations, summary headers; Jest and TAP lines', () => {
      const spec = ['✔ passes (0.5ms)', '✖ adds numbers (1.2345ms)', '  AssertionError: x', 'ℹ tests 2', '✖ failing tests:', '', 'test at x.test.js:1:1', '✖ adds numbers (1.2345ms)'].join('\n');
      assert.deepStrictEqual(testrun.parseFailures(spec), ['adds numbers']);
      const jest = ['  ✕ does a thing (3 ms)', '  ✕ slow one (12.5 s)', '  FAIL  src/a.test.js', '  ✓ fine (1 ms)'].join('\n');
      assert.deepStrictEqual(testrun.parseFailures(jest), ['does a thing', 'slow one', 'src/a.test.js']);
      assert.deepStrictEqual(testrun.parseFailures('not ok 1 - tap one\nok 2 - fine\n  not ok 1 - nested\n1..2'), ['tap one', 'nested']);
      assert.deepStrictEqual(testrun.parseFailures('✗ old style'), ['old style']);
    });
    test('[4a-r3-2] a real node --test run with a failing test is read in names mode, without the duration', () => {
      const NT = "const test=require('node:test');const assert=require('node:assert');const s=require('./spec.json');\ntest('works', () => assert.strictEqual(s.v, 1));\ntest('other', () => {});\n";
      const r = mkRepo({ v: 1 }, { v: 2 }, { command: 'node --test' }, { 'x.test.js': NT });
      const { out } = runT(r);
      assert.strictEqual(out.mode, 'names', JSON.stringify(out)); assert.strictEqual(out.passed, false);
      assert.strictEqual(out.diagnosis, 'defect'); assert.deepStrictEqual(out.newFailures, ['works']);
      const tap = runT(mkRepo({ v: 1 }, { v: 2 }, { command: 'node --test --test-reporter=tap' }, { 'x.test.js': NT })).out;
      assert.strictEqual(tap.mode, 'names'); assert.deepStrictEqual(tap.newFailures, ['works']);
      assert.match(fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8'), /--test-reporter=tap/);
    });
    const mkPinned = () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      const specPath = path.join(r.dir, '.sereno', 'specs', 'demo.md');
      fs.mkdirSync(path.dirname(specPath), { recursive: true }); fs.writeFileSync(specPath, 'criteria\n');
      const at = S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'built', '--spec', '.sereno/specs/demo.md']).out;
      assert.strictEqual(at.ok, true, JSON.stringify(at));
      return { r, specPath, at };
    };
    test('[4a-r3-3] after a pinned attempt, a new attempt without --spec/--spec-hash is refused (spec_required)', () => {
      const { r } = mkPinned();
      const bad = S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'fix', '--outcome', 'running']);
      assert.strictEqual(bad.out.code, 'spec_required'); assert.notStrictEqual(bad.status, 0);
      assert.strictEqual(S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'fix', '--outcome', 'running', '--spec', '.sereno/specs/demo.md']).out.attempt, 2);
      git(r.dir, 'checkout', '-q', '-b', 'task/other');
      assert.strictEqual(S(r.dir, ['attempt', '--task', 'other', '--builder', 'sonnet', '--kind', 'fix', '--outcome', 'running']).out.ok, true, 'another task is unaffected');
    });
    test('[4a-r3-3] on a task branch with attempt records, test and gate without --task are refused (task_required)', () => {
      const { r } = mkPinned();
      const t = S(r.dir, ['test', '--base', r.base, '--head', r.head]);
      assert.strictEqual(t.out.code, 'task_required'); assert.notStrictEqual(t.status, 0);
      const g = S(r.dir, ['gate', '--stdin', '--base', r.base, '--head', r.head, '--tests-passed', 'true'], '{"outcome":"pass"}');
      assert.strictEqual(g.out.code, 'task_required');
      assert.strictEqual(S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]).out.ok, true);
      const fresh = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      assert.strictEqual(S(fresh.dir, ['test', '--base', fresh.base, '--head', fresh.head]).out.ok, true, 'no attempts: --task stays optional');
    });
    test('[4a-r3-3] a malformed spec_hash in the newest pinned attempt is refused; an attempt with no hash is skipped for the pin', () => {
      const { r, specPath, at } = mkPinned();
      const rec1 = JSON.parse(fs.readFileSync(path.join(r.dir, at.path), 'utf8'));
      const no = Object.assign({}, rec1, { attempt: 2 }); delete no.spec_hash;
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'demo-2.json'), JSON.stringify(no));
      assert.strictEqual(S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]).out.ok, true, 'attempt 1 still pins');
      fs.writeFileSync(specPath, 'criteria edited\n');
      assert.strictEqual(S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]).out.code, 'spec_changed', 'edit detected through the older pinned attempt');
      fs.writeFileSync(specPath, 'criteria\n');
      fs.writeFileSync(path.join(r.dir, '.sereno', 'attempts', 'demo-3.json'), JSON.stringify(Object.assign({}, rec1, { attempt: 3, spec_hash: 'garbage' })));
      assert.strictEqual(S(r.dir, ['test', '--task', 'demo', '--base', r.base, '--head', r.head]).out.code, 'spec_changed');
      assert.strictEqual(S(r.dir, ['gate', '--stdin', '--task', 'demo', '--base', r.base, '--head', r.head, '--tests-passed', 'true'], '{"outcome":"pass"}').out.code, 'spec_changed');
    });
    test('[4a-r3-3] [4a-r3-4] ship skill spells out --spec on repeat attempts, --task on test and gate, and runs the suite in the background', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'skills', 'ship', 'SKILL.md'), 'utf8');
      assert.ok(!/exactly as `\/sereno:build` does/.test(t));
      assert.match(t, /attempt --task <task> --spec-revision[^\n]*--spec \.sereno\/specs\/<task>\.md/);
      assert.match(t, /sereno\.js" test --task <task> --base/); assert.match(t, /sereno\.js" gate --file [^ ]+ --task <task>/);
      assert.match(t, /foreground with a Bash `timeout` of 600000/); assert.match(t, /`run_in_background: true`/);
      assert.ok(!/timeoutSec` lower/.test(t), 'the "lower timeoutSec in .sereno/pipeline.json" advice is gone');
      assert.match(t, /~\/\.sereno\/pipeline\.json/);
    });
    test('[4a-r3-5] sweepStale removes a stale base dir whose wt/node_modules is a real directory; a junction target still survives', () => {
      const tmpRoot = fs.realpathSync.native(os.tmpdir());
      const d = fs.mkdtempSync(path.join(tmpRoot, 'sereno-base-'));
      fs.mkdirSync(path.join(d, 'wt', 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(d, 'wt', 'node_modules', 'pkg', 'i.js'), 'x');
      fs.writeFileSync(path.join(d, '.sereno-plugin-base'), 'x');
      const old = new Date(Date.now() - 2 * 3600 * 1000);
      fs.utimesSync(path.join(d, '.sereno-plugin-base'), old, old);
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      try {
        assert.ok(testrun.sweepStale(r.dir) >= 1);
        assert.strictEqual(fs.existsSync(d), false, 'the stale dir with a real node_modules is gone');
      } finally { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
    });
    test('[4a-r3-6] README states the deleted-test and chained-TAP outcomes', () => {
      const t = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
      assert.match(t, /delete tests while a base failure persists/); assert.match(t, /chains two TAP producers/);
    });
    /* ---- Phase 4a: red-team round 4 ---- */
    test('[4a-r4-1] plan-less runner: base fails A, head prints the same three lines then crashes: not passed', () => {
      const tests = ['A', 'B', 'C'];
      const { out } = runT(mkRepo({ tests, fails: ['A'] }, { tests, fails: ['A'], crashAfter: 3 }));
      assert.strictEqual(out.passed, false); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.strictEqual(out.note, 'cannot confirm the head suite completed');
    });
    test('[4a-r4-1] plan-less runner with a consistent TAP summary on a complete head passes (excused); an inconsistent summary does not', () => {
      const mkS = (n) => [
        "console.log('not ok 1 - A\\nok 2 - B\\nok 3 - C\\n# tests " + n + "\\n# pass 2\\n# fail 1');process.exit(2);",
      ].join('\n');
      const good = mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node sm.js' }, { 'sm.js': mkS(3) });
      const o = runT(good).out;
      assert.strictEqual(o.passed, true, JSON.stringify(o)); assert.strictEqual(o.diagnosis, 'none'); assert.deepStrictEqual(o.baseFailures, ['A']);
      const bad = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node sm.js' }, { 'sm.js': mkS(5) })).out;
      assert.strictEqual(bad.passed, false); assert.strictEqual(bad.diagnosis, 'unknown_baseline');
    });
    test('[4a-r4-2] --task must match the task/<x> branch for test, gate and attempt (branch_mismatch)', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      const t = S(r.dir, ['test', '--task', 'other', '--base', r.base, '--head', r.head]);
      assert.strictEqual(t.out.code, 'branch_mismatch'); assert.notStrictEqual(t.status, 0);
      const g = S(r.dir, ['gate', '--stdin', '--task', 'other', '--base', r.base, '--head', r.head, '--tests-passed', 'true'], '{"outcome":"pass"}');
      assert.strictEqual(g.out.code, 'branch_mismatch');
      const a = S(r.dir, ['attempt', '--task', 'other', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'built']);
      assert.strictEqual(a.out.code, 'branch_mismatch');
      assert.strictEqual(S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'built']).out.ok, true);
    });
    test('[4a-r4-3] 201 base failures plus one new head failure: the capped run is unparsed, not truncated and excused', () => {
      const CAP = [
        "const base=process.cwd().includes('sereno-base-');const n=base?201:202;",
        "for(let i=1;i<=n;i++)console.log('not ok '+i+' - f'+i);process.exit(1);",
      ].join('\n');
      const { out } = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node cap.js' }, { 'cap.js': CAP }));
      assert.strictEqual(out.passed, false, JSON.stringify(out)); assert.strictEqual(out.mode, 'exit-code');
      assert.strictEqual(out.diagnosis, 'unknown_baseline');
    });
    test('[4a-r4-4] a silent exit-0 re-run after a failing head is not a flaky pass', () => {
      const SIL = [
        "const fs=require('fs');",
        "if(process.cwd().includes('sereno-base-')){console.log('all fine');process.exit(0);}",
        COUNTER,
        "if(n===0){console.log('not ok 1 - A');process.exit(1);}",
        "console.log('all fine');",
      ].join('\n');
      const { out } = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node sil.js' }, { 'sil.js': SIL }));
      assert.strictEqual(out.passed, false, JSON.stringify(out)); assert.strictEqual(out.diagnosis, 'unknown_baseline');
      assert.deepStrictEqual(out.flaky, []);
    });
    /* ---- Phase 4a: final fixes ---- */
    const mkEx = (headFirst, rerun) => [
      "const fs=require('fs');",
      "if(process.cwd().includes('sereno-base-')){console.log('ok 1 - A\\nok 2 - B\\nok 3 - C\\n1..3');process.exit(0);}",
      COUNTER,
      "if(n===0){" + headFirst + "}",
      rerun,
    ].join('\n');
    test('[4a-final-1] exit-code mode: capped head (201 not ok), silent exit-0 re-run is not a flaky pass', () => {
      const SC = mkEx("for(let i=1;i<=201;i++)console.log('not ok '+i+' - f'+i);process.exit(1);", "console.log('quiet');");
      const { out } = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node ex.js' }, { 'ex.js': SC }));
      assert.strictEqual(out.mode, 'exit-code'); assert.strictEqual(out.passed, false, JSON.stringify(out));
      assert.strictEqual(out.diagnosis, 'unknown_baseline'); assert.deepStrictEqual(out.flaky, []);
      assert.strictEqual(out.note, 'cannot confirm the re-run completed');
    });
    test('[4a-final-1] exit-code mode: stack trace head, silent exit-0 re-run is not a flaky pass', () => {
      const SC = mkEx("console.log('ok 1 - A');console.error('Error: boom\\n    at x (y.js:1:1)');process.exit(1);", "console.log('quiet');");
      const { out } = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node ex.js' }, { 'ex.js': SC }));
      assert.strictEqual(out.mode, 'exit-code'); assert.strictEqual(out.passed, false, JSON.stringify(out));
      assert.strictEqual(out.diagnosis, 'unknown_baseline'); assert.deepStrictEqual(out.flaky, []);
    });
    test('[4a-final-1] exit-code mode: a genuine full exit-0 re-run is still a flaky pass', () => {
      const SC = mkEx("console.log('ok 1 - A');console.error('Error: boom\\n    at x (y.js:1:1)');process.exit(1);", "console.log('ok 1 - A\\nok 2 - B\\nok 3 - C\\n1..3');");
      const { out } = runT(mkRepo({ tests: ['A'] }, { tests: ['A'] }, { command: 'node ex.js' }, { 'ex.js': SC }));
      assert.strictEqual(out.passed, true, JSON.stringify(out)); assert.deepStrictEqual(out.flaky, ['(whole suite)']);
    });
    test('[4a-final-2] parseSummary: footer before results, or two footers, is unknown; footer after the last result counts', () => {
      assert.strictEqual(testrun.parseSummary('# tests 2\n# pass 2\n# fail 0\nok 1 - A\nok 2 - B\n').summary, null);
      assert.strictEqual(testrun.parseSummary('ok 1 - A\nok 2 - B\n# tests 2\n# pass 2\n# fail 0\n# tests 2\n').summary, null);
      assert.deepStrictEqual(testrun.parseSummary('ok 1 - A\nok 2 - B\n# tests 2\n# pass 2\n# fail 0\n').summary, { tests: 2, pass: 2, fail: 0 });
    });
    test('[4a-final-3] gate --task y --branch main on task/x is branch_mismatch', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      git(r.dir, 'branch', '-m', 'task/x');
      const g = S(r.dir, ['gate', '--stdin', '--task', 'y', '--branch', 'main', '--base', r.base, '--head', r.head, '--tests-passed', 'true'], '{"outcome":"pass"}');
      assert.strictEqual(g.out.code, 'branch_mismatch'); assert.strictEqual(g.status, 16);
    });
    test('[4a-final-4] on task/demo with attempt records, gate --branch main without --task is task_required', () => {
      const r = mkRepo({ tests: ['A'] }, { tests: ['A'] });
      assert.strictEqual(S(r.dir, ['attempt', '--task', 'demo', '--builder', 'sonnet', '--kind', 'feature', '--outcome', 'built']).out.ok, true);
      const g = S(r.dir, ['gate', '--stdin', '--branch', 'main', '--base', r.base, '--head', r.head, '--tests-passed', 'true'], '{"outcome":"pass"}');
      assert.strictEqual(g.out.code, 'task_required'); assert.strictEqual(g.status, 19);
    });
    for (const d of tmps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ } }
    /* ---- Phase 4a: bash tool rule ---- */
    {
      const skillsDir = path.join(ROOT, 'plugin', 'skills');
      for (const d of fs.readdirSync(skillsDir)) {
        test('[4a-bash] skill ' + d + ': Bash-tool rule present, allowed-tools has Bash and not PowerShell', () => {
          const t = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8');
          const m = t.match(/^allowed-tools:\s*(.*)$/m);
          assert.ok(m, 'allowed-tools');
          const tools = m[1].split(',').map((s) => s.trim());
          assert.ok(tools.includes('Bash'));
          assert.ok(!tools.some((s) => /powershell/i.test(s)));
          assert.ok(/## How to run commands/.test(t));
          assert.ok(/with the Bash tool, never PowerShell or cmd/.test(t));
        });
      }
    }
  }

  /* ---- Phase 4a: handoff hardening ---- */
  {
    const { createSafeFs } = require('../plugin/bin/lib/fsafe.js');
    const SERENO = path.join(ROOT, 'plugin', 'bin', 'sereno.js');
    const { spawnSync } = require('node:child_process');
    const mk = () => {
      const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4hh-')));
      fs.mkdirSync(path.join(d, '.sereno', 'cache'), { recursive: true });
      return d;
    };
    test('[4a-harden] readFile and removeFile refuse a hard-linked file; both files untouched', () => {
      const d = mk(); const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4ho-')));
      const victim = path.join(outside, 'victim.txt');
      fs.writeFileSync(victim, 'secret');
      const inside = path.join(d, '.sereno', 'cache', 'verdict-rr_h.json');
      try { fs.linkSync(victim, inside); } catch (_e) { return; } // OS refuses hard links
      const f = createSafeFs(d);
      for (const op of [() => f.readFile('.sereno/cache/verdict-rr_h.json', 1000), () => f.removeFile('.sereno/cache/verdict-rr_h.json')]) {
        assert.throws(op, (e) => e.code === 'path_refused');
      }
      assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'secret');
      assert.strictEqual(fs.readFileSync(inside, 'utf8'), 'secret');
      for (const x of [d, outside]) fs.rmSync(x, { recursive: true, force: true });
    });
    test('[4a-harden] readFile reads normally from the fd, enforces the cap, and refuses a swapped target', () => {
      const d = mk();
      fs.writeFileSync(path.join(d, '.sereno', 'cache', 'a.json'), 'hello');
      const f = createSafeFs(d);
      assert.strictEqual(f.readFile('.sereno/cache/a.json', 1000).toString('utf8'), 'hello');
      assert.throws(() => f.readFile('.sereno/cache/a.json', 3), (e) => e.code === 'path_refused');
      // Simulate a swap between lstat and open: fstat reports a different inode than lstat did.
      const real = fs.fstatSync;
      fs.fstatSync = (fd, o) => { const s = real(fd, o); return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: s.ino + 1n }); };
      try { assert.throws(() => f.readFile('.sereno/cache/a.json', 1000), (e) => e.code === 'path_refused'); }
      finally { fs.fstatSync = real; }
      assert.strictEqual(f.readFile('.sereno/cache/a.json', 1000).toString('utf8'), 'hello');
      fs.rmSync(d, { recursive: true, force: true });
    });
    test('[4a-harden] gate requires --run-id to end with _<first 7 hex of --head>; paths gives cacheDir', () => {
      const d = mk();
      const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4hhh-')));
      const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
      const head = g('rev-parse', 'HEAD');
      const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
      const run = (...a) => JSON.parse(spawnSync(process.execPath, [SERENO, ...a], { cwd: d, encoding: 'utf8', env }).stdout);
      const wrongHex = head.slice(0, 7) === '0000000' ? '1111111' : '0000000';
      const args = (id) => ['gate', '--stdin', '--task', 'hh', '--base', head, '--head', head, '--branch', 'main', '--run-id', id, '--tests-passed', 'true'];
      const bad = spawnSync(process.execPath, [SERENO, ...args('rr_20260101T000000Z_' + wrongHex)], { cwd: d, encoding: 'utf8', env, input: '{"outcome":"pass"}' });
      const badOut = JSON.parse(bad.stdout);
      assert.strictEqual(badOut.code, 'invalid_arg', bad.stdout);
      const upper = spawnSync(process.execPath, [SERENO, ...args('rr_20260101T000000Z_' + head.slice(0, 7).toUpperCase())], { cwd: d, encoding: 'utf8', env, input: '{"outcome":"pass"}' });
      assert.strictEqual(JSON.parse(upper.stdout).code, 'invalid_arg', 'RUN_ID format is lowercase hex');
      const p = run('paths');
      assert.strictEqual(p.cacheDir, path.join(d, '.sereno', 'cache').split(path.sep).join('/'));
      assert.ok(!p.cacheDir.includes(String.fromCharCode(92)));
      for (const x of [d, home]) fs.rmSync(x, { recursive: true, force: true });
    });
    test('[4a-relcache] paths gives an absolute cacheDir spelled from cwd; gate/spec accept it and tricky paths are handled', () => {
      const d = mk();
      const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4rc-')));
      const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
      const head = g('rev-parse', 'HEAD'); const h7 = head.slice(0, 7);
      const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
      const run = (cwd, ...a) => JSON.parse(spawnSync(process.execPath, [SERENO, ...a], { cwd, encoding: 'utf8', env }).stdout);
      const fwd = (x) => x.split(path.sep).join('/');
      const cache = path.join(d, '.sereno', 'cache'); fs.mkdirSync(cache, { recursive: true });
      const sub = path.join(d, 'pkg', 'deep'); fs.mkdirSync(sub, { recursive: true });
      const want = fwd(cache);
      assert.strictEqual(run(d, 'paths').cacheDir, want);
      assert.strictEqual(run(sub, 'paths').cacheDir, want);
      assert.strictEqual(run(cache, 'paths').cacheDir, want, 'cwd == cache dir gives the dir itself, not empty');
      assert.strictEqual(run(path.join(d, '.sereno'), 'paths').cacheDir, want);
      // cwd spelled with different case than git's toplevel (Windows only): prefix keeps cwd's spelling
      let cwds = [sub];
      if (process.platform === 'win32') {
        const flip = (x) => x.replace(/sereno-p4hh/i, (m) => m === m.toLowerCase() ? m.toUpperCase() : m.toLowerCase());
        const alt = flip(sub); assert.notStrictEqual(alt, sub); cwds = [sub, alt];
        assert.strictEqual(run(alt, 'paths').cacheDir, fwd(flip(cache)));
        assert.notStrictEqual(fwd(flip(cache)), want);
      }
      let n = 0;
      const putSpec = (task) => fs.writeFileSync(path.join(cache, 'spec-' + task + '.md'), '## Goal\nchange a\n');
      const specArgs = (task, f) => ['spec', '--task', task, '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--body-file', f];
      for (const cwd of cwds) {
        const p = run(cwd, 'paths');
        assert.ok(path.isAbsolute(p.cacheDir));
        const task = 'rc' + (n++);
        putSpec(task);
        const sp = run(cwd, ...specArgs(task, p.cacheDir + '/spec-' + task + '.md'));
        assert.strictEqual(sp.ok, true, JSON.stringify(sp));
        assert.ok(!fs.existsSync(path.join(cache, 'spec-' + task + '.md')));
        const id = 'rr_2026010' + n + 'T000000Z_' + h7;
        fs.writeFileSync(path.join(cache, 'verdict-' + id + '.json'), '{"outcome":"pass","findings":[]}');
        const gt = run(cwd, 'gate', '--file', p.cacheDir + '/verdict-' + id + '.json', '--task', task, '--base', head, '--head', head, '--branch', 'main', '--run-id', id, '--tests-passed', 'true');
        assert.strictEqual(gt.ok, true, JSON.stringify(gt));
      }
      // an absolute arg inside the cache is accepted (native separators too)
      putSpec('rcabs');
      assert.strictEqual(run(sub, ...specArgs('rcabs', path.join(cache, 'spec-rcabs.md'))).ok, true);
      // refused: outside the cache, other drive, \\?\ namespace form
      fs.writeFileSync(path.join(sub, 'spec-zz.md'), 'x');
      const refused = [['spec-zz.md'], [path.join(sub, 'spec-zz.md')]];
      if (process.platform === 'win32') {
        const drive = path.parse(d).root[0].toUpperCase();
        const other = 'ABDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((c) => c !== drive && c !== 'C') || 'Z';
        refused.push([other + ':\\.sereno\\cache\\spec-zz.md']);
        refused.push(['\\\\?\\' + path.join(cache, 'spec-zz.md')]);
      }
      for (const [f] of refused) {
        putSpec('zz');
        const r = run(sub, ...specArgs('zz', f));
        assert.strictEqual(r.code, 'path_refused', f + ' -> ' + JSON.stringify(r));
        assert.ok(fs.existsSync(path.join(cache, 'spec-zz.md')), 'refused file is left alone');
      }
      // .SERENO/cache/... is accepted where the filesystem treats it as the real dir (Windows)
      if (process.platform === 'win32') {
        putSpec('rcup');
        const r = run(d, ...specArgs('rcup', '.SERENO/cache/spec-rcup.md'));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
      }
      for (const x of [d, home]) fs.rmSync(x, { recursive: true, force: true });
    });
    test('[4a-aliascwd] cwd via junction / subdir of junction / 8.3 short path: paths + spec/gate round trip; junctioned cache refused', () => {
      if (process.platform !== 'win32') return;
      const d = mk();
      const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4ac-')));
      const lnkParent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4acl-')));
      const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-p4aco-')));
      const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(d, 'a.txt'), 'x\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'init');
      const head = g('rev-parse', 'HEAD'); const h7 = head.slice(0, 7);
      const env = Object.assign({}, process.env, { HOME: home, USERPROFILE: home });
      const run = (cwd, ...a) => JSON.parse(spawnSync(process.execPath, [SERENO, ...a], { cwd, encoding: 'utf8', env }).stdout);
      const cache = path.join(d, '.sereno', 'cache'); fs.mkdirSync(cache, { recursive: true });
      fs.mkdirSync(path.join(d, 'pkg', 'deep'), { recursive: true });
      const link = path.join(lnkParent, 'lnk');
      let n = 0;
      const roundTrip = (cwd, label) => {
        const p = run(cwd, 'paths');
        const want = path.resolve(cwd).split(path.sep).join('/');
        assert.ok(p.cacheDir.toLowerCase().startsWith(want.toLowerCase().replace(/\/(pkg\/deep)$/i, '')), label + ': cacheDir keeps the alias spelling: ' + p.cacheDir);
        const task = 'ac' + (n++);
        fs.writeFileSync(path.join(cache, 'spec-' + task + '.md'), '## Goal\nchange a\n');
        const sp = run(cwd, 'spec', '--task', task, '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--body-file', p.cacheDir + '/spec-' + task + '.md');
        assert.strictEqual(sp.ok, true, label + ' spec: ' + JSON.stringify(sp));
        const id = 'rr_2026010' + n + 'T000000Z_' + h7;
        fs.writeFileSync(path.join(cache, 'verdict-' + id + '.json'), '{"outcome":"pass","findings":[]}');
        const gt = run(cwd, 'gate', '--file', p.cacheDir + '/verdict-' + id + '.json', '--task', task, '--base', head, '--head', head, '--branch', 'main', '--run-id', id, '--tests-passed', 'true');
        assert.strictEqual(gt.ok, true, label + ' gate: ' + JSON.stringify(gt));
      };
      let linked = false;
      try { fs.symlinkSync(d, link, 'junction'); linked = true; } catch (_e) { console.log('    (junction unavailable; skipping a/b)'); }
      try {
        if (linked) {
          roundTrip(link, 'junction');
          roundTrip(path.join(link, 'pkg', 'deep'), 'junction subdir');
        }
        // (c) 8.3 short form of the repo root
        let short = d;
        try { short = execFileSync('cmd', ['/d', '/c', 'for %I in ("' + d + '") do @echo %~sI'], { encoding: 'utf8', windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_e) { /* none */ }
        if (short && short.toLowerCase() !== d.toLowerCase() && fs.existsSync(short)) roundTrip(short, '8.3');
        else console.log('    (8.3 short names unavailable; skipping c)');
        // .sereno/cache as a junction pointing outside the repo is refused
        fs.writeFileSync(path.join(outside, 'spec-ac9.md'), '## Goal\nx\n');
        const saved = path.join(d, '.sereno', 'cache-real');
        fs.renameSync(cache, saved);
        let cj = false;
        try { fs.symlinkSync(outside, cache, 'junction'); cj = true; } catch (_e) { /* skip */ }
        try {
          if (cj) {
            const r = run(d, 'spec', '--task', 'ac9', '--builder', 'sonnet', '--kind', 'feature', '--reason', 'r', '--body-file', cache.split(path.sep).join('/') + '/spec-ac9.md');
            assert.strictEqual(r.ok, false, JSON.stringify(r));
            assert.strictEqual(r.code, 'path_refused', JSON.stringify(r));
            assert.ok(fs.existsSync(path.join(outside, 'spec-ac9.md')), 'outside file untouched');
          }
        } finally { if (cj) fs.rmdirSync(cache); fs.renameSync(saved, cache); }
      } finally {
        if (linked) fs.rmdirSync(link);
        for (const x of [d, home, lnkParent, outside]) fs.rmSync(x, { recursive: true, force: true });
      }
    });
  }

  /* ---- Phase 4b: bundled plugin rules ---- */
  {
    const globRe = (g) => new RegExp('^' + g.replace(/[.+^$|()[\]{}]/g, (c) => '\\' + c).replace(/\*\*\//g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?') + '$');
    const patterns = require('../package.json').build.files.map(globRe);
    const bundled = (rel) => patterns.some((re) => re.test(rel));
    test('[4b-bundle] build.files globs match what the matcher expects', () => {
      assert.ok(bundled('plugin/bin/lib/recovery.js'));
      assert.ok(bundled('plugin/bin/lib/sub/x.js'));
      assert.ok(bundled('plugin/agents/builder.md'));
      assert.ok(!bundled('plugin/bin/sereno.js'));
    });
    test('[4b-bundle] every relative require of recovery.js and config.js (transitively) is bundled', () => {
      const seen = new Set(); const queue = [...fs.readFileSync(path.join(ROOT, 'src/pipeline.js'), 'utf8').matchAll(/require\(\s*['"]\.\.\/(plugin\/[^'"]+)['"]\s*\)/g)].map((m) => m[1]);
      assert.ok(queue.length >= 3, 'found the plugin requires in src/pipeline.js');
      while (queue.length) {
        const rel = queue.pop();
        if (seen.has(rel)) continue;
        seen.add(rel);
        assert.ok(bundled(rel), rel + ' is not matched by build.files');
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
          let next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
          if (!path.posix.extname(next)) next += '.js';
          assert.ok(fs.existsSync(path.join(ROOT, next)), rel + ' requires missing ' + next);
          queue.push(next);
        }
      }
      assert.ok(seen.has('plugin/bin/lib/fsafe.js'), 'walk reached fsafe.js');
    });
    test('[4b-bundle] src/pipeline.js loads and exposes decide', () => {
      const pl = require('../src/pipeline.js');
      assert.strictEqual(typeof pl.decide, 'function');
      assert.strictEqual(pl.decide, require('../plugin/bin/lib/recovery.js').decide);
      assert.strictEqual(typeof pl.config, 'object');
    });
    /* ---- [4b-reader] ---- */
    {
      const pl = require('../src/pipeline.js');
      const tmps = [];
      const mkd = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-4br-'))); tmps.push(d); return d; };
      const sub = (r, s) => { const d = path.join(r, '.sereno', s); fs.mkdirSync(d, { recursive: true }); return d; };
      const wj = (d, n, o) => fs.writeFileSync(path.join(d, n), typeof o === 'string' ? o : JSON.stringify(o));
      const HEX = 'a1b2c3d';
      const runId = (stamp, h) => 'rr_' + stamp + '_' + (h || HEX);
      const attempt = (task, n, extra) => Object.assign({ project_id: 'p1', task_id: task, spec_revision: 1, attempt: n, builder_requested: 'sonnet', agent_id: 'a_1',
        config_hash: 'sha256:' + 'a'.repeat(64), kind: 'feature', fixes: null, diagnosis: 'none', outcome: 'pass', review_run_id: null,
        started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T10:05:00.000Z' }, extra || {});
      const gate = (task, id, extra) => Object.assign({ review_run_id: id, task_id: task, spec: '.sereno/specs/' + task + '.md', spec_hash: 'sha256:' + 'b'.repeat(64),
        branch: 'task/' + task, base_commit: 'abcdef1', head_commit: 'abcdef2', session_id: 's-1', agent_id: 'a_2', model: 'claude-fable-5',
        outcome: 'block', tests_passed: true, findings: [], context_requests: [], reviewed_at: '2026-10-15T11:00:00.000Z', config_hash: 'sha256:' + 'a'.repeat(64) }, extra || {});
      const link = (target, at) => { try { fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir'); return true; } catch (_) { return false; } };

      await atest('[4b-reader] no .sereno, a relative path and a non-string give null (no throw)', async () => {
        assert.strictEqual(await pl.readRepo(mkd()), null);
        assert.strictEqual(await pl.readRepo('relative/path'), null);
        assert.strictEqual(await pl.readRepo(undefined), null);
        assert.strictEqual(await pl.listAttempts(mkd()), null);
      });

      await atest('[4b-reader] reads attempts, gates and spec front matter; groups by task; spec body is never returned', async () => {
        const r = mkd();
        wj(sub(r, 'attempts'), 'demo-1.json', attempt('demo', 1, { outcome: 'block' }));
        wj(sub(r, 'attempts'), 'demo-2.json', attempt('demo', 2));
        wj(sub(r, 'attempts'), 'other-1.json', attempt('other', 1));
        const id = runId('20261015T110000Z');
        wj(sub(r, 'gates'), id + '.json', gate('demo', id, { findings: [{ severity: 'high', kind: 'bug', file: 'src/a.js', line: 4, summary: 'x' }] }));
        const specText = '---\ntask: "demo"\nbuilder: sonnet\nkind: feature\nreason: "cheap enough"\nfixes: null\nbase_branch: "main"\nspec_revision: 3\ncreated_at: "2026-10-15T09:00:00.000Z"\n---\n\nSECRET-BODY-TEXT acceptance criteria\n';
        wj(sub(r, 'specs'), 'demo.md', specText);
        const out = await pl.readRepo(r);
        assert.ok(out);
        assert.deepStrictEqual(out.tasks.map((t) => t.task), ['demo', 'other']);
        const demo = out.tasks[0];
        assert.deepStrictEqual(demo.attempts.map((a) => a.attempt), [2, 1]);
        assert.strictEqual(demo.gates.length, 1);
        assert.strictEqual(demo.gates[0].findings[0].file, 'src/a.js');
        assert.strictEqual(demo.spec.reason, 'cheap enough');
        assert.strictEqual(demo.spec.spec_revision, 3);
        assert.strictEqual(demo.spec.base_branch, 'main');
        assert.strictEqual(out.tasks[1].spec, null);
        assert.ok(!JSON.stringify(out).includes('SECRET-BODY-TEXT'), 'spec body leaked');
        assert.strictEqual(out.skipped, 0);
        assert.ok(out.config && out.config.roles, 'effective config present');
        assert.deepStrictEqual((await pl.listAttempts(r)).sort(), ['demo-1.json', 'demo-2.json', 'other-1.json']);
      });

      await atest('[4b-reader] unknown fields are dropped from attempts, gates and findings; summaries are capped and stripped', async () => {
        const r = mkd();
        wj(sub(r, 'attempts'), 'demo-1.json', attempt('demo', 1, { prompt: 'PROMPT-TEXT', command: 'rm -rf', extra: { a: 1 } }));
        const id = runId('20261015T110000Z');
        wj(sub(r, 'gates'), id + '.json', gate('demo', id, {
          transcript: 'TRANSCRIPT', findings: [{ severity: 'high', kind: 'bug', file: 'src/a.js', line: 4, summary: 'a\u0000b‮' + 'z'.repeat(400), diff: 'DIFF-TEXT', prompt: 'P' }],
        }));
        const out = await pl.readRepo(r);
        const a = out.tasks[0].attempts[0], g = out.tasks[0].gates[0];
        assert.deepStrictEqual(Object.keys(a).sort(), ['agent_id', 'attempt', 'builder_requested', 'config_hash', 'diagnosis', 'ended_at', 'fixes', 'head_commit', 'kind', 'outcome',
          'project_id', 'review_run_id', 'spec_hash', 'spec_revision', 'started_at', 'task_id']);
        assert.deepStrictEqual(Object.keys(g).sort(), ['agent_id', 'base_commit', 'branch', 'config_hash', 'context_requests', 'findings', 'head_commit', 'model', 'outcome',
          'review_run_id', 'reviewed_at', 'session_id', 'spec', 'spec_hash', 'task_id', 'tests_passed']);
        assert.deepStrictEqual(Object.keys(g.findings[0]).sort(), ['file', 'kind', 'line', 'severity', 'summary']);
        assert.ok(g.findings[0].summary.length <= 300);
        assert.ok(g.findings[0].summary.startsWith('ab'), 'control chars stripped');
        const all = JSON.stringify(out);
        for (const s of ['PROMPT-TEXT', 'rm -rf', 'TRANSCRIPT', 'DIFF-TEXT']) assert.ok(!all.includes(s), s + ' leaked');
      });

      await atest('[4b-reader] tests.command and tests.setup are dropped from config', async () => {
        const r = mkd();
        sub(r, 'attempts');
        wj(path.join(r, '.sereno'), 'pipeline.json', { tests: { command: 'npm run SECRET-CMD', setup: 'SECRET-SETUP' } });
        const out = await pl.readRepo(r);
        assert.ok(out && out.config && out.config.tests, 'config loaded');
        assert.ok(!('command' in out.config.tests) && !('setup' in out.config.tests));
        assert.ok(!JSON.stringify(out).includes('SECRET'));
      });

      await atest('[4b-reader] a linked or non-file .sereno/pipeline.json is never loaded (config null, counted)', async () => {
        const outside = mkd(), r = mkd();
        sub(r, 'attempts');
        wj(outside, 'pipeline.json', { tests: { command: 'OUTSIDE-CMD' }, preset: 'lean' });
        const f = path.join(r, '.sereno', 'pipeline.json');
        let linked = true;
        try { fs.symlinkSync(path.join(outside, 'pipeline.json'), f, 'file'); } catch (_) { linked = false; }
        if (!linked) { fs.rmSync(f, { force: true }); linked = link(outside, f); }
        if (!linked) { console.log('    (link not permitted here; case not exercised)'); return; }
        const out = await pl.readRepo(r);
        assert.ok(out);
        assert.strictEqual(out.config, null);
        assert.strictEqual(out.skipped, 1);
        assert.ok(!JSON.stringify(out).includes('OUTSIDE'));
      });

      await atest('[4b-reader] a config that fails to load gives config null and is counted in skipped', async () => {
        const r = mkd();
        sub(r, 'attempts');
        wj(path.join(r, '.sereno'), 'pipeline.json', '{not json');
        const out = await pl.readRepo(r);
        assert.ok(out);
        assert.strictEqual(out.config, null);
        assert.strictEqual(out.skipped, 1);
      });

      await atest('[4b-reader] malformed, mismatched, oversized and non-file entries are skipped and counted', async () => {
        const r = mkd();
        const ad = sub(r, 'attempts'), gd = sub(r, 'gates'), sd = sub(r, 'specs');
        wj(ad, 'demo-1.json', attempt('demo', 1));
        wj(ad, 'bad-1.json', '{nope');
        wj(ad, 'liar-1.json', attempt('someone', 1));
        wj(ad, 'big-1.json', JSON.stringify(attempt('big', 1, { project_id: 'x'.repeat(300 * 1024) })));
        fs.mkdirSync(path.join(ad, 'dir-1.json'));
        wj(ad, 'notes.txt', 'ignored');
        const good = runId('20261015T110000Z'), wrong = runId('20261015T120000Z');
        wj(gd, good + '.json', gate('demo', good));
        wj(gd, wrong + '.json', gate('demo', 'rr_other'));
        wj(gd, runId('20261015T130000Z') + '.json', '[]');
        wj(sd, 'nofront.md', 'just text, no front matter\n');
        const out = await pl.readRepo(r);
        const demo = out.tasks.find((t) => t.task === 'demo');
        assert.strictEqual(demo.attempts.length, 1);
        assert.strictEqual(demo.gates.length, 1);
        assert.strictEqual(out.tasks.length, 1, 'skipped files create no task');
        assert.strictEqual(out.skipped, 7); // bad, liar, big, dir-1.json, wrong gate, [] gate, nofront spec
      });

      await atest('[4b-reader] caps: 200 newest attempt files and 200 newest gate files', async () => {
        const r = mkd();
        const ad = sub(r, 'attempts'), gd = sub(r, 'gates');
        for (let n = 1; n <= 230; n++) wj(ad, 'big-' + n + '.json', attempt('big', n));
        for (let i = 0; i < 230; i++) {
          const id = runId('20261015T' + String(100000 + i).padStart(6, '0') + 'Z');
          wj(gd, id + '.json', gate('big', id));
        }
        const out = await pl.readRepo(r);
        const t = out.tasks[0];
        assert.strictEqual(t.attempts.length, 200);
        assert.strictEqual(t.attempts[0].attempt, 230);
        assert.strictEqual(t.attempts[199].attempt, 31);
        assert.strictEqual(t.gates.length, 200);
        assert.ok(t.gates[0].review_run_id > t.gates[199].review_run_id, 'newest first');
        assert.strictEqual((await pl.listAttempts(r)).length, 200);
      });

      await atest('[4b-reader] a symlinked/junctioned .sereno is refused before anything is read', async () => {
        const target = mkd(), r = mkd();
        wj(sub(target, 'attempts'), 'demo-1.json', attempt('demo', 1));
        if (!link(path.join(target, '.sereno'), path.join(r, '.sereno'))) { console.log('    (link not permitted here; case not exercised)'); return; }
        assert.strictEqual(await pl.readRepo(r), null);
        assert.strictEqual(await pl.listAttempts(r), null);
        assert.strictEqual(await pl.guard(r), false);
      });

      for (const s of ['attempts', 'gates', 'specs']) {
        await atest('[4b-reader] a symlinked/junctioned .sereno/' + s + ' is refused (whole repo null)', async () => {
          const outside = mkd(), r = mkd();
          fs.mkdirSync(path.join(r, '.sereno'));
          wj(outside, 'demo-1.json', attempt('demo', 1));
          wj(outside, 'demo.md', '---\ntask: "demo"\n---\n');
          if (!link(outside, path.join(r, '.sereno', s))) { console.log('    (link not permitted here; case not exercised)'); return; }
          assert.strictEqual(await pl.readRepo(r), null);
          assert.strictEqual(await pl.listAttempts(r), null);
          assert.strictEqual(await pl.guard(r), false);
        });
      }

      await atest('[4b-reader] a symlinked file inside attempts is skipped, never followed', async () => {
        const r = mkd(), outside = mkd();
        const ad = sub(r, 'attempts');
        wj(outside, 'real.json', attempt('demo', 1, { project_id: 'OUTSIDE' }));
        let linked = true;
        try { fs.symlinkSync(path.join(outside, 'real.json'), path.join(ad, 'demo-1.json'), 'file'); } catch (_) { linked = false; }
        if (!linked) { console.log('    (symlink not permitted here; case not exercised)'); return; }
        const out = await pl.readRepo(r);
        assert.ok(!JSON.stringify(out).includes('OUTSIDE'));
        assert.strictEqual(out.skipped, 1);
      });

      await atest('[4b-reader] a non-local root (UNC) is refused', async () => {
        assert.strictEqual(await pl.readRepo('\\\\server\\share\\repo'), null);
      });

      await atest('[4b-reader] a throwing fs layer never escapes readRepo or listAttempts', async () => {
        const boom = new Proxy({}, { get() { return () => { throw new Error('boom'); }; } });
        assert.strictEqual(await pl.readRepo(mkd(), { fsp: boom }), null);
        assert.strictEqual(await pl.listAttempts(mkd(), { fsp: boom }), null);
      });

      await atest('[4b-reader] cleanup', async () => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
