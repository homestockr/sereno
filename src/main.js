'use strict';
/*
 * Sereno — Electron main process. Owns the collector, the window, and the toast.
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, Notification, Tray,
  nativeImage, nativeTheme, screen, powerMonitor, shell } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('./store.js');
// The tray shares the collector's coalescing window rather than keeping its
// own copy of the number: they throttle the same flood for the same reason.
const { createCollector, BROADCAST_COALESCE_MS } = require('./collector.js');
const wiring = require('./wiring.js');
const config = require('./config.js');
const ledgerLife = require('./ledger-life.js');

const PORT = Number(process.env.CLAUDE_HUD_PORT) || 8787;

// Must stay in sync with build.appId in package.json — electron-builder stamps
// exactly this onto the Start Menu and desktop shortcuts it creates.
const APP_USER_MODEL_ID = 'com.sereno.widget';

// A dev run MUST NOT answer to the installed app's identity. Electron stamps
// whatever id is set here onto a Start Menu shortcut of its own, pointing at a
// bare electron.exe with no app path; if that shortcut shares an id with the
// real install, Windows resolves toast clicks to it and the user gets Electron's
// welcome screen instead of the widget. Suffixing keeps the two apart for good.
const DEV_APP_USER_MODEL_ID = APP_USER_MODEL_ID + '.dev';

const DEFAULT_WIDTH = 380;        // CSS px, matches the mockup
const MIN_WIDTH = 300;
const MAX_WIDTH = 820;
const MIN_HEIGHT = 60;
// electron-builder output directory, which lives inside the source tree.
const BUILD_OUTPUT = /[\\/]dist[\\/]win-unpacked[\\/]/i;
// Breathing room kept clear of the work area's edges, matching the gap the
// window is first placed at.
const SCREEN_MARGIN = 48;
// A ceiling on what the renderer may ask for. Not a layout constraint - the work
// area below is - just a guard against a nonsense value over IPC.
const MAX_REQUESTED_HEIGHT = 20000;
const SWEEP_MS = 30 * 1000;

// Discrete steps beat free-form zoom: every stop stays on a crisp pixel grid.
const ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];

const stateDir = path.join(app.getPath('appData'), 'sereno');
const stateFile = path.join(stateDir, 'window.json');
const legacyStateFile = path.join(app.getPath('appData'), 'claude-hud', 'window.json');

let win = null;
let collector = null;
let ui = { x: null, y: null, width: DEFAULT_WIDTH, zoom: 1, collapsed: false, trayHintShown: false };
let tray = null;
let trayState = null;      // '<state>/<theme>', so a theme flip repaints too
let trayTip = null;
let trayCounts = { total: 0, blocked: 0, active: 0, quiet: 0 };
let trayTimer = null;
let ledger = null;               // open spend ledger, or null when off / unavailable
let trayMenu = null;
let optInAsked = false;         // the dialog is shown at most once per run
let ledgerUnavailable = false;   // enabled in config but openLedger threw
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
        collapsed: b.collapsed === true,
        trayHintShown: b.trayHintShown === true,
      };
    } catch (_) { /* try the next one */ }
  }
  return { x: null, y: null, width: DEFAULT_WIDTH, zoom: 1, collapsed: false, trayHintShown: false };
}

let saveTimer = null;

function writeUi() {
  try {
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      ui.x = x; ui.y = y;
    }
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(ui));
  } catch (_) {}
}

/** Debounced: 'moved' fires continuously while a window is being dragged. */
function saveUi() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeUi, 400);
}

/** Quitting inside the debounce window would otherwise lose the last move. */
function flushUi() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeUi();
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
  const floor = MIN_HEIGHT;
  const want = Math.max(floor, Math.round(lastCssHeight * ui.zoom));

  // Never taller than the display can actually show. A fixed 1400px ceiling used
  // to leave the footer hanging off the bottom of a long session list with no way
  // to reach it - the widget has no chrome and nothing scrolled. The renderer
  // scrolls its row list against whatever height it ends up with.
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const ceiling = Math.max(floor, area.height - SCREEN_MARGIN);
  const h = Math.min(want, ceiling);

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
  // The height ceiling comes from the display, so a display change can move it.
  applySize();
  clampToVisible();
}

/* ---------- window ---------- */

