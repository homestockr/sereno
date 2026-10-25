// @ts-check
'use strict';
/*
 * Hardened, read-only git for the plugin.
 *
 * This is a DELIBERATE COPY of the SAFE_ARGS / safeEnv approach in the app's
 * src/gitexec.js (see that file for the threat model). The plugin must not
 * require anything outside plugin/, so the two are kept in step by hand.
 * Only local commands are used. Every git verb the plugin runs, anywhere (git.js,
 * spec.js, testrun.js, doctor.js, sereno.js):
 *   diff (--numstat, --stat: review.js), rev-parse, symbolic-ref, status (the clean-tree check, `cleanFiles`), merge-base (also
 *   `--is-ancestor`, `isAncestor`: is a task merged into its base)
 *   (skills), ls-tree, show, show-ref (spec.js: does the branch exist), branch (spec.js:
 *   create task/<name>), worktree add / list / remove / prune (the base-suite checkout
 *   and the stale sweep), and --version (doctor).
 * Every revision is validated first and follows --end-of-options.
 */

const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 10000;

/** Replaceable in tests (a slow or failing exec). @type {typeof execFileSync} */
let execImpl = execFileSync;
/** @param {typeof execFileSync | null} fn null restores the real one */
function setExec(fn) { execImpl = fn || execFileSync; }

const SAFE_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.ssh.allow=never',
  '-c', 'protocol.http.allow=never',
  '-c', 'protocol.https.allow=never',
  '-c', 'protocol.git.allow=never',
  '-c', 'protocol.ext.allow=never',
  '-c', 'credential.helper=',
  '-c', 'log.showSignature=false',
  '-c', 'gpg.program=',
  '-c', 'gpg.ssh.program=',
  '-c', 'gpg.x509.program=',
];

/** @param {NodeJS.ProcessEnv} [base] */
function safeEnv(base) {
  return Object.assign({}, base || process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
}

/**
 * @param {string} cwd @param {string[]} args @param {number} [timeoutMs]
 * @returns {string | null} trimmed stdout, or null when git fails
 */
function git(cwd, args, timeoutMs) {
  try {
    return String(execImpl('git', SAFE_ARGS.concat(args), {
      cwd, env: safeEnv(), encoding: 'utf8', timeout: timeoutMs || GIT_TIMEOUT_MS, windowsHide: true,
      maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch (_e) { return null; }
}

/** @param {unknown} s @returns {boolean} */
function isSha(s) { return typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s); }

/** A conservative branch or ref name: never option-shaped, no revision syntax. @param {unknown} s */
function isRefName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(s)
    && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('//');
}

/** Plugin-generated directories under .sereno/: the only paths a clean-tree check ignores. */
const GENERATED_DIRS = ['.sereno/attempts', '.sereno/gates', '.sereno/briefs', '.sereno/cache'];

/**
 * Tracked files with uncommitted changes, checked from the repo root whatever the
 * caller's cwd (root-anchored pathspecs). null when git fails. Generated .sereno/ dirs
 * are ignored; .sereno/pipeline.json and .sereno/specs/ are not.
 * @param {string} root @returns {string[] | null}
 */
function cleanFiles(root) {
  const out = git(root, ['status', '--porcelain', '--untracked-files=no', '--', ':/'].concat(GENERATED_DIRS.map((d) => ':(exclude,top)' + d)));
  if (out === null) return null;
  return out.split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^[ MADRCTU]{1,2} /, '')); // git() trims, so line 1 may lack its leading space
}

/** @param {string} cwd @returns {string | null} */
function toplevel(cwd) {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  return out ? out : null;
}

/** Resolve a sha or ref name to a full 40-hex commit id, or null. @param {string} cwd @param {string} rev */
function resolveCommit(cwd, rev) {
  if (!isSha(rev) && !isRefName(rev)) return null;
  const out = git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{commit}']);
  return out && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/**
 * Is commit `a` an ancestor of (or equal to) commit `b`? Both are resolved first, so only
 * 40-hex ids reach git. null when either does not resolve or git fails.
 * @param {string} cwd @param {string} a @param {string} b @returns {boolean | null}
 */
function isAncestor(cwd, a, b) {
  const x = resolveCommit(cwd, a), y = resolveCommit(cwd, b);
  if (!x || !y) return null;
  try {
    execImpl('git', SAFE_ARGS.concat(['merge-base', '--is-ancestor', x, y]), { cwd, env: safeEnv(), timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: 'ignore' });
    return true;
  } catch (e) { return /** @type {any} */ (e) && /** @type {any} */ (e).status === 1 ? false : null; }
}

/** Current branch name, or null when detached. @param {string} cwd */
function currentBranch(cwd) {
  const out = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return out && isRefName(out) ? out : null;
}

/**
 * Blob at <commit>:<path>, read from the object database (never the working tree,
 * so a symlink in the worktree cannot redirect it). The caller has already
 * validated commit (40 hex) and rel (clean repo-relative path).
 * @param {string} cwd @param {string} commit @param {string} rel @param {number} maxBytes
 * @returns {{ kind: 'blob' | 'symlink' | 'other', size: number, bytes: Buffer } | null} null when absent
 */
function showBlob(cwd, commit, rel, maxBytes) {
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  const tree = git(cwd, ['-c', 'core.quotePath=false', 'ls-tree', '-l', '--end-of-options', commit, '--', rel]);
  if (!tree) return null;
  const m = /^(\d{6}) (\w+) [0-9a-f]+\s+(\d+|-)\t(.*)$/.exec(tree);
  if (!m || m[4] !== rel) return null;
  if (m[1] === '120000') return { kind: 'symlink', size: 0, bytes: Buffer.alloc(0) };
  if (m[2] !== 'blob') return { kind: 'other', size: 0, bytes: Buffer.alloc(0) };
  const r = spawnSync('git', SAFE_ARGS.concat(['show', '--no-textconv', '--end-of-options', commit + ':' + rel]), {
    cwd, env: safeEnv(), timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: maxBytes + 1, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!r.stdout) return null;
  return { kind: 'blob', size: parseInt(m[3], 10), bytes: Buffer.from(r.stdout).subarray(0, maxBytes) };
}

module.exports = { cleanFiles, GENERATED_DIRS, setExec, SAFE_ARGS, safeEnv, git, showBlob, isSha, isRefName, toplevel, resolveCommit, currentBranch, isAncestor };
