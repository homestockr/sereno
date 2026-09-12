'use strict';
/*
 * The collector: a plain node:http server living inside the Electron main
 * process. No daemon, no deps.
 *
 *   POST /hook    <- bin/emit.js hook <Event>
 *   POST /status  <- bin/emit.js statusline
 *   GET  /events  -> SSE stream of snapshots
 *   GET  /state   -> one snapshot as JSON
 *   GET  /        -> the widget page (also works in a plain browser tab)
 *
 * Bound to 127.0.0.1 only. Nothing here is authenticated because nothing here
 * leaves the loopback interface.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const BROADCAST_COALESCE_MS = 120;   // statusline fires ~1.5s/session; do not flood
const HEARTBEAT_MS = 15000;
const MAX_BODY = 1024 * 1024;
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

function createCollector(store, port) {
  const clients = new Set();
  let timer = null;

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
        frame = 'data: ' + JSON.stringify(store.snapshot()) + '\n\n';
      } catch (_) { return; }
      for (const res of clients) {
        try { res.write(frame); } catch (_) { clients.delete(res); }
      }
    }, BROADCAST_COALESCE_MS);
    if (timer.unref) timer.unref();
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
        try {
          if (url === '/hook') store.applyHook(msg.event || msg.payload.hook_event_name, msg.payload, meta);
          else store.applyStatus(msg.payload, meta);
        } catch (_) { /* a bad payload must never take the HUD down */ }
      });
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
      try { res.write('data: ' + JSON.stringify(store.snapshot()) + '\n\n'); } catch (_) {}
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
      res.end(JSON.stringify(store.snapshot()));
      return;
    }

    // --- static widget ------------------------------------------------
    let rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    try { rel = decodeURIComponent(rel); } catch (_) { /* keep the raw form */ }
    const file = path.resolve(RENDERER_DIR, rel);

    // A bare startsWith is not enough: it also matches SIBLING directories that
    // share the prefix, so "/../renderer-something/x" escaped this check and was
    // served. Requiring the separator confines it to the directory itself.
    if (file !== RENDERER_DIR && !file.startsWith(RENDERER_DIR + path.sep)) {
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
  });

  store.onChange = broadcast;

  return {
    server,
    broadcast,
    clientCount: () => clients.size,
    listen(cb) {
      server.on('error', (err) => cb && cb(err));
      server.listen(port, '127.0.0.1', () => cb && cb(null, server.address()));
    },
    close() {
      for (const res of clients) { try { res.end(); } catch (_) {} }
      clients.clear();
      try { server.close(); } catch (_) {}
    },
  };
}

module.exports = { createCollector };
