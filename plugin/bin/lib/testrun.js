// @ts-check
'use strict';
/*
 * sereno.js test: run the repo's suite at base (in a throwaway git worktree)
 * and at head (in the working tree), and diff the failures.
 *
 * Nothing here prints to stdout; full logs go to .sereno/cache through fsafe.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SerenoError } = require('./fsafe.js');
const gitlib = require('./git.js');

const DEFAULT_TIMEOUT_SEC = 900;
const DEFAULT_WORKTREE_TIMEOUT_SEC = 300;
const MAX_TIMEOUT_SEC = 2147483;
const MAX_CAPTURE = 4 * 1024 * 1024; // bytes kept in memory per suite for parsing
const MAX_LOG = 900 * 1024; // fsafe refuses files over 1 MiB; stay under it
const MAX_NAMES = 200;

/** @type {Set<import('node:child_process').ChildProcess>} */
const liveChildren = new Set();
/** @type {Set<() => void>} */
const cleanups = new Set();

/**
 * Kill a process and its children by pid: taskkill /T /F on win32, the process group (children
 * spawned detached lead their own) or the process itself elsewhere. Best effort.
 * @param {number | undefined} pid @param {import('node:child_process').ChildProcess} [child]
 */
function killPid(pid, child) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else { try { process.kill(-pid, 'SIGKILL'); } catch (_e) { if (child) child.kill('SIGKILL'); else process.kill(pid, 'SIGKILL'); } }
  } catch (_e) { /* best effort */ }
}

/** @param {import('node:child_process').ChildProcess} child */
function killTree(child) { killPid(child.pid, child); }

/** Is a process with this pid running? EPERM means it exists. @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/**
 * A start identity for a live pid, recorded beside it so a later --stop can tell the process it
 * started from a different process that was given the same pid. win32: the image name from
 * `tasklist` (the creation time needs PowerShell, which is too slow here). Elsewhere: the
 * `ps` start time. Null when it cannot be read.
 * @param {number} pid @returns {string | null}
 */
function procIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      const m = /^"([^"]{1,260})","(\d+)"/m.exec(String(r.stdout || ''));
      return m && parseInt(m[2], 10) === pid ? m[1].toLowerCase() : null;
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 10000 });
    const t = String(r.stdout || '').trim();
    return t ? t.slice(0, 100) : null;
  } catch (_e) { return null; }
}

let aborted = false;

/** Kill every running suite and run every pending cleanup. Used on SIGINT and the deadline. After it no suite starts. */
function abortAll() {
  aborted = true;
  for (const c of liveChildren) killTree(c);
  for (const f of Array.from(cleanups)) { try { f(); } catch (_e) { /* best effort */ } }
}

/** @param {string} s */
function stripAnsi(s) { return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''); }

/**
 * Failing test names from common runner output.
 * @param {string} output @returns {string[]}
 */
function parseFailures(output) { return parseFailuresInfo(output).names; }

/**
 * Like parseFailures, plus whether the MAX_NAMES cap was hit (the list is then incomplete).
 * @param {string} output @returns {{ names: string[], capped: boolean }}
 */
function parseFailuresInfo(output) {
  /** @type {Set<string>} */
  const seen = new Set();
  let capped = false;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    let name = null;
    let m = /^\s*not ok\s+\d+\s*-?\s*(.*)$/.exec(raw);
    if (m) { if (!/#\s*(SKIP|TODO)\b/i.test(m[1])) name = m[1]; }
    else if ((m = /^\s*(?:FAIL|✗|✕|✖)\s+(.+)$/.exec(raw))) name = m[1];
    else if ((m = /^\s*\d+\)\s+(.+)$/.exec(raw))) name = m[1];
    if (name === null) continue;
    name = name.replace(/\s+/g, ' ').trim().replace(/\s*\(\d+(?:\.\d+)?\s*m?s\)$/, '').slice(0, 200);
    if (/^failing tests?\b.*:$/i.test(name)) continue; // a summary header, not a test
    if (name && !seen.has(name)) { if (seen.size < MAX_NAMES) seen.add(name); else capped = true; }
  }
  return { names: Array.from(seen), capped };
}

/**
 * TAP-style result lines: how many were printed (any indent), how many at top level,
 * and the top-level plan (`1..N`) if one was printed.
 * @param {string} output @returns {{ count: number, top: number, plan: number | null }}
 */
function parseCounts(output) {
  let count = 0, top = 0, plan = null;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    if (/^\s*(?:not ok|ok)\s+\d+/.test(raw)) { count++; if (/^(?:not ok|ok)\s/.test(raw)) top++; }
    else { const m = /^1\.\.(\d+)\s*$/.exec(raw); if (m) plan = parseInt(m[1], 10); }
  }
  return { count, top, plan };
}

/**
 * The TAP summary footer (`# tests N`, `# pass P`, `# fail F`; node:test and tape print it) and the
 * number of `not ok` result lines seen at any indent.
 * @param {string} output @returns {{ nok: number, summary: { tests: number, pass: number | null, fail: number | null } | null }}
 */
