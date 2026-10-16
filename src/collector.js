'use strict';
/*
 * The collector: a plain node:http server living inside the Electron main
 * process. No daemon, no deps.
 *
 *   POST /hook    <- bin/emit.js hook <Event>
 *   POST /status  <- bin/emit.js statusline
 *   GET  /events  -> SSE stream of snapshots
 *   GET  /state   -> one snapshot as JSON
 *   POST /v1/logs, /v1/traces <- OTLP/JSON (only with a ledger; else 200 and drop)
 *   GET  /ledger/summary -> ledger totals
 *   GET  /api/spend/{today,series,projects,top-prompts} -> spend views (ledger only)
 *   GET  /api/projects, /api/pipeline, /api/token; POST /api/review, /api/projects/<id>/hide (guarded)
 *   GET  /console[/*] -> the console pages (src/renderer/console)
 *   GET  /        -> the widget page (also works in a plain browser tab)
 *
 * Bound to 127.0.0.1 only. Nothing here is authenticated because nothing here
 * leaves the loopback interface.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const otlp = require('./otlp.js');
const spendtime = require('./spendtime.js');
const pipelineLib = require('./pipeline.js');
const wiring = require('./wiring.js');
const { emptyRoleSpend } = require('./ledger.js');
const { normalizePath } = require('./projects.js');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const CONSOLE_DIR = path.join(RENDERER_DIR, 'console');
const SPEND_TICK_MS = 60 * 1000;   // checks for a local-day rollover
const BROADCAST_COALESCE_MS = 120;   // statusline fires ~1.5s/session; do not flood
const HEARTBEAT_MS = 15000;
const MAX_BODY = 1024 * 1024;
const MAX_OTLP_BODY = 8 * 1024 * 1024;   // /v1/*: raw cap, and the gunzip output cap
const MAX_SSE_CLIENTS = 16;
const LIVE_ORDER = ['idle', 'thinking', 'running', 'blocked'];   // worst last
const MAX_ACTION_BODY = 4 * 1024;   // POST /api/review, /api/projects/<id>/hide
const HIDE_RE = /^\/api\/projects\/([A-Za-z0-9_-]{1,64})\/hide$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function readBody(req, cb) {
  let raw = '';
  let over = false;
  let done = false;
  // 'error' and 'end' can both fire; the callback must run exactly once.
  const finish = (v) => { if (done) return; done = true; cb(v); };

  req.on('data', (c) => {
    if (over) return;
    raw += c;
    if (raw.length > MAX_BODY) { over = true; raw = ''; req.destroy(); }
  });
  req.on('end', () => {
    if (over) return finish(null);
    try { finish(JSON.parse(raw)); } catch (_) { finish(null); }
  });
  req.on('error', () => finish(null));
  req.on('aborted', () => finish(null));
}

// Raw (Buffer) body reader for /v1. cb(err, buf); err is 'big' or 'aborted'.
// Unlike readBody it never touches the request after the cap trips: the caller
// answers 413 and closes.
function readRaw(req, cap, cb) {
  const chunks = [];
  let n = 0;
  let done = false;
  const finish = (e, v) => { if (done) return; done = true; cb(e, v); };
  req.on('data', (c) => {
    if (done) return;
    n += c.length;
    if (n > cap) { chunks.length = 0; finish('big'); return; }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks)));
  req.on('error', () => finish('aborted'));
  req.on('aborted', () => finish('aborted'));
}

// Serves one file confined to `dir`. A bare startsWith is not enough: it also
// matches SIBLING directories that share the prefix, so "/../renderer-something/x"
// escaped that check and was served. Requiring the separator confines it.
function serveStatic(res, dir, rel) {
  // No synchronous throw may escape: a NUL byte makes fs.readFile throw ERR_INVALID_ARG_VALUE.
  let file;
  try {
    rel = decodeURIComponent(rel);
    if (rel.includes('\0')) { res.writeHead(400).end('bad request'); return; }
    file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const ext = path.extname(file);
      const headers = {
        'content-type': TYPES[ext] || 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      };
      // frame-ancestors is ignored in a meta CSP, so HTML needs it as a real header.
      if (ext === '.html') headers['content-security-policy'] = "frame-ancestors 'none'";
      res.writeHead(200, headers);
      res.end(buf);
    });
  } catch (_) {
    try { if (!res.headersSent) res.writeHead(400).end('bad request'); else res.end(); } catch (_e) {}
  }
}

const SPEND_RANGES_SERIES = ['24h', '7d', '30d'];
const SPEND_RANGES_PERIOD = ['7d', '30d', 'month'];

function createCollector(store, port, opts) {
  // Swappable at runtime (setLedger): the tray toggles it without a restart.
  let ledger = (opts && opts.ledger) || null;
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
  const projects = (opts && opts.projects) || null;   // project registry (src/projects.js)
  const repos = (opts && opts.repos) || null;   // repo poller (src/repos.js)
  const pipelineAlerts = (opts && opts.pipelineAlerts && typeof opts.pipelineAlerts.open === 'function') ? opts.pipelineAlerts : null;   // src/pipeline-alerts.js machine (absent under npm run serve)
  const pluginStatusFn = (opts && typeof opts.pluginStatus === 'function') ? opts.pluginStatus : () => wiring.pluginStatus();   // tests inject; reads installed_plugins.json read-only
  const onReview = (opts && typeof opts.onReview === 'function') ? opts.onReview : null;   // absent under npm run serve
  // Per-launch secret for the console's POST actions; handed out by GET /api/token.
  const token = crypto.randomBytes(24).toString('base64url');
  const clients = new Set();
  let timer = null;

  // Spend in the snapshot: a cached ledger.today(), recomputed only on a logs
  // ingest, setLedger(), a local-day rollover, or first use. Never per broadcast.
  let spendCache = null;
  let spendDay = null;
  function computeSpend() {
    if (!ledger) { spendCache = { enabled: false }; spendDay = spendtime.dayStart(now()); return; }
    try {
      const t = ledger.today(now());
      const any = ledger.hasAny();
      spendCache = {
        enabled: true,
        todayMicros: t.costMicros,
        bySource: Object.assign({}, t.bySource),
        byAttribution: Object.assign({}, t.byAttribution),
        unattributedN: t.unattributedN,
        hasTelemetry: any === true,
      };
      spendDay = spendtime.dayStart(now());
    } catch (_) {
      // Keep a stale figure only within the same local day; never present yesterday's as today's.
      let sameDay = false;
      try { sameDay = spendDay !== null && spendtime.dayStart(now()) === spendDay; } catch (_) {}
      if (!spendCache || spendCache.unavailable || !spendCache.enabled || !sameDay) spendCache = { enabled: true, unavailable: true };
    }
  }
  function spendState() {
    if (!spendCache) computeSpend();
    return spendCache;
  }
  /**
   * Open pipeline decisions for the attention panel, from an explicit key list: no repo path
   * leaves here. sessionId (the only thing "Review in terminal" sends) is present only when a
   * live session sits inside the repo, most recently seen first.
   */
  function decisionList() {
    if (!pipelineAlerts) return [];
    let open = [];
    try { open = pipelineAlerts.open(); } catch (_) { return []; }
    const norm = (p) => String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const live = [];
    for (const s of store.sessions.values()) {
      const pub = store.publicSession(s);
      if (!pub.stale && pub.cwd && pub.id) live.push(pub);
    }
    live.sort((a, b) => b.lastSeen - a.lastSeen);
    return open.slice(0, 50).map((d) => {
      const roots = (Array.isArray(d.paths) ? d.paths : []).map(norm).filter(Boolean);
      const hit = live.find((s) => { const c = norm(s.cwd); return roots.some((r) => c === r || c.startsWith(r + '/')); });
      return Object.assign({
        projectId: String(d.projectId).slice(0, 128),
        project: String(d.project).slice(0, 128),
        task: String(d.task).slice(0, 128),
        reason: typeof d.reason === 'string' ? d.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200) : null,
        attempt: typeof d.attempt === 'number' && Number.isFinite(d.attempt) ? d.attempt : null,
      }, hit ? { sessionId: hit.id } : {});
    });
  }
  /** Stalled repairs, informational only: project and task names. */
  function stalledList() {
    if (!pipelineAlerts || typeof pipelineAlerts.stalled !== 'function') return [];
    try {
      return pipelineAlerts.stalled().slice(0, 50).map((d) => ({ project: String(d.project).slice(0, 128), task: String(d.task).slice(0, 128), kind: d.kind === 'repair' ? 'repair' : 'build' }));
    } catch (_) { return []; }
  }
  function snapshot() { return Object.assign(store.snapshot(), { spend: spendState(), decisions: decisionList(), stalled: stalledList() }); }
  function refreshSpend() { computeSpend(); broadcast(); }
  function tickSpend() {
    if (spendCache === null) return;   // nobody has asked yet; first use computes
    let d;
    try { d = spendtime.dayStart(now()); } catch (_) { return; }
    if (d !== spendDay) refreshSpend();
  }
  const spendTimer = setInterval(tickSpend, SPEND_TICK_MS);
  if (spendTimer.unref) spendTimer.unref();

  /*
   * The collector is unauthenticated by design - it trusts the local user. That
   * is only safe while "local" actually means local, so two things are checked
   * on every request.
   *
   * Host: a page on the internet can point a hostname at 127.0.0.1 (DNS
   * rebinding) and then read this server same-origin, which would hand it every
   * session's cwd, commands and costs. Pinning the Host header to loopback names
   * closes that.
   *
   * Origin: a cross-origin POST with content-type text/plain is a CORS "simple
   * request" and needs no preflight, so any page the user visits could inject
   * fake sessions and fire fake permission alerts. Browsers always attach Origin
   * to those; emit.js never does.
   */
  const allowedHosts = new Set([
    '127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port,
    // Ports are omitted when they are the scheme default; harmless to accept.
    '127.0.0.1', 'localhost', '[::1]',
  ]);
  const allowedOrigins = new Set([
    'http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port,
  ]);

  function localOnly(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host');
      return false;
    }
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(String(origin).toLowerCase())) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden origin');
      return false;
    }
    return true;
  }

  function broadcast() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!clients.size) return;
      let frame;
      try {
        frame = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
      } catch (_) { return; }
      for (const res of clients) {
        try { res.write(frame); } catch (_) { clients.delete(res); }
      }
    }, BROADCAST_COALESCE_MS);
    if (timer.unref) timer.unref();
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
  }
  const pick = (o) => Object.assign({}, o);   // plain-copy a { key: micros } map

  // Every response is built from an explicit key list: nothing the ledger returns
  // can leak into the API by accident.
  function handleApi(req, res, url) {
    if (url === '/api/pipeline') { sendJson(res, 200, buildPipeline()); return; }
    const m = /^\/api\/spend\/(today|series|projects|top-prompts)$/.exec(url);
    if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
    if (!ledger) { sendJson(res, 200, { enabled: false }); return; }
    let sp;
    try { sp = new URL(req.url, 'http://x').searchParams; } catch (_) { sp = new URLSearchParams(); }
    const bad = (why) => res.writeHead(400, { 'content-type': 'text/plain' }).end(why);
    const asOf = now();
    try {
      if (m[1] === 'today') {
        const t = ledger.today(asOf);
        const hasTelemetry = ledger.hasAny() === true;
        sendJson(res, 200, {
          enabled: true, hasTelemetry, asOf, day: t.day, costMicros: t.costMicros, requests: t.requests,
          bySource: pick(t.bySource), byAttribution: pick(t.byAttribution), unattributedN: t.unattributedN,
        });
        return;
      }
      if (m[1] === 'series') {
        const range = sp.get('range') === null ? '30d' : sp.get('range');
        if (!SPEND_RANGES_SERIES.includes(range)) return bad('range must be 24h, 7d or 30d');
        const spec = range === '24h' ? spendtime.hourBuckets(asOf) : spendtime.lastNDays(range === '7d' ? 7 : 30, asOf);
        const rows = ledger.series(spec.map((b) => ({ key: b.key || b.day, since: b.since, until: b.until })));
        sendJson(res, 200, {
          enabled: true, asOf, range,
          buckets: rows.map((r, i) => ({
            key: r.key, since: spec[i].since, until: spec[i].until, costMicros: r.costMicros, requests: r.requests,
            bySource: pick(r.bySource), byAttribution: pick(r.byAttribution),
          })),
        });
        return;
      }
      // projects and top-prompts share the period ranges
      const range = sp.get('range') === null ? 'month' : sp.get('range');
      if (!SPEND_RANGES_PERIOD.includes(range)) return bad('range must be 7d, 30d or month');
      const until = spendtime.dayBounds(asOf).until;
      const since = range === 'month' ? spendtime.monthStart(asOf) : spendtime.lastNDays(range === '7d' ? 7 : 30, asOf)[0].since;
      if (m[1] === 'projects') {
        const p = ledger.projects({ since, until });
        const days = spendtime.lastNDays(14, asOf);
        const tr = ledger.trends({ buckets: days });
        sendJson(res, 200, {
          enabled: true, asOf, range,
          rows: p.rows.map((r) => ({
            project: r.project, costMicros: r.costMicros, requests: r.requests,
            bySource: pick(r.bySource), byAttribution: pick(r.byAttribution),
            trend: tr.get(r.project ?? null) || days.map(() => 0),
          })),
          unattributed: { costMicros: p.unattributed.costMicros, requests: p.unattributed.requests },
        });
        return;
      }
      // top-prompts
      const lv = sp.get('limit');
      const limit = lv !== null && lv.trim() !== '' && Number.isFinite(Number(lv)) ? Number(lv) : 10;
      const rows = ledger.topPrompts({ since, until, limit });
      sendJson(res, 200, {
        enabled: true, asOf, range,
        rows: rows.map((r) => ({
          ts: r.ts, project: r.project, sessionShort: r.sessionShort, costMicros: r.costMicros,
          models: r.models.slice(), attribution: r.attribution,
        })),
      });
    } catch (_) {
      try { res.writeHead(503, { 'content-type': 'text/plain' }).end('ledger unavailable'); } catch (_e) {}
    }
  }

  /*
   * GET /api/projects. Built from explicit key lists and from the poller's
   * in-memory snapshot, so a request never runs git. No path, hash, cwd or commit
   * message leaves here; brief lines are already capped and control-stripped.
   */
  function buildProjects() {
    const asOf = now();
    const reg = projects ? projects.list() : [];
    let snap = {};
    try { snap = repos ? repos.snapshot() : {}; } catch (_) { snap = {}; }
    // publicSession() carries the stale flag; store.sessions holds top-level sessions only.
    const sessions = Array.from(store.sessions.values()).map((x) => store.publicSession(x));
    const days = spendtime.lastNDays(14, asOf);
    const pathsOf = (p, st) => {
      const set = new Set();
      for (const x of [p.repoPath].concat(st && Array.isArray(st.worktrees) ? st.worktrees.map((w) => w.path) : [])) {
        if (typeof x !== 'string' || !x) continue;
        try { set.add(normalizePath(x).replace(/\/$/, '')); } catch (_) {}
      }
      return Array.from(set);
    };
    // Length of the longest worktree path that is a prefix of cwd (0 = none), so a nested repo wins.
    const depth = (cwd, norms) => {
      if (typeof cwd !== 'string' || !cwd) return 0;
      let n;
      try { n = normalizePath(cwd); } catch (_) { return 0; }
      let best = 0;
      for (const x of norms) if ((n === x || n.startsWith(x + '/')) && x.length > best) best = x.length;
      return best;
    };
    // A hidden project is not polled, so it shows no git state even if a stale entry lingers.
    const meta = reg.map((p) => ({ p, st: p.hidden ? undefined : snap[p.id] }));
    let spend = null;
    if (ledger) {
      try {
        spend = ledger.spendByCwdPrefix({
          prefixes: meta.map((m) => ({ key: m.p.id, paths: pathsOf(m.p, m.st) })),
          buckets: days,
        });
      } catch (_) { spend = null; }
    }
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const briefTime = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
    const normsOf = new Map(meta.map((m) => [m.p.id, pathsOf(m.p, m.st)]));
    const owns = (cwd, id) => {
      const mine = depth(cwd, normsOf.get(id) || []);
      if (!mine) return false;
      for (const [oid, ns] of normsOf) if (oid !== id && depth(cwd, ns) > mine) return false;
      return true;
    };
    const out = meta.map(({ p, st }) => {
      const sp = spend && spend.get(p.id);
      let last = st ? num(st.lastCommitAt) : null;
      for (const s of sessions) {
        if (owns(s.cwd, p.id) && typeof s.lastSeen === 'number' && (last === null || s.lastSeen > last)) last = s.lastSeen;
      }
      if (sp && sp.lastTs !== null && (last === null || sp.lastTs > last)) last = sp.lastTs;
      // Live sessions: same cwd-under-worktree join; the best state wins (blocked > running > thinking > idle).
      const liveIds = [];
      let liveRank = -1;
      for (const s of sessions) {
        if (s.stale || !owns(s.cwd, p.id)) continue;
        liveIds.push(s.id);
        liveRank = Math.max(liveRank, LIVE_ORDER.indexOf(s.state));
      }
      const b = st && st.brief;
      return {
        id: p.id,
        name: p.name,
        hidden: p.hidden === true,
        freshness: st && typeof st.freshness === 'string' ? st.freshness : 'none',
        brief: b ? { now: b.now ?? null, next: b.next ?? null, blocked: b.blocked ?? null, generatedAt: b.generatedAt ?? null, behindSince: st ? num(st.behindSince) : null } : null,
        git: {
          defaultBranch: st && typeof st.defaultBranch === 'string' ? st.defaultBranch : null,
          ahead: st ? num(st.ahead) : null,
          behind: st ? num(st.behind) : null,
          dirty: st && typeof st.dirty === 'boolean' ? st.dirty : null,
          lastCommitAt: st ? num(st.lastCommitAt) : null,
        },
        prs: st ? num(st.prs) : null,
        branches: st && Array.isArray(st.branches)
          ? st.branches.map((x) => ({ name: x.name, freshness: x.freshness || 'none', now: x.brief ? (x.brief.now ?? null) : null, generatedAt: x.brief ? briefTime(x.brief.generatedAt) : null, behindSince: num(x.behindSince) }))
          : [],
        spend14: sp ? { costMicros: sp.costMicros, trend: sp.trend.slice() } : null,
        lastActivity: last,
        live: { state: liveRank >= 0 ? LIVE_ORDER[liveRank] : null, sessionIds: liveIds },
        error: st ? st.error === true : false,
        briefsMalformed: st ? (num(st.briefsMalformed) || 0) : 0,
      };
    });
    return { asOf, projects: out };
  }

  /*
   * GET /api/pipeline. Built from the poller's in-memory snapshot (never runs git) and
   * from explicit key lists: no command, prompt, spec body, hash, session or agent id,
   * or repo path leaves here. Findings are the one place a file name appears.
   */
  const PIPE_ROLES = ['builder', 'red-team', 'scribe', 'main', 'auxiliary', 'unattributed'];
  const PIPE_DAYS = 30;
  const pStr = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : null);
  const pNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pBool = (v) => v === true;
  function pipeGate(g) {
    if (!g || typeof g !== 'object') return null;
    return { review_run_id: pStr(g.review_run_id, 64), outcome: pStr(g.outcome, 32), tests_passed: pBool(g.tests_passed), reviewed_at: pStr(g.reviewed_at, 40), model: pStr(g.model, 128) };
  }
  function pipeFinding(f) {
    f = f && typeof f === 'object' ? f : {};
    return { severity: pStr(f.severity, 16), kind: pStr(f.kind, 32), file: pStr(f.file, 260), line: pNum(f.line), summary: pStr(f.summary, 300) };
  }
  /** Ledger spend (USD, an estimate) over a task's runs: each gate's agent and each attempt's agent; null when nothing was measured. */
  function taskCost(t) {
    if (!ledger || typeof ledger.spendForAgentId !== 'function') return null;
    let sum = 0, any = false;
    const seen = new Set();
    const add = (c) => { if (Number.isFinite(c) && c > 0) { sum += c; any = true; } };
    try {
      for (const g of (Array.isArray(t.gates) ? t.gates : [])) {
        if (!g || typeof g.agent_id !== 'string' || !g.agent_id || seen.has(g.agent_id)) continue;
        seen.add(g.agent_id);
        add(typeof g.session_id === 'string' && g.session_id ? ledger.spendForAgent(g.session_id, g.agent_id) : ledger.spendForAgentId(g.agent_id));
      }
      for (const a of (Array.isArray(t.attempts) ? t.attempts : [])) {
        if (!a || typeof a.agent_id !== 'string' || !a.agent_id || seen.has(a.agent_id)) continue;
        seen.add(a.agent_id);
        add(ledger.spendForAgentId(a.agent_id));
      }
    } catch (_) { return null; }
    return any ? sum : null;
  }
  function pipeTask(t) {
    return {
      task: pStr(t.task, 128), stage: pStr(t.stage, 32), step: pStr(t.step, 120), reason: pStr(t.reason, 64), attempt: pNum(t.attempt),
      gate: pipeGate(t.gate),
      findings: Array.isArray(t.findings) ? t.findings.slice(0, 50).map(pipeFinding) : [],
      startedAt: pNum(t.startedAt), updatedAt: pNum(t.updatedAt), reviewRuns: pNum(t.reviewRuns) || 0, expired: pBool(t.expired),
      costUsd: taskCost(t),
    };
  }
  function pipeRedTeam(r) {
    if (!r || typeof r !== 'object') return null;
    return { agent: pStr(r.agent, 128), fallback: pStr(r.fallback, 128), onFallback: pStr(r.onFallback, 16) };
  }
  function buildPipeline() {
    const asOf = now();
    const reg = projects ? projects.list() : [];
    let snap = {};
    try { snap = repos ? repos.snapshot() : {}; } catch (_) { snap = {}; }
    const outProjects = [];
    const sigIn = [];
    const routingProjects = [];
    for (const p of reg) {
      if (p.hidden) continue;
      const st = snap[p.id];
      const pv = st && st.pipeline && typeof st.pipeline === 'object' ? st.pipeline : null;
      const all = pv && Array.isArray(pv.tasks) ? pv.tasks : [];
      const active = all.filter((t) => t && t.stage !== 'merged' && t.stage !== 'stopped');
      const rt = pv ? pv.redTeam : null;
      let idle = null;
      if (!active.length) {
        let latest = null;
        for (const t of all) for (const g of (Array.isArray(t.gates) ? t.gates : [])) {
          const at = g && typeof g.reviewed_at === 'string' ? Date.parse(g.reviewed_at) : NaN;
          if (Number.isFinite(at) && (!latest || at > latest.at)) latest = { at, outcome: g.outcome };
        }
        idle = rt && rt.enabled === false ? 'gate-off' : (latest && latest.outcome === 'pass' ? 'latest-pass' : 'no-task');
      }
      outProjects.push({ id: p.id, name: p.name, tasks: active.map(pipeTask), idle });
      sigIn.push({ id: p.id, tasks: all.map((t) => ({ task: t.task, stage: t.stage, gates: Array.isArray(t.gates) ? t.gates : [] })) });
      routingProjects.push({ id: p.id, redTeam: pipeRedTeam(rt) });
    }
    const sg = pipelineLib.signals(sigIn, asOf);
    const signals = {
      days: sg.days,
      projects: sg.projects.map((x) => ({ id: x.id, gate: x.gate ? { outcome: pStr(x.gate.outcome, 32), task: pStr(x.gate.task, 128), ageMs: pNum(x.gate.ageMs) } : null })),
      outcomes: { n: sg.outcomes.n, pass: sg.outcomes.pass, block: sg.outcomes.block, needs_context: sg.outcomes.needs_context, error: sg.outcomes.error, skipped: sg.outcomes.skipped },
      rework: { n: sg.rework.n, median: sg.rework.median, max: sg.rework.max, excluded: sg.rework.excluded },
      runsThisWeek: sg.runsThisWeek,
    };
    let rs = null;
    if (ledger) {
      try { rs = ledger.roleSpend(asOf - PIPE_DAYS * 24 * 3600 * 1000, pipelineLib.roleMap(), pipelineLib.inferModels()); } catch (_) { rs = null; }
    }
    const src = (rs || emptyRoleSpend()).roles;
    const roles = {};
    for (const k of PIPE_ROLES) {
      const r = src[k] || {};
      roles[k] = { costUsd: pNum(r.costUsd) || 0, explicit: pNum(r.explicit) || 0, inferred: pNum(r.inferred) || 0, unattributed: pNum(r.unattributed) || 0 };
    }
    let rpm;
    try { rpm = pipelineLib.redTeamPerMerge(sigIn, ledger && rs ? ledger.spendForAgent : null); } catch (_) { rpm = { mean: null, n: 0, excluded: 0 }; }
    return {
      projects: outProjects,
      signals,
      roleSpend: { enabled: !!rs, days: PIPE_DAYS, roles },
      redTeamPerMerge: { mean: pNum(rpm.mean), n: rpm.n, excluded: rpm.excluded },
      routing: {
        models: pipelineLib.agentModels().map((m) => ({ agent: m.agent, role: m.role, model: m.model })),
        projects: routingProjects,
      },
      plugin: (() => {
        let ps = null;
        try { ps = pluginStatusFn(); } catch (_) { ps = null; }
        ps = ps && typeof ps === 'object' ? ps : {};
        const installed = ps.installed === true;
        return { installed, detected: installed || ps.detected === true, version: installed && typeof ps.version === 'string' ? pStr(ps.version, 32) : null };
      })(),
    };
  }

  // The POST guard for console actions; localOnly (Host/Origin) has already run.
  // Every failure is a bare 403: no hint about which part failed.
  function actionGuard(req, res) {
    const deny = () => { res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden'); return false; };
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || (!allowedOrigins.has(origin) || origin.includes('[::1]'))) return deny();
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return deny();
    const got = Buffer.from(String(req.headers['x-sereno-token'] || ''));
    const want = Buffer.from(token);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return deny();
    return true;
  }

  function handleAction(req, res, url) {
    if (!actionGuard(req, res)) { req.resume(); return; }
    const plain = (code, text) => { try { res.writeHead(code, { 'content-type': 'text/plain' }).end(text); } catch (_) {} };
    const bad = () => { try { res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' }).end('bad request'); } catch (_) {} };
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_ACTION_BODY) { bad(); res.on('finish', () => req.destroy()); return; }
    readRaw(req, MAX_ACTION_BODY, (err, buf) => {
      if (err === 'big') { bad(); res.on('finish', () => req.destroy()); return; }
      if (err) return;
      let body;
      try { body = JSON.parse(buf.toString('utf8')); } catch (_) { return bad(); }
      const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
      const hideM = HIDE_RE.exec(url);
      try {
        if (!hideM) {   // review: the only input is a session id; the pid is the store's, never the request's
          if (!keys || keys.length !== 1 || keys[0] !== 'sessionId' || typeof body.sessionId !== 'string'
            || !body.sessionId || body.sessionId.length > 200) return bad();
          const s = store.sessions.get(body.sessionId);   // top-level sessions only
          if (!s) return plain(404, 'not found');
          if (!onReview) return plain(501, 'not available here');
          Promise.resolve().then(() => onReview(store.publicSession(s))).then(
            (ok) => { if (ok === false) plain(502, 'could not raise the terminal'); else { try { res.writeHead(204).end(); } catch (_) {} } },
            () => plain(500, 'failed'),
          );
          return;
        }
        if (!keys || keys.length !== 1 || keys[0] !== 'hidden' || typeof body.hidden !== 'boolean') return bad();
        if (!projects) return plain(404, 'not found');
        const ok = body.hidden ? projects.hide(hideM[1]) : projects.unhide(hideM[1]);
        if (!ok) return plain(404, 'not found');
        res.writeHead(204).end();
        if (repos && typeof repos.refresh === 'function') { try { Promise.resolve(repos.refresh()).catch(() => {}); } catch (_) {} }
      } catch (_) {
        try { if (!res.headersSent) plain(500, 'internal error'); } catch (_e) {}
      }
    });
  }

  function route(req, res) {
    const url = (req.url || '/').split('?')[0];

    if (!localOnly(req, res)) return;

    // --- ingest -------------------------------------------------------
    if (req.method === 'POST' && (url === '/hook' || url === '/status')) {
      // Defence in depth: application/json cannot be sent cross-origin without
      // a preflight, which this server never grants.
      const ctype = String(req.headers['content-type'] || '');
      if (!/^application\/json\b/i.test(ctype)) {
        res.writeHead(415, { 'content-type': 'text/plain' }).end('expected application/json');
        return;
      }
      // Consume the body BEFORE replying. Ending the response first lets Node
      // discard the rest of the request stream, which silently drops events
      // whenever the body does not arrive in the same packet as the headers.
      readBody(req, (msg) => {
        try { res.writeHead(204).end(); } catch (_) {}
        if (!msg || !msg.payload) return;
        const meta = { ppid: typeof msg.ppid === 'number' ? msg.ppid : null };
        const event = msg.event || msg.payload.hook_event_name;
        try {
          if (url === '/hook') store.applyHook(event, msg.payload, meta);
          else store.applyStatus(msg.payload, meta);
        } catch (_) { /* a bad payload must never take the HUD down */ }
        // Project registration runs git, so it runs after the response has been written.
        if (url === '/hook' && projects) {
          const cwd = msg.payload.cwd;
          if (typeof cwd === 'string' && cwd) {
            setImmediate(() => {
              try { Promise.resolve(projects.noteCwd(cwd)).catch(() => {}); } catch (_) { /* never affects the store or the response */ }
            });
          }
        }
        // The ledger is a record, not the live view: its failures stay here.
        if (ledger) {
          try {
            if (url === '/hook') ledger.recordHook(event, msg.payload);
            else {
              const p = msg.payload;
              const cost = p.cost && p.cost.total_cost_usd;
              if (typeof p.session_id === 'string' && typeof cost === 'number') {
                ledger.recordStatus(p.session_id, cost, Date.now());
              }
            }
          } catch (_) { /* never affects the store or the response */ }
        }
      });
      return;
    }

    // --- OTLP/JSON ingest ---------------------------------------------
    if (req.method === 'POST' && (url === '/v1/logs' || url === '/v1/traces')) {
      const ctype = String(req.headers['content-type'] || '');
      if (!/^application\/json\s*(;|$)/i.test(ctype)) {
        res.writeHead(415, { 'content-type': 'text/plain' })
          .end('expected application/json; OTLP protobuf is not supported (use OTEL_EXPORTER_OTLP_PROTOCOL=http/json)');
        return;
      }
      const enc = String(req.headers['content-encoding'] || '').toLowerCase().trim();
      if (enc && enc !== 'gzip' && enc !== 'identity') {
        res.writeHead(415, { 'content-type': 'text/plain' }).end('unsupported content-encoding');
        return;
      }
      const reply = (code, text) => {
        try {
          if (code === 200) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          else res.writeHead(code, { 'content-type': 'text/plain', connection: 'close' }).end(text || '');
        } catch (_) {}
      };
      readRaw(req, MAX_OTLP_BODY, (err, buf) => {
        if (err === 'big') { reply(413, 'body too large'); res.on('finish', () => req.destroy()); return; }
        if (err) return;
        const handle = (raw) => {
          let body;
          try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return reply(400, 'invalid json'); }
          if (!ledger) return reply(200);   // ledger off: accept and drop, nothing touches disk
          let inserted = false;
          try {
            if (url === '/v1/logs') {
              const rows = otlp.parseLogs(body);
              if (rows.length) { ledger.ingestRequests(rows); inserted = true; }
            } else {
              const spans = otlp.parseTraces(body);
              if (spans.length) { ledger.ingestSpans(spans); inserted = true; }
            }
          } catch (_) { return reply(503, 'ledger write failed'); }
          reply(200);
          if (inserted) refreshSpend();
        };
        if (enc !== 'gzip') return handle(buf);
        zlib.gunzip(buf, { maxOutputLength: MAX_OTLP_BODY }, (e, out) => {
          if (e) return reply(e.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, e.code === 'ERR_BUFFER_TOO_LARGE' ? 'body too large' : 'invalid gzip');
          handle(out);
        });
      });
      return;
    }

    if (req.method === 'GET' && url === '/ledger/summary') {
      if (!ledger) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ enabled: false }));
        return;
      }
      let sp;
      try { sp = new URL(req.url, 'http://x').searchParams; } catch (_) { sp = new URLSearchParams(); }
      const range = {};
      for (const k of ['since', 'until']) {
        const v = sp.get(k);
        if (v !== null && v.trim() !== '' && Number.isFinite(Number(v))) range[k] = Number(v);
      }
      let out;
      try { out = JSON.stringify(Object.assign({ enabled: true }, ledger.totals(range))); }
      catch (_) { res.writeHead(503, { 'content-type': 'text/plain' }).end('ledger unavailable'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(out);
      return;
    }

    // --- console actions ----------------------------------------------
    if (req.method === 'GET' && url === '/api/token') { sendJson(res, 200, { token }); return; }
    if (req.method === 'GET' && url === '/api/projects') { sendJson(res, 200, buildProjects()); return; }
    if (req.method === 'POST' && (url === '/api/review' || HIDE_RE.test(url))) { handleAction(req, res, url); return; }

    // --- spend API ----------------------------------------------------
    if (req.method === 'GET' && url.startsWith('/api/')) {
      handleApi(req, res, url);
      return;
    }

    // --- console ------------------------------------------------------
    if (req.method === 'GET' && (url === '/console' || url.startsWith('/console/'))) {
      const rel = url.slice('/console'.length).replace(/^\/+/, '');
      serveStatic(res, CONSOLE_DIR, rel === '' ? 'index.html' : rel);
      return;
    }

    // --- SSE ----------------------------------------------------------
    if (url === '/events') {
      // One widget plus the odd debugging tab. A cap keeps a runaway client from
      // pinning memory with stalled streams.
      if (clients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('too many subscribers');
        return;
      }
      const first = 'data: ' + JSON.stringify(snapshot()) + '\n\n';   // before writeHead: a throw is the router's 500
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      try { res.write(first); } catch (_) {}
      clients.add(res);

      const hb = setInterval(() => {
        try { res.write(': hb\n\n'); } catch (_) { clients.delete(res); }
      }, HEARTBEAT_MS);
      if (hb.unref) hb.unref();

      const drop = () => { clearInterval(hb); clients.delete(res); };
      req.on('close', drop);
      req.on('error', drop);
      return;
    }

    if (url === '/state') {
      const body = JSON.stringify(snapshot());   // build first: a throw becomes the router's 500
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // --- static widget ------------------------------------------------
    serveStatic(res, RENDERER_DIR, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  }
  // Last line of defence: nothing thrown while routing may take the process down.
  const server = http.createServer((req, res) => {
    try { route(req, res); }
    catch (_) {
      try { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error'); else res.end(); } catch (_e) {}
    }
  });
  // Slow-client guards: these bound receiving the request, not long-lived SSE responses.
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  store.onChange = broadcast;

  return {
    server,
    broadcast,
    setLedger(l) { ledger = l || null; refreshSpend(); },
    _tickSpend: tickSpend,
    clientCount: () => clients.size,
    listen(cb) {
      server.on('error', (err) => cb && cb(err));
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address();
        // Port 0 asks the OS for a free port: the Host/Origin checks must then accept the real one.
        if (port === 0 && addr && typeof addr === 'object') {
          port = addr.port;
          for (const h of ['127.0.0.1', 'localhost', '[::1]']) { allowedHosts.add(h + ':' + port); allowedOrigins.add('http://' + h + ':' + port); }
        }
        if (cb) cb(null, addr);
      });
    },
    close() {
      clearInterval(spendTimer);
      for (const res of clients) { try { res.end(); } catch (_) {} }
      clients.clear();
      try { server.close(); } catch (_) {}
    },
  };
}

module.exports = { createCollector, BROADCAST_COALESCE_MS };
