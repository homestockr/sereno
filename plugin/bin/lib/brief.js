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
const speclib = require('./spec.js');
const nextLib = require('./next.js');
const recoveryLib = require('./recovery.js');
const { validBranchName } = speclib;

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

const BLOCKED_MAX = 3;

/**
 * Now / Next / Blocked for one task branch, from next's state and recovery.
 * @param {string} root @param {any} deps @param {any} m the task's spec meta
 * @returns {{ now: string, next: string, blocked: string }}
 */
function taskParts(root, deps, m) {
  const s = nextLib.stateOf(deps, m);
  /** @type {string} */
  let state;
  if (s.step === 'build') state = 'no attempt yet';
  else if (s.step === 'idle') state = 'waiting on ' + m.after;
  else if (s.step === 'retry') state = 'environment failure, retry next';
  else if (s.step === 'merge') state = /switched off/.test(s.reason) ? 'tests passed, gate off, ready to merge' : 'gate passed, ready to merge';
  else if (s.step === 'done') state = /stopped/.test(s.reason) ? 'stopped' : 'merged';
  else if (s.step === 'decide') state = 'needs a decision';
  else {
    let r = null;
    try { r = deps.recover(m.task); } catch (_e) { r = null; }
    if (r && r.next === 'repair') state = 'review blocked, repair next';
    else if (r && /^head_moved/.test(r.reason)) state = 'branch moved after review';
    else state = 'built, not reviewed';
  }
  const title = speclib.readSpecTitle(root, m.task);
  const cmd = s.command || (s.step === 'idle' ? null : '/sereno:next');
  let next = cmd ? 'run ' + cmd : s.reason;
  if (s.hold) next += ' (before merging: ' + s.hold + ')';
  const blocked = s.step === 'decide' ? rec.cleanText(String(s.reason), 80) : '';
  return { now: m.task + ': ' + title + ', ' + state, next, blocked };
}

/**
 * Now / Next / Blocked from the records, no model: Now is the task most recently merged into the
 * branch (newest task tip by commit time), Next is what `next` answers, Blocked is the tasks in
 * `decide`, each with its reason, at most three.
 * @param {{ root: string, fsafe: any, config: any, branch: string }} a
 * @returns {{ now: string, next: string, blocked: string }}
 */
function autoParts(a) {
  const deps = nextLib.realDeps({ root: a.root, fsafe: a.fsafe, config: a.config });
  // A task branch is briefed as that task: its title, where it stands, what to run next.
  if (a.branch.startsWith('task/')) {
    const t = a.task || a.branch.slice(5);
    const m = deps.spec(t);
    if (m && 'task/' + t === a.branch) return taskParts(a.root, deps, m);
  }
  /** @type {any[]} */
  const metas = [];
  for (const t of deps.listSpecs()) { const m = deps.spec(t); if (m) metas[metas.length] = m; }
  /** @type {any} */
  let last = null;
  let lastAt = -1;
  for (const m of metas) {
    if (!deps.attemptCount(m.task) || !nextLib.mergedInto(deps, m.task, a.branch)) continue;
    if ('task/' + m.task === a.branch) continue; // briefing a task branch: it is not "merged into" itself
    const tip = gitlib.resolveCommit(a.root, 'refs/heads/task/' + m.task)
      || recoveryLib.recordedHead({ root: a.root, task: m.task, listAttempts: () => a.fsafe.listDir('.sereno/attempts') }); // branch deleted after the merge
    const ct = tip ? gitlib.git(a.root, ['show', '-s', '--format=%ct', '--end-of-options', tip]) : null;
    const at = ct && /^\d{1,12}$/.test(ct) ? parseInt(ct, 10) : 0;
    if (at > lastAt || (at === lastAt && last && m.task > last.task)) { last = m; lastAt = at; }
  }
  const now = last ? 'Merged ' + last.task + ': ' + speclib.readSpecTitle(a.root, last.task) : 'No task merged yet';
  const n = nextLib.decide({ task: null, deps });
  const next = n.task
    ? n.task + ' (' + n.step + '), ' + (n.command ? 'run ' + n.command : 'run /sereno:next')
    : n.reason;
  /** @type {string[]} */
  const blocked = [];
  for (const m of metas) {
    if (blocked.length >= BLOCKED_MAX) break;
    if (!deps.attemptCount(m.task)) continue;
    const s = nextLib.stateOf(deps, m);
    if (s.step === 'decide') blocked[blocked.length] = m.task + ': ' + rec.cleanText(String(s.reason).split(/[,;:]/)[0], 30); // the first clause keeps three entries inside the 120-character line
  }
  return { now, next, blocked: blocked.join('; ') };
}

/** @param {{ root: string, fsafe: any, config: any, branch: string, task?: string }} a */
function writeAutoBrief(a) {
  const p = autoParts(a);
  return writeBrief({ root: a.root, fsafe: a.fsafe, branch: a.branch, now: p.now, next: p.next, blocked: p.blocked, task: a.task });
}

module.exports = { writeAutoBrief, autoParts, writeBrief, currentVersion, briefRel, oneLine, LINE_MAX };
