// @ts-check
'use strict';
/*
 * sereno.js recovery: the decision rules from the plan, as code.
 *
 * Reads a task's attempt records (and the gate each one points at) plus the
 * config, and says what /sereno:ship does next. It reads only; it writes nothing.
 *
 * Attempt vocabulary the skill uses:
 *   running         Builder started, not finished
 *   built           Builder committed; waiting for tests and review
 *   block           defect or blocking verdict; diagnosis says which
 *                   (defect = repairable; spec / unknown = needs a decision)
 *   error           environment failure (diagnosis environment), a hook refusal
 *                   (diagnosis hook_failed, always a decision) or any other
 *                   failure, including a budget or turn-cap stop (diagnosis none)
 *   needs_context   review could not finish, or the baseline said nothing
 *   pass / skipped  tests passed and the gate passed / was switched off
 *   stopped         the user ended the task
 */

const fs = require('node:fs');
const path = require('node:path');
const { SerenoError } = require('./fsafe.js');

const DEFECT_KINDS = ['defect', 'bug', 'security', 'privacy', 'test', 'regression', 'correctness', 'spec', 'spec-violation'];

/** @param {string} root @param {string} rel @returns {any | null} */
function readJson(root, rel) {
  try {
    const file = path.join(root, rel);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) { return null; }
}

/** @param {any} gate */
function gateHasDefect(gate) {
  const fs_ = gate && Array.isArray(gate.findings) ? gate.findings : [];
  return fs_.some((f) => f && DEFECT_KINDS.includes(String(f.kind).toLowerCase()) && f.severity !== 'low');
}

/**
 * @param {{ root: string, task: string, config: any, listAttempts: () => string[], currentHead?: () => string | null, currentSpecHash?: () => string | null }} a
 */
function decide(a) {
  const escaped = a.task.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = new RegExp('^' + escaped + '-(\\d+)\\.json$');
  /** @type {{ n: number, rec: any, gate: any | null }[]} */
  const attempts = [];
  for (const f of a.listAttempts()) {
    const m = re.exec(f);
    if (!m) continue;
    const r = readJson(a.root, '.sereno/attempts/' + f);
    if (!r || typeof r !== 'object') continue;
    const id = typeof r.review_run_id === 'string' && /^rr_\d{8}T\d{6}Z_[0-9a-f]{7}$/.test(r.review_run_id) ? r.review_run_id : null;
    attempts.splice(attempts.length, 0, { n: parseInt(m[1], 10), rec: r, gate: id ? readJson(a.root, '.sereno/gates/' + id + '.json') : null });
  }
  attempts.sort((x, y) => x.n - y.n);
  if (!attempts.length) throw new SerenoError('not_found', 'no attempts recorded for task ' + a.task);

  const rc = a.config.recovery;
  const red = a.config.roles.redTeam;
  /** An attempt that needs a repair rather than a decision. */
  const isDefect = (/** @type {{ rec: any, gate: any }} */ x) =>
    x.rec.outcome === 'block' && (x.gate ? gateHasDefect(x.gate) : x.rec.diagnosis === 'defect');
  const isEnv = (/** @type {{ rec: any }} */ x) => x.rec.outcome === 'error' && x.rec.diagnosis === 'environment';

  const last = attempts[attempts.length - 1];
  const before = attempts.slice(0, -1);
  const repairsUsed = before.filter(isDefect).length;
  const infraRetriesUsed = before.filter(isEnv).length;
  let consecutiveBlocks = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].rec.outcome === 'block' && attempts[i].rec.review_run_id) consecutiveBlocks++; else break;
  }

  /** @param {string} next @param {string} reason */
  const out = (next, reason) => ({ next, reason, attempt: last.n, repairsUsed, infraRetriesUsed, gate_enabled: !!red.enabled });
  const o = last.rec.outcome;

  /**
   * Before any `merge`: the reviewed commit must still be the branch tip, and the spec
   * must be the one that was reviewed. Skipped only when the caller gives no lookups.
   * @param {string | null | undefined} gateHead the commit the record reviewed, if any record carries it
   * @param {unknown} specHash the spec hash the record pinned, if any
   */
  const mergeGuard = (gateHead, specHash) => {
    if (typeof a.currentHead === 'function' && gateHead !== undefined) {
      const tip = a.currentHead();
      if (!tip || gateHead !== tip) return out('review', 'head_moved: the branch tip is not the commit the gate reviewed');
    }
    if (typeof a.currentSpecHash === 'function' && specHash !== undefined) {
      const now = a.currentSpecHash();
      if (!now || specHash !== now) return out('decide', 'spec_changed: the spec is not the one that was reviewed');
    }
    return null;
  };

  if (o === 'built') return out('review', 'the latest attempt is built and not yet reviewed');
  if (o === 'running') return out('decide', 'the latest attempt never finished');
  if (o === 'stopped') return out('done', 'the task was stopped');
  if (o === 'needs_context') return out('decide', 'the review needs context, or the test baseline is unusable');
  if (o === 'skipped') {
    if (red.enabled) return out('decide', 'attempt is marked skipped but the red team is enabled');
    // With the gate off, the skipped attempt itself carries the head it was tested at (sereno.js attempt --update --head).
    const sh = last.rec.head_commit;
    if (typeof sh !== 'string' || !/^[0-9a-f]{40}$/.test(sh)) return out('decide', 'head_unknown: the skipped attempt does not record which commit was tested');
    let pin;
    for (let i = attempts.length - 1; i >= 0; i--) if (typeof attempts[i].rec.spec_hash === 'string') { pin = attempts[i].rec.spec_hash; break; }
    return mergeGuard(sh, pin) || { ...out('merge', 'tests passed and the gate is switched off in the config'), head_commit: sh };
  }
  if (o === 'pass') {
    const g = last.gate;
    if (g && g.outcome === 'pass' && g.tests_passed === true) {
      if (g.task_id !== a.task || g.branch !== 'task/' + a.task) return out('decide', 'the gate record belongs to another task or branch');
      const guard = mergeGuard(String(g.head_commit), String(g.spec_hash));
      if (guard) return guard;
      /** @type {any} */ const m = out('merge', 'tests passed and the gate passed');
      m.head_commit = g.head_commit;
      if (typeof g.base_commit === 'string') m.base_commit = g.base_commit;
      return m;
    }
    return out('decide', 'attempt says pass but the gate record is missing or does not confirm it');
  }
  if (o === 'error') {
    if (last.rec.diagnosis === 'hook_failed') return out('decide', "hook_failed: the repo's commit hook refused the Builder's commit; fix the hook on its own branch, or approve a commit that skips it and record it with sereno.js attempt --adopt");
    if (last.rec.diagnosis !== 'environment') return out('decide', 'the attempt failed for a reason that is not the environment');
    return infraRetriesUsed < rc.infraRetries
      ? out('retry', 'environment failure; the repair is not used')
      : out('decide', 'environment failure and the infrastructure retries are used up');
  }
  if (o === 'block') {
    if (!isDefect(last)) return out('decide', 'blocked for a reason that is not a known defect kind');
    if (red.enabled && last.rec.review_run_id && consecutiveBlocks >= red.maxBlockedRuns) return out('decide', 'the red team blocked ' + consecutiveBlocks + ' times in a row');
    return repairsUsed < rc.repairs
      ? out('repair', 'first defect; one repair by the same Builder')
      : out('decide', 'a second defect: the repair did not fix it');
  }
  return out('decide', 'the latest attempt has an unknown outcome');
}

module.exports = { decide, DEFECT_KINDS, gateHasDefect };
