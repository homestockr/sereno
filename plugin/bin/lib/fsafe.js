// @ts-check
'use strict';
/*
 * The plugin's only file writer. Every write goes through here.
 *
 * Rules: a target is a path relative to the repo root that starts with ".sereno/".
 * Each directory on the way (".sereno", ".sereno/gates", ...) is created if
 * needed and must be a real directory, not a symlink or junction, and its
 * realpath must equal the expected path inside the repo's realpath. Writes are
 * tmp + rename in the same directory. Anything else is refused with code
 * "path_refused".
 */

const fs = require('node:fs');
const path = require('node:path');

class SerenoError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(code, message, extra) { super(message); this.code = code; this.extra = extra || {}; }
}

const refuse = (/** @type {string} */ msg) => new SerenoError('path_refused', msg);
const fold = (/** @type {string} */ p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const MAX_BYTES = 1024 * 1024;

/**
 * Validate a repo-relative target and return its segments (starting at ".sereno").
 * @param {unknown} rel @returns {string[]}
 */
function segmentsOf(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || /[\u0000-\u001f]/.test(rel)) throw refuse('bad path');
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) throw refuse('absolute path refused');
  const segs = rel.split(/[\\/]/);
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || /[<>:"|?*]/.test(s) || /[. ]$/.test(s)) throw refuse('bad path segment');
  }
  if (segs[0] !== '.sereno' || segs.length < 2) throw refuse('only paths under .sereno/ are writable');
  return segs;
}

/** @param {string} repoRoot */
function createSafeFs(repoRoot) {
  const realRoot = fs.realpathSync.native(repoRoot);

  /** Make sure the directory chain is real; create it when asked. @returns {string | null} */
  function checkDir(/** @type {string[]} */ segs, /** @type {boolean} */ create) {
    let cur = realRoot;
    for (const s of segs) {
      const next = path.join(cur, s);
      let st = null;
      try { st = fs.lstatSync(next); } catch (_e) { st = null; }
      if (!st) {
        if (!create) return null;
        fs.mkdirSync(next);
        st = fs.lstatSync(next);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw refuse(s + ' is a symlink, junction or not a directory');
      if (fold(fs.realpathSync.native(next)) !== fold(next)) throw refuse(s + ' resolves outside the expected location');
      cur = next;
    }
    return cur;
  }

  /**
   * @param {string} rel repo-relative target, under .sereno/
   * @param {string | Buffer} data
   * @param {{ exclusive?: boolean }} [opts] exclusive: fail with code "exists" instead of replacing
   * @returns {string} absolute path written
   */
  function writeFile(rel, data, opts) {
    const segs = segmentsOf(rel);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new SerenoError('too_large', 'file too large');
    const dir = checkDir(segs.slice(0, -1), true);
    if (!dir) throw refuse('directory unavailable');
    const target = path.join(dir, segs[segs.length - 1]);
    let st = null;
    try { st = fs.lstatSync(target); } catch (_e) { st = null; }
    if (st && (st.isSymbolicLink() || !st.isFile())) throw refuse('target is not a regular file');
    const tmp = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2, 10) + '.tmp';
    try {
      fs.writeFileSync(tmp, data, { flag: 'wx' });
      if (opts && opts.exclusive) {
        try { fs.linkSync(tmp, target); }
        catch (e) {
          if (fs.existsSync(target)) throw new SerenoError('exists', 'target exists');
          if (e && /** @type {any} */ (e).code === 'EPERM') fs.renameSync(tmp, target);
          else throw e;
        }
      } else {
        fs.renameSync(tmp, target);
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch (_e) { /* already renamed or gone */ }
    }
    return target;
  }

  /** @param {string} rel @param {unknown} obj @param {{ exclusive?: boolean }} [opts] */
  function writeJson(rel, obj, opts) { return writeFile(rel, JSON.stringify(obj, null, 2) + '\n', opts); }

  /** File names in a directory under .sereno/, [] when it does not exist. @param {string} rel */
  function listDir(rel) {
    const dir = checkDir(segmentsOf(rel + '/x').slice(0, -1), false);
    return dir ? fs.readdirSync(dir) : [];
  }

  return { root: realRoot, writeFile, writeJson, listDir };
}

module.exports = { createSafeFs, SerenoError, MAX_BYTES };
