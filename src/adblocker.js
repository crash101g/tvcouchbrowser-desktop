'use strict';
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { ANY, THIRD } = require('./filter-parser');

const MAX_AGE_MS = 24 * 3600 * 1000; // lists are refreshed at least daily
const MAX_ZAPS = 500;
const UBO = 'https://ublockorigin.github.io/uAssets/filters/';

const list = (file, title, url, defaultOn) => ({ file, title, url, defaultOn });
const LISTS = [
  list('easylist.txt', 'EasyList (ads)', 'https://easylist.to/easylist/easylist.txt', true),
  list('easyprivacy.txt', 'EasyPrivacy (trackers)', 'https://easylist.to/easylist/easyprivacy.txt', true),
  list('ubo-filters.txt', 'uBlock filters', UBO + 'filters.txt', true),
  list('ubo-privacy.txt', 'uBlock filters: Privacy', UBO + 'privacy.txt', true),
  list('ubo-badware.txt', 'uBlock filters: Badware risks (scam and fake-download sites)', UBO + 'badware.txt', true),
  list('ubo-quick-fixes.txt', 'uBlock filters: Quick fixes', UBO + 'quick-fixes.txt', true),
  list('ubo-unbreak.txt', 'uBlock filters: Unbreak (fixes sites the other lists break)', UBO + 'unbreak.txt', true),
  list('adguard-popups.txt', 'AdGuard Popups', 'https://filters.adtidy.org/extension/ublock/filters/19.txt', true),
  list('peter-lowe.txt', "Peter Lowe's ad and tracking servers",
    'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext', true),
  list('ubo-annoyances-cookies.txt', 'uBlock filters: Cookie notices', UBO + 'annoyances-cookies.txt', false),
  list('ubo-annoyances-others.txt', 'uBlock filters: Other annoyances', UBO + 'annoyances-others.txt', false),
  list('adguard-mobile.txt', 'AdGuard Mobile Ads (overlaps EasyList)', 'https://filters.adtidy.org/extension/ublock/filters/11.txt', false),
  list('adguard-other-annoyances.txt', 'AdGuard Other Annoyances (large)', 'https://filters.adtidy.org/extension/ublock/filters/21.txt', false),
  list('fanboy-annoyance.txt', "Fanboy's Annoyance (very large: cookie, social, chat)", 'https://secure.fanboy.co.nz/fanboy-annoyance.txt', false),
];

// Captcha and bot-check providers are never blocked: a blocked captcha can't be solved, and the site
// behind it stays locked.
const CHALLENGE_HOSTS = ['challenges.cloudflare.com', 'hcaptcha.com', 'recaptcha.net', 'arkoselabs.com', 'funcaptcha.com'];
const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr',
  'com.br', 'com.mx', 'com.ar', 'com.tr', 'co.in', 'co.za', 'com.cn', 'com.hk', 'com.tw', 'com.sg']);

/** Approximate registrable domain, used to decide first- vs third-party. */
function site(host) {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  return parts.slice(TWO_PART_TLDS.has(parts.slice(-2).join('.')) ? -3 : -2).join('.');
}

function* suffixes(host) {
  let h = host.toLowerCase();
  for (;;) {
    yield h;
    const dot = h.indexOf('.');
    if (dot < 0 || dot === h.length - 1) return;
    h = h.slice(dot + 1);
  }
}

function isChallenge(host, urlPath) {
  const under = (d) => host === d || host.endsWith('.' + d);
  if (CHALLENGE_HOSTS.some(under)) return true;
  return (under('google.com') || under('gstatic.com')) && urlPath.startsWith('/recaptcha');
}

function matches(hosts, paths, host, urlPath, third) {
  for (const h of suffixes(host)) {
    const flags = hosts.get(h);
    if (flags !== undefined && (flags === ANY || (flags === THIRD) === third)) return true;
    const list = paths.get(h);
    if (list && list.some((p) => urlPath.startsWith(p))) return true;
  }
  return false;
}

