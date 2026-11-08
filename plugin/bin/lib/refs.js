// @ts-check
'use strict';
/*
 * Garble guard for /sereno:task. A long command line pasted into the terminal can lose
 * chunks ("MATCHEg.ts:148", "ONE_TIME_PRIavingPercent"). This pulls the file paths and
 * code names out of the task text and checks each against the tracked files of the repo.
 *
 * A token that does not resolve is `new` when a word like "new" or "create" is within 8
 * words of it (the text is describing something to be made), `missing` otherwise. A token
 * with a line number is never `new`: a new file has no line 148.
 *
 * Read-only. The text is never stored; the caller deletes its file. Built-ins only.
 */

const fs = require('node:fs');
const path = require('node:path');
const gitlib = require('./git.js');

const LIST_CAP = 50;
const TOKEN_CAP = 200;
const NAME_GREP_CAP = 120;
const NEAR_WORDS = 8;
const LS_MAX_BYTES = 32 * 1024 * 1024;
const LINE_READ_MAX = 8 * 1024 * 1024;
const EXT_RE = /[\w@-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|css|html|yml|yaml|sql|sh)$/i;
const NEW_RE = /^(?:new|creat(?:e|es|ed|ing)|add|adds|added|adding|introduc(?:e|es|ed|ing)|extract|extracts|extracted|extracting)$/i;

/** @typedef {{ ref: string, kind: 'path' | 'name', path?: string, from?: number, to?: number, idx: number }} Token */

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
      const part = strip(raw);
      if (!part) continue;
      const m = /^([\w@./-]+?)(?::(\d+)(?:-(\d+))?)?$/.exec(part);
      if (m && /[A-Za-z]/.test(m[1]) && (m[1].includes('/') || EXT_RE.test(m[1])) && !/^\.+$/.test(m[1])) {
        addTok({ ref: part, kind: 'path', path: m[1].replace(/^\.\//, ''), from: m[2] === undefined ? undefined : Number(m[2]), to: m[3] === undefined ? undefined : Number(m[3]), idx });
        continue;
      }
      for (const id of part.split(/[^A-Za-z0-9_$]+/)) if (isName(id)) addTok({ ref: id, kind: 'name', idx });
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
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > LINE_READ_MAX) return null;
    const s = fs.readFileSync(file, 'utf8');
    if (!s) return 0;
    const n = s.split('\n').length;
    return s.endsWith('\n') ? n - 1 : n;
  } catch (_e) { return null; }
}

/**
 * @param {{ root: string, text: string }} o
 * @returns {{ ok: true, checked: number, missing: { ref: string, kind: string, why: string }[], new: { ref: string, kind: string }[] } | { ok: false, error: string, code: string }}
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
  /** @type {{ ref: string, kind: string }[]} */ const added = [];
  const done = new Set();
  let checked = 0, greps = 0;
  /** @param {Token} t @param {string} why */
  const unresolved = (t, why) => {
    const hasLine = t.kind === 'path' && t.from !== undefined;
    if (!hasLine && nearNew(words, t.idx)) { if (added.length < LIST_CAP) added[added.length] = { ref: t.ref, kind: t.kind }; }
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
      let why = 'not a tracked file';
      // Prose such as purchase/restore: lowercase letters only, no extension, no line number, no ./ or trailing /. Ignored, unless it names a tracked directory.
      const prose = t.from === undefined && /^[a-z]+(?:\/[a-z]+)+$/.test(p) && !t.ref.startsWith('./');
      if (prose && !tracked.has(p) && !files.some((f) => f.startsWith(p + '/'))) { checked--; continue; }
      if (tracked.has(p)) file = p;
      else if (!p.includes('/')) {
        const hits = byName.get(p) || [];
        if (hits.length === 1) file = hits[0];
        else if (hits.length > 1) why = 'matches ' + hits.length + ' tracked files, so it names none';
      } else if (p.endsWith('/')) {
        if (files.some((f) => f.startsWith(p))) continue;
      } else if (files.some((f) => f.startsWith(p + '/'))) continue; // a tracked directory
      if (file === null) { unresolved(t, why); continue; }
      if (t.from !== undefined) {
        const n = lineCount(path.join(root, file));
        const to = t.to === undefined ? t.from : t.to;
        if (n !== null && (t.from < 1 || to < t.from || to > n)) {
          if (missing.length < LIST_CAP) missing[missing.length] = { ref: t.ref, kind: 'path', why: 'the line is outside ' + file + ' (' + n + ' lines)' };
        }
      }
    } else {
      if (++greps > NAME_GREP_CAP) { checked--; continue; }
      const hit = gitlib.git(root, ['grep', '-l', '-I', '-w', '-F', '-e', t.ref], 20000);
      if (!hit) unresolved(t, 'not found in the tracked files');
    }
  }
  return { ok: true, checked, missing, new: added };
}

module.exports = { extract, check, isName };
