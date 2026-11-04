'use strict';
// CPN IDE for macOS: hosts the official CPN IDE Angular UI and runs its backend
// (Java + 32-bit CPN simulator) in a Docker container, since the simulator has no macOS build.
// Every window is an independent workspace with its own backend container, so two models
// can be edited and simulated side by side.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const { execFile, spawn } = require('child_process');

const IMAGE = 'ghcr.io/alefire99/cpn-ide-backend:latest';
// CPN_IDE_DEV_TAG=x runs a fully separate instance (own containers, data dir and lock), e.g. for testing
// next to the installed app without touching its backends.
const DEV_TAG = (process.env.CPN_IDE_DEV_TAG || '').replace(/[^a-z0-9-]/gi, '');
const CONTAINER_PREFIX = DEV_TAG ? `cpn-ide-mac-${DEV_TAG}-backend` : 'cpn-ide-mac-backend';
const CONTAINER_LABEL = DEV_TAG ? `app=cpn-ide-mac-${DEV_TAG}` : 'app=cpn-ide-mac';
const UI_INDEX = path.join(__dirname, '..', 'ui', 'index.html');
const SPLASH = path.join(__dirname, 'splash.html');

const workspaces = new Map(); // BrowserWindow id -> Workspace
let backendsStopped = false;
const pendingStartupFiles = [];
const logLines = [];

function log(line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  for (const l of text.split('\n')) logLines.push(`[${new Date().toISOString().slice(11, 19)}] ${l}`);
  if (logLines.length > 3000) logLines.splice(0, logLines.length - 3000);
}

// ---------- Docker ----------

const DOCKER_CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  path.join(os.homedir(), '.docker/bin/docker'),
  path.join(os.homedir(), '.orbstack/bin/docker'),
  '/opt/local/bin/docker',
  '/usr/bin/docker',
];

function findDocker() {
  return DOCKER_CANDIDATES.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
}

// GUI apps get a minimal PATH; the docker CLI needs its credential helpers on it.
function dockerEnv(dockerPath) {
  const dirs = [path.dirname(dockerPath), '/Applications/Docker.app/Contents/Resources/bin',
    '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { ...process.env, PATH: [...new Set(dirs)].join(':') };
}

function docker(args, { timeout = 60000, onLine } = {}) {
  const bin = findDocker();
  return new Promise((resolve) => {
    if (!bin) return resolve({ code: -1, stdout: '', stderr: 'docker not found' });
    const child = spawn(bin, args, { env: dockerEnv(bin) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { stdout += d; if (onLine) String(d).split('\n').forEach((l) => l.trim() && onLine(l.trim())); });
    child.stderr.on('data', (d) => { stderr += d; if (onLine) String(d).split('\n').forEach((l) => l.trim() && onLine(l.trim())); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function httpUp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

class BackendError extends Error {
  constructor(message, action) { super(message); this.action = action; }
}

async function ensureDaemon(status) {
  if (!findDocker()) {
    throw new BackendError('Docker was not found. On macOS the CPN simulator only runs in Docker. Please install Docker Desktop and restart the app.', 'install-docker');
  }
  let info = await docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 });
  if (info.code === 0) return;
  status('Starting Docker Desktop …');
  if (fs.existsSync('/Applications/Docker.app')) execFile('/usr/bin/open', ['-g', '-a', 'Docker']);
  else if (fs.existsSync('/Applications/OrbStack.app')) execFile('/usr/bin/open', ['-g', '-a', 'OrbStack']);
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    info = await docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 10000 });
    if (info.code === 0) return;
  }
  throw new BackendError('Docker is not running. Please start Docker Desktop and click "Try again".', 'retry');
}

let pulling = null;

async function ensureImage(status) {
  const img = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeout: 20000 });
  if (img.code === 0) return;
  // One pull for all windows that start at the same time.
  if (!pulling) {
    pulling = (async () => {
      let last = 0;
      const pull = await docker(['pull', '--platform', 'linux/amd64', IMAGE], {
        timeout: 30 * 60000,
        onLine: (l) => {
          log(l);
          if (Date.now() - last < 700) return;
          last = Date.now();
          for (const ws of workspaces.values()) ws.status(`Download: ${l}`);
        },
      });
      if (pull.code !== 0) throw new BackendError(`Could not download the backend image:\n${pull.stderr.slice(-500)}`, 'retry');
    })().finally(() => { pulling = null; });
  }
  status('Downloading the CPN backend (once, about 400 MB) …');
  await pulling;
}

