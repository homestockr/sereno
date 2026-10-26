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
 * @returns {{ task: string, builder: string | null, kind: string | null, base_branch: string | null, after: string | null, hold_before_merge: string | null, spec_revision: number, created_at: string | null } | null}
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
  };
}

const GENERIC_HEADINGS = ['goal', 'background', 'acceptance criteria', 'tests', 'out of scope', 'notes'];
/** @param {string} h */
const isGeneric = (h) => GENERIC_HEADINGS.includes(h.replace(/[:\s#]+$/, '').trim().toLowerCase());

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
        let fence = false, inGoal = false;
        for (const line of body.split(/\r?\n/)) {
          if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
          if (fence) continue;
          const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
          if (h1 && !isGeneric(h1[1])) { raw = h1[1]; break; }
        }
        if (!raw) {
          fence = false;
          for (const line of body.split(/\r?\n/)) {
            if (/^\s*(```|~~~)/.test(line)) { fence = !fence; if (!inGoal) continue; }
            const h = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(fence ? '' : line);
            if (h) { if (inGoal) break; inGoal = h[1] === '##' && h[2].trim().toLowerCase() === 'goal'; continue; }
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
 * @param {{ task: string, builder: string, kind: string, reason: string, fixes: string | null, baseBranch?: string | null, after?: string | null, hold?: string | null, revision: number, body: string, now?: Date }} p
 */
function renderSpec(p) {
  // JSON strings are valid YAML scalars, so free text can never break the front matter.
  const head = [
    '---',
    'task: ' + JSON.stringify(p.task),
    'builder: ' + p.builder,
    'kind: ' + p.kind,
    'reason: ' + JSON.stringify(p.reason),
    'fixes: ' + (p.fixes === null ? 'null' : JSON.stringify(p.fixes)),
    'base_branch: ' + (p.baseBranch ? JSON.stringify(p.baseBranch) : 'null'),
    'after: ' + (p.after ? JSON.stringify(p.after) : 'null'),
    'hold_before_merge: ' + (p.hold ? JSON.stringify(p.hold) : 'null'),
    'spec_revision: ' + p.revision,
    'created_at: ' + JSON.stringify((p.now || new Date()).toISOString()),
    '---',
    '',
  ].join('\n');
  return head + p.body.replace(/\s+$/, '') + '\n';
}

/**
 * Write .sereno/specs/<task>.md.
 * @param {{ root: string, fsafe: { writeFile: (rel: string, data: string) => string }, task: string, allowed?: string[], builder?: string, kind?: string, reason?: string, fixes?: string, baseBranch?: string, after?: string, hold?: string, body: string }} a
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
  const revision = previousRevision(a.root, task) + 1;
  const text = renderSpec({ task, builder: /** @type {string} */ (a.builder), kind: /** @type {string} */ (a.kind), reason, fixes, baseBranch, after, hold, revision, body: a.body });
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

module.exports = { validBranchName, previousRevision, previousBaseBranch, readSpecMeta, readSpecTitle, HOLD_MAX, renderSpec, writeSpec, createTaskBranch };
