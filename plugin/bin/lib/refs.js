// @ts-check
'use strict';
/*
 * Garble guard for /sereno:task. A long command line pasted into the terminal can lose
 * chunks ("MATCHEg.ts:148", "ONE_TIME_PRIavingPercent"). This pulls the file paths and
 * code names out of the task text and checks each against the tracked files of the repo.
 *
 * A token that does not resolve is `new` when a word like "new" or "create" is within 8
 * words of it (the text is describing something to be made). Otherwise it is `missing`
 * (a strong signal, the caller stops) or `warn` (a weak signal, listed only). Strong: a path
 * with a directory part, any path with a line number, a camelCase or UPPER_SNAKE name. Weak: a
 * bare file name ("settings.json", "Node.js") and a PascalCase name ("TypeScript"). A token
 * with a line number is never `new`: a new file has no line 148.
 *
 * Read-only. The text is never stored; the caller deletes its file. Built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gitlib = require('./git.js');

const LIST_CAP = 50;
const TOKEN_CAP = 200;
const NAME_GREP_CAP = 120;
const GREP_CHUNK = 40;
const NEAR_WORDS = 8;
const LS_MAX_BYTES = 32 * 1024 * 1024;
const LINE_READ_MAX = 8 * 1024 * 1024;
const EXT_RE = /[\w-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|css|html|yml|yaml|sql|sh)$/i;
const NEW_RE = /^(?:new|creat(?:e|es|ed|ing)|add|adds|added|adding|introduc(?:e|es|ed|ing)|extract|extracts|extracted|extracting)$/i;

/** @typedef {{ ref: string, kind: 'path' | 'name', path?: string, from?: number, to?: number, idx: number, dot?: boolean, weak?: boolean }} Token */

