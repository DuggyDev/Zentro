'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DownloadManager } = require('../src/downloader');
const { JsonStore } = require('../src/store');

const payload = crypto.randomBytes(3 * 1024 * 1024);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PAYLOAD_SHA = sha(payload);

const seen = { ranges: [], flakyHits: 0 };

function serveFile(req, res, { slow = false, ranges = true, failAfter = null } = {}) {
  const m = /bytes=(\d+)-/.exec(req.headers.range || '');
  const start = ranges && m ? Number(m[1]) : 0;
  if (m) seen.ranges.push(req.headers.range);
  if (start >= payload.length) { res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` }); return res.end(); }
  const headers = { 'Content-Type': 'application/octet-stream', ETag: '"abc"' };
  if (ranges) headers['Accept-Ranges'] = 'bytes';
  if (start > 0) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'Content-Length': payload.length - start });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': payload.length });
  }
  const body = payload.subarray(start);
  const limit = failAfter != null ? Math.min(failAfter, body.length) : body.length;
  let pos = 0;
  const timer = setInterval(() => {
    if (pos >= limit) {
      clearInterval(timer);
      return limit < body.length ? res.destroy() : res.end();
    }
    const end = Math.min(pos + 65536, limit);
    res.write(body.subarray(pos, end));
    pos = end;
  }, slow ? 15 : 0);
  res.on('close', () => clearInterval(timer));
}

let server; let base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    switch (u.pathname) {
      case '/file.bin': return serveFile(req, res, { slow: u.searchParams.has('slow') });
      case '/norange.bin': return serveFile(req, res, { slow: true, ranges: false });
      case '/flaky.bin': {
        seen.flakyHits++;
        return serveFile(req, res, { failAfter: seen.flakyHits === 1 ? Math.floor(payload.length / 2) : null });
      }
      case '/redirect': res.writeHead(302, { Location: '/file.bin' }); return res.end();
      case '/redirect-ftp': res.writeHead(302, { Location: 'ftp://example.com/x' }); return res.end();
      case '/missing': res.writeHead(404); return res.end('nope');
      case '/cd': res.writeHead(200, { 'Content-Disposition': 'attachment; filename="../../evil.exe"', 'Content-Length': 5 }); return res.end('hello');
      case '/chunked': res.writeHead(200); res.write('abc'); return setTimeout(() => res.end('def'), 20);
      case '/empty': res.writeHead(200, { 'Content-Length': 0 }); return res.end();
      default: res.writeHead(404); return res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.closeAllConnections(); server.close(); });

class MemStore { constructor() { this.d = {}; } get(k, f) { return k in this.d ? this.d[k] : f; } set(k, v) { this.d[k] = JSON.parse(JSON.stringify(v)); } flush() {} }

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentro-test-'));
  const store = extra.store || new MemStore();
  const manager = new DownloadManager({
    store,
    getSettings: () => ({ downloadDir: dir, maxConcurrent: extra.maxConcurrent || 3 }),
    retryBaseMs: 20, idleTimeoutMs: 3000,
  });
  manager.load();
  return { dir, store, manager };
}

async function waitFor(manager, id, pred, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    const it = manager.get(id);
    if (it && pred(it)) return it;
    if (Date.now() - t0 > ms) throw new Error(`timeout; last state: ${JSON.stringify(it)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const done = (m, id) => waitFor(m, id, (i) => i.status === 'completed');

test('downloads a file, reports progress, and the bytes match', async () => {
  const { dir, manager } = setup();
  const updates = [];
  manager.on('updates', (b) => updates.push(...b));
  const { id } = await manager.add(`${base}/file.bin?slow=1`);
  const it = await done(manager, id);
  assert.equal(it.fileName, 'file.bin');
  assert.equal(it.totalBytes, payload.length);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'file.bin'))), PAYLOAD_SHA);
  assert.deepEqual(fs.readdirSync(dir), ['file.bin'], 'no leftover .zentro-part files');
  const mine = updates.filter((u) => u.id === id);
  assert.ok(mine.some((u) => u.status === 'downloading' && u.receivedBytes > 0 && u.receivedBytes < payload.length), 'saw mid-download progress');
  assert.ok(mine.some((u) => u.speed > 0), 'saw a speed value');
  assert.ok(mine.some((u) => u.eta != null), 'saw an ETA');
});

test('pause and resume continue with a Range request and give identical bytes', async () => {
  const { dir, manager } = setup();
  seen.ranges.length = 0;
  const { id } = await manager.add(`${base}/file.bin?slow=1`);
  await waitFor(manager, id, (i) => i.receivedBytes > 300000);
  manager.pause(id);
  const paused = await waitFor(manager, id, (i) => i.status === 'paused');
  assert.ok(paused.receivedBytes > 0 && paused.receivedBytes < payload.length);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('.zentro-part')), 'partial file kept');
  manager.resume(id);
  await done(manager, id);
  assert.ok(seen.ranges.length >= 1, 'server saw a Range header');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'file.bin'))), PAYLOAD_SHA);
});

test('an interrupted connection is retried and resumed automatically', async () => {
  const { dir, manager } = setup();
  seen.flakyHits = 0;
  const { id } = await manager.add(`${base}/flaky.bin`);
  await done(manager, id);
  assert.ok(seen.flakyHits >= 2, 'server was contacted again after the drop');
  assert.equal(sha(fs.readFileSync(path.join(dir, 'flaky.bin'))), PAYLOAD_SHA);
});

