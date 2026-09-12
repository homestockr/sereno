'use strict';
/*
 * Reading and writing Claude Code's settings.json.
 *
 * Shared by the `wire`/`unwire` CLIs and by the app itself, because someone who
 * installed a packaged build has no npm scripts to run.
 *
 * Everything here merges. Existing hooks are preserved and ours are appended; an
 * existing statusLine is reported so the caller can confirm before replacing it.
 *
 * IDENTITY IS PATH-BASED AND DELIBERATELY STRICT. An earlier version recognised
 * its own entries by matching /emit\.(js|cmd)/ against the command string, which
 * matched ANY tool whose shim happened to be called emit.js: uninstalling Sereno
 * deleted that tool's hooks, and wiring Sereno repointed them at itself. An entry
 * now counts as ours only when the shim path it references is one we know we
 * installed - this install's own paths, plus whatever earlier installs recorded
 * in the ledger below.
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

// Remembers which shim paths this machine has ever wired, so an install that has
// moved (dev checkout -> packaged build) still recognises and cleans up its own
// entries instead of orphaning them.
const LEDGER = path.join(os.homedir(), '.sereno', 'wired.json');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

/** The shim path a command string invokes, or null if it does not look like one. */
function shimPathOf(cmd) {
  const s = String(cmd || '');
  const quoted = s.match(/"([^"]*emit\.(?:js|cmd))"/i);
  if (quoted) return norm(quoted[1]);
  const bare = s.match(/([^\s"]*emit\.(?:js|cmd))/i);
  return bare ? norm(bare[1]) : null;
}

function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    return Array.isArray(j.shims) ? j.shims.map(norm) : [];
  } catch (_) { return []; }
}

function rememberShims(paths) {
  try {
    const all = new Set(readLedger());
    for (const p of paths) if (p) all.add(norm(p));
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify({ shims: [...all] }, null, 2));
  } catch (_) { /* the ledger is an optimisation, never a requirement */ }
}

/** Every shim path we are entitled to claim. */
function ownShims(extra) {
  const own = new Set(readLedger());
  for (const p of extra || []) if (p) own.add(norm(p));
  return [...own];
}

/**
 * Is this command one of ours?
 * Strict by design: an unknown path is somebody else's, never ours.
 */
function isOurs(cmd, own) {
  const p = shimPathOf(cmd);
  if (!p || !own || !own.length) return false;
  return own.includes(p);
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
  const shim = o.packaged ? o.emitCmdPath : String(o.emitJsPath).split(path.sep).join('/');
  const base = o.packaged ? `"${shim}"` : `node "${shim}"`;
  return {
    shimPath: shim,
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

/** Is Sereno currently installed? Cheap enough to poll. */
function status(extraShims) {
  let s;
  try { s = readSettings(); } catch (e) { return { ok: false, error: e.message, wired: false }; }
  const own = ownShims(extraShims);

  const sl = s.settings.statusLine;
  const statusWired = !!(sl && isOurs(sl.command, own));
  const hooks = s.settings.hooks || {};
  const wiredEvents = EVENTS.filter((ev) =>
    (Array.isArray(hooks[ev]) ? hooks[ev] : [])
      .some((g) => (g.hooks || []).some((h) => isOurs(h.command, own))));

  return {
    ok: true,
    file: s.file,
    exists: s.existed,
    wired: statusWired && wiredEvents.length === EVENTS.length,
    statusLineWired: statusWired,
    foreignStatusLine: sl && !isOurs(sl.command, own) ? sl : null,
    wiredEvents,
    missingEvents: EVENTS.filter((e) => !wiredEvents.includes(e)),
  };
}

/**
 * Merges our entries in.
 * `replaceStatusLine` must be true to displace someone else's statusLine.
 */
function wire(commands, options) {
  const opt = options || {};
  const s = readSettings();
  const settings = s.settings;
  const changes = [];
  const own = ownShims([commands.shimPath].concat(opt.extraShims || []));

  const cur = settings.statusLine;
  let needsStatusLineConfirm = false;

  if (cur && isOurs(cur.command, own)) {
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
    const mine = list.find((g) => (g.hooks || []).some((h) => isOurs(h.command, own)));
    if (mine) {
      // Repoint a stale path (dev -> packaged, or a moved install).
      let touched = false;
      for (const h of mine.hooks) {
        if (isOurs(h.command, own) && h.command !== commands.hook(ev)) {
          h.command = commands.hook(ev);
          touched = true;
        }
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
  rememberShims([commands.shimPath]);
  return { changes, backup, needsStatusLineConfirm };
}

/**
 * Removes only our own entries, leaving everything else untouched.
 *
 * This is what uninstall needs. Restoring a backup would also roll back any
 * unrelated settings changed since, and would not help at all if the newest
 * backup happens to predate a second wiring.
 *
 * Returns `skipped` for shim-looking entries we could not prove were ours; the
 * caller should surface them rather than deleting on suspicion.
 */
function removeEntries(extraShims) {
  const s = readSettings();
  const settings = s.settings;
  const own = ownShims(extraShims);
  const removed = [];
  const skipped = [];

  if (settings.statusLine) {
    if (isOurs(settings.statusLine.command, own)) {
      delete settings.statusLine;
      removed.push('statusLine');
    } else if (shimPathOf(settings.statusLine.command)) {
      skipped.push('statusLine: ' + settings.statusLine.command);
    }
  }

  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const kept = hooks[ev]
      .map((group) => {
        const inner = (group.hooks || []).filter((h) => {
          if (isOurs(h.command, own)) return false;
          if (shimPathOf(h.command)) skipped.push(ev + ': ' + h.command);
          return true;
        });
        return inner.length ? Object.assign({}, group, { hooks: inner }) : null;
      })
      .filter(Boolean);
    if (kept.length !== hooks[ev].length) removed.push('hooks.' + ev);
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;

  if (!removed.length) return { removed: [], skipped, changed: false };
  fs.writeFileSync(s.file, JSON.stringify(settings, null, 2) + '\n');
  return { removed, skipped, changed: true };
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
  EVENTS, LEDGER, configDir, settingsPath, buildCommands,
  status, wire, unwire, removeEntries, backups, isOurs, shimPathOf, ownShims,
};