function createWindow() {
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
  // Collapsed means the window is not on screen at all; the tray carries the
  // state instead. Showing it first and hiding it would flash the widget.
  win.once('ready-to-show', () => { if (!ui.collapsed) win.show(); });
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

/* ---------- tray ---------- */

/*
 * The collapsed form. It lives in the notification area rather than floating on
 * screen, so it is always in the same place and costs no room at all.
 *
 * Created once, at startup, and never destroyed: Windows treats a re-created
 * tray icon as a new one and can drop it back into the overflow flyout, so a
 * tray that came and went would need promoting out of the overflow every time.
 * It also doubles as the way back if the window ever ends up somewhere
 * unreachable.
 *
 * The marks are the row vocabulary at tray scale - see tools/make-tray-icons.js.
 * Shape carries the state; the count cannot survive 16px and lives in the
 * tooltip instead.
 */
/*
 * Windows does not invert a tray icon for you - that is a macOS template-image
 * behaviour - so each theme gets its own drawn set. Measured, a single
 * light-on-transparent set sat at 1.02:1 against Windows 11's light taskbar,
 * which is to say invisible, and 'busy' is the state that means work is
 * happening.
 */
function trayTheme() {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/*
 * Built from buffers rather than createFromPath so both scale factors come off
 * one image: 16px at 1x and 32px at 2x, which is what a DPI-scaled taskbar
 * asks for.
 */
function trayIcon(state) {
  const theme = trayTheme();
  const img = nativeImage.createEmpty();
  for (const [size, scale] of [[16, 1], [32, 2]]) {
    const file = path.join(__dirname, 'tray', state + '-' + theme + '-' + size + '.png');
    try {
      img.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: fs.readFileSync(file) });
    } catch (e) {
      console.error('[sereno] tray icon unreadable: ' + file + ' (' + e.message + ')');
    }
  }
  // An empty image is an invisible tray icon, and the tray is now the only way
  // back to a hidden window - so anything is better than nothing.
  if (img.isEmpty()) {
    const px = Buffer.alloc(16 * 16 * 4, 0xb0);
    return nativeImage.createFromBitmap(px, { width: 16, height: 16 });
  }
  return img;
}

function trayStateFor(counts) {
  if (counts.blocked > 0) return 'needs';
  if (counts.active > 0) return 'busy';
  return 'quiet';
}

function trayTooltip(counts) {
  if (counts.blocked > 0) {
    return 'Sereno — ' + counts.blocked +
      (counts.blocked === 1 ? ' session needs you' : ' sessions need you');
  }
  if (counts.active > 0) return 'Sereno — ' + counts.active + ' active';
  return counts.total > 0 ? 'Sereno — nothing waiting' : 'Sereno';
}

function showWindow(focus) {
  if (!win || win.isDestroyed()) return;
  if (ui.collapsed) { ui.collapsed = false; saveUi(); }
  // A toast click and a second launch used to call showInactive() directly and
  // leave ui.collapsed set, so the window was on screen while the state said
  // otherwise - the next tray click did nothing, and the next restart hid a
  // widget that had been in use all along.
  if (focus === false) win.showInactive(); else win.show();
  reassertOnTop();
}

/*
 * Said once, the first time the window goes away.
 *
 * Windows 11 puts a tray icon it has not seen before into the overflow flyout,
 * and an application cannot promote itself out of it - that is the user's
 * choice to make, and there is no API for it. So the one moment this can be
 * explained is the moment the window vanishes and the icon is not where the
 * user is looking. A toast is the right shape for it: it appears exactly then,
 * and it goes through the same AppUserModelID the permission alerts do.
 */
function trayHint() {
  if (ui.trayHintShown) return;
  // Marked before showing, so a toast that throws cannot nag on every collapse.
  // The cost is that an environment with notifications switched off spends the
  // one explanation without ever displaying it; the README carries the same
  // instruction for exactly that reason.
  ui.trayHintShown = true;
  saveUi();
  if (!Notification.isSupported()) return;
  try {
    new Notification({
      title: 'Sereno is in the notification area',
      body: 'Windows hides new icons behind the ⌃ arrow. Drag Sereno out of it once and it stays put.',
    }).show();
  } catch (_) { /* a failed hint must never take the app down */ }
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  if (!ui.collapsed) { ui.collapsed = true; saveUi(); }
  win.hide();
  // After hiding, so the toast does not appear over a window that is about to
  // disappear from under it.
  trayHint();
}