function parseSummary(output) {
  let nok = 0, lastResult = -1, firstFooter = Infinity;
  /** @type {Record<string, number>} */
  const seen = { tests: 0, pass: 0, fail: 0 };
  /** @type {{ tests: number | null, pass: number | null, fail: number | null }} */
  const sm = { tests: null, pass: null, fail: null };
  const lines = stripAnsi(output).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(?:not ok|ok)\s+\d+/.test(raw)) { lastResult = i; if (/^\s*not ok/.test(raw)) nok++; continue; }
    const t = /^(?:#|ℹ)\s*(tests|pass|fail)\s+(\d+)\s*$/.exec(raw);
    if (t) { sm[/** @type {'tests'|'pass'|'fail'} */ (t[1])] = parseInt(t[2], 10); seen[t[1]]++; if (i < firstFooter) firstFooter = i; }
  }
  // The footer counts only when it follows the last result line and appears exactly once.
  const good = sm.tests !== null && seen.tests === 1 && seen.pass <= 1 && seen.fail <= 1 && firstFooter > lastResult;
  return { nok, summary: good ? { tests: /** @type {number} */ (sm.tests), pass: sm.pass, fail: sm.fail } : null };
}

/**
 * Is the TAP evidence trustworthy? Not if top-level test numbers repeat, if more than one
 * plan line is printed, or if the plan comes after results and anything TAP follows it
 * (a plan printed last must be the last TAP line). A test that deliberately prints fake
 * TAP lines can still mislead the count; the red team reviews the diff for that.
 * @param {string} output @returns {boolean}
 */
function tapValid(output) {
  const seen = new Set();
  let results = 0, plans = 0, planAfterResults = false, resultAfterLatePlan = false;
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const m = /^(?:not ok|ok)\s+(\d+)/.exec(raw);
    if (m) {
      if (seen.has(m[1])) return false;
      seen.add(m[1]);
      results++;
      if (planAfterResults) resultAfterLatePlan = true;
    } else if (/^1\.\.\d+\s*$/.test(raw)) {
      plans++;
      if (results > 0) planAfterResults = true;
    }
  }
  return plans <= 1 && !resultAfterLatePlan;
}

/**
 * @typedef {{ exitCode: number | null, timedOut: boolean, startFailed: boolean, output: string, failures: string[], parsed?: boolean, tapValid?: boolean, count?: number, top?: number, plan?: number | null, nok?: number, summary?: { tests: number, pass: number | null, fail: number | null } | null, capped?: boolean }} Suite
 */

/**
 * Run one suite through the platform shell. Never rejects.
 * @param {string} command @param {string} cwd @param {number} timeoutSec
 * @returns {Promise<Suite>}
 */
