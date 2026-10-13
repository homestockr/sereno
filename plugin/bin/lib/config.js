// @ts-check
'use strict';
/* pipeline.json: load, preset expansion, validation, config_hash. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SerenoError } = require('./fsafe.js');

const AGENTS = ['builder', 'builder-haiku', 'builder-opus', 'scribe', 'red-team', 'red-team-lean'];
const ON_FALLBACK = ['ask', 'auto', 'never'];
const MAX_CONFIG_BYTES = 64 * 1024;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function defaultPreset() {
  return {
    preset: 'default',
    roles: {
      builder: {
        default: 'sonnet',
        options: {
          haiku: { agent: 'builder-haiku', model: 'claude-haiku-4-5-20251001', maxTurns: 40 },
          sonnet: { agent: 'builder', model: 'claude-sonnet-5-5', maxTurns: 80 },
          opus: { agent: 'builder-opus', model: 'claude-opus-5-5', maxTurns: 120 },
        },
      },
      scribe: { agent: 'scribe' },
      redTeam: { agent: 'red-team', fallback: /** @type {string | null} */ ('red-team-lean'), onFallback: 'ask', maxBlockedRuns: 2, enabled: true },
    },
    recovery: { repairs: 1, infraRetries: 2, taskBudgetUsd: null },
    tests: { command: null },
  };
}

/** @type {Record<string, () => any>} */
const PRESETS = {
  default: defaultPreset,
  lean() {
    const c = defaultPreset();
    c.preset = 'lean';
    c.roles.redTeam.agent = 'red-team-lean';
    c.roles.redTeam.fallback = null;
    return c;
  },
};

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function stripBad(/** @type {any} */ v) {
  if (Array.isArray(v)) return v.map(stripBad);
  if (!isObj(v)) return v;
  /** @type {Record<string, any>} */
  const o = {};
  for (const k of Object.keys(v)) if (!BAD_KEYS.has(k)) o[k] = stripBad(v[k]);
  return o;
}

/** Objects merge key by key; everything else (arrays, null, scalars) replaces. Prototype keys are dropped. */
function deepMerge(/** @type {any} */ base, /** @type {any} */ over) {
  if (!isObj(base) || !isObj(over)) return stripBad(over);
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) {
    if (BAD_KEYS.has(k)) continue;
    out[k] = isObj(out[k]) && isObj(over[k]) ? deepMerge(out[k], over[k]) : stripBad(over[k]);
  }
  return out;
}

