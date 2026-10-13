// @ts-check
'use strict';
/*
 * sereno.js context: bounded file contents for the red team, read from the
 * object database at the head commit (git show), never from the working tree.
 * A symlink in the worktree therefore cannot point the read outside the repo,
 * and a symlink committed in the tree is skipped, not followed.
 */

const { SerenoError } = require('./fsafe.js');
const gitlib = require('./git.js');
const rec = require('./records.js');

const MAX_FILES = 5;
const FILE_CAP = 32 * 1024;
const TOTAL_CAP = 96 * 1024;

/**
 * @param {{ root: string, head: string, files: string[] }} a head is a full commit id
 * @returns {{ files: { path: string, content: string | null, truncated: boolean }[], missing: string[] }}
 */
function readContext(a) {
  if (!a.files.length) throw new SerenoError('usage', 'name at least one repo-relative file');
  if (a.files.length > MAX_FILES) throw new SerenoError('invalid_arg', 'at most ' + MAX_FILES + ' files per request');
  const rels = [];
  for (const f of a.files) {
    const rel = rec.repoRelative(f);
    if (!rel) throw new SerenoError('path_refused', 'not a repo-relative path inside the repository: ' + String(f).slice(0, 80));
    if (!rels.includes(rel)) rels.splice(rels.length, 0, rel);
  }
  let budget = TOTAL_CAP;
  const files = [];
  const missing = [];
  for (const rel of rels) {
    const cap = Math.min(FILE_CAP, budget);
    const blob = cap > 0 ? gitlib.showBlob(a.root, a.head, rel, cap) : null;
    if (cap <= 0) { files.splice(files.length, 0, { path: rel, content: null, truncated: true }); continue; }
    if (!blob || blob.kind !== 'blob') { missing.splice(missing.length, 0, rel); continue; }
    if (blob.bytes.includes(0)) { files.splice(files.length, 0, { path: rel, content: null, truncated: false }); continue; }
    const truncated = blob.size > blob.bytes.length;
    let text = blob.bytes.toString('utf8');
    if (truncated) text = text.replace(/�+$/, '');
    budget -= Buffer.byteLength(text);
    files.splice(files.length, 0, { path: rel, content: text, truncated });
  }
  return { files, missing };
}

module.exports = { readContext, MAX_FILES, FILE_CAP, TOTAL_CAP };