function runSuite(command, cwd, timeoutSec) {
  return new Promise((resolve) => {
    if (aborted) { resolve({ exitCode: null, timedOut: false, startFailed: true, output: '', failures: [] }); return; }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0, timedOut = false, spawnError = false, done = false;
    let child;
    try {
      child = spawn(command, { shell: true, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (_e) {
      resolve({ exitCode: null, timedOut: false, startFailed: true, output: '', failures: [] });
      return;
    }
    liveChildren.add(child);
    const take = (/** @type {Buffer} */ b) => {
      if (size >= MAX_CAPTURE) return;
      chunks[chunks.length] = b; size += b.length;
    };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const finish = (/** @type {number | null} */ code) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(grace);
      liveChildren.delete(child);
      const output = Buffer.concat(chunks).toString('utf8');
      const notFound = code === 127 || code === 9009
        || (code !== 0 && code !== null && output.length < 2000 && /is not recognized as an internal or external command|command not found|: not found/i.test(output));
      const counts = parseCounts(output), sum = parseSummary(output);
      const info = code === 0 ? { names: /** @type {string[]} */ ([]), capped: false } : parseFailuresInfo(output);
      resolve({
        count: counts.count, top: counts.top, plan: counts.plan, nok: sum.nok, summary: sum.summary, tapValid: tapValid(output),
        exitCode: code, timedOut, startFailed: spawnError || (!timedOut && notFound),
        // A run that hit the name cap is unparsed: no name-based excuse, exit-code rules apply.
        output, failures: info.capped ? [] : info.names, capped: info.capped,
        parsed: code !== 0 && info.names.length > 0 || /^\s*(?:not ok|ok)\s+\d+/m.test(stripAnsi(output)),
      });
    };
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      grace = setTimeout(() => finish(null), 3000);
    }, timeoutSec * 1000);
    child.on('error', () => { spawnError = true; finish(null); });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

/** @param {string} root @returns {string | null} */
function packageTestScript(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const t = pkg && pkg.scripts && pkg.scripts.test;
    if (typeof t !== 'string' || !t.trim()) return null;
    if (/no test specified/i.test(t)) return null;
    return 'npm test';
  } catch (_e) { return null; }
}

/** @param {any} config @param {string} root @returns {string | null} */
function resolveCommand(config, root) {
  const c = config && config.tests && config.tests.command;
  if (typeof c === 'string' && c.trim()) return c;
  return packageTestScript(root);
}

/**
 * Evidence that a failing head ran its whole suite: at least as many result lines as the
 * base printed, and, when a TAP plan is printed, a plan that was reached.
 * @param {Suite} head @param {Suite} base @returns {'complete' | 'incomplete' | 'unknown'}
 */
function headCompletion(head, base) {
  // No result counts and no plan anywhere (a non-TAP runner): nothing to prove completion with.
  if (head.tapValid === false) return 'unknown'; // repeated numbers or a misplaced plan: not evidence
  if (!head.count && !base.count && head.plan == null && base.plan == null) return 'unknown';
  if ((head.count || 0) < (base.count || 0)) return 'incomplete';
  if (head.plan != null) return (head.top || 0) >= head.plan ? 'complete' : 'incomplete';
  if (base.plan != null) return 'incomplete'; // the base reached a plan line; the head never printed one
  // Neither run printed a plan: a result count that merely matches the base proves nothing. Only a
  // TAP summary (node:test, tape) that agrees with the result lines seen shows the run finished.
  const sm = head.summary;
  if (sm && sm.tests === (head.count || 0) && (sm.fail === null || sm.fail === (head.nok || 0)) && (sm.pass === null || sm.pass + (sm.fail || 0) <= sm.tests)) return 'complete';
  return 'unknown';
}

/** @param {string} sha */
function cacheRel(sha) { return '.sereno/cache/base-' + sha + '.json'; }

/** @param {string} root @param {string} sha @param {string} configHash @param {string} command @returns {Suite | null} */
function readBaseCache(root, sha, configHash, command) {
  try {
    const p = path.join(root, cacheRel(sha));
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || j.config_hash !== configHash || j.command !== command || j.sha !== sha || !j.suite) return null;
    const s = j.suite;
    // Only a fully passing base is ever trusted: a planted "base passed" can only make head
    // failures count (the safe direction); a planted failure list could excuse real ones.
    if (s.exitCode !== 0 || !Array.isArray(s.failures) || s.failures.length !== 0) return null;
    if (!Number.isInteger(s.count) || s.count < 0) return null;
    return {
      exitCode: 0, timedOut: false, startFailed: false, output: '(cached)', parsed: s.parsed === true,
      failures: [], count: s.count, top: s.count, plan: Number.isInteger(s.plan) ? s.plan : null,
    };
  } catch (_e) { return null; }
}

const BASE_PREFIX = 'sereno-base-';
const BASE_MARKER = '.sereno-plugin-base';
const STALE_MS = 60 * 60 * 1000;

/**
 * Remove sereno-base-* temp dirs this plugin made (marker file inside) that are older
 * than maxAgeMs, left behind by an interrupted run. A node_modules link is removed
 * first and never followed; if it cannot be removed the dir is left alone.
 * @param {string} root @param {number} [maxAgeMs] @returns {number} dirs removed
 */
function sweepStale(root, maxAgeMs) {
  const age = maxAgeMs === undefined ? STALE_MS : maxAgeMs;
  let removed = 0;
  let tmpRoot;
  let names;
  try { tmpRoot = fs.realpathSync.native(os.tmpdir()); names = fs.readdirSync(tmpRoot); } catch (_e) { return 0; }
  for (const name of names) {
    if (!name.startsWith(BASE_PREFIX)) continue;
    const dir = path.join(tmpRoot, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const mk = fs.lstatSync(path.join(dir, BASE_MARKER));
      if (!mk.isFile() || Date.now() - mk.mtimeMs < age) continue;
      const wt = path.join(dir, 'wt');
      const link = path.join(wt, 'node_modules');
      let l = null;
      try { l = fs.lstatSync(link); } catch (_e) { l = null; }
      // Only a link (a junction reports as a symlink on Windows) is unlinked; a real directory
      // is removed with the rest by rmSync, which does not follow links.
      if (l && l.isSymbolicLink()) {
        try { fs.unlinkSync(link); } catch (_e) { try { fs.rmdirSync(link); } catch (_e2) { /* checked below */ } }
        try { fs.lstatSync(link); continue; } catch (_e) { /* gone */ }
      }
      let registered = false;
      try { registered = fs.existsSync(wt) && fs.existsSync(path.join(wt, '.git')); } catch (_e) { registered = false; }
      if (registered) gitlib.git(root, ['worktree', 'remove', '--force', wt]);
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (_e) { /* best effort */ }
  }
  if (removed) gitlib.git(root, ['worktree', 'prune']);
  return removed;
}

/**
 * Run the base suite in its own worktree; the worktree is always removed.
 * @param {string} root @param {string} sha @param {string} command @param {number} timeoutSec
 * @returns {Promise<Suite>}
 */
async function runAtBase(root, sha, command, timeoutSec, setup, wtTimeoutSec) {
  const wtMs = (wtTimeoutSec || DEFAULT_WORKTREE_TIMEOUT_SEC) * 1000;
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), BASE_PREFIX));
  try { fs.writeFileSync(path.join(tmp, BASE_MARKER), 'sereno plugin base worktree'); } catch (_e) { /* the sweep then skips this dir */ }
  const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(tmp).startsWith(fold(root + path.sep))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
    throw new SerenoError('worktree_failed', 'temp directory is inside the repository');
  }
  const wt = path.join(tmp, 'wt');
  let added = false;
  const link = path.join(wt, 'node_modules');
  let linked = false;
  const cleanup = () => {
    // Drop the node_modules link first, so nothing below can follow it into the real directory.
    if (linked) {
      try { fs.unlinkSync(link); } catch (_e) { try { fs.rmdirSync(link); } catch (_e2) { /* checked below */ } }
      try { fs.lstatSync(link); } catch (_e) { linked = false; }
      if (linked) { cleanups.delete(cleanup); return; } // never recurse through a link we could not remove
    }
    // `added` is set before the add runs: a timed-out add can leave a partial checkout.
    if (added) gitlib.git(root, ['worktree', 'remove', '--force', wt], wtMs);
    added = false;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
    gitlib.git(root, ['worktree', 'prune'], wtMs);
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  try {
    added = true;
    const out = gitlib.git(root, ['worktree', 'add', '--detach', wt, sha], wtMs);
    if (out === null) throw new SerenoError('worktree_failed', 'git worktree add failed for the base commit');
    if (typeof setup === 'string' && setup.trim()) {
      const st = await runSuite(setup, wt, timeoutSec);
      if (st.exitCode !== 0 || st.timedOut) {
        return { exitCode: st.exitCode, timedOut: st.timedOut, startFailed: true, output: '(base setup failed) ' + st.output, failures: [], parsed: false };
      }
    } else {
      const nm = path.join(root, 'node_modules');
      let isDir = false;
      try { const l = fs.lstatSync(nm); isDir = l.isDirectory() && !l.isSymbolicLink(); } catch (_e) { isDir = false; }
      if (isDir) {
        try { fs.symlinkSync(nm, link, process.platform === 'win32' ? 'junction' : 'dir'); linked = true; } catch (_e) { /* run without it */ }
      }
    }
    return await runSuite(command, wt, timeoutSec);
  } finally {
    cleanup();
  }
}

