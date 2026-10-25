// @ts-check
'use strict';
/*
 * sereno.js next: what /sereno:next does, as code. Read-only; it writes nothing.
 *
 * Answers { task, step, reason, hold, command }:
 *   step     build | ship | repair | retry | merge | decide | done | pick | idle
 *            (repair: recovery says one repair is due; ship is entered at its repair bullet)
 *   command  the exact slash command the user types next, or null when `next` itself
 *            carries on (build, ship, repair, retry) or there is nothing to type (pick, idle)
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
 * @property {(task: string) => string | null} [recordedHead] the commit the newest success was recorded at
 * @property {() => string[] | null} [cleanFiles] tracked files with uncommitted changes (null: unknown)
 * @property {(task: string) => { pinned: string | null, current: string | null }} [specPin] the spec hash the newest pinned attempt carries, and the spec's hash now
 * @property {(task: string) => boolean} [branchExists] does refs/heads/task/<task> resolve (when absent, assumed yes)
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
  if (reason.startsWith('hook_failed') || reason.startsWith('branch task/') || reason.startsWith('the latest attempt never finished') || reason.startsWith('dirty_tree')) return null; // the options are a person's call, listed in the reason
  if (reason.startsWith('head_moved')) return '/sereno:build ' + task;
  if (reason.startsWith('spec_changed')) return '/sereno:build ' + task; // a new build pins the new spec
  return '/sereno:ship ' + task;
}

/**
 * The decide for a task whose branch is gone while its work is not merged.
 * @param {Deps} d @param {Meta} m
 * @returns {{ step: string, reason: string, hold: string | null, command: string | null }}
 */
function goneDecide(d, m) {
  const task = m.task;
  const h = typeof d.recordedHead === 'function' ? d.recordedHead(task) : null;
  const stop = 'run `sereno.js stop --task ' + task + '` to retire it';
  return { step: 'decide', reason: 'branch task/' + task + ' is gone and ' + (h ? 'its reviewed commit is not in ' + (m.base_branch || 'the base branch') + ': recreate the branch at ' + h.slice(0, 7) + ' and run /sereno:merge ' + task + ', or ' + stop : 'nothing reviewed is on record: ' + stop), hold: null, command: null };
}

/**
 * The preconditions of the skills that build, ship, retry and repair, checked once here so `next`
 * never hands out a step the skill would refuse (which loops to the step cap): (a) the tracked
 * tree is clean, (b) task/<task> exists for ship, retry and repair, (c) a built attempt is shipped
 * only while the spec is the one the build pinned. Any other step passes through unchanged.
 * @param {Deps} d @param {Meta} m @param {{ step: string, reason: string, hold: string | null, command: string | null }} st
 * @returns {{ step: string, reason: string, hold: string | null, command: string | null }}
 */
