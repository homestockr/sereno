// @ts-check
'use strict';
/*
 * Review sizing and the review pack.
 *
 *   chooseReviewer  sereno.js reviewer: which red team agent reviews this task. Read-only, no model:
 *                   the spec's kind, the diff line count and the touched paths decide. The gate never
 *                   switches off here; only the reviewer changes.
 *   buildPack       sereno.js review-pack: a short map for the red team, written to
 *                   .sereno/cache/review-<task>.md. Paths, counts and the spec's own text only; it
 *                   holds no file contents.
 */

const gitlib = require('./git.js');
const rec = require('./records.js');
const testrun = require('./testrun.js');
const { SerenoError } = require('./fsafe.js');

/** Always get the full red team. A repo's roles.redTeam.light.never adds to these and cannot remove them. */
const DEFAULT_NEVER = ['**/migrations/**', 'supabase/**'];
/** A touched path whose lowercased form contains any of these always gets the full red team. */
const NEVER_WORDS = ['auth', 'permission', 'payment', 'delete', 'secret', 'password', 'credential', 'token', 'billing', 'rbac', 'acl'];
/** Short words that would match inside ordinary names ("oracle"): they must be a whole path word. */
const NEVER_WHOLE_WORDS = ['rbac', 'acl'];

/** Binary files have no line count in numstat; count them as this many lines so they never pass as small. */
const BINARY_LINES = 1000;

/**
 * Glob to a case-insensitive RegExp. `**` crosses directories, `*` and `?` do not.
 * @param {string} glob @returns {RegExp}
 */
