'use strict';
// TVCouchBrowser page script. Runs at document start in every frame, in an isolated world: pages can't
// see or replace it. The app calls the functions in `api` in the top frame through the tvcb:call message.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const top = window === window.top;
const host = location.hostname;
const isHttp = location.protocol === 'http:' || location.protocol === 'https:';

// ---- cosmetic filtering, and the one script that must share the page's world ----------------------
const page = isHttp && host ? ipcRenderer.sendSync('tvcb:page', host, top) : { active: false, css: '' };
if (page.css) webFrame.insertCSS(page.css);

/**
 * Runs in the page's own world, before any page script. Alerts, confirms and prompts go to the app's
 * own dialog, so a remote or phone can answer them. `ask` is only held in this closure.
 */
function inPage(prune, ask) {
  const text = (v) => (v === undefined ? '' : String(v));
  window.alert = function alert(m) { ask('alert', text(m), ''); };
  window.confirm = function confirm(m) { return ask('confirm', text(m), '') === true; };
  window.prompt = function prompt(m, d) {
    const r = ask('prompt', text(m), text(d));
    return typeof r === 'string' ? r : null;
  };

  // YouTube: drop the ad fields from player responses (what uBO's json-prune scriptlets do).
  if (!prune) return;
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const strip = (o) => {
    if (o && typeof o === 'object') {
      for (const k of AD_KEYS) if (k in o) delete o[k];
      if (o.playerResponse) strip(o.playerResponse);
    }
    return o;
  };
  for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
    let v;
    try {
      Object.defineProperty(window, name, { configurable: true, get: () => v, set: (x) => { v = strip(x); } });
    } catch (e) { /* already defined */ }
  }
  const parse = JSON.parse;
  JSON.parse = function () { return strip(parse.apply(this, arguments)); };
  const json = Response.prototype.json;
  Response.prototype.json = function () { return json.apply(this, arguments).then(strip); };
}

if (isHttp) {
  contextBridge.executeInMainWorld({
    func: inPage,
    args: [page.active && /(^|\.)youtube\.com$/.test(host),
      (kind, message, value) => ipcRenderer.sendSync('tvcb:dialog', kind, message.slice(0, 2000), value.slice(0, 2000))],
  });
}

const isHtml = () => (document.documentElement ? document.documentElement.namespaceURI === 'http://www.w3.org/1999/xhtml'
  : /html/.test(document.contentType || ''));

if (page.active && isHtml()) {
  const seen = new Set();
  let queued = [];
  const collect = (root) => {
    const each = (el) => {
      if (el.id && !seen.has('#' + el.id)) { seen.add('#' + el.id); queued.push('#' + el.id); }
      if (el.classList) for (const c of el.classList) if (!seen.has('.' + c)) { seen.add('.' + c); queued.push('.' + c); }
    };
    if (root.nodeType === 1) each(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll('[id],[class]')) each(el);
  };
  let timer = 0;
  const flush = async () => {
    timer = 0;
    if (!queued.length) return;
    const batch = queued.slice(0, 5000);
    queued = queued.slice(5000);
    const css = await ipcRenderer.invoke('tvcb:generic', host, batch);
    if (css) webFrame.insertCSS(css);
    if (queued.length) schedule();
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 300); };
  const start = () => {
    collect(document);
    flush();
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) collect(n);
      if (queued.length) schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

// ---- media: keep the screen on while something plays -----------------------------------------------
{
  const report = () => {
    const playing = [...document.querySelectorAll('video,audio')].some((m) => !m.paused && !m.ended);
    ipcRenderer.send('tvcb:media', playing);
  };
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, report, true);
}

// ---- what the app must know: a person clicked, or a text field has focus ---------------------------
for (const ev of ['pointerdown', 'mousedown', 'keydown']) {
  window.addEventListener(ev, (e) => { if (e.isTrusted) ipcRenderer.send('tvcb:gesture'); }, true);
}

