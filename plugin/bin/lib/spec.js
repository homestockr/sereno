// @ts-check
'use strict';
/*
 * Task specs and task branches.
 *
 * validBranchName is a DELIBERATE COPY of validBranchName in the app's
 * src/briefs.js (the plugin must not require anything outside plugin/); keep
 * the two in step by hand. The spec file is written only through fsafe.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SerenoError } = require('./fsafe.js');
const gitlib = require('./git.js');
const rec = require('./records.js');

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

const REASON_MAX = 400;
const HOLD_MAX = 200;

/**
 * Read the revision of an existing spec, 0 when there is none or it is unreadable.
 * @param {string} root real repo root @param {string} task
 */
function previousRevision(root, task) {
  const file = path.join(root, '.sereno', 'specs', task + '.md');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) return 0;
    const m = /^spec_revision:\s*(\d{1,6})\s*$/m.exec(fs.readFileSync(file, 'utf8').split(/\r?\n---\r?\n/)[0]);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_e) { return 0; }
}

/**
 * Read base_branch from an existing spec, null when there is none.
 * @param {string} root real repo root @param {string} task @returns {string | null}
 */
function previousBaseBranch(root, task) {
  const file = path.join(root, '.sereno', 'specs', task + '.md');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) return null;
    const m = /^base_branch:\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(fs.readFileSync(file, 'utf8').split(/\r?\n---\r?\n/)[0]);
    const v = m ? JSON.parse(m[1]) : null;
    return typeof v === 'string' && gitlib.isRefName(v) ? v : null;
  } catch (_e) { return null; }
}

/**
 * The front matter of an existing spec as plain values, or null when there is no readable
 * spec. Bounded read, no symlinks. Keys a spec does not have (older specs have no `after`
 * or `hold_before_merge`) come back null. `created_at` is the ISO string or null.
 * @param {string} root real repo root @param {string} task
 * @returns {{ task: string, builder: string | null, kind: string | null, base_branch: string | null, after: string | null, hold_before_merge: string | null, spec_revision: number, created_at: string | null, check_hosts: string[], review: 'full' | 'light' | 'none' | null } | null}
 */
function readSpecMeta(root, task) {
  const file = path.join(root, '.sereno', 'specs', task + '.md');
  let head;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) return null;
    const text = fs.readFileSync(file, 'utf8');
    if (!/^---\r?\n/.test(text)) return null;
    head = text.replace(/^---\r?\n/, '').split(/\r?\n---\r?\n/)[0];
  } catch (_e) { return null; }
  /** @param {string} k @returns {unknown} */
  const val = (k) => {
    const m = new RegExp('^' + k + ':[ \t]*(.*?)[ \t]*$', 'm').exec(head);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_e) { return /^[A-Za-z0-9_.-]+$/.test(m[1]) ? m[1] : null; }
  };
  const str = (/** @type {string} */ k) => { const v = val(k); return typeof v === 'string' && v ? v : null; };
  const after = str('after');
  let afterOk = null;
  if (after) { try { afterOk = rec.checkTask(after); } catch (_e) { afterOk = null; } }
  const hold = str('hold_before_merge');
  const rev = val('spec_revision');
  const base = str('base_branch');
  return {
    task,
    builder: str('builder'), kind: str('kind'),
    base_branch: base && gitlib.isRefName(base) ? base : null,
    after: afterOk,
    hold_before_merge: hold ? rec.cleanText(hold, HOLD_MAX) || null : null,
    spec_revision: typeof rev === 'number' ? rev : 0,
    created_at: str('created_at'),
    check_hosts: hostsOf(head),
    review: reviewOf(str('review')),
  };
}

/** The review levels a spec may choose (plugin 0.6). */
const REVIEWS = ['full', 'light', 'none'];

/** @param {string | null} v @returns {'full' | 'light' | 'none' | null} */
function reviewOf(v) { return v === 'full' || v === 'light' || v === 'none' ? v : null; }

