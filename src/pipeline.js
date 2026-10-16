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
const briefsLib = require('./briefs.js');

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
    let repoConfig = false;   // the effective config came from this repo's own pipeline.json, not the user-level default
    try {
      if (!(await configFileOk(root, fsp))) throw new Error('config file refused');
      const lc = config.loadConfig(root);
      repoConfig = lc.source === path.join(root, '.sereno', 'pipeline.json');
      cfg = JSON.parse(JSON.stringify(lc.config));
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

    return { config: cfg, repoConfig, tasks: [...tasks.values()].sort((a, b) => (a.task < b.task ? -1 : 1)), skipped };
  } catch (_) { return null; }
}

const EXPIRE_MS = 7 * 24 * 3600 * 1000;
/** Whether a task last touched at `updatedAt` has aged out at `now`. @param {number | null} updatedAt @param {number} now */
function isExpired(updatedAt, now) { return typeof updatedAt === 'number' && now - updatedAt > EXPIRE_MS; }
const NON_LOW = (/** @type {any} */ f) => f && f.severity !== 'low';

/**
 * The plugin's own spec hash (records.sha256 over the spec file's bytes, as
 * `sereno.js recovery` computes it), read with the reader's guards. Null on any problem.
 * @param {string} root @param {string} task @param {typeof nodeFs.promises} fsp
 * @returns {Promise<string | null>}
 */
async function specHashOf(root, task, fsp) {
  try {
    const file = path.join(root, '.sereno', 'specs', task + '.md');
    const st = await fsp.lstat(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > 1024 * 1024) return null;
    return rec.sha256(await fsp.readFile(file));
  } catch (_) { return null; }
}

/** @param {any} e @returns {string} */
function errCode(e) { return e && typeof e.code === 'string' && /^[a-z_]{2,40}$/.test(e.code) ? e.code : 'error'; }

/**
 * One task's stage, from the plugin's own `recovery.decide`. Never throws.
 * `git(args, cwd)` resolves to stdout and rejects on a non-zero exit (an error with `.code`).
 * @param {string} root main worktree root
 * @param {{ task: string, spec: any, attempts: any[], gates: any[] }} entry one item of readRepo().tasks
 * @param {any} cfg effective config from readRepo (tests.command/setup already dropped)
 * @param {(args: string[], cwd: string) => Promise<string>} git
 * @param {number} now
 * @param {{ fsp?: typeof nodeFs.promises }} [opts]
 */
