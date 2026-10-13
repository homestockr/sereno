#!/usr/bin/env node
// @ts-check
'use strict';
/*
 * sereno.js: the deterministic half of the Sereno pipeline plugin.
 *
 *   node sereno.js <subcommand> [--json] ...
 *
 * Every subcommand prints exactly one JSON object on stdout:
 *   success  { "ok": true, ... }                     exit 0
 *   failure  { "ok": false, "error", "code", ... }   exit non-zero
 * Nothing else is written to stdout. Node built-ins only. The only files it
 * writes are under <repo>/.sereno/, through lib/fsafe.js.
 *
 * Subcommands: config, run-id, gate, attempt, paths, test, spec, branch, clean, context, recovery, brief, doctor.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SerenoError, createSafeFs } = require('./lib/fsafe.js');
const gitlib = require('./lib/git.js');
const { loadConfig, inertKeys } = require('./lib/config.js');
const rec = require('./lib/records.js');
const testrun = require('./lib/testrun.js');
const speclib = require('./lib/spec.js');
const contextlib = require('./lib/context.js');
const recovery = require('./lib/recovery.js');
const briefLib = require('./lib/brief.js');
const doctorLib = require('./lib/doctor.js');
const { projectId } = require('./lib/projectid.js');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/** The model: id from an agent definition's front matter, or null. @param {string} name */
function agentModel(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new SerenoError('invalid_arg', '--agent-name has an invalid format');
  let text;
  try { text = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf8'); } catch (_e) { throw new SerenoError('invalid_arg', 'no such plugin agent: ' + name); }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m = fm && /^model:\s*(\S+)\s*$/m.exec(fm[1]);
  return m ? m[1] : null;
}

const EXIT = { usage: 2, config_invalid: 3, invalid_arg: 4, not_a_repo: 5, path_refused: 6, exists: 7, head_mismatch: 8, no_test_command: 9, worktree_failed: 10, dirty_tree: 11, spec_changed: 17, spec_required: 18, task_required: 19, record_final: 12, not_found: 13, version_conflict: 14, detached_head: 15, branch_mismatch: 16, interrupted: 130 };
const MAX_INPUT = 1024 * 1024;

/**
 * @param {string[]} argv
 * @param {{ value: string[], bool: string[] }} spec
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv, spec) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new SerenoError('usage', 'unexpected argument: ' + a.slice(0, 60));
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (spec.bool.includes(name) && eq < 0) { out[name] = true; continue; }
    if (!spec.value.includes(name)) throw new SerenoError('usage', 'unknown flag: --' + name.slice(0, 40));
    if (eq > 0) { out[name] = a.slice(eq + 1); continue; }
    if (i + 1 >= argv.length) throw new SerenoError('usage', '--' + name + ' needs a value');
    i++;
    out[name] = argv[i];
  }
  return out;
}

/** @param {Record<string, string | boolean>} a @param {string} k @returns {string | undefined} */
const str = (a, k) => (typeof a[k] === 'string' ? /** @type {string} */ (a[k]) : undefined);

/** @returns {{ root: string, fsafe: ReturnType<typeof createSafeFs> }} */
function needRepo() {
  const top = gitlib.toplevel(process.cwd());
  if (!top) throw new SerenoError('not_a_repo', 'not inside a git repository');
  const root = fs.realpathSync.native(path.resolve(top));
  return { root, fsafe: createSafeFs(root) };
}

/** Free text from flags: cleaned, capped, or null. */
const flagText = (/** @type {string | undefined} */ v, /** @type {number} */ max) => (v === undefined ? null : (rec.cleanText(v, max) || null));

/** @param {string} v @param {string} what @param {RegExp} re */
function matchId(v, what, re) {
  if (!re.test(v)) throw new SerenoError('invalid_arg', what + ' has an invalid format');
  return v;
}

/** @param {string | undefined} v @param {string} what @returns {string | null} ISO string */
function isoOrNull(v, what) {
  if (v === undefined) return null;
  const d = v === 'now' ? new Date() : new Date(v);
  if (isNaN(d.getTime())) throw new SerenoError('invalid_arg', what + ' is not a valid timestamp');
  return d.toISOString();
}

/** Read the verdict: JSON, or the first fenced block when the agent wrapped it. @param {string} text */
function parseVerdict(text) {
  try { return JSON.parse(text); } catch (_e) { /* try a fenced block */ }
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (m) { try { return JSON.parse(m[1]); } catch (_e) { /* fall through */ } }
  throw new SerenoError('invalid_arg', 'verdict is not valid JSON');
}

/** @param {string} file */
function readCapped(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new SerenoError('invalid_arg', 'not a regular file');
  if (st.size > MAX_INPUT) throw new SerenoError('invalid_arg', 'input larger than 1 MB');
  return fs.readFileSync(file);
}

/** @param {string} root @param {string} specArg @returns {{ rel: string, hash: string }} */
function readSpec(root, specArg) {
  const rel = rec.repoRelative(specArg);
  if (!rel) throw new SerenoError('path_refused', 'spec must be a path inside the repository');
  const abs = path.join(root, rel);
  let real;
  try { real = fs.realpathSync.native(abs); } catch (_e) { throw new SerenoError('invalid_arg', 'spec file not found: ' + rel); }
  const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!fold(real).startsWith(fold(root + path.sep))) throw new SerenoError('path_refused', 'spec resolves outside the repository');
  return { rel, hash: rec.sha256(readCapped(real)) };
}

