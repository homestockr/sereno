// @ts-check
'use strict';
/*
 * Pipeline: the app's read side of the plugin's task records. The rules (recovery,
 * config) are the plugin's own pure modules, required by relative path so the tab
 * cannot disagree with /sereno:ship. package.json build.files bundles them.
 *
 * readRepo reads `.sereno/{attempts,gates,specs}` of one repo. Guards run before any
 * read (and before the plugin's recovery.decide may read the same dirs): local path
 * only, no symlinked/junctioned `.sereno` or subdirectory, realpath containment,
 * capped directory scans, bounded reads. Only fixed field lists are kept; spec bodies,
 * tests.command and tests.setup are never returned. Nothing here throws.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { isLocalPath } = require('./gitexec.js');
const recovery = require('../plugin/bin/lib/recovery.js');
const config = require('../plugin/bin/lib/config.js');
const rec = require('../plugin/bin/lib/records.js');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 200;
const SCAN_FACTOR = 4;
const SPEC_HEAD_BYTES = 8 * 1024;
const SPEC_FIELDS = ['task', 'builder', 'kind', 'reason', 'fixes', 'base_branch', 'spec_revision', 'created_at'];
const ATTEMPT_FILE = /^(.+)-([1-9]\d{0,5})\.json$/;

/** @typedef {{ config: any, tasks: Array<{ task: string, spec: any, attempts: any[], gates: any[] }>, skipped: number }} RepoRecords */

/** @param {unknown} s @param {number} max @returns {string | null} */
function str(s, max) { const t = rec.cleanText(s, max); return t ? t : null; }
/** @param {unknown} s @returns {string | null} */
function idStr(s) { return typeof s === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(s) ? s : null; }
/** @param {unknown} s @returns {string | null} */
function hex(s) { return typeof s === 'string' && /^[0-9a-f]{7,64}$/i.test(s) ? s : null; }
/** @param {unknown} s @returns {string | null} */
function sha(s) { return typeof s === 'string' && /^sha256:[0-9a-f]{64}$/.test(s) ? s : null; }
/** @param {unknown} s @returns {string | null} */
function iso(s) { return typeof s === 'string' && s.length <= 40 && Number.isFinite(Date.parse(s)) ? s : null; }
/** @param {unknown} n @returns {number | null} */
function posInt(n) { return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 1e9 ? n : null; }
/** @param {unknown} t @returns {string | null} */
function taskName(t) { try { return rec.checkTask(t); } catch (_) { return null; } }
/** @param {unknown} o @returns {o is Record<string, any>} */
function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

/**
 * Refuse a repo whose `.sereno` or one of its record dirs is a link or escapes the
 * repo. Returns which record dirs exist, or null when refused or `.sereno` is absent.
 * @param {string} root
 * @param {typeof nodeFs.promises} fsp
 * @returns {Promise<{ attempts: boolean, gates: boolean, specs: boolean } | null>}
 */
