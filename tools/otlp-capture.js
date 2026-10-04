#!/usr/bin/env node
'use strict';
/*
 * Discovery probe for Claude Code's OpenTelemetry export.
 *
 * Listens on 127.0.0.1:4319 and appends every OTLP/JSON request it receives to
 * ./samples/otlp-<signal>.jsonl (logs, traces). Used with a throwaway session
 * to check what the ledger can rely on: which events and span attributes
 * actually arrive, and whether span agent_id matches hook agent_id.
 *
 * samples/*.jsonl is gitignored: these captures hold real session data.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.SERENO_PROBE_PORT) || 4319;
const SAMPLES = path.join(__dirname, '..', 'samples');
fs.mkdirSync(SAMPLES, { recursive: true });

http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const signal = (req.url || '').split('?')[0].replace(/^\/v1\//, '').replace(/[^a-z]/gi, '') || 'other';
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { parsed = { __unparsed: body.slice(0, 2000) }; }
    const record = { ts: Date.now(), path: req.url, contentType: req.headers['content-type'], body: parsed };
    try { fs.appendFileSync(path.join(SAMPLES, 'otlp-' + signal + '.jsonl'), JSON.stringify(record) + '\n'); } catch (_) {}
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('capturing OTLP/JSON on http://127.0.0.1:' + PORT + ' -> samples/otlp-*.jsonl');
});
