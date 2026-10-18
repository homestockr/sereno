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
const crypto = require('node:crypto');
const config = require('./config.js');

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'PreCompact', 'SessionEnd',
  'SubagentStart', 'StopFailure',
];
// Events whose config entries carry a matcher field.
const MATCHED = new Set(['PreToolUse', 'PostToolUse', 'PreCompact', 'SessionStart', 'SessionEnd']);

// Remembers which shim paths this machine has ever wired, so an install that has
// moved (dev checkout -> packaged build) still recognises and cleans up its own
// entries instead of orphaning them.
function ledgerPath() { return path.join(config.home(), 'wired.json'); }

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
    const j = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return Array.isArray(j.shims) ? j.shims.map(norm) : [];
  } catch (_) { return []; }
}

function rememberShims(paths) {
  try {
    const all = new Set(readLedger());
    for (const p of paths) if (p) all.add(norm(p));
    // Read-merge-write: wired.json also holds the telemetry record.
    const rec = readWiredRecord();
    rec.shims = [...all];
    writeWiredRecord(rec);
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
    hookCount: EVENTS.length,
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

/* ---------- telemetry (OTLP -> the collector) ---------- */

const TELEMETRY_ENDPOINT = 'http://127.0.0.1:8787';

/** The env block we ask Claude Code to export telemetry with. Never any OTEL_LOG_* key. */
function telemetryEnv(traces) {
  const env = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: TELEMETRY_ENDPOINT,
  };
  if (traces) {
    env.OTEL_TRACES_EXPORTER = 'otlp';
    env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA = '1';
  }
  return env;
}

/** Where we remember which env keys we set. Same file as the shim ledger in production. */
const wiredRecordPath = ledgerPath;

function readWiredRecord() {
  try {
    const j = JSON.parse(fs.readFileSync(wiredRecordPath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch (_) { return {}; }
}

/** Atomic (tmp + rename), preserving other keys (the shim ledger lives here too). */
function writeWiredRecord(rec) {
  const file = wiredRecordPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Merges telemetry env vars into settings.json (backup first, like wire()).
 *
 * CONFLICT RULE: any existing OTEL_* key (including OTEL_LOG_*, which are not
 * ours to judge) that we would not set, or would set to a different value, or a
 * differing CLAUDE_CODE_ENABLE_TELEMETRY / CLAUDE_CODE_ENHANCED_TELEMETRY_BETA,
 * means a foreign telemetry setup is present and ours must not be mixed into it.
 * We change nothing (no backup, no write) and return { conflict: [keys] }.
 * Identical values are fine (idempotent).
 *
 * @param {{traces?: boolean, dryRun?: boolean}} [options]
 */
function wireTelemetry(options) {
  const opt = options || {};
  const want = telemetryEnv(opt.traces !== false);
  const s = readSettings();
  const settings = s.settings;
  // A present-but-not-an-object env (array, string, number, null) is somebody's
  // malformed config: a conflict, never silently replaced.
  if ('env' in settings && !(settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env))) {
    return { conflict: ['env'], changes: [], backup: null };
  }
  const env = settings.env || null;

  const conflict = [];
  if (env) {
    for (const k of Object.keys(env)) {
      const isOtel = /^OTEL_/.test(k);
      const guarded = isOtel || k === 'CLAUDE_CODE_ENABLE_TELEMETRY' || k === 'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA';
      if (!guarded) continue;
      if (!(k in want)) { if (isOtel) conflict.push(k); continue; }
      if (String(env[k]) !== want[k]) conflict.push(k);
    }
  }
  if (conflict.length) return { conflict, changes: [], backup: null };

  const added = Object.keys(want).filter((k) => !env || !(k in env));
  if (!added.length) return { conflict: null, changes: [], backup: null };
  const changes = added.map((k) => 'env.' + k + ': added');
  if (opt.dryRun) return { conflict: null, changes, backup: null, dryRun: true };

  settings.env = env || {};
  for (const k of added) settings.env[k] = want[k];

  let backup = null;
  if (s.existed) {
    backup = s.file + '.bak.' + Date.now();
    fs.writeFileSync(backup, s.raw);
  } else {
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
  }
  fs.writeFileSync(s.file, JSON.stringify(settings, null, 2) + '\n');

  // Record only what we added: a key already present with our value is not ours to remove.
  const rec = readWiredRecord();
  const mine = Object.assign({}, rec.telemetry && rec.telemetry.env);
  for (const k of added) mine[k] = want[k];
  rec.telemetry = { env: mine };
  writeWiredRecord(rec);
  return { conflict: null, changes, backup };
}

/**
 * Removes the telemetry keys we set, but only those still holding the value we
 * set (a user-edited value stays), then clears the record. An empty `env` is
 * dropped. No record (wired.json missing or without telemetry): removes nothing.
 */
function unwireTelemetry() {
  const rec = readWiredRecord();
  const mine = rec.telemetry && rec.telemetry.env;
  if (!mine || typeof mine !== 'object') return { removed: [], kept: [], recorded: false };

  const s = readSettings();
  const settings = s.settings;
  const removed = [];
  const kept = [];
  if (settings.env && typeof settings.env === 'object') {
    for (const k of Object.keys(mine)) {
      if (!(k in settings.env)) continue;
      if (String(settings.env[k]) === mine[k]) { delete settings.env[k]; removed.push(k); }
      else kept.push(k);
    }
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  if (removed.length) fs.writeFileSync(s.file, JSON.stringify(settings, null, 2) + '\n');

  delete rec.telemetry;
  writeWiredRecord(rec);
  return { removed, kept, recorded: true };
}

/** Is there a telemetry record in wired.json (did we wire it)? */
function telemetryWired() {
  const t = readWiredRecord().telemetry;
  return !!(t && t.env && typeof t.env === 'object');
}

/** Human text for a wireTelemetry conflict, shared by the app and the CLI. */
function conflictMessage(keys) {
  return 'settings.json already configures telemetry (' + keys.join(', ') + '). '
    + 'Nothing was changed. Remove or align those keys to let Sereno wire telemetry.';
}

/* ---------- legacy /brief slash command (retired: the plugin ships /sereno:brief) ---------- */
// The app no longer installs this file. It only recognises a copy it wrote earlier
// (by the sha256 it recorded) so the user can remove it, and never touches any other.

const COMMAND_KEY = 'commands/brief.md';

function commandTargetPath() { return path.join(configDir(), 'commands', 'brief.md'); }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readIfExists(file) {
  try { return fs.readFileSync(file); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

/**
 * 'not-installed' (no file), 'installed' (the file still matches the sha256 Sereno
 * recorded, so it is ours and unedited) or 'conflict' (a file we did not write, or one
 * that was edited).
 */
function commandsStatus() {
  const cur = readIfExists(commandTargetPath());
  if (cur === null) return 'not-installed';
  const rec = readWiredRecord().commands;
  return rec && rec[COMMAND_KEY] === sha256(cur) ? 'installed' : 'conflict';
}

/** Removes brief.md only if it still matches the sha256 we recorded; otherwise keeps it. */
function uninstallCommands() {
  const rec = readWiredRecord();
  const want = rec.commands && rec.commands[COMMAND_KEY];
  if (typeof want !== 'string') return { removed: [], kept: [], recorded: false };
  const target = commandTargetPath();
  const cur = readIfExists(target);
  const removed = [];
  const kept = [];
  if (cur !== null) {
    if (sha256(cur) === want) { fs.unlinkSync(target); removed.push(COMMAND_KEY); }
    else kept.push(COMMAND_KEY);
  }
  delete rec.commands[COMMAND_KEY];
  if (!Object.keys(rec.commands).length) delete rec.commands;
  writeWiredRecord(rec);
  return { removed, kept, recorded: true };
}

/* ---------- Pipeline plugin detection ---------- */

const MAX_PLUGINS_FILE = 1024 * 1024;

const MAX_PLUGIN_RECORDS = 256;
const MAX_PLUGIN_VERSIONS = 8;

/** Parse "major.minor.patch[-pre]" into numbers, or null when it is not dotted numeric semver. */
function parseSemver(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' } : null;
}

/** Negative when a sorts after b (newer first). Unparseable sorts below parseable; ties return 0. */
function compareVersionsDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pb.n[i] - pa.n[i];
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return -1;
  if (!pb.pre) return 1;
  return -comparePre(pa.pre, pb.pre);
}

/** Semver prerelease precedence (ascending): numeric < alphanumeric, shorter prefix lower. */
function comparePre(a, b) {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) { const d = Number(x[i]) - Number(y[i]); if (d) return d < 0 ? -1 : 1; continue; }
    if (nx) return -1;
    if (ny) return 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/** Control and bidi/format characters never belong in a version string. */
const VERSION_JUNK = /[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Dedupe key: semver strings drop a leading v, build metadata and leading zeros; others stay as cleaned. */
function versionKey(s) {
  const p = parseSemver(s);
  return p ? p.n.join('.') + (p.pre ? '-' + p.pre : '') : s;
}

/**
 * Whether the Sereno pipeline plugin is installed in Claude Code. Reads
 * <home>/.claude/plugins/installed_plugins.json read-only: bounded, lstat'd, never
 * through a link. Never throws. Installs are per project, so every record is
 * considered: `version` is the newest, `versions` the distinct ones, newest first.
 * @param {string} [home]
 * @returns {{installed: boolean, detected?: boolean, version?: string|null, versions?: string[]}}
 */
function pluginStatus(home) {
  const none = { installed: false, detected: false };
  try {
    const file = path.join(home || os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_PLUGINS_FILE) return none;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, st.size, 0);
      text = buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
    const j = JSON.parse(text);
    const plugins = j && typeof j === 'object' ? j.plugins : null;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return none;
    if (!Object.prototype.hasOwnProperty.call(plugins, 'sereno@sereno')) return { installed: false, detected: true };
    const v = plugins['sereno@sereno'];
    const records = (Array.isArray(v) ? v.slice(0, MAX_PLUGIN_RECORDS) : [v]);
    const seen = [];
    const keys = new Set();
    for (const r of records) {
      if (r && typeof r === 'object' && typeof r.version === 'string') {
        const s = r.version.replace(VERSION_JUNK, '').trim().slice(0, 32);
        const k = s ? versionKey(s) : '';
        if (s && !keys.has(k)) { keys.add(k); seen.push(s); }
      }
    }
    const versions = seen.sort(compareVersionsDesc).slice(0, MAX_PLUGIN_VERSIONS);
    return { installed: true, version: versions.length ? versions[0] : null, versions };
  } catch (_) { return none; }
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
  EVENTS, ledgerPath, configDir, settingsPath, buildCommands,
  wireTelemetry, unwireTelemetry, telemetryWired, conflictMessage, telemetryEnv,
  uninstallCommands, commandsStatus, pluginStatus,
  status, wire, unwire, removeEntries, backups, isOurs, shimPathOf, ownShims,
};
