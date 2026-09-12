'use strict';
/*
 * Sereno — Electron main process. Owns the collector, the window, and the toast.
 */

const { app, BrowserWindow, ipcMain, Notification, screen, powerMonitor, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('./store.js');
const { createCollector } = require('./collector.js');
const wiring = require('./wiring.js');

const PORT = Number(process.env.CLAUDE_HUD_PORT) || 8787;

const DEFAULT_WIDTH = 380;        // CSS px, matches the mockup
const MIN_WIDTH = 300;
const MAX_WIDTH = 820;
const MIN_HEIGHT = 60;
const SWEEP_MS = 30 * 1000;

// Discrete steps beat free-form zoom: every stop stays on a crisp pixel grid.
const ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];

const stateDir = path.join(app.getPath('appData'), 'sereno');
const stateFile = path.join(stateDir, 'window.json');
const legacyStateFile = path.join(app.getPath('appData'), 'claude-hud', 'window.json');

let win = null;
let collector = null;
let ui = { x: null, y: null, width: DEFAULT_WIDTH, zoom: 1 };
let lastCssHeight = MIN_HEIGHT;

/* ---------- persistence ---------- */

function loadUi() {
  for (const file of [stateFile, legacyStateFile]) {
    try {
      const b = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        x: typeof b.x === 'number' ? b.x : null,
        y: typeof b.y === 'number' ? b.y : null,
        width: typeof b.width === 'number' ? b.width : DEFAULT_WIDTH,
        zoom: typeof b.zoom === 'number' ? b.zoom : 1,
      };
    } catch (_) { /* try the next one */ }
  }
  return { x: null, y: null, width: DEFAULT_WIDTH, zoom: 1 };
}

let saveTimer = null;
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        ui.x = x; ui.y = y;
      }
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(ui));
    } catch (_) {}
  }, 400);
}

/* ---------- geometry ---------- */

/**
 * Window pixels are content pixels times the zoom factor.
 *
 * setBounds, not setSize: on Windows a `transparent: true` window will GROW via
 * setSize but silently refuse to shrink, so zooming out left the widget stuck at
 * its widest. setBounds is not subject to that, verified across the flag matrix.
 * Do not "simplify" this back to setSize.
 */
function applySize() {
  if (!win || win.isDestroyed()) return;
  const w = Math.round(ui.width * ui.zoom);
  const h = Math.max(MIN_HEIGHT, Math.round(lastCssHeight * ui.zoom));
  const [cw, ch] = win.getSize();
  if (cw !== w || ch !== h) win.setBounds({ width: w, height: h });
}

function setZoom(z) {
  ui.zoom = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], z));
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(ui.zoom);
  applySize();
  clampToVisible();
  saveUi();
}

function nudgeZoom(dir) {
  // Step to the neighbouring stop rather than multiplying, so it never drifts.
  let i = ZOOM_STEPS.findIndex((z) => Math.abs(z - ui.zoom) < 0.001);
  if (i === -1) i = ZOOM_STEPS.reduce((best, z, k) =>
    Math.abs(z - ui.zoom) < Math.abs(ZOOM_STEPS[best] - ui.zoom) ? k : best, 0);
  setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)))]);
}

/** Keeps the window on a display that actually exists after a monitor change. */
function clampToVisible() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
  const nx = Math.min(Math.max(x, area.x), area.x + area.width - w);
  const ny = Math.min(Math.max(y, area.y), area.y + area.height - h);
  if (nx !== x || ny !== y) win.setPosition(Math.round(nx), Math.round(ny));
}

/* Electron quietly drops always-on-top across lock/unlock and display changes. */
function reassertOnTop() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  clampToVisible();
}

/* ---------- window ---------- */

function createWindow() {
  ui = loadUi();

  win = new BrowserWindow({
    width: Math.round(ui.width * ui.zoom),
    height: MIN_HEIGHT,
    x: ui.x === null ? undefined : ui.x,
    y: ui.y === null ? undefined : ui.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,      // sized programmatically; content drives the height
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // the waiting timer must keep ticking
      zoomFactor: ui.zoom,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (ui.x === null) {
    const area = screen.getPrimaryDisplay().workArea;
    win.setPosition(area.x + area.width - Math.round(ui.width * ui.zoom) - 24, area.y + 24);
  } else {
    clampToVisible();
  }

  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(ui.zoom));
  win.once('ready-to-show', () => win.show());
  win.on('moved', saveUi);
  win.on('closed', () => { win = null; });

  /*
   * The widget only ever shows our own page from 127.0.0.1. Anything trying to
   * leave that is a bug or an attack, so both exits are nailed shut:
   *
   *  - a new window may only hand http(s) to the OS browser. Without the scheme
   *    check, shell.openExternal would happily launch file:// or any registered
   *    protocol handler on the machine.
   *  - navigation away from the collector origin is refused outright, since the
   *    destination would inherit this window's preload bridge.
   */
  const isWebUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch (_) { return false; } };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) event.preventDefault();
  });

  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

