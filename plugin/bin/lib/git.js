// @ts-check
'use strict';
/*
 * Hardened, read-only git for the plugin.
 *
 * This is a DELIBERATE COPY of the SAFE_ARGS / safeEnv approach in the app's
 * src/gitexec.js (see that file for the threat model). The plugin must not
 * require anything outside plugin/, so the two are kept in step by hand.
 * Only local plumbing is used here: rev-parse and symbolic-ref. Every revision
 * is validated first and follows --end-of-options.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 10000;

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
 * @param {string} cwd @param {string[]} args
 * @returns {string | null} trimmed stdout, or null when git fails
 */
function git(cwd, args) {
  try {
    return String(execFileSync('git', SAFE_ARGS.concat(args), {
      cwd, env: safeEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
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

module.exports = { SAFE_ARGS, safeEnv, git, isSha, isRefName, toplevel, resolveCommit, currentBranch };