/* ---- runnable checks (plugin 0.5 H1) ---- */

const CHECKS_MAX = 20;
const CHECK_VALUE_MAX = 500;
const CHECK_HOSTS_MAX = 10;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** @param {string} category @param {number} line 0 for none @param {string} detail */
function badChecks(category, line, detail) {
  return new SerenoError('invalid_checks', 'invalid_checks ' + category + (line ? ' (line ' + line + ')' : '') + ': ' + detail);
}

/** A bare host name or IP literal: no port, scheme, path or credentials. @param {string} h */
function validHost(h) {
  if (typeof h !== 'string' || !h || h.length > 253) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h) || /^\[[0-9A-Fa-f:.]+\]$/.test(h);
}

/** The `check_hosts` list of a spec head: valid lowercase host names only, at most 10. @param {string} head @returns {string[]} */
function hostsOf(head) {
  const m = /^check_hosts:[ \t]*(.*?)[ \t]*$/m.exec(head);
  if (!m) return [];
  let v;
  try { v = JSON.parse(m[1]); } catch (_e) { return []; }
  if (!Array.isArray(v)) return [];
  /** @type {string[]} */
  const out = [];
  for (const h of v) if (typeof h === 'string' && validHost(h) && !out.includes(h.toLowerCase()) && out.length < CHECK_HOSTS_MAX) out[out.length] = h.toLowerCase();
  return out;
}

/**
 * Validate and normalise a --check-hosts value: a list of bare host names. Throws invalid_arg.
 * @param {string[]} list @returns {string[]}
 */
function cleanCheckHosts(list) {
  if (list.length > CHECK_HOSTS_MAX) throw new SerenoError('invalid_arg', '--check-hosts takes at most ' + CHECK_HOSTS_MAX + ' hosts');
  /** @type {string[]} */
  const out = [];
  for (const raw of list) {
    const h = raw.trim().toLowerCase();
    if (!validHost(h)) throw new SerenoError('invalid_arg', '--check-hosts takes bare host names (no scheme, port or path): ' + rec.cleanText(raw, 60));
    if (!out.includes(h)) out[out.length] = h;
  }
  return out;
}

