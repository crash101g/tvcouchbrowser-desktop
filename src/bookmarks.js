'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = [
  { url: 'https://duckduckgo.com/', title: 'DuckDuckGo' },
  { url: 'https://www.youtube.com/', title: 'YouTube' },
  { url: 'https://en.wikipedia.org/', title: 'Wikipedia' },
  { url: 'https://www.bbc.com/news', title: 'BBC News' },
];

/** Start-screen bookmarks in order, with a page thumbnail per bookmark when one was captured. */
class Bookmarks {
  constructor(store, dir) {
    this.store = store;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.items = store.get('bookmarks', DEFAULTS.map((b) => ({ ...b })));
  }

  save() { this.store.set('bookmarks', this.items); }

  add(bookmark, jpeg) {
    this.items = this.items.filter((b) => b.url !== bookmark.url);
    this.items.push(bookmark);
    if (jpeg) fs.writeFileSync(this.thumbFile(bookmark.url), jpeg);
    this.save();
  }

  remove(index) {
    const [b] = this.items.splice(index, 1);
    fs.rmSync(this.thumbFile(b.url), { force: true });
    this.save();
  }

  /** Moves the bookmark at [from] to [to] (clamped) and returns its new index. */
  move(from, to) {
    const t = Math.max(0, Math.min(to, this.items.length - 1));
    this.items.splice(t, 0, this.items.splice(from, 1)[0]);
    this.save();
    return t;
  }

  /** The thumbnail as a data: URL, or null. */
  thumb(url) {
    try { return 'data:image/jpeg;base64,' + fs.readFileSync(this.thumbFile(url)).toString('base64'); } catch { return null; }
  }

  thumbFile(url) {
    return path.join(this.dir, crypto.createHash('sha1').update(url).digest('hex') + '.jpg');
  }
}

module.exports = { Bookmarks };
