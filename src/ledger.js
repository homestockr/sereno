// @ts-check
'use strict';
/*
 * Spend ledger: SQLite via built-in node:sqlite. Money is integer micro-dollars
 * (estimates), time is integer ms. PRIVACY: no prompt/response/command/tool-input
 * columns exist, and recordHook reads only an allowlist of payload fields.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config.js');

class LedgerUnavailableError extends Error {
  /** @param {string} msg */
  constructor(msg) { super(msg); this.name = 'LedgerUnavailableError'; this.code = 'LEDGER_UNAVAILABLE'; }
}

const DAY_MS = 86400000;

const SCHEMA_V1 = `
CREATE TABLE requests (
  request_key TEXT PRIMARY KEY, request_id TEXT, session_id TEXT, prompt_id TEXT,
  ts INTEGER NOT NULL, model TEXT, query_source TEXT, source TEXT, agent_name TEXT,
  agent_id TEXT, attribution TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX requests_session_ts ON requests(session_id, ts);
CREATE INDEX requests_ts ON requests(ts);
CREATE INDEX requests_request_id ON requests(request_id);
CREATE TABLE spans (request_id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, ts INTEGER NOT NULL);
CREATE TABLE sessions (session_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL, cwd TEXT, project TEXT, model TEXT);
CREATE TABLE agents (session_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_type TEXT,
  started INTEGER, stopped INTEGER, PRIMARY KEY (session_id, agent_id));
CREATE TABLE status (session_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, cost_micros INTEGER NOT NULL);
`;
const MIGRATIONS = [SCHEMA_V1];

/** @param {any} v @returns {string|null} */
const str = v => (typeof v === 'string' && v !== '' ? v : null);

/**
 * @param {{ file?: string, retentionDays?: number }} [opts]
 */
