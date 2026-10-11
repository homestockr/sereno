// @ts-check
'use strict';
/*
 * Repo poller: git state per registered project, held in memory.
 *
 * Read-only and local: worktrees, branch names + commit times + hashes,
 * ahead/behind against the existing upstream ref, and a dirty flag. No commit
 * messages, no diffs, no network commands. All git goes through gitexec.js
 * (hardened for untrusted repos). Nothing here throws.
 */

const { gitExec } = require('./gitexec.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 14 * DAY_MS;
const MAX_BRANCHES = 8;

/**
 * @typedef {import('./gitexec.js').Exec} Exec
 * @typedef {{ path: string, branch: string | null, head: string, dirty: boolean | null }} Worktree
 * @typedef {{ name: string, lastCommitAt: number, head: string }} Branch
 * @typedef {{
 *   id: string, name: string, defaultBranch: string | null, ahead: number | null, behind: number | null,
 *   dirty: boolean | null, lastCommitAt: number | null, worktrees: Worktree[], branches: Branch[],
 *   polledAt: number | null, error: boolean
 * }} RepoState
 */

/** @param {string} out */
function parseWorktrees(out) {
  /** @type {{ path: string, branch: string | null, head: string }[]} */
  const list = [];
  /** @type {{ path: string, branch: string | null, head: string } | null} */
  let cur = null;
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, head: '' };
      list.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

/** @param {string} out @returns {Branch[]} */
function parseBranches(out) {
  /** @type {Branch[]} */
  const list = [];
  for (const line of String(out).split(/\r?\n/)) {
    const [name, ts, head] = line.split('\t');
    const t = Number(ts);
    if (name && Number.isFinite(t) && ts !== '') list.push({ name, lastCommitAt: t * 1000, head: head || '' });
  }
  return list;
}

/**
 * Run fn over items, at most `limit` at a time.
 * @template T
 * @param {T[]} items @param {number} limit @param {(x: T) => Promise<void>} fn
 */
async function pool(items, limit, fn) {
  let i = 0;
  const workers = [];
  for (let w = 0; w < Math.max(1, Math.min(limit, items.length)); w++) {
    workers.push((async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })());
  }
  await Promise.all(workers);
}

/**
 * @param {{ registry: { list: () => { id: string, name: string, repoPath: string, hidden: boolean }[] },
 *   exec?: Exec, now?: () => number, intervalMs?: number, concurrency?: number }} opts
 */