// ---------- files ----------

// .cpn files are usually iso-8859-1; honour the XML declaration in both directions.
function xmlEncoding(textOrBuf) {
  const head = Buffer.isBuffer(textOrBuf) ? textOrBuf.subarray(0, 200).toString('latin1') : String(textOrBuf).slice(0, 200);
  const m = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head);
  const enc = m ? m[1].toLowerCase() : 'utf-8';
  return /8859-1|latin-?1|windows-1252/.test(enc) ? 'latin1' : 'utf8';
}

function readModel(file) {
  const buf = fs.readFileSync(file);
  return buf.toString(xmlEncoding(buf));
}

function writeModel(file, text) {
  const enc = xmlEncoding(text);
  const out = enc === 'latin1' ? String(text).replace(/[^\x00-\xff]/g, (c) => `&#${c.codePointAt(0)};`) : String(text);
  fs.writeFileSync(file, out, enc);
}

// ---------- workspaces (one per window) ----------

function freeSlot() {
  const used = new Set([...workspaces.values()].map((w) => w.slot));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

class Workspace {
  constructor(file) {
    this.slot = freeSlot();
    this.container = this.slot === 1 ? CONTAINER_PREFIX : `${CONTAINER_PREFIX}-${this.slot}`;
    this.port = null;
    this.ready = false;
    this.starting = null;
    this.unsaved = false;
    this.closeConfirmed = false;
    this.currentFile = null;
    this.pendingOpen = file ? [file] : [];

    const offset = (this.slot - 1) * 28;
    const focused = BrowserWindow.getFocusedWindow();
    const base = focused ? focused.getBounds() : null;
    this.win = new BrowserWindow({
      width: 1440,
      height: 900,
      ...(base ? { x: base.x + 28, y: base.y + 28 } : offset ? { x: 60 + offset, y: 40 + offset } : {}),
      minWidth: 900,
      minHeight: 600,
      title: 'CPN IDE',
      backgroundColor: '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        // Own storage per slot: the UI keeps the backend address in localStorage.
        partition: `persist:cpn-window-${this.slot}`,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    workspaces.set(this.win.id, this);
    this.wireWindow();
    this.win.loadFile(SPLASH);
    this.win.webContents.once('did-finish-load', () => this.boot());
  }

  alive() { return this.win && !this.win.isDestroyed(); }

  status(text) {
    log(`[${this.slot}] ${text}`);
    if (this.alive()) this.win.webContents.send('splash:status', { text });
  }

  send(channel) {
    if (this.alive() && this.ready) this.win.webContents.send('cpn:menu', channel);
  }

  hasModel() { return !!this.currentFile || this.unsaved; }

  openFile(file) {
    this.pendingOpen.push(file);
    if (this.ready && !this.starting) this.send('main.menu.open.project');
    if (this.alive()) this.win.focus();
  }

  setCurrentFile(file) {
    this.currentFile = file;
    if (!this.alive()) return;
    this.win.setTitle(file ? `${path.basename(file)} – CPN IDE` : 'CPN IDE');
    this.win.setRepresentedFilename(file || '');
    if (file) app.addRecentDocument(file);
  }

  setUnsaved(v) {
    this.unsaved = v;
    if (this.alive()) this.win.setDocumentEdited(v);
  }

  async existingPort() {
    const running = await docker(['inspect', '-f', '{{.State.Running}}', this.container], { timeout: 15000 });
    if (running.code !== 0 || running.stdout !== 'true') return null;
    const port = await docker(['port', this.container, '8080/tcp'], { timeout: 15000 });
    const m = /:(\d+)\s*$/m.exec(port.stdout);
    return m ? Number(m[1]) : null;
  }

  async startBackend() {
    this.ready = false;
    const status = (t) => this.status(t);
    status('Checking Docker …');
    await ensureDaemon(status);

    const reuse = await this.existingPort();
    if (reuse && await httpUp(reuse)) {
      this.port = reuse;
      this.ready = true;
      status(`Found a running backend on port ${reuse}.`);
      return;
    }

    await ensureImage(status);
    await docker(['rm', '-f', this.container], { timeout: 30000 });
    this.port = await freePort();
    status('Starting the CPN backend …');
    // tmpfs: the emulated 32-bit simulator cannot list directories on ext4 (64-bit readdir offsets),
    // which makes "setting model paths" fail with SysErr.
    const run = await docker([
      'run', '-d', '--rm', '--name', this.container, '--platform', 'linux/amd64',
      '--label', CONTAINER_LABEL,
      '--tmpfs', '/data:rw,exec,mode=1777', '--tmpfs', '/tmp:rw,exec,mode=1777',
      '-p', `127.0.0.1:${this.port}:8080`, IMAGE,
    ], { timeout: 120000 });
    if (run.code !== 0) throw new BackendError(`The backend container does not start:\n${run.stderr.slice(-500)}`, 'retry');
    log(`[${this.slot}] container ${this.container} (${run.stdout.slice(0, 12)}) on port ${this.port}`);

    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      if (!this.alive()) return;
      if (await httpUp(this.port)) {
        this.ready = true;
        status(`Backend ready (${Math.round((Date.now() - t0) / 1000)} s).`);
        return;
      }
      const alive = await docker(['inspect', '-f', '{{.State.Running}}', this.container], { timeout: 15000 });
      if (alive.code !== 0 || alive.stdout !== 'true') {
        throw new BackendError('The backend container stopped unexpectedly.', 'retry');
      }
      status(`Starting the CPN backend … ${Math.round((Date.now() - t0) / 1000)} s`);
      await sleep(1500);
    }
    throw new BackendError('The backend did not respond in time.', 'retry');
  }

  stopBackend() {
    this.ready = false;
    return docker(['rm', '-f', this.container], { timeout: 20000 });
  }

  boot() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        await this.startBackend();
        if (this.alive()) {
          await this.win.loadFile(UI_INDEX);
          // A window closed while its backend was starting would leave the container behind.
        } else {
          await this.stopBackend();
        }
      } catch (e) {
        log(`[${this.slot}] ERROR ${e.stack || e}`);
        if (this.alive()) this.win.webContents.send('splash:error', { text: e.message, action: e.action || 'retry' });
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  async restartBackend() {
    if (this.alive()) await this.win.loadFile(SPLASH);
    await this.stopBackend();
    await this.boot();
  }

  wireWindow() {
    const win = this.win;
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 700 } };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
    });
    win.on('close', (e) => {
      if (this.closeConfirmed || !this.unsaved) return;
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Save', 'Cancel', "Don't Save"],
        defaultId: 0,
        cancelId: 1,
        message: `Save changes to "${this.currentFile ? path.basename(this.currentFile) : 'model'}"?`,
        detail: 'Your changes will be lost if you don\'t save them.',
      });
      if (choice === 2) { this.closeConfirmed = true; return; }
      e.preventDefault();
      if (choice === 0) this.send('main.menu.save.project');
    });
    win.on('closed', () => {
      workspaces.delete(win.id);
      this.win = null;
      this.stopBackend();
    });
  }
}