// Selectors are joined in chunks so one invalid selector only drops its own chunk.
function toCss(selectors) {
  const unique = [...new Set(selectors)];
  const out = [];
  for (let i = 0; i < unique.length; i += 200) out.push(unique.slice(i, i + 200).join(',') + '{display:none!important}');
  return out.join('\n');
}

class AdBlocker {
  constructor(store, dir, fetcher) {
    this.store = store;
    this.dir = dir;
    this.fetcher = fetcher;
    this.filters = null;
    this.queue = Promise.resolve(); // one load or download at a time
    this.updating = false;
    fs.mkdirSync(dir, { recursive: true });
  }

  get ruleCount() { return this.filters ? this.filters.ruleCount : 0; }
  get lastUpdated() { return this.store.get('adblockUpdated', 0); }
  get enabled() { return this.store.get('adblockEnabled', true); }
  set enabled(v) { this.store.set('adblockEnabled', v); }

  isAllowlisted(host) {
    return !!host && this.store.get('adblockAllow', []).includes(host.replace(/^www\./, ''));
  }

  setAllowlisted(host, allowed) {
    const h = host.replace(/^www\./, '');
    const set = new Set(this.store.get('adblockAllow', []));
    if (allowed) set.add(h); else set.delete(h);
    this.store.set('adblockAllow', [...set]);
  }

  /** Blocking and hiding are on for a page on [host]. */
  active(host) { return this.enabled && !this.isAllowlisted(host); }

  // ---- which lists --------------------------------------------------------------------------

  enabledLists() { return new Set(this.store.get('adblockLists', LISTS.filter((l) => l.defaultOn).map((l) => l.file))); }
  setEnabledLists(files) { this.store.set('adblockLists', [...files]); }
  chosen() { const on = this.enabledLists(); return LISTS.filter((l) => on.has(l.file)); }
  missing() { return this.chosen().some((l) => !fs.existsSync(path.join(this.dir, l.file))); }

  // ---- elements the user removed ("zapped"), remembered per site as CSS selectors -------------

  zaps(host) { return this.store.get('zaps', {})[site(host)] || []; }

  /** Saves a selector to hide on [host]'s site. False if it doesn't look like a plain selector. */
  addZap(host, selector) {
    if (selector.length > 200 || !selector.trim() || /[{}<>;@\n]/.test(selector)) return false;
    const all = this.store.get('zaps', {});
    if (Object.values(all).reduce((n, l) => n + l.length, 0) >= MAX_ZAPS) return false;
    const key = site(host);
    all[key] = [...new Set([...(all[key] || []), selector])];
    this.store.set('zaps', all);
    return true;
  }

  zapCount(host) { return this.zaps(host).length; }

  clearZaps(host) {
    const all = this.store.get('zaps', {});
    delete all[site(host)];
    this.store.set('zaps', all);
  }

  zapCss(host) {
    // One rule per selector, so a selector the browser rejects doesn't take the others with it.
    return this.zaps(host).map((s) => s + '{display:none!important}').join('\n');
  }

  // ---- loading --------------------------------------------------------------------------------

