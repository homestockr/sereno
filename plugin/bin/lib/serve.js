// @ts-check
'use strict';
/*
 * sereno.js serve --start / --stop: the spec's dev server, for the browse red team.
 *
 * --start launches the spec's `serve` command detached (it outlives this command), waits for its
 * `ready` URL with the same polling as the test step's checks, and records the pid in
 * .sereno/cache/serve-<task>.json. --stop kills the process tree by that pid and removes the file.
 * The ship skill stops it after the reviewer on every path. Nothing here reads the pid file as
 * anything but data: the pid must be a plain integer.
 */

const rec = require('./records.js');
const speclib = require('./spec.js');
const testrun = require('./testrun.js');
const { SerenoError } = require('./fsafe.js');

const FILE_MAX = 16 * 1024;

/** @param {string} task @returns {string} */
function serveRel(task) { return '.sereno/cache/serve-' + rec.checkTask(task) + '.json'; }

/**
 * @param {{ readFile: (rel: string, max: number) => Buffer }} fsafe @param {string} rel
 * @returns {{ pid: number, started_at: string, ready: string | null } | null}
 */
function readServeFile(fsafe, rel) {
  let j;
  try { j = JSON.parse(fsafe.readFile(rel, FILE_MAX).toString('utf8')); } catch (_e) { return null; }
  if (!j || typeof j !== 'object' || !Number.isInteger(j.pid) || j.pid <= 1) return null;
  return { pid: j.pid, started_at: typeof j.started_at === 'string' ? rec.cleanText(j.started_at, 40) : '', ready: typeof j.ready === 'string' ? rec.cleanText(j.ready, 500) : null };
}

/**
 * @param {{ root: string, fsafe: any, task: string, opts?: { httpTimeoutMs?: number, readyTotalMs?: number, readyPollMs?: number } }} a
 * @returns {Promise<Record<string, any>>}
 */
async function start(a) {
  const rel = serveRel(a.task);
  const existing = readServeFile(a.fsafe, rel);
  if (existing && testrun.pidAlive(existing.pid)) {
    throw new SerenoError('serve_running', 'a server for task ' + a.task + ' is already running (pid ' + existing.pid + '); run serve --stop first', { task: a.task, pid: existing.pid });
  }
  let text;
  try { text = a.fsafe.readFile('.sereno/specs/' + a.task + '.md', 1024 * 1024).toString('utf8'); } catch (_e) { throw new SerenoError('not_found', 'no spec for task ' + a.task + '; run /sereno:task first'); }
  const checks = speclib.parseChecks(text);
  const serve = checks.find((c) => c.kind === 'serve');
  const browse = checks.filter((c) => c.kind === 'browse').length;
  if (!browse) return { task: a.task, started: false, reason: 'the spec has no browse checks; no server is needed' };
  if (!serve || serve.kind !== 'serve') return { task: a.task, started: false, reason: 'the spec has browse checks but no serve; nothing to start' };
  const r = await testrun.startDetached(serve.serve, serve.ready, a.root, a.opts);
  if (!r.ok) {
    try { a.fsafe.removeFile(rel); } catch (_e) { /* best effort */ }
    throw new SerenoError('server_not_ready', 'the serve step did not become ready: ' + r.why, { task: a.task });
  }
  const startedAt = new Date().toISOString();
  try {
    a.fsafe.writeJson(rel, { pid: r.pid, started_at: startedAt, ready: serve.ready });
  } catch (e) {
    testrun.killPid(r.pid || undefined);
    throw e;
  }
  return { task: a.task, started: true, pid: r.pid, ready: serve.ready, started_at: startedAt, file: rel };
}

/**
 * Kill the recorded server's tree and remove the file. Idempotent: no file is a successful no-op.
 * A recorded pid that is no longer running is only cleaned up, never signalled (pids get reused).
 * @param {{ fsafe: any, task: string }} a @returns {Record<string, any>}
 */
function stop(a) {
  const rel = serveRel(a.task);
  const f = readServeFile(a.fsafe, rel);
  if (!f) {
    try { a.fsafe.removeFile(rel); } catch (_e) { /* unreadable file; best effort */ }
    return { task: a.task, stopped: false, reason: 'no server recorded for task ' + a.task };
  }
  const alive = testrun.pidAlive(f.pid);
  if (alive) testrun.killPid(f.pid);
  a.fsafe.removeFile(rel);
  return { task: a.task, stopped: true, pid: f.pid, was_alive: alive };
}

/**
 * Leftover serve files, for doctor. @param {{ listDir: (rel: string) => string[], readFile: (rel: string, max: number) => Buffer }} fsafe
 * @returns {{ task: string, file: string, pid: number | null, alive: boolean }[]}
 */
function leftovers(fsafe) {
  /** @type {{ task: string, file: string, pid: number | null, alive: boolean }[]} */
  const out = [];
  let names = [];
  try { names = fsafe.listDir('.sereno/cache'); } catch (_e) { return out; }
  for (const n of names) {
    const m = /^serve-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/.exec(n);
    if (!m) continue;
    const f = readServeFile(fsafe, '.sereno/cache/' + n);
    out[out.length] = { task: m[1], file: '.sereno/cache/' + n, pid: f ? f.pid : null, alive: !!f && testrun.pidAlive(f.pid) };
  }
  return out;
}

module.exports = { start, stop, leftovers, serveRel, readServeFile };
