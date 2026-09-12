'use strict';
/*
 * Replays the captured samples through the store in true timestamp order and
 * prints the resulting state transitions. This is the regression test that
 * matters: it runs the state machine against real payloads, not invented ones.
 *
 *   node tools/replay.js [sessionId]
 */

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store.js');

const dir = path.join(__dirname, '..', 'samples');
const only = process.argv[2];

const records = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl')) continue;
  const kind = f === 'statusline.jsonl' ? 'status' : 'hook';
  const event = kind === 'hook' ? f.replace(/^hook-/, '').replace(/\.jsonl$/, '') : '';
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (!r.payload || !r.payload.session_id) continue;
      if (only && r.payload.session_id !== only) continue;
      records.push({ ts: r.ts, kind, event, payload: r.payload });
    } catch (_) { /* skip */ }
  }
}
records.sort((a, b) => a.ts - b.ts);

if (!records.length) {
  console.log('no records found in', dir);
  process.exit(1);
}

const store = new Store();
const toasts = [];
store.onBlocked = (s) => toasts.push(s);

const t0 = records[0].ts;
let prev = '';
for (const r of records) {
  if (r.kind === 'hook') store.applyHook(r.event, r.payload);
  else store.applyStatus(r.payload);

  const s = store.sessions.get(r.payload.session_id);
  const line = s
    ? `${s.state}|${[s.stateTool, s.stateArg].filter(Boolean).join(' \u00b7 ')}|agents=${s.subagents}|$${s.costUsd === null ? '-' : s.costUsd.toFixed(4)}|ctx=${s.contextPct === null ? '-' : s.contextPct + '%'}`
    : '(removed)';

  const src = r.kind === 'status' ? 'statusline' : r.event;
  const tag = r.payload.agent_id ? ' [agent ' + r.payload.agent_id.slice(0, 6) + ']' : '';
  if (line !== prev) {
    const t = ((r.ts - t0) / 1000).toFixed(1).padStart(6);
    console.log(`${t}s  ${(src + tag).padEnd(30)} -> ${line}`);
    prev = line;
  }
}

console.log('\n--- toasts fired:', toasts.length);
for (const t of toasts) console.log('    ' + t.projectName + ': ' + [t.stateTool, t.stateArg].filter(Boolean).join(' \u00b7 '));
console.log('--- final snapshot:');
console.log(JSON.stringify(store.snapshot(), null, 1));
