'use strict';
/**
 * Zentro download engine.
 *
 * - Streams every download straight to disk (never buffers whole files in memory).
 * - HTTP and HTTPS only, redirects are followed and re-validated at every hop.
 * - Pause / resume through HTTP Range requests (only when the server supports it).
 * - Automatic retry with back-off for dropped connections, resuming where possible.
 * - Downloads go to "<name>.<id>.zentro-part" and are renamed when complete.
 *
 * This file has no Electron dependency so it can be tested with plain Node.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Transform, pipeline } = require('stream');
const sec = require('./security');

const UA = 'Zentro/1.0 (Windows; Download Manager)';
const MAX_REDIRECTS = 10;
const PART_EXT = '.zentro-part';
const TICK_MS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['queued', 'downloading', 'paused', 'completed', 'failed', 'canceled']);

// Errors that only make sense to retry when we already talked to the server once.
const CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH']);
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET',
  ...CONNECT_CODES,
]);

function fatal(message, code) {
  const e = new Error(message);
  e.retryable = false;
  e.expose = true;
  if (code) e.code = code;
  return e;
}
function transient(message, code) {
  const e = new Error(message);
  e.retryable = true;
  e.expose = true;
  if (code) e.code = code;
  return e;
}
function abortedError() {
  const e = new Error('Aborted');
  e.aborted = true;
  return e;
}

function statusError(res) {
  const sc = res.statusCode;
  const known = {
    401: 'The server asks for a login (401), which Zentro doesn\u2019t support yet.',
    403: 'The server denied access (403). The link may have expired.',
    404: 'File not found on the server (404).',
    410: 'The file is no longer available (410).',
    429: 'The server says there are too many requests (429).',
  };
  const msg = known[sc] || `The server answered ${sc}${res.statusMessage ? ' ' + res.statusMessage : ''}.`;
  return [408, 429, 500, 502, 503, 504].includes(sc) ? transient(msg) : fatal(msg);
}

function friendlyError(err) {
  if (err && err.expose) return err.message;
  const code = err && err.code;
  switch (code) {
    case 'ENOTFOUND': return 'Server not found. Check the link and your internet connection.';
    case 'EAI_AGAIN': return 'Could not look up the server. Check your internet connection.';
    case 'ECONNREFUSED': return 'The server refused the connection.';
    case 'ETIMEDOUT': return 'The connection timed out.';
    case 'ECONNRESET': case 'EPIPE': case 'ECONNABORTED': case 'ERR_STREAM_PREMATURE_CLOSE': case 'UND_ERR_SOCKET':
      return 'The connection was interrupted.';
    case 'ENETUNREACH': case 'ENETDOWN': case 'EHOSTUNREACH': return 'The network is unreachable. Check your internet connection.';
    case 'ENOSPC': return 'There isn\u2019t enough free disk space.';
    case 'EACCES': case 'EPERM': case 'EROFS': return 'Zentro isn\u2019t allowed to write to the download folder.';
    case 'ENOENT': return 'The download folder no longer exists.';
    case 'EBUSY': return 'The file is being used by another program.';
    default: break;
  }
  if (typeof code === 'string' && (/^ERR_(TLS|SSL)/.test(code) || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH/.test(code))) {
    return 'The secure connection failed because the server\u2019s certificate isn\u2019t trusted.';
  }
  return (err && err.message) || 'The download failed.';
}

function isRetryable(err, item) {
  if (err.retryable !== undefined) return err.retryable;
  const code = err.code;
  if (!RETRYABLE_CODES.has(code)) return false;
  if (CONNECT_CODES.has(code)) return item.receivedBytes > 0 || item.retriedOnce === true;
  return true;
}

/** What the renderer is allowed to see. No local paths except the folder for display. */
function publicItem(item) {
  return {
    id: item.id,
    url: item.url,
    fileName: item.fileName,
    dir: item.dir,
    totalBytes: item.totalBytes,
    receivedBytes: item.receivedBytes,
    status: item.status,
    error: item.error,
    note: item.note,
    speed: item.speed,
    eta: item.eta,
    resumable: item.resumable,
    createdAt: item.createdAt,
    completedAt: item.completedAt,
    missing: !!item.missing,
    dangerous: sec.isDangerousFile(item.fileName),
  };
}

