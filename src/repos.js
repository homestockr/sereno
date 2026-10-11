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

const os = require('node:os');
const { execFile } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const nodeFs = require('node:fs');
const { gitExec, isLocalPath } = require('./gitexec.js');
const briefsLib = require('./briefs.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 14 * DAY_MS;
const MAX_BRANCHES = 8;
const GH_INTERVAL_MS = 5 * 60 * 1000;
const GH_TIMEOUT_MS = 10000;
const GH_ARGS = ['pr', 'list', '--state', 'open', '--json', 'number', '--limit', '100'];
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * owner/name from a github.com remote URL (https, scp-style ssh, ssh://). Credentials
 * in the URL are dropped. Anything else, or a hostile-looking name, is null.
 * @param {unknown} url @returns {{ owner: string, name: string } | null}
 */
function parseGithubRemote(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  const m = /^https:\/\/(?:[^@\/\s]+@)?github\.com\/([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/i.exec(u)
    || /^(?:ssh:\/\/)?git@github\.com[:\/]([^\/\s]+)\/([^\/\s]+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  for (const x of [m[1], m[2]]) if (!NAME_RE.test(x) || x.startsWith('-')) return null;
  return { owner: m[1], name: m[2] };
}

/**
 * Runs `gh` in a repo. Never prompts, never checks for updates.
 * @param {string[]} args @param {{ cwd?: string }} o @returns {Promise<{ stdout: string }>}
 */
function ghExecDefault(args, o) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      cwd: o && o.cwd, windowsHide: true, timeout: GH_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: Object.assign({}, process.env, { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }),
    }, (err, stdout) => (err ? reject(err) : resolve({ stdout: String(stdout) })));
  });
}

/**
 * @typedef {import('./gitexec.js').Exec} Exec
 * @typedef {{ path: string, branch: string | null, head: string, dirty: boolean | null }} Worktree
 * @typedef {{ name: string, lastCommitAt: number, head: string, brief?: any, freshness?: string, behindSince?: number | null }} Branch
 * @typedef {{
 *   id: string, name: string, defaultBranch: string | null, ahead: number | null, behind: number | null,
 *   dirty: boolean | null, lastCommitAt: number | null, worktrees: Worktree[], branches: Branch[],
 *   polledAt: number | null, error: boolean, brief: any, freshness: string, behindSince?: number | null, briefsMalformed: number,
 *   prs?: number | null
 * }} RepoState
 */

/** @param {string} out */
function parseWorktrees(out) {
  /** @type {{ path: string, branch: string | null, head: string, prunable?: boolean }[]} */
  const list = [];
  /** @type {{ path: string, branch: string | null, head: string, prunable?: boolean } | null} */
  let cur = null;
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, head: '' };
      list.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && /^prunable(\s|$)/.test(line)) cur.prunable = true;
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

/** @param {string} out @returns {Branch[]} */
function parseBranches(out) {
  /** @type {Branch[]} */
  const list = [];
  for (const line of String(out).split(/\r?\n/)) {
    const [full, ts, head] = line.split('\t');
    // %(refname) is the full ref; %(refname:short) becomes heads/<name> when a tag shares the name.
    const name = full && full.startsWith('refs/heads/') ? full.slice(11) : full;
    const t = Number(ts);
    if (name && Number.isFinite(t) && ts !== '') list.push({ name, lastCommitAt: t * 1000, head: head || '' });
  }
  return list;
}

const BACKOFF_START_MS = 5 * 60 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

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
 *   exec?: Exec, now?: () => number, intervalMs?: number, concurrency?: number,
 *   fsp?: typeof nodeFs.promises,
 *   ghExec?: (args: string[], o: { cwd?: string }) => Promise<{ stdout: string }>, ghIntervalMs?: number }} opts
 */
