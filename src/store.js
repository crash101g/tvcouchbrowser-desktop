'use strict';
const fs = require('fs');
const path = require('path');

/** A JSON settings file, written atomically a moment after the last change. Readable only by this user. */
class Store {
  constructor(file) {
    this.file = file;
    this.timer = null;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    if (typeof this.data !== 'object' || this.data === null) this.data = {};
  }

  get(key, fallback) { return key in this.data ? this.data[key] : fallback; }

  set(key, value) {
    this.data[key] = value;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
