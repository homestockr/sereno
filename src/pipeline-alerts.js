// @ts-check
'use strict';
/*
 * Pipeline alerts (phase 4b, step 5). A pure state machine over the task views the
 * repo poller already holds: no I/O, no timers, no Electron. The caller feeds it on
 * every poll and acts on the events it returns. State lives in memory only.
 *
 *   decision-open / decision-reopen   a task's stage is `decision` (fires once per episode)
 *   decision-reviewing                a newer attempt or gate appeared, or the stage moved on
 *   stalled / stalled-clear           a repair attempt is running but nobody is building
 *
 * Expired tasks never alert and never stay open.
 */

const STALL_MS = 10 * 60 * 1000;
const REASON_MAX = 200;

/**
 * @typedef {{ task?: string, stage?: string, attempt?: number | null, reason?: string | null, expired?: boolean,
 *   gate?: { outcome?: string | null, review_run_id?: string | null } | null, gates?: any[],
 *   attempts?: Array<{ attempt?: number | null, outcome?: string | null, started_at?: string | null }> }} TaskIn
 * @typedef {{ id: string, name: string, paths?: string[], tasks?: TaskIn[] }} ProjectIn
 * @typedef {{ type: 'decision-open' | 'decision-reopen' | 'decision-reviewing' | 'stalled' | 'stalled-clear',
 *   key: string, projectId: string, project: string, task: string, attempt: number | null, reason: string | null, kind?: 'repair' | 'build' }} AlertEvent
 * @typedef {{ projectId: string, project: string, task: string, reason: string | null, attempt: number | null, paths: string[] }} OpenDecision
 */

/** @param {unknown} v @param {number} max @returns {string | null} */
function clean(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : null;
}

/** @param {unknown} p */
function norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** @param {string} cwd @param {string[]} roots */
function inside(cwd, roots) {
  const c = norm(cwd);
  if (!c) return false;
  return roots.some((r) => { const n = norm(r); return n !== '' && (c === n || c.startsWith(n + '/')); });
}

/**
 * Registry entries + the poller's snapshot -> machine input. Paths are the repo root and its worktrees.
 * @param {Array<{ id: string, name?: string, repoPath?: string, hidden?: boolean }>} registry
 * @param {Record<string, any>} snap
 * @returns {ProjectIn[]}
 */
function toInput(registry, snap) {
  /** @type {ProjectIn[]} */
  const out = [];
  for (const p of Array.isArray(registry) ? registry : []) {
    if (!p || p.hidden || typeof p.id !== 'string') continue;
    const st = snap && snap[p.id];
    const pv = st && st.pipeline && typeof st.pipeline === 'object' ? st.pipeline : null;
    if (!pv || !Array.isArray(pv.tasks)) continue;
    const paths = [p.repoPath].concat(((st.worktrees) || []).map((/** @type {any} */ w) => w && w.path))
      .filter((x) => typeof x === 'string' && x);
    out.push({ id: p.id, name: String(p.name || (st && st.name) || p.id), paths: /** @type {string[]} */ (paths), tasks: pv.tasks });
  }
  return out;
}

/**
 * @param {{ now?: () => number }} [opts]
 */
