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
 * Subcommands: config, run-id, gate, attempt, paths, test, spec, branch, clean, context, recovery, brief, doctor,
 * next, after-check, preflight, reviewer, review-pack, serve, spec-review-needed, spec-review.
 *
 *   spec-review-needed --task <t>
 *                           read-only: { needed, reason }. The red team reads a spec before the first build unless
 *                           roles.redTeam.specReview is false, the red team is off, or the spec's kind is in
 *                           roles.redTeam.light.kinds. Decided in code, no model.
 *   spec-review --file <verdict.json> --task <t> [--agent-name <n>] [--agent <id>] [--session <id>]
 *                           records the red team's spec verdict {outcome: agree|revise|split, points: [<= 8]} as
 *                           .sereno/spec-reviews/<t>-<spec_revision>.json. The file is .sereno/cache/verdict-spec-<t>.json,
 *                           removed once recorded. Any other outcome is refused.
 *
 *   serve --task <t> --start | --stop
 *                           --start launches the spec's `serve` detached (it outlives the command), waits for its
 *                           `ready` URL and writes .sereno/cache/serve-<t>.json {pid, started_at, ready}; refuses
 *                           while a live one exists; a no-op ok when the spec has no browse checks or no serve.
 *                           --stop kills the process tree and removes the file; safe to repeat. The ship skill
 *                           brackets the browse reviewer with these. doctor lists a leftover file.
 *
 *   reviewer --task <t> --base <sha> --head <sha>
 *                           read-only: { agent, light, reason }. Light only when the spec's kind is in
 *                           roles.redTeam.light.kinds, the diff is at most maxDiffLines, and no touched
 *                           path trips a `never` rule (the built-in ones always apply). Ship stores the
 *                           reason in the gate as reviewer_reason (gate --reviewer-reason).
 *   review-pack --task <t> --base <sha> --head <sha>
 *                           writes .sereno/cache/review-<t>.md (<= 200 lines): the spec's acceptance
 *                           criteria, diffstat, touched files, test counts and failing names, and source
 *                           files without test changes. No file contents.
 *   brief --auto --branch <b>
 *                           writes Now / Next / Blocked from the records instead of taking them as flags.
 *
 *   next [--task <t>] [--steps-done <n>]
 *                           with --steps-done, also cap_reached: true once n >= 3 (the step cap of /sereno:next).
 *   next [--task <t>]       what /sereno:next does: { task, step, reason, hold, command }. Read-only.
 *   after-check --task <t>  ok when the spec's `after` task is merged into the base (or there is none); then, if
 *                           task/<t> has no attempts and no commits of its own and the tree is clean, it
 *                           fast-forwards task/<t> to the base tip (else a `warning`, branch untouched);
 *                           otherwise error code after_not_merged. /sereno:build calls it first.
 *   preflight [--task <t>] [--timeout-sec <n>]
 *                           runs the repo's pre-commit hook against the current tree, without committing:
 *                           { hook, passed, timed_out, dirty_after, output_head, output_tail, on_task_branch, branch_note }.
 *                           With --task it reports on_task_branch / branch_note; it never switches branches. Hooks can modify files
 *                           (lint --fix): it reports dirty_after when the tree changed and never undoes it.
 *   spec ... [--after <task|none>] [--hold <text>]
 *                           `after` queues the task behind another; `hold` (<= 200 chars, one line) is
 *                           a human step printed before merge. Omitted keeps the earlier spec's value;
 *                           `--after none` and `--hold ""` clear it.
 *   spec ... [--check-hosts <a,b>]
 *                           bare host names (no scheme, port or path) that the spec's `checks` block may
 *                           use besides localhost, 127.0.0.1 and [::1]; at most 10. Only /sereno:task passes
 *                           it, from hosts the user named. Omitted keeps the earlier list; "" clears it.
 *                           A malformed `checks` block is refused: code invalid_checks (exit 25).
 *   test ... [--task <t>]   with --task, also runs the spec's `checks` at head after the suite; the result
 *                           gains checks: [{ n, kind, target, result, detail }] and checks_log.
 *   attempt --adopt --task <t>
 *                           records a new `built` attempt for the tip of task/<t> after the user approved a
 *                           manual commit of the Builder's work (e.g. past a failing hook). Refuses a
 *                           dirty tree. With the last attempt's start_commit (see attempt --start-commit) the
 *                           tip must differ from it and descend from it (tip_not_moved, tip_unrelated);
 *                           without one, the tip must be newer than the attempt's end by commit time.
 *   stop --task <t>         retires a task: records a new attempt with outcome `stopped` (recovery maps it to done,
 *                           so the task leaves the in-progress list). Refused while the newest attempt is running
 *                           or when there is none. Writes one record; never touches git.
 *   attempt ... --no-verify-approved
 *                           on a new running record: stores no_verify_approved: true (the user approved
 *                           --no-verify for this task's Builder commit). A new running record inherits it from
 *                           the newest earlier attempt of the same task (not after stop). Without it the Builder must not use it.
 *                           A new running record is refused (attempt_running) while the newest attempt is still running.
 *   attempt --start-commit <sha>
 *                           records the commit the Builder started from, on the running record.
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
const nextLib = require('./lib/next.js');
const reviewLib = require('./lib/review.js');
const serveLib = require('./lib/serve.js');
const specReviewLib = require('./lib/specreview.js');
const preflightLib = require('./lib/preflight.js');
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

const EXIT = { usage: 2, config_invalid: 3, invalid_arg: 4, not_a_repo: 5, path_refused: 6, exists: 7, head_mismatch: 8, no_test_command: 9, deadline: 20, builder_not_allowed: 21, worktree_failed: 10, dirty_tree: 11, spec_changed: 17, spec_required: 18, task_required: 19, record_final: 12, not_found: 13, version_conflict: 14, detached_head: 15, branch_mismatch: 16, after_not_merged: 22, tip_not_moved: 23, tip_unrelated: 24, invalid_checks: 25, serve_running: 26, server_not_ready: 27, interrupted: 130 };
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

const CACHE_FILE_MAX = 64 * 1024;

/**
 * Resolve a --file/--body-file argument to a cache-file rel path (relative to the repo
 * root), or refuse. The argument is resolved against the process cwd (the same base
 * `paths` uses for cacheDir), then must land on .sereno/cache/<name> under the root with
 * name matching the pattern. path.relative compares case-insensitively on win32.
 * @param {string} root @param {string} arg @param {RegExp} nameRe @returns {{ rel: string, m: RegExpExecArray }}
 */
function cacheFileArg(root, arg, nameRe) {
  // Resolve against the cwd as spelled (it may be a junction, subst or 8.3 alias), then
  // realpath the directory so it compares with git's realpath'd root.
  if (process.platform === 'win32' && /^[\\/]{2}[?.][\\/]/.test(String(arg))) throw new SerenoError('path_refused', 'namespace-prefixed paths are not accepted');
  const abs = path.resolve(process.cwd(), String(arg));
  let dir = path.dirname(abs);
  try { dir = fs.realpathSync.native(dir); } catch (_e) { /* fall back to lexical */ }
  const rel = path.relative(root, path.join(dir, path.basename(abs)));
  const segs = rel.split(/[\\/]/);
  const fold = (/** @type {string} */ x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  if (segs.length !== 3 || fold(segs[0]) !== '.sereno' || fold(segs[1]) !== 'cache') throw new SerenoError('path_refused', 'only .sereno/cache/ files are accepted');
  const m = nameRe.exec(segs[2]);
  if (!m) throw new SerenoError('path_refused', 'file name not accepted');
  return { rel: '.sereno/cache/' + segs[2], m };
}

/** @param {string} root @param {string} specArg @returns {{ rel: string, hash: string, text: string }} */
function readSpec(root, specArg) {
  const rel = rec.repoRelative(specArg);
  if (!rel) throw new SerenoError('path_refused', 'spec must be a path inside the repository');
  const abs = path.join(root, rel);
  let real;
  try { real = fs.realpathSync.native(abs); } catch (_e) { throw new SerenoError('invalid_arg', 'spec file not found: ' + rel); }
  const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (!fold(real).startsWith(fold(root + path.sep))) throw new SerenoError('path_refused', 'spec resolves outside the repository');
  const buf = readCapped(real);
  return { rel, hash: rec.sha256(buf), text: buf.toString('utf8') };
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
      value: ['file', 'task', 'spec', 'base', 'head', 'branch', 'session', 'agent', 'agent-name', 'model', 'tests-passed', 'run-id', 'reviewer-reason'],
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
    if (!runId.endsWith('_' + head.slice(0, 7).toLowerCase())) throw new SerenoError('invalid_arg', '--run-id must end with _ and the first 7 hex of --head');

    /** @type {string | null} */
    let cacheRel = null;
    let text;
    if (a.stdin) text = readStdin();
    else {
      const cf = cacheFileArg(root, /** @type {string} */ (a.file), /^verdict-(rr_[A-Za-z0-9_]+)\.json$/);
      if (cf.m[1] !== runId) throw new SerenoError('path_refused', 'verdict file does not match --run-id');
      cacheRel = cf.rel;
      text = fsafe.readFile(cacheRel, CACHE_FILE_MAX).toString('utf8');
    }
    const v = rec.sanitizeVerdict(parseVerdict(text));
    // Per-check results are for the spec's browse checks only; any other number is dropped. A failed one forces block.
    /** @type {number[]} */
    let browseNs = [];
    try { browseNs = speclib.parseChecks(spec.text).filter((c) => c.kind === 'browse').map((c) => c.n); } catch (_e) { browseNs = []; }
    const checks = rec.sanitizeChecks(v.checks, browseNs);
    if (checks.some((c) => c.result === 'fail')) {
      v.outcome = 'block';
      for (const c of checks) {
        if (c.result === 'fail' && v.findings.length < rec.MAX_FINDINGS) v.findings[v.findings.length] = { severity: 'high', kind: 'spec', file: null, line: null, summary: rec.cleanText('browse check ' + c.n + ' failed' + (c.note ? ': ' + c.note : ''), 300) };
      }
    }
    const { config_hash } = loadConfig(root);
    const reviewerReason = rec.cleanText(str(a, 'reviewer-reason'), 200);

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
    if (reviewerReason) /** @type {any} */ (gate).reviewer_reason = reviewerReason;
    if (checks.length) /** @type {any} */ (gate).checks = checks;
    const rel = '.sereno/gates/' + runId + '.json';
    fsafe.writeJson(rel, gate);
    if (cacheRel) fsafe.removeFile(cacheRel);
    return { path: rel, review_run_id: runId, outcome: gate.outcome, findings: gate.findings.length, tests_passed: gate.tests_passed, checks: checks.length };
  },

  stop(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    const re = attemptRe(task);
    const nums = [];
    for (const f of fsafe.listDir('.sereno/attempts')) { const m = re.exec(f); if (m) nums[nums.length] = parseInt(m[1], 10); }
    nums.sort((x, y) => x - y);
    if (!nums.length) throw new SerenoError('not_found', 'no attempts recorded for task ' + task + '; nothing to stop');
    /** @type {any} */
    let last = null;
    try {
      const file = path.join(root, '.sereno', 'attempts', task + '-' + nums[nums.length - 1] + '.json');
      const st = fs.lstatSync(file);
      if (st.isFile() && st.size <= MAX_INPUT) last = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) { last = null; }
    if (!last || typeof last !== 'object') throw new SerenoError('not_found', 'the latest attempt record is unreadable');
    if (last.outcome === 'running') throw new SerenoError('invalid_arg', 'attempt ' + nums[nums.length - 1] + ' is still running; finish it with --update first');
    if (last.outcome === 'stopped') throw new SerenoError('invalid_arg', 'task ' + task + ' is already stopped');
    const { config, config_hash } = loadConfig(root);
    const sm = speclib.readSpecMeta(root, task);
    if (sm && nextLib.mergedInto(nextLib.realDeps({ root, fsafe, config }), task, sm.base_branch)) throw new SerenoError('already_merged', 'task ' + task + ' is already merged into ' + sm.base_branch + '; there is nothing to retire');
    const now = new Date().toISOString();
    return allocateAttempt(fsafe, task, {
      project_id: typeof last.project_id === 'string' && last.project_id ? last.project_id : projectId(root),
      task_id: task,
      spec_revision: Number.isInteger(last.spec_revision) && last.spec_revision > 0 ? last.spec_revision : 1,
      attempt: 0,
      builder_requested: rec.enumOr(last.builder_requested, rec.BUILDERS),
      agent_id: null,
      config_hash,
      kind: rec.enumOr(last.kind, rec.KINDS),
      fixes: null,
      diagnosis: 'none',
      outcome: 'stopped',
      review_run_id: null,
      started_at: now,
      ended_at: now,
    });
  },

  attempt(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, {
      value: ['task', 'project', 'spec-revision', 'builder', 'agent', 'kind', 'fixes', 'diagnosis', 'outcome', 'review-run-id', 'started-at', 'ended-at', 'update', 'agent-id', 'spec', 'spec-hash', 'head', 'start-commit'],
      bool: ['json', 'adopt', 'no-verify-approved'],
    });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    checkTaskBranch(root, task);
    if (a.adopt) return adoptAttempt(root, fsafe, task, a);
    if (a.update !== undefined) return updateAttempt(root, fsafe, task, a);
    if (a.head !== undefined) throw new SerenoError('usage', '--head is only for --update with --outcome skipped');
    const { config_hash } = loadConfig(root);
    const fixes = str(a, 'fixes');
    const rr = str(a, 'review-run-id');
    if (rr !== undefined && !rec.RUN_ID.test(rr)) throw new SerenoError('invalid_arg', '--review-run-id has an invalid format');
    const revArg = str(a, 'spec-revision');
    if (revArg !== undefined && !/^[1-9]\d{0,5}$/.test(revArg)) throw new SerenoError('invalid_arg', '--spec-revision must be a positive integer');
    const shArg = str(a, 'spec-hash');
    if (shArg !== undefined && !/^sha256:[0-9a-f]{64}$/.test(shArg)) throw new SerenoError('invalid_arg', '--spec-hash must be sha256:<64 hex>');
    if (shArg !== undefined && str(a, 'spec') !== undefined) throw new SerenoError('usage', 'give --spec or --spec-hash, not both');
    const scArg = str(a, 'start-commit');
    const startCommit = scArg === undefined ? null : gitlib.resolveCommit(root, scArg);
    if (scArg !== undefined && !startCommit) throw new SerenoError('invalid_arg', '--start-commit must name an existing commit');
    const specHash = shArg !== undefined ? shArg : (str(a, 'spec') !== undefined ? readSpec(root, /** @type {string} */ (str(a, 'spec'))).hash : null);
    if (specHash === null && newestPin(root, fsafe, task)) throw new SerenoError('spec_required', 'an earlier attempt of this task pinned a spec; pass --spec .sereno/specs/' + task + '.md');
    const agent = str(a, 'agent') !== undefined ? str(a, 'agent') : str(a, 'agent-id');
    if (agent !== undefined) matchId(agent, '--agent', /^[A-Za-z0-9._:-]{1,128}$/);

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
    if (specHash !== null) /** @type {any} */ (record).spec_hash = specHash;
    if (startCommit) /** @type {any} */ (record).start_commit = startCommit;
    // The user's per-task approval to use --no-verify on the Builder's commit; recorded so it is auditable.
    // The approval lasts for the task: a new running record inherits it from the newest earlier attempt of the
    // same task (a stopped task starts fresh). It never carries to another task.
    let inherit = false;
    {
      const re = attemptRe(task);
      let top = 0;
      for (const f of fsafe.listDir('.sereno/attempts')) { const m = re.exec(f); if (m) top = Math.max(top, parseInt(m[1], 10)); }
      const prev = top ? newestAttemptRecord(fsafe, task, top) : null;
      inherit = !!(prev && prev.no_verify_approved === true && prev.outcome !== 'stopped');
    }
    if (a['no-verify-approved'] || (inherit && record.outcome === 'running')) /** @type {any} */ (record).no_verify_approved = true;
    return allocateAttempt(fsafe, task, record);
  },

  async test(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['base', 'head', 'task', 'spec', 'deadline-sec'], bool: ['json'] });
    const dl = str(a, 'deadline-sec');
    if (dl !== undefined && !(/^[1-9]\d{0,6}$/.test(dl) && Number(dl) <= 2147483)) throw new SerenoError('invalid_arg', '--deadline-sec must be a positive integer');
    if (dl !== undefined) {
      // One wall-clock budget for the whole command: stop every suite, remove the worktree, keep a base cache only if the base suite already passed in full.
      setTimeout(() => {
        testrun.abortAll();
        // Synchronous on purpose: nothing may run between the abort and the exit.
        try { fs.writeSync(1, JSON.stringify({ ok: false, status: 'deadline', code: 'deadline', error: 'the test run exceeded --deadline-sec ' + dl, deadline_sec: Number(dl), passed: false }) + '\n'); } catch (_e) { /* exit anyway */ }
        process.exit(EXIT.deadline);
      }, Number(dl) * 1000);
    }
    const { root, fsafe } = needRepo();
    /** @type {import('./lib/spec.js').Check[]} */
    let checks = [];
    if (str(a, 'task') !== undefined) {
      const t = rec.checkTask(str(a, 'task'));
      checkTaskBranch(root, t);
      const specArg = str(a, 'spec') || '.sereno/specs/' + t + '.md';
      checkSpecPin(root, fsafe, t, specArg);
      // The checks come from the spec the attempt is pinned to (checkSpecPin refused any other), parsed before any suite starts.
      checks = speclib.parseChecks(readSpec(root, specArg).text);
    } else requireTaskIfRecorded(root, fsafe);
    testrun.sweepStale(root);
    const base = gitlib.resolveCommit(root, str(a, 'base') || '');
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!base) throw new SerenoError('invalid_arg', '--base must name an existing commit');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    const { config, config_hash } = loadConfig(root);
    return await testrun.runTests({ root, fsafe, config, configHash: config_hash, base, head, runId: rec.makeRunId(head), checks });
  },

  spec(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task', 'builder', 'kind', 'reason', 'fixes', 'base-branch', 'after', 'hold', 'check-hosts', 'body-file'], bool: ['json', 'stdin'] });
    if (!!a['body-file'] === !!a.stdin) throw new SerenoError('usage', 'give exactly one of --body-file or --stdin');
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    /** @type {string} */
    let body;
    let cacheRel = null;
    if (a.stdin) body = readStdin();
    else {
      const cf = cacheFileArg(root, /** @type {string} */ (a['body-file']), /^spec-([A-Za-z0-9._-]+)\.md$/);
      if (cf.m[1] !== task) throw new SerenoError('path_refused', 'spec file does not match --task');
      cacheRel = cf.rel;
      body = fsafe.readFile(cacheRel, CACHE_FILE_MAX).toString('utf8');
    }
    const out = speclib.writeSpec({ root, fsafe, task, allowed: loadConfig(root).config.roles.builder.allowed, builder: str(a, 'builder'), kind: str(a, 'kind'), reason: str(a, 'reason'), fixes: str(a, 'fixes'), baseBranch: str(a, 'base-branch'), after: str(a, 'after'), hold: str(a, 'hold'), checkHosts: str(a, 'check-hosts') === undefined ? undefined : /** @type {string} */ (str(a, 'check-hosts')).split(',').map((x) => x.trim()).filter(Boolean), body });
    if (cacheRel) fsafe.removeFile(cacheRel);
    return out;
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
    return recovery.decide({
      root, task, config,
      listAttempts: () => fsafe.listDir('.sereno/attempts'),
      currentHead: () => gitlib.resolveCommit(root, 'refs/heads/task/' + task),
      currentSpecHash: () => { try { return readSpec(root, '.sereno/specs/' + task + '.md').hash; } catch (_e) { return null; } },
      headMerged: nextLib.headMergedFor(root, fsafe, task),
    });
  },

  brief(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['branch', 'now', 'next', 'blocked', 'task', 'expect-version'], bool: ['json', 'auto'] });
    const branch = str(a, 'branch'), now = str(a, 'now'), next = str(a, 'next');
    if (a.auto) {
      if (branch === undefined) throw new SerenoError('usage', 'brief --auto needs --branch');
      if (now !== undefined || next !== undefined || a.blocked !== undefined || a['expect-version'] !== undefined) throw new SerenoError('usage', '--auto writes Now, Next and Blocked itself; do not pass --now, --next, --blocked or --expect-version');
      const r = needRepo();
      return briefLib.writeAutoBrief({ root: r.root, fsafe: r.fsafe, config: loadConfig(r.root).config, branch, task: str(a, 'task') });
    }
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

  next(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task', 'steps-done'], bool: ['json'] });
    const t = str(a, 'task');
    const sd = str(a, 'steps-done');
    if (sd !== undefined && !/^\d{1,3}$/.test(sd)) throw new SerenoError('invalid_arg', '--steps-done must be a non-negative integer');
    const { root, fsafe } = needRepo();
    const { config } = loadConfig(root);
    const r = nextLib.decide({ task: t === undefined ? null : rec.checkTask(t), deps: nextLib.realDeps({ root, fsafe, config }) });
    // The merge skill puts the title in the merge commit message; it is shell-safe (see readSpecTitle).
    /** @type {Record<string, any>} */
    const out = r.task ? Object.assign({}, r, { title: speclib.readSpecTitle(root, r.task) }) : Object.assign({}, r);
    // /sereno:next runs at most STEP_CAP build/ship/retry steps per invocation; it passes the count it has done.
    if (sd !== undefined) out.cap_reached = Number(sd) >= nextLib.STEP_CAP;
    return out;
  },

  reviewer(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task', 'base', 'head'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root } = needRepo();
    const base = gitlib.resolveCommit(root, str(a, 'base') || '');
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!base) throw new SerenoError('invalid_arg', '--base must name an existing commit');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    const meta = speclib.readSpecMeta(root, task);
    if (!meta) throw new SerenoError('not_found', 'no spec for task ' + task + '; run /sereno:task first');
    const { config } = loadConfig(root);
    // A spec with browse checks gets the browse red team (its checks block must parse; if it does not, the normal choice stands).
    let browse = 0;
    try { const b = reviewLib.browseChecks(fs.readFileSync(path.join(root, '.sereno', 'specs', task + '.md'), 'utf8')); browse = b ? b.length : 0; } catch (_e) { browse = 0; }
    return reviewLib.chooseReviewer({ root, config, kind: meta.kind, base, head, browse });
  },

  'spec-review-needed'(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root } = needRepo();
    const meta = speclib.readSpecMeta(root, task);
    if (!meta) throw new SerenoError('not_found', 'no spec for task ' + task + '; run /sereno:task first');
    const { config } = loadConfig(root);
    return specReviewLib.needed({ config, kind: meta.kind });
  },

  'spec-review'(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['file', 'task', 'agent-name', 'agent', 'session'], bool: ['json'] });
    if (str(a, 'file') === undefined) throw new SerenoError('usage', 'give --file <verdict.json>');
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    const meta = speclib.readSpecMeta(root, task);
    if (!meta) throw new SerenoError('not_found', 'no spec for task ' + task + '; run /sereno:task first');
    const id = /^[A-Za-z0-9._:-]{1,128}$/;
    const agent = str(a, 'agent');
    const agentName = str(a, 'agent-name');
    const sessRaw = str(a, 'session');
    const session = sessRaw !== undefined && !sessRaw.includes('${') && /^[A-Za-z0-9-]{8,64}$/.test(sessRaw) ? sessRaw : undefined;
    const cf = cacheFileArg(root, /** @type {string} */ (a.file), /^verdict-spec-(.+).json$/);
    if (cf.m[1] !== task) throw new SerenoError('path_refused', 'verdict file does not match --task');
    const v = specReviewLib.sanitize(parseVerdict(fsafe.readFile(cf.rel, CACHE_FILE_MAX).toString('utf8')));
    const record = {
      task,
      spec_revision: meta.spec_revision,
      outcome: v.outcome,
      points: v.points,
      agent_name: agentName === undefined ? null : matchId(agentName, '--agent-name', id),
      agent_id: agent === undefined ? null : matchId(agent, '--agent', id),
      session: session === undefined ? null : session,
      reviewed_at: new Date().toISOString(),
    };
    const rel = '.sereno/spec-reviews/' + task + '-' + meta.spec_revision + '.json';
    fsafe.writeJson(rel, record);
    fsafe.removeFile(cf.rel);
    return { path: rel, spec_revision: meta.spec_revision, outcome: record.outcome, points: record.points.length };
  },

  async serve(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json', 'start', 'stop'] });
    if (!!a.start === !!a.stop) throw new SerenoError('usage', 'give exactly one of --start or --stop');
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    return a.start ? serveLib.start({ root, fsafe, task }) : serveLib.stop({ fsafe, task });
  },

  'review-pack'(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task', 'base', 'head'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    const base = gitlib.resolveCommit(root, str(a, 'base') || '');
    const head = gitlib.resolveCommit(root, str(a, 'head') || '');
    if (!base) throw new SerenoError('invalid_arg', '--base must name an existing commit');
    if (!head) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    let specText;
    try { specText = fsafe.readFile('.sereno/specs/' + task + '.md', MAX_INPUT).toString('utf8'); } catch (_e) { throw new SerenoError('not_found', 'no spec for task ' + task + '; run /sereno:task first'); }
    const r = reviewLib.buildPack({ root, fsafe, task, base, head, specText });
    return Object.assign({}, r, { abs: path.join(root, r.path).split(path.sep).join('/') });
  },

  'after-check'(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['task'], bool: ['json'] });
    const task = rec.checkTask(str(a, 'task'));
    const { root, fsafe } = needRepo();
    const { config } = loadConfig(root);
    const deps = nextLib.realDeps({ root, fsafe, config });
    const m = deps.spec(task);
    if (!m) throw new SerenoError('not_found', 'no spec for task ' + task + '; run /sereno:task first');
    const st = nextLib.afterState(deps, m);
    if (!st.ok) {
      throw new SerenoError('after_not_merged', 'task ' + task + ' comes after ' + st.after + ', which is not merged into ' + (st.base || 'its base branch') + ' yet' + (st.base ? '' : ' (no base branch is known)') + '; merge ' + st.after + ' first', { task, after: st.after, base: st.base });
    }
    /** @type {Record<string, any>} */
    const out = { task, after: st.after, merged: true, base: st.base };
    if (st.after && st.base) Object.assign(out, nextLib.refreshQueuedBranch({ root, task, base: st.base, attempts: deps.attemptCount(task) }));
    return out;
  },

  preflight(/** @type {string[]} */ argv) {
    const a = parseArgs(argv, { value: ['timeout-sec', 'task'], bool: ['json'] });
    const ts = str(a, 'timeout-sec');
    const ptask = str(a, 'task') === undefined ? undefined : rec.checkTask(str(a, 'task'));
    if (ts !== undefined && !/^[1-9]\d{0,3}$/.test(ts)) throw new SerenoError('invalid_arg', '--timeout-sec must be a positive integer');
    const { root } = needRepo();
    return preflightLib.preflight({ root, task: ptask, timeoutMs: ts === undefined ? undefined : Number(ts) * 1000 });
  },

  paths(/** @type {string[]} */ argv) {
    parseArgs(argv, { value: [], bool: ['json'] });
    const top = gitlib.toplevel(process.cwd());
    const root = top ? fs.realpathSync.native(path.resolve(top)) : null;
    const home = path.join(os.homedir(), '.sereno');
    // cacheDir is absolute (Write needs that) but spelled from the session's own cwd, not
    // git's: Claude Code compares paths case-sensitively. path.relative ignores case on win32.
    let cwd = process.cwd();
    try { cwd = fs.realpathSync.native(cwd); } catch (_e) { /* keep as is */ }
    const cacheAbs = root && path.join(root, '.sereno', 'cache');
    return {
      repo_root: root,
      sereno_dir: root && path.join(root, '.sereno'),
      cacheDir: cacheAbs && path.resolve(process.cwd(), path.relative(cwd, cacheAbs) || '.').split(path.sep).join('/'),
      layout: {
        pipeline: '.sereno/pipeline.json',
        specs: '.sereno/specs/<task>.md',
        gates: '.sereno/gates/<review_run_id>.json',
        attempts: '.sereno/attempts/<task>-<n>.json',
        spec_reviews: '.sereno/spec-reviews/<task>-<spec_revision>.json',
        briefs: '.sereno/briefs/<branch>.md',
      },
      user_config: path.join(home, 'pipeline.json'),
    };
  },
};