function paintTray() {
  if (!tray || tray.isDestroyed()) return;
  // Both of these are Shell_NotifyIcon calls, so both are guarded: the tray is
  // repainted only when what it shows actually differs.
  const key = trayStateFor(trayCounts) + '/' + trayTheme();
  if (key !== trayState) { trayState = key; tray.setImage(trayIcon(trayStateFor(trayCounts))); }
  // Composed here, not in trayTooltip: that one is a pure function of the counts.
  const tip = trayTooltip(trayCounts) + (ledgerUnavailable ? ' · Spend history unavailable' : '');
  if (tip !== trayTip) { trayTip = tip; tray.setToolTip(tip); }
}

/*
 * Coalesced on the same footing as the collector's broadcast, and for the same
 * reason its comment gives: the statusline fires roughly per session per 1.5s,
 * and building a full snapshot on each one - sorting every session, mapping
 * every subagent - to read four integers off it is work nobody asked for.
 */
function updateTray(counts) {
  trayCounts = counts;
  if (trayTimer) return;
  trayTimer = setTimeout(() => { trayTimer = null; paintTray(); }, BROADCAST_COALESCE_MS);
  if (trayTimer.unref) trayTimer.unref();
}

function createTray(store) {
  tray = new Tray(trayIcon('quiet'));
  trayState = 'quiet';
  tray.setToolTip('Sereno');

  // Left click only ever shows. The tray exists to get the widget back, and a
  // toggle here can land on hidden: Windows users double-click by habit, and
  // the second click of a double-click has historically arrived as a plain
  // click. Hiding stays on the header button and the menu item below.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());

  trayMenu = Menu.buildFromTemplate([
    { label: 'Show Sereno', click: showWindow },
    { label: 'Hide to tray', click: hideWindow },
    { type: 'separator' },
    {
      id: 'ledger', label: 'Keep spend history', type: 'checkbox',
      checked: config.read().ledger.enabled === true,
      click: (item) => setLedgerEnabled(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit Sereno', click: () => app.quit() },
  ]);
  tray.setContextMenu(trayMenu);

  updateTray(store.snapshot().counts);
}

/* ---------- spend ledger ---------- */

/** Closes whatever is open, then opens per config. Never throws. */
function applyLedgerConfig() {
  try { if (ledger) ledger.close(); } catch (_) {}
  ledger = null;
  const r = ledgerLife.startLedger(config.read(), {
    log: (m) => console.log('[sereno] ' + m),
    error: (m) => console.error('[sereno] ' + m),   // once per start attempt
  });
  ledger = r.ledger;
  ledgerUnavailable = r.unavailable;
  if (collector) collector.setLedger(ledger);
  const item = trayMenu && trayMenu.getMenuItemById('ledger');
  if (item) item.checked = config.read().ledger.enabled === true;
  paintTray();
}

function setLedgerEnabled(on) {
  try { config.write({ ledger: { enabled: !!on } }); }
  catch (e) { console.error('[sereno] could not save spend history setting: ' + e.message); return; }
  applyLedgerConfig();
}

/**
 * One question, asked until it gets an answer: dismissing it leaves null.
 * Async and parentless, and called only once the collector and window are up:
 * a blocking dialog at boot would leave the hook that launched us with a dead
 * port and lose its session and alerts.
 */
function askLedgerOptIn() {
  if (optInAsked || config.read().ledger.enabled !== null) return;
  optInAsked = true;
  dialog.showMessageBox({
    type: 'question',
    message: ledgerLife.OPT_IN_MESSAGE,
    detail: ledgerLife.OPT_IN_DETAIL,
    buttons: ledgerLife.OPT_IN_BUTTONS,
    defaultId: 0,
    cancelId: ledgerLife.OPT_IN_BUTTONS.length,   // dismissal: not an answer
    noLink: true,
  }).then(({ response }) => {
    const answer = ledgerLife.optInAnswer(response);
    if (answer === null) return;
    config.write({ ledger: { enabled: answer } });
    applyLedgerConfig();
    // Step 5: offer telemetry wiring here (separate confirmation).
  }).catch((e) => console.error('[sereno] opt-in dialog failed: ' + e.message));
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
    n.on('click', () => showWindow(false));
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
  // Launching it again is the natural "where did it go?" move, so it has to
  // properly un-collapse rather than just put a window on screen.
  app.on('second-instance', () => showWindow(false));

  // Windows keys both toast delivery and taskbar identity off the AppUserModelID,
  // and only honours one that a Start Menu shortcut actually carries. The NSIS
  // installer stamps its shortcuts with build.appId, so the running app has to
  // claim that same string: mismatch, and Windows treats the pinned shortcut and
  // the live window as two unrelated apps, and drops every toast on the floor.
  //
  // Never set this to a file path. Windows happily accepts one, then launches
  // that executable when a toast is clicked - which for electron.exe means the
  // welcome screen, not the widget.
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? APP_USER_MODEL_ID : DEV_APP_USER_MODEL_ID);
  }

  app.whenReady().then(() => {
    const store = new Store();
    store.onBlocked = toastBlocked;

    // Refresh the launch command on every boot, so auto-launch keeps pointing at
    // this build after an update, a reinstall, or a move out of the dev tree.
    // An unpackaged run only fills the slot if it is empty: see recordLaunch.
    try {
      config.recordLaunch(
        app.isPackaged
          ? { exe: process.execPath, args: [] }
          // Unpackaged, electron.exe needs to be told which app to run.
          : { exe: process.execPath, args: [app.getAppPath()] },
        // isPackaged is not a proxy for "installed": dist/win-unpacked is a
        // packaged build sitting inside the checkout, which the next build
        // recreates. Launching one to eyeball a change must not claim the slot
        // either - and that case is harder to undo, since only the real install
        // can take it back.
        { provisional: !app.isPackaged || BUILD_OUTPUT.test(process.execPath) },
      );
    } catch (_) { /* a read-only home must not stop the widget starting */ }

    // Whatever the shim captured while we were booting. Done before the collector
    // accepts anyone, so the first snapshot a client sees already has it.
    for (const rec of config.drainPending()) {
      try {
        store.applyHook(rec.event, rec.payload,
          { ppid: typeof rec.ppid === 'number' ? rec.ppid : null });
      } catch (_) { /* one bad replay must not cost the rest */ }
    }
    config.clearLaunchLock();

    // Before the tray, so it reads the persisted state rather than the module
    // defaults - on a collapsed restart the click handler would otherwise be
    // wrong about what a click should do.
    ui = loadUi();

    // Ledger per current config (null = off); the opt-in is asked after startup.
    applyLedgerConfig();

    // A tray is a nicety; the widget is not. An icon Windows refuses must not
    // take the rest of this callback - collector, window, everything - with it.
    try {
      createTray(store);
      nativeTheme.on('updated', () => { trayState = null; paintTray(); });
    } catch (e) {
      tray = null;
      console.error('[sereno] running without a tray: ' + e.message);
    }

    collector = createCollector(store, PORT, { ledger });

    // createCollector takes store.onChange for its broadcast; chain the tray on
    // rather than replacing it, so both stay in step with every event.
    const broadcast = store.onChange;
    store.onChange = () => { broadcast(); updateTray(store.snapshot().counts); };
    collector.listen((err, addr) => {
      if (err) {
        console.error('[sereno] cannot listen on ' + PORT + ': ' + err.code);
        app.quit();
        return;
      }
      console.log('[sereno] collector on http://127.0.0.1:' + addr.port);
      createWindow();
      askLedgerOptIn();
    });

    const sweep = setInterval(() => {
      // Re-broadcast regardless: `stale` is time-derived, so the view goes quiet
      // on its own even when no events are arriving.
      store.sweep();
      collector.broadcast();
      // sweep() ages sessions out on a timer rather than on an event, so the
      // tray would otherwise keep claiming work that has gone quiet.
      updateTray(store.snapshot().counts);
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

  // Collapsing takes the window off screen entirely; the tray carries the state
  // from then on. Nothing is resized, which is why none of the puck's geometry
  // - its own floors, its measured width, the creep it caused at a screen edge
  // - needs to exist any more.
  ipcMain.on('sereno:collapse', (_e, collapsed) => {
    if (collapsed) hideWindow(); else showWindow();
  });

  ipcMain.on('sereno:height', (_e, height) => {
    const h = Number(height);
    if (!Number.isFinite(h) || h <= 0) return;
    lastCssHeight = Math.min(MAX_REQUESTED_HEIGHT, h);
    applySize();
    // A window that just grew can hang off the bottom of the screen.
    clampToVisible();
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


  ipcMain.handle('sereno:settings', () => {
    try { return Object.assign({ ok: true }, config.read()); }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('sereno:set-auto-launch', (_e, on) => {
    try { return Object.assign({ ok: true }, config.write({ autoLaunch: !!on })); }
    catch (e) { return { ok: false, error: e.message }; }
  });

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
  app.on('before-quit', () => {
    flushUi();
    if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
    if (collector) collector.close();
    try { if (ledger) ledger.close(); } catch (_) {}
    ledger = null;
  });
}
