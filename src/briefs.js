// @ts-check
'use strict';
/*
 * Briefs: the `.sereno/briefs/<percent-encoded branch>.md` files a worktree holds,
 * and how fresh each one is against its branch.
 *
 * Pure parts (parseBrief, decodeBriefName, validBranchName, classify) are separate
 * from I/O (readBriefs reads files; freshness runs git through an injected exec,
 * i.e. the hardened runner). Nothing here throws. The only file content ever read
 * is brief files, and only the Now/Next/Blocked lines plus a few header fields
 * are kept, each capped and stripped of control characters.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { isLocalPath } = require('./gitexec.js');

const MAX_BRIEF_BYTES = 16 * 1024;
const MAX_LINE = 200;
const REVLIST_MAX_BUFFER = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {import('./gitexec.js').Exec} Exec
 * @typedef {{
 *   branch: string, worktree: string | null, version: number | null, sourceCommit: string | null,
 *   task: string | null, generatedAt: string | null, now: string | null, next: string | null, blocked: string | null
 * }} Brief
 * @typedef {'fresh' | 'behind' | 'stale' | 'unknown'} Freshness
 */

// C0, DEL + C1, and bidi embedding/override/isolate controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** @param {string} s */
function clean(s) {
  const t = String(s).replace(CONTROL_RE, '').trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE - 1) + '…' : t;
}

/** @param {string} v @returns {string | null} */
function fm(v) { const c = clean(v); return c ? c : null; }

/**
 * @param {unknown} text
 * @returns {Brief | null}
 */
function parseBrief(text) {
  try {
    if (typeof text !== 'string' || text.length > MAX_BRIEF_BYTES) return null;
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);
    if (!lines.length || lines[0].trim() !== '---') return null;
    let end = -1;
    for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
    if (end < 0) return null;
    /** @type {Record<string, string>} */
    const kv = {};
    for (let i = 1; i < end; i++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(lines[i]);
      if (m && !(m[1].toLowerCase() in kv)) kv[m[1].toLowerCase()] = m[2];
    }
    const branch = kv.branch !== undefined ? clean(kv.branch) : '';
    if (!branch) return null;
    /** @type {{ now: string | null, next: string | null, blocked: string | null }} */
    const body = { now: null, next: null, blocked: null };
    for (let i = end + 1; i < lines.length; i++) {
      const m = /^(now|next|blocked)\s*:(.*)$/i.exec(lines[i]);
      if (!m) continue;
      const k = /** @type {'now' | 'next' | 'blocked'} */ (m[1].toLowerCase());
      if (body[k] === null) body[k] = clean(m[2]);
    }
    if (body.now === null && body.next === null && body.blocked === null) return null;
    const vs = kv.version !== undefined ? kv.version.trim() : '';
    const version = /^\d{1,9}$/.test(vs) ? Number(vs) : null;
    const sc = kv.source_commit !== undefined ? kv.source_commit.trim() : '';
    const sourceCommit = /^[0-9a-f]{4,64}$/i.test(sc) ? sc : null;
    return {
      branch,
      worktree: kv.worktree !== undefined ? fm(kv.worktree) : null,
      version,
      sourceCommit,
      task: kv.task !== undefined ? fm(kv.task) : null,
      generatedAt: kv.generated_at !== undefined ? fm(kv.generated_at) : null,
      now: body.now, next: body.next, blocked: body.blocked,
    };
  } catch (_) { return null; }
}

/** @param {string} file @returns {string | null} */
function decodeBriefName(file) {
  try {
    const base = path.basename(String(file));
    if (!/\.md$/i.test(base) || base.length <= 3) return null;
    const name = decodeURIComponent(base.slice(0, -3));
    return name ? name : null;
  } catch (_) { return null; }
}

/**
 * Mirrors `git check-ref-format --branch` closely enough to keep a name out of
 * option position and out of revision syntax.
 * @param {unknown} b
 */
