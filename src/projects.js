// @ts-check
'use strict';
/*
 * Project registry. Any git repo a Claude Code session runs in becomes a
 * project, stored in ~/.sereno/projects.json (not the ledger: projects must
 * work with spend history off).
 *
 * Git is only ever run async, off the hook path: the collector answers /hook
 * first and then calls noteCwd() fire-and-forget. Nothing here throws.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config.js');
const { gitExec, isLocalPath } = require('./gitexec.js');

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const MAX_CWD = 1024;
const MAX_CONCURRENT = 2;   // resolveRepo runs at most this many at once
const MAX_PENDING = 50;     // distinct uncached cwds waiting or running; more are dropped until it drains

/**
 * Insert into the resolve cache: expired entries go first, then the oldest past the cap.
 * @param {Map<string, { at: number, val: any }>} cache @param {string} key @param {any} val @param {number} at
 */
function cacheSet(cache, key, val, at) {
  for (const [k, v] of cache) if (at - v.at >= CACHE_TTL_MS) cache.delete(k);
  cache.delete(key);
  cache.set(key, { at, val });
  while (cache.size > CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
}

/**
 * @typedef {{ stdout: string }} ExecResult
 * @typedef {(file: string, args: string[], opts: { cwd?: string }) => Promise<ExecResult>} Exec
 * @typedef {{ root: string, worktree: string }} Repo
 * @typedef {{ id: string, name: string, repoPath: string, hidden: boolean, pinned: boolean, firstSeen: number }} Project
 */

/** Shared hardened git runner (src/gitexec.js). @type {Exec} */
const defaultExec = gitExec;

/**
 * Identity form of a path: absolute, forward slashes, no trailing slash, and
 * lowercase on Windows (drive-letter paths or a win32 host), where case and
 * separators do not distinguish files.
 * @param {string} p
 */
function normalizePath(p) {
  const winLike = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p);
  let s = winLike ? path.win32.resolve(p) : path.resolve(p);
  if (winLike) s = s.replace(/\\/g, '/').toLowerCase();
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** @param {string} root */
function projectId(root) {
  return crypto.createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 12);
}

/** Display form: original casing, native separators. @param {string} p */
function displayPath(p) {
  return /^[a-zA-Z]:[\\/]/.test(p) ? path.win32.resolve(p) : path.resolve(p);
}

const firstLine = (s) => String(s).split(/\r?\n/)[0].trim();

/**
 * @param {string} cwd
 * @param {{ exec?: Exec, now?: () => number, cache?: Map<string, { at: number, val: Repo | null }> }} [opts]
 * @returns {Promise<Repo | null>}
 */
async function resolveRepo(cwd, opts) {
  try {
    // Over-long strings, UNC, device, relative and WSL-style paths never reach exec or fs.
    if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_CWD || !isLocalPath(cwd)) return null;
    const exec = (opts && opts.exec) || defaultExec;
    const now = (opts && opts.now) || Date.now;
    const cache = opts && opts.cache;
    const key = normalizePath(cwd);
    if (cache) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_TTL_MS) return hit.val;
    }
    /** @type {Repo | null} */
    let val = null;
    try {
      const top = firstLine((await exec('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout);
      if (top) {
        let root = top;
        try {
          const common = firstLine((await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })).stdout);
          if (common && path.basename(common).toLowerCase() === '.git') root = path.dirname(common);
        } catch (_) { /* fall back to the toplevel */ }
        // core.worktree / gitdir files are repo-controlled: a non-local result is not a project.
        if (isLocalPath(root) && isLocalPath(top)) val = { root: displayPath(root), worktree: displayPath(top) };
      }
    } catch (_) { val = null; }
    if (cache) cacheSet(cache, key, val, now());
    return val;
  } catch (_) { return null; }
}

/**
 * @param {{ file?: string, exec?: Exec, now?: () => number }} [opts]
 */
