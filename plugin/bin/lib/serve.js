// @ts-check
'use strict';
/*
 * sereno.js serve --start / --stop: the spec's dev server, for the browse red team.
 *
 * --start launches the spec's `serve` command detached (it outlives this command), waits for its
 * `ready` URL with the same polling as the test step's checks, and records the pid in
 * .sereno/cache/serve-<task>.json as {pid, started_at, ready, ident} (ident is the process identity,
 * image name plus start time, or null when it could not be read). --stop kills the process tree by
 * that pid and removes the file; a positive identity mismatch means the pid was reused and nothing
 * is killed, an unreadable identity is unknown and is treated as the same process.
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
 * @returns {{ pid: number, started_at: string, ready: string | null, ident: string | null } | null}
 */
function readServeFile(fsafe, rel) {
  let j;
  try { j = JSON.parse(fsafe.readFile(rel, FILE_MAX).toString('utf8')); } catch (_e) { return null; }
  if (!j || typeof j !== 'object' || !Number.isInteger(j.pid) || j.pid <= 1) return null;
  return { pid: j.pid, started_at: typeof j.started_at === 'string' ? rec.cleanText(j.started_at, 40) : '', ready: typeof j.ready === 'string' ? rec.cleanText(j.ready, 500) : null, ident: typeof j.ident === 'string' && j.ident ? j.ident.slice(0, 120) : null };
}

/**
 * @param {{ root: string, fsafe: any, task: string, opts?: { httpTimeoutMs?: number, readyTotalMs?: number, readyPollMs?: number } }} a
 * @returns {Promise<Record<string, any>>}
 */
async function start(a) {
  const rel = serveRel(a.task);
  const existing = readServeFile(a.fsafe, rel);
  if (existing && testrun.pidAlive(existing.pid) && testrun.identityCheck(existing.ident, existing.pid) !== 'mismatch') {
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
    const ident = r.pid ? testrun.procIdentity(r.pid) : null;
    a.fsafe.writeJson(rel, { pid: r.pid, started_at: startedAt, ready: serve.ready, ident });
  } catch (e) {
    testrun.killPid(r.pid || undefined);
    throw e;
  }
  return { task: a.task, started: true, pid: r.pid, ready: serve.ready, started_at: startedAt, file: rel };
}

/**
 * Kill the recorded server's tree and remove the file. Idempotent: no file is a successful no-op.
 * A recorded pid that is no longer running is only cleaned up, never signalled (pids get reused).
 * @param {{ fsafe: any, task: string, killPid?: (pid: number) => void }} a @returns {Record<string, any>}
 */
function stop(a) {
  const rel = serveRel(a.task);
  const f = readServeFile(a.fsafe, rel);
  if (!f) {
    try { a.fsafe.removeFile(rel); } catch (_e) { /* unreadable file; best effort */ }
    return { task: a.task, stopped: false, reason: 'no server recorded for task ' + a.task };
  }
  const alive = testrun.pidAlive(f.pid);
  // Only a positive identity mismatch means the pid was reused and is never killed; an identity
  // that cannot be read is unknown and the process is killed, as before identities were recorded.
  const ident = alive ? testrun.identityCheck(f.ident, f.pid) : null;
  if (ident === 'mismatch') {
    a.fsafe.removeFile(rel);
    return { task: a.task, stopped: true, pid: f.pid, was_alive: false, reason: 'pid reused' };
  }
  if (alive) {
    (a.killPid || testrun.killPid)(f.pid);
    // The kill can lag or fail: look again for up to ~1 s. A survivor keeps its file so doctor lists it.
    let still = testrun.pidAlive(f.pid);
    for (let i = 0; still && i < 10; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      still = testrun.pidAlive(f.pid);
    }
    if (still) return { task: a.task, stopped: false, killed: false, pid: f.pid, was_alive: true, reason: 'still running after kill' };
  }
  a.fsafe.removeFile(rel);
  return ident ? { task: a.task, stopped: true, pid: f.pid, was_alive: true, ident } : { task: a.task, stopped: true, pid: f.pid, was_alive: false };
}

/**
 * Leftover serve files, for doctor. @param {{ listDir: (rel: string) => string[], readFile: (rel: string, max: number) => Buffer }} fsafe
 * @returns {{ task: string, file: string, pid: number | null, alive: boolean, identity: 'match' | 'mismatch' | 'unknown' | null }[]}
 */
function leftovers(fsafe) {
  /** @type {{ task: string, file: string, pid: number | null, alive: boolean, identity: 'match' | 'mismatch' | 'unknown' | null }[]} */
  const out = [];
  let names = [];
  try { names = fsafe.listDir('.sereno/cache'); } catch (_e) { return out; }
  for (const n of names) {
    const m = /^serve-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/.exec(n);
    if (!m) continue;
    const f = readServeFile(fsafe, '.sereno/cache/' + n);
    // Alive only when the pid runs and its identity matches or cannot be read; a mismatch is a reused pid.
    const running = !!f && testrun.pidAlive(f.pid);
    const identity = f && running ? testrun.identityCheck(f.ident, f.pid) : null;
    out[out.length] = { task: m[1], file: '.sereno/cache/' + n, pid: f ? f.pid : null, alive: running && identity !== 'mismatch', identity };
  }
  return out;
}

module.exports = { start, stop, leftovers, serveRel, readServeFile };
