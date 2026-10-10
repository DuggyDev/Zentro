'use strict';
const fs = require('fs');
const path = require('path');

/** Tiny JSON file store with atomic writes and corruption recovery. */
class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep the unreadable file for inspection and start clean.
        try { fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      }
      this.data = {};
    }
    return this.data;
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('Could not save Zentro data:', err.message);
    }
  }
}

module.exports = { JsonStore };