async function taskView(root, entry, cfg, git, now, opts) {
  const fsp = (opts && opts.fsp) || nodeFs.promises;
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : [];
  const gates = Array.isArray(entry.gates) ? entry.gates : [];
  const spec = entry.spec || null;
  const latest = attempts.length ? attempts[0] : null;   // reader sorts newest first
  const byRun = latest && latest.review_run_id ? gates.find((g) => g.review_run_id === latest.review_run_id) : null;
  let gate = byRun || gates[0] || null;
  let findings = gate ? gate.findings : [];

  /** @type {number[]} */
  const stamps = [];
  const push = (/** @type {any} */ v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; if (Number.isFinite(t)) stamps.push(t); };
  for (const a of attempts) { push(a.started_at); push(a.ended_at); }
  for (const g of gates) push(g.reviewed_at);
  const starts = attempts.map((a) => Date.parse(a.started_at)).filter(Number.isFinite);
  if (!stamps.length && spec) push(spec.created_at);
  const startedAt = starts.length ? Math.min(...starts) : (stamps.length ? Math.min(...stamps) : null);
  const updatedAt = stamps.length ? Math.max(...stamps) : null;
  const expired = isExpired(updatedAt, now);

  const view = (/** @type {string} */ stage, /** @type {string} */ step, /** @type {string | null} */ reason, /** @type {number | null} */ attempt) =>
    ({ task: entry.task, stage, step, reason, attempt, gate, findings, startedAt, updatedAt, reviewRuns: gates.length, expired });

  try {
    if (!attempts.length) return view('architect', 'Spec written', null, null);
    if (!cfg || !isObj(cfg.recovery) || !isObj(cfg.roles) || !isObj(cfg.roles.redTeam)) return view('unknown', 'Status unavailable', 'config_unavailable', latest.attempt);

    // A running attempt is a Builder working right now (recovery.decide would call it unfinished,
    // which is right only after the Builder has returned). Never a decision.
    if (latest.outcome === 'running') {
      const prev = attempts[1];
      if (prev && prev.outcome === 'block') {
        const pg = (prev.review_run_id && gates.find((g) => g.review_run_id === prev.review_run_id)) || gates[0] || null;
        if (pg) {
          gate = pg; findings = pg.findings;
          const c = findings.filter(NON_LOW).length;
          return view('builder', 'Fixing ' + c + ' finding' + (c === 1 ? '' : 's'), null, latest.attempt);
        }
      }
      return view('builder', 'Building', null, latest.attempt);
    }

    // Merged: the reviewed commit is already in the spec's base branch.
    // Only a gate that belongs to the latest attempt (or a latest attempt that passed/skipped) can
    // say "merged"; a task re-opened under the same name after a merge has a fresh built attempt.
    const gateIsLatest = !!byRun || latest.outcome === 'pass' || latest.outcome === 'skipped';
    const head = gateIsLatest && gate && gate.head_commit;
    const base = spec && spec.base_branch;
    if (head && base && briefsLib.validBranchName(base)) {
      try { await git(['merge-base', '--is-ancestor', head, 'refs/heads/' + base], root); return view('merged', 'Merged', null, latest.attempt); }
      catch (e) {
        // 1: not an ancestor. 128: the commit is not in this repo (pruned, other clone): not merged.
        const c = e && /** @type {any} */ (e).code;
        if (c !== 1 && c !== 128) throw e;
      }
    }

    const names = await listAttempts(root, { fsp });
    if (!names) return view('unknown', 'Status unavailable', 'repo_refused', latest.attempt);
    // Only a latest attempt that says pass/skipped reaches recovery's merge guard.
    const guarded = latest.outcome === 'pass' || latest.outcome === 'skipped';
    const tip = !guarded ? null : await git(['rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/task/' + entry.task + '^{commit}'], root)
      .then((o) => { const t = o.trim(); return /^[0-9a-f]{40}$/.test(t) ? t : null; }, (e) => { if (e && /** @type {any} */ (e).code === 1) return null; throw e; });
    const specHash = guarded ? await specHashOf(root, entry.task, fsp) : null;

    const d = recovery.decide({
      root, task: entry.task, config: cfg,
      listAttempts: () => names,
      currentHead: () => tip,
      currentSpecHash: () => specHash,
    });
    const reason = typeof d.reason === 'string' ? d.reason : null;
    const n = typeof d.attempt === 'number' ? d.attempt : latest.attempt;
    switch (d.next) {
      case 'retry': return view('builder', 'Retrying after an environment failure', reason, n);
      case 'repair': {
        const c = findings.filter(NON_LOW).length;
        return view('builder', 'Fixing ' + c + ' finding' + (c === 1 ? '' : 's'), reason, n);
      }
      case 'review': return view('red-team', 'In review', reason, n);
      case 'decide': return view('decision', 'Needs a decision', reason, n);
      case 'merge': return view('ready', 'Ready: run /sereno:merge', reason, n);
      case 'done': return view('stopped', 'Stopped', reason, n);
      default: return view('unknown', 'Status unavailable', 'unknown_next', n);
    }
  } catch (e) {
    return view('unknown', 'Status unavailable', errCode(e), latest ? latest.attempt : null);
  }
}

/** True when the repo passes the guards (use before handing it to recovery.decide). @param {string} root */
async function guard(root) { return (await guardRepo(root, nodeFs.promises)) !== null; }

/* ---- Step 3: roles, signals, red-team $/merge ---- */

const DAY_MS = 24 * 3600 * 1000;
const SIGNAL_DAYS = 30;
const WEEK_DAYS = 7;
const ROLE_MAP = Object.freeze({
  'sereno:builder': 'builder', 'sereno:builder-haiku': 'builder', 'sereno:builder-opus': 'builder',
  'sereno:red-team': 'red-team', 'sereno:red-team-lean': 'red-team',
  'sereno:scribe': 'scribe',
});
const AGENT_HEAD_BYTES = 4096;
const MAX_AGENT_FILES = 50;
const AGENTS_DIR = path.join(__dirname, '..', 'plugin', 'agents');
const SKILLS_DIR = path.join(__dirname, '..', 'plugin', 'skills');

/** agent_type -> role (a fresh copy). @returns {Record<string, string>} */
function roleMap() { return Object.assign({}, ROLE_MAP); }