/** @param {string} value @param {number} line @param {string[]} hosts @returns {string} */
function checkUrl(value, line, hosts) {
  let u;
  try { u = new URL(value); } catch (_e) { throw badChecks('syntax', line, 'not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badChecks('scheme', line, 'only http: and https: URLs are accepted');
  if (u.username || u.password) throw badChecks('host', line, 'a URL with credentials is refused');
  const h = u.hostname.toLowerCase();
  if (!LOCAL_HOSTS.includes(h) && !hosts.includes(h)) throw badChecks('host', line, h + ' is not localhost, 127.0.0.1, [::1] or listed in check_hosts');
  return value;
}

/**
 * @typedef {{ n: number, kind: 'cmd', cmd: string, expect: { type: 'exit', code: number } | { type: 'stdout', text: string } }
 *   | { n: number, kind: 'serve', serve: string, ready: string }
 *   | { n: number, kind: 'http', url: string, expect: { type: 'status', code: number } | { type: 'body', text: string } }
 *   | { n: number, kind: 'browse', url: string, look: string }} Check
 */

/**
 * Parse the `checks` fenced block of a spec. `text` is the whole spec file (its front matter
 * supplies check_hosts) or just a body, in which case `hosts` supplies them. A fence inside another
 * fence is example text and does not count. Returns [] when there is no block. Throws
 * invalid_checks <category> for anything malformed (syntax, expect, limit, host, scheme, serve,
 * multiple, unterminated). Nothing is executed here.
 * @param {string} text @param {string[]} [hosts]
 * @returns {Check[]}
 */
function parseChecks(text, hosts) {
  let head = '', body = text;
  if (/^---\r?\n/.test(text)) {
    const parts = text.replace(/^---\r?\n/, '').split(/\r?\n---\r?\n/);
    head = parts[0]; body = parts.slice(1).join('\n---\n');
  }
  const allowed = hosts ? hosts : hostsOf(head);
  /** @type {string | null} */
  let open = null;
  let inChecks = false, seenBlock = false, closed = false;
  /** @type {{ line: number, text: string }[]} */
  const lines = [];
  const all = body.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (open) {
      const c = new RegExp('^ {0,3}' + (open[0] === '`' ? '`' : '~') + '{' + open.length + ',}[ \\t]*$');
      if (c.test(l)) { open = null; if (inChecks) { inChecks = false; closed = true; } }
      else if (inChecks) lines[lines.length] = { line: i + 1, text: l };
      continue;
    }
    const o = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/.exec(l);
    if (o) {
      open = o[1];
      if (o[2].trim() === 'checks') {
        if (seenBlock) throw badChecks('multiple', i + 1, 'a spec has one checks block');
        seenBlock = true; inChecks = true;
      }
    }
  }
  if (!seenBlock) return [];
  if (!closed) throw badChecks('unterminated', 0, 'the checks block is never closed');

  /** @type {Check[]} */
  const out = [];
  /** @type {Record<string, any> | null} */
  let cur = null;
  let serves = 0;
  const value = (/** @type {string} */ v, /** @type {number} */ line) => {
    const t = v.trim();
    if (!t) throw badChecks('syntax', line, 'empty value');
    if (t.length > CHECK_VALUE_MAX) throw badChecks('limit', line, 'a value is longer than ' + CHECK_VALUE_MAX + ' characters');
    if (/[\u0000-\u001f\u007f]/.test(t)) throw badChecks('syntax', line, 'control characters are not allowed');
    return t;
  };
  const finish = () => {
    if (!cur) return;
    const c = cur; cur = null;
    const n = out.length + 1;
    if (c.kind === 'cmd') {
      if (c.expect === undefined) throw badChecks('expect', c.line, 'cmd needs an expect line');
      if (c.ready !== undefined || c.look !== undefined) throw badChecks('syntax', c.line, 'cmd takes only expect');
      const m = /^exit (\d{1,3})$/.exec(c.expect), s = /^stdout contains (.+)$/.exec(c.expect);
      if (!m && !s) throw badChecks('expect', c.line, 'cmd expects "exit <n>" or "stdout contains <text>"');
      out[out.length] = { n, kind: 'cmd', cmd: c.value, expect: m ? { type: 'exit', code: parseInt(m[1], 10) } : { type: 'stdout', text: /** @type {RegExpExecArray} */ (s)[1] } };
    } else if (c.kind === 'serve') {
      if (c.expect !== undefined || c.look !== undefined) throw badChecks('syntax', c.line, 'serve takes only ready');
      if (c.ready === undefined) throw badChecks('serve', c.line, 'a serve needs a ready URL');
      serves++;
      if (serves > 1) throw badChecks('serve', c.line, 'at most one serve');
      out[out.length] = { n, kind: 'serve', serve: c.value, ready: checkUrl(c.ready, c.line, allowed) };
    } else if (c.kind === 'http') {
      if (c.expect === undefined) throw badChecks('expect', c.line, 'http needs an expect line');
      if (c.ready !== undefined || c.look !== undefined) throw badChecks('syntax', c.line, 'http takes only expect');
      const m = /^status ([1-5]\d\d)$/.exec(c.expect), b = /^body contains (.+)$/.exec(c.expect);
      if (!m && !b) throw badChecks('expect', c.line, 'http expects "status <n>" or "body contains <text>"');
      out[out.length] = { n, kind: 'http', url: checkUrl(c.value, c.line, allowed), expect: m ? { type: 'status', code: parseInt(m[1], 10) } : { type: 'body', text: /** @type {RegExpExecArray} */ (b)[1] } };
    } else {
      if (c.look === undefined) throw badChecks('syntax', c.line, 'browse needs a look line');
      if (c.expect !== undefined || c.ready !== undefined) throw badChecks('syntax', c.line, 'browse takes only look');
      out[out.length] = { n, kind: 'browse', url: checkUrl(c.value, c.line, allowed), look: c.look };
    }
  };
  for (const { line, text: raw } of lines) {
    const l = raw.replace(/\s+$/, '');
    if (!l.trim()) continue;
    const s = /^- (cmd|serve|http|browse):(?:[ \t]+(.*))?$/.exec(l);
    if (s) {
      finish();
      if (out.length >= CHECKS_MAX) throw badChecks('limit', line, 'more than ' + CHECKS_MAX + ' checks');
      cur = { kind: s[1], line, value: value(s[2] || '', line) };
      continue;
    }
    const k = /^[ \t]+(expect|ready|look):(?:[ \t]+(.*))?$/.exec(l);
    if (k && cur) {
      if (cur[k[1]] !== undefined) throw badChecks('syntax', line, 'duplicate ' + k[1]);
      cur[k[1]] = value(k[2] || '', line);
      continue;
    }
    throw badChecks('syntax', line, 'not a check item or a key of one');
  }
  finish();
  return out;
}

/**
 * Tracks fenced code (a fence closes only on the same character with at least the opening length) and
 * skips indented code (4+ spaces or a tab). @param {string} line @param {{ open: string | null }} st @returns {boolean} true to skip the line
 */
function skipCode(line, st) {
  if (st.open) {
    const c = new RegExp('^ {0,3}' + (st.open[0] === '`' ? '`' : '~') + '{' + st.open.length + ',}[ \\t]*$');
    if (c.test(line)) st.open = null;
    return true;
  }
  const o = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (o) { st.open = o[1]; return true; }
  return /^(?: {4,}|\t)/.test(line);
}

const GENERIC_HEADINGS = ['goal', 'background', 'acceptance criteria', 'tests', 'out of scope', 'notes'];
/** @param {string} h */
const normHeading = (h) => h.replace(/[:\s#]+$/, '').trim().toLowerCase();
const isGeneric = (h) => GENERIC_HEADINGS.includes(normHeading(h));

/** Cut at 72 characters on a word boundary (a single long word is cut hard). @param {string} s */
function wordCut(s) {
  if (s.length <= 72) return s;
  const cut = s.slice(0, 73);
  const i = cut.lastIndexOf(' ');
  return (i > 0 ? cut.slice(0, i) : s.slice(0, 72)).trim();
}

/**
 * The spec's title for a commit message, in this order: `title:` in the front matter; the first
 * `# ` (H1) heading of the body; the first non-empty line of the section under a `## Goal` heading;
 * else the task name. Generic headings (Goal, Background, Acceptance criteria, Tests, Out of scope,
 * Notes) never count as a title. One line, at most 72 characters (cut on a word boundary), and the
 * characters a shell treats specially inside double quotes (" ` $ \ ') are removed, so the result is
 * safe to place inside "..." on a command line.
 * @param {string} root real repo root @param {string} task @returns {string}
 */
function readSpecTitle(root, task) {
  const file = path.join(root, '.sereno', 'specs', task + '.md');
  let raw = null;
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && !st.isSymbolicLink() && st.size <= 1024 * 1024) {
      const text = fs.readFileSync(file, 'utf8');
      const parts = /^---\r?\n/.test(text) ? text.replace(/^---\r?\n/, '').split(/\r?\n---\r?\n/) : null;
      const head = parts ? parts[0] : '';
      const body = parts ? parts.slice(1).join('\n---\n') : text;
      const m = /^title:[ \t]*(.*?)[ \t]*$/m.exec(head);
      if (m && m[1]) { try { const v = JSON.parse(m[1]); raw = typeof v === 'string' ? v : null; } catch (_e) { raw = m[1]; } }
      if (!raw || !raw.trim()) {
        raw = null;
        let st = { open: null }, inGoal = false;
        for (const line of body.split(/\r?\n/)) {
          if (skipCode(line, st)) continue;
          const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
          if (h1 && !isGeneric(h1[1])) { raw = h1[1]; break; }
        }
        if (!raw) {
          st = { open: null };
          for (const line of body.split(/\r?\n/)) {
            if (skipCode(line, st)) continue;
            const h = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
            if (h) { if (inGoal) break; inGoal = h[1] === '##' && normHeading(h[2]) === 'goal'; continue; }
            if (inGoal && line.trim()) { raw = line.trim().replace(/^(?:[-*+>]|\d+[.)])[ \t]+/, ''); break; }
          }
        }
      }
    }
  } catch (_e) { raw = null; }
  const clean = wordCut(rec.cleanText(raw || '', 400).replace(/["`$\\']/g, '').replace(/ {2,}/g, ' ').trim());
  return clean || task;
}

/**
 * Build the spec file text.
 * @param {{ task: string, builder: string, kind: string, reason: string, fixes: string | null, baseBranch?: string | null, after?: string | null, hold?: string | null, checkHosts?: string[], review?: string | null, revision: number, body: string, now?: Date }} p
 */
function renderSpec(p) {
  // JSON strings are valid YAML scalars, so free text can never break the front matter.
  const head = [
    '---',
    'task: ' + JSON.stringify(p.task),
    'builder: ' + p.builder,
    'kind: ' + p.kind,
    ...(p.review ? ['review: ' + p.review] : []),
    'reason: ' + JSON.stringify(p.reason),
    'fixes: ' + (p.fixes === null ? 'null' : JSON.stringify(p.fixes)),
    'base_branch: ' + (p.baseBranch ? JSON.stringify(p.baseBranch) : 'null'),
    'after: ' + (p.after ? JSON.stringify(p.after) : 'null'),
    'hold_before_merge: ' + (p.hold ? JSON.stringify(p.hold) : 'null'),
    ...(p.checkHosts && p.checkHosts.length ? ['check_hosts: ' + JSON.stringify(p.checkHosts)] : []),
    'spec_revision: ' + p.revision,
    'created_at: ' + JSON.stringify((p.now || new Date()).toISOString()),
    '---',
    '',
  ].join('\n');
  return head + p.body.replace(/\s+$/, '') + '\n';
}

/**
 * Write .sereno/specs/<task>.md.
 * @param {{ root: string, fsafe: { writeFile: (rel: string, data: string) => string }, task: string, allowed?: string[], builder?: string, kind?: string, reason?: string, fixes?: string, baseBranch?: string, after?: string, hold?: string, checkHosts?: string[], review?: string, body: string }} a
 */
function writeSpec(a) {
  const task = rec.checkTask(a.task);
  if (!rec.BUILDERS.includes(a.builder || '')) throw new SerenoError('invalid_arg', '--builder must be one of: ' + rec.BUILDERS.join(', '));
  if (a.allowed && !a.allowed.includes(/** @type {string} */ (a.builder))) throw new SerenoError('builder_not_allowed', '--builder ' + a.builder + ' is not allowed by roles.builder.allowed; allowed tiers: ' + a.allowed.join(', '));
  if (!rec.KINDS.includes(a.kind || '')) throw new SerenoError('invalid_arg', '--kind must be one of: ' + rec.KINDS.join(', '));
  const reason = rec.cleanText(a.reason, REASON_MAX);
  if (!reason) throw new SerenoError('invalid_arg', '--reason is required: record why this Builder was chosen');
  const fixes = a.fixes === undefined ? null : rec.checkTask(a.fixes);
  if (!a.body || !a.body.trim()) throw new SerenoError('invalid_arg', 'acceptance criteria are required on stdin');
  if (a.baseBranch !== undefined && !gitlib.isRefName(a.baseBranch)) throw new SerenoError('invalid_arg', '--base-branch is not a valid branch name');
  const baseBranch = a.baseBranch !== undefined ? a.baseBranch : previousBaseBranch(a.root, task);
  // after / hold: omitted keeps the earlier spec's value; `--after none` and `--hold ""` clear it.
  const prev = readSpecMeta(a.root, task);
  /** @type {string | null} */
  let after = prev ? prev.after : null;
  if (a.after !== undefined) {
    if (a.after === '' || a.after === 'none') after = null;
    else {
      after = rec.checkTask(a.after);
      if (after === task) throw new SerenoError('invalid_arg', '--after cannot name the task itself');
    }
  }
  /** @type {string | null} */
  let hold = prev ? prev.hold_before_merge : null;
  if (a.hold !== undefined) {
    const h = rec.cleanText(a.hold, HOLD_MAX + 1);
    if (a.hold.trim() && !h) throw new SerenoError('invalid_arg', '--hold has no printable text');
    if (h.length > HOLD_MAX) throw new SerenoError('invalid_arg', '--hold is longer than ' + HOLD_MAX + ' characters');
    hold = h || null;
  }
  // check_hosts: omitted keeps the earlier spec's list; an empty list clears it. Only the user's own hosts belong here.
  const checkHosts = a.checkHosts !== undefined ? cleanCheckHosts(a.checkHosts) : (prev ? prev.check_hosts : []);
  // review: omitted keeps the earlier spec's value; a new spec with none has no field (the config decides, as before 0.6).
  if (a.review !== undefined && !REVIEWS.includes(a.review)) throw new SerenoError('usage', '--review must be one of: ' + REVIEWS.join(', '));
  const review = a.review !== undefined ? a.review : (prev ? prev.review : null);
  parseChecks(a.body, checkHosts); // a malformed checks block is refused at write time, never at test time
  const revision = previousRevision(a.root, task) + 1;
  const text = renderSpec({ task, builder: /** @type {string} */ (a.builder), kind: /** @type {string} */ (a.kind), reason, fixes, baseBranch, after, hold, checkHosts, review, revision, body: a.body });
  const rel = '.sereno/specs/' + task + '.md';
  a.fsafe.writeFile(rel, text);
  return { path: rel, spec_revision: revision, spec_hash: rec.sha256(Buffer.from(text, 'utf8')) };
}

/**
 * Create branch task/<task> at the current HEAD. Does not switch to it.
 * Refuses a bad name, an existing branch, a detached HEAD, or a dirty tracked tree.
 * @param {{ root: string, task: string }} a
 */
function createTaskBranch(a) {
  const task = rec.checkTask(a.task);
  const branch = 'task/' + task;
  if (!validBranchName(branch) || !gitlib.isRefName(branch)) throw new SerenoError('invalid_arg', 'not a valid branch name: ' + branch);
  const head = gitlib.resolveCommit(a.root, 'HEAD');
  if (!head) throw new SerenoError('invalid_arg', 'repository has no commits yet');
  const dirty = gitlib.cleanFiles(a.root);
  if (dirty === null) throw new SerenoError('invalid_arg', 'could not read the working tree status');
  if (dirty.length) throw new SerenoError('dirty_tree', 'working tree has uncommitted changes; commit or stash them first');
  if (gitlib.git(a.root, ['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]) !== null) {
    throw new SerenoError('exists', 'branch ' + branch + ' already exists');
  }
  if (gitlib.git(a.root, ['branch', '--no-track', '--end-of-options', branch, head]) === null) {
    throw new SerenoError('invalid_arg', 'git could not create ' + branch);
  }
  return { branch, base_commit: head, from_branch: gitlib.currentBranch(a.root) };
}

module.exports = { REVIEWS, parseChecks, cleanCheckHosts, CHECKS_MAX, CHECK_VALUE_MAX, validBranchName, previousRevision, previousBaseBranch, readSpecMeta, readSpecTitle, HOLD_MAX, renderSpec, writeSpec, createTaskBranch };