function newWindow(file) {
  return new Workspace(file);
}

// Finder / Dock: reuse a window that has no model yet, otherwise open a new one.
function openFileFromOS(file) {
  if (!app.isReady()) { pendingStartupFiles.push(file); return; }
  const empty = [...workspaces.values()].find((w) => !w.hasModel() && !w.pendingOpen.length);
  if (empty) empty.openFile(file);
  else newWindow(file);
}

function wsFor(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return win ? workspaces.get(win.id) : null;
}

function focusedWs(win) {
  const w = win || BrowserWindow.getFocusedWindow();
  return w ? workspaces.get(w.id) : null;
}

// ---------- IPC ----------

ipcMain.on('cpn:get-config', (e) => {
  const ws = wsFor(e.sender);
  e.returnValue = { backendUrl: ws && ws.port ? `http://127.0.0.1:${ws.port}` : null };
});

ipcMain.handle('cpn:open-dialog', async (e, options) => {
  const ws = wsFor(e.sender);
  if (ws && ws.pendingOpen.length) return [ws.pendingOpen.shift()];
  const r = await dialog.showOpenDialog(ws ? ws.win : undefined, {
    properties: ['openFile'],
    filters: (options && options.filters) || [{ name: 'CPN models', extensions: ['cpn', 'CPN'] }],
  });
  return r.canceled ? null : r.filePaths;
});