/** @param {string} task */
function attemptRe(task) { return new RegExp('^' + task.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '-(\\d+)\\.json$'); }

/**
 * The newest attempt of the task that carries a spec_hash key (set when /sereno:build
 * opened it). A malformed value is returned as-is, so callers can refuse it.
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task
 * @returns {{ n: number, hash: unknown } | null}
 */
function newestPin(root, fsafe, task) {
  const re = attemptRe(task);
  const nums = [];
  for (const f of fsafe.listDir('.sereno/attempts')) { const m = re.exec(f); if (m) nums[nums.length] = parseInt(m[1], 10); }
  nums.sort((x, y) => y - x);
  for (const n of nums) {
    let j;
    try {
      const file = path.join(root, '.sereno', 'attempts', task + '-' + n + '.json');
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_INPUT) continue;
      j = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) { continue; }
    if (j && typeof j === 'object' && j.spec_hash !== undefined && j.spec_hash !== null) return { n, hash: j.spec_hash };
  }
  return null;
}

/**
 * If the newest pinned attempt's spec hash differs from the spec on disk, refuse. A task
 * with no pinned attempt pins nothing. A malformed pin is refused, never passed.
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {string} specArg
 * @returns {string | null}
 */
function checkSpecPin(root, fsafe, task, specArg) {
  const pin = newestPin(root, fsafe, task);
  if (!pin) return null;
  if (typeof pin.hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(pin.hash)) throw new SerenoError('spec_changed', 'attempt ' + pin.n + ' has a malformed spec_hash; re-run the build');
  const now = readSpec(root, specArg).hash;
  if (now !== pin.hash) throw new SerenoError('spec_changed', 'the spec changed since /sereno:build opened attempt ' + pin.n + '; re-run the build (or restore the spec)');
  return pin.hash;
}

/**
 * Without --task, refuse when the current branch is task/<name> and the repo has attempt
 * records for that task: the spec pin must not be skippable by leaving the flag out.
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe
 */
function requireTaskIfRecorded(root, fsafe) {
  const branch = gitlib.currentBranch(root);
  const m = branch && /^task\/(.+)$/.exec(branch);
  if (!m) return;
  let t;
  try { t = rec.checkTask(m[1]); } catch (_e) { return; }
  const re = attemptRe(t);
  if (fsafe.listDir('.sereno/attempts').some((f) => re.test(f))) throw new SerenoError('task_required', 'this branch has attempt records for task ' + t + '; pass --task ' + t);
}

/**
 * On a task/<x> branch, --task must be <x>.
 * @param {string} root @param {string | undefined} task
 */
function checkTaskBranch(root, task) {
  if (task === undefined) return;
  const branch = gitlib.currentBranch(root); // the checked-out branch, whatever --branch says
  const m = branch && /^task\/(.+)$/.exec(branch);
  if (m && m[1] !== task) throw new SerenoError('branch_mismatch', 'this branch is task/' + m[1] + '; --task must be ' + m[1] + ', not ' + task);
}

