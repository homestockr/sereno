// @ts-check
'use strict';
/*
 * sereno.js brief: write .sereno/briefs/<encodeURIComponent(branch)>.md in the
 * format the Sereno app's src/briefs.js parseBrief reads (front matter, then
 * Now / Next / Blocked lines). The format is shared with the app by contract and
 * pinned by a test that parses this output with the app's parser; the plugin
 * itself requires nothing outside plugin/.
 */

const fs = require('node:fs');
const path = require('node:path');
const { SerenoError } = require('./fsafe.js');
const gitlib = require('./git.js');
const rec = require('./records.js');
const { validBranchName } = require('./spec.js');

const LINE_MAX = 120;
const READ_MAX = 16 * 1024;

/** One line, control and bidi characters stripped, at most LINE_MAX characters. @param {unknown} v @returns {string} */
function oneLine(v) {
  const t = rec.cleanText(v, 100000);
  return t.length > LINE_MAX ? t.slice(0, LINE_MAX - 1).trimEnd() + '…' : t;
}

/** @param {string} branch */
function briefRel(branch) { return '.sereno/briefs/' + encodeURIComponent(branch) + '.md'; }

/**
 * The version in an existing brief's front matter, or null when the file is absent
 * or has no readable version.
 * @param {string} root @param {string} rel @returns {number | null}
 */
function currentVersion(root, rel) {
  const file = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(file); } catch (_e) { return null; }
  if (st.isSymbolicLink() || !st.isFile()) throw new SerenoError('path_refused', 'existing brief is not a regular file');
  if (st.size > READ_MAX) return null;
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return null;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = /^version\s*:\s*(\d{1,9})\s*$/i.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * @param {{ root: string, fsafe: { writeFile: (rel: string, data: string) => string }, branch: string,
 *   now: string, next: string, blocked: string, task?: string, expectVersion?: number, at?: Date }} a
 */
function writeBrief(a) {
  const branch = a.branch;
  if (!validBranchName(branch) || !gitlib.isRefName(branch)) throw new SerenoError('invalid_arg', 'not a valid branch name');
  const cur = gitlib.currentBranch(a.root);
  if (!cur) throw new SerenoError('detached_head', 'detached HEAD: check out a branch, then run the brief again');
  if (cur !== branch) throw new SerenoError('branch_mismatch', 'the brief is for the checked-out branch (' + cur + '), not ' + branch);
  const head = gitlib.resolveCommit(a.root, 'HEAD');
  if (!head) throw new SerenoError('invalid_arg', 'HEAD does not name a commit');
  const now = oneLine(a.now), next = oneLine(a.next);
  if (!now || !next) throw new SerenoError('invalid_arg', '--now and --next must not be empty');
  const blocked = oneLine(a.blocked) || 'None';
  const fallbackTask = branch.replace(/\/+/g, '-');
  const task = rec.cleanText(a.task === undefined ? fallbackTask : a.task, 100) || fallbackTask;

  const rel = briefRel(branch);
  const current = currentVersion(a.root, rel);
  const seen = current === null ? 0 : current;
  if (a.expectVersion !== undefined && a.expectVersion !== seen) {
    throw new SerenoError('version_conflict', 'the brief changed since you read it', { current: seen });
  }
  const version = seen + 1;
  const generated = (a.at || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const text = [
    '---',
    'branch: ' + branch,
    'worktree: ' + a.root.replace(/\\/g, '/'),
    'version: ' + version,
    'source_commit: ' + head,
    'task: ' + task,
    'generated_at: ' + generated,
    '---',
    'Now: ' + now,
    'Next: ' + next,
    'Blocked: ' + blocked,
    '',
  ].join('\n');
  a.fsafe.writeFile(rel, text);
  return { path: rel, version, source_commit: head };
}

module.exports = { writeBrief, currentVersion, briefRel, oneLine, LINE_MAX };
