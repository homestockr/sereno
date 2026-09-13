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
const DEFAULTS = { autoLaunch: false, launch: null };

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

/** Never throws: a missing or corrupt config just means defaults. */
function read() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch (_) { raw = null; }
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    autoLaunch: o.autoLaunch === true,
    launch: o.launch && typeof o.launch.exe === 'string' && o.launch.exe
      ? { exe: o.launch.exe, args: Array.isArray(o.launch.args) ? o.launch.args.map(String) : [] }
      : DEFAULTS.launch,
  };
}

/** Merges a patch in and returns the settings as they now stand on disk. */
function write(patch) {
  const next = Object.assign(read(), patch || {});
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

/**
 * Records how to start *this* build.
 *
 * The shim cannot work it out for itself: under ELECTRON_RUN_AS_NODE its own
 * process.execPath is whatever runtime the hook happened to use, and in a dev
 * checkout the app needs its directory passed as an argument. Rewriting this on
 * every boot is also what keeps auto-launch pointing at the right binary after
 * an update, a reinstall, or a move from the dev tree to a packaged install.
 */
function recordLaunch(spec) {
  const cur = read();
  const same = cur.launch && cur.launch.exe === spec.exe
    && JSON.stringify(cur.launch.args) === JSON.stringify(spec.args || []);
  if (same) return cur;
  return write({ launch: { exe: spec.exe, args: spec.args || [] } });
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
  read, write, recordLaunch, drainPending, clearLaunchLock,
};
