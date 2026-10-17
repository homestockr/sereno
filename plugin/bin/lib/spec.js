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
 * Build the spec file text.
 * @param {{ task: string, builder: string, kind: string, reason: string, fixes: string | null, baseBranch?: string | null, revision: number, body: string, now?: Date }} p
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
    'spec_revision: ' + p.revision,
    'created_at: ' + JSON.stringify((p.now || new Date()).toISOString()),
    '---',
    '',
  ].join('\n');
  return head + p.body.replace(/\s+$/, '') + '\n';
}

/**
 * Write .sereno/specs/<task>.md.
 * @param {{ root: string, fsafe: { writeFile: (rel: string, data: string) => string }, task: string, allowed?: string[], builder?: string, kind?: string, reason?: string, fixes?: string, baseBranch?: string, body: string }} a
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
  const revision = previousRevision(a.root, task) + 1;
  const text = renderSpec({ task, builder: /** @type {string} */ (a.builder), kind: /** @type {string} */ (a.kind), reason, fixes, baseBranch, revision, body: a.body });
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

module.exports = { validBranchName, previousRevision, previousBaseBranch, renderSpec, writeSpec, createTaskBranch };