/** Bounded head of a plugin file; links and non-files read as empty. @param {string} file @returns {string} */
function headOf(file) {
  const st = nodeFs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) return '';
  const fd = nodeFs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(AGENT_HEAD_BYTES);
    return buf.toString('utf8', 0, nodeFs.readSync(fd, buf, 0, AGENT_HEAD_BYTES, 0));
  } finally { nodeFs.closeSync(fd); }
}

/** `name:` and `model:` from an agent file's front matter, or null. @param {string} text @returns {{ name: string, model: string } | null} */
function parseAgent(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  let name = null, model = null;
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = /^(name|model):\s*(\S+)\s*$/.exec(lines[i]);
    if (m && m[1] === 'name' && name === null) name = m[2];
    else if (m && m[1] === 'model' && model === null) model = m[2];
  }
  return name && model && idStr(model) ? { name, model } : null;
}

/**
 * The bundled agents and the model each runs on, for the routing view: one entry per
 * agent file whose name maps to a role. Same bounded reads as inferModels. Never throws.
 * @param {string} [dir] defaults to the bundled plugin/agents
 * @returns {Array<{ agent: string, role: string, model: string }>}
 */
function agentModels(dir) {
  const d = dir || AGENTS_DIR;
  /** @type {Array<{ agent: string, role: string, model: string }>} */
  const out = [];
  try {
    for (const n of nodeFs.readdirSync(d).filter((x) => x.endsWith('.md')).sort().slice(0, MAX_AGENT_FILES)) {
      try {
        const a = parseAgent(headOf(path.join(d, n)));
        const role = a ? ROLE_MAP['sereno:' + a.name] : null;
        if (a && role) out.push({ agent: 'sereno:' + a.name, role, model: a.model });
      } catch (_) { /* skip this file */ }
    }
  } catch (_) { /* no directory */ }
  return out;
}

/** @type {Map<string, Record<string, string>>} */
const inferCache = new Map();

/**
 * model -> role for models that exactly one role uses, computed from the bundled agent
 * files' `name:` and `model:` front matter and the skills' `model:` (the orchestration
 * role: the main-thread commands run on it). A model also used by orchestration, or by
 * two agent roles, never infers. Bounded reads, no links, cached per directory pair.
 * Never throws; an unreadable directory contributes nothing.
 * @param {string} [dir] defaults to the bundled plugin/agents
 * @param {string | null} [skillsDir] defaults to the bundled plugin/skills (only with the default agents dir)
 * @returns {Record<string, string>}
 */
function inferModels(dir, skillsDir) {
  const d = dir || AGENTS_DIR;
  const sd = skillsDir !== undefined ? skillsDir : (dir ? null : SKILLS_DIR);
  const key = d + '|' + (sd || '');
  const hit = inferCache.get(key);
  if (hit) return Object.assign({}, hit);
  /** @type {Map<string, Set<string>>} */
  const byModel = new Map();
  const head = headOf;
  const addRole = (/** @type {string} */ model, /** @type {string} */ role) => {
    let set = byModel.get(model);
    if (!set) { set = new Set(); byModel.set(model, set); }
    set.add(role);
  };
  if (sd) {
    try {
      for (const n of nodeFs.readdirSync(sd).sort().slice(0, MAX_AGENT_FILES)) {
        try {
          const lines = head(path.join(sd, n, 'SKILL.md')).replace(/^﻿/, '').split(/\r?\n/);
          if (lines[0].trim() !== '---') continue;
          for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
            const m = /^model:\s*(\S+)\s*$/.exec(lines[i]);
            if (m && idStr(m[1])) { addRole(m[1], 'orchestration'); break; }
          }
        } catch (_) { /* skip this skill */ }
      }
    } catch (_) { /* no skills directory */ }
  }
  try {
    const names = nodeFs.readdirSync(d).filter((n) => n.endsWith('.md')).sort().slice(0, MAX_AGENT_FILES);
    for (const n of names) {
      try {
        const ag = parseAgent(head(path.join(d, n)));
        const role = ag ? ROLE_MAP['sereno:' + ag.name] : null;
        if (!ag || !role) continue;
        addRole(ag.model, role);
      } catch (_) { /* skip this file */ }
    }
  } catch (_) { /* no directory */ }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [model, roles] of byModel) if (roles.size === 1 && !roles.has('orchestration')) out[model] = [...roles][0];
  inferCache.set(key, out);
  return Object.assign({}, out);
}

