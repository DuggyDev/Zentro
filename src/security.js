'use strict';
/**
 * Security helpers shared by the main process and the download engine.
 * Nothing in here touches Electron, so it can be unit-tested with plain Node.
 */
const path = require('path');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.expose = true; // safe to show to the user
  }
}

// Files that can run code when opened. Zentro asks before opening any of these.
const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.msi', '.msp', '.msix', '.msixbundle', '.appx', '.appxbundle',
  '.bat', '.cmd', '.com', '.scr', '.pif', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.reg', '.cpl',
  '.msc', '.dll', '.sys', '.gadget', '.application', '.scf', '.url', '.inf', '.chm',
]);

function isDangerousFile(name) {
  return DANGEROUS_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

/**
 * Validate and normalise a user supplied link. Only http: and https: pass.
 * Returns a WHATWG URL object or throws ValidationError with a friendly message.
 */
function validateUrl(raw) {
  if (typeof raw !== 'string') throw new ValidationError('Paste a download link first.');
  let s = raw.trim();
  if (!s) throw new ValidationError('Paste a download link first.');
  if (s.length > 2048) throw new ValidationError('That link is too long (the limit is 2048 characters).');
  if (/[\u0000-\u001f\u007f\s]/.test(s)) throw new ValidationError('That link contains spaces or hidden characters. Copy it again.');

  if (s.includes('\\')) throw new ValidationError('That looks like a file path, not a web link. Paste an http:// or https:// link.');

  // "example.com/file.zip" -> assume https
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError('That doesn\u2019t look like a valid link. Make sure it starts with http:// or https://');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ValidationError(`Only http:// and https:// links are supported (this one uses ${u.protocol}//).`);
  }
  if (!u.hostname) throw new ValidationError('That link has no website address in it.');
  if (u.username || u.password) {
    throw new ValidationError('Links with a username or password inside them are not supported.');
  }
  return u;
}

/** Turn any string into a safe single Windows file name (no folders, no reserved names). */
function sanitizeFileName(name, fallback = 'download') {
  let n = String(name == null ? '' : name);
  try { n = n.normalize('NFC'); } catch { /* ignore */ }
  n = n.replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''); // bidi tricks that hide extensions
  n = n.split(/[\\/]/).pop();                                     // drop any folder parts
  n = n.replace(/[<>:"|?*]/g, '_');
  n = n.replace(/^[\s.]+|[\s.]+$/g, '');                          // no leading/trailing dots or spaces
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(n.split('.')[0])) n = '_' + n;
  if (n.length > 180) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n || fallback;
}

/** Join dir + name and make sure the result is still inside dir. */
function resolveInside(dir, name) {
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError('Unsafe file path blocked.');
  }
  return full;
}

/** Extract a file name from Content-Disposition (RFC 6266 / 5987). */
function fileNameFromHeaders(headers) {
  const cd = headers && headers['content-disposition'];
  if (!cd || typeof cd !== 'string') return null;
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ }
  }
  m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd);
  if (m) return m[1].replace(/\\(.)/g, '$1');
  m = /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) return m[1].trim();
  return null;
}

function fileNameFromUrl(u) {
  const url = typeof u === 'string' ? new URL(u) : u;
  const seg = url.pathname.split('/').filter(Boolean).pop() || '';
  let name = seg;
  try { name = decodeURIComponent(seg); } catch { /* keep raw */ }
  return name || url.hostname || 'download';
}

/** Whitelist + type-check settings changes coming from the renderer. */
function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ValidationError('Invalid settings.');
  }
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    switch (key) {
      case 'downloadDir':
        if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 200 || /[\u0000-\u001f]/.test(value)) {
          throw new ValidationError('Choose a full folder path for downloads.');
        }
        out.downloadDir = path.normalize(value);
        break;
      case 'notifications':
        if (typeof value !== 'boolean') throw new ValidationError('Invalid notification setting.');
        out.notifications = value;
        break;
      case 'maxConcurrent':
        if (!Number.isInteger(value) || value < 1 || value > 8) throw new ValidationError('Simultaneous downloads must be between 1 and 8.');
        out.maxConcurrent = value;
        break;
      default:
        throw new ValidationError(`Unknown setting: ${String(key).slice(0, 40)}`);
    }
  }
  return out;
}

module.exports = {
  ValidationError,
  isDangerousFile,
  validateUrl,
  sanitizeFileName,
  resolveInside,
  fileNameFromHeaders,
  fileNameFromUrl,
  validateSettingsPatch,
};
