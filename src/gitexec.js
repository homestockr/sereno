// @ts-check
'use strict';
/*
 * The one place Sereno runs git.
 *
 * Threat model. Sereno defends against what a clone or an archive's WORKING TREE
 * can deliver: .gitattributes and filters, submodules, symlinks and junctions,
 * branch and ref names, brief files, huge files and option-shaped names.
 * The .git/ directory is trusted to the same degree the user's own git and
 * Claude Code trust it (Claude Code runs plain git in the same repos). Sereno
 * adds cheap defence in depth on top (SAFE_ARGS and the env below) but does NOT
 * claim that a repo's .git/config cannot make git run a program or contact
 * the network.
 *
 * Defence in depth: core.fsmonitor, core.hooksPath (the null device),
 * core.untrackedCache, protocol.allow=never plus every per-protocol key
 * (file, ssh, http, https, git, ext; those override the generic one),
 * credential.helper, GIT_NO_LAZY_FETCH (a partial clone must not fetch on a
 * poll), GIT_TERMINAL_PROMPT=0 and GIT_OPTIONAL_LOCKS=0 (status never writes
 * the index). Sereno itself runs no network command.
 * Submodules carry their own config, so status is run with
 * --ignore-submodules=all and never descends into them.
 * Content filters (filter.<name>.clean/smudge/process) are driver-named, so
 * they are blanked per call by the caller that runs status (see repos.js).
 * Signature programs are blanked too (log.showSignature=false, gpg.program,
 * gpg.ssh.program, gpg.x509.program).
 *
 * Only local drive-letter paths are ever used as a git cwd or read for briefs
 * (isLocalPath). A UNC path would open SMB connections (NTLM exposure) and block.
 * Projects on network drives or inside WSL are therefore not tracked.
 *
 * Every git command Sereno runs, and why it is safe (read-only; plumbing where
 * possible, because plumbing ignores porcelain config such as log.*):
 *   projects.js  rev-parse --show-toplevel                 plumbing, prints a path
 *                rev-parse --path-format=absolute --git-common-dir   plumbing
 *   repos.js     rev-parse --path-format=absolute --git-dir --git-common-dir   plumbing, once per worktree
 *                  (the git dirs are then only fs.stat'ed for change detection)
 *                worktree list --porcelain                 reads .git/worktrees, no hooks
 *                for-each-ref refs/heads                   plumbing, ref names/dates/ids only
 *                symbolic-ref --short refs/remotes/origin/HEAD   plumbing, reads a ref
 *                rev-list --left-right --count A...B@{upstream}  plumbing, counts only
 *                config --get-regexp ^filter.*             reads config, executes nothing
 *                config --get remote.origin.url            reads config, executes nothing
 *                log -n 10 --format=%ct%x09%s refs/heads/<default>   subjects and times only, no signature display
 *                status --porcelain --ignore-submodules=all  needed for dirty; fsmonitor,
 *                  hooks, untracked cache off, filter drivers blanked per call, no optional locks
 *   briefs.js    cat-file -e <sha>^{commit}                plumbing, existence only
 *                rev-list --timestamp A..B -- pathspec    plumbing: no signature display
 * Every ref reaching git passed briefs.validBranchName and follows --end-of-options.
 */

const os = require('node:os');
const { execFile } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;

/**
 * @typedef {{ stdout: string }} ExecResult
 * @typedef {(file: string, args: string[], opts: { cwd?: string, maxBuffer?: number }) => Promise<ExecResult>} Exec
 */

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

/**
 * A local drive-letter path only (C:\x or C:/x). Rejects UNC (\\host, //host,
 * \\?\UNC\), device paths (\\.\, \\?\), relative paths and over-long strings.
 * @param {unknown} p @returns {boolean}
 */
function isLocalPath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 1024 && /^[A-Za-z]:[\\/]/.test(p) && !p.includes('\u0000');
}

/** @param {NodeJS.ProcessEnv} [base] */
function safeEnv(base) {
  return Object.assign({}, base || process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
}

/** @type {Exec} */
function gitExec(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, file === 'git' ? SAFE_ARGS.concat(args) : args, {
      cwd: opts && opts.cwd, env: safeEnv(), windowsHide: true, timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8', maxBuffer: (opts && opts.maxBuffer) || 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });
}

module.exports = { gitExec, isLocalPath, SAFE_ARGS, safeEnv, GIT_TIMEOUT_MS };
