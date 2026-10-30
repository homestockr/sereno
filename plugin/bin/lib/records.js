// @ts-check
'use strict';
/*
 * Gate and attempt records. A red-team verdict is untrusted input: only the
 * fields in the schema are read, every string is cleaned and capped, enums
 * outside their list become "unknown", and paths outside the repo are dropped.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const { SerenoError } = require('./fsafe.js');

const MAX_FINDINGS = 50;
const MAX_CONTEXT = 20;
const SUMMARY_MAX = 300;
const KIND_MAX = 40;
const PATH_MAX = 260;

const GATE_OUTCOMES = ['pass', 'block', 'needs_context', 'error', 'skipped'];
const SEVERITIES = ['high', 'medium', 'low'];
const CHECK_RESULTS = ['pass', 'fail', 'unverified'];
const CHECK_NOTE_MAX = 300;
const MAX_CHECKS = 20;
const BUILDERS = ['haiku', 'sonnet', 'opus'];
const KINDS = ['mechanical', 'feature', 'fix', 'refactor'];
const DIAGNOSES = ['environment', 'spec', 'defect', 'hook_failed', 'none'];
const ATTEMPT_OUTCOMES = ['pass', 'block', 'needs_context', 'error', 'skipped', 'stopped', 'running', 'built'];
const FINAL_OUTCOMES = ['pass', 'block', 'needs_context', 'error', 'skipped', 'stopped'];

// Control characters, DEL, C1, zero-width, bidi marks and isolates, line/paragraph separators.
const STRIP = new RegExp('[' + ['\\u0000-\\u0008', '\\u000b-\\u001f', '\\u007f-\\u009f', '\\u061c', '\\u200b-\\u200f', '\\u2028-\\u202e', '\\u2060-\\u2069', '\\ufeff'].join('') + ']', 'g');

/** @param {unknown} v @param {number} max @returns {string} */
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\t\n\r]+/g, ' ').replace(STRIP, '').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** @param {unknown} v @param {string[]} list @returns {string} */
function enumOr(v, list) {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/-/g, '_') : '';
  return list.includes(s) ? s : 'unknown';
}

/**
 * A repo-relative path, lexically inside the repo, or null.
 * @param {unknown} v @returns {string | null}
 */
function repoRelative(v) {
  if (typeof v !== 'string' || !v || v.length > PATH_MAX || /[\u0000-\u001f\u007f]/.test(v)) return null;
  const p = v.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const n = path.posix.normalize(p);
  if (n === '.' || n === '..' || n.startsWith('../') || n.startsWith('/')) return null;
  return n;
}

/** @param {unknown} v @returns {number | null} */
function lineOrNull(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 100000000 ? v : null;
}

/**
 * A verdict's per-check results (browse checks). Only a positive integer n, one of pass / fail /
 * unverified (anything else is unverified) and a cleaned note are kept. One entry per n: the most
 * severe result wins (fail, then unverified, then pass), so a duplicate cannot launder a failure.
 * @param {unknown} raw @param {number[]} [allowed] the spec's browse check numbers; others are dropped
 * @returns {{ n: number, result: 'pass' | 'fail' | 'unverified', note: string }[]}
 */
const MAX_CHECK_ENTRIES = 1000; // a safety cap on the raw array, applied before ranking, so a late `fail` is never cut off
function sanitizeChecks(raw, allowed) {
  const rank = { fail: 2, unverified: 1, pass: 0 };
  /** @type {Map<number, { n: number, result: 'pass' | 'fail' | 'unverified', note: string }>} */
  const by = new Map();
  for (const c of Array.isArray(raw) ? raw.slice(0, MAX_CHECK_ENTRIES) : []) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
    const n = c.n;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CHECKS) continue;
    if (allowed && !allowed.includes(n)) continue;
    const r = enumOr(c.result, CHECK_RESULTS);
    const result = /** @type {'pass' | 'fail' | 'unverified'} */ (r === 'unknown' ? 'unverified' : r);
    const prev = by.get(n);
    if (!prev || rank[result] > rank[prev.result]) by.set(n, { n, result, note: cleanText(c.note, CHECK_NOTE_MAX) });
  }
  return Array.from(by.values()).sort((x, y) => x.n - y.n);
}

/**
 * @param {unknown} verdict untrusted red-team verdict
 * @returns {{ outcome: string, findings: any[], context_requests: string[], checks: { n: number, result: 'pass' | 'fail' | 'unverified', note: string }[] }}
 */
function sanitizeVerdict(verdict) {
  const v = verdict && typeof verdict === 'object' && !Array.isArray(verdict) ? /** @type {Record<string, any>} */ (verdict) : {};
  const rawFindings = Array.isArray(v.findings) ? v.findings.slice(0, MAX_FINDINGS) : [];
  const findings = [];
  for (const f of rawFindings) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const file = repoRelative(f.file);
    findings.splice(findings.length, 0, {
      severity: enumOr(f.severity, SEVERITIES),
      kind: cleanText(f.kind, KIND_MAX) || 'unknown',
      file,
      line: file ? lineOrNull(f.line) : null,
      summary: cleanText(f.summary, SUMMARY_MAX),
    });
  }
  const context = [];
  for (const c of Array.isArray(v.context_requests) ? v.context_requests : []) {
    const p = repoRelative(c);
    if (p && context.length < MAX_CONTEXT) context.splice(context.length, 0, p);
  }
  return { outcome: enumOr(v.outcome, GATE_OUTCOMES), findings, context_requests: context, checks: sanitizeChecks(v.checks) };
}

/** @param {string | Buffer} bytes @returns {string} */
function sha256(bytes) { return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }

/** @param {Date} d @returns {string} yyyymmddThhmmssZ */
function compactUtc(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

const RUN_ID = /^rr_\d{8}T\d{6}Z_[0-9a-f]{7}$/;

/** @param {string} head sha, 7 to 40 hex @param {Date} [now] */
function makeRunId(head, now) {
  return 'rr_' + compactUtc(now || new Date()) + '_' + head.slice(0, 7).toLowerCase();
}

/** Task names become file names, so they are strict. @param {unknown} t @returns {string} */
function checkTask(t) {
  if (typeof t !== 'string' || !t) throw new SerenoError('invalid_arg', '--task is required');
  if (/[\\/:]/.test(t) || t.includes('..') || t.startsWith('.')) throw new SerenoError('path_refused', 'task name is not a plain name');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t) || /[.]$/.test(t)) throw new SerenoError('invalid_arg', 'task must be 1-64 chars of letters, digits, . _ -');
  return t;
}

module.exports = {
  sanitizeVerdict, sanitizeChecks, cleanText, enumOr, repoRelative, sha256, makeRunId, checkTask, compactUtc,
  RUN_ID, FINAL_OUTCOMES, BUILDERS, KINDS, DIAGNOSES, ATTEMPT_OUTCOMES, GATE_OUTCOMES, MAX_FINDINGS,
};
