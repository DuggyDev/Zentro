'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { DownloadManager } = require('./src/downloader');
const { JsonStore } = require('./src/store');
const { ValidationError, validateSettingsPatch, isDangerousFile } = require('./src/security');

const APP_ID = 'com.zentro.downloadmanager';
const isDev = process.argv.includes('--dev');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.setAppUserModelId(APP_ID); // needed for Windows toast notifications

let mainWindow = null;
let store = null;
let manager = null;
let settings = null;
let quitting = false;
let confirmedClose = false;
const liveNotifications = new Set();

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// ---------------------------------------------------------------- hardening for every web contents
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: mainWindow || undefined });
  });
});

// ---------------------------------------------------------------- settings
function loadSettings() {
  const defaults = { downloadDir: app.getPath('downloads'), notifications: true, maxConcurrent: 3 };
  let saved = {};
  try { saved = validateSettingsPatch(store.get('settings', {})); } catch { saved = {}; }
  return { ...defaults, ...saved };
}

// ---------------------------------------------------------------- window
function createWindow() {
  const iconPath = path.join(__dirname, 'renderer', 'assets', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: '#0a0a0c',
    title: 'Zentro Download Manager',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    // Native Windows minimize / maximize / close buttons drawn over our dark title strip.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0a0c', symbolColor: '#f2f2f5', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: isDev,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('focus', () => { mainWindow.flashFrame(false); manager.verifyCompleted(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('close', (e) => {
    if (confirmedClose || quitting || manager.activeCount() === 0) return;
    e.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Keep downloading', 'Pause and quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Downloads in progress',
      message: 'Some downloads are still running.',
      detail: 'If you quit now they will be paused. You can resume them the next time you open Zentro.',
    }).then((r) => {
      if (r.response === 1) { confirmedClose = true; mainWindow && mainWindow.close(); }
    });
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- notifications
function notify(title, body, onClick) {
  if (!settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n); // keep a reference so it isn't garbage collected before the click
  const drop = () => liveNotifications.delete(n);
  n.on('click', () => { drop(); if (onClick) onClick(); });
  n.on('close', drop);
  n.on('failed', drop);
  n.show();
  setTimeout(drop, 120000);
}

function wireManager() {
  manager.on('updates', (batch) => {
    send('downloads:updates', batch);
    if (mainWindow && !mainWindow.isDestroyed()) {
      const agg = manager.aggregate();
      mainWindow.setProgressBar(agg.fraction >= 0 && agg.fraction <= 1 ? agg.fraction : agg.fraction === 2 ? 2 : -1, agg.fraction === 2 ? { mode: 'indeterminate' } : undefined);
    }
  });
  manager.on('removed', (id) => send('downloads:removed', id));
  manager.on('completed', (item) => {
    const raw = manager.peek(item.id);
    notify('Download complete', item.fileName, () => {
      if (raw && raw.savePath) shell.showItemInFolder(raw.savePath);
    });
    if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });
  manager.on('failed', (item) => {
    notify('Download failed', `${item.fileName}: ${item.error}`, () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  });
}

// ---------------------------------------------------------------- IPC
function assertTrusted(event) {
  const ok = mainWindow
    && event.senderFrame === mainWindow.webContents.mainFrame
    && typeof event.senderFrame.url === 'string'
    && event.senderFrame.url.startsWith('file://');
  if (!ok) throw new ValidationError('Request blocked.');
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrusted(event);
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const message = err && err.expose ? err.message : 'Something went wrong. Please try again.';
      if (!(err && err.expose)) console.error(`[${channel}]`, err);
      return { ok: false, error: message };
    }
  });
}

function requireId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ValidationError('Unknown download.');
  return id;
}

function requireFinished(id) {
  const item = manager.peek(requireId(id));
  if (!item || item.status !== 'completed' || !item.savePath) throw new ValidationError('That download isn\u2019t finished yet.');
  return item;
}

function registerIpc() {
  handle('downloads:list', () => manager.list());
  handle('downloads:add', (url) => manager.add(url));
  handle('downloads:pause', (id) => { manager.pause(requireId(id)); return true; });
  handle('downloads:resume', (id) => { manager.resume(requireId(id)); return true; });
  handle('downloads:retry', (id) => { manager.retry(requireId(id)); return true; });
  handle('downloads:cancel', (id) => { manager.cancel(requireId(id)); return true; });
  handle('downloads:remove', (id) => { manager.remove(requireId(id)); return true; });
  handle('downloads:clearCompleted', () => manager.clearCompleted());

  handle('downloads:open', async (id) => {
    const item = requireFinished(id);
    if (!fs.existsSync(item.savePath)) {
      manager.verifyCompleted();
      throw new ValidationError('That file has been moved or deleted.');
    }
    if (isDangerousFile(item.fileName)) {
      let host = '';
      try { host = new URL(item.url).hostname; } catch { /* ignore */ }
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Show in folder', 'Open anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Open this program?',
        message: `\u201C${item.fileName}\u201D can run code on your computer.`,
        detail: `It was downloaded from ${host || 'the internet'}. Zentro never runs downloads on its own. Only open it if you trust the source.`,
      });
      if (response === 0) return false;
      if (response === 1) { shell.showItemInFolder(item.savePath); return true; }
    }
    const err = await shell.openPath(item.savePath);
    if (err) throw new ValidationError('Windows couldn\u2019t open this file. Try \u201CShow in folder\u201D.');
    return true;
  });

  handle('downloads:showInFolder', (id) => {
    const item = requireFinished(id);
    if (fs.existsSync(item.savePath)) shell.showItemInFolder(item.savePath);
    else { manager.verifyCompleted(); shell.openPath(item.dir); }
    return true;
  });

  handle('folder:open', async (kind) => {
    const dir = kind === 'windows' ? app.getPath('downloads') : settings.downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new ValidationError('Couldn\u2019t open that folder.');
    return true;
  });

  handle('settings:get', () => ({ ...settings }));
  handle('settings:set', async (patch) => {
    const clean = validateSettingsPatch(patch);
    if (clean.downloadDir) {
      try {
        await fs.promises.mkdir(clean.downloadDir, { recursive: true });
        await fs.promises.access(clean.downloadDir, fs.constants.W_OK);
      } catch {
        throw new ValidationError('Zentro can\u2019t write to that folder. Pick a different one.');
      }
    }
    settings = { ...settings, ...clean };
    store.set('settings', settings);
    store.flush();
    manager.pump();
    return { ...settings };
  });
  handle('settings:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose download folder',
      defaultPath: settings.downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  handle('clipboard:read', () => clipboard.readText().slice(0, 2048));
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
}

// ---------------------------------------------------------------- lifecycle
app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;

  // The UI never needs the network: all downloading happens in the main process.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));

  Menu.setApplicationMenu(null);

  store = new JsonStore(path.join(app.getPath('userData'), 'zentro-data.json'));
  store.load();
  settings = loadSettings();

  manager = new DownloadManager({ store, getSettings: () => settings });
  manager.load();
  wireManager();
  registerIpc();
  createWindow();
});

app.on('before-quit', (event) => {
  if (quitting || !manager) return;
  event.preventDefault();
  quitting = true;
  manager.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
