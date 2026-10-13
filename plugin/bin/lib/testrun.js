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

/** @param {import('node:child_process').ChildProcess} child */
function killTree(child) {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    else { try { process.kill(-pid, 'SIGKILL'); } catch (_e) { child.kill('SIGKILL'); } }
  } catch (_e) { /* best effort */ }
}

/** Kill every running suite and run every pending cleanup. Used on SIGINT. */
function abortAll() {
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

/**
 * @param {{ root: string, fsafe: any, config: any, configHash: string, base: string, head: string, runId: string }} o
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
  if (cached) {
    baseSuite = cached;
    head = await runSuite(command, root, timeoutSec);
  } else if (parallel) {
    [baseSuite, head] = await Promise.all([runAtBase(root, o.base, command, timeoutSec, setup, wtTimeoutSec), runSuite(command, root, timeoutSec)]);
  } else {
    baseSuite = await runAtBase(root, o.base, command, timeoutSec, setup, wtTimeoutSec);
    head = await runSuite(command, root, timeoutSec);
  }
  addLog(baseCached ? 'base (cached, not re-run)' : 'base', baseSuite);
  addLog('head', head);

  const baseEnv = !baseCached && (baseSuite.timedOut || baseSuite.startFailed);
  // A baseline excuses only what it observed: it must have run, and if the head's runner
  // reports results, a failing base must have reported some too.
  const baseUsable = !baseEnv && !(baseSuite.exitCode !== 0 && !baseSuite.parsed && !!head.parsed);
  const basePassed = baseSuite.exitCode === 0 && baseSuite.failures.length === 0 && !baseSuite.timedOut && !baseSuite.startFailed;
  if (!baseCached && baseUsable && basePassed) {
    try {
      fsafe.writeJson(cacheRel(o.base), {
        sha: o.base, config_hash: o.configHash, command,
        suite: { exitCode: 0, failures: [], parsed: !!baseSuite.parsed, count: baseSuite.count || 0, plan: baseSuite.plan === undefined ? null : baseSuite.plan },
      });
    } catch (_e) { /* the cache is an optimisation */ }
  }

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
    command, log,
  };
}

module.exports = { sweepStale, tapValid, runAtBase, parseCounts, parseSummary, runTests, parseFailures, resolveCommand, abortAll, runSuite };
