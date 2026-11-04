'use strict';
// The CPN IDE UI was written for Electron 4 with `remote` and nodeIntegration. This preload
// recreates just the surface it uses (dialogs, fs, BrowserWindow, ipcRenderer) on top of IPC.

const { ipcRenderer } = require('electron');

const isSplash = /\/splash\.html$/.test(decodeURIComponent(location.pathname));

if (isSplash) {
  window.cpnSplash = {
    onStatus: (cb) => ipcRenderer.on('splash:status', (_e, m) => cb(m)),
    onError: (cb) => ipcRenderer.on('splash:error', (_e, m) => cb(m)),
    retry: () => ipcRenderer.send('cpn:retry'),
    installDocker: () => ipcRenderer.send('cpn:install-docker'),
    showLog: () => ipcRenderer.send('cpn:show-log'),
  };
} else {
  installUiBridge();
}

function installUiBridge() {
  // Point the UI at our backend before its scripts read the settings.
  const DEFAULT_SETTINGS = {
    serverAddress: 'http://localhost:8080',
    globref: 'globref CONST = 1;',
    color: 'colset TYPE = unit;',
    var: 'var v:UNIT;',
    fun: 'fun Fun1() = [];',
    type: 'UNIT',
    initmark: 'empty',
    code: 'input();\noutput();\naction();',
    cond: '[]',
    time: '@+',
    priority: 'P_NORMAL',
    annot: '1`()',
    block: 'New block',
    monitorblock: 'New monitor block',
    declaration: '(* New declaration *)',
    page: 'New page',
    ellipse: { h: 40, w: 70 },
    box: { h: 40, w: 70 },
  };
  const cfg = ipcRenderer.sendSync('cpn:get-config');
  try {
    const stored = JSON.parse(localStorage.getItem('applicationSettings') || '{}');
    const merged = Object.assign({}, DEFAULT_SETTINGS, stored);
    if (cfg.backendUrl) merged.serverAddress = cfg.backendUrl;
    localStorage.setItem('applicationSettings', JSON.stringify(merged));
  } catch (e) {
    console.error('CPN IDE: could not store backend URL', e);
  }

  const lastFn = (args) => {
    for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === 'function') return args[i];
    return null;
  };
  const firstObj = (args) => Array.prototype.find.call(args, (a) => a && typeof a === 'object' && !Array.isArray(a)) || {};

  const fs = {
    readFile(file, ...rest) {
      const cb = lastFn(rest);
      ipcRenderer.invoke('cpn:read-file', String(file)).then(
        (text) => cb && cb(null, text),
        (err) => cb && cb(err),
      );
    },
    writeFile(file, data, ...rest) {
      const cb = lastFn(rest);
      ipcRenderer.invoke('cpn:write-file', String(file), String(data)).then(
        () => cb && cb(null),
        (err) => { if (cb) cb(err); else alert(`Speichern fehlgeschlagen: ${err.message}`); },
      );
    },
    writeFileSync(file, data) {
      const err = ipcRenderer.sendSync('cpn:write-file-sync', String(file), String(data));
      if (err) { alert(`Speichern fehlgeschlagen: ${err}`); throw new Error(err); }
    },
  };

  // Old (callback) dialog API. On cancel the callback is not called: the UI indexes into the result unguarded.
  const dialog = {
    showOpenDialog(...args) {
      const cb = lastFn(args);
      const p = ipcRenderer.invoke('cpn:open-dialog', JSON.parse(JSON.stringify(firstObj(args))));
      if (!cb) return p.then((paths) => ({ canceled: !paths, filePaths: paths || [] }));
      p.then((paths) => { if (paths && paths.length) cb(paths); });
      return undefined;
    },
    showSaveDialog(...args) {
      const cb = lastFn(args);
      const p = ipcRenderer.invoke('cpn:save-dialog', JSON.parse(JSON.stringify(firstObj(args))));
      if (!cb) return p.then((file) => ({ canceled: !file, filePath: file || undefined }));
      p.then((file) => { if (file) cb(file); });
      return undefined;
    },
  };

  function BrowserWindow() {}
  BrowserWindow.prototype.loadURL = function (url) { ipcRenderer.send('cpn:open-window', String(url)); };
  ['on', 'once', 'setMenu', 'setMenuBarVisibility', 'show', 'close', 'focus', 'removeMenu'].forEach((n) => {
    BrowserWindow.prototype[n] = function () {};
  });

  const shell = {
    openExternal(url) { ipcRenderer.send('cpn:open-external', String(url)); return Promise.resolve(); },
  };

  const electron = {
    ipcRenderer,
    dialog,
    shell,
    BrowserWindow,
    webFrame: { setZoomFactor() {}, setZoomLevel() {} },
  };
  electron.remote = {
    dialog,
    shell,
    BrowserWindow,
    process: { platform: process.platform, env: {}, versions: process.versions },
    getCurrentWindow: () => new BrowserWindow(),
    require(name) {
      if (name === 'fs') return fs;
      if (name === 'electron') return electron;
      throw new Error(`CPN IDE: module ${name} is not available`);
    },
  };

  window.require = function (name) {
    if (name === 'electron') return electron;
    if (name === 'fs') return fs;
    throw new Error(`CPN IDE: module ${name} is not available`);
  };

  // Menu commands from the main process, re-emitted under the channel names the UI listens to.
  ipcRenderer.on('cpn:menu', (event, channel) => ipcRenderer.emit(channel, event));

  ipcRenderer.on('cpn:edit', (event, what) => {
    const el = document.activeElement;
    const editing = el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (editing) document.execCommand(what);
    else ipcRenderer.emit(what === 'undo' ? 'main.menu.undo' : 'main.menu.redo', event);
  });
}
