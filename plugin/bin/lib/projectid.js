// @ts-check
'use strict';
/* The app's project id for a repo root. Copied from src/projects.js (normalizePath, projectId)
 * because the plugin must not require anything outside plugin/. A test keeps the two in step. */

const path = require('node:path');
const crypto = require('node:crypto');

/** @param {string} p */
function normalizePath(p) {
  const winLike = process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p);
  let s = winLike ? path.win32.resolve(p) : path.resolve(p);
  if (winLike) s = s.replace(/\\/g, '/').toLowerCase();
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** @param {string} root */
function projectId(root) {
  return crypto.createHash('sha1').update(normalizePath(root)).digest('hex').slice(0, 12);
}

module.exports = { normalizePath, projectId };