/** @param {string} w */
function strip(w) {
  let s = w;
  for (;;) {
    const t = s.replace(/^[`'"([{<*]+/, '').replace(/[`'")\]}>*.,;:!?]+$/, '');
    if (t === s) return s;
    s = t;
  }
}

/** @param {string} s */
function isName(s) {
  if (s.length < 4 || s.length > 80 || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) return false;
  const caps = (s.match(/[A-Z]/g) || []).length;
  const lower = /[a-z]/.test(s);
  if (s.includes('_') && caps > 0) return true; // UPPER_SNAKE, or a damaged one
  if (/^[a-z_$]/.test(s) && /[a-z0-9_$][A-Z]/.test(s)) return true; // camelCase
  return lower && caps >= 2; // PascalCase
}

/** PascalCase only (not UPPER_SNAKE, not camelCase): a product or language name is as likely as a symbol.
 * @param {string} s */
function isWeakName(s) {
  if (s.includes('_') && /[A-Z]/.test(s)) return false;
  return !(/^[a-z_$]/.test(s) && /[a-z0-9_$][A-Z]/.test(s));
}

/**
 * Pull path and code-name tokens out of free text. Each token remembers the index of the
 * whitespace-separated word it came from, for the "new" proximity rule.
 * @param {string} text
 * @returns {{ tokens: Token[], words: string[] }}
 */
function extract(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  /** @type {Token[]} */ const tokens = [];
  const seen = new Set();
  /** @param {Token} t */
  const addTok = (t) => { const k = t.kind + '\0' + t.ref + '\0' + t.idx; if (!seen.has(k)) { seen.add(k); tokens[tokens.length] = t; } };
  words.forEach((word, idx) => {
    for (const raw of word.split(/[`'"()[\]{}<>,;|]+/)) {
      const part = strip(raw).replace(/[\\]/g, '/');
      if (!part) continue;
      // Absolute paths, home paths and drive paths are not repo-relative: skipped whole.
      if (/^[/~]/.test(part) || /^[A-Za-z]:\//.test(part)) continue;
      const m = /^([\w./-]+?)(?::(\d+)(?:-(\d+))?)?$/.exec(part);
      // A path candidate ends in a known extension. Extensionless slash tokens (branches,
      // dirs, routes, I/O) are prose. A bare fragment such as .md or .source.md is not a path.
      if (m && /[A-Za-z]/.test(m[1]) && EXT_RE.test(m[1])) {
        // A bare dotted token (.eslintrc.json) is decided in check(): a path only when tracked.
        const dot = m[1].startsWith('.') && !m[1].includes('/');
        addTok({ ref: part, kind: 'path', dot, path: m[1].replace(/^\.\//, ''), from: m[2] === undefined ? undefined : Number(m[2]), to: m[3] === undefined ? undefined : Number(m[3]), idx });
        continue;
      }
      for (const id of part.split(/[^A-Za-z0-9_$]+/)) if (isName(id)) addTok({ ref: id, kind: 'name', weak: isWeakName(id), idx });
    }
  });
  return { tokens, words };
}

/** @param {string[]} words @param {number} idx */
function nearNew(words, idx) {
  for (let j = Math.max(0, idx - NEAR_WORDS); j <= Math.min(words.length - 1, idx + NEAR_WORDS); j++) {
    if (j !== idx && NEW_RE.test(strip(words[j]))) return true;
  }
  return false;
}

/** @param {string} file @returns {number | null} */
function lineCount(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > LINE_READ_MAX) return null;
    const s = fs.readFileSync(file, 'utf8');
    if (!s) return 0;
    const n = s.split('\n').length;
    return s.endsWith('\n') ? n - 1 : n;
  } catch (_e) { return null; }
}

/**
 * One `git grep` per chunk of names. Exit 0 = matches, 1 = none, anything else (or a
 * timeout) = failure, never "not found".
 * @param {string} root @param {string[]} names @returns {Set<string> | null}
 */
function grepNames(root, names) {
  const found = new Set();
  const want = new Set(names);
  for (let i = 0; i < names.length; i += GREP_CHUNK) {
    // The user's grep.* and color.* config must not change the output shape.
    const args = ['grep', '--no-line-number', '--no-column', '--no-color', '-h', '-o', '-w', '-F', '-I'];
    for (const n of names.slice(i, i + GREP_CHUNK)) { args[args.length] = '-e'; args[args.length] = n; }
    const r = spawnSync('git', gitlib.SAFE_ARGS.concat(args), { cwd: root, env: gitlib.safeEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: LS_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) return null;
    if (r.status === 0) for (const line of String(r.stdout).split(/\r?\n/)) if (want.has(line)) found.add(line);
  }
  return found;
}

/** The real path of abs, only when it stays inside the real root; a junction or symlink out is null.
 * @param {string} root @param {string} abs @returns {string | null} */
function insideReal(root, abs) {
  try {
    const rr = fs.realpathSync.native(root), ra = fs.realpathSync.native(abs);
    const a = process.platform === 'win32' ? ra.toLowerCase() : ra, r = process.platform === 'win32' ? rr.toLowerCase() : rr;
    return a.startsWith(r.endsWith(path.sep) ? r : r + path.sep) ? ra : null;
  } catch (_e) { return null; }
}

/**
 * @param {{ root: string, text: string }} o
 * @returns {{ ok: true, checked: number, missing: { ref: string, kind: string, why: string }[], warn: { ref: string, kind: string, why: string }[], new: { ref: string, kind: string }[] } | { ok: false, error: string, code: string }}
 */
function check(o) {
  const { root } = o;
  const ls = gitlib.git(root, ['ls-files', '-z'], 20000, LS_MAX_BYTES);
  if (ls === null) return { ok: false, error: 'could not list the tracked files (git failed)', code: 'git_failed' };
  const files = ls.split('\0').filter(Boolean);
  const tracked = new Set(files);
  /** @type {Map<string, string[]>} */ const byName = new Map();
  for (const f of files) {
    const b = f.slice(f.lastIndexOf('/') + 1);
    const l = byName.get(b);
    if (l) l[l.length] = f; else byName.set(b, [f]);
  }

  const { tokens, words } = extract(o.text);
  /** @type {{ ref: string, kind: string, why: string }[]} */ const missing = [];
  /** @type {{ ref: string, kind: string, why: string }[]} */ const warn = [];
  /** @type {{ ref: string, kind: string }[]} */ const added = [];
  const done = new Set();
  let checked = 0, greps = 0;
  /** @type {Token[]} */ const nameToks = [];
  /** @param {Token} t @param {string} why */
  const unresolved = (t, why) => {
    const hasLine = t.kind === 'path' && t.from !== undefined;
    const weak = t.kind === 'path' ? (!hasLine && !(/** @type {string} */ (t.path)).includes('/')) : !!t.weak;
    if (!hasLine && nearNew(words, t.idx)) { if (added.length < LIST_CAP) added[added.length] = { ref: t.ref, kind: t.kind }; }
    else if (weak) { if (warn.length < LIST_CAP) warn[warn.length] = { ref: t.ref, kind: t.kind, why }; }
    else if (missing.length < LIST_CAP) missing[missing.length] = { ref: t.ref, kind: t.kind, why };
  };
  for (const t of tokens) {
    if (checked >= TOKEN_CAP) break;
    const key = t.kind + '\0' + t.ref + '\0' + (nearNew(words, t.idx) ? 'n' : '');
    if (done.has(key)) continue;
    done.add(key);
    checked++;
    if (t.kind === 'path') {
      const p = /** @type {string} */ (t.path);
      /** @type {string | null} */ let file = null;
      let resolved = false;
      if (tracked.has(p)) { file = p; resolved = true; }
      else if (!p.includes('/') && (byName.get(p) || []).length >= 1) {
        const hits = /** @type {string[]} */ (byName.get(p));
        resolved = true; // more than one match is ambiguous, not garbled
        if (hits.length === 1) file = hits[0];
      } else if (t.dot) {
        checked--; // an untracked bare dotfile name is prose or a typo, not a reference
        continue;
      } else {
        // Untracked but present (.sereno/pipeline.json, a new local file): lstat, inside root,
        // and the real path (junctions, symlinks) must stay inside the real root.
        const abs = path.resolve(root, p);
        if (abs.startsWith(path.resolve(root) + path.sep)) {
          try {
            const st = fs.lstatSync(abs);
            if (insideReal(root, abs) !== null) { resolved = true; if (st.isFile()) file = p; }
          } catch (_e) { /* absent */ }
        }
      }
      if (!resolved) { unresolved(t, 'not a tracked file'); continue; }
      if (file !== null && t.from !== undefined) {
        const n = lineCount(path.join(root, file));
        const to = t.to === undefined ? t.from : t.to;
        if (n !== null && (t.from < 1 || to < t.from || to > n)) {
          if (missing.length < LIST_CAP) missing[missing.length] = { ref: t.ref, kind: 'path', why: 'the line is outside ' + file + ' (' + n + ' lines)' };
        }
      }
    } else {
      if (++greps > NAME_GREP_CAP) { checked--; continue; }
      nameToks[nameToks.length] = t;
    }
  }
  if (nameToks.length) {
    const found = grepNames(root, [...new Set(nameToks.map((t) => t.ref))]);
    if (found === null) return { ok: false, error: 'could not search the tracked files (git grep failed)', code: 'git_failed' };
    for (const t of nameToks) if (!found.has(t.ref)) unresolved(t, 'not found in the tracked files');
  }
  return { ok: true, checked, missing, warn, new: added };
}

module.exports = { extract, check, isName };