function globToRegExp(glob) {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * The rule a path trips, or null. @param {string} p repo-relative, forward slashes
 * @param {string[]} extra the repo's own globs
 * @returns {string | null}
 */
function neverRule(p, extra) {
  const path_ = p.replace(/\\/g, '/');
  for (const g of DEFAULT_NEVER.concat(extra || [])) if (globToRegExp(g).test(path_)) return g;
  const low = path_.toLowerCase();
  for (const w of NEVER_WORDS) {
    if (NEVER_WHOLE_WORDS.includes(w) ? new RegExp('(^|[^a-z0-9])' + w + '([^a-z0-9]|$)').test(low) : low.includes(w)) return 'path contains ' + w;
  }
  return null;
}

/**
 * Lines changed and files touched by `git diff base...head`. null when git fails or the output is too
 * large to read (a diff that big is never "light").
 * @param {string} root @param {string} base @param {string} head
 * @returns {{ lines: number, files: string[] } | null}
 */
function diffInfo(root, base, head) {
  const out = gitlib.git(root, ['-c', 'core.quotePath=false', 'diff', '--numstat', '--no-renames', '--end-of-options', base + '...' + head]);
  if (out === null) return null;
  let lines = 0;
  /** @type {string[]} */
  const files = [];
  for (const l of out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (!m) continue;
    lines += m[1] === '-' ? BINARY_LINES : parseInt(m[1], 10) + parseInt(m[2], 10);
    files[files.length] = m[3];
  }
  return { lines, files };
}

/**
 * @param {{ root: string, config: any, kind: string | null, base: string, head: string }} a
 * @returns {{ agent: string, light: boolean, reason: string }}
 */
function chooseReviewer(a) {
  const red = a.config.roles.redTeam;
  const light = red.light;
  // The reason goes inside double quotes on a command line (gate --reviewer-reason): no shell metacharacters.
  const safe = (/** @type {string} */ t) => rec.cleanText(t, 200).replace(/["`$\\']/g, '');
  const normal = (/** @type {string} */ reason) => ({ agent: red.agent, light: false, reason: safe(reason) });
  const kind = a.kind || 'unknown';
  if (!light.kinds.length) return normal('light review is off (roles.redTeam.light.kinds is empty)');
  if (!light.kinds.includes(kind)) return normal('kind ' + kind + ' is not one of: ' + light.kinds.join(', '));
  const d = diffInfo(a.root, a.base, a.head);
  if (!d) return normal('the diff could not be read');
  if (d.lines > light.maxDiffLines) return normal('the diff is ' + d.lines + ' lines, over the limit of ' + light.maxDiffLines);
  for (const f of d.files) {
    const rule = neverRule(f, light.never);
    if (rule) return normal(rule === f ? 'touches ' + f : 'touches ' + f + ' (' + rule + ')');
  }
  return { agent: light.agent, light: true, reason: safe('kind ' + kind + ', ' + d.lines + ' lines (limit ' + light.maxDiffLines + '), no sensitive path') };
}

/* ---- review pack ---- */

const PACK_MAX_LINES = 200;
const SPEC_MAX_LINES = 60;
const STAT_MAX_LINES = 40;
const FILES_MAX = 50;
const UNTESTED_MAX = 25;
const NAMES_MAX = 15;
const LINE_MAX = 300;
const LOG_MAX = 1024 * 1024;

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|c|cc|cpp|h|hpp|swift|sh|ps1|sql)$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[a-z]+$|(?:^|\/)test[-_.][^/]*$|[-_]test\.[a-z]+$/i;

/** @param {string[]} arr @param {string} v */
function add(arr, v) { arr[arr.length] = v; }

/** @param {string} s */
function plain(s) { return s.replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, LINE_MAX); }

/**
 * The spec's acceptance criteria, verbatim: the section under a heading that mentions
 * "acceptance", up to the next heading of the same or a higher level. A spec with no such heading
 * is all acceptance criteria (the body is what /sereno:task was given), so the whole body is used.
 * @param {string} specText @returns {string[]}
 */
function acceptanceLines(specText) {
  const parts = /^---\r?\n/.test(specText) ? specText.replace(/^---\r?\n/, '').split(/\r?\n---\r?\n/) : [specText];
  const body = (/^---\r?\n/.test(specText) ? parts.slice(1).join('\n---\n') : specText).replace(/\s+$/, '').split(/\r?\n/);
  let start = -1, level = 0;
  for (let i = 0; i < body.length; i++) {
    const m = /^(#{1,6})[ \t]+(.*)$/.exec(body[i]);
    if (m && /acceptance/i.test(m[2])) { start = i; level = m[1].length; break; }
  }
  if (start < 0) return body.map(plain);
  let end = body.length;
  for (let i = start + 1; i < body.length; i++) {
    const m = /^(#{1,6})[ \t]+/.exec(body[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return body.slice(start, end).map(plain);
}

/**
 * The test summary from the newest test log for this head: counts and failing test names only.
 * @param {{ listDir: (rel: string) => string[], readFile: (rel: string, max: number) => Buffer }} fsafe @param {string} head
 * @returns {string[]}
 */
function testSummary(fsafe, head) {
  const tail = '_' + head.slice(0, 7).toLowerCase() + '.log';
  let names;
  try { names = fsafe.listDir('.sereno/cache').filter((n) => /^test-rr_/.test(n) && n.endsWith(tail)).sort(); } catch (_e) { names = []; }
  if (!names.length) return ['No test record for this head in .sereno/cache (run `sereno.js test` first).'];
  let text;
  try { text = fsafe.readFile('.sereno/cache/' + names[names.length - 1], LOG_MAX).toString('utf8'); } catch (_e) { return ['The test record could not be read.']; }
  const m = /^===== head \(exit (\d+)[^)]*\) =====\r?\n([\s\S]*?)(?=^===== |$(?![\s\S]))/m.exec(text);
  if (!m) return ['The test record has no head section.'];
  const out = m[2];
  const sum = testrun.parseSummary(out);
  const c = testrun.parseCounts(out);
  const failing = testrun.parseFailures(out);
  const lines = [];
  if (sum.summary) add(lines, 'Head run (exit ' + m[1] + '): ' + sum.summary.tests + ' tests, ' + sum.summary.pass + ' pass, ' + sum.summary.fail + ' fail.');
  else add(lines, 'Head run (exit ' + m[1] + '): ' + c.count + ' result lines, ' + sum.nok + ' failing' + (c.count ? '' : ' (the runner printed no TAP lines)') + '.');
  if (failing.length) {
    add(lines, 'Failing tests (names only):');
    for (const n of failing.slice(0, NAMES_MAX)) add(lines, '- ' + plain(n));
    if (failing.length > NAMES_MAX) add(lines, '- ... and ' + (failing.length - NAMES_MAX) + ' more');
  }
  return lines;
}

/**
 * Touched source files with no test change next to them: if the diff touches no test file, every
 * source file; otherwise the source files whose base name appears in no touched test path.
 * @param {string[]} files @returns {string[]}
 */
function untested(files) {
  const tests = files.filter((f) => TEST_PATH.test(f));
  const src = files.filter((f) => CODE_EXT.test(f) && !TEST_PATH.test(f));
  if (!tests.length) return src;
  const low = tests.map((t) => t.toLowerCase());
  return src.filter((f) => {
    const stem = (f.split('/').pop() || f).replace(/\.[^.]+$/, '').toLowerCase();
    return !stem || !low.some((t) => t.includes(stem));
  });
}

/**
 * @param {{ root: string, fsafe: any, task: string, base: string, head: string, specText: string }} a
 * @returns {{ path: string, lines: number, files: number, truncated: boolean }}
 */
function buildPack(a) {
  const d = diffInfo(a.root, a.base, a.head);
  if (!d) throw new SerenoError('invalid_arg', 'could not read the diff between --base and --head');
  const stat = gitlib.git(a.root, ['-c', 'core.quotePath=false', 'diff', '--stat=100', '--no-renames', '--end-of-options', a.base + '...' + a.head]);
  const statLines = (stat || '').split(/\r?\n/).filter(Boolean).map(plain);
  const crit = acceptanceLines(a.specText);
  /** @type {string[]} */
  const out = [];
  add(out, '# Review pack: ' + a.task);
  add(out, 'A map for the review, not evidence. Verify every claim against the code yourself.');
  add(out, 'base ' + a.base.slice(0, 12) + '  head ' + a.head.slice(0, 12) + '  (git diff base...head)');
  add(out, '');
  add(out, '## Acceptance criteria (the spec, verbatim)');
  for (const l of crit.slice(0, SPEC_MAX_LINES)) add(out, l);
  if (crit.length > SPEC_MAX_LINES) add(out, '[' + (crit.length - SPEC_MAX_LINES) + ' more spec lines not shown; read .sereno/specs/' + a.task + '.md]');
  add(out, '');
  add(out, '## Diffstat');
  if (statLines.length > STAT_MAX_LINES) { for (const l of statLines.slice(0, STAT_MAX_LINES - 1)) add(out, l); add(out, '...'); add(out, statLines[statLines.length - 1]); }
  else for (const l of statLines) add(out, l);
  add(out, '');
  add(out, '## Touched files (' + d.files.length + ', ' + d.lines + ' lines changed)');
  for (const f of d.files.slice(0, FILES_MAX)) add(out, '- ' + plain(f));
  if (d.files.length > FILES_MAX) add(out, '- ... and ' + (d.files.length - FILES_MAX) + ' more');
  add(out, '');
  add(out, '## Tests');
  for (const l of testSummary(a.fsafe, a.head)) add(out, l);
  add(out, '');
  const un = untested(d.files);
  add(out, '## Touched source files with no test change in the diff (' + un.length + ')');
  if (!un.length) add(out, 'None.');
  for (const f of un.slice(0, UNTESTED_MAX)) add(out, '- ' + plain(f));
  if (un.length > UNTESTED_MAX) add(out, '- ... and ' + (un.length - UNTESTED_MAX) + ' more');
  let truncated = false;
  if (out.length > PACK_MAX_LINES) { out.length = PACK_MAX_LINES - 1; add(out, '[pack truncated at ' + PACK_MAX_LINES + ' lines]'); truncated = true; }
  const rel = '.sereno/cache/review-' + a.task + '.md';
  a.fsafe.writeFile(rel, out.join('\n') + '\n');
  return { path: rel, lines: out.length, files: d.files.length, truncated };
}

module.exports = { chooseReviewer, buildPack, diffInfo, neverRule, globToRegExp, acceptanceLines, untested, DEFAULT_NEVER, NEVER_WORDS, PACK_MAX_LINES };
