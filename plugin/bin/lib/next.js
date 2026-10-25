// @ts-check
'use strict';
/*
 * sereno.js next: what /sereno:next does, as code. Read-only; it writes nothing.
 *
 * Answers { task, step, reason, hold, command }:
 *   step     build | ship | retry | merge | decide | done | pick | idle
 *   command  the exact slash command the user types next, or null when `next` itself
 *            carries on (build, ship, retry) or there is nothing to type (pick, idle)
 *   hold     the spec's hold_before_merge text, only on a `merge` stop
 * `pick` also carries `tasks`: the tasks in progress, oldest first.
 *
 * It wraps recovery.decide and adds the states recovery cannot see: a task with no
 * attempts, a task already merged into its base, and the queue pick (a spec's `after`).
 * Every lookup is injected (see realDeps), so the table is testable without a repo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SerenoError } = require('./fsafe.js');
const gitlib = require('./git.js');
const rec = require('./records.js');
const speclib = require('./spec.js');
const recovery = require('./recovery.js');

/**
 * @typedef {{ task: string, base_branch: string | null, after: string | null, hold_before_merge: string | null, created_at: string | null }} Meta
 * @typedef {object} Deps
 * @property {() => string[]} listSpecs task names that have a spec file
 * @property {(task: string) => Meta | null} spec
 * @property {(task: string) => number} attemptCount
 * @property {(task: string) => string | null} lastOutcome outcome of the newest attempt, or null
 * @property {(task: string) => { next: string, reason: string }} recover recovery.decide for the task
 * @property {(task: string, base: string) => boolean} isMerged is task/<task> an ancestor of <base>
 */

/**
 * Is `task` merged into the branch `base`? Needs a recorded success (newest attempt `pass` or
 * `skipped`) and the branch tip to be an ancestor of the base. false when the base is unknown
 * or either ref is missing: an unknown state is never reported as merged.
 * @param {Deps} d @param {string} task @param {string | null} base
 */
function mergedInto(d, task, base) {
  if (!base) return false;
  // A branch cut from the base with no commits of its own is an ancestor of the base from the
  // start, so "ancestor" alone proves nothing: a recorded success must come with it.
  const last = d.lastOutcome(task);
  return (last === 'pass' || last === 'skipped') && d.isMerged(task, base);
}

/**
 * The base a queued task's `after` is checked against: the task's own base_branch, else the
 * `after` task's. null when neither is known.
 * @param {Deps} d @param {Meta} m @returns {string | null}
 */
function baseFor(d, m) {
  if (m.base_branch) return m.base_branch;
  const a = m.after ? d.spec(m.after) : null;
  return a && a.base_branch ? a.base_branch : null;
}

/**
 * Is the task's `after` satisfied? true when it has none or it is merged into the base.
 * @param {Deps} d @param {Meta} m @returns {{ ok: boolean, after: string | null, base: string | null }}
 */
function afterState(d, m) {
  if (!m.after) return { ok: true, after: null, base: null };
  const base = baseFor(d, m);
  return { ok: mergedInto(d, m.after, base), after: m.after, base };
}

/** The slash command that `merge` already suggests for a `decide` reason. @param {string} task @param {string} reason @returns {string | null} */
function commandForDecide(task, reason) {
  if (reason.startsWith('hook_failed')) return null; // the options are a person's call, listed in the reason
  if (reason.startsWith('head_moved')) return '/sereno:build ' + task;
  if (reason.startsWith('spec_changed')) return '/sereno:task ' + task;
  return '/sereno:ship ' + task;
}

/**
 * State of one task that has a spec.
 * @param {Deps} d @param {Meta} m
 * @returns {{ step: string, reason: string, hold: string | null, command: string | null }}
 */
function stateOf(d, m) {
  const task = m.task;
  const mk = (/** @type {string} */ step, /** @type {string} */ reason, /** @type {string | null} */ command, /** @type {string | null} */ hold) => ({ step, reason, hold: hold || null, command });
  if (d.attemptCount(task) === 0) {
    const a = afterState(d, m);
    if (!a.ok) return mk('idle', 'after_not_merged: ' + task + ' waits for ' + a.after + ' to be merged' + (a.base ? ' into ' + a.base : ''), null, null);
    return mk('build', 'the spec exists and nothing has been built yet', null, null);
  }
  if (mergedInto(d, task, m.base_branch)) {
    return mk('done', 'task/' + task + ' is merged into ' + m.base_branch, '/sereno:next', null);
  }
  /** @type {{ next: string, reason: string }} */
  let r;
  try { r = d.recover(task); } catch (_e) { r = { next: 'decide', reason: 'the attempt records for this task could not be read' }; }
  switch (r.next) {
    case 'review': return mk('ship', r.reason, null, null);
    case 'retry': return mk('retry', r.reason, null, null);
    case 'repair': return mk('ship', r.reason, null, null);
    case 'merge': return mk('merge', r.reason, '/sereno:merge ' + task, m.hold_before_merge);
    case 'done': return mk('done', r.reason, '/sereno:next', null);
    default: return mk('decide', r.reason, commandForDecide(task, r.reason), null);
  }
}