async function guardRepo(root, fsp) {
  try {
    if (!isLocalPath(root)) return null;
    const base = path.join(root, '.sereno');
    const bst = await fsp.lstat(base);
    if (bst.isSymbolicLink() || !bst.isDirectory()) return null;
    const rootReal = (await fsp.realpath(root)).toLowerCase().replace(/[\\/]+$/, '');
    const inside = async (/** @type {string} */ p) => {
      const r = (await fsp.realpath(p)).toLowerCase();
      return r === rootReal || r.startsWith(rootReal + path.sep);
    };
    if (!(await inside(base))) return null;
    /** @type {{ attempts: boolean, gates: boolean, specs: boolean }} */
    const has = { attempts: false, gates: false, specs: false };
    for (const sub of /** @type {Array<'attempts' | 'gates' | 'specs'>} */ (['attempts', 'gates', 'specs'])) {
      const dir = path.join(base, sub);
      let st;
      try { st = await fsp.lstat(dir); } catch (e) {
        if (e && /** @type {any} */ (e).code === 'ENOENT') continue;
        return null;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      if (!(await inside(dir))) return null;
      has[sub] = true;
    }
    return has;
  } catch (_) { return null; }
}

/**
 * The plugin's config loader follows links (statSync), so check the repo's own
 * pipeline.json first: absent is fine; a link, a non-file or an escaping realpath is not.
 * @param {string} root @param {typeof nodeFs.promises} fsp
 */
async function configFileOk(root, fsp) {
  const file = path.join(root, '.sereno', 'pipeline.json');
  let st;
  try { st = await fsp.lstat(file); } catch (e) { return !!e && /** @type {any} */ (e).code === 'ENOENT'; }
  if (st.isSymbolicLink() || !st.isFile()) return false;
  const rootReal = (await fsp.realpath(root)).toLowerCase().replace(/[\\/]+$/, '');
  return (await fsp.realpath(file)).toLowerCase().startsWith(rootReal + path.sep);
}

/** @param {string} dir @param {typeof nodeFs.promises} fsp @returns {Promise<string[]>} */
async function scan(dir, fsp) {
  /** @type {string[]} */
  const names = [];
  try {
    const d = await fsp.opendir(dir);
    try {
      let n = 0;
      for await (const ent of d) { if (++n > MAX_FILES * SCAN_FACTOR) break; names.push(ent.name); }
    } finally { await d.close().catch(() => {}); }
  } catch (_) { /* unreadable dir: nothing */ }
  return names;
}

/**
 * Bounded read of a regular, non-link file of at most MAX_FILE_BYTES. With headBytes,
 * only that many leading bytes are returned. 'bad' when linked, oversized or unreadable.
 * @param {string} file @param {typeof nodeFs.promises} fsp @param {number} [headBytes]
 * @returns {Promise<{ text: string } | 'bad'>}
 */
async function readBounded(file, fsp, headBytes) {
  try {
    const st = await fsp.lstat(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return 'bad';
    const want = Math.min(headBytes || MAX_FILE_BYTES, MAX_FILE_BYTES);
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await fh.read(buf, 0, want + 1, 0);
      if (!headBytes && bytesRead > MAX_FILE_BYTES) return 'bad';
      return { text: buf.toString('utf8', 0, Math.min(bytesRead, want)) };
    } finally { await fh.close().catch(() => {}); }
  } catch (_) { return 'bad'; }
}

/** @param {string} text @returns {any} parsed JSON or undefined */
function parseJson(text) { try { return JSON.parse(text); } catch (_) { return undefined; } }

/** @param {Record<string, any>} r @param {string} task @param {number} n */
function cleanAttempt(r, task, n) {
  return {
    project_id: str(r.project_id, 128),
    task_id: task,
    spec_revision: posInt(r.spec_revision),
    attempt: n,
    builder_requested: rec.enumOr(r.builder_requested, rec.BUILDERS),
    agent_id: idStr(r.agent_id),
    config_hash: sha(r.config_hash),
    kind: rec.enumOr(r.kind, rec.KINDS),
    fixes: taskName(r.fixes),
    diagnosis: rec.enumOr(r.diagnosis, rec.DIAGNOSES),
    outcome: rec.enumOr(r.outcome, rec.ATTEMPT_OUTCOMES),
    review_run_id: typeof r.review_run_id === 'string' && rec.RUN_ID.test(r.review_run_id) ? r.review_run_id : null,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    spec_hash: sha(r.spec_hash),
    head_commit: hex(r.head_commit),
  };
}

/** @param {Record<string, any>} r @param {string} task @param {string} runId */
function cleanGate(r, task, runId) {
  const v = rec.sanitizeVerdict({ outcome: r.outcome, findings: r.findings, context_requests: r.context_requests });
  return {
    review_run_id: runId,
    task_id: task,
    spec: str(r.spec, 260),
    spec_hash: sha(r.spec_hash),
    branch: str(r.branch, 255),
    base_commit: hex(r.base_commit),
    head_commit: hex(r.head_commit),
    session_id: idStr(r.session_id),
    agent_id: idStr(r.agent_id),
    model: idStr(r.model),
    outcome: v.outcome,
    tests_passed: r.tests_passed === true,
    findings: v.findings,
    context_requests: v.context_requests,
    reviewed_at: iso(r.reviewed_at),
    config_hash: sha(r.config_hash),
  };
}

/**
 * Front matter only (the first block between `---` lines). Values are JSON strings
 * where the plugin wrote them. The body is never parsed or returned.
 * @param {string} text @returns {Record<string, any> | null}
 */
function parseSpecHead(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return null;
  /** @type {Record<string, any>} */
  const kv = {};
  for (let i = 1; i < end; i++) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(lines[i]);
    if (!m || !SPEC_FIELDS.includes(m[1]) || m[1] in kv) continue;
    let v = /** @type {any} */ (m[2].trim());
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (_) { continue; } }
    else if (v === 'null') v = null;
    kv[m[1]] = v;
  }
  const rev = typeof kv.spec_revision === 'string' && /^\d{1,6}$/.test(kv.spec_revision) ? Number(kv.spec_revision) : null;
  return {
    task: taskName(kv.task),
    builder: rec.enumOr(kv.builder, rec.BUILDERS),
    kind: rec.enumOr(kv.kind, rec.KINDS),
    reason: str(kv.reason, 400),
    fixes: taskName(kv.fixes),
    base_branch: str(kv.base_branch, 255),
    spec_revision: rev,
    created_at: iso(kv.created_at),
  };
}

