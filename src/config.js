'use strict';
/*
 * Sereno's own settings, deliberately kept out of Claude Code's settings.json:
 * nothing here is Claude Code's business, and settings.json is a file we only
 * ever want to touch when wiring.
 *
 * This module is also the contract between the app and the hook shim. On a cold
 * session start bin/emit.js reads config.json to decide whether it may launch
 * the widget, and writes into pending/ so the event that triggered the launch is
 * not lost. The shim inlines its own copy of these paths on purpose - it runs
 * from the unpacked tree and must not reach into app.asar - so any change to the
 * layout below has to be mirrored there.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Opt-in. Starting a GUI app from somebody's shell hook is not a default.
const DEFAULTS = { autoLaunch: false, launch: null, ledger: { enabled: null, retentionDays: 90 } };

// A replay only makes sense while the session it describes is still fresh, and
// a crash loop must not be able to fill the queue with work for the next boot.
const PENDING_MAX_AGE_MS = 5 * 60 * 1000;
const PENDING_MAX_FILES = 64;

/** Overridable so tests never read or write the real user's config. */
function home() {
  return process.env.SERENO_HOME || path.join(os.homedir(), '.sereno');
}

const configFile = () => path.join(home(), 'config.json');
const pendingDir = () => path.join(home(), 'pending');
const launchLock = () => path.join(home(), 'launching');

/**
 * enabled is tri-state on purpose: null means "not asked yet", which is what
 * makes the first-launch dialog fire. Anything else that is not a real boolean
 * is treated as not asked rather than guessed at.
 */
function normalizeLedger(l) {
  const o = l && typeof l === 'object' ? l : {};
  const rd = o.retentionDays;
  return {
    enabled: o.enabled === true || o.enabled === false ? o.enabled : null,
    retentionDays: typeof rd === 'number' && Number.isFinite(rd) && rd > 0 ? rd : DEFAULTS.ledger.retentionDays,
  };
}

/** Never throws: a missing or corrupt config just means defaults. */
function read() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { raw = null; }
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    autoLaunch: o.autoLaunch === true,
    launch: o.launch && typeof o.launch.exe === 'string' && o.launch.exe
      ? Object.assign(
        { exe: o.launch.exe, args: Array.isArray(o.launch.args) ? o.launch.args.map(String) : [] },
        // Carried through deliberately. write() rebuilds the file from read(),
        // so anything read() drops is destroyed by the next unrelated write -
        // and the ⚙ toggle performs exactly such a write.
        o.launch.provisional === true ? { provisional: true } : null,
      )
      : DEFAULTS.launch,
    ledger: normalizeLedger(o.ledger),
  };
}

/** Merges a patch in and returns the settings as they now stand on disk. */
function write(patch) {
  const cur = read();
  const next = Object.assign({}, cur, patch || {});
  // Merged, not replaced: { ledger: { enabled: true } } must keep retentionDays.
  next.ledger = normalizeLedger(Object.assign({}, cur.ledger, patch && patch.ledger));
  fs.mkdirSync(home(), { recursive: true });
  // Written then renamed, for the same reason queuePending is: the shim reads
  // this file from another process on the hook path, and a bare truncating
  // write lets it see half a file and silently decline to launch.
  const tmp = configFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, configFile());
  return next;
}

/** Windows paths differ in case and separator and still name one file. */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (process.platform !== 'win32') return a === b;
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

/**
 * Records how to start *this* build.
 *
 * The shim cannot work it out for itself: under ELECTRON_RUN_AS_NODE its own
 * process.execPath is whatever runtime the hook happened to use, and in a dev
 * checkout the app needs its directory passed as an argument. Rewriting this on
 * every boot keeps auto-launch pointing at the right binary after an update, a
 * reinstall, or a move from the dev tree to a packaged install.
 *
 * `provisional` marks a build that lives somewhere temporary - a source
 * checkout, or a dist/ directory the next build recreates. Such a build may
 * SEED an empty slot, because refusing outright would leave auto-launch
 * switched on and doing nothing for somebody who only runs from source. What it
 * must not do is displace an installed copy: running from source once used to
 * silently repoint auto-launch at a tree that would not be there tomorrow, and
 * the next session start opened a dev build instead of the installed app.
 *
 * The test is identity and usability, NOT who got there first. A slot holding
 * another provisional seed is replaceable - otherwise a moved checkout could
 * never correct itself - and so is one naming an exe that no longer exists,
 * which is what an uninstall leaves behind. Both of those used to heal on the
 * next boot, because this function simply overwrote, and both must keep healing.
 *
 * Returns the settings as they now stand, which on a declined write is the
 * OTHER build's record rather than this one's.
 */
function recordLaunch(spec, opts) {
  const provisional = !!(opts && opts.provisional);
  const cur = read();

  if (provisional && cur.launch && !cur.launch.provisional) {
    let usable = false;
    try { usable = fs.statSync(cur.launch.exe).isFile(); } catch (_) { usable = false; }
    if (usable) return cur;   // a real install, still there: leave it alone
  }

  const same = cur.launch
    && samePath(cur.launch.exe, spec.exe)
    && JSON.stringify(cur.launch.args) === JSON.stringify(spec.args || [])
    && !!cur.launch.provisional === provisional;
  if (same) return cur;

  return write({
    launch: Object.assign(
      { exe: spec.exe, args: spec.args || [] },
      provisional ? { provisional: true } : null,
    ),
  });
}

/**
 * Takes everything the shim queued while we were starting, oldest first, and
 * removes it. Reading is best-effort per file: one unparseable entry must not
 * cost us the rest of the queue.
 */
function drainPending() {
  const dir = pendingDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }

  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  const out = [];
  // Names lead with a timestamp, so a lexical sort is chronological.
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    if (out.length < PENDING_MAX_FILES) {
      try {
        if (fs.statSync(file).mtimeMs >= cutoff) {
          const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (rec && rec.event && rec.payload) out.push(rec);
        }
      } catch (_) { /* skip it, but still delete it below */ }
    }
    // Unlink unconditionally: a file we could not read is a file we never can.
    try { fs.unlinkSync(file); } catch (_) {}
  }
  return out;
}

/**
 * Drops the shim's debounce marker. We are up, so the next cold start is a
 * genuine one and should not be swallowed by a lock this launch left behind.
 */
function clearLaunchLock() {
  try { fs.unlinkSync(launchLock()); } catch (_) {}
}

module.exports = {
  DEFAULTS, home, configFile, pendingDir, launchLock,
  normalizeLedger, read, write, recordLaunch, drainPending, clearLaunchLock,
};
