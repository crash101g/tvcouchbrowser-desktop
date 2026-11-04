'use strict';
// Loads filters off the main thread: from the cache if it is current, otherwise by parsing the lists.
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { parentPort, workerData } = require('worker_threads');
const { parseLists } = require('./filter-parser');

const CACHE_VERSION = 1;

function load({ dir, files }) {
  const cache = path.join(dir, 'parsed.bin');
  const present = files.map((n) => path.join(dir, n)).filter((p) => fs.existsSync(p));
  const newest = Math.max(0, ...present.map((p) => fs.statSync(p).mtimeMs));
  const signature = files.join(',');
  try {
    if (fs.statSync(cache).mtimeMs >= newest) {
      const saved = v8.deserialize(fs.readFileSync(cache));
      if (saved.version === CACHE_VERSION && saved.signature === signature) return saved.filters;
    }
  } catch { /* missing or unreadable: parse instead */ }
  const filters = parseLists(present.map((p) => fs.readFileSync(p, 'utf8')));
  try {
    const tmp = cache + '.tmp';
    fs.writeFileSync(tmp, v8.serialize({ version: CACHE_VERSION, signature, filters }));
    fs.renameSync(tmp, cache);
  } catch (e) { console.warn('filter cache not written:', e.message); }
  return filters;
}

parentPort.postMessage(load(workerData));