const posInt = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isInteger(n) && n > 0;
const nonNegInt = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** @param {any} c effective config @returns {string[]} */
function validate(c) {
  /** @type {string[]} */
  const errs = [];
  const bad = (/** @type {string} */ m) => { errs.splice(errs.length, 0, m); };
  const agent = (/** @type {string} */ p, /** @type {unknown} */ v, /** @type {boolean} */ nullable) => {
    if (nullable && v === null) return;
    if (typeof v !== 'string' || !AGENTS.includes(v)) bad(p + ': must be one of ' + AGENTS.join(', '));
  };
  if (typeof c.preset !== 'string' || !PRESETS[c.preset]) bad('preset: must be one of ' + Object.keys(PRESETS).join(', '));
  if (!isObj(c.roles)) { bad('roles: must be an object'); return errs; }
  const b = c.roles.builder;
  if (!isObj(b)) bad('roles.builder: must be an object');
  else if (!isObj(b.options)) bad('roles.builder.options: must be an object');
  else {
    for (const k of Object.keys(b.options)) {
      const o = b.options[k];
      const p = 'roles.builder.options.' + k;
      if (!isObj(o)) { bad(p + ': must be an object'); continue; }
      agent(p + '.agent', o.agent, false);
      if (typeof o.model !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(o.model)) bad(p + '.model: must be a model id string');
      if (!posInt(o.maxTurns)) bad(p + '.maxTurns: must be a positive integer');
    }
    if (typeof b.default !== 'string' || !Object.prototype.hasOwnProperty.call(b.options, b.default)) bad('roles.builder.default: must name an entry in roles.builder.options');
  }
  if (!isObj(c.roles.scribe)) bad('roles.scribe: must be an object'); else agent('roles.scribe.agent', c.roles.scribe.agent, false);
  const r = c.roles.redTeam;
  if (!isObj(r)) bad('roles.redTeam: must be an object');
  else {
    agent('roles.redTeam.agent', r.agent, false);
    agent('roles.redTeam.fallback', r.fallback, true);
    if (!ON_FALLBACK.includes(r.onFallback)) bad('roles.redTeam.onFallback: must be ask, auto or never');
    if (!posInt(r.maxBlockedRuns)) bad('roles.redTeam.maxBlockedRuns: must be a positive integer');
    if (typeof r.enabled !== 'boolean') bad('roles.redTeam.enabled: must be true or false');
  }
  const rec = c.recovery;
  if (!isObj(rec)) bad('recovery: must be an object');
  else {
    // 0 is allowed for these two: it switches the repair or the retries off.
    if (!nonNegInt(rec.repairs)) bad('recovery.repairs: must be a non-negative integer');
    if (!nonNegInt(rec.infraRetries)) bad('recovery.infraRetries: must be a non-negative integer');
    if (rec.taskBudgetUsd !== null && !(typeof rec.taskBudgetUsd === 'number' && rec.taskBudgetUsd > 0 && isFinite(rec.taskBudgetUsd))) bad('recovery.taskBudgetUsd: must be null or a positive number');
  }
  if (!isObj(c.tests)) bad('tests: must be an object');
  else if (c.tests.command !== null && !(typeof c.tests.command === 'string' && c.tests.command.trim() && c.tests.command.length <= 1000)) bad('tests.command: must be null or a non-empty string');
  if (isObj(c.tests)) {
    if (c.tests.parallel !== undefined && typeof c.tests.parallel !== 'boolean') bad('tests.parallel: must be true or false');
    if (c.tests.setup !== undefined && c.tests.setup !== null && !(typeof c.tests.setup === 'string' && c.tests.setup.trim() && c.tests.setup.length <= 1000)) bad('tests.setup: must be null or a non-empty string');
    if (c.tests.timeoutSec !== undefined && !posInt(c.tests.timeoutSec)) bad('tests.timeoutSec: must be a positive integer');
  }
  return errs;
}

/** @param {unknown} v @returns {any} */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (!isObj(v)) return v;
  /** @type {Record<string, any>} */
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
  return o;
}

/** @param {unknown} cfg @returns {string} sha256:<hex> of the canonical JSON */
function configHash(cfg) {
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(canonical(cfg))).digest('hex');
}

/** @param {string} file @returns {any | null} null when absent */
function readConfigFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (_e) { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_CONFIG_BYTES) throw new SerenoError('config_invalid', 'pipeline.json is too large', { errors: [file + ': larger than ' + MAX_CONFIG_BYTES + ' bytes'] });
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new SerenoError('config_invalid', 'pipeline.json is not valid JSON', { errors: [file + ': ' + (e instanceof Error ? e.message : 'parse error')] }); }
  if (!isObj(parsed)) throw new SerenoError('config_invalid', 'pipeline.json must be an object', { errors: [file + ': must be a JSON object'] });
  return parsed;
}

/**
 * @param {string | null} repoRoot
 * @returns {{ config: any, config_hash: string, source: string }}
 */
function loadConfig(repoRoot) {
  const candidates = [];
  if (repoRoot) candidates.splice(candidates.length, 0, path.join(repoRoot, '.sereno', 'pipeline.json'));
  candidates.splice(candidates.length, 0, path.join(os.homedir(), '.sereno', 'pipeline.json'));
  let user = null, source = 'builtin';
  for (const f of candidates) {
    user = readConfigFile(f);
    if (user) { source = f; break; }
  }
  const presetName = user && user.preset !== undefined ? user.preset : 'default';
  if (typeof presetName !== 'string' || !PRESETS[presetName]) {
    throw new SerenoError('config_invalid', 'invalid pipeline.json', { errors: ['preset: must be one of ' + Object.keys(PRESETS).join(', ')], source });
  }
  const effective = deepMerge(PRESETS[presetName](), user || {});
  const errors = validate(effective);
  if (errors.length) throw new SerenoError('config_invalid', 'invalid pipeline.json', { errors, source });
  return { config: effective, config_hash: configHash(effective), source };
}

module.exports = { loadConfig, validate, configHash, canonical, PRESETS, AGENTS };