/**
 * Write the record under the next free attempt number. Exclusive create: if two writers
 * race for the same number, the loser takes the next one.
 * @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {Record<string, any>} record
 */
function newestAttemptRecord(fsafe, task, n) {
  try {
    const r = JSON.parse(fsafe.readFile('.sereno/attempts/' + task + '-' + n + '.json', MAX_INPUT).toString('utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch (_e) { return null; }
}

/** @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {Record<string, any>} record */
function allocateAttempt(fsafe, task, record) {
  const re = attemptRe(task);
  let n = 1;
  for (const f of fsafe.listDir('.sereno/attempts')) {
    const m = re.exec(f);
    if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
  }
  // A second running record would mean a second Builder for an attempt that is still going (for example
  // when a background agent's result arrives after the loop moved on).
  if (record.outcome === 'running' && n > 1) {
    const prev = newestAttemptRecord(fsafe, task, n - 1);
    if (!prev) throw new SerenoError('invalid_arg', 'the newest attempt record of ' + task + ' (attempt ' + (n - 1) + ') is unreadable; repair or remove it first');
    if (prev.outcome === 'running') throw new SerenoError('attempt_running', 'attempt ' + (n - 1) + ' of ' + task + ' is still running; finish it with --update before starting another');
  }
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
}

/**
 * attempt --adopt: the user approved a manual commit of the Builder's work (for example past
 * a failing hook). It accepts any newest attempt that ended as `error`; the typical case is
 * hook_failed. A record without `start_commit` falls back to the commit-time rule. Record a new `built` attempt for the tip of task/<task> so ship can go on.
 * Refuses a dirty tree, another branch, and a tip that is not a new commit since the last
 * attempt (the tip was already adopted, or is not newer than the last attempt's end).
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {Record<string, string | boolean>} a
 */
function adoptAttempt(root, fsafe, task, a) {
  for (const k of ['update', 'spec', 'spec-hash', 'project', 'spec-revision', 'builder', 'agent', 'agent-id', 'kind', 'fixes', 'diagnosis', 'outcome', 'review-run-id', 'started-at', 'ended-at', 'head', 'start-commit', 'no-verify-approved']) {
    if (a[k] !== undefined) throw new SerenoError('usage', '--' + k + ' cannot be combined with --adopt');
  }
  if (gitlib.currentBranch(root) !== 'task/' + task) throw new SerenoError('branch_mismatch', 'check out task/' + task + ' first; --adopt records the tip of the branch you are on');
  const dirty = gitlib.cleanFiles(root);
  if (dirty === null) throw new SerenoError('invalid_arg', 'could not read the working tree status');
  if (dirty.length) throw new SerenoError('dirty_tree', 'working tree has uncommitted changes; commit or stash them first', { files: dirty.slice(0, 20) });
  const tip = gitlib.resolveCommit(root, 'refs/heads/task/' + task);
  if (!tip) throw new SerenoError('invalid_arg', 'task/' + task + ' has no commit');
  const re = attemptRe(task);
  const nums = [];
  for (const f of fsafe.listDir('.sereno/attempts')) { const m = re.exec(f); if (m) nums[nums.length] = parseInt(m[1], 10); }
  nums.sort((x, y) => x - y);
  if (!nums.length) throw new SerenoError('not_found', 'no attempts recorded for task ' + task + '; nothing to adopt after');
  /** @param {number} n @returns {any} */
  const read = (n) => {
    try {
      const file = path.join(root, '.sereno', 'attempts', task + '-' + n + '.json');
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_INPUT) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) { return null; }
  };
  const all = nums.map(read);
  const last = all[all.length - 1];
  if (!last || typeof last !== 'object') throw new SerenoError('not_found', 'the latest attempt record is unreadable');
  if (last.outcome === 'running') throw new SerenoError('invalid_arg', 'attempt ' + nums[nums.length - 1] + ' is still running; finish it with --update first');
  if (all.some((r) => r && r.head_commit === tip)) throw new SerenoError('tip_not_moved', 'the tip of task/' + task + ' is already recorded by an earlier attempt');
  if (last.outcome !== 'error') throw new SerenoError('invalid_arg', 'attempt ' + nums[nums.length - 1] + ' ended as ' + String(last.outcome) + ', not error; --adopt is only for work that failed to commit (for example a hook refusal)');
  const lastN = nums[nums.length - 1];
  if (typeof last.start_commit === 'string' && gitlib.isSha(last.start_commit)) {
    // The commit the Builder started from is the reference: a clock or an amend cannot fool it.
    if (tip === last.start_commit.toLowerCase()) throw new SerenoError('tip_not_moved', 'the tip of task/' + task + ' is still the commit attempt ' + lastN + ' started from');
    if (gitlib.isAncestor(root, last.start_commit, tip) !== true) throw new SerenoError('tip_unrelated', 'the tip of task/' + task + ' does not build on the commit attempt ' + lastN + ' started from');
  } else {
    // An older record with no start_commit: fall back to commit time against the attempt's end.
    const ref = typeof last.ended_at === 'string' ? last.ended_at : (typeof last.started_at === 'string' ? last.started_at : null);
    const refMs = ref ? new Date(ref).getTime() : NaN;
    if (!isNaN(refMs)) {
      const ct = gitlib.git(root, ['show', '-s', '--format=%ct', '--end-of-options', tip]);
      const tipSec = ct && /^\d{1,12}$/.test(ct) ? parseInt(ct, 10) : NaN;
      if (isNaN(tipSec)) throw new SerenoError('invalid_arg', 'could not read the commit time of the tip');
      if (tipSec <= Math.floor(refMs / 1000)) throw new SerenoError('tip_not_moved', 'the tip of task/' + task + ' is not a new commit since attempt ' + lastN + ' ended');
    }
  }
  const pinned = checkSpecPin(root, fsafe, task, '.sereno/specs/' + task + '.md');
  const { config_hash } = loadConfig(root);
  const now = new Date().toISOString();
  /** @type {Record<string, any>} */
  const record = {
    project_id: typeof last.project_id === 'string' && last.project_id ? last.project_id : projectId(root),
    task_id: task,
    spec_revision: Number.isInteger(last.spec_revision) && last.spec_revision > 0 ? last.spec_revision : 1,
    attempt: 0,
    builder_requested: rec.enumOr(last.builder_requested, rec.BUILDERS),
    agent_id: null,
    config_hash,
    kind: rec.enumOr(last.kind, rec.KINDS),
    fixes: typeof last.fixes === 'string' ? last.fixes : null,
    diagnosis: 'none',
    outcome: 'built',
    review_run_id: null,
    started_at: now,
    ended_at: now,
  };
  if (pinned) record.spec_hash = pinned;
  if (last.no_verify_approved === true) record.no_verify_approved = true;
  record.head_commit = tip;
  return allocateAttempt(fsafe, task, record);
}

/**
 * attempt --update <n>: merge outcome, diagnosis, review run id and end time into
 * an existing record. A record whose outcome is final is never changed.
 * @param {string} root @param {ReturnType<typeof createSafeFs>} fsafe @param {string} task @param {Record<string, string | boolean>} a
 */
function updateAttempt(root, fsafe, task, a) {
  for (const k of ['spec', 'spec-hash', 'project', 'spec-revision', 'builder', 'agent', 'kind', 'fixes', 'started-at', 'start-commit']) {
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
  const headArg = str(a, 'head');
  if (headArg !== undefined) {
    if (record.outcome !== 'skipped') throw new SerenoError('usage', '--head is only for --outcome skipped');
    const h = gitlib.resolveCommit(root, headArg);
    if (!h) throw new SerenoError('invalid_arg', '--head must name an existing commit');
    record.head_commit = h;
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