function openLedger(opts = {}) {
  /** @type {any} */
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch (e) { throw new LedgerUnavailableError('node:sqlite is unavailable (need Node >= 22.13)'); }
  const file = opts.file || path.join(config.home(), 'sereno.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const rd = Number(opts.retentionDays);
  const retentionDays = Number.isFinite(rd) && rd > 0 ? rd : 90;
  const db = new sqlite.DatabaseSync(file, { timeout: 2000 });   // busy timeout: a second process waits instead of SQLITE_BUSY
  try {
  let closed = false;
  const live = () => { if (closed) throw new Error('ledger is closed'); };

  // The constructor `timeout` option is ignored on Node 22.13-22.15; set it explicitly.
  db.exec('PRAGMA busy_timeout=2000');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  let ver = Number(db.prepare('PRAGMA user_version').get().user_version);
  while (ver < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[ver]);
      db.exec('PRAGMA user_version=' + (ver + 1));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    ver++;
  }

  const q = {
    insReq: db.prepare(`INSERT OR IGNORE INTO requests (request_key, request_id, session_id, prompt_id, ts, model,
      query_source, source, agent_name, agent_id, attribution, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cost_micros, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    spanFor: db.prepare('SELECT agent_id FROM spans WHERE request_id=? AND agent_id IS NOT NULL'),
    upSessSeen: db.prepare(`INSERT INTO sessions (session_id, first_seen, last_seen) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET first_seen=MIN(first_seen, excluded.first_seen),
      last_seen=MAX(last_seen, excluded.last_seen)`),
    insSpan: db.prepare('INSERT OR IGNORE INTO spans (request_id, session_id, agent_id, ts) VALUES (?,?,?,?)'),
    upgrade: db.prepare(`UPDATE requests SET agent_id=?, attribution='explicit' WHERE request_id=?
      AND source='subagent' AND attribution='unknown'`),
    sessStart: db.prepare(`INSERT INTO sessions (session_id, first_seen, last_seen, cwd, project, model)
      VALUES (?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET cwd=COALESCE(excluded.cwd, cwd),
      project=COALESCE(excluded.project, project), model=COALESCE(excluded.model, model),
      first_seen=MIN(first_seen, excluded.first_seen), last_seen=MAX(last_seen, excluded.last_seen)`),
    agentGet: db.prepare('SELECT agent_type FROM agents WHERE session_id=? AND agent_id=?'),
    agentStart: db.prepare(`INSERT INTO agents (session_id, agent_id, agent_type, started, stopped) VALUES (?,?,?,?,NULL)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET stopped=NULL,
      agent_type=COALESCE(NULLIF(excluded.agent_type,''), agent_type)`),
    agentStop: db.prepare(`INSERT INTO agents (session_id, agent_id, agent_type, started, stopped) VALUES (?,?,?,?,?)
      ON CONFLICT(session_id, agent_id) DO UPDATE SET stopped=excluded.stopped,
      agent_type=COALESCE(NULLIF(excluded.agent_type,''), agent_type)`),
    statusGet: db.prepare('SELECT ts, cost_micros FROM status WHERE session_id=?'),
    statusSet: db.prepare(`INSERT INTO status (session_id, ts, cost_micros) VALUES (?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET ts=excluded.ts, cost_micros=excluded.cost_micros`),
    sumUpTo: db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM requests WHERE session_id=? AND ts<=?'),
    sumAll: db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM requests WHERE session_id=?'),
    pruneReq: db.prepare('DELETE FROM requests WHERE ts < ?'),
    pruneSpan: db.prepare('DELETE FROM spans WHERE ts < ?'),
    pruneSess: db.prepare('DELETE FROM sessions WHERE last_seen < ?'),
    pruneAgents: db.prepare(`DELETE FROM agents WHERE COALESCE(stopped, started) < ?
      OR session_id NOT IN (SELECT session_id FROM sessions)`),
    pruneStatus: db.prepare('DELETE FROM status WHERE ts < ?'),
  };

  /** @template T @param {() => T} fn @returns {T} */
  function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  /** @param {import('./otlp.js').RequestRecord[]} rows */
  function ingestRequests(rows) {
    live();
    tx(() => {
      for (const r of rows || []) {
        let attribution = 'unknown';
        /** @type {string|null} */
        let agentId = null;
        if (r.source === 'main' || r.source === 'auxiliary') attribution = 'explicit';
        else if (r.source === 'subagent' && r.requestId) {
          const sp = q.spanFor.get(r.requestId);
          if (sp && sp.agent_id) { attribution = 'explicit'; agentId = sp.agent_id; }
        }
        q.insReq.run(r.requestKey, r.requestId, r.sessionId, r.promptId, r.ts > 0 ? r.ts : Date.now(), r.model, r.querySource,
          r.source, r.agentName, agentId, attribution, r.inputTokens, r.outputTokens, r.cacheReadTokens,
          r.cacheCreationTokens, r.costMicros, r.durationMs);
        if (r.sessionId) {
          const t = r.ts > 0 ? r.ts : Date.now();
          q.upSessSeen.run(r.sessionId, t, t);
        }
      }
    });
  }

  /** @param {import('./otlp.js').SpanRecord[]} spans */
  function ingestSpans(spans) {
    live();
    tx(() => {
      for (const s of spans || []) {
        if (!s.requestId) continue;
        q.insSpan.run(s.requestId, s.sessionId, s.agentId, s.ts > 0 ? s.ts : Date.now());
        if (s.agentId) q.upgrade.run(s.agentId, s.requestId);
      }
    });
  }

  /** @param {string} event @param {any} payload */
  function recordHook(event, payload) {
    live();
    const p = payload && typeof payload === 'object' ? payload : {};
    const sessionId = str(p.session_id);
    if (!sessionId) return;
    const now = Date.now();
    if (event === 'SessionStart') {
      const cwd = str(p.cwd);
      const project = cwd ? path.basename(cwd) || null : null;
      q.sessStart.run(sessionId, now, now, cwd, project, str(p.model));
    } else if (event === 'SubagentStart' || event === 'SubagentStop') {
      const agentId = str(p.agent_id);
      if (!agentId) return;
      const type = typeof p.agent_type === 'string' ? p.agent_type : '';
      if (event === 'SubagentStart') q.agentStart.run(sessionId, agentId, type, now);
      else {
        if (!q.agentGet.get(sessionId, agentId) && type === '') return;
        q.agentStop.run(sessionId, agentId, type, now, now);
      }
    }
  }

  /** @param {string} sessionId @param {number} costUsd @param {number} ts */
  function recordStatus(sessionId, costUsd, ts) {
    live();
    if (!sessionId || typeof costUsd !== 'number' || !Number.isFinite(costUsd)) return;
    const micros = Math.round(costUsd * 1e6);
    const cur = q.statusGet.get(sessionId);
    if (cur && cur.cost_micros === micros) return;
    q.statusSet.run(sessionId, Number.isFinite(ts) ? Math.round(ts) : Date.now(), micros);
  }

  /** @param {{since?: number, until?: number}} range */
  function whereFor(range) {
    /** @type {string[]} */ const where = [];
    /** @type {number[]} */ const args = [];
    if (range.since != null) { where.push('requests.ts >= ?'); args.push(range.since); }
    if (range.until != null) { where.push('requests.ts < ?'); args.push(range.until); }
    return { w: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
  }

  // The one aggregation behind totals() and today(): head totals plus per-column groups.
  /** @param {{since?: number, until?: number}} range */
  function aggregate(range) {
    const { w, args } = whereFor(range);
    const head = db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS c, COUNT(*) AS n FROM requests' + w).get(...args);
    /** @param {string} col */
    const group = col => {
      /** @type {Record<string, number>} */
      const o = {};
      for (const r of db.prepare(`SELECT ${col} AS k, SUM(cost_micros) AS c FROM requests${w} GROUP BY ${col}`).all(...args)) {
        o[String(r.k)] = Number(r.c);
      }
      return o;
    };
    return {
      costMicros: Number(head.c), requests: Number(head.n),
      bySource: group('source'), byModel: group('model'), byAttribution: group('attribution'),
    };
  }

  /** @param {{since?: number, until?: number}} [range] */
  function totals(range = {}) {
    live();
    const { w, args } = whereFor(range);
    const agg = aggregate(range);
    const sw = w ? w + ' AND requests.session_id IS NOT NULL' : ' WHERE requests.session_id IS NOT NULL';
    const sessions = db.prepare(`SELECT requests.session_id AS sid, sessions.project AS project,
      SUM(requests.cost_micros) AS c FROM requests LEFT JOIN sessions ON sessions.session_id = requests.session_id
      ${sw} GROUP BY requests.session_id ORDER BY c DESC`).all(...args)
      .map(r => ({ sessionId: r.sid, project: r.project ?? null, costMicros: Number(r.c) }));
    return {
      costMicros: agg.costMicros, requests: agg.requests,
      bySource: agg.bySource, byModel: agg.byModel, byAttribution: agg.byAttribution, sessions,
    };
  }

  /** @param {Record<string, number>} o @param {any} k @param {number} c */
  const addTo = (o, k, c) => { const key = String(k); o[key] = (o[key] || 0) + c; };

  // Rows are pre-aggregated into 15-minute slots (ts - ts % 900000), not per request: the
  // aggregation is then O(slots), not O(requests). 15 minutes (not a whole hour) is on purpose:
  // every real UTC offset is a multiple of 15 min (+05:30, +05:45...), so local day AND local
  // hour boundaries always fall on a slot boundary and bucketing slots is exact. Whole-hour
  // slots would split buckets in those zones. If a caller passes boundaries that are not
  // slot-aligned, we fall back to per-request grouping (SLOT = 1) so results stay exact.
  const SLOT_MS = 900000;
  /** @param {{ since: number, until: number }[]} buckets */
  const slotFor = buckets => (buckets.every(b => b.since % SLOT_MS === 0 && b.until % SLOT_MS === 0) ? SLOT_MS : 1);
  /** @param {{ since: number, until: number }[]} buckets @param {number} ts @returns {number} index or -1 */
  function bucketIndex(buckets, ts) {
    let a = 0, b = buckets.length - 1;
    while (a < b) { const mid = (a + b + 1) >> 1; if (buckets[mid].since <= ts) a = mid; else b = mid - 1; }
    return ts < buckets[a].since || ts >= buckets[a].until ? -1 : a;
  }

  // series: ONE query for the whole span; slots are bucketed in JS by binary search over
  // the (contiguous, sorted) bucket list. A boundary ts belongs to the later bucket.
  /** @param {{ key: string, since: number, until: number }[]} buckets */
  function series(buckets) {
    live();
    const out = (buckets || []).map(b => ({
      key: b.key, costMicros: 0, requests: 0,
      /** @type {Record<string, number>} */ bySource: {},
      /** @type {Record<string, number>} */ byAttribution: {},
    }));
    if (!out.length) return out;
    const lo = buckets[0].since, hi = buckets[buckets.length - 1].until;
    const slot = slotFor(buckets);
    const rows = db.prepare(`SELECT ts - (ts % ${slot}) AS slot, source, attribution, SUM(cost_micros) AS c, COUNT(*) AS n
      FROM requests WHERE ts >= ? AND ts < ? GROUP BY slot, source, attribution`).all(lo, hi);
    for (const r of rows) {
      const i = bucketIndex(buckets, Number(r.slot));
      if (i < 0) continue;
      const o = out[i], c = Number(r.c);
      o.costMicros += c; o.requests += Number(r.n);
      addTo(o.bySource, r.source, c); addTo(o.byAttribution, r.attribution, c);
    }
    return out;
  }

  /** @param {{ since: number, until: number }} range */
  function projects(range) {
    live();
    const rows = db.prepare(`SELECT sessions.project AS p, requests.source AS s, requests.attribution AS a,
      SUM(requests.cost_micros) AS c, COUNT(*) AS n FROM requests
      LEFT JOIN sessions ON sessions.session_id = requests.session_id
      WHERE requests.ts >= ? AND requests.ts < ? GROUP BY p, s, a`).all(range.since, range.until);
    /** @type {Map<string|null, any>} */
    const m = new Map();
    const un = { costMicros: 0, requests: 0 };
    for (const r of rows) {
      const p = r.p ?? null, c = Number(r.c), n = Number(r.n);
      let e = m.get(p);
      if (!e) { e = { project: p, costMicros: 0, requests: 0, bySource: {}, byAttribution: {} }; m.set(p, e); }
      e.costMicros += c; e.requests += n;
      addTo(e.bySource, r.s, c); addTo(e.byAttribution, r.a, c);
      if (r.a === 'unknown') { un.costMicros += c; un.requests += n; }
    }
    const list = [...m.values()].sort((x, y) => y.costMicros - x.costMicros);
    return { rows: list, unattributed: un };
  }

  // Per-project trend for ALL projects in one query. Map: project (null = no project) -> number[].
  /** @param {{ buckets: { since: number, until: number }[] }} o */
  function trends(o) {
    live();
    const buckets = o.buckets || [];
    /** @type {Map<string|null, number[]>} */
    const m = new Map();
    if (!buckets.length) return m;
    const slot = slotFor(buckets);
    const rows = db.prepare(`SELECT sessions.project AS p, requests.ts - (requests.ts % ${slot}) AS slot,
      SUM(requests.cost_micros) AS c FROM requests
      LEFT JOIN sessions ON sessions.session_id = requests.session_id
      WHERE requests.ts >= ? AND requests.ts < ? GROUP BY p, slot`).all(buckets[0].since, buckets[buckets.length - 1].until);
    for (const r of rows) {
      const i = bucketIndex(buckets, Number(r.slot));
      if (i < 0) continue;
      const p = r.p ?? null;
      let arr = m.get(p);
      if (!arr) { arr = buckets.map(() => 0); m.set(p, arr); }
      arr[i] += Number(r.c);
    }
    return m;
  }

  /** @param {{ project: string|null, buckets: { since: number, until: number }[] }} o */
  function trend(o) {
    live();
    const buckets = o.buckets || [];
    return trends({ buckets }).get(o.project ?? null) || buckets.map(() => 0);
  }

  /** @param {{ since: number, until: number, limit?: number }} o */
  function topPrompts(o) {
    live();
    const rawLim = Math.floor(Number(o.limit ?? 10));
    const lim = Math.min(100, Math.max(1, Number.isFinite(rawLim) ? rawLim : 10));
    // 1) rank prompt groups by cost in SQL and keep only the top N group keys
    const top = db.prepare(`SELECT COALESCE(prompt_id, request_key) AS g FROM requests
      WHERE ts >= ? AND ts < ? GROUP BY g ORDER BY SUM(cost_micros) DESC, MIN(ts) ASC LIMIT ${lim}`).all(o.since, o.until);
    if (!top.length) return [];
    // 2) details only for those N keys; grouped per (prompt, model), merged per prompt in JS
    //    so models stay a clean distinct list
    const keys = top.map(r => r.g);
    const rows = db.prepare(`SELECT COALESCE(requests.prompt_id, requests.request_key) AS g, requests.model AS model,
      MIN(requests.ts) AS ts, SUM(requests.cost_micros) AS c, COUNT(*) AS n,
      SUM(requests.attribution='explicit') AS ne, SUM(requests.attribution='unknown') AS nu,
      MIN(sessions.project) AS project, MIN(requests.session_id) AS sid
      FROM requests LEFT JOIN sessions ON sessions.session_id = requests.session_id
      WHERE requests.ts >= ? AND requests.ts < ?
      AND COALESCE(requests.prompt_id, requests.request_key) IN (${keys.map(() => '?').join(',')})
      GROUP BY g, requests.model`).all(o.since, o.until, ...keys);
    /** @type {Map<string, any>} */
    const m = new Map();
    for (const r of rows) {
      let e = m.get(r.g);
      if (!e) { e = { ts: Number(r.ts), project: r.project ?? null, sid: r.sid ?? null, costMicros: 0, n: 0, ne: 0, nu: 0, models: new Set() }; m.set(r.g, e); }
      e.ts = Math.min(e.ts, Number(r.ts));
      if (e.project === null && r.project != null) e.project = r.project;
      if (e.sid === null && r.sid != null) e.sid = r.sid;
      e.costMicros += Number(r.c); e.n += Number(r.n); e.ne += Number(r.ne); e.nu += Number(r.nu);
      if (r.model != null) e.models.add(String(r.model));
    }
    return [...m.values()].map(e => ({
      ts: e.ts, project: e.project, sessionShort: e.sid ? String(e.sid).slice(0, 8) : null,
      costMicros: e.costMicros, models: [...e.models].sort(),
      attribution: e.ne === e.n ? 'explicit' : e.nu === e.n ? 'unknown' : 'mixed',
    })).sort((x, y) => y.costMicros - x.costMicros || x.ts - y.ts).slice(0, lim);
  }

  /** @param {number} nowMs */
  function today(nowMs) {
    live();
    const b = require('./spendtime.js').dayBounds(nowMs);
    const agg = aggregate({ since: b.since, until: b.until });
    const un = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ts >= ? AND ts < ? AND attribution='unknown'`).get(b.since, b.until);
    return {
      day: b.day, since: b.since, until: b.until, costMicros: agg.costMicros, requests: agg.requests,
      bySource: agg.bySource, byAttribution: agg.byAttribution, unattributedN: Number(un.n),
    };
  }

  /** True once any request has ever been recorded (not just today). */
  function hasAny() {
    live();
    return db.prepare('SELECT 1 FROM requests LIMIT 1').get() !== undefined;
  }

  /** @param {string} sessionId */
  function reconcile(sessionId) {
    live();
    const st = q.statusGet.get(sessionId);
    if (!st) {
      return { ledgerMicros: Number(q.sumAll.get(sessionId).s), statusMicros: null, deltaPct: null, ok: false };
    }
    const ledgerMicros = Number(q.sumUpTo.get(sessionId, st.ts).s);
    const statusMicros = Number(st.cost_micros);
    /** @type {number|null} */
    let deltaPct;
    if (statusMicros === 0) deltaPct = ledgerMicros === 0 ? 0 : null;
    else deltaPct = Math.round((ledgerMicros - statusMicros) / statusMicros * 1000) / 10;
    if (deltaPct === 0) deltaPct = 0; // normalise -0
    return { ledgerMicros, statusMicros, deltaPct, ok: deltaPct !== null && Math.abs(deltaPct) <= 2 };
  }

  /** @param {number} [days] */
  function prune(days = retentionDays) {
    live();
    const cutoff = Date.now() - days * DAY_MS;
    tx(() => {
      q.pruneReq.run(cutoff); q.pruneSpan.run(cutoff); q.pruneSess.run(cutoff);
      q.pruneAgents.run(cutoff); q.pruneStatus.run(cutoff);
    });
  }

  function close() {
    if (closed) return;
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { closed = true; db.close(); }
  }

  prune(retentionDays);
  return { file, ingestRequests, ingestSpans, recordHook, recordStatus, totals, series, projects, trend, trends, topPrompts, today, hasAny, reconcile, prune, close, _db: db };
  } catch (e) {
    // setup failed after the file was opened: release the handle (Windows keeps it locked)
    try { db.close(); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { openLedger, LedgerUnavailableError };
