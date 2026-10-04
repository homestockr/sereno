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
const otlp = require('./otlp.js');
const spendtime = require('./spendtime.js');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const CONSOLE_DIR = path.join(RENDERER_DIR, 'console');
const SPEND_TICK_MS = 60 * 1000;   // checks for a local-day rollover
const BROADCAST_COALESCE_MS = 120;   // statusline fires ~1.5s/session; do not flood
const HEARTBEAT_MS = 15000;
const MAX_BODY = 1024 * 1024;
const MAX_OTLP_BODY = 8 * 1024 * 1024;   // /v1/*: raw cap, and the gunzip output cap
const MAX_SSE_CLIENTS = 16;

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
  try { rel = decodeURIComponent(rel); } catch (_) { /* keep the raw form */ }
  const file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const SPEND_RANGES_SERIES = ['24h', '7d', '30d'];
const SPEND_RANGES_PERIOD = ['7d', '30d', 'month'];

function createCollector(store, port, opts) {
  // Swappable at runtime (setLedger): the tray toggles it without a restart.
  let ledger = (opts && opts.ledger) || null;
  const now = (opts && typeof opts.now === 'function') ? opts.now : Date.now;
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
      spendCache = {
        enabled: true,
        todayMicros: t.costMicros,
        bySource: Object.assign({}, t.bySource),
        byAttribution: Object.assign({}, t.byAttribution),
        unattributedN: t.unattributedN,
        hasTelemetry: t.requests > 0,
      };
      spendDay = spendtime.dayStart(now());
    } catch (_) {
      if (!spendCache || spendCache.unavailable) spendCache = { enabled: true, unavailable: true };   // nothing to keep yet
    }
  }
  function spendState() {
    if (!spendCache) computeSpend();
    return spendCache;
  }
  function snapshot() { return Object.assign(store.snapshot(), { spend: spendState() }); }
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
        sendJson(res, 200, {
          enabled: true, asOf, day: t.day, costMicros: t.costMicros, requests: t.requests,
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
        sendJson(res, 200, {
          enabled: true, asOf, range,
          rows: p.rows.map((r) => ({
            project: r.project, costMicros: r.costMicros, requests: r.requests,
            bySource: pick(r.bySource), byAttribution: pick(r.byAttribution),
            trend: ledger.trend({ project: r.project, buckets: days }),
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

  const server = http.createServer((req, res) => {
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      try { res.write('data: ' + JSON.stringify(snapshot()) + '\n\n'); } catch (_) {}
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot()));
      return;
    }

    // --- static widget ------------------------------------------------
    serveStatic(res, RENDERER_DIR, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
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
      server.listen(port, '127.0.0.1', () => cb && cb(null, server.address()));
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