const COMMANDS = {
  config(/** @type {string[]} */ argv) {
    parseArgs(argv, { value: [], bool: ['json'] });
    const top = gitlib.toplevel(process.cwd());
    const { config, config_hash, source } = loadConfig(top ? fs.realpathSync.native(path.resolve(top)) : null);
    return { config, config_hash, source, inert: inertKeys(config) };
  },

  'run-id'(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['head'], bool: ['json'] });
    const head = str(a, 'head');
    if (!head || !gitlib.isSha(head)) throw new SerenoError('invalid_arg', '--head must be a commit sha (7-40 hex)');
    return { review_run_id: rec.makeRunId(head) };
  },

  gate(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, {
      value: ['file', 'task', 'spec', 'base', 'head', 'branch', 'session', 'agent', 'agent-name', 'model', 'tests-passed', 'run-id'],
      bool: ['json', 'stdin'],
    });
    if (!!a.file === !!a.stdin) throw new SerenoError('usage', 'give exactly one of --file or --stdin');
    const { root, fsafe } = needRepo();
    if (str(a, 'task') === undefined) requireTaskIfRecorded(root, fsafe);
    const task = rec.checkTask(str(a, 'task'));
    checkTaskBranch(root, task);
    const base = gitlib.resolveCommit(root, str(a, 'base') || '');
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!base) throw new SerenoError('invalid_arg', '--base must name an existing commit');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    const branchArg = str(a, 'branch');
    if (branchArg !== undefined && !gitlib.isRefName(branchArg)) throw new SerenoError('invalid_arg', '--branch is not a valid branch name');
    const branch = branchArg || gitlib.currentBranch(root);
    if (!branch) throw new SerenoError('invalid_arg', 'no branch: HEAD is detached and --branch was not given');
    const specArg = str(a, 'spec') || '.sereno/specs/' + task + '.md';
    const spec = readSpec(root, specArg);
    const pinned = checkSpecPin(root, fsafe, task, specArg);
    if (pinned) spec.hash = pinned;
    const tp = str(a, 'tests-passed');
    if (tp !== undefined && tp !== 'true' && tp !== 'false') throw new SerenoError('invalid_arg', '--tests-passed must be true or false');
    const id = /^[A-Za-z0-9._:-]{1,128}$/;
    const agent = str(a, 'agent');
    // The skill passes "${CLAUDE_SESSION_ID}"; empty or unsubstituted means unknown, and a
    // value that is not a plain id is dropped rather than stored.
    const sessRaw = str(a, 'session');
    const session = sessRaw !== undefined && !sessRaw.includes('${') && /^[A-Za-z0-9-]{8,64}$/.test(sessRaw) ? sessRaw : undefined;
    const agentName = str(a, 'agent-name');
    // --model wins; otherwise the model: front matter of plugin/agents/<agent-name>.md.
    const model = str(a, 'model') !== undefined ? str(a, 'model') : (agentName !== undefined ? agentModel(agentName) : undefined);
    const runId = str(a, 'run-id') || rec.makeRunId(head);
    if (!rec.RUN_ID.test(runId)) throw new SerenoError('invalid_arg', '--run-id has an invalid format');

    const text = a.stdin ? readStdin() : readCapped(/** @type {string} */ (a.file)).toString('utf8');
    const v = rec.sanitizeVerdict(parseVerdict(text));
    const { config_hash } = loadConfig(root);

    const gate = {
      review_run_id: runId,
      task_id: task,
      spec: spec.rel,
      spec_hash: spec.hash,
      branch,
      base_commit: base,
      head_commit: head,
      session_id: session === undefined ? null : matchId(session, '--session', id),
      agent_id: agent === undefined ? null : matchId(agent, '--agent', id),
      model: model === undefined || model === null ? null : matchId(model, '--model', id),
      outcome: v.outcome,
      tests_passed: tp === 'true',
      findings: v.findings,
      context_requests: v.context_requests,
      reviewed_at: new Date().toISOString(),
      config_hash,
    };
    const rel = '.sereno/gates/' + runId + '.json';
    fsafe.writeJson(rel, gate);
    return { path: rel, review_run_id: runId, outcome: gate.outcome, findings: gate.findings.length, tests_passed: gate.tests_passed };
  },

  attempt(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, {
      value: ['task', 'project', 'spec-revision', 'builder', 'agent', 'kind', 'fixes', 'diagnosis', 'outcome', 'review-run-id', 'started-at', 'ended-at', 'update', 'agent-id', 'spec', 'spec-hash'],
      bool: ['json'],
    });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    checkTaskBranch(root, task);
    if (a.update !== undefined) return updateAttempt(root, fsafe, task, a);
    const { config_hash } = loadConfig(root);
    const fixes = str(a, 'fixes');
    const rr = str(a, 'review-run-id');
    if (rr !== undefined && !rec.RUN_ID.test(rr)) throw new SerenoError('invalid_arg', '--review-run-id has an invalid format');
    const revArg = str(a, 'spec-revision');
    if (revArg !== undefined && !/^[1-9]\d{0,5}$/.test(revArg)) throw new SerenoError('invalid_arg', '--spec-revision must be a positive integer');
    const shArg = str(a, 'spec-hash');
    if (shArg !== undefined && !/^sha256:[0-9a-f]{64}$/.test(shArg)) throw new SerenoError('invalid_arg', '--spec-hash must be sha256:<64 hex>');
    if (shArg !== undefined && str(a, 'spec') !== undefined) throw new SerenoError('usage', 'give --spec or --spec-hash, not both');
    const specHash = shArg !== undefined ? shArg : (str(a, 'spec') !== undefined ? readSpec(root, /** @type {string} */ (str(a, 'spec'))).hash : null);
    if (specHash === null && newestPin(root, fsafe, task)) throw new SerenoError('spec_required', 'an earlier attempt of this task pinned a spec; pass --spec .sereno/specs/' + task + '.md');
    const agent = str(a, 'agent') !== undefined ? str(a, 'agent') : str(a, 'agent-id');
    if (agent !== undefined) matchId(agent, '--agent', /^[A-Za-z0-9._:-]{1,128}$/);

    const re = attemptRe(task);
    const existing = fsafe.listDir('.sereno/attempts');
    let n = 1;
    for (const f of existing) {
      const m = re.exec(f);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    }
    const record = {
      // Same id the app derives for this repo (sha1 of the normalised root, 12 hex); --project overrides.
      project_id: flagText(str(a, 'project'), 128) || projectId(root),
      task_id: task,
      spec_revision: revArg === undefined ? 1 : parseInt(revArg, 10),
      attempt: 0,
      builder_requested: rec.enumOr(str(a, 'builder'), rec.BUILDERS),
      agent_id: agent === undefined ? null : agent,
      config_hash,
      kind: rec.enumOr(str(a, 'kind'), rec.KINDS),
      fixes: fixes === undefined ? null : rec.checkTask(fixes),
      diagnosis: rec.enumOr(str(a, 'diagnosis') || 'none', rec.DIAGNOSES),
      outcome: rec.enumOr(str(a, 'outcome'), rec.ATTEMPT_OUTCOMES),
      review_run_id: rr === undefined ? null : rr,
      started_at: isoOrNull(str(a, 'started-at'), '--started-at'),
      ended_at: isoOrNull(str(a, 'ended-at'), '--ended-at'),
    };
    // Exclusive create: if two writers race for the same number, the loser takes the next one.
    if (specHash !== null) /** @type {any} */ (record).spec_hash = specHash;
    for (let tries = 0; tries < 20; tries++, n++) {
      record.attempt = n;
      const rel = '.sereno/attempts/' + task + '-' + n + '.json';
      try {
        fsafe.writeJson(rel, record, { exclusive: true });
        return { path: rel, attempt: n, task_id: task };
      } catch (e) {
        if (!(e instanceof SerenoError) || e.code !== 'exists') throw e;
      }
    }
    throw new SerenoError('exists', 'could not allocate an attempt number');
  },

  async test(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['base', 'head', 'task', 'spec'], bool: ['json'] });
    const { root, fsafe } = needRepo();
    if (str(a, 'task') !== undefined) {
      const t = rec.checkTask(str(a, 'task'));
      checkTaskBranch(root, t);
      checkSpecPin(root, fsafe, t, str(a, 'spec') || '.sereno/specs/' + t + '.md');
    } else requireTaskIfRecorded(root, fsafe);
    testrun.sweepStale(root);
    const base = gitlib.resolveCommit(root, str(a, 'base') || '');
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!base) throw new SerenoError('invalid_arg', '--base must name an existing commit');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    const { config, config_hash } = loadConfig(root);
    return await testrun.runTests({ root, fsafe, config, configHash: config_hash, base, head, runId: rec.makeRunId(head) });
  },

  spec(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task', 'builder', 'kind', 'reason', 'fixes', 'base-branch'], bool: ['json', 'stdin'] });
    if (!a.stdin) throw new SerenoError('usage', 'the acceptance criteria come on stdin: pass --stdin');
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    return speclib.writeSpec({ root, fsafe, task, builder: str(a, 'builder'), kind: str(a, 'kind'), reason: str(a, 'reason'), fixes: str(a, 'fixes'), baseBranch: str(a, 'base-branch'), body: readStdin() });
  },

  branch(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root } = needRepo();
    return speclib.createTaskBranch({ root, task });
  },

  clean(/** @type {string[]} */ argv) {
    parseArgs(argv, { value: [], bool: ['json'] });
    const { root } = needRepo();
    const files = gitlib.cleanFiles(root);
    if (files === null) throw new SerenoError('invalid_arg', 'could not read the working tree status');
    return { clean: files.length === 0, files: files.slice(0, 50) };
  },

  context(/** @type {string[]} */ argv) {
    // Positional file names follow the flags; flags are parsed first.
    /** @type {string[]} */ const flags = [];
    /** @type {string[]} */ const files = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--head') { flags[flags.length] = argv[i]; flags[flags.length] = argv[i + 1] === undefined ? '' : argv[++i]; }
      else if (argv[i].startsWith('--head=') || argv[i] === '--json') flags[flags.length] = argv[i];
      else files[files.length] = argv[i];
    }
    const a = parseArgs(flags, { value: ['head'], bool: ['json'] });
    const { root } = needRepo();
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    const r = contextlib.readContext({ root, head, files });
    return { head, files: r.files, missing: r.missing };
  },

  recovery(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    const { config } = loadConfig(root);
    return recovery.decide({ root, task, config, listAttempts: () => fsafe.listDir('.sereno/attempts') });
  },

  brief(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['branch', 'now', 'next', 'blocked', 'task', 'expect-version'], bool: ['json'] });
    const branch = str(a, 'branch'), now = str(a, 'now'), next = str(a, 'next');
    if (branch === undefined || now === undefined || next === undefined) throw new SerenoError('usage', 'brief needs --branch, --now, --next and --blocked');
    const ev = str(a, 'expect-version');
    if (ev !== undefined && !/^\d{1,9}$/.test(ev)) throw new SerenoError('invalid_arg', '--expect-version must be a non-negative integer');
    const { root, fsafe } = needRepo();
    return briefLib.writeBrief({ root, fsafe, branch, now, next, blocked: str(a, 'blocked') || '', task: str(a, 'task'), expectVersion: ev === undefined ? undefined : Number(ev) });
  },

  doctor(/** @type {string[]} */ argv) {
    parseArgs(argv, { value: [], bool: ['json'] });
    return doctorLib.runDoctor(process.cwd());
  },

  paths(/** @type {string[]} */ argv) {
    parseArgs(argv, { value: [], bool: ['json'] });
    const top = gitlib.toplevel(process.cwd());
    const root = top ? fs.realpathSync.native(path.resolve(top)) : null;
    const home = path.join(os.homedir(), '.sereno');
    return {
      repo_root: root,
      sereno_dir: root && path.join(root, '.sereno'),
      layout: {
        pipeline: '.sereno/pipeline.json',
        specs: '.sereno/specs/<task>.md',
        gates: '.sereno/gates/<review_run_id>.json',
        attempts: '.sereno/attempts/<task>-<n>.json',
        briefs: '.sereno/briefs/<branch>.md',
      },
      user_config: path.join(home, 'pipeline.json'),
    };
  },
};

