'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const sec = require('../src/security');

test('validateUrl accepts http and https only', () => {
  assert.equal(sec.validateUrl('https://example.com/a.zip').href, 'https://example.com/a.zip');
  assert.equal(sec.validateUrl('http://example.com/a.zip').protocol, 'http:');
  assert.equal(sec.validateUrl('example.com/a.zip').protocol, 'https:'); // bare host gets https
  for (const bad of [
    'file:///C:/Windows/system32/calc.exe', 'ftp://example.com/a', 'javascript:alert(1)',
    'data:text/html,hi', 'magnet:?xt=urn:btih:abc', 'blob:https://x/y', '\\\\server\\share\\x.exe',
    '', '   ', 'https://', 'https://user:pass@example.com/x', 'https://exa mple.com',
  ]) {
    assert.throws(() => sec.validateUrl(bad), sec.ValidationError, `should reject: ${bad}`);
  }
  assert.throws(() => sec.validateUrl(42), sec.ValidationError);
  assert.throws(() => sec.validateUrl('https://example.com/' + 'a'.repeat(3000)), sec.ValidationError);
});

test('sanitizeFileName strips folders, reserved names and tricks', () => {
  assert.equal(sec.sanitizeFileName('../../Windows/evil.exe'), 'evil.exe');
  assert.equal(sec.sanitizeFileName('..\\..\\evil.exe'), 'evil.exe');
  assert.equal(sec.sanitizeFileName('C:\\Users\\x\\a.txt'), 'a.txt');
  assert.equal(sec.sanitizeFileName('..'), 'download');
  assert.equal(sec.sanitizeFileName('   '), 'download');
  assert.equal(sec.sanitizeFileName('CON'), '_CON');
  assert.equal(sec.sanitizeFileName('nul.txt'), '_nul.txt');
  assert.equal(sec.sanitizeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(sec.sanitizeFileName('report.pdf. '), 'report.pdf');
  assert.equal(sec.sanitizeFileName('file\u202Efdp.exe'), 'filefdp.exe');
  assert.equal(sec.sanitizeFileName('a:stream'), 'a_stream');
  const long = sec.sanitizeFileName('x'.repeat(400) + '.zip');
  assert.ok(long.length <= 180 && long.endsWith('.zip'));
});

test('resolveInside blocks traversal', () => {
  const dir = path.resolve('/tmp/zentro-dl');
  assert.equal(sec.resolveInside(dir, 'ok.txt'), path.join(dir, 'ok.txt'));
  assert.throws(() => sec.resolveInside(dir, '../x.txt'), sec.ValidationError);
  assert.throws(() => sec.resolveInside(dir, '..'), sec.ValidationError);
  assert.throws(() => sec.resolveInside(dir, path.resolve('/etc/passwd')), sec.ValidationError);
});

test('file names from headers and URLs', () => {
  assert.equal(sec.fileNameFromHeaders({ 'content-disposition': 'attachment; filename="a b.zip"' }), 'a b.zip');
  assert.equal(sec.fileNameFromHeaders({ 'content-disposition': "attachment; filename*=UTF-8''%E2%82%AC%20rates.txt" }), '\u20ac rates.txt');
  assert.equal(sec.fileNameFromHeaders({ 'content-disposition': 'attachment; filename=plain.bin' }), 'plain.bin');
  assert.equal(sec.fileNameFromHeaders({}), null);
  assert.equal(sec.fileNameFromUrl('https://x.com/dir/My%20File.pdf?x=1'), 'My File.pdf');
  assert.equal(sec.fileNameFromUrl('https://x.com/'), 'x.com');
});

test('dangerous extensions are flagged', () => {
  for (const n of ['setup.exe', 'A.MSI', 'x.bat', 'invoice.pdf.exe', 'run.ps1', 'a.lnk']) assert.ok(sec.isDangerousFile(n), n);
  for (const n of ['photo.jpg', 'movie.mkv', 'notes.txt', 'archive.zip', 'x']) assert.ok(!sec.isDangerousFile(n), n);
});

test('settings patches are whitelisted and type checked', () => {
  assert.deepEqual(sec.validateSettingsPatch({ notifications: false, maxConcurrent: 4 }), { notifications: false, maxConcurrent: 4 });
  assert.throws(() => sec.validateSettingsPatch({ evil: 1 }), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch({ maxConcurrent: 99 }), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch({ maxConcurrent: '3' }), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch({ notifications: 'yes' }), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch({ downloadDir: 'relative/path' }), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch(null), sec.ValidationError);
  assert.throws(() => sec.validateSettingsPatch([]), sec.ValidationError);
});