/** @param {number[]} xs sorted ascending @returns {number} */
function median(xs) { const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; }

/**
 * Pipeline signals over a fixed 30 days. A project is
 * `{ id, tasks: [{ task, stage, gates }] }` where `gates` are the reader's cleaned gate
 * records for that task (the task view alone does not carry every run).
 * @param {Array<{ id?: string, tasks?: Array<{ task: string, stage?: string, gates?: any[] }> }>} projects
 * @param {number} now
 */
function signals(projects, now) {
  const since = now - SIGNAL_DAYS * DAY_MS;
  const week = now - WEEK_DAYS * DAY_MS;
  const outcomes = { pass: 0, block: 0, needs_context: 0, error: 0, skipped: 0 };
  /** @type {Record<string, number>} */
  const counts = outcomes;
  let n = 0, runsThisWeek = 0, noPass = 0;
  /** @type {number[]} */
  const rework = [];
  const perProject = [];
  for (const p of Array.isArray(projects) ? projects : []) {
    /** @type {{ outcome: string, task: string, at: number } | null} */
    let latest = null;
    for (const t of (p && Array.isArray(p.tasks) ? p.tasks : [])) {
      /** @type {Array<{ outcome: string, at: number }>} */
      const runs = [];
      for (const g of (Array.isArray(t.gates) ? t.gates : [])) {
        const at = g && typeof g.reviewed_at === 'string' ? Date.parse(g.reviewed_at) : NaN;
        if (!Number.isFinite(at) || at < since || at > now || typeof g.outcome !== 'string') continue;
        runs.push({ outcome: g.outcome, at });
        n++;
        if (Object.prototype.hasOwnProperty.call(counts, g.outcome)) counts[g.outcome]++;
        if (at >= week) runsThisWeek++;
        if (!latest || at > latest.at) latest = { outcome: g.outcome, task: t.task, at };
      }
      if (!runs.length) continue;
      runs.sort((a, b) => a.at - b.at);
      const first = runs.findIndex((r) => r.outcome === 'pass');
      if (first < 0) noPass++; else rework.push(first);
    }
    perProject.push({ id: p && typeof p.id === 'string' ? p.id : null, gate: latest ? { outcome: latest.outcome, task: latest.task, ageMs: Math.max(0, now - latest.at) } : null });
  }
  rework.sort((a, b) => a - b);
  return {
    days: SIGNAL_DAYS,
    projects: perProject,
    outcomes: Object.assign({ n }, outcomes),
    rework: { n: rework.length, median: rework.length ? median(rework) : null, max: rework.length ? rework[rework.length - 1] : null, excluded: noPass },
    runsThisWeek,
  };
}

/**
 * Red-team spend per merge (USD, an estimate): for each pass gate of a merged task, the
 * ledger spend of the gate's own session and agent. Gates without a session or agent id
 * are excluded and counted. With no ledger (spend history off) nothing is measured.
 * @param {Array<{ tasks?: Array<{ task: string, stage?: string, gates?: any[] }> }>} projects
 * @param {((sessionId: string, agentId: string) => number) | null | undefined} spendForAgent
 * @returns {{ mean: number | null, n: number, excluded: number }}
 */
function redTeamPerMerge(projects, spendForAgent) {
  let sum = 0, n = 0, excluded = 0;
  for (const p of Array.isArray(projects) ? projects : []) {
    for (const t of (p && Array.isArray(p.tasks) ? p.tasks : [])) {
      if (t.stage !== 'merged') continue;
      for (const g of (Array.isArray(t.gates) ? t.gates : [])) {
        if (!g || g.outcome !== 'pass') continue;
        if (!g.agent_id || !g.session_id || typeof spendForAgent !== 'function') { excluded++; continue; }
        try {
          // 0 means no ledger rows carry this agent_id (spans off): unmeasured, not free.
          const c = Number(spendForAgent(g.session_id, g.agent_id)) || 0;
          if (c > 0) { sum += c; n++; } else excluded++;
        } catch (_) { excluded++; }
      }
    }
  }
  return { mean: n ? sum / n : null, n, excluded };
}

module.exports = { roleMap, inferModels, agentModels, signals, redTeamPerMerge, recovery, config, decide: recovery.decide, readRepo, listAttempts, guard, taskView, isExpired };