/**
 * attempt --update <n>: merge outcome, diagnosis, review run id and end time into
 * an existing record. A record whose outcome is final is never changed.
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {Record<string, string | boolean>} a
 */
function updateAttempt(root, fsafe, task, a) {
  for (const k of ['spec', 'spec-hash', 'project', 'spec-revision', 'builder', 'agent', 'kind', 'fixes', 'started-at']) {
    if (a[k] !== undefined) throw new SerenoError('usage', '--' + k + ' cannot be combined with --update');
  }
  const nArg = str(a, 'update');
  if (nArg === undefined || !/^[1-9]\d{0,5}$/.test(nArg)) throw new SerenoError('invalid_arg', '--update must be an attempt number');
  const rel = '.sereno/attempts/' + task + '-' + nArg + '.json';
  let record;
  try {
    const file = path.join(root, rel);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_INPUT) throw new Error('not a regular file');
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) { throw new SerenoError('not_found', 'no attempt record ' + rel); }
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new SerenoError('not_found', 'attempt record is not an object');
  if (rec.FINAL_OUTCOMES.includes(record.outcome)) throw new SerenoError('record_final', 'attempt ' + nArg + ' is already final (' + record.outcome + ')');
  const outcome = str(a, 'outcome'), diagnosis = str(a, 'diagnosis'), rr = str(a, 'review-run-id'), ended = str(a, 'ended-at');
  if (outcome !== undefined) {
    const v = rec.enumOr(outcome, rec.ATTEMPT_OUTCOMES);
    if (v === 'unknown') throw new SerenoError('invalid_arg', '--outcome must be one of: ' + rec.ATTEMPT_OUTCOMES.join(', '));
    record.outcome = v;
  }
  if (diagnosis !== undefined) {
    const v = rec.enumOr(diagnosis, rec.DIAGNOSES);
    if (v === 'unknown') throw new SerenoError('invalid_arg', '--diagnosis must be one of: ' + rec.DIAGNOSES.join(', '));
    record.diagnosis = v;
  }
  if (rr !== undefined) {
    if (!rec.RUN_ID.test(rr)) throw new SerenoError('invalid_arg', '--review-run-id has an invalid format');
    record.review_run_id = rr;
  }
  const agentId = str(a, 'agent-id');
  if (agentId !== undefined) record.agent_id = matchId(agentId, '--agent-id', /^[A-Za-z0-9._:-]{1,128}$/);
  if (ended !== undefined) record.ended_at = isoOrNull(ended, '--ended-at');
  fsafe.writeJson(rel, record);
  return { path: rel, attempt: parseInt(nArg, 10), task_id: task, outcome: record.outcome, diagnosis: record.diagnosis };
}

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let total = 0;
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); }
    catch (e) { if (/** @type {any} */ (e).code === 'EOF') break; if (/** @type {any} */ (e).code === 'EAGAIN') continue; throw e; }
    if (!n) break;
    total += n;
    if (total > MAX_INPUT) throw new SerenoError('invalid_arg', 'stdin larger than 1 MB');
    chunks.splice(chunks.length, 0, Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {unknown} obj @param {number} code */
function finish(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n', () => process.exit(code));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (!cmd || !Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) {
      throw new SerenoError('usage', 'usage: sereno.js <' + Object.keys(COMMANDS).join('|') + '> [--json] ...');
    }
    const result = await /** @type {Record<string, (a: string[]) => object | Promise<object>>} */ (COMMANDS)[cmd](rest);
    const out = Object.assign({ ok: true }, result);
    finish(out, out.ok === false ? 1 : 0);
  } catch (e) {
    if (e instanceof SerenoError) {
      finish(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra), /** @type {Record<string, number>} */ (EXIT)[e.code] || 1);
    } else {
      finish({ ok: false, error: 'internal error', code: 'internal' }, 1);
    }
  }
}

process.on('SIGINT', () => {
  testrun.abortAll();
  finish({ ok: false, error: 'interrupted', code: 'interrupted' }, 130);
});
main();
