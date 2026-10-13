// @ts-check
'use strict';
/* sereno.js doctor: environment checks. Every check is isolated; none throws. */

const fs = require('node:fs');
const path = require('node:path');
const { SerenoError, createSafeFs } = require('./fsafe.js');
const gitlib = require('./git.js');
const { loadConfig } = require('./config.js');
const { resolveCommand } = require('./testrun.js');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

/** @param {string} cwd @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[], config_hash: string | null }} */
function runDoctor(cwd) {
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  /** @param {string} name @param {() => { ok: boolean, detail: string }} fn */
  const check = (name, fn) => {
    let r;
    try { r = fn(); } catch (e) { r = { ok: false, detail: e instanceof SerenoError ? e.message : 'check failed unexpectedly' }; }
    checks.splice(checks.length, 0, { name, ok: !!r.ok, detail: String(r.detail) });
  };

  const major = parseInt(process.versions.node.split('.')[0], 10);
  check('node', () => ({ ok: major >= 18, detail: 'node ' + process.versions.node + (major >= 18 ? '' : ' (need 18 or newer)') }));

  check('git', () => {
    const v = gitlib.git(cwd, ['--version']);
    return v ? { ok: true, detail: v } : { ok: false, detail: 'git not found on PATH' };
  });

  /** @type {string | null} */
  let root = null;
  check('git repo', () => {
    const top = gitlib.toplevel(cwd);
    if (!top) return { ok: false, detail: 'not inside a git repository' };
    root = fs.realpathSync.native(path.resolve(top));
    return { ok: true, detail: root.replace(/\\/g, '/') };
  });

  /** @type {any} */
  let loaded = null;
  check('pipeline.json', () => {
    try {
      loaded = loadConfig(root);
      return { ok: true, detail: (loaded.source === 'builtin' ? 'defaults' : loaded.source.replace(/\\/g, '/')) + ', config_hash ' + loaded.config_hash };
    } catch (e) {
      if (e instanceof SerenoError) {
        const errs = Array.isArray(e.extra.errors) ? ': ' + e.extra.errors.join('; ') : '';
        return { ok: false, detail: e.message + errs };
      }
      throw e;
    }
  });

  check('test command', () => {
    if (!loaded) return { ok: false, detail: 'needs a valid pipeline.json' };
    const cfgCmd = loaded.config.tests && loaded.config.tests.command;
    const cmd = resolveCommand(loaded.config, root || '');
    if (!cmd) return { ok: false, detail: 'none: set tests.command in .sereno/pipeline.json or a real scripts.test in package.json' };
    return { ok: true, detail: typeof cfgCmd === 'string' && cfgCmd.trim() ? 'tests.command: ' + cmd : 'package.json scripts.test: ' + cmd };
  });

  check('.sereno writable', () => {
    if (!root) return { ok: false, detail: 'needs a git repository' };
    const file = createSafeFs(root).writeFile('.sereno/cache/doctor-probe-' + process.pid + '.tmp', 'probe');
    fs.unlinkSync(file);
    return { ok: true, detail: '.sereno/ accepts writes' };
  });

  check('red-team agents', () => {
    if (!loaded) return { ok: false, detail: 'needs a valid pipeline.json' };
    const r = loaded.config.roles.redTeam;
    const names = [r.agent].concat(r.fallback ? [r.fallback] : []);
    const missing = names.filter((/** @type {string} */ n) => !/^[a-z][a-z0-9-]*$/.test(n) || !fs.existsSync(path.join(AGENTS_DIR, n + '.md')));
    return missing.length ? { ok: false, detail: 'missing under plugin/agents/: ' + missing.join(', ') } : { ok: true, detail: names.join(', ') };
  });

  return { ok: checks.every((c) => c.ok), checks, config_hash: loaded ? loaded.config_hash : null };
}

module.exports = { runDoctor };
