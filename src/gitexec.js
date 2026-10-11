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
 */

const os = require('node:os');
const { execFile } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;

/**
 * @typedef {{ stdout: string }} ExecResult
 * @typedef {(file: string, args: string[], opts: { cwd?: string }) => Promise<ExecResult>} Exec
 */

const SAFE_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=' + os.devNull,
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.allow=never',
  '-c', 'credential.helper=',
];

/** @param {NodeJS.ProcessEnv} [base] */
function safeEnv(base) {
  return Object.assign({}, base || process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
}

/** @type {Exec} */
function gitExec(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, file === 'git' ? SAFE_ARGS.concat(args) : args, {
      cwd: opts && opts.cwd, env: safeEnv(), windowsHide: true, timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8', maxBuffer: 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });
}

module.exports = { gitExec, SAFE_ARGS, safeEnv, GIT_TIMEOUT_MS };
