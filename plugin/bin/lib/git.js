// @ts-check
'use strict';
/*
 * Hardened, read-only git for the plugin.
 *
 * This is a DELIBERATE COPY of the SAFE_ARGS / safeEnv approach in the app's
 * src/gitexec.js (see that file for the threat model). The plugin must not
 * require anything outside plugin/, so the two are kept in step by hand.
 * Only local commands are used here: rev-parse, symbolic-ref, status, merge-base,
 * ls-tree, show, and worktree add / remove / prune (the base-suite checkout). Every
 * revision is validated first and follows --end-of-options.
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

module.exports = { setExec, SAFE_ARGS, safeEnv, git, showBlob, isSha, isRefName, toplevel, resolveCommit, currentBranch };