function validBranchName(b) {
  if (typeof b !== 'string' || !b || b.length > 255) return false;
  if (b.startsWith('-') || b.startsWith('/') || b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return false;
  if (/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(b)) return false;
  // Characters that disguise a name (invisible, bidi, tag, C1): treat it as absent. ZWNJ/ZWJ stay valid.
  if (/[-​‎‏؜᠎⁠-⁤﻿￹-￻‪-‮⁦-⁩󠀀-󠁿]/u.test(b)) return false;
  if (b.includes('..') || b.includes('//') || b.includes('@{') || b === '@') return false;
  if (b.split('/').some((c) => c.startsWith('.') || c.endsWith('.lock'))) return false;
  return true;
}

/**
 * Async throughout (nothing blocks the Electron main thread). Only local drive-letter
 * worktree paths are touched. Each brief file is read with a bounded read (never more
 * than MAX_BRIEF_BYTES + 1), and the number of directory entries scanned is capped.
 * @param {string[]} worktreePaths
 * @param {{ fsp?: typeof nodeFs.promises, maxFiles?: number }} [opts]
 * @returns {Promise<{ byBranch: Map<string, Brief & { file: string, worktree: string | null, worktreePath: string }>, malformed: number }>}
 */
async function readBriefs(worktreePaths, opts) {
  const fsp = (opts && opts.fsp) || nodeFs.promises;
  const maxFiles = (opts && opts.maxFiles) || 200;
  /** @type {Map<string, Brief & { file: string, worktree: string | null, worktreePath: string }>} */
  const byBranch = new Map();
  let malformed = 0;
  let seen = 0;
  const gen = (/** @type {Brief} */ b) => { const t = Date.parse(b.generatedAt || ''); return Number.isFinite(t) ? t : 0; };
  for (const wt of worktreePaths || []) {
    if (!isLocalPath(wt)) continue;
    /** @type {string[]} */
    const names = [];
    const dir = path.join(wt, '.sereno', 'briefs');
    try {
      // A symlinked/junctioned .sereno or briefs dir could point anywhere: skip the worktree's briefs.
      if ((await fsp.lstat(path.join(wt, '.sereno'))).isSymbolicLink() || (await fsp.lstat(dir)).isSymbolicLink()) continue;
      const root = (await fsp.realpath(wt)).toLowerCase();
      const real = (await fsp.realpath(dir)).toLowerCase();
      if (real !== root && !real.startsWith(root.replace(/[\\/]+$/, '') + path.sep)) continue;
      const d = await fsp.opendir(dir);
      try {
        let n = 0;
        for await (const ent of d) { if (++n > maxFiles * 4) break; names.push(ent.name); }
      } finally { await d.close().catch(() => {}); }
    } catch (_) { continue; }
    for (const name of names) {
      if (!/\.md$/i.test(name)) continue;
      if (++seen > maxFiles) return { byBranch, malformed };
      try {
        const full = path.join(dir, name);
        const st = await fsp.lstat(full);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (st.size > MAX_BRIEF_BYTES) { malformed++; continue; }
        let text = '';
        const fh = await fsp.open(full, 'r');
        try {
          const buf = Buffer.alloc(MAX_BRIEF_BYTES + 1);
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          if (bytesRead > MAX_BRIEF_BYTES) { malformed++; continue; }
          text = buf.toString('utf8', 0, bytesRead);
        } finally { await fh.close().catch(() => {}); }
        const b = parseBrief(text);
        const fromName = decodeBriefName(name);
        if (!b || fromName === null || fromName !== b.branch) { malformed++; continue; }
        const cur = byBranch.get(b.branch);
        if (cur) {
          const cv = cur.version === null ? -1 : cur.version;
          const bv = b.version === null ? -1 : b.version;
          if (bv < cv || (bv === cv && gen(b) <= gen(cur))) continue;
        }
        byBranch.set(b.branch, Object.assign({}, b, { file: name, worktreePath: wt }));
      } catch (_) { malformed++; }
    }
  }
  return { byBranch, malformed };
}

/** @param {number} oldestMs @param {number} now @returns {'behind' | 'stale'} */
function classify(oldestMs, now) { return now - oldestMs > DAY_MS ? 'stale' : 'behind'; }

/**
 * The git half of freshness, split out so a caller can cache it: either a fixed
 * answer ('fresh' / 'unknown') or the commit time (ms) of the oldest commit past
 * the brief's source that touches anything but .sereno/ and STATUS.md.
 * @param {{ brief: { branch: string, sourceCommit: string | null }, branchHead?: string | null, exec: Exec, cwd: string }} a
 * @returns {Promise<'fresh' | 'unknown' | 'behind' | { oldest: number }>}
 */
async function inspectFreshness(a) {
  try {
    const b = a.brief;
    if (!b || !validBranchName(b.branch) || !b.sourceCommit || !/^[0-9a-f]{4,64}$/i.test(b.sourceCommit)) return 'unknown';
    try { await a.exec('git', ['cat-file', '-e', '--end-of-options', b.sourceCommit + '^{commit}'], { cwd: a.cwd }); } catch (_) { return 'unknown'; }
    const end = a.branchHead && /^[0-9a-f]{40,64}$/i.test(a.branchHead) ? a.branchHead : 'refs/heads/' + b.branch;
    // Plumbing, not `git log`: rev-list ignores log.* config (showSignature would run gpg.program).
    let out = '';
    try {
      out = (await a.exec('git', ['rev-list', '--timestamp', '--end-of-options', b.sourceCommit + '..' + end, '--',
        '.', ':(exclude).sereno', ':(exclude)STATUS.md'], { cwd: a.cwd, maxBuffer: REVLIST_MAX_BUFFER })).stdout;
    } catch (e) {
      // Too many commits to list: we only need to know it is behind.
      if (e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'behind';
      return 'unknown';
    }
    let oldest = Infinity;
    for (const line of String(out).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const t = Number(line.split(' ')[0]);
      if (Number.isFinite(t)) oldest = Math.min(oldest, t * 1000);
    }
    return oldest === Infinity ? 'fresh' : { oldest };
  } catch (_) { return 'unknown'; }
}

/**
 * @param {{ brief: { branch: string, sourceCommit: string | null }, branchHead?: string | null, exec: Exec, cwd: string, now?: number }} a
 * @returns {Promise<Freshness>}
 */
async function freshness(a) {
  const r = await inspectFreshness(a);
  if (typeof r === 'string') return r;
  return classify(r.oldest, a.now === undefined ? Date.now() : a.now);
}

module.exports = {
  parseBrief, decodeBriefName, readBriefs, freshness, inspectFreshness, classify, validBranchName,
  MAX_BRIEF_BYTES, MAX_LINE,
};
