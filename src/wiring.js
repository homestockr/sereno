'use strict';
/*
 * Reading and writing Claude Code's settings.json.
 *
 * Shared by the `wire`/`unwire` CLIs and by the app itself, because someone who
 * installed a packaged build has no npm scripts to run.
 *
 * Everything here merges. Existing hooks are preserved and ours are appended; an
 * existing statusLine is reported so the caller can confirm before replacing it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd',
];
// Events whose config entries carry a matcher field.
const MATCHED = new Set(['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'SessionEnd']);

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

/** Recognises our own entries across both dev and packaged forms. */
function isOurs(cmd) {
  return typeof cmd === 'string' && /emit\.(js|cmd)/i.test(cmd);
}

/**
 * The command Claude Code should invoke.
 *
 * Packaged builds must not assume Node exists on the machine - Claude Code
 * itself ships as a native binary - so the shim runs through Electron with
 * ELECTRON_RUN_AS_NODE, wrapped in a .cmd so the hook stays a single string.
 */
function buildCommands(opts) {
  const o = opts || {};
  const base = o.packaged
    ? `"${o.emitCmdPath}"`
    : `node "${String(o.emitJsPath).split(path.sep).join('/')}"`;
  return {
    statusLine: base + ' statusline',
    hook: (ev) => base + ' hook ' + ev,
  };
}

function readSettings() {
  const file = settingsPath();
  const existed = fs.existsSync(file);
  const raw = existed ? fs.readFileSync(file, 'utf8') : '{}\n';
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    const err = new Error('settings.json is not valid JSON, refusing to touch it: ' + e.message);
    err.code = 'EBADJSON';
    throw err;
  }
  return { file, existed, raw, settings: parsed };
}

/** Is the HUD currently installed? Cheap enough to poll. */
function status() {
  let s;
  try { s = readSettings(); } catch (e) { return { ok: false, error: e.message, wired: false }; }
  const sl = s.settings.statusLine;
  const statusWired = !!(sl && isOurs(sl.command));
  const hooks = s.settings.hooks || {};
  const wiredEvents = EVENTS.filter((ev) =>
    (Array.isArray(hooks[ev]) ? hooks[ev] : []).some((g) => (g.hooks || []).some((h) => isOurs(h.command))));
  return {
    ok: true,
    file: s.file,
    exists: s.existed,
    wired: statusWired && wiredEvents.length === EVENTS.length,
    statusLineWired: statusWired,
    foreignStatusLine: !!(sl && !isOurs(sl.command)) ? sl : null,
    wiredEvents,
    missingEvents: EVENTS.filter((e) => !wiredEvents.includes(e)),
  };
}

/**
 * Merges our entries in.
 * `replaceStatusLine` must be true to displace someone else's statusLine.
 * Returns { changes[], backup, needsStatusLineConfirm }.
 */
function wire(commands, options) {
  const opt = options || {};
  const s = readSettings();
  const settings = s.settings;
  const changes = [];

  const cur = settings.statusLine;
  let needsStatusLineConfirm = false;

  if (cur && isOurs(cur.command)) {
    if (cur.command !== commands.statusLine) {
      settings.statusLine = { type: 'command', command: commands.statusLine, padding: 0 };
      changes.push('statusLine: repointed at this build');
    }
  } else if (cur) {
    if (opt.replaceStatusLine) {
      settings.statusLine = { type: 'command', command: commands.statusLine, padding: 0 };
      changes.push('statusLine: REPLACED (previous value is in the backup)');
    } else {
      needsStatusLineConfirm = true;
    }
  } else {
    settings.statusLine = { type: 'command', command: commands.statusLine, padding: 0 };
    changes.push('statusLine: added');
  }

  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const mine = list.find((g) => (g.hooks || []).some((h) => isOurs(h.command)));
    if (mine) {
      // Repoint a stale path (dev -> packaged, or a moved install).
      let touched = false;
      for (const h of mine.hooks) {
        if (isOurs(h.command) && h.command !== commands.hook(ev)) { h.command = commands.hook(ev); touched = true; }
      }
      if (touched) changes.push('hooks.' + ev + ': repointed at this build');
      settings.hooks[ev] = list;
      continue;
    }
    const entry = { hooks: [{ type: 'command', command: commands.hook(ev), timeout: 5 }] };
    if (MATCHED.has(ev)) entry.matcher = '*';
    list.push(entry);                       // append: existing hooks are preserved
    settings.hooks[ev] = list;
    changes.push('hooks.' + ev + ': added');
  }

  if (needsStatusLineConfirm && !changes.length) {
    return { changes: [], backup: null, needsStatusLineConfirm: true };
  }
  if (!changes.length) return { changes: [], backup: null, needsStatusLineConfirm };

  if (opt.dryRun) return { changes, backup: null, needsStatusLineConfirm, dryRun: true };

  let backup = null;
  if (s.existed) {
    backup = s.file + '.bak.' + Date.now();
    fs.writeFileSync(backup, s.raw);
  } else {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
  }
  fs.writeFileSync(s.file, JSON.stringify(settings, null, 2) + '\n');
  return { changes, backup, needsStatusLineConfirm };
}

/**
 * Surgically removes only our own entries, leaving everything else untouched.
 *
 * This is what uninstall needs. Restoring a backup would also roll back any
 * unrelated settings changed since, and would not help at all if the newest
 * backup happens to predate a second wiring.
 */
function removeEntries() {
  const s = readSettings();
  const settings = s.settings;
  const removed = [];

  if (settings.statusLine && isOurs(settings.statusLine.command)) {
    delete settings.statusLine;
    removed.push('statusLine');
  }

  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const kept = hooks[ev]
      .map((group) => {
        const inner = (group.hooks || []).filter((h) => !isOurs(h.command));
        return inner.length ? Object.assign({}, group, { hooks: inner }) : null;
      })
      .filter(Boolean);
    if (kept.length !== hooks[ev].length) removed.push('hooks.' + ev);
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;

  if (!removed.length) return { removed: [], changed: false };
  fs.writeFileSync(s.file, JSON.stringify(settings, null, 2) + '\n');
  return { removed, changed: true };
}

function backups() {
  const file = settingsPath();
  const dir = path.dirname(file);
  const base = path.basename(file) + '.bak.';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .map((f) => ({ file: path.join(dir, f), ts: Number(f.slice(base.length)) || 0 }))
    .sort((a, b) => b.ts - a.ts);
}

/** Restores the newest backup byte for byte. */
function unwire() {
  const list = backups();
  if (!list.length) {
    const e = new Error('No settings.json backup found in ' + path.dirname(settingsPath()));
    e.code = 'ENOBACKUP';
    throw e;
  }
  const newest = list[0];
  fs.writeFileSync(settingsPath(), fs.readFileSync(newest.file));
  fs.unlinkSync(newest.file);
  return { restoredFrom: newest.file, remaining: list.length - 1 };
}

module.exports = {
  EVENTS, configDir, settingsPath, buildCommands,
  status, wire, unwire, removeEntries, backups, isOurs,
};
