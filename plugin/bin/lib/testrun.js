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
function parseFailures(output) {
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    let name = null;
    let m = /^\s*not ok\s+\d+\s*-?\s*(.*)$/.exec(raw);
    if (m) { if (!/#\s*(SKIP|TODO)\b/i.test(m[1])) name = m[1]; }
    else if ((m = /^\s*(?:FAIL|✗|✕)\s+(.+)$/.exec(raw))) name = m[1];
    else if ((m = /^\s*\d+\)\s+(.+)$/.exec(raw))) name = m[1];
    if (name === null) continue;
    name = name.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (name && seen.size < MAX_NAMES) seen.add(name);
  }
  return Array.from(seen);
}

/**
 * @typedef {{ exitCode: number | null, timedOut: boolean, startFailed: boolean, output: string, failures: string[], parsed?: boolean }} Suite
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
      resolve({
        exitCode: code, timedOut, startFailed: spawnError || (!timedOut && notFound),
        output, failures: code === 0 ? [] : parseFailures(output),
        parsed: code !== 0 && parseFailures(output).length > 0 || /^s*(?:not ok|ok)s+d+/m.test(stripAnsi(output)),
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
    if (!(s.exitCode === null || Number.isInteger(s.exitCode)) || !Array.isArray(s.failures)) return null;
    return {
      exitCode: s.exitCode, timedOut: false, startFailed: false, output: '(cached)', parsed: s.parsed === true,
      failures: s.failures.filter((/** @type {unknown} */ x) => typeof x === 'string').slice(0, MAX_NAMES),
    };
  } catch (_e) { return null; }
}

/**
 * Run the base suite in its own worktree; the worktree is always removed.
 * @param {string} root @param {string} sha @param {string} command @param {number} timeoutSec
 * @returns {Promise<Suite>}
 */
async function runAtBase(root, sha, command, timeoutSec, setup) {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'sereno-base-'));
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
    if (added) {
      gitlib.git(root, ['worktree', 'remove', '--force', wt]);
      added = false;
    }
    gitlib.git(root, ['worktree', 'prune']);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  try {
    const out = gitlib.git(root, ['worktree', 'add', '--detach', wt, sha]);
    if (out === null) throw new SerenoError('worktree_failed', 'git worktree add failed for the base commit');
    added = true;
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
  const timeoutSec = config.tests && Number.isInteger(config.tests.timeoutSec) && config.tests.timeoutSec > 0 ? config.tests.timeoutSec : DEFAULT_TIMEOUT_SEC;
  const setup = config.tests && typeof config.tests.setup === 'string' ? config.tests.setup : null;
  const parallel = !!(config.tests && config.tests.parallel === true);

  const cur = gitlib.resolveCommit(root, 'HEAD');
  if (cur !== o.head) throw new SerenoError('head_mismatch', 'HEAD is not the commit given in --head');
  const dirty = gitlib.git(root, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty === null || dirty !== '') throw new SerenoError('head_mismatch', 'the working tree has uncommitted changes to tracked files');

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
    [baseSuite, head] = await Promise.all([runAtBase(root, o.base, command, timeoutSec, setup), runSuite(command, root, timeoutSec)]);
  } else {
    baseSuite = await runAtBase(root, o.base, command, timeoutSec, setup);
    head = await runSuite(command, root, timeoutSec);
  }
  addLog(baseCached ? 'base (cached, not re-run)' : 'base', baseSuite);
  addLog('head', head);

  const baseEnv = !baseCached && (baseSuite.timedOut || baseSuite.startFailed);
  // A baseline excuses only what it observed: it must have run, and if the head's runner
  // reports results, a failing base must have reported some too.
  const baseUsable = !baseEnv && !(baseSuite.exitCode !== 0 && !baseSuite.parsed && !!head.parsed);
  if (!baseCached && baseUsable) {
    try {
      fsafe.writeJson(cacheRel(o.base), {
        sha: o.base, config_hash: o.configHash, command,
        suite: { exitCode: baseSuite.exitCode, failures: baseSuite.failures, parsed: !!baseSuite.parsed },
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
  let passed = true, diagnosis = 'none', baseFailing = false;
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
      const candidates = head.failures.filter((n) => !known.has(n));
      if (candidates.length) {
        const again = await runSuite(command, root, timeoutSec);
        addLog('head re-run', again);
        if (again.timedOut || again.startFailed) {
          newFailures = candidates;
        } else {
          const still = new Set(again.failures);
          newFailures = candidates.filter((n) => still.has(n) || (again.exitCode !== 0 && again.failures.length === 0));
          flaky = candidates.filter((n) => !newFailures.includes(n));
        }
      }
    } else if (!baseFailed) {
      const again = await runSuite(command, root, timeoutSec);
      addLog('head re-run', again);
      if (again.exitCode === 0) flaky = ['(whole suite)'];
      else { passed = false; diagnosis = 'defect'; note = 'exit-code mode: failing test names were not recognised; head fails and base passes'; }
    } else {
      baseFailing = true; passed = false; diagnosis = 'unknown_baseline';
      note = 'exit-code mode: the suite fails at base too, so the baseline says nothing about this failure; needs a decision';
    }
    if (newFailures.length) { passed = false; diagnosis = 'defect'; }
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

module.exports = { runTests, parseFailures, resolveCommand, abortAll, runSuite };