ipcMain.handle('cpn:save-dialog', async (e, options) => {
  const ws = wsFor(e.sender);
  const r = await dialog.showSaveDialog(ws ? ws.win : undefined, {
    title: 'Save As',
    defaultPath: (options && options.defaultPath) || (ws && ws.currentFile ? path.basename(ws.currentFile) : 'model.cpn'),
    filters: (options && options.filters) || [{ name: 'CPN models', extensions: ['cpn', 'CPN'] }],
  });
  return r.canceled ? null : r.filePath;
});

function markFile(e, file) {
  const ws = wsFor(e.sender);
  if (ws && /\.cpn$/i.test(file)) { ws.setCurrentFile(file); ws.setUnsaved(false); }
}

ipcMain.handle('cpn:read-file', async (e, file) => {
  const text = readModel(file);
  markFile(e, file);
  return text;
});

ipcMain.handle('cpn:write-file', async (e, file, data) => {
  writeModel(file, data);
  markFile(e, file);
});

ipcMain.on('cpn:write-file-sync', (e, file, data) => {
  try {
    writeModel(file, data);
    markFile(e, file);
    e.returnValue = null;
  } catch (err) {
    e.returnValue = String(err);
  }
});

ipcMain.on('cpn:open-window', (e, url) => {
  const ws = wsFor(e.sender);
  const w = new BrowserWindow({ width: 900, height: 700, parent: ws ? ws.win : undefined });
  w.loadURL(url);
});

