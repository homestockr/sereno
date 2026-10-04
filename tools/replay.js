'use strict';
/*
 * Replays the captured samples through the store in true timestamp order and
 * prints the resulting state transitions. This is the regression test that
 * matters: it runs the state machine against real payloads, not invented ones.
 *
 *   node tools/replay.js [sessionId]
 *   node tools/replay.js --otlp [--fixtures]   replay OTLP into a temp ledger twice
 */

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store.js');

const dir = path.join(__dirname, '..', 'samples');
const args = process.argv.slice(2);

if (args.includes('--otlp')) {
  replayOtlp(args.includes('--fixtures'));
  return;
}
const only = args.find((a) => !a.startsWith('--'));

const records = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.jsonl') || f.startsWith('otlp-')) continue;
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

/*
 * OTLP replay. Prints aggregates only: no session ids, project names or other
 * identifiers ever reach the terminal (samples are real captures).
 */
function replayOtlp(forceFixtures) {
  const os = require('node:os');
  const otlp = require('../src/otlp.js');
  const { openLedger } = require('../src/ledger.js');
  const fx = path.join(__dirname, 'fixtures');
  const rd = (d, f) => { try { return fs.readFileSync(path.join(d, f), 'utf8'); } catch (_) { return null; } };

  // Each entry is one parsed OTLP export body. Lines may be raw bodies or
  // { ts, body } / { ts, payload } wrappers.
  const bodies = (text) => {
    const out = [];
    for (const line of (text || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); out.push(o.body || o.payload || o); } catch (_) { /* skip */ }
    }
    return out;
  };
  let logs; let traces; let status = [];
  const sLogs = forceFixtures ? null : rd(dir, 'otlp-logs.jsonl');
  const sTraces = forceFixtures ? null : rd(dir, 'otlp-traces.jsonl');
  let source;
  if (sLogs !== null || sTraces !== null) {
    source = 'samples/otlp-*.jsonl';
    logs = bodies(sLogs); traces = bodies(sTraces);
    const st = rd(dir, 'statusline.jsonl');
    for (const line of (st || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const p = o.payload || o;
        const cost = p && p.cost && p.cost.total_cost_usd;
        if (p && typeof p.session_id === 'string' && typeof cost === 'number') status.push({ id: p.session_id, cost, ts: Number(o.ts) });
      } catch (_) { /* skip */ }
    }
  } else {
    source = 'tools/fixtures/otlp-*.json';
    logs = [JSON.parse(rd(fx, 'otlp-logs.json'))]; traces = [JSON.parse(rd(fx, 'otlp-traces.json'))];
  }
  console.log('replaying ' + source + ' (' + logs.length + ' log bodies, ' + traces.length + ' trace bodies, '
    + status.length + ' status records)');

  const dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sereno-replay-'));
  const ledger = openLedger({ file: path.join(dirTmp, 'sereno.db'), retentionDays: 36500 });
  const idx = new Map();
  const n = (id) => { if (!idx.has(id)) idx.set(id, idx.size + 1); return idx.get(id); };
  const snap = () => JSON.stringify(ledger.totals());
  const pass = (label) => {
    for (const b of logs) { const rows = otlp.parseLogs(b); if (rows.length) ledger.ingestRequests(rows); }
    for (const b of traces) { const sp = otlp.parseTraces(b); if (sp.length) ledger.ingestSpans(sp); }
    for (const r of status) ledger.recordStatus(r.id, r.cost, r.ts);
    const t = ledger.totals();
    console.log(label + ': cost ' + t.costMicros + ' micros (est. $' + (t.costMicros / 1e6).toFixed(4) + '), requests ' + t.requests);
    console.log('  bySource ' + JSON.stringify(t.bySource));
    console.log('  byAttribution ' + JSON.stringify(t.byAttribution));
    for (const s of t.sessions) {
      const r = ledger.reconcile(s.sessionId);
      console.log('  session ' + n(s.sessionId) + ' reconcile: ' + (r.statusMicros === null
        ? 'no statusline record' : JSON.stringify({ deltaPct: r.deltaPct, ok: r.ok })));
    }
    return snap();
  };
  let same = false;
  try {
    const a = pass('pass 1');
    const b = pass('pass 2');
    same = a === b;
  } finally {
    try { ledger.close(); } catch (_) { /* ignore */ }
    fs.rmSync(dirTmp, { recursive: true, force: true });
  }
  console.log('replay idempotent: ' + (same ? 'yes' : 'no'));
  process.exitCode = same ? 0 : 1;
}