/* ---- runnable checks (plugin 0.5 H1) ---- */

const CHECK_CMD_TIMEOUT_MS = 120 * 1000;
const CHECK_HTTP_TIMEOUT_MS = 10 * 1000;
const CHECK_READY_TOTAL_MS = 60 * 1000;
const CHECK_READY_POLL_MS = 500;
const CHECK_STDOUT_MAX = 1024 * 1024;
const CHECK_BODY_MAX = 256 * 1024;
const CHECK_LOG_PART_MAX = 60 * 1024;
const CHECK_TARGET_MAX = 200;
const CHECK_DETAIL_MAX = 300;

/** At most 3 lines and 300 characters of output, control bytes stripped, lines joined with " | ". @param {string} s */
function checkDetail(s) {
  const lines = stripAnsi(s).split(/\r?\n/).map((l) => l.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.slice(0, 3).join(' | ').slice(0, CHECK_DETAIL_MAX);
}

/** @param {string} s @param {number} n */
function clip(s, n) { return s.length > n ? s.slice(0, n) : s; }

/**
 * Run one check command through the platform shell, keeping stdout apart from stderr. Tree-killed on
 * timeout or abort. Never rejects.
 * @param {string} command @param {string} cwd @param {number} timeoutMs
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, startFailed: boolean, stdout: string, stderr: string }>}
 */
function runCheckCmd(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    if (aborted) { resolve({ exitCode: null, timedOut: false, startFailed: true, stdout: '', stderr: '' }); return; }
    /** @type {Buffer[]} */ const out = [], err = [];
    let so = 0, se = 0, timedOut = false, spawnError = false, done = false;
    let child;
    try {
      child = spawn(command, { shell: true, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (_e) { resolve({ exitCode: null, timedOut: false, startFailed: true, stdout: '', stderr: '' }); return; }
    liveChildren.add(child);
    if (child.stdout) child.stdout.on('data', (/** @type {Buffer} */ b) => { if (so < CHECK_STDOUT_MAX) { out[out.length] = b; so += b.length; } });
    if (child.stderr) child.stderr.on('data', (/** @type {Buffer} */ b) => { if (se < CHECK_STDOUT_MAX) { err[err.length] = b; se += b.length; } });
    /** @type {NodeJS.Timeout | undefined} */ let grace;
    const fin = (/** @type {number | null} */ code) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      liveChildren.delete(child);
      resolve({ exitCode: code, timedOut, startFailed: spawnError, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    const timer = setTimeout(() => { timedOut = true; killTree(child); grace = setTimeout(() => fin(null), 3000); }, timeoutMs);
    child.on('error', () => { spawnError = true; fin(null); });
    child.on('close', (code) => fin(timedOut ? null : code));
  });
}

/**
 * GET one URL: no redirects followed, the body read up to 256 KiB, a 10 s overall limit. Never rejects.
 * @param {string} url @param {number} timeoutMs
 * @returns {Promise<{ status: number | null, body: string, error: string | null, timedOut: boolean }>}
 */
function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    /** @type {import('node:http').ClientRequest | null} */ let req = null;
    const fin = (/** @type {number | null} */ status, /** @type {string | null} */ error, /** @type {boolean} */ to) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { if (req) req.destroy(); } catch (_e) { /* best effort */ }
      resolve({ status, body: Buffer.concat(chunks).toString('utf8'), error, timedOut: to });
    };
    const timer = setTimeout(() => fin(null, 'timed out', true), timeoutMs);
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
      req = lib.get(u, { agent: false, headers: { 'user-agent': 'sereno-checks' } }, (/** @type {import('node:http').IncomingMessage} */ res) => {
        const status = res.statusCode || 0;
        res.on('data', (/** @type {Buffer} */ b) => {
          if (size < CHECK_BODY_MAX) { const take = b.subarray(0, CHECK_BODY_MAX - size); chunks[chunks.length] = take; size += take.length; }
          if (size >= CHECK_BODY_MAX) fin(status, null, false);
        });
        res.on('end', () => fin(status, null, false));
        res.on('error', (/** @type {Error} */ e) => fin(status, 'read error: ' + (/** @type {any} */ (e).code || 'error'), false));
      });
      req.on('error', (/** @type {Error} */ e) => fin(null, String((/** @type {any} */ (e).code) || 'request failed'), false));
    } catch (_e) { fin(null, 'request failed', false); }
  });
}

