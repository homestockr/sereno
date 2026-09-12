'use strict';
/*
 * Feeds a realistic two-session scenario through the real shim, so the widget
 * can be eyeballed without waiting for a live permission prompt.
 *
 *   node tools/demo.js            populate and leave one session blocked
 *   node tools/demo.js --clear    end both sessions
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const EMIT = path.join(__dirname, '..', 'bin', 'emit.js');

function send(args, payload) {
  try {
    execFileSync(process.execPath, [EMIT].concat(args), {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
    });
  } catch (e) { console.error('send failed: ' + e.message); }
}
const hook = (ev, p) => send(['hook', ev], Object.assign({ hook_event_name: ev }, p));
const status = (p) => send(['statusline'], p);

const S1 = { session_id: 'demo-homestockr', cwd: 'C:\\dev\\homestockr' };
const S2 = { session_id: 'demo-api-worker', cwd: 'C:\\dev\\api-worker' };

if (process.argv.includes('--clear')) {
  hook('SessionEnd', Object.assign({ reason: 'other' }, S1));
  hook('SessionEnd', Object.assign({ reason: 'other' }, S2));
  console.log('demo sessions ended');
  process.exit(0);
}

// --- session 1: busy, two subagents running ---
hook('SessionStart', Object.assign({ source: 'startup' }, S1));
hook('PreToolUse', Object.assign({ tool_name: 'Bash', tool_input: { command: 'npm run build' }, tool_use_id: 'a1' }, S1));
hook('PreToolUse', Object.assign({ tool_name: 'Grep', tool_use_id: 'g1', agent_id: 'ag1', agent_type: 'Explore' }, S1));
hook('PreToolUse', Object.assign({ tool_name: 'Grep', tool_use_id: 'g2', agent_id: 'ag2', agent_type: 'Explore' }, S1));
status(Object.assign({
  model: { display_name: 'Opus 5' },
  cost: { total_cost_usd: 1.88 },
  context_window: { used_percentage: 34, context_window_size: 200000, current_usage: {} },
  rate_limits: {
    five_hour: { used_percentage: 52, resets_at: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { used_percentage: 58, resets_at: Math.floor(Date.now() / 1000) + 86400 },
  },
}, S1));

// --- session 2: blocked on something destructive ---
hook('SessionStart', Object.assign({ source: 'startup' }, S2));
hook('PreToolUse', Object.assign({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' }, tool_use_id: 'b1' }, S2));
status(Object.assign({
  model: { display_name: 'Opus 5' },
  cost: { total_cost_usd: 0.53 },
  context_window: { used_percentage: 12, context_window_size: 200000, current_usage: {} },
}, S2));
hook('Notification', Object.assign({
  message: 'Claude needs your permission',
  notification_type: 'permission_prompt',
}, S2));

console.log('demo populated: homestockr running (2 agents), api-worker BLOCKED');
console.log('clear with: node tools/demo.js --clear');