function createPipelineAlerts(opts) {
  const now = (opts && opts.now) || Date.now;
  const born = now();
  /** key `projectId/task` -> decision episode. @type {Map<string, { phase: 'open' | 'reviewing', attempt: number, gateRun: string, gateN: number, view: OpenDecision }>} */
  const decisions = new Map();
  /** key `projectId/task/attempt` -> stalled marker. @type {Map<string, { projectId: string, project: string, task: string, attempt: number | null }>} */
  const stalled = new Map();
  /** projectId -> last time a live builder was seen in the repo. @type {Map<string, number>} */
  const lastBuilder = new Map();

  /** @param {TaskIn} t */
  const gateRun = (t) => (t.gate && typeof t.gate.review_run_id === 'string' ? t.gate.review_run_id : '');
  /** @param {TaskIn} t */
  const gateCount = (t) => (Array.isArray(t.gates) ? t.gates.length : 0);
  /** @param {TaskIn} t */
  const attemptOf = (t) => (typeof t.attempt === 'number' && Number.isFinite(t.attempt) ? t.attempt : -1);

  /**
   * @param {ProjectIn[]} projects
   * @param {Array<{ cwd?: string }>} liveBuilders live `sereno:builder*` subagents with their session cwd
   * @returns {AlertEvent[]}
   */
  function update(projects, liveBuilders) {
    const t0 = now();
    /** @type {AlertEvent[]} */
    const events = [];
    const seenD = new Set();
    const seenS = new Set();
    const builders = Array.isArray(liveBuilders) ? liveBuilders : [];

    for (const p of Array.isArray(projects) ? projects : []) {
      if (!p || typeof p.id !== 'string') continue;
      const roots = Array.isArray(p.paths) ? p.paths : [];
      if (!lastBuilder.has(p.id)) lastBuilder.set(p.id, born);
      if (builders.some((b) => b && typeof b.cwd === 'string' && inside(b.cwd, roots))) lastBuilder.set(p.id, t0);
      const idle = t0 - /** @type {number} */ (lastBuilder.get(p.id));

      for (const t of Array.isArray(p.tasks) ? p.tasks : []) {
        if (!t || typeof t.task !== 'string' || t.expired === true) continue;
        const dkey = p.id + '/' + t.task;
        const att = attemptOf(t);
        /** @param {AlertEvent['type']} type @param {string} key @returns {AlertEvent} */
        const ev = (type, key) => ({ type, key, projectId: p.id, project: String(p.name), task: t.task || '', attempt: att < 0 ? null : att, reason: clean(t.reason, REASON_MAX) });

        // --- decision episodes ---
        const cur = decisions.get(dkey);
        if (t.stage === 'decision') {
          seenD.add(dkey);
          const view = { projectId: p.id, project: String(p.name), task: t.task, reason: clean(t.reason, REASON_MAX), attempt: att < 0 ? null : att, paths: roots.slice() };
          const fresh = { phase: /** @type {'open'} */ ('open'), attempt: att, gateRun: gateRun(t), gateN: gateCount(t), view };
          if (!cur) {
            decisions.set(dkey, fresh);
            events.push(ev('decision-open', dkey + '/' + att));
          } else if (cur.phase === 'reviewing') {
            decisions.set(dkey, fresh);
            events.push(ev('decision-reopen', dkey + '/' + att));
          } else if (att > cur.attempt || gateCount(t) > cur.gateN || gateRun(t) !== cur.gateRun) {
            // Both the review and the next decision happened between two polls.
            events.push(ev('decision-reviewing', dkey + '/' + cur.attempt));
            decisions.set(dkey, fresh);
            events.push(ev('decision-reopen', dkey + '/' + att));
          } else {
            cur.view = view;
          }
        } else if (cur) {
          seenD.add(dkey);
          if (cur.phase === 'open' && t.stage !== 'unknown') {
            // A status we cannot read right now keeps the episode; anything else means it moved on.
            cur.phase = 'reviewing';
            events.push(ev('decision-reviewing', dkey + '/' + cur.attempt));
          }
        }

        // --- stalled build or repair ---
        const latest = Array.isArray(t.attempts) && t.attempts.length ? t.attempts[0] : null;
        const startedAt = latest && typeof latest.started_at === 'string' ? Date.parse(latest.started_at) : NaN;
        const kind = t.gate && t.gate.outcome === 'block' ? 'repair' : 'build';
        const isStalled = !!(latest && latest.outcome === 'running'
          && Number.isFinite(startedAt) && t0 - startedAt >= STALL_MS && idle >= STALL_MS);
        const skey = dkey + '/' + att;
        if (isStalled) {
          seenS.add(skey);
          if (!stalled.has(skey)) {
            stalled.set(skey, { projectId: p.id, project: String(p.name), task: t.task, attempt: att < 0 ? null : att, kind });
            events.push(Object.assign(ev('stalled', skey), { kind }));
          }
        }
      }
    }

    // Anything that is no longer true clears; tasks that vanished or expired drop without an event.
    for (const k of Array.from(decisions.keys())) if (!seenD.has(k)) decisions.delete(k);
    for (const [k, v] of Array.from(stalled.entries())) {
      if (seenS.has(k)) continue;
      stalled.delete(k);
      events.push({ type: 'stalled-clear', key: k, projectId: v.projectId, project: v.project, task: v.task, attempt: v.attempt, reason: null });
    }
    // Forget projects that left the input.
    const ids = new Set((Array.isArray(projects) ? projects : []).map((p) => p && p.id));
    for (const id of Array.from(lastBuilder.keys())) if (!ids.has(id)) lastBuilder.delete(id);
    return events;
  }

  /** Current open decisions, for counts and the attention panel. @returns {OpenDecision[]} */
  function open() {
    return Array.from(decisions.values()).filter((d) => d.phase === 'open').map((d) => Object.assign({}, d.view, { paths: d.view.paths.slice() }));
  }

  /** Currently stalled tasks. */
  function stalledNow() { return Array.from(stalled.values()).map((s) => Object.assign({}, s)); }

  return { update, open, stalled: stalledNow };
}

module.exports = { createPipelineAlerts, toInput, inside, STALL_MS };