const deepActive = () => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
};

const editable = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
  (el.tagName === 'INPUT' && /^(text|search|url|email|password|tel|number|)$/i.test(el.type)));

{
  const report = () => {
    const el = deepActive();
    if (el && el.tagName === 'IFRAME') return; // that frame reports for itself
    ipcRenderer.send('tvcb:editing', editable(el));
  };
  document.addEventListener('focusin', report, true);
  document.addEventListener('focusout', () => setTimeout(report, 0), true);
}

if (top) {
  // ---- link mode ------------------------------------------------------------------------------------
  const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],' +
    '[role=tab],[role=menuitem],[role=option],[role=checkbox],[onclick],[tabindex]:not([tabindex="-1"]),' +
    '[contenteditable=""],[contenteditable=true],iframe';
  let current = null;
  let ring = null;

  const visibleRect = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || +st.opacity === 0) return null;
    return r;
  };

  const candidates = () => {
    const out = [];
    for (const el of document.querySelectorAll(FOCUSABLE)) {
      if (el.disabled) continue;
      const r = visibleRect(el);
      if (!r) continue;
      // skip elements covered by something else (e.g. hidden behind a dialog)
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) continue;
      out.push({ el, r });
    }
    // drop wrappers that contain another candidate, keep the innermost
    return out.filter((c) => !out.some((o) => o !== c && c.el.contains(o.el) && c.el.tagName !== 'A'));
  };

  const showRing = (el) => {
    if (!ring) {
      ring = document.createElement('div');
      // White ring, dark outline, blue glow: visible on light, dark and blue pages alike.
      ring.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:4px solid #fff;' +
        'border-radius:8px;box-shadow:0 0 0 3px #000,0 0 0 6px #4DA3FF,0 0 22px 6px rgba(77,163,255,.7);' +
        'transition:all .08s';
    }
    if (!ring.isConnected) document.documentElement.appendChild(ring);
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, {
      // 8px clear of the element on every side (4px gap + 4px border)
      left: r.left - 8 + 'px', top: r.top - 8 + 'px', width: r.width + 8 + 'px', height: r.height + 8 + 'px',
      display: 'block',
    });
  };

  const hideRing = () => { if (ring) ring.style.display = 'none'; };
  const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  const focusEl = (el) => {
    current = el;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    showRing(el);
    try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } catch (e) { /* ignore */ }
  };

  const scrollDir = (dir) => {
    const dx = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const dy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
    window.scrollBy({ left: dx * innerWidth * 0.4, top: dy * innerHeight * 0.4, behavior: 'smooth' });
    current = null; hideRing();
    return 'scrolled';
  };

  // Picks the nearest candidate in a direction: distance along it plus 2x the sideways offset.
  const nav = (dir) => {
    const list = candidates();
    const from = current && current.isConnected ? visibleRect(current) : null;
    if (!from) {
      const first = list.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left))[0];
      if (first) { focusEl(first.el); return 'ok'; }
      return scrollDir(dir);
    }
    const c = center(from);
    let best = null; let bestScore = Infinity;
    for (const { el, r } of list) {
      if (el === current) continue;
      const p = center(r);
      let along; let side;
      if (dir === 'right') { if (p.x <= c.x) continue; along = r.left - from.right; side = Math.abs(p.y - c.y); }
      if (dir === 'left') { if (p.x >= c.x) continue; along = from.left - r.right; side = Math.abs(p.y - c.y); }
      if (dir === 'down') { if (p.y <= c.y) continue; along = r.top - from.bottom; side = Math.abs(p.x - c.x); }
      if (dir === 'up') { if (p.y >= c.y) continue; along = from.top - r.bottom; side = Math.abs(p.x - c.x); }
      const score = Math.max(along, 0) + 2 * side;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) { focusEl(best); return 'ok'; }
    return scrollDir(dir);
  };

  // Where the app should click to activate the focused element, as fractions of the viewport.
  const target = () => {
    const r = current && current.isConnected ? visibleRect(current) : null;
    if (!r) return null;
    const p = center(r);
    return { x: p.x / innerWidth, y: p.y / innerHeight };
  };

  // ---- cursor mode: scroll whatever is under the cursor --------------------------------------------
  const scrollAt = (fx, fy, dx, dy) => {
    let el = document.elementFromPoint(fx * innerWidth, fy * innerHeight);
    while (el && el !== document.body && el !== document.documentElement) {
      const st = getComputedStyle(el);
      const canY = dy && /(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1;
      const canX = dx && /(auto|scroll)/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (canY || canX) {
        const beforeT = el.scrollTop; const beforeL = el.scrollLeft;
        el.scrollBy(dx, dy);
        if (el.scrollTop !== beforeT || el.scrollLeft !== beforeL) return;
      }
      el = el.parentElement;
    }
    window.scrollBy(dx, dy);
  };

  const pageBy = (dir) => { window.scrollBy({ top: dir * innerHeight * 0.85, behavior: 'smooth' }); };

  // ---- video keys ------------------------------------------------------------------------------------
  const activeVideo = () => {
    const vids = [...document.querySelectorAll('video')];
    return vids.find((v) => !v.paused) ||
      vids.map((v) => ({ v, a: v.clientWidth * v.clientHeight })).sort((a, b) => b.a - a.a).map((o) => o.v)[0];
  };

  const media = (cmd) => {
    const v = activeVideo();
    if (!v) return 'none';
    switch (cmd) {
      case 'playpause': if (v.paused) v.play(); else v.pause(); break;
      case 'play': v.play(); break;
      case 'pause': v.pause(); break;
      case 'ff': v.currentTime = Math.min(v.currentTime + 10, v.duration || Infinity); break;
      case 'rew': v.currentTime = Math.max(v.currentTime - 10, 0); break;
      case 'next': v.currentTime = Math.min(v.currentTime + 60, v.duration || Infinity); break;
      case 'prev': v.currentTime = Math.max(v.currentTime - 60, 0); break;
    }
    return 'ok';
  };

  const exitFullscreen = () => {
    if (document.fullscreenElement) { document.exitFullscreen(); return true; }
    return false;
  };

  // ---- typing from the phone -------------------------------------------------------------------------
  // Makes sure something can take the text; the app then inserts it, whichever frame has focus.
  const prepareType = () => {
    let el = deepActive();
    if (!editable(el) && current && editable(current)) { el = current; el.focus(); }
    if (editable(el)) return 'ok';
    return el && el.tagName === 'IFRAME' ? 'iframe' : 'nofield';
  };

  const blur = () => { const el = deepActive(); if (el && el.blur) el.blur(); };

  // ---- clean up: overlays, cookie walls, sticky ad bars, scroll locks --------------------------------
  const ANNOY = /(^|[-_\s])(ad|ads|advert|adsbox|banner|sponsor|promo|cookie|consent|gdpr|cmp|newsletter|subscribe|popup|pop-up|modal|overlay|interstitial|paywall|lightbox|backdrop)([-_\s]|$)/i;
  const nameOf = (el) => (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');

  const unlockScroll = () => {
    let changed = false;
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const st = getComputedStyle(el);
      if (st.overflow === 'hidden' || st.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('overflow-y', 'auto', 'important');
        changed = true;
      }
      if (el === document.body && st.position === 'fixed') {
        // Sites lock scrolling by fixing the body at -scrollY; put it back where it was.
        const y = -parseInt(el.style.top || '0', 10) || 0;
        el.style.setProperty('position', 'static', 'important');
        el.style.setProperty('top', 'auto', 'important');
        if (y) window.scrollTo(0, y);
        changed = true;
      }
    }
    // Paywalls and cookie walls blur the article behind them.
    for (const el of document.querySelectorAll('body, body > *, main, article')) {
      const f = getComputedStyle(el).filter;
      if (f && f.includes('blur')) { el.style.setProperty('filter', 'none', 'important'); changed = true; }
    }
    return changed;
  };

  const cleanup = () => {
    let n = 0;
    const vw = innerWidth; const vh = innerHeight;
    const links = document.querySelectorAll('a[href]').length;
    const fs = document.fullscreenElement;
    for (const el of document.querySelectorAll('body *')) {
      if (!el.isConnected) continue;
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'sticky') continue;
      if (fs && (el.contains(fs) || fs.contains(el))) continue;
      if (el === ring) continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (!w || !h) continue;
      const cover = (w * h) / (vw * vh);
      // Never take the page's own layout: something holding most of its links is the site itself.
      const own = el.querySelectorAll('a[href]').length;
      if (links > 20 && own > links * 0.5) continue;
      const big = cover >= 0.3 && st.position === 'fixed';
      const annoying = ANNOY.test(nameOf(el)) && own <= 8;
      const adFrame = cover < 0.3 && own <= 3 && el.querySelector('iframe') && (r.top <= 0 || r.bottom >= vh - 1);
      if (big || annoying || adFrame) { el.remove(); n++; }
    }
    if (unlockScroll()) n++;
    return n;
  };

  // ---- remove element ("zap") and a selector to remember it by ---------------------------------------
  const stableName = (x) => /^[A-Za-z_][\w-]{1,40}$/.test(x) && !/\d{4,}/.test(x) && !/^(css|sc|jsx|emotion)-/.test(x);

  const selectorFor = (el) => {
    const tag = el.tagName.toLowerCase();
    let sel = '';
    if (el.id && stableName(el.id)) sel = '#' + CSS.escape(el.id);
    else if (tag === 'iframe' && el.src) {
      try {
        const u = new URL(el.src, location.href);
        if (u.hostname && u.hostname !== location.hostname) sel = 'iframe[src*="' + u.hostname.replace(/"/g, '') + '"]';
      } catch (e) { /* ignore */ }
    }
    if (!sel) {
      const cls = [...el.classList].filter(stableName).slice(0, 3);
      if (!cls.length) return '';
      sel = tag + cls.map((c) => '.' + CSS.escape(c)).join('');
      const p = el.parentElement;
      if (p && p.id && stableName(p.id)) sel = '#' + CSS.escape(p.id) + ' > ' + sel;
    }
    // Only remember selectors that pick out this element and few others.
    try {
      const count = document.querySelectorAll(sel).length;
      return count >= 1 && count <= 3 ? sel : '';
    } catch (e) { return ''; }
  };

  const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };

  // Returns '' (nothing there), '-' (removed, not remembered) or the selector to remember.
  const zapEl = (start) => {
    let el = start;
    if (!el || el === document.body || el === document.documentElement || el === ring) return '';
    // Climb out of wrappers that are barely bigger than what was pointed at.
    while (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement &&
      area(el.parentElement) <= area(el) * 1.25) el = el.parentElement;
    const sel = selectorFor(el);
    el.remove();
    unlockScroll();
    if (current && !current.isConnected) { current = null; hideRing(); }
    return sel || '-';
  };

  const zapAt = (fx, fy) => {
    hideRing();
    return zapEl(document.elementFromPoint(fx * innerWidth, fy * innerHeight));
  };

  const zapCurrent = () => (current && current.isConnected ? zapEl(current) : '');

  const api = { nav, target, hideRing, scrollAt, pageBy, media, exitFullscreen, prepareType, blur, cleanup, zapAt, zapCurrent,
    reset: () => { current = null; hideRing(); } };

  ipcRenderer.on('tvcb:call', (_e, id, fn, args) => {
    let result = null;
    try { result = Object.hasOwn(api, fn) ? api[fn](...args) : null; } catch (e) { /* the page changed underneath us */ }
    ipcRenderer.send('tvcb:reply', id, result === undefined ? null : result);
  });
}