function guard(d, m, st) {
  if (!['build', 'ship', 'retry', 'repair'].includes(st.step)) return st;
  const task = m.task;
  const files = typeof d.cleanFiles === 'function' ? d.cleanFiles() : null;
  if (files && files.length) {
    return { step: 'decide', reason: 'dirty_tree: ' + files.slice(0, 5).join(', ') + (files.length > 5 ? ' and ' + (files.length - 5) + ' more' : ''), hold: null, command: null };
  }
  if (st.step !== 'build' && typeof d.branchExists === 'function' && !d.branchExists(task)) return goneDecide(d, m);
  if (st.step === 'ship' && typeof d.specPin === 'function') {
    const p = d.specPin(task);
    if (p.pinned && p.pinned !== p.current) {
      const reason = 'spec_changed: the spec changed after the build; a new build pins it';
      return { step: 'decide', reason, hold: null, command: commandForDecide(task, reason) };
    }
  }
  return st;
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
    if (!a.ok) return mk('idle', a.after && d.lastOutcome(a.after) === 'stopped' ? a.after + ' was stopped; run /sereno:task ' + task + ' --after none to unblock' : 'after_not_merged: ' + task + ' waits for ' + a.after + ' to be merged' + (a.base ? ' into ' + a.base : ''), null, null);
    return mk('build', 'the spec exists and nothing has been built yet', null, null);
  }
  if (mergedInto(d, task, m.base_branch)) {
    return mk('done', 'task/' + task + ' is merged into ' + m.base_branch, '/sereno:next', null);
  }
  /** @type {{ next: string, reason: string }} */
  let r;
  try { r = d.recover(task); } catch (_e) { r = { next: 'decide', reason: 'the attempt records for this task could not be read' }; }
  switch (r.next) {
    case 'review': {
      // The branch was deleted and the work is not in the base (for example a squash merge, which
      // leaves no ancestor): nothing can be shipped, a person decides. Covers a built attempt too.
      if (typeof d.branchExists === 'function' && !d.branchExists(task)) return goneDecide(d, m);
      // The branch moved after the review: ship refuses that state, so it is a build (or a person's call), never a ship loop.
      if (r.reason.startsWith('head_moved')) return mk('decide', r.reason, commandForDecide(task, r.reason), null);
      return mk('ship', r.reason, null, null);
    }
    case 'retry': return mk('retry', r.reason, null, null);
    case 'repair': return mk('repair', r.reason, null, null);
    case 'merge': return mk('merge', r.reason, '/sereno:merge ' + task, m.hold_before_merge);
    case 'done': return mk('done', r.reason, '/sereno:next', null);
    default: {
      if (r.reason.startsWith('the latest attempt never finished')) {
        const n = typeof (/** @type {any} */ (r)).attempt === 'number' ? /** @type {any} */ (r).attempt : d.attemptCount(task);
        return mk('decide', 'the latest attempt never finished: close it with `sereno.js attempt --task ' + task + ' --update ' + n + ' --outcome error --diagnosis none --ended-at now`', null, null);
      }
      return mk('decide', r.reason, commandForDecide(task, r.reason), null);
    }
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
    return Object.assign({ task: a.task }, guard(d, m, stateOf(d, m)));
  }
  /** @type {Meta[]} */
  const metas = [];
  for (const t of d.listSpecs()) { const m = d.spec(t); if (m) metas[metas.length] = m; }
  // Oldest first; a spec without a date sorts last; ties break on the name.
  metas.sort((x, y) => (x.created_at || '9').localeCompare(y.created_at || '9') || x.task.localeCompare(y.task));

  const inProgress = metas.filter((m) => d.attemptCount(m.task) > 0 && stateOf(d, m).step !== 'done');
  if (inProgress.length === 1) return Object.assign({ task: inProgress[0].task }, guard(d, inProgress[0], stateOf(d, inProgress[0])));
  if (inProgress.length > 1) {
    const names = inProgress.map((m) => m.task);
    return { task: null, step: 'pick', reason: names.length + ' tasks are in progress: ' + names.join(', ') + '; say which one to run', hold: null, command: null, tasks: names };
  }
  const fresh = metas.filter((m) => d.attemptCount(m.task) === 0);
  const ready = fresh.find((m) => afterState(d, m).ok);
  if (ready) return Object.assign({ task: ready.task }, guard(d, ready, stateOf(d, ready)));
  if (fresh.length) {
    const waiting = fresh.map((m) => m.task + ' (after ' + m.after + (m.after && d.lastOutcome(m.after) === 'stopped' ? ', stopped; run /sereno:task ' + m.task + ' --after none to unblock' : '') + ')');
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
      headMerged: headMergedFor(root, fsafe, task),
    }),
    isMerged: (task, base) => branchMerged(root, fsafe, task, base),
    cleanFiles: () => gitlib.cleanFiles(root),
    specPin: (task) => {
      let pinned = null;
      const ns = nums(task);
      for (let i = ns.length - 1; i >= 0; i--) { const j = readAttempt(task, ns[i]); if (j && typeof j.spec_hash === 'string') { pinned = j.spec_hash; break; } }
      let current = null;
      try { current = rec.sha256(fs.readFileSync(path.join(root, '.sereno', 'specs', task + '.md'))); } catch (_e) { current = null; }
      return { pinned, current };
    },
    recordedHead: (task) => recovery.recordedHead({ root, task, listAttempts: () => fsafe.listDir('.sereno/attempts') }),
    branchExists: (task) => !!gitlib.resolveCommit(root, 'refs/heads/task/' + task),
  };
}

