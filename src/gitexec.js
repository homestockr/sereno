// @ts-check
'use strict';
/*
 * The one place Sereno runs git. Repos may be untrusted: a cloned .git/config
 * can make git run programs. Claude Code itself runs git in these same repos,
 * so this narrows our own exposure; it makes no stronger claim.
 *
 * What is neutralised here: core.fsmonitor, core.hooksPath (pointed at the null
 * device), core.untrackedCache, protocol.allow=never, credential.helper, all
 * prompting (GIT_TERMINAL_PROMPT=0) and optional locks (GIT_OPTIONAL_LOCKS=0,
 * so status never writes the index). No network command is ever run.
 * Submodules carry their own config, so status is run with
 * --ignore-submodules=all and never descends into them.
 * Content filters (filter.<name>.clean/smudge/process) are driver-named, so
 * they are blanked per call by the caller that runs status (see repos.js).
 * Signature programs are blanked too (log.showSignature=false, gpg.program,
 * gpg.ssh.program, gpg.x509.program): a repo config must not make a commit
 * display run a program.
 *
 * Only local drive-letter paths are ever used as a git cwd or read for briefs
 * (isLocalPath). A UNC path would open SMB connections (NTLM exposure) and block.
 * Projects on network drives or inside WSL are therefore not tracked.
 *
 * Every git command Sereno runs, and why it is safe (read-only; plumbing where
 * possible, because plumbing ignores porcelain config such as log.*):
 *   projects.js  rev-parse --show-toplevel                 plumbing, prints a path
 *                rev-parse --path-format=absolute --git-common-dir   plumbing
 *   repos.js     worktree list --porcelain                 reads .git/worktrees, no hooks
 *                for-each-ref refs/heads                   plumbing, ref names/dates/ids only
 *                symbolic-ref --short refs/remotes/origin/HEAD   plumbing, reads a ref
 *                rev-list --left-right --count A...B@{upstream}  plumbing, counts only
 *                config --get-regexp ^filter.*             reads config, executes nothing
 *                config --get remote.origin.url            reads config, executes nothing
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
  return Object.assign({}, base || process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
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