test('servers without Range support: pause is refused, cancel cleans up', async () => {
  const { dir, manager } = setup();
  const { id } = await manager.add(`${base}/norange.bin`);
  await waitFor(manager, id, (i) => i.receivedBytes > 100000);
  assert.throws(() => manager.pause(id), /doesn.t allow pausing/);
  manager.cancel(id);
  const it = await waitFor(manager, id, (i) => i.status === 'canceled');
  assert.equal(it.receivedBytes, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  manager.retry(id);
  await done(manager, id);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'norange.bin'))), PAYLOAD_SHA);
});

test('HTTP errors become clear failed states and can be removed', async () => {
  const { manager } = setup();
  const { id } = await manager.add(`${base}/missing`);
  const it = await waitFor(manager, id, (i) => i.status === 'failed');
  assert.match(it.error, /404/);
  manager.remove(id);
  assert.equal(manager.get(id), null);
});

test('unreachable servers fail quickly with a friendly message', async () => {
  const { manager } = setup();
  const { id } = await manager.add('http://127.0.0.1:1/nothing.bin'); // nothing listens on port 1
  const it = await waitFor(manager, id, (i) => i.status === 'failed');
  assert.match(it.error, /refused|unreachable|timed out/i);
});

test('redirects are followed, non-http redirects are refused', async () => {
  const { dir, manager } = setup();
  const a = await manager.add(`${base}/redirect`);
  await done(manager, a.id);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'file.bin'))), PAYLOAD_SHA);
  const b = await manager.add(`${base}/redirect-ftp`);
  const it = await waitFor(manager, b.id, (i) => i.status === 'failed');
  assert.match(it.error, /http/i);
});

test('invalid links are rejected before anything is created', async () => {
  const { manager } = setup();
  for (const bad of ['file:///C:/x.exe', 'ftp://a/b', 'javascript:alert(1)', '']) {
    await assert.rejects(() => manager.add(bad), /link|http|Paste/i);
  }
  assert.equal(manager.list().length, 0);
});

test('a malicious Content-Disposition cannot escape the download folder', async () => {
  const { dir, manager } = setup();
  const { id } = await manager.add(`${base}/cd`);
  const it = await done(manager, id);
  assert.equal(it.fileName, 'evil.exe');
  assert.equal(it.dangerous, true);
  assert.ok(fs.existsSync(path.join(dir, 'evil.exe')));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.exe')));
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil.exe')));
});

test('unknown size (chunked) and empty files work', async () => {
  const { dir, manager } = setup();
  const a = await manager.add(`${base}/chunked`);
  const ia = await done(manager, a.id);
  assert.equal(ia.totalBytes, 6);
  assert.equal(fs.readFileSync(path.join(dir, 'chunked'), 'utf8'), 'abcdef');
  const b = await manager.add(`${base}/empty`);
  await done(manager, b.id);
  assert.equal(fs.statSync(path.join(dir, 'empty')).size, 0);
});

test('same file twice never overwrites: second becomes "name (1).ext"', async () => {
  const { dir, manager } = setup();
  const a = await manager.add(`${base}/file.bin`);
  await done(manager, a.id);
  const b = await manager.add(`${base}/file.bin`);
  const ib = await done(manager, b.id);
  assert.equal(ib.fileName, 'file (1).bin');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['file (1).bin', 'file.bin']);
});

test('concurrency limit queues extra downloads', async () => {
  const { manager } = setup({ maxConcurrent: 1 });
  const a = await manager.add(`${base}/file.bin?slow=1`);
  const b = await manager.add(`${base}/file.bin?slow=1`);
  assert.equal(manager.get(b.id).status, 'queued');
  await done(manager, a.id);
  await done(manager, b.id);
});

test('history survives a restart; interrupted downloads come back paused and resume', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zentro-store-')), 'data.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentro-test-'));
  const mk = () => {
    const store = new JsonStore(file); store.load();
    const m = new DownloadManager({ store, getSettings: () => ({ downloadDir: dir, maxConcurrent: 3 }), retryBaseMs: 20, idleTimeoutMs: 3000 });
    m.load();
    return m;
  };
  const m1 = mk();
  const a = await m1.add(`${base}/chunked`);
  await done(m1, a.id);
  const b = await m1.add(`${base}/file.bin?slow=1`);
  await waitFor(m1, b.id, (i) => i.receivedBytes > 300000);
  await m1.shutdown(); // like closing the app mid-download

  const m2 = mk();
  const list = m2.list();
  assert.equal(list.find((i) => i.id === a.id).status, 'completed');
  const pb = list.find((i) => i.id === b.id);
  assert.equal(pb.status, 'paused');
  m2.resume(b.id);
  await done(m2, b.id);
  assert.equal(sha(fs.readFileSync(path.join(dir, 'file.bin'))), PAYLOAD_SHA);

  // deleting a finished file is noticed
  fs.unlinkSync(path.join(dir, 'chunked'));
  m2.verifyCompleted();
  assert.equal(m2.get(a.id).missing, true);
});

test('a corrupt history file is set aside instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentro-store-'));
  const file = path.join(dir, 'data.json');
  fs.writeFileSync(file, '{ not json');
  const s = new JsonStore(file);
  s.load();
  assert.deepEqual(s.data, {});
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
});