  enqueue(job) {
    const run = this.queue.then(job);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Loads the cached lists, downloading them first if missing or older than a day. */
  start() {
    return this.enqueue(async () => {
      const stale = Date.now() - this.lastUpdated > MAX_AGE_MS;
      const missing = this.missing();
      if (!this.filters && !missing) await this.load();
      return missing || stale ? this.download() : 'Filter lists loaded';
    });
  }

  updateNow() { return this.enqueue(() => this.download()); }

  /** Refreshes the lists if the last successful update is a day old; for a browser left open for days. */
  async updateIfStale() {
    if (Date.now() - this.lastUpdated < MAX_AGE_MS || this.updating) return '';
    this.updating = true;
    try { return await this.updateNow(); } finally { this.updating = false; }
  }

  /** After the chosen lists change: fetch any that are missing, then rebuild the filters. */
  reload() {
    return this.enqueue(async () => {
      if (this.missing()) return this.download();
      await this.load();
      return `Filter lists loaded: ${this.ruleCount} rules`;
    });
  }

  async download() {
    const lists = this.chosen();
    let ok = 0;
    for (const l of lists) {
      try {
        const res = await this.fetcher(l.url, { signal: AbortSignal.timeout(45000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length <= 1000) throw new Error('too short');
        const tmp = path.join(this.dir, l.file + '.tmp');
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, path.join(this.dir, l.file));
        ok++;
      } catch (e) {
        console.warn(`download ${l.url} failed: ${e.message}`);
      }
    }
    if (ok > 0) this.store.set('adblockUpdated', Date.now());
    await this.load();
    return ok === lists.length ? 'Filter lists updated' : `Updated ${ok} of ${lists.length} filter lists`;
  }

  load() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'filter-worker.js'), {
        workerData: { dir: this.dir, files: this.chosen().map((l) => l.file) },
      });
      worker.once('message', (filters) => { this.filters = filters; resolve(); });
      worker.once('error', reject);
    });
  }

  // ---- matching -----------------------------------------------------------------------------

  /** True if a subresource request to [url] made from a page on [pageHost] should be blocked. */
  shouldBlock(url, pageHost) {
    const f = this.filters;
    if (!f) return false;
    const host = url.hostname.toLowerCase();
    if (!host || isChallenge(host, url.pathname)) return false;
    const third = !pageHost || site(host) !== site(pageHost);
    const urlPath = url.pathname + url.search;
    if (matches(f.allowHosts, f.allowPaths, host, urlPath, third)) return false;
    return matches(f.blockHosts, f.blockPaths, host, urlPath, third);
  }

  /** True if a pop-up window to [url] opened from [pageHost] is an ad: a blocked host or a `$popup` rule. */
  shouldBlockPopup(url, pageHost) {
    if (this.shouldBlock(url, pageHost)) return true;
    const f = this.filters;
    if (!f) return false;
    const third = !pageHost || site(url.hostname) !== site(pageHost);
    return matches(f.popupHosts, new Map(), url.hostname.toLowerCase(), '', third);
  }

  hostMatches(set, host) {
    for (const h of suffixes(host)) if (set.has(h)) return true;
    return false;
  }

  exceptionsFor(host) {
    const set = new Set(this.filters.genericExceptions);
    for (const h of suffixes(host)) for (const s of this.filters.specificExceptions.get(h) || []) set.add(s);
    return set;
  }

  /**
   * CSS for a frame on [host]. Generic rules without a class/id key apply to every page, so they go
   * only to the top frame: ad frames are blocked by network rules.
   */
  cosmeticCss(host, topFrame) {
    const zapped = this.zapCss(host);
    const f = this.filters;
    if (!f || this.hostMatches(f.noCosmeticHosts, host)) return zapped;
    const skip = this.exceptionsFor(host);
    const out = [];
    for (const h of suffixes(host)) for (const s of f.specific.get(h) || []) if (!skip.has(s)) out.push(s);
    if (topFrame && !this.hostMatches(f.noGenericHosts, host)) for (const s of f.genericComplex) if (!skip.has(s)) out.push(s);
    return toCss(out) + '\n' + zapped;
  }

  /** CSS for generic selectors keyed by the given classes (".x") and ids ("#x") seen in the page. */
  genericCss(host, tokens) {
    const f = this.filters;
    if (!f || this.hostMatches(f.noCosmeticHosts, host) || this.hostMatches(f.noGenericHosts, host)) return '';
    const skip = this.exceptionsFor(host);
    const out = [];
    for (const t of tokens) for (const s of f.genericByToken.get(t) || []) if (!skip.has(s)) out.push(s);
    return toCss(out);
  }
}

module.exports = { AdBlocker, LISTS, MAX_AGE_MS, site };