/** Rebuild a trustworthy item from whatever is in the JSON file. */
function sanitizeLoaded(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !UUID_RE.test(raw.id)) return null;
  if (typeof raw.url !== 'string' || !STATUSES.has(raw.status)) return null;
  if (typeof raw.dir !== 'string' || !path.isAbsolute(raw.dir)) return null;
  try { sec.validateUrl(raw.url); } catch { return null; }
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  const item = {
    id: raw.id,
    url: raw.url,
    fileName: sec.sanitizeFileName(raw.fileName),
    dir: raw.dir,
    partPath: null,
    savePath: null,
    totalBytes: num(raw.totalBytes),
    receivedBytes: num(raw.receivedBytes),
    status: raw.status,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 300) : null,
    note: null,
    speed: 0,
    eta: null,
    resumable: raw.resumable === true,
    etag: typeof raw.etag === 'string' ? raw.etag : null,
    lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : null,
    createdAt: num(raw.createdAt) || Date.now(),
    completedAt: num(raw.completedAt) || null,
    missing: false,
  };
  try {
    if (typeof raw.partPath === 'string') {
      item.partPath = sec.resolveInside(item.dir, path.relative(item.dir, raw.partPath));
      if (!item.partPath.endsWith(PART_EXT)) item.partPath = null;
    }
    if (typeof raw.savePath === 'string') {
      item.savePath = sec.resolveInside(item.dir, path.relative(item.dir, raw.savePath));
    }
  } catch { /* leave null */ }
  return item;
}

class DownloadManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{get:Function,set:Function,flush:Function}} opts.store
   * @param {() => {downloadDir:string, maxConcurrent:number}} opts.getSettings
   */
  constructor({ store, getSettings, retryBaseMs = 1000, maxRetries = 5, idleTimeoutMs = 30000 } = {}) {
    super();
    this.store = store;
    this.getSettings = getSettings;
    this.retryBaseMs = retryBaseMs;
    this.maxRetries = maxRetries;
    this.idleTimeoutMs = idleTimeoutMs;
    this.items = new Map();
    this.runtime = new Map();
    this.dirty = new Set();
    this.flushTimer = null;
    this.persistTimer = null;
    this.closing = false;
  }

  // ---------------------------------------------------------------- loading
  load() {
    const saved = this.store.get('downloads', []);
    if (!Array.isArray(saved)) return;
    for (const raw of saved) {
      const item = sanitizeLoaded(raw);
      if (!item) continue;
      if (item.status === 'downloading' || item.status === 'queued') {
        // Never restart anything without the user's say-so.
        const partExists = item.partPath && fs.existsSync(item.partPath);
        if (item.resumable && partExists) {
          item.status = 'paused';
        } else {
          item.status = 'failed';
          item.error = 'Zentro was closed before this download finished. Press Retry to start again.';
        }
      }
      if (item.status === 'completed') item.missing = !(item.savePath && fs.existsSync(item.savePath));
      this.items.set(item.id, item);
    }
  }

  // ---------------------------------------------------------------- queries
  list() { return [...this.items.values()].map(publicItem); }
  get(id) { const i = this.items.get(id); return i ? publicItem(i) : null; }
  /** Raw item for the main process only (contains local paths). */
  peek(id) { return this.items.get(id) || null; }
  activeCount() {
    let n = 0;
    for (const i of this.items.values()) if (i.status === 'downloading' || i.status === 'queued') n++;
    return n;
  }
  aggregate() {
    let received = 0; let total = 0; let speed = 0; let active = 0; let unknown = false;
    for (const i of this.items.values()) {
      if (i.status !== 'downloading') continue;
      active++;
      speed += i.speed;
      if (i.totalBytes > 0) { received += i.receivedBytes; total += i.totalBytes; } else unknown = true;
    }
    let fraction = -1;
    if (active > 0) fraction = total > 0 ? Math.min(1, received / total) : (unknown ? 2 : -1);
    return { active, speed, fraction };
  }

  // ---------------------------------------------------------------- commands
  async add(rawUrl) {
    const url = sec.validateUrl(rawUrl);
    const { downloadDir } = this.getSettings();
    try {
      await fsp.mkdir(downloadDir, { recursive: true });
      await fsp.access(downloadDir, fs.constants.W_OK);
    } catch {
      throw new sec.ValidationError('Zentro can\u2019t write to the download folder. Choose another folder in Settings.');
    }
    const id = crypto.randomUUID();
    const item = {
      id,
      url: url.href,
      fileName: sec.sanitizeFileName(sec.fileNameFromUrl(url)),
      dir: downloadDir,
      partPath: null,
      savePath: null,
      totalBytes: 0,
      receivedBytes: 0,
      status: 'queued',
      error: null,
      note: null,
      speed: 0,
      eta: null,
      resumable: false,
      etag: null,
      lastModified: null,
      createdAt: Date.now(),
      completedAt: null,
      missing: false,
    };
    this.items.set(id, item);
    this._emitUpdate(item, true);
    this._persistNow();
    this.pump();
    return publicItem(item);
  }

  pause(id) {
    const item = this._need(id);
    const rt = this.runtime.get(id);
    if (item.status === 'queued') {
      item.status = 'paused';
      this._emitUpdate(item, true);
      return;
    }
    if (item.status !== 'downloading' || !rt) throw new sec.ValidationError('This download can\u2019t be paused right now.');
    if (!item.resumable) throw new sec.ValidationError('This server doesn\u2019t allow pausing this download. You can cancel it instead.');
    this._abort(rt, 'pause');
  }

  /** Resume a paused download, or retry a failed / canceled one. */
  resume(id) {
    const item = this._need(id);
    if (!['paused', 'failed', 'canceled'].includes(item.status)) {
      throw new sec.ValidationError('This download is already running.');
    }
    if (!item.resumable) this._discardPart(item);
    item.status = 'queued';
    item.error = null;
    item.note = null;
    item.speed = 0;
    item.eta = null;
    this._emitUpdate(item, true);
    this.pump();
  }
  retry(id) { this.resume(id); }

  cancel(id) {
    const item = this._need(id);
    const rt = this.runtime.get(id);
    if (rt) { this._abort(rt, 'cancel'); return; }
    if (['queued', 'paused', 'failed'].includes(item.status)) {
      this._discardPart(item);
      item.status = 'canceled';
      item.error = 'Canceled';
      item.speed = 0; item.eta = null; item.note = null;
      this._emitUpdate(item, true);
      this._persistNow();
      return;
    }
    throw new sec.ValidationError('This download can\u2019t be canceled.');
  }

  remove(id) {
    const item = this._need(id);
    if (item.status === 'downloading' || item.status === 'queued' || this.runtime.has(id)) {
      throw new sec.ValidationError('Cancel the download before removing it from the list.');
    }
    if (item.status !== 'completed') this._discardPart(item);
    this.items.delete(id);
    this.dirty.delete(id);
    this._persistNow();
    this.emit('removed', id);
  }

  clearCompleted() {
    const ids = [...this.items.values()].filter((i) => i.status === 'completed').map((i) => i.id);
    for (const id of ids) { this.items.delete(id); this.dirty.delete(id); this.emit('removed', id); }
    this._persistNow();
    return ids.length;
  }

  /** Re-check which finished files still exist on disk. */
  verifyCompleted() {
    for (const item of this.items.values()) {
      if (item.status !== 'completed') continue;
      const missing = !(item.savePath && fs.existsSync(item.savePath));
      if (missing !== item.missing) { item.missing = missing; this._emitUpdate(item); }
    }
  }

  async shutdown() {
    this.closing = true;
    const waits = [];
    for (const rt of this.runtime.values()) { waits.push(rt.done); this._abort(rt, 'shutdown'); }
    await Promise.allSettled(waits);
    for (const item of this.items.values()) {
      if (item.status === 'queued') item.status = 'paused';
    }
    this._flush();
    this._persistNow();
  }

  // ---------------------------------------------------------------- scheduling
  pump() {
    if (this.closing) return;
    const max = Math.max(1, Number(this.getSettings().maxConcurrent) || 3);
    let running = 0;
    for (const i of this.items.values()) if (i.status === 'downloading') running++;
    for (const item of this.items.values()) {
      if (running >= max) break;
      if (item.status === 'queued' && !this.runtime.has(item.id)) { running++; this._begin(item); }
    }
  }

  _begin(item) {
    item.status = 'downloading';
    item.error = null;
    item.note = 'Connecting\u2026';
    item.speed = 0;
    item.eta = null;
    const rt = { req: null, res: null, intent: null, ticker: null, wake: null, bytes: 0, lastTick: 0, progressed: false };
    this.runtime.set(item.id, rt);
    this._emitUpdate(item, true);
    rt.done = this._run(item, rt).catch((err) => {
      this.runtime.delete(item.id);
      this._fail(item, err);
      this.pump();
    });
  }

  _abort(rt, intent) {
    if (rt.intent) return;
    rt.intent = intent;
    if (rt.wake) rt.wake();
    if (rt.req) rt.req.destroy();
    if (rt.res) rt.res.destroy();
  }

  // ---------------------------------------------------------------- the download loop
  async _run(item, rt) {
    let attempt = 0;
    let outcome;
    for (;;) {
      rt.progressed = false;
      try {
        const r = await this._attempt(item, rt);
        outcome = rt.intent ? 'aborted' : r;
        break;
      } catch (err) {
        if (rt.intent) { outcome = 'aborted'; break; }
        if (rt.progressed) attempt = 0;
        if (isRetryable(err, item) && attempt < this.maxRetries) {
          attempt++;
          item.retriedOnce = true;
          item.note = `Connection lost. Retrying (${attempt} of ${this.maxRetries})\u2026`;
          item.speed = 0;
          item.eta = null;
          this._emitUpdate(item, true);
          await this._sleep(rt, Math.min(30000, this.retryBaseMs * 2 ** (attempt - 1)));
          if (rt.intent) { outcome = 'aborted'; break; }
          continue;
        }
        outcome = err;
        break;
      }
    }
    this.runtime.delete(item.id);
    if (outcome === 'done') await this._complete(item);
    else if (outcome === 'aborted') await this._afterAbort(item, rt.intent);
    else this._fail(item, outcome);
    this.pump();
  }

  _sleep(rt, ms) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      rt.wake = () => { clearTimeout(t); resolve(); };
    });
  }

  async _attempt(item, rt) {
    // Where do we continue from? The file on disk is the source of truth.
    let offset = 0;
    if (item.partPath) {
      try { offset = (await fsp.stat(item.partPath)).size; } catch { offset = 0; }
    }
    if (!item.resumable) offset = 0;
    if (item.totalBytes > 0 && offset > item.totalBytes) offset = 0;

    const { res, finalUrl } = await this._request(item, rt, item.url, offset);
    rt.res = res;
    const sc = res.statusCode;
    const h = res.headers;

    if (sc === 416) {
      res.resume();
      if (offset > 0 && item.totalBytes > 0 && offset === item.totalBytes) { item.receivedBytes = offset; return 'done'; }
      await this._truncatePart(item);
      throw transient('The server rejected the resume request. Starting over.');
    }
    if (sc !== 200 && sc !== 206) {
      res.resume();
      throw statusError(res);
    }

    let start = offset;
    if (sc === 206) {
      const m = /^bytes\s+(\d+)-(\d+)?\/(\d+|\*)$/i.exec(String(h['content-range'] || ''));
      if (!m || Number(m[1]) !== offset) {
        res.resume();
        await this._truncatePart(item);
        throw transient('Unexpected response while resuming. Starting over.');
      }
      if (m[3] !== '*') item.totalBytes = Number(m[3]);
      item.resumable = true;
    } else {
      start = 0; // 200: full body, anything on disk is replaced
      const cl = Number.parseInt(h['content-length'], 10);
      item.totalBytes = Number.isFinite(cl) && cl >= 0 ? cl : 0;
      item.resumable = /\bbytes\b/i.test(String(h['accept-ranges'] || '')) && item.totalBytes > 0;
      item.etag = h.etag && !/^W\//i.test(h.etag) ? String(h.etag) : null;
      item.lastModified = h['last-modified'] ? String(h['last-modified']) : null;
    }

    if (!item.partPath) {
      const name = sec.sanitizeFileName(sec.fileNameFromHeaders(h) || sec.fileNameFromUrl(finalUrl), item.fileName);
      item.fileName = name;
      item.partPath = sec.resolveInside(item.dir, `${name}.${item.id.slice(0, 8)}${PART_EXT}`);
    }

    item.receivedBytes = start;
    item.note = null;
    this._emitUpdate(item, true);

    const fileStream = fs.createWriteStream(item.partPath, { flags: start > 0 ? 'a' : 'w' });
    const counter = new Transform({
      transform: (chunk, _enc, cb) => {
        item.receivedBytes += chunk.length;
        rt.bytes += chunk.length;
        rt.progressed = true;
        cb(null, chunk);
      },
    });
    rt.bytes = 0;
    rt.lastTick = Date.now();
    rt.ticker = setInterval(() => this._tick(item, rt), TICK_MS);

    return new Promise((resolve, reject) => {
      pipeline(res, counter, fileStream, (err) => {
        clearInterval(rt.ticker);
        rt.ticker = null;
        const finish = () => {
          if (rt.intent) return resolve('aborted');
          if (err) return reject(err);
          if (item.totalBytes > 0 && item.receivedBytes !== item.totalBytes) {
            return reject(transient('The connection closed before the download finished.'));
          }
          return resolve('done');
        };
        // Wait until the file handle is really closed so the size on disk is final.
        if (fileStream.closed) finish(); else fileStream.once('close', finish);
      });
    });
  }

  /** One HTTP(S) request, following redirects. Resolves with the final response. */
  _request(item, rt, startUrl, offset) {
    return new Promise((resolve, reject) => {
      const go = (target, redirects) => {
        if (rt.intent) return reject(abortedError());
        let u;
        try { u = sec.validateUrl(target); } catch (e) { return reject(fatal(e.message)); }
        const lib = u.protocol === 'https:' ? https : http;
        const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity' };
        if (offset > 0) {
          headers.Range = `bytes=${offset}-`;
          const validator = item.etag || item.lastModified;
          if (validator) headers['If-Range'] = validator;
        }
        const req = lib.request(u, { method: 'GET', headers }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            if (redirects >= MAX_REDIRECTS) return reject(fatal('The link redirects too many times.'));
            let next;
            try { next = new URL(res.headers.location, u); } catch { return reject(fatal('The server sent an invalid redirect.')); }
            if (u.protocol === 'https:' && next.protocol === 'http:') {
              return reject(fatal('Blocked a redirect from a secure (https) link to an insecure (http) one.'));
            }
            return go(next.href, redirects + 1);
          }
          return resolve({ res, finalUrl: u });
        });
        rt.req = req;
        req.setTimeout(this.idleTimeoutMs, () => {
          req.destroy(Object.assign(new Error('The connection timed out.'), { code: 'ETIMEDOUT' }));
        });
        req.on('error', reject);
        req.end();
      };
      go(startUrl, 0);
    });
  }

  _tick(item, rt) {
    const now = Date.now();
    const dt = Math.max(0.001, (now - rt.lastTick) / 1000);
    const instant = rt.bytes / dt;
    rt.bytes = 0;
    rt.lastTick = now;
    item.speed = item.speed > 0 ? item.speed * 0.8 + instant * 0.2 : instant;
    if (item.speed < 1) item.speed = 0;
    item.eta = item.totalBytes > 0 && item.speed > 0
      ? Math.max(0, Math.round((item.totalBytes - item.receivedBytes) / item.speed))
      : null;
    this._emitUpdate(item);
  }

  // ---------------------------------------------------------------- outcomes
  async _complete(item) {
    try {
      const finalPath = await this._uniquePath(item.dir, item.fileName);
      await fsp.rename(item.partPath, finalPath);
      item.savePath = finalPath;
      item.fileName = path.basename(finalPath);
      item.partPath = null;
      if (!item.totalBytes) item.totalBytes = item.receivedBytes;
      item.receivedBytes = item.totalBytes;
      item.status = 'completed';
      item.completedAt = Date.now();
      item.speed = 0;
      item.eta = 0;
      item.error = null;
      item.note = null;
      item.missing = false;
    } catch (err) {
      return this._fail(item, err);
    }
    this._emitUpdate(item, true);
    this._persistNow();
    this.emit('completed', publicItem(item));
  }

  _fail(item, err) {
    item.status = 'failed';
    item.error = friendlyError(err);
    item.speed = 0;
    item.eta = null;
    item.note = null;
    if (!item.resumable) this._discardPart(item); // nothing to resume from, free the disk space
    this._emitUpdate(item, true);
    this._persistNow();
    this.emit('failed', publicItem(item));
  }

  async _afterAbort(item, intent) {
    item.speed = 0;
    item.eta = null;
    item.note = null;
    if (intent === 'cancel') {
      this._discardPart(item);
      item.status = 'canceled';
      item.error = 'Canceled';
    } else if (intent === 'pause') {
      item.status = 'paused';
    } else if (item.resumable) { // shutdown
      item.status = 'paused';
    } else {
      this._discardPart(item);
      item.status = 'failed';
      item.error = 'Zentro was closed before this download finished. Press Retry to start again.';
    }
    this._emitUpdate(item, true);
    this._persistNow();
  }

  // ---------------------------------------------------------------- file helpers
  _discardPart(item) {
    if (item.partPath) { try { fs.unlinkSync(item.partPath); } catch { /* already gone */ } }
    item.partPath = null;
    item.receivedBytes = 0;
  }

  async _truncatePart(item) {
    if (item.partPath) { try { await fsp.truncate(item.partPath, 0); } catch { /* ignore */ } }
    item.receivedBytes = 0;
  }

  async _uniquePath(dir, name) {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${base} (${i})${ext}`;
      const full = sec.resolveInside(dir, candidate);
      try { await fsp.access(full); } catch { return full; }
    }
    throw fatal('Could not find a free file name in the download folder.');
  }

  _need(id) {
    if (typeof id !== 'string') throw new sec.ValidationError('Unknown download.');
    const item = this.items.get(id);
    if (!item) throw new sec.ValidationError('That download no longer exists.');
    return item;
  }

  // ---------------------------------------------------------------- events + persistence
  _emitUpdate(item, immediate = false) {
    this.dirty.add(item.id);
    if (immediate) this._flush();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this._flush(), 200);
      if (this.flushTimer.unref) this.flushTimer.unref();
    }
    this._schedulePersist();
  }

  _flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty.size) return;
    const batch = [...this.dirty].map((id) => this.items.get(id)).filter(Boolean).map(publicItem);
    this.dirty.clear();
    if (batch.length) this.emit('updates', batch);
  }

  _schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this._persistNow(); }, 1500);
    if (this.persistTimer.unref) this.persistTimer.unref();
  }

  _persistNow() {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null; }
    const rows = [...this.items.values()].map((i) => ({ ...i, speed: 0, eta: null, note: null }));
    this.store.set('downloads', rows);
    this.store.flush();
  }
}

module.exports = { DownloadManager, PART_EXT, friendlyError, publicItem };
