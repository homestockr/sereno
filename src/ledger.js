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
  const db = new sqlite.DatabaseSync(file);
  try {
  let closed = false;
  const live = () => { if (closed) throw new Error('ledger is closed'); };

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

  /** @param {{since?: number, until?: number}} [range] */
  function totals(range = {}) {
    live();
    /** @type {string[]} */ const where = [];
    /** @type {number[]} */ const args = [];
    if (range.since != null) { where.push('requests.ts >= ?'); args.push(range.since); }
    if (range.until != null) { where.push('requests.ts < ?'); args.push(range.until); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
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
    const sw = w ? w + ' AND requests.session_id IS NOT NULL' : ' WHERE requests.session_id IS NOT NULL';
    const sessions = db.prepare(`SELECT requests.session_id AS sid, sessions.project AS project,
      SUM(requests.cost_micros) AS c FROM requests LEFT JOIN sessions ON sessions.session_id = requests.session_id
      ${sw} GROUP BY requests.session_id ORDER BY c DESC`).all(...args)
      .map(r => ({ sessionId: r.sid, project: r.project ?? null, costMicros: Number(r.c) }));
    return {
      costMicros: Number(head.c), requests: Number(head.n),
      bySource: group('source'), byModel: group('model'), byAttribution: group('attribution'), sessions,
    };
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
    tx(() => { q.pruneReq.run(cutoff); q.pruneSpan.run(cutoff); });
  }

  function close() {
    if (closed) return;
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { closed = true; db.close(); }
  }

  prune(retentionDays);
  return { file, ingestRequests, ingestSpans, recordHook, recordStatus, totals, reconcile, prune, close, _db: db };
  } catch (e) {
    // setup failed after the file was opened: release the handle (Windows keeps it locked)
    try { db.close(); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { openLedger, LedgerUnavailableError };