/* ---------- toast ---------- */

function toastBlocked(session) {
  if (!Notification.isSupported()) return;
  try {
    const subject = [session.stateTool, session.stateArg].filter(Boolean).join(' · ');
    const n = new Notification({
      title: session.projectName + ' needs you',
      body: subject || 'Claude is waiting for permission',
      urgency: 'critical',
      timeoutType: 'never',
    });
    n.on('click', () => { if (win && !win.isDestroyed()) { win.showInactive(); reassertOnTop(); } });
    n.show();
  } catch (_) { /* a failed toast must never take the HUD down */ }
}

/* ---------- boot ---------- */

/* The shim paths this build owns. Wiring identity is path-based, so these are
   what let Sereno recognise its own settings entries and nobody else's. */
function shimCommands() {
  return wiring.buildCommands({
    packaged: app.isPackaged,
    // Packaged: resources/emit.cmd sits beside app.asar.unpacked/bin/emit.js.
    emitCmdPath: path.join(process.resourcesPath || "", "emit.cmd"),
    emitJsPath: path.join(__dirname, "..", "bin", "emit.js"),
  });
}

// The uninstaller runs `Sereno.exe --unwire` while the files still exist, so a
// removed install never leaves Claude Code calling a shim that is no longer there.
const CLI_UNWIRE = process.argv.includes('--unwire');

if (CLI_UNWIRE) {
  app.whenReady().then(() => {
    try { wiring.removeEntries([shimCommands().shimPath]); } catch (_) {}
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { win.showInactive(); reassertOnTop(); }
  });

  // Windows shows toasts only for a known AppUserModelID. Without this the
  // Notification silently never appears, which kills the whole point of the app.
  if (process.platform === 'win32') app.setAppUserModelId('Sereno');

  app.whenReady().then(() => {
    const store = new Store();
    store.onBlocked = toastBlocked;

    collector = createCollector(store, PORT);
    collector.listen((err, addr) => {
      if (err) {
        console.error('[sereno] cannot listen on ' + PORT + ': ' + err.code);
        app.quit();
        return;
      }
      console.log('[sereno] collector on http://127.0.0.1:' + addr.port);
      createWindow();
    });

    const sweep = setInterval(() => {
      // Re-broadcast regardless: `stale` is time-derived, so the view goes quiet
      // on its own even when no events are arriving.
      store.sweep();
      collector.broadcast();
    }, SWEEP_MS);
    sweep.unref();

    screen.on('display-metrics-changed', reassertOnTop);
    screen.on('display-added', reassertOnTop);
    screen.on('display-removed', reassertOnTop);
    powerMonitor.on('unlock-screen', reassertOnTop);
    powerMonitor.on('resume', reassertOnTop);
  });

  /* ---------- ipc ---------- */

  ipcMain.on('sereno:quit', () => app.quit());

  ipcMain.on('sereno:height', (_e, height) => {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return;
    lastCssHeight = Math.min(1400, h);
    applySize();
  });

  ipcMain.on('sereno:width-by', (_e, dx) => {
    const d = Number(dx);
    if (!Number.isFinite(d) || !d) return;
    ui.width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ui.width + d));
    applySize();
    clampToVisible();
    saveUi();
  });

  ipcMain.on('sereno:zoom-by', (_e, dir) => nudgeZoom(Number(dir) || 0));
  ipcMain.on('sereno:zoom-set', (_e, z) => setZoom(Number(z) || 1));

  /* Wiring, driven from the UI: a packaged install has no npm scripts to run. */


  ipcMain.handle('sereno:wiring-status', () => {
    const st = wiring.status([shimCommands().shimPath]);
    return Object.assign({ packaged: app.isPackaged }, st);
  });

  ipcMain.handle('sereno:wire', (_e, opts) => {
    try {
      const r = wiring.wire(shimCommands(), { replaceStatusLine: !!(opts && opts.replaceStatusLine) });
      return { ok: true, changes: r.changes, backup: r.backup, needsStatusLineConfirm: r.needsStatusLineConfirm };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('sereno:unwire', () => {
    try { return Object.assign({ ok: true }, wiring.removeEntries([shimCommands().shimPath])); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sereno:focus', async (_e, pid) => {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) return false;
    if (process.platform !== 'win32') return false;
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        // powershell.exe cannot read inside app.asar, so the script is unpacked
        // and the path has to be redirected to the unpacked tree.
        '-File', path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'focus-window.ps1'),
        '-TargetPid', String(target),
      ], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        resolve(!err && /^OK/.test(String(stdout).trim()));
      });
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (collector) collector.close(); });
}