ipcMain.on('cpn:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.on('cpn:retry', (e) => { const ws = wsFor(e.sender); if (ws) ws.boot(); });
ipcMain.on('cpn:install-docker', () => shell.openExternal('https://www.docker.com/products/docker-desktop/'));
ipcMain.on('cpn:show-log', (e) => showLog(wsFor(e.sender)));

// Signals sent by the CPN IDE UI itself (same names as the original Windows app).
ipcMain.on('model.save.backup', (e) => { const ws = wsFor(e.sender); if (ws) ws.setUnsaved(true); });
ipcMain.on('project.saved', (e) => { const ws = wsFor(e.sender); if (ws) ws.setUnsaved(false); });
ipcMain.on('app.init.complete', (e) => {
  const ws = wsFor(e.sender);
  if (ws && ws.pendingOpen.length) ws.send('main.menu.open.project');
});

function showLog(ws) {
  const w = new BrowserWindow({ width: 900, height: 600, title: 'Backend Log', parent: ws ? ws.win : undefined });
  const html = `<pre style="font:12px Menlo,monospace;white-space:pre-wrap;padding:8px">${
    logLines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
  w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function showContainerLog(ws) {
  if (!ws) return showLog(null);
  const r = await docker(['logs', '--tail', '400', ws.container], { timeout: 20000 });
  log(`--- docker logs ${ws.container} ---`);
  log((r.stdout + '\n' + r.stderr).replace(/\x1b\[[0-9;]*m/g, ''));
  showLog(ws);
}

// ---------- menu ----------

function buildMenu() {
  const menuSend = (channel) => (_item, win) => { const ws = focusedWs(win); if (ws) ws.send(channel); };
  const edit = (what) => (_item, win) => { const ws = focusedWs(win); if (ws && ws.alive()) ws.win.webContents.send('cpn:edit', what); };
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'About CPN IDE' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit CPN IDE' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => newWindow() },
        { label: 'New Model', accelerator: 'CmdOrCtrl+N', click: menuSend('main.menu.new.project') },
        { label: 'Open …', accelerator: 'CmdOrCtrl+O', click: menuSend('main.menu.open.project') },
        { label: 'Open in New Window …', accelerator: 'CmdOrCtrl+Shift+O', click: openInNewWindow },
        { role: 'recentDocuments', label: 'Open Recent', submenu: [{ role: 'clearRecentDocuments', label: 'Clear Menu' }] },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuSend('main.menu.save.project') },
        { label: 'Save As …', accelerator: 'CmdOrCtrl+Shift+S', click: menuSend('main.menu.saveas.project') },
        { type: 'separator' },
        { role: 'close', label: 'Close Window' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: edit('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: edit('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
        { type: 'separator' },
        {
          label: 'Reload Interface',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_i, win) => { const ws = focusedWs(win); if (ws && ws.ready) ws.win.loadFile(UI_INDEX); },
        },
        { role: 'toggleDevTools', label: 'Developer Tools' },
      ],
    },
    {
      label: 'Simulator',
      submenu: [
        { label: 'Restart Backend', click: (_i, win) => { const ws = focusedWs(win); if (ws) ws.restartBackend(); } },
        { label: 'Show Backend Log', click: (_i, win) => showContainerLog(focusedWs(win)) },
      ],
    },
    { role: 'windowMenu', label: 'Window' },
    {
      role: 'help',
      label: 'Help',
      submenu: [
        { label: 'CPN IDE Website', click: () => shell.openExternal('https://cpnide.org/') },
        { label: 'CPN Tools Documentation', click: () => shell.openExternal('https://cpntools.org/category/documentation/') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  if (app.dock) app.dock.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => newWindow() }]));
}

async function openInNewWindow(_item, win) {
  const r = await dialog.showOpenDialog(win || undefined, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'CPN models', extensions: ['cpn', 'CPN'] }],
  });
  if (!r.canceled) r.filePaths.forEach((f) => newWindow(f));
}

// ---------- app lifecycle ----------

app.setName('CPN IDE');
if (DEV_TAG) app.setPath('userData', path.join(app.getPath('appData'), `CPN IDE ${DEV_TAG}`));

app.on('open-file', (e, file) => {
  e.preventDefault();
  openFileFromOS(file);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching the app again (e.g. `open -n`) opens another window in this instance.
  app.on('second-instance', (_e, argv) => {
    const files = argv.filter((a) => /\.cpn$/i.test(a)).map((a) => path.resolve(a));
    if (files.length) files.forEach(openFileFromOS);
    else newWindow();
  });

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: 'CPN IDE',
      applicationVersion: app.getVersion(),
      version: 'UI 1.24.1031',
      credits: 'CPN IDE (TU/e) mit dem CPN-Tools-Simulator. Backend-Image: AleFire99/cpn-ide-vscode.',
    });
    buildMenu();
    const argFiles = process.argv.slice(1).filter((a) => /\.cpn$/i.test(a) && fs.existsSync(a)).map((a) => path.resolve(a));
    const files = [...new Set([...pendingStartupFiles, ...argFiles])];
    if (files.length) files.forEach((f) => newWindow(f));
    else newWindow();
  });
}

app.on('window-all-closed', () => app.quit());

app.on('activate', () => {
  if (app.isReady() && workspaces.size === 0) newWindow();
});

// will-quit fires only after every window agreed to close (unsaved-changes prompts included).
app.on('will-quit', (e) => {
  if (backendsStopped) return;
  e.preventDefault();
  backendsStopped = true;
  docker(['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`], { timeout: 15000 })
    .then((r) => (r.stdout ? docker(['rm', '-f', ...r.stdout.split(/\s+/)], { timeout: 30000 }) : null))
    .finally(() => app.quit());
});