/** Valid attempt filenames, newest (highest number) first, capped. @param {string[]} names */
function attemptNames(names) {
  /** @type {Array<{ name: string, n: number }>} */
  const ok = [];
  for (const name of names) {
    const m = ATTEMPT_FILE.exec(name);
    if (m && taskName(m[1])) ok.push({ name, n: Number(m[2]) });
  }
  ok.sort((a, b) => b.n - a.n || (a.name < b.name ? 1 : -1));
  return ok.slice(0, MAX_FILES).map((x) => x.name);
}

/**
 * Attempt filenames (`<task>-<n>.json`) for a repo, newest first, capped. Null when the
 * repo is refused or has no `.sereno`. Callers run this (or `guard`) before `recovery.decide`.
 * @param {string} root
 * @param {{ fsp?: typeof nodeFs.promises }} [opts]
 * @returns {Promise<string[] | null>}
 */
async function listAttempts(root, opts) {
  try {
    const fsp = (opts && opts.fsp) || nodeFs.promises;
    const g = await guardRepo(root, fsp);
    if (!g) return null;
    if (!g.attempts) return [];
    return attemptNames(await scan(path.join(root, '.sereno', 'attempts'), fsp));
  } catch (_) { return null; }
}

/**
 * @param {string} root
 * @param {{ fsp?: typeof nodeFs.promises }} [opts]
 * @returns {Promise<RepoRecords | null>} null when there is no `.sereno` or the repo is refused
 */
async function readRepo(root, opts) {
  try {
    const fsp = (opts && opts.fsp) || nodeFs.promises;
    const g = await guardRepo(root, fsp);
    if (!g) return null;
    const base = path.join(root, '.sereno');
    let skipped = 0;

    /** @type {any} */
    let cfg = null;
    try {
      if (!(await configFileOk(root, fsp))) throw new Error('config file refused');
      cfg = JSON.parse(JSON.stringify(config.loadConfig(root).config));
      if (isObj(cfg.tests)) { delete cfg.tests.command; delete cfg.tests.setup; }
    } catch (_) { cfg = null; skipped++; }

    /** @type {Map<string, { task: string, spec: any, attempts: any[], gates: any[] }>} */
    const tasks = new Map();
    const entry = (/** @type {string} */ t) => {
      let e = tasks.get(t);
      if (!e) { e = { task: t, spec: null, attempts: [], gates: [] }; tasks.set(t, e); }
      return e;
    };

    if (g.attempts) {
      const dir = path.join(base, 'attempts');
      for (const name of attemptNames(await scan(dir, fsp))) {
        const m = /** @type {RegExpExecArray} */ (ATTEMPT_FILE.exec(name));
        const r = await readBounded(path.join(dir, name), fsp);
        const j = r === 'bad' ? undefined : parseJson(r.text);
        if (!isObj(j) || j.task_id !== m[1] || j.attempt !== Number(m[2])) { skipped++; continue; }
        entry(m[1]).attempts.push(cleanAttempt(j, m[1], Number(m[2])));
      }
    }

    if (g.gates) {
      const dir = path.join(base, 'gates');
      const names = (await scan(dir, fsp)).filter((n) => n.endsWith('.json') && rec.RUN_ID.test(n.slice(0, -5)));
      names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      for (const name of names.slice(0, MAX_FILES)) {
        const runId = name.slice(0, -5);
        const r = await readBounded(path.join(dir, name), fsp);
        const j = r === 'bad' ? undefined : parseJson(r.text);
        const t = isObj(j) ? taskName(j.task_id) : null;
        if (!isObj(j) || !t || j.review_run_id !== runId) { skipped++; continue; }
        entry(t).gates.push(cleanGate(j, t, runId));
      }
    }

    if (g.specs) {
      const dir = path.join(base, 'specs');
      const names = (await scan(dir, fsp)).filter((n) => n.endsWith('.md') && taskName(n.slice(0, -3)));
      names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      for (const name of names.slice(0, MAX_FILES)) {
        const r = await readBounded(path.join(dir, name), fsp, SPEC_HEAD_BYTES);
        let sp = null;
        if (r !== 'bad') { try { sp = parseSpecHead(r.text); } catch (_) { sp = null; } }
        if (!sp) { skipped++; continue; }
        entry(name.slice(0, -3)).spec = sp;
      }
    }

    return { config: cfg, tasks: [...tasks.values()].sort((a, b) => (a.task < b.task ? -1 : 1)), skipped };
  } catch (_) { return null; }
}

/** True when the repo passes the guards (use before handing it to recovery.decide). @param {string} root */
async function guard(root) { return (await guardRepo(root, nodeFs.promises)) !== null; }

module.exports = { recovery, config, decide: recovery.decide, readRepo, listAttempts, guard };
