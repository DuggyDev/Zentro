'use strict';
// Runs in an isolated, sandboxed context. Exposes a small, fixed API to the page.
// The page never receives ipcRenderer, Node.js, or file system access.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then((r) => {
    if (!r || r.ok !== true) throw new Error((r && r.error) || 'Something went wrong.');
    return r.data;
  });

const subscribe = (channel, cb) => {
  if (typeof cb !== 'function') return () => {};
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('zentro', Object.freeze({
  list: () => call('downloads:list'),
  add: (url) => call('downloads:add', url),
  pause: (id) => call('downloads:pause', id),
  resume: (id) => call('downloads:resume', id),
  cancel: (id) => call('downloads:cancel', id),
  retry: (id) => call('downloads:retry', id),
  remove: (id) => call('downloads:remove', id),
  clearCompleted: () => call('downloads:clearCompleted'),
  open: (id) => call('downloads:open', id),
  showInFolder: (id) => call('downloads:showInFolder', id),
  openFolder: (kind) => call('folder:open', kind),
  getSettings: () => call('settings:get'),
  setSettings: (patch) => call('settings:set', patch),
  chooseFolder: () => call('settings:chooseFolder'),
  readClipboard: () => call('clipboard:read'),
  getInfo: () => call('app:info'),
  onUpdates: (cb) => subscribe('downloads:updates', cb),
  onRemoved: (cb) => subscribe('downloads:removed', cb),
}));