/**
 * @param {{ task?: string | null, deps: Deps }} a
 * @returns {{ task: string | null, step: string, reason: string, hold: string | null, command: string | null, tasks?: string[] }}
 */
function decide(a) {
  const d = a.deps;
  if (a.task) {
    const m = d.spec(a.task);
    if (!m) throw new SerenoError('not_found', 'no spec for task ' + a.task + '; run /sereno:task first');
    return Object.assign({ task: a.task }, stateOf(d, m));
  }
  /** @type {Meta[]} */
  const metas = [];
  for (const t of d.listSpecs()) { const m = d.spec(t); if (m) metas[metas.length] = m; }
  // Oldest first; a spec without a date sorts last; ties break on the name.
  metas.sort((x, y) => (x.created_at || '9').localeCompare(y.created_at || '9') || x.task.localeCompare(y.task));

  const inProgress = metas.filter((m) => d.attemptCount(m.task) > 0 && stateOf(d, m).step !== 'done');
  if (inProgress.length === 1) return Object.assign({ task: inProgress[0].task }, stateOf(d, inProgress[0]));
  if (inProgress.length > 1) {
    const names = inProgress.map((m) => m.task);
    return { task: null, step: 'pick', reason: names.length + ' tasks are in progress: ' + names.join(', ') + '; say which one to run', hold: null, command: null, tasks: names };
  }
  const fresh = metas.filter((m) => d.attemptCount(m.task) === 0);
  const ready = fresh.find((m) => afterState(d, m).ok);
  if (ready) return Object.assign({ task: ready.task }, stateOf(d, ready));
  if (fresh.length) {
    const waiting = fresh.map((m) => m.task + ' (after ' + m.after + ')');
    return { task: null, step: 'idle', reason: 'nothing ready: ' + waiting.join(', ') + ' wait for an earlier task to be merged', hold: null, command: null };
  }
  return { task: null, step: 'idle', reason: 'Nothing queued.', hold: null, command: null };
}

/**
 * The real lookups for a repo.
 * @param {{ root: string, fsafe: { listDir: (rel: string) => string[] }, config: any }} a
 * @returns {Deps}
 */
function realDeps(a) {
  const { root, fsafe, config } = a;
  /** @param {string} task @returns {number[]} */
  const nums = (task) => {
    const re = new RegExp('^' + task.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '-(\\d+)\\.json$');
    const out = [];
    for (const f of fsafe.listDir('.sereno/attempts')) { const m = re.exec(f); if (m) out[out.length] = parseInt(m[1], 10); }
    return out.sort((x, y) => x - y);
  };
  /** @param {string} task @param {number} n @returns {any} */
  const readAttempt = (task, n) => {
    try {
      const file = path.join(root, '.sereno', 'attempts', task + '-' + n + '.json');
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > 1024 * 1024) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) { return null; }
  };
  return {
    listSpecs: () => {
      const out = [];
      for (const f of fsafe.listDir('.sereno/specs')) {
        const m = /^(.+)\.md$/.exec(f);
        if (!m) continue;
        try { out[out.length] = rec.checkTask(m[1]); } catch (_e) { /* not a task name */ }
      }
      return out;
    },
    spec: (task) => speclib.readSpecMeta(root, task),
    attemptCount: (task) => nums(task).length,
    lastOutcome: (task) => {
      const n = nums(task);
      const r = n.length ? readAttempt(task, n[n.length - 1]) : null;
      return r && typeof r.outcome === 'string' ? r.outcome : null;
    },
    recover: (task) => recovery.decide({
      root, task, config,
      listAttempts: () => fsafe.listDir('.sereno/attempts'),
      currentHead: () => gitlib.resolveCommit(root, 'refs/heads/task/' + task),
      currentSpecHash: () => {
        try { return rec.sha256(fs.readFileSync(path.join(root, '.sereno', 'specs', task + '.md'))); } catch (_e) { return null; }
      },
    }),
    isMerged: (task, base) => gitlib.isAncestor(root, 'refs/heads/task/' + task, 'refs/heads/' + base) === true,
  };
}

module.exports = { decide, realDeps, afterState, baseFor, commandForDecide };