function createRegistry(opts) {
  const o = opts || {};
  const now = o.now || Date.now;
  const fileOf = () => o.file || path.join(config.home(), 'projects.json');
  const cache = new Map();
  /** @type {Map<string, Promise<void>>} */
  const inflight = new Map();
  let running = 0;
  /** @type {(() => void)[]} */
  const waiters = [];
  function acquire() {
    if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
    return new Promise((res) => { waiters.push(res); });
  }
  function release() {
    const next = waiters.shift();
    if (next) next(); else running--;   // a waiter inherits the slot
  }
  /** @type {Project[] | null} */
  let projects = null;

  function load() {
    if (projects) return projects;
    projects = [];
    try {
      const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
      if (raw && Array.isArray(raw.projects)) {
        for (const p of raw.projects) {
          if (p && typeof p.id === 'string' && typeof p.repoPath === 'string') {
            projects.push({
              id: p.id,
              name: typeof p.name === 'string' ? p.name : path.basename(p.repoPath),
              repoPath: p.repoPath,
              hidden: p.hidden === true,
              pinned: p.pinned === true,
              firstSeen: typeof p.firstSeen === 'number' ? p.firstSeen : 0,
            });
          }
        }
      }
    } catch (_) { projects = []; }   // missing or corrupt: empty, and untouched until a real change
    return projects;
  }

  function save() {
    try {
      const file = fileOf();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ projects: load() }, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (_) { /* memory still holds it; a later change retries */ }
  }

  const copy = (p) => Object.assign({}, p);

  /** @param {string} root */
  function register(root) {
    const list = load();
    const id = projectId(root);
    let p = list.find((x) => x.id === id);
    if (p) return copy(p);
    const repoPath = displayPath(root);
    p = { id, name: path.basename(repoPath) || repoPath, repoPath, hidden: false, pinned: false, firstSeen: now() };
    list.push(p);
    save();
    return copy(p);
  }

  /** @param {string} id @param {boolean} hidden */
  function setHidden(id, hidden) {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    if (p.hidden !== hidden) { p.hidden = hidden; save(); }
    return true;
  }

  /** @param {string} id @param {boolean} pinned */
  function setPinned(id, pinned) {
    const p = load().find((x) => x.id === id);
    if (!p) return false;
    if (p.pinned !== pinned) { p.pinned = pinned; save(); }
    return true;
  }

  /** @param {string} cwd @returns {Promise<void>} */
  function noteCwd(cwd) {
    try {
      if (typeof cwd !== 'string' || !cwd || cwd.length > MAX_CWD || !isLocalPath(cwd)) return Promise.resolve();
      const key = normalizePath(cwd);
      const cur = inflight.get(key);
      if (cur) return cur;
      const hit = cache.get(key);
      if (hit && now() - hit.at < CACHE_TTL_MS) {   // cached: answers at once, no git, no slot
        if (hit.val) register(hit.val.root);
        return Promise.resolve();
      }
      if (inflight.size >= MAX_PENDING) return Promise.resolve();
      const p = (async () => {
        await acquire();
        try {
          const repo = await resolveRepo(cwd, { exec: o.exec, now, cache });
          if (repo) register(repo.root);
        } catch (_) { /* never throws */ } finally { release(); }
      })().finally(() => { inflight.delete(key); });
      inflight.set(key, p);
      return p;
    } catch (_) { return Promise.resolve(); }
  }

  return {
    register,
    hide: (id) => setHidden(id, true),
    unhide: (id) => setHidden(id, false),
    pin: (id) => setPinned(id, true),
    unpin: (id) => setPinned(id, false),
    list: () => load().map(copy),
    noteCwd,
    pendingCount: () => inflight.size,
    resolve: (cwd) => resolveRepo(cwd, { exec: o.exec, now, cache }),
  };
}

module.exports = { cacheSet, CACHE_MAX, resolveRepo, createRegistry, normalizePath, projectId, CACHE_TTL_MS };
