'use strict';
/*
 * The only bridge between the widget page and Electron. Window dragging is
 * handled by CSS (-webkit-app-region), so it needs no IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sereno', {
  quit: () => ipcRenderer.send('sereno:quit'),
  reportHeight: (height) => ipcRenderer.send('sereno:height', height),
  resizeWidthBy: (dx) => ipcRenderer.send('sereno:width-by', dx),
  nudgeZoom: (dir) => ipcRenderer.send('sereno:zoom-by', dir),
  setZoom: (z) => ipcRenderer.send('sereno:zoom-set', z),
  focusSession: (pid) => ipcRenderer.invoke('sereno:focus', pid),

  // A packaged install has no npm scripts, so setup happens in the UI.
  wiringStatus: () => ipcRenderer.invoke('sereno:wiring-status'),
  connect: (opts) => ipcRenderer.invoke('sereno:wire', opts || {}),
  disconnect: () => ipcRenderer.invoke('sereno:unwire'),

  // Sereno's own settings, which live nowhere near Claude Code's.
  settings: () => ipcRenderer.invoke('sereno:settings'),
  setAutoLaunch: (on) => ipcRenderer.invoke('sereno:set-auto-launch', !!on),
});