/** @param {number} ms */
const READY_SETTLE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a ready URL until it answers 2xx or 3xx. Shared by runChecks and `serve --start`.
 * @param {string} url @param {{ exited: () => boolean, aborted?: () => boolean, readyMs: number, pollMs: number, httpMs: number, anyStatus?: boolean }} o
 * @returns {Promise<boolean>}
 */
async function pollReady(url, o) {
  const until = Date.now() + o.readyMs;
  while (!(o.aborted && o.aborted()) && !o.exited() && Date.now() < until) {
    const r = await httpGet(url, Math.min(2000, o.httpMs));
    if (r.status !== null && (o.anyStatus || (r.status >= 200 && r.status < 400))) {
      // An answer only counts while the serve child is still alive: a server that was already there
      // (or a child that died of EADDRINUSE in the same tick) must not read as ready.
      if (o.exited()) return false;
      await sleep(READY_SETTLE_MS);
      return !o.exited();
    }
    await sleep(o.pollMs);
  }
  return false;
}

/**
 * Does anything answer at this URL (any HTTP status)? Used before spawning a `serve`, so a ready
 * URL that is already taken is never mistaken for the new server. Never rejects.
 * @param {string} url @param {number} httpMs @returns {Promise<boolean>}
 */
async function alreadyAnswers(url, httpMs) {
  const r = await httpGet(url, Math.min(2000, httpMs));
  return r.status !== null;
}

/**
 * Start a `serve` command detached so it outlives this process, wait for its ready URL, and return
 * its pid. On failure (not ready in time, or it exited) the tree is killed and ok is false. Never
 * rejects. On win32 `detached` gives the child its own console-less process group; elsewhere its
 * own session. The tree is found later by pid (taskkill /T on win32, the process group elsewhere).
 * @param {string} command @param {string | null} ready @param {string} cwd
 * @param {{ httpTimeoutMs?: number, readyTotalMs?: number, readyPollMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, pid: number | null, why: string }>}
 */
async function startDetached(command, ready, cwd, opts) {
  const o = opts || {};
  if (ready && await alreadyAnswers(ready, o.httpTimeoutMs || CHECK_HTTP_TIMEOUT_MS)) return { ok: false, pid: null, why: 'something already answers at ' + ready + '; stop it first' };
  let child;
  try {
    child = spawn(command, { shell: true, cwd, windowsHide: true, stdio: 'ignore', detached: true });
  } catch (_e) { return { ok: false, pid: null, why: 'could not start' }; }
  let exited = false, code = /** @type {number | null} */ (null);
  child.on('error', () => { exited = true; });
  child.on('exit', (c) => { exited = true; code = c; });
  const pid = child.pid || null;
  if (!pid) return { ok: false, pid: null, why: 'could not start' };
  const readyMs = o.readyTotalMs || CHECK_READY_TOTAL_MS;
  if (ready) {
    const ok = await pollReady(ready, { exited: () => exited, readyMs, pollMs: o.readyPollMs || CHECK_READY_POLL_MS, httpMs: o.httpTimeoutMs || CHECK_HTTP_TIMEOUT_MS });
    if (!ok) {
      killPid(pid, child);
      return { ok: false, pid, why: exited ? 'the server exited' + (code === null ? '' : ' with code ' + code) + ' before it was ready' : 'no 2xx or 3xx from ' + ready + ' within ' + Math.round(readyMs / 1000) + ' s' };
    }
  }
  child.unref();
  return { ok: true, pid, why: '' };
}

/**
 * @typedef {{ n: number, kind: string, target: string, result: 'pass' | 'fail' | 'timeout' | 'server_not_ready' | 'refused' | 'unverified', detail: string }} CheckResult
 */

/**
 * Run a spec's checks at the working tree. cmd and http run in order; browse is recorded as
 * unverified and never runs. A `serve` starts in the background first, is polled at its `ready` URL,
 * and is ALWAYS killed (tree kill) before this returns: in the finally block, and, through
 * liveChildren and cleanups, on SIGINT and the --deadline-sec abort. Never rejects.
 * @param {import('./spec.js').Check[]} checks @param {string} cwd
 * @param {{ cmdTimeoutMs?: number, httpTimeoutMs?: number, readyTotalMs?: number, readyPollMs?: number }} [opts] shorter limits for tests; the defaults are the contract
 * @returns {Promise<{ results: CheckResult[], logs: string[], servePid: number | null }>}
 */