/**
 * Is task/<task> merged into the branch `base`? With the branch present, its tip must be an
 * ancestor of the base. With the branch gone (merged, then deleted), the commit the success was
 * recorded at (the passing gate's head, or a skipped attempt's head) must be an ancestor.
 * @param {string} root @param {{ listDir: (rel: string) => string[] }} fsafe @param {string} task @param {string} base
 */
function branchMerged(root, fsafe, task, base) {
  const baseRef = 'refs/heads/' + base;
  if (gitlib.resolveCommit(root, 'refs/heads/task/' + task)) return gitlib.isAncestor(root, 'refs/heads/task/' + task, baseRef) === true;
  const h = recovery.recordedHead({ root, task, listAttempts: () => fsafe.listDir('.sereno/attempts') });
  return !!h && gitlib.isAncestor(root, h, baseRef) === true;
}

/**
 * recovery's headMerged lookup for a task: is this commit in the task's base branch.
 * @param {string} root @param {{ listDir: (rel: string) => string[] }} fsafe @param {string} task @returns {(head: string) => boolean}
 */
function headMergedFor(root, fsafe, task) {
  return (head) => {
    const m = speclib.readSpecMeta(root, task);
    return !!(m && m.base_branch && gitlib.isRefName(m.base_branch) && gitlib.isAncestor(root, head, 'refs/heads/' + m.base_branch) === true);
  };
}

/**
 * A queued task's branch is cut when its spec is written, so it can sit behind the base after
 * the task it comes `after` is merged. Bring it up to the base tip, but only when that cannot
 * lose anything: the task has no attempts, the branch has no commits of its own (its tip is an
 * ancestor of the base tip, so every commit on it is already in the base), and the tracked tree
 * is clean. Then it fast-forwards (`git merge --ff-only` when it is checked out here,
 * `git branch -f` otherwise). It never touches any branch except task/<task>. Anything else
 * leaves the branch alone and returns a warning.
 * @param {{ root: string, task: string, base: string, attempts: number }} a
 * @returns {{ refreshed: boolean, warning?: string }}
 */
function refreshQueuedBranch(a) {
  const { root, task, base } = a;
  if (!gitlib.isRefName(base)) return { refreshed: false };
  const ref = 'refs/heads/task/' + task;
  const tip = gitlib.resolveCommit(root, ref);
  const baseTip = gitlib.resolveCommit(root, 'refs/heads/' + base);
  if (!tip || !baseTip || tip === baseTip) return { refreshed: false };
  const left = (/** @type {string} */ why) => ({ refreshed: false, warning: 'task/' + task + ' is behind ' + base + ' and was left alone: ' + why });
  if (a.attempts > 0) return left('it already has attempts');
  const own = gitlib.isAncestor(root, tip, baseTip);
  if (own === null) return left('could not compare it with ' + base);
  if (!own) return left('it has commits of its own, so it was not moved; bring it up to date by hand if the task needs the merged work');
  const dirty = gitlib.cleanFiles(root);
  if (dirty === null || dirty.length) return left('the working tree has uncommitted changes');
  const onIt = gitlib.currentBranch(root) === 'task/' + task;
  const r = onIt ? gitlib.git(root, ['merge', '--ff-only', '--end-of-options', baseTip]) : gitlib.git(root, ['branch', '-f', '--end-of-options', 'task/' + task, baseTip]);
  if (r === null || gitlib.resolveCommit(root, ref) !== baseTip) return left('git could not move it');
  return { refreshed: true };
}

// The cap is counted by the model (it passes --steps-done), so it is a backstop, not a hard limit.
const STEP_CAP = 3;

module.exports = { STEP_CAP, decide, realDeps, refreshQueuedBranch, branchMerged, headMergedFor, afterState, baseFor, commandForDecide, stateOf, mergedInto };