function createPoller(opts) {
  const registry = opts.registry;
  const exec = opts.exec || gitExec;
  const now = opts.now || Date.now;
  const intervalMs = opts.intervalMs || 30000;
  const concurrency = opts.concurrency || 2;
  /** @type {Map<string, RepoState>} */
  let state = new Map();
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @param {string[]} args @param {string} cwd */
  const git = async (args, cwd) => (await exec('git', args, { cwd })).stdout;
  /** @param {string[]} args @param {string} cwd */
  const gitOrNull = async (args, cwd) => { try { return await git(args, cwd); } catch (_) { return null; } };

  /**
   * git status runs a path's clean filter on stat-dirty files, and a repo's
   * config can define that filter as a program. Reading config executes
   * nothing, so list the driver names and blank each one for this call.
   * Anything odd: skip the check (null) rather than risk it.
   * @param {string} cwd @returns {Promise<boolean | null>}
   */
  async function dirtyOf(cwd) {
    try {
      let out = '';
      try { out = await git(['config', '--get-regexp', String.raw`^filter\..*\.(clean|smudge|process)$`], cwd); }
      catch (e) { if (!e || e.code !== 1) return null; }   // exit 1 = no such keys
      /** @type {string[]} */
      const flags = [];
      const seen = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = /^filter\.(.+)\.(?:clean|smudge|process)(?:\s|$)/i.exec(line);
        if (!m || !/^[A-Za-z0-9_.-]+$/.test(m[1])) return null;
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        for (const k of ['clean', 'smudge', 'process']) flags.push('-c', 'filter.' + m[1] + '.' + k + '=');
        flags.push('-c', 'filter.' + m[1] + '.required=false');
      }
      const st = await git(flags.concat(['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']), cwd);
      return !!st.trim();
    } catch (_) { return null; }
  }

  /** @param {{ id: string, name: string, repoPath: string }} p @returns {Promise<RepoState>} */
  async function pollOne(p) {
    const cwd = p.repoPath;
    const wts = parseWorktrees(await git(['worktree', 'list', '--porcelain'], cwd));
    const branches = parseBranches(await git(['for-each-ref', 'refs/heads',
      '--format=%(refname:short)%09%(committerdate:unix)%09%(objectname)'], cwd));
    const names = new Set(branches.map((b) => b.name));

    let def = null;
    const sym = await gitOrNull(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (sym && sym.trim()) def = sym.trim().replace(/^origin\//, '');
    if (!def || !names.has(def)) {
      def = names.has('main') ? 'main' : names.has('master') ? 'master' : (wts[0] && wts[0].branch) || null;
    }

    let ahead = null; let behind = null;
    if (def) {
      const ab = await gitOrNull(['rev-list', '--left-right', '--count', def + '...' + def + '@{upstream}'], cwd);
      const m = ab && /^(\d+)\s+(\d+)/.exec(ab.trim());
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    }

    /** @type {Worktree[]} */
    const worktrees = [];
    for (const w of wts) {
      worktrees.push({ path: w.path, branch: w.branch, head: w.head, dirty: await dirtyOf(w.path) });
    }

    const t = now();
    const byRecent = branches.slice().sort((a, b) => b.lastCommitAt - a.lastCommitAt);
    const picked = byRecent.filter((b) => b.name === def || t - b.lastCommitAt <= RECENT_MS);
    const keep = new Set(picked.filter((b) => b.name !== def).slice(0, def && names.has(def) ? MAX_BRANCHES - 1 : MAX_BRANCHES)
      .map((b) => b.name));
    if (def) keep.add(def);
    const shown = byRecent.filter((b) => keep.has(b.name));

    return {
      id: p.id, name: p.name, defaultBranch: def, ahead, behind,
      dirty: worktrees.some((w) => w.dirty === true),
      lastCommitAt: branches.length ? Math.max(...branches.map((b) => b.lastCommitAt)) : null,
      worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, dirty: w.dirty })),
      branches: shown, polledAt: t, error: false,
    };
  }

  async function runPoll() {
    let list = [];
    try { list = registry.list().filter((p) => !p.hidden); } catch (_) { return; }
    const next = new Map();
    const ids = new Set(list.map((p) => p.id));
    for (const [id, s] of state) if (ids.has(id)) next.set(id, s);
    state = next;
    await pool(list, concurrency, async (p) => {
      try {
        state.set(p.id, await pollOne(p));
      } catch (_) {
        const prev = state.get(p.id);
        if (prev) state.set(p.id, Object.assign({}, prev, { name: p.name, error: true }));
        else state.set(p.id, {
          id: p.id, name: p.name, defaultBranch: null, ahead: null, behind: null, dirty: null,
          lastCommitAt: null, worktrees: [], branches: [], polledAt: null, error: true,
        });
      }
    });
  }

  /** Overlapping calls share the in-flight poll; nothing is queued. @returns {Promise<void>} */
  function pollNow() {
    if (running) return running;
    running = runPoll().catch(() => {}).finally(() => { running = null; });
    return running;
  }

  return {
    pollNow,
    start() {
      if (timer) return;
      timer = setInterval(() => { pollNow(); }, intervalMs);
      timer.unref();
      pollNow();
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    snapshot() {
      /** @type {Record<string, RepoState>} */
      const out = {};
      for (const [id, s] of state) out[id] = JSON.parse(JSON.stringify(s));
      return out;
    },
  };
}

module.exports = { createPoller, parseWorktrees, parseBranches, RECENT_MS, MAX_BRANCHES };
