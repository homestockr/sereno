// @ts-check
'use strict';
/*
 * The spec review (plugin 0.5 H2): the red team reads a spec before any build.
 *
 *   needed    sereno.js spec-review-needed: decided from the config and the spec's kind, in code.
 *   sanitize  sereno.js spec-review: the verdict is untrusted; only the outcome and a few short
 *             points are kept.
 *   latest    sereno.js next: the recorded outcome for the spec's current revision.
 *
 * Records live in .sereno/spec-reviews/<task>-<spec_revision>.json, written through fsafe.
 */

const fs = require('node:fs');
const path = require('node:path');
const rec = require('./records.js');
const { SerenoError } = require('./fsafe.js');

const OUTCOMES = ['agree', 'revise', 'split'];
const MAX_POINTS = 8;
const POINT_MAX = 200;
const MAX_BYTES = 64 * 1024;

/**
 * Is a spec review wanted for a spec of this kind? No model decides this.
 * @param {{ config: any, kind: string | null }} a
 * @returns {{ needed: boolean, reason: string }}
 */
function needed(a) {
  const r = a.config && a.config.roles && a.config.roles.redTeam ? a.config.roles.redTeam : {};
  if (r.specReview !== true) return { needed: false, reason: 'roles.redTeam.specReview is off' };
  if (r.enabled === false) return { needed: false, reason: 'the red team is off' };
  const kinds = r.light && Array.isArray(r.light.kinds) ? r.light.kinds : [];
  if (a.kind && kinds.includes(a.kind)) return { needed: false, reason: 'a ' + a.kind + ' spec gets the light review, so no spec review' };
  return { needed: true, reason: 'the red team reviews the spec before the build' };
}

/**
 * @param {unknown} verdict untrusted
 * @returns {{ outcome: string, points: string[] }}
 */
function sanitize(verdict) {
  const v = verdict && typeof verdict === 'object' && !Array.isArray(verdict) ? /** @type {Record<string, any>} */ (verdict) : {};
  const outcome = rec.enumOr(v.outcome, OUTCOMES);
  if (outcome === 'unknown') throw new SerenoError('invalid_arg', 'a spec review outcome must be one of ' + OUTCOMES.join(', '));
  /** @type {string[]} */
  const points = [];
  for (const p of Array.isArray(v.points) ? v.points : []) {
    const t = rec.cleanText(p, POINT_MAX);
    if (t && points.length < MAX_POINTS) points[points.length] = t;
  }
  return { outcome, points };
}

/**
 * The recorded review of the task's spec at `revision`, or null. Unreadable or malformed records
 * count as no record.
 * @param {string} root @param {string} task @param {number} revision
 * @returns {{ outcome: string, points: string[] } | null}
 */
function latest(root, task, revision) {
  try {
    const file = path.join(root, '.sereno', 'spec-reviews', task + '-' + revision + '.json');
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || j.task !== task || j.spec_revision !== revision || !OUTCOMES.includes(j.outcome)) return null;
    return { outcome: j.outcome, points: Array.isArray(j.points) ? j.points.filter((/** @type {unknown} */ p) => typeof p === 'string').slice(0, MAX_POINTS) : [] };
  } catch (_e) { return null; }
}

module.exports = { OUTCOMES, MAX_POINTS, needed, sanitize, latest };
