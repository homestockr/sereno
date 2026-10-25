// @ts-check
'use strict';
/*
 * sereno.js preflight: would the repo's pre-commit hook refuse a commit of the current tree?
 *
 * It runs the hook, without committing anything, so a hook that fails for reasons
 * unrelated to the task (a drifted lockfile, a broken linter) is found before any Builder
 * tokens are spent. It never fixes anything and never tries to undo anything.
 *
 * A hook is code the repo owns, and some hooks modify files (lint --fix, formatters). This
 * command cannot stop that, so it takes a snapshot of `git status --porcelain` plus a hash
 * of `git diff HEAD` before and after, and reports `dirty_after: true` when they differ. The
 * caller decides what to do; nothing is reverted here. It is the one place the plugin
 * deliberately runs git WITHOUT the hardened SAFE_ARGS (hooksPath is the point).
 *
 * Which hook: `git hook run pre-commit` when git is 2.36 or newer and the hook exists at
 * `git rev-parse --git-path hooks/pre-commit` (this honours core.hooksPath, so husky's
 * generated shim is found). Otherwise the file is executed directly (through `sh` on
 * Windows), falling back to `.husky/pre-commit`. No hook means passed.
 *
 * Result: { hook: path | null, passed, timed_out, dirty_after, output_head }.
 * output_head is the first 5 lines of the hook's output, each cut to 200 characters.
 * Nothing is written to disk and nothing is sent anywhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const gitlib = require('./git.js');
const rec = require('./records.js');

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const HEAD_LINES = 5;
const LINE_MAX = 200;

/** @param {string} cwd @param {string[]} args @param {(f: string, a: string[], o: any) => any} spawn */
function plainGit(cwd, args, spawn) {
  const r = spawn('git', ['-c', 'core.fsmonitor=false'].concat(args), { cwd, env: gitlib.safeEnv(), encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r && r.status === 0 && !r.error ? String(r.stdout || '') : null;
}

/** Text that stands for the working tree's state. @param {string} cwd @param {(f: string, a: string[], o: any) => any} spawn */
function snapshot(cwd, spawn) {
  const st = plainGit(cwd, ['status', '--porcelain', '--untracked-files=all'], spawn);
  const df = plainGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD'], spawn);
  return (st === null ? '?' : st) + '\0' + (df === null ? '?' : crypto.createHash('sha256').update(df).digest('hex'));
}

/** @param {string} text @returns {string[]} */
function head(text) {
  return text.split(/\r?\n/).map((l) => rec.cleanText(l, LINE_MAX)).filter(Boolean).slice(0, HEAD_LINES);
}

/** @param {string} v "git version 2.54.0.windows.1" @returns {boolean} */
function hasHookRun(v) {
  const m = /(\d+)\.(\d+)/.exec(v);
  return !!m && (parseInt(m[1], 10) > 2 || (parseInt(m[1], 10) === 2 && parseInt(m[2], 10) >= 36));
}

/**
 * @param {{ root: string, timeoutMs?: number, spawn?: (f: string, a: string[], o: any) => any }} a
 */
function preflight(a) {
  const spawn = a.spawn || childProcess.spawnSync;
  const root = a.root;
  const timeout = Math.min(Math.max(a.timeoutMs || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

  /** @type {string | null} */
  let hookAbs = null;
  const gp = plainGit(root, ['rev-parse', '--git-path', 'hooks/pre-commit'], spawn);
  if (gp && gp.trim()) {
    const cand = path.resolve(root, gp.trim());
    if (isFile(cand)) hookAbs = cand;
  }
  const viaGit = hookAbs !== null;
  if (!hookAbs) {
    const husky = path.join(root, '.husky', 'pre-commit');
    if (isFile(husky)) hookAbs = husky;
  }
  if (!hookAbs) return { hook: null, passed: true, timed_out: false, dirty_after: false, output_head: [] };

  const rel = path.relative(root, hookAbs).split(path.sep).join('/');
  const hookLabel = rel && !rel.startsWith('..') ? rel : hookAbs;
  const before = snapshot(root, spawn);
  const gv = plainGit(root, ['--version'], spawn) || '';
  /** @type {any} */
  let r;
  const opts = { cwd: root, env: gitlib.safeEnv(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  if (viaGit && hasHookRun(gv)) r = spawn('git', ['hook', 'run', 'pre-commit'], opts);
  else if (process.platform === 'win32') r = spawn('sh', [hookAbs], opts);
  else r = spawn(hookAbs, [], opts);
  const after = snapshot(root, spawn);

  const timedOut = !!(r && r.error && /** @type {any} */ (r.error).code === 'ETIMEDOUT');
  const spawnFailed = !!(r && r.error && !timedOut);
  const out = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '') + (spawnFailed ? '\ncould not run the hook: ' + /** @type {any} */ (r.error).code : '');
  return {
    hook: hookLabel,
    passed: !timedOut && !spawnFailed && !!r && r.status === 0,
    timed_out: timedOut,
    dirty_after: before !== after,
    output_head: head(timedOut ? 'the hook did not finish within ' + Math.round(timeout / 1000) + ' s\n' + out : out),
  };
}

/** @param {string} p */
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_e) { return false; } }

module.exports = { preflight, head, hasHookRun, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