async function runChecks(checks, cwd, opts) {
  const o = opts || {};
  const cmdMs = o.cmdTimeoutMs || CHECK_CMD_TIMEOUT_MS, httpMs = o.httpTimeoutMs || CHECK_HTTP_TIMEOUT_MS;
  const readyMs = o.readyTotalMs || CHECK_READY_TOTAL_MS, pollMs = o.readyPollMs || CHECK_READY_POLL_MS;
  /** @type {CheckResult[]} */ const results = [];
  /** @type {string[]} */ const logs = [];
  /** @type {import('node:child_process').ChildProcess | null} */ let server = null;
  let servePid = null;
  /** @type {Buffer[]} */ const serveOut = [];
  let serveSize = 0, serveExited = false, serveCode = /** @type {number | null} */ (null);
  const stopServer = () => {
    if (!server) return;
    const s = server; server = null;
    killTree(s);
    liveChildren.delete(s);
  };
  cleanups.add(stopServer);
  const record = (/** @type {{ n: number }} */ c, /** @type {string} */ kind, /** @type {string} */ target, /** @type {CheckResult['result']} */ result, /** @type {string} */ detail, /** @type {string} */ log) => {
    results[results.length] = { n: c.n, kind, target: clip(target, CHECK_TARGET_MAX), result, detail: clip(detail, CHECK_DETAIL_MAX) };
    logs[logs.length] = '===== check ' + c.n + ': ' + kind + ' (' + result + ') =====\n' + clip(log, CHECK_LOG_PART_MAX) + '\n';
  };
  let serverReady = true;
  try {
    for (const c of checks) {
      if (aborted) { record(c, c.kind, targetOf(c), 'refused', 'the run was interrupted', ''); continue; }
      if (c.kind === 'browse') { record(c, 'browse', c.url, 'unverified', clip(c.look, CHECK_DETAIL_MAX), c.look); continue; }
      if (c.kind === 'serve') {
        if (c.ready && await alreadyAnswers(c.ready, httpMs)) {
          serverReady = false;
          const why = 'something already answers at ' + c.ready + '; stop it first';
          record(c, 'serve', c.serve, 'fail', why, why);
          continue;
        }
        let child;
        try {
          child = spawn(c.serve, { shell: true, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
        } catch (_e) { record(c, 'serve', c.serve, 'fail', 'could not start', ''); serverReady = false; continue; }
        server = child; servePid = child.pid || null;
        liveChildren.add(child);
        const take = (/** @type {Buffer} */ b) => { if (serveSize < CHECK_LOG_PART_MAX) { serveOut[serveOut.length] = b; serveSize += b.length; } };
        if (child.stdout) child.stdout.on('data', take);
        if (child.stderr) child.stderr.on('data', take);
        child.on('error', () => { serveExited = true; });
        child.on('close', (code) => { serveExited = true; serveCode = code; });
        let readyUrl = c.ready;
        if (!readyUrl) {
          // No ready URL: when http checks follow, wait for the first one's URL to answer (any status).
          const first = checks.find((x) => x.kind === 'http' && x.n > c.n);
          if (!first || first.kind !== 'http') { record(c, 'serve', c.serve, 'pass', 'started (no ready URL)', ''); continue; }
          readyUrl = first.url;
        }
        const ok = await pollReady(readyUrl, { exited: () => serveExited, aborted: () => aborted, readyMs, pollMs, httpMs, anyStatus: !c.ready });
        if (ok) record(c, 'serve', c.serve, 'pass', (c.ready ? 'ready at ' : 'answering at ') + readyUrl, '');
        else {
          serverReady = false;
          const why = serveExited ? 'the server exited' + (serveCode === null ? '' : ' with code ' + serveCode) + ' before it was ready' : (c.ready ? 'no 2xx or 3xx from ' : 'no answer from ') + readyUrl + ' within ' + Math.round(readyMs / 1000) + ' s';
          record(c, 'serve', c.serve, 'server_not_ready', why, why + '\n' + Buffer.concat(serveOut).toString('utf8'));
        }
        continue;
      }
      if (c.kind === 'cmd') {
        const r = await runCheckCmd(c.cmd, cwd, cmdMs);
        const log = r.stdout + (r.stderr ? '\n[stderr]\n' + r.stderr : '');
        if (r.timedOut) { record(c, 'cmd', c.cmd, 'timeout', 'no exit within ' + Math.round(cmdMs / 1000) + ' s; killed', log); continue; }
        if (r.startFailed || r.exitCode === null) { record(c, 'cmd', c.cmd, 'fail', 'the command could not run', log); continue; }
        if (c.expect.type === 'exit') {
          if (r.exitCode === c.expect.code) record(c, 'cmd', c.cmd, 'pass', '', log);
          else record(c, 'cmd', c.cmd, 'fail', 'exit ' + r.exitCode + ', expected ' + c.expect.code + (checkDetail(log) ? ': ' + checkDetail(log) : ''), log);
        } else if (r.stdout.includes(c.expect.text)) record(c, 'cmd', c.cmd, 'pass', '', log);
        else record(c, 'cmd', c.cmd, 'fail', 'exit ' + r.exitCode + '; stdout does not contain the expected text' + (checkDetail(r.stdout) ? ': ' + checkDetail(r.stdout) : ''), log);
        continue;
      }
      // http
      if (!serverReady) { record(c, 'http', c.url, 'server_not_ready', 'the serve step did not become ready', ''); continue; }
      const r = await httpGet(c.url, httpMs);
      if (r.timedOut) { record(c, 'http', c.url, 'timeout', 'no complete response within ' + Math.round(httpMs / 1000) + ' s', ''); continue; }
      if (r.status === null) { record(c, 'http', c.url, 'fail', 'no response: ' + (r.error || 'error'), ''); continue; }
      if (c.expect.type === 'status') {
        if (r.status === c.expect.code) record(c, 'http', c.url, 'pass', '', 'status ' + r.status);
        else record(c, 'http', c.url, 'fail', 'status ' + r.status + ', expected ' + c.expect.code, 'status ' + r.status + '\n' + r.body);
      } else if (r.body.includes(c.expect.text)) record(c, 'http', c.url, 'pass', '', 'status ' + r.status);
      else record(c, 'http', c.url, 'fail', 'status ' + r.status + '; body does not contain the expected text', 'status ' + r.status + '\n' + r.body);
    }
  } finally {
    stopServer();
    cleanups.delete(stopServer);
  }
  return { results, logs, servePid };
}

/** @param {import('./spec.js').Check} c */
function targetOf(c) { return c.kind === 'cmd' ? c.cmd : c.kind === 'serve' ? c.serve : c.url; }

/**
 * @param {{ root: string, fsafe: any, config: any, configHash: string, base: string, head: string, runId: string, checks?: import('./spec.js').Check[], checkOpts?: object }} o
 */
async function runTests(o) {
  const { root, fsafe, config } = o;
  const command = resolveCommand(config, root);
  if (!command) throw new SerenoError('no_test_command', 'no tests.command in pipeline.json and no "test" script in package.json');
  const timeoutSec = config.tests && Number.isInteger(config.tests.timeoutSec) && config.tests.timeoutSec > 0 ? Math.min(config.tests.timeoutSec, MAX_TIMEOUT_SEC) : DEFAULT_TIMEOUT_SEC;
  const wtTimeoutSec = config.tests && Number.isInteger(config.tests.worktreeTimeoutSec) && config.tests.worktreeTimeoutSec > 0 ? Math.min(config.tests.worktreeTimeoutSec, MAX_TIMEOUT_SEC) : DEFAULT_WORKTREE_TIMEOUT_SEC;
  const setup = config.tests && typeof config.tests.setup === 'string' ? config.tests.setup : null;
  const parallel = !!(config.tests && config.tests.parallel === true);

  const cur = gitlib.resolveCommit(root, 'HEAD');
  if (cur !== o.head) throw new SerenoError('head_mismatch', 'HEAD is not the commit given in --head');
  // Only the plugin's generated dirs under .sereno/ are ignored; pipeline.json and specs/ count.
  const dirty = gitlib.cleanFiles(root);
  if (dirty === null || dirty.length) throw new SerenoError('head_mismatch', 'the working tree has uncommitted changes to tracked files');

  const cached = readBaseCache(root, o.base, o.configHash, command);
  const baseCached = cached !== null;
  /** @type {{ label: string, suite: Suite }[]} */
  const logParts = [];
  const addLog = (/** @type {string} */ label, /** @type {Suite} */ suite) => { logParts[logParts.length] = { label, suite }; };

  /** @type {Suite} */
  let baseSuite;
  /** @type {Suite} */
  let head;
  // The base cache is written the moment the base suite completes and passes in full, so a
  // deadline during the head run does not waste it. Same conditions as before.
  const cacheBase = (/** @type {Suite} */ s) => {
    if (aborted || s.timedOut || s.startFailed || s.exitCode !== 0 || s.failures.length) return;
    try {
      fsafe.writeJson(cacheRel(o.base), {
        sha: o.base, config_hash: o.configHash, command,
        suite: { exitCode: 0, failures: [], parsed: !!s.parsed, count: s.count || 0, plan: s.plan === undefined ? null : s.plan },
      });
    } catch (_e) { /* the cache is an optimisation */ }
  };
  const runBase = () => runAtBase(root, o.base, command, timeoutSec, setup, wtTimeoutSec).then((s) => { cacheBase(s); return s; });
  if (cached) {
    baseSuite = cached;
    head = await runSuite(command, root, timeoutSec);
  } else if (parallel) {
    [baseSuite, head] = await Promise.all([runBase(), runSuite(command, root, timeoutSec)]);
  } else {
    baseSuite = await runBase();
    head = await runSuite(command, root, timeoutSec);
  }
  addLog(baseCached ? 'base (cached, not re-run)' : 'base', baseSuite);
  addLog('head', head);

  const baseEnv = !baseCached && (baseSuite.timedOut || baseSuite.startFailed);
  // A baseline excuses only what it observed: it must have run, and if the head's runner
  // reports results, a failing base must have reported some too.
  const baseUsable = !baseEnv && !(baseSuite.exitCode !== 0 && !baseSuite.parsed && !!head.parsed);
  const basePassed = baseSuite.exitCode === 0 && baseSuite.failures.length === 0 && !baseSuite.timedOut && !baseSuite.startFailed;
  const headFailed = head.exitCode !== 0;
  const baseFailed = baseSuite.exitCode !== 0;
  const headEnv = head.timedOut || head.startFailed;
  const failing = [head, baseSuite].filter((s) => s.exitCode !== 0 && !(s.timedOut || s.startFailed));
  const mode = failing.length && !failing.every((s) => s.failures.length > 0) ? 'exit-code' : 'names';

  /** @type {string[]} */ let newFailures = [];
  /** @type {string[]} */ let flaky = [];
  let passed = true, diagnosis = 'none', baseFailing = false, incompleteRuns = false;
  /** @type {string | null} */ let note = null;
  const timedOut = head.timedOut || baseSuite.timedOut;
  const baseFailures = !baseUsable ? [] : baseSuite.failures.slice();

  if (headEnv || (headFailed && baseEnv)) {
    passed = false; diagnosis = 'environment';
  } else if (headFailed && !baseUsable) {
    passed = false; diagnosis = 'environment'; note = 'baseline could not run';
  } else if (headFailed) {
    if (mode === 'names') {
      const known = new Set(baseSuite.failures);
      const firstNew = head.failures.filter((n) => !known.has(n));
      if (!firstNew.length) {
        const c = headCompletion(head, baseSuite);
        if (c !== 'complete') {
          passed = false; diagnosis = 'unknown_baseline';
          note = c === 'unknown' ? 'cannot confirm the head suite completed' : 'head suite did not complete';
        }
      } else {
        // Re-run the WHOLE head suite once. Only a clean, complete re-run excuses the first
        // run's new failures as flaky; a failing re-run is never passed.
        const again = await runSuite(command, root, timeoutSec);
        addLog('head re-run', again);
        if (again.timedOut || again.startFailed) {
          newFailures = firstNew;
        } else if (again.exitCode === 0) {
          // A silent or shorter exit-0 re-run is never proof of a flaky pass.
          if (headCompletion(again, baseSuite) === 'incomplete' || (again.count || 0) < Math.max(baseSuite.count || 0, head.count || 0)) {
            passed = false; diagnosis = 'unknown_baseline'; note = 'head suite did not complete';
          } else {
            flaky = firstNew;
          }
        } else {
          newFailures = firstNew.concat(again.failures.filter((n) => !known.has(n) && !firstNew.includes(n)));
          // Nothing is believable about a run that did not reach its end: needs a decision.
          if (headCompletion(head, baseSuite) === 'incomplete' || headCompletion(again, baseSuite) === 'incomplete') {
            passed = false; diagnosis = 'unknown_baseline'; note = 'head suite did not complete'; incompleteRuns = true;
          }
        }
      }
    } else if (!baseFailed) {
      const again = await runSuite(command, root, timeoutSec);
      addLog('head re-run', again);
      if (again.exitCode === 0) {
        // Same rule as names mode: a silent or shorter exit-0 re-run is never proof of a flaky pass.
        if (headCompletion(again, baseSuite) === 'incomplete' || (again.count || 0) < Math.max(baseSuite.count || 0, head.count || 0)) {
          passed = false; diagnosis = 'unknown_baseline'; note = 'cannot confirm the re-run completed';
        } else flaky = ['(whole suite)'];
      } else { passed = false; diagnosis = 'defect'; note = 'exit-code mode: failing test names were not recognised; head fails and base passes'; }
    } else {
      baseFailing = true; passed = false; diagnosis = 'unknown_baseline';
      note = 'exit-code mode: the suite fails at base too, so the baseline says nothing about this failure; needs a decision';
    }
    if (newFailures.length && !incompleteRuns) { passed = false; diagnosis = 'defect'; }
  }

  // Runnable checks (spec `checks` block): at head only, in the repo root, after the suite. They never touch
  // the base/head comparison above. A failing or timed-out check is a new failure and a defect.
  /** @type {CheckResult[]} */ let checkResults = [];
  /** @type {string | null} */ let checksLog = null;
  if (o.checks && o.checks.length && !headEnv && !aborted) {
    const cr = await runChecks(o.checks, root, /** @type {any} */ (o.checkOpts));
    checkResults = cr.results;
    const bad = cr.results.filter((r) => r.result !== 'pass' && r.result !== 'unverified');
    if (bad.length) {
      for (const r of bad) newFailures[newFailures.length] = 'check ' + r.n + ': ' + r.kind;
      passed = false;
      if (diagnosis === 'none') diagnosis = 'defect';
    }
    let t = cr.logs.join('\n');
    if (Buffer.byteLength(t) > MAX_LOG) t = Buffer.from(t).subarray(0, MAX_LOG).toString('utf8') + '\n[log truncated]\n';
    const rel = '.sereno/cache/checks-' + o.runId + '.log';
    try { fsafe.writeFile(rel, t); checksLog = rel; } catch (_e) { /* logs are best effort */ }
  }

  const logRel = '.sereno/cache/test-' + o.runId + '.log';
  let text = '';
  for (const p of logParts) {
    text += '===== ' + p.label + ' (exit ' + p.suite.exitCode + (p.suite.timedOut ? ', timed out' : '') + ') =====\n' + p.suite.output + '\n';
  }
  if (Buffer.byteLength(text) > MAX_LOG) text = Buffer.from(text).subarray(0, MAX_LOG).toString('utf8') + '\n[log truncated]\n';
  /** @type {string | null} */
  let log = null;
  try { fsafe.writeFile(logRel, text); log = logRel; } catch (_e) { /* logs are best effort */ }

  return {
    passed, mode, newFailures, baseFailures, flaky, baseCached, baseUsable, timedOut, diagnosis,
    baseFailing, note, exit_codes: { base: baseSuite.exitCode, head: head.exitCode },
    command, log, checks: checkResults, checks_log: checksLog,
  };
}

module.exports = { killPid, pidAlive, procIdentity, startDetached, pollReady, runChecks, httpGet, sweepStale, tapValid, runAtBase, parseCounts, parseSummary, runTests, parseFailures, resolveCommand, abortAll, runSuite };