function createPoller(opts) {
  const registry = opts.registry;
  const rawExec = opts.exec || gitExec;
  /** Per-project poll context: a git call killed by the timeout marks it. @type {AsyncLocalStorage<{ killed: boolean }>} */
  const pollCtx = new AsyncLocalStorage();
  /** @type {Exec} */
  const exec = async (file, args, o) => {
    try { return await rawExec(file, args, o); } catch (e) {
      const c = pollCtx.getStore();
      if (c && e && (e.killed || e.signal)) c.killed = true;
      throw e;
    }
  };
  /** Timeout backoff per project: skip until `until`; the next wait doubles, up to an hour. @type {Map<string, { until: number, wait: number }>} */
  const backoff = new Map();
  const fsp = opts.fsp || nodeFs.promises;
  const now = opts.now || Date.now;
  const intervalMs = opts.intervalMs || 30000;
  const concurrency = opts.concurrency || 2;
  const ghExec = opts.ghExec || ghExecDefault;
  const ghIntervalMs = opts.ghIntervalMs || GH_INTERVAL_MS;
  /** Open PR count per project (null = unknown / signed out / not a GitHub repo). @type {Map<string, number | null>} */
  const prs = new Map();
  /** When each project's gh was last tried. @type {Map<string, number>} */
  const ghAt = new Map();
  let ghOff = false;   // gh is not installed: off for the rest of the run
  /** @type {Promise<void> | null} */
  let ghRunning = null;
  /** @type {NodeJS.Timeout | null} */
  let ghTimer = null;
  /** @type {Map<string, RepoState>} */
  let state = new Map();
  /** @type {Promise<void> | null} */
  let running = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** Git half of freshness, keyed by project + branch + head + source commit. Pruned each poll.
   * @type {Map<string, 'fresh' | 'behind' | { oldest: number }>} */
  const freshCache = new Map();

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
    if (!isLocalPath(cwd)) throw new Error('not a local path');
    // Worktree paths come from .git/worktrees/*/gitdir, which the repo controls: only
    // local drive-letter paths that exist and are not prunable ever become a cwd or a read.
    const wts = [];
    for (const w of parseWorktrees(await git(['worktree', 'list', '--porcelain'], cwd))) {
      if (w.prunable || !isLocalPath(w.path)) continue;
      try { await fsp.stat(w.path); } catch (_) { continue; }
      // A branch name that is not a valid ref name never reaches git again.
      wts.push(Object.assign(w, { branch: briefsLib.validBranchName(w.branch) ? w.branch : null }));
    }
    const branches = parseBranches(await git(['for-each-ref', '--count=2000', '--sort=-committerdate', 'refs/heads',
      '--format=%(refname)%09%(committerdate:unix)%09%(objectname)'], cwd))
      .filter((b) => briefsLib.validBranchName(b.name));
    const names = new Set(branches.map((b) => b.name));

    let def = null;
    const sym = await gitOrNull(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (sym && sym.trim()) def = sym.trim().replace(/^origin\//, '');
    if (!briefsLib.validBranchName(def)) def = null;
    if (!def || !names.has(def)) {
      def = names.has('main') ? 'main' : names.has('master') ? 'master' : (wts[0] && wts[0].branch) || null;
    }
    if (!briefsLib.validBranchName(def)) def = null;

    let ahead = null; let behind = null;
    if (def) {
      const ab = await gitOrNull(['rev-list', '--left-right', '--count', '--end-of-options', def + '...' + def + '@{upstream}'], cwd);
      const m = ab && /^(\d+)\s+(\d+)/.exec(ab.trim());
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    }

    /** @type {Worktree[]} */
    const worktrees = [];
    for (const w of wts) {
      worktrees.push({ path: w.path, branch: w.branch, head: w.head, dirty: await dirtyOf(w.path) });
    }

    const t = now();
    const { byBranch, malformed } = await briefsLib.readBriefs(wts.map((w) => w.path), { fsp });
    const byRecent = branches.slice().sort((a, b) => b.lastCommitAt - a.lastCommitAt);
    const hasDef = !!(def && names.has(def));
    const picked = byRecent.filter((b) => b.name !== def && (byBranch.has(b.name) || t - b.lastCommitAt <= RECENT_MS));
    // Branches with a brief come first, so the cap never drops one for a plain recent branch.
    const chosen = picked.filter((b) => byBranch.has(b.name)).concat(picked.filter((b) => !byBranch.has(b.name)))
      .slice(0, hasDef ? MAX_BRANCHES - 1 : MAX_BRANCHES);
    const keep = new Set(chosen.map((b) => b.name));
    if (def) keep.add(def);

    /** @type {Set<string>} */
    const used = new Set();
    /** @type {Branch[]} */
    const shown = [];
    for (const b of byRecent) {
      if (!keep.has(b.name)) continue;
      const brief = byBranch.get(b.name) || null;
      let fr = 'none';
      let behindSince = null;
      if (brief) {
        const key = [p.id, b.name, b.head, brief.sourceCommit || ''].join('\u0000');
        used.add(key);
        let r = freshCache.get(key);
        if (r === undefined) {
          const got = await briefsLib.inspectFreshness({ brief, branchHead: b.head, exec, cwd });
          if (got === 'unknown') fr = 'unknown';   // not cached: the commit may arrive on a later fetch
          else { freshCache.set(key, got); r = got; }
        }
        if (r !== undefined) {
          fr = r === 'fresh' ? 'fresh' : r === 'behind' ? 'behind' : briefsLib.classify(r.oldest, t);
          if (typeof r === 'object') behindSince = r.oldest;
        }
      }
      shown.push(Object.assign({}, b, { brief, freshness: fr, behindSince }));
    }
    for (const k of Array.from(freshCache.keys())) if (k.startsWith(p.id + '\u0000') && !used.has(k)) freshCache.delete(k);
    const headline = shown.find((b) => b.name === def);

    return {
      id: p.id, name: p.name, defaultBranch: def, ahead, behind,
      dirty: worktrees.some((w) => w.dirty === true),
      lastCommitAt: branches.length ? Math.max(...branches.map((b) => b.lastCommitAt)) : null,
      worktrees: worktrees.map((w) => ({ path: w.path, branch: w.branch, dirty: w.dirty })),
      branches: shown, polledAt: t, error: false,
      brief: headline ? headline.brief : null, freshness: headline ? headline.freshness : 'none',
      behindSince: headline ? headline.behindSince : null, briefsMalformed: malformed,
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
      const bo = backoff.get(p.id);
      if (bo && now() < bo.until) return;   // timed out recently: leave it alone
      const ctx = { killed: false };
      let res = null;
      try { res = await pollCtx.run(ctx, () => pollOne(p)); } catch (_) { res = null; }
      if (ctx.killed) {
        const wait = bo ? Math.min(bo.wait * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
        backoff.set(p.id, { until: now() + wait, wait });
      } else if (res) backoff.delete(p.id);
      if (res && !ctx.killed) { state.set(p.id, res); return; }
      const prev = state.get(p.id);
      if (prev) state.set(p.id, Object.assign({}, prev, { name: p.name, error: true }));
      else state.set(p.id, {
        id: p.id, name: p.name, defaultBranch: null, ahead: null, behind: null, dirty: null,
        lastCommitAt: null, worktrees: [], branches: [], polledAt: null, error: true,
        brief: null, freshness: 'none', briefsMalformed: 0,
      });
    });
  }

  /** Overlapping calls share the in-flight poll; nothing is queued. @returns {Promise<void>} */
  function pollNow() {
    if (running) return running;
    running = runPoll().catch(() => {}).finally(() => { running = null; });
    return running;
  }

  /** Drops everything held for projects that are hidden or gone. */
  function prune() {
    let ids;
    try { ids = new Set(registry.list().filter((p) => !p.hidden).map((p) => p.id)); } catch (_) { return; }
    for (const id of Array.from(state.keys())) if (!ids.has(id)) state.delete(id);
    for (const id of Array.from(prs.keys())) if (!ids.has(id)) prs.delete(id);
    for (const id of Array.from(ghAt.keys())) if (!ids.has(id)) ghAt.delete(id);
    for (const id of Array.from(backoff.keys())) if (!ids.has(id)) backoff.delete(id);
  }

  async function runGh() {
    if (ghOff) return;
    let list = [];
    try { list = registry.list().filter((p) => !p.hidden); } catch (_) { return; }
    const t = now();
    const due = list.filter((p) => !ghAt.has(p.id) || t - /** @type {number} */ (ghAt.get(p.id)) >= ghIntervalMs);
    await pool(due, 1, async (p) => {
      if (ghOff) return;
      ghAt.set(p.id, now());
      try {
        // gh must not run inside an untrusted repo (it shells out to git there, unhardened):
        // read the remote with the hardened git, then run gh from the temp dir with --repo.
        let remote = null;
        try { remote = parseGithubRemote((await exec('git', ['config', '--get', 'remote.origin.url'], { cwd: p.repoPath })).stdout); } catch (_) {}
        if (!remote) { prs.set(p.id, null); return; }
        const args = GH_ARGS.slice(0, 2).concat(['--repo', remote.owner + '/' + remote.name], GH_ARGS.slice(2));
        const out = (await ghExec(args, { cwd: os.tmpdir() })).stdout;
        const arr = JSON.parse(String(out));
        prs.set(p.id, Array.isArray(arr) ? arr.length : null);
      } catch (e) {
        if (e && e.code === 'ENOENT') { ghOff = true; prs.clear(); return; }
        prs.set(p.id, null);   // signed out, not a GitHub repo, timeout, bad output
      }
    });
  }

  /** Polls gh for projects whose last try is over the interval old. Overlapping calls share one run. @returns {Promise<void>} */
  function pollGh() {
    if (ghRunning) return ghRunning;
    ghRunning = runGh().catch(() => {}).finally(() => { ghRunning = null; });
    return ghRunning;
  }

  /** After a hide/unhide: forget hidden projects at once, then poll so an unhidden one fills in. */
  function refresh() {
    prune();
    pollGh();
    return pollNow();
  }

  return {
    pollNow,
    pollGh,
    refresh,
    start() {
      if (timer) return;
      timer = setInterval(() => { pollNow(); }, intervalMs);
      timer.unref();
      pollNow();
      // gh is slower and rate-limited upstream: its own, much longer timer.
      ghTimer = setInterval(() => { pollGh(); }, ghIntervalMs);
      ghTimer.unref();
      pollGh();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (ghTimer) { clearInterval(ghTimer); ghTimer = null; }
    },
    snapshot() {
      /** @type {Record<string, RepoState>} */
      const out = {};
      for (const [id, s] of state) {
        out[id] = JSON.parse(JSON.stringify(s));
        out[id].prs = prs.has(id) ? prs.get(id) : null;
      }
      return out;
    },
  };
}

module.exports = { createPoller, parseGithubRemote, GH_INTERVAL_MS, GH_ARGS, parseWorktrees, parseBranches, RECENT_MS, MAX_BRANCHES };
