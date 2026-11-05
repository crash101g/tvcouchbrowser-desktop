'use strict';
const fs = require('fs');
const path = require('path');
const electron = require('electron');
const { app, BaseWindow, WebContentsView, Menu, ipcMain, net, powerSaveBlocker, safeStorage, session } = electron;
const { AdBlocker, LISTS, MAX_AGE_MS, site } = require('./adblocker');
const { Bookmarks } = require('./bookmarks');
const { PhoneServer, lanAddress } = require('./phone-server');
const { MAC_MENU, commandHeld, desktopUserAgent } = require('./platform');
const { Store } = require('./store');
const { TokenStore } = require('./tokens');
const qrcode = require('../vendor/qrcode.js');

const MAX_TABS = 6;
const MAX_JS_DIALOGS = 2;
const POINTER_MS = 5000; // the pointer stays up this long after the last use
const GESTURE_MS = 5000; // how long a click or key press allows a new window, as in Chrome
const HOLD_OK_MS = 500;
const HOLD_BACK_MS = 600;
const PAD_SCROLL_GAIN = 2.5;
const MIN_ZOOM = 0.25, MAX_ZOOM = 5;
const CURSOR_W = 30, CURSOR_H = 42;
const TOP_EDGE = 3; // the mouse this close to the top of the window shows the address bar
const DIRS = ['up', 'down', 'left', 'right'];
const ARROWS = { ArrowUp: 0, ArrowDown: 1, ArrowLeft: 2, ArrowRight: 3 };
const SEARCH_ENGINES = [
  ['DuckDuckGo', 'https://duckduckgo.com/?q='],
  ['Google', 'https://www.google.com/search?q='],
  ['Bing', 'https://www.bing.com/search?q='],
];
const MEDIA_KEYS = {
  MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaFastForward: 'ff', MediaRewind: 'rew',
  MediaTrackNext: 'next', MediaTrackPrevious: 'prev',
};
const UI = (file) => path.join(__dirname, 'ui', file);
const test = global.__tvcbTest || {}; // set only by test/e2e.js

const chrome = process.versions.chrome.split('.')[0];
const DESKTOP_UA = desktopUserAgent(chrome);
const MOBILE_UA = `Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;

const argv = process.argv.slice(1);
const windowed = argv.includes('--windowed');
const urlArg = (args) => args.find((a) => /^https?:\/\//i.test(a)) || null;

let store, blocker, bookmarks, tokens, server, web;
let win, uiView, toastView, cursorView;
const tabs = [];
let current = 0;
const tab = () => tabs[current];

// What is on top of the page. `start` covers it completely; the others are overlays.
const screens = { start: false, startFocus: null, menu: null, address: null, dialog: null };
let cursorMode = true;
let fullscreen = false;
let zapNext = false;
let pointer = { x: 0, y: 0 };
let pointerMoved = false;
let pointerUntil = 0;
let pointerTimer = null;
let scale = 1; // window pixels per upstream "dp": sizes were tuned on a 1280-wide TV
let keepAwake = null;
let injecting = false; // this app is sending input, as the remote or phone pointer
let mouseHeld = false;
let mouseAtTop = true; // until seen lower down: a view that appears reports the mouse where it already is

// ---- small helpers ------------------------------------------------------------------------------

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };
const isHttp = (url) => /^https?:/i.test(url || '');
const bounds = () => { const b = win.getContentBounds(); return { width: b.width, height: b.height }; };
const browsing = () => !screens.start && !!tab().view;
const overlayShown = () => !!(screens.dialog || screens.menu || screens.address || screens.start);
const textOverlay = () => !!(screens.dialog?.prompt !== undefined && screens.dialog?.prompt !== null) || (!!screens.address && !screens.dialog && !screens.menu);

function toast(text) {
  toastView.webContents.send('ui:toast', text);
  toastView.setVisible(true);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastView.setVisible(false), 2200);
}

function send(wc, ...events) {
  if (wc.isDestroyed()) return;
  injecting = true; // before-mouse-event sees these too, and fires during sendInputEvent
  try { for (const ev of events) wc.sendInputEvent(ev); } finally { injecting = false; }
}

/** Calls a function in the page script's `api`, in the top frame. Resolves null if the page can't answer. */
const calls = new Map();
let nextCall = 1;
function call(t, fn, ...args) {
  if (!t?.view) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextCall++;
    const done = (v) => { if (calls.delete(id)) resolve(v); };
    calls.set(id, done);
    setTimeout(() => done(null), 2000);
    try { t.view.webContents.send('tvcb:call', id, fn, args); } catch { done(null); }
  });
}

ipcMain.on('tvcb:reply', (_e, id, value) => calls.get(id)?.(value));

// ---- tabs and web views -------------------------------------------------------------------------

function newTab(url, title = '') {
  return { url, title, view: null, pageHost: hostOf(url), blocked: 0, jsDialogs: 0, editing: false, lastGesture: 0, zoom: 1, playing: false };
}

const tabOf = (wc) => tabs.find((t) => t.view?.webContents === wc);
const tabById = (id) => tabs.find((t) => t.view?.webContents.id === id);

function createView(t) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      session: web,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // runs the preload in every frame; it never exposes Node
      webviewTag: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
      plugins: true, // the Widevine CDM
    },
  });
  view.setBackgroundColor('#ffffff');
  const wc = view.webContents;
  t.view = view;
  wc.setUserAgent(uaFor(t.url));
  wc.on('before-input-event', (e, input) => onInput(e, input));
  wc.on('before-mouse-event', (_e, event) => onMouse(event));
  wc.setWindowOpenHandler(({ url }) => {
    // Without a recent click these are pop-ups and pop-unders.
    if (Date.now() - t.lastGesture < GESTURE_MS) { t.lastGesture = 0; newWindow(t, url); } // one click, one window
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e) => {
    const url = e.url;
    if (!e.isMainFrame) return;
    if (!isHttp(url)) { e.preventDefault(); toast(`Can't open ${url.split(':')[0]} links`); return; }
    // A page sending itself to an ad or tracker domain without a click: a forced redirect.
    const parsed = new URL(url);
    if (Date.now() - t.lastGesture > GESTURE_MS && t.pageHost && blocker.active(t.pageHost) && blocker.shouldBlock(parsed, t.pageHost)) {
      e.preventDefault();
      toast(`Blocked a redirect to ${parsed.hostname}`);
      return;
    }
    if (wc.getUserAgent() !== uaFor(url)) { e.preventDefault(); wc.setUserAgent(uaFor(url)); wc.loadURL(url); }
  });
  // At commit, not at the start of the navigation: will-navigate has to judge it against the page it left.
  wc.on('did-navigate', (_e, url) => {
    t.pageHost = hostOf(url);
    t.blocked = 0;
    t.jsDialogs = 0;
    t.editing = false;
    t.lastGesture = 0; // a click on one page gives the next page nothing
    t.url = url;
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) t.url = url; });
  wc.on('page-title-updated', (_e, title) => { t.title = title; if (screens.address) render(); });
  wc.on('did-finish-load', () => {
    t.url = wc.getURL() || t.url;
    saveTabs();
    if (t === tab() && isAutoClean(t.pageHost)) {
      cleanUpPage(true);
      setTimeout(() => { if (t === tab()) cleanUpPage(true); }, 3000); // late pop-ups
    }
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && t === tab()) toast(`Couldn't open ${hostOf(url) || url}: ${description}`);
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !t.url) return;
    toast('The page crashed and was reloaded');
    wc.reload();
  });
  wc.on('will-prevent-unload', (e) => e.preventDefault()); // "Are you sure you want to leave?" never traps Back
  wc.on('enter-html-full-screen', () => { fullscreen = true; updateCursor(); updateKeepAwake(); });
  wc.on('leave-html-full-screen', () => { fullscreen = false; updateCursor(); updateKeepAwake(); });
  return view;
}

function layout() {
  const { width, height } = bounds();
  scale = Math.max(width / 1280, 0.5);
  const full = { x: 0, y: 0, width, height };
  tab()?.view?.setBounds(full);
  uiView.setBounds(full);
  toastView.setBounds({ x: Math.round(width * 0.15), y: Math.round(height - 96 * scale), width: Math.round(width * 0.7), height: Math.round(52 * scale) });
  // The final size can arrive after the window opens, so the pointer stays centred until it is used.
  pointer = pointerMoved ? { x: Math.min(pointer.x, width - 1), y: Math.min(pointer.y, height - 1) } : { x: width / 2, y: height / 2 };
  placeCursor();
}

function placeCursor() {
  cursorView.setBounds({ x: Math.round(pointer.x), y: Math.round(pointer.y), width: Math.round(CURSOR_W * scale), height: Math.round(CURSOR_H * scale) });
}

function showTab(index) {
  const old = tab();
  current = index;
  const t = tab();
  if (old !== t && old?.view) {
    win.contentView.removeChildView(old.view);
    call(old, 'media', 'pause');
  }
  if (!t.view) {
    createView(t);
    if (t.url) t.view.webContents.loadURL(t.url).catch(() => {});
  }
  win.contentView.addChildView(t.view, 0);
  layout();
  screens.start = false;
  render();
  updateCursor();
  updateKeepAwake();
}

function showStart(focus = null) {
  screens.start = true;
  screens.startFocus = focus;
  call(tab(), 'media', 'pause');
  render();
  updateCursor();
}

function openInNewTab(url) {
  if (tabs.length >= MAX_TABS) { load(url); toast(`Opened here: ${MAX_TABS} tabs is the limit`); return; }
  tabs.push(newTab(url));
  showTab(tabs.length - 1);
}

/**
 * A new window the page opened after a click. Same-site windows open in a tab. A window to a filtered ad
 * domain is dropped. A window to another site is the click-anywhere pop-under trick as often as a real
 * link, so it asks first.
 */
function newWindow(from, url) {
  if (!isHttp(url)) { toast('Blocked a pop-up'); return; }
  const target = new URL(url);
  const page = from.pageHost;
  const active = !!page && blocker.active(page);
  if (active && blocker.shouldBlockPopup(target, page)) { toast('Blocked a pop-up ad'); return; }
  if (!active || site(target.hostname) === site(page)) { openInNewTab(url); return; }
  showDialog(`This page wants to open ${target.hostname}`, [
    ['Open it in a new tab', () => openInNewTab(url)],
    ['Open it here', () => load(url)],
    ['Block it', () => toast('Blocked a pop-up')],
  ]);
}

function closeTab(index) {
  const [t] = tabs.splice(index, 1);
  if (t.view) {
    win.contentView.removeChildView(t.view);
    t.view.webContents.close({ waitForBeforeUnload: false });
    t.view = null;
  }
  if (!tabs.length) { tabs.push(newTab(null)); current = 0; showStart(); return; }
  current = Math.min(current, tabs.length - 1);
  if (tab().url) showTab(current); else showStart();
  updateKeepAwake();
}

/** Loads [input] (a URL or a search) in the current tab. */
function load(input) {
  const url = resolve(input);
  if (!url) { toast("Can't open that address"); return; }
  const t = tab();
  t.url = url;
  if (t.view) {
    t.view.webContents.setUserAgent(uaFor(url));
    t.view.webContents.loadURL(url).catch(() => {});
  }
  showTab(current); // creates the view and loads t.url if there wasn't one
}

/** Turns typed text into an http(s) URL, or a search URL. Returns null for other schemes. */
function resolve(input) {
  const s = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') return URL.canParse(s) ? s : null;
  if (scheme && !/\s/.test(s) && !/^[\w.-]+:\d+/.test(s) && !scheme.includes('.')) return null; // javascript:, data:, file: ...
  if (!/\s/.test(s) && (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) || s.startsWith('localhost'))) return 'https://' + s;
  return SEARCH_ENGINES[searchEngine()][1] + encodeURIComponent(s);
}

const searchEngine = () => Math.min(store.get('search', 0), SEARCH_ENGINES.length - 1);

function saveTabs() {
  store.set('tabs', tabs.map((t) => ({ url: t.url || '', title: t.title })));
  store.set('current', current);
}

function restoreTabs() {
  for (const o of store.get('tabs', []).slice(0, MAX_TABS)) tabs.push(newTab(o.url || null, o.title));
  if (!tabs.length) tabs.push(newTab(null));
  current = Math.max(0, Math.min(store.get('current', 0), tabs.length - 1));
}

// ---- user agent: a computer shows desktop sites unless asked for the mobile one -------------------

const mobileSites = () => store.get('mobile', []);
const isMobile = (url) => { const h = hostOf(url); return !!h && mobileSites().includes(site(h)); };
const uaFor = (url) => (isMobile(url) ? MOBILE_UA : DESKTOP_UA);

function toggleMobile() {
  const t = tab();
  if (!t.pageHost) return;
  const s = site(t.pageHost);
  const on = !mobileSites().includes(s);
  store.set('mobile', on ? [...mobileSites(), s] : mobileSites().filter((x) => x !== s));
  if (t.view) { t.view.webContents.setUserAgent(uaFor(t.url)); t.view.webContents.reload(); }
  toast(on ? `Mobile site on for ${s}` : `Desktop site for ${s}`);
}

// ---- drawing the app's own screens ------------------------------------------------------------

function render() {
  const s = {
    start: screens.start ? {
      bookmarks: bookmarks.items.map((b) => ({ ...b, thumb: bookmarks.thumb(b.url) })),
      hint: 'Menu key, F1 or hold Back (Esc): browser menu  ·  Hold OK on a tile: move or remove',
      focus: screens.startFocus,
    } : null,
    address: screens.address && {
      ...screens.address,
      tabs: tabs.length > 1 ? tabs.map((t, i) => ({ name: tabName(t), current: i === current })) : null,
    },
    menu: screens.menu && { items: screens.menu.map(({ label, symbol }) => ({ label, symbol })) },
    dialog: screens.dialog && {
      title: screens.dialog.title,
      message: screens.dialog.message,
      qr: screens.dialog.qr,
      prompt: screens.dialog.prompt,
      checks: screens.dialog.checks,
      buttons: screens.dialog.buttons,
      items: screens.dialog.items?.map(({ label, checked, index }) => ({ label, checked, index })),
    },
  };
  uiView.webContents.send('ui:render', s);
  uiView.setVisible(overlayShown());
  if (overlayShown()) { uiView.webContents.focus(); mouseHeld = false; } // the release goes to the overlay
  else tab().view?.webContents.focus();
  screens.startFocus = null;
}

function showDialog(title, items) {
  closeDialog();
  screens.dialog = { title, items: items.map(([label, run]) => ({ label, run })) };
  render();
  updateCursor();
}

/** Closes the dialog; a page waiting on one gets the cancel answer. */
function closeDialog(choice) {
  const d = screens.dialog;
  screens.dialog = null;
  if (d?.onClose) d.onClose(choice);
}

function dismissDialog() {
  closeDialog();
  render();
  updateCursor();
}

function messageDialog(title, message, extra = {}) {
  closeDialog();
  screens.dialog = { title, message, buttons: ['OK'], ...extra };
  render();
  updateCursor();
}

ipcMain.on('ui:act', (e, layer, index, extra) => {
  if (e.sender !== uiView.webContents) return;
  if (layer === 'start') {
    if (index < 0) openAddress();
    else if (bookmarks.items[index]) load(bookmarks.items[index].url);
  } else if (layer === 'start-options') {
    bookmarkOptions(index);
  } else if (layer === 'menu') {
    screens.menu?.[index]?.run();
  } else if (layer === 'address-tab') {
    selectTab(index);
  } else if (layer === 'address-menu') {
    if (!fullscreen) { screens.address = null; openMenu(); }
  } else if (layer === 'address') {
    closeAddress();
    if (typeof extra === 'string' && extra.trim()) load(extra);
  } else if (layer === 'dialog') {
    const d = screens.dialog;
    if (!d) return;
    if (d.items && !d.buttons) {
      const run = d.items[index]?.run;
      dismissDialog();
      run?.();
    } else {
      closeDialog({ button: index, value: extra });
      render();
      updateCursor();
    }
  }
});

ipcMain.on('ui:back', (e) => { if (e.sender === uiView.webContents) goBack(); });

function bookmarkOptions(i) {
  const b = bookmarks.items[i];
  if (!b) return;
  const moved = (to) => showStart(bookmarks.move(i, to));
  showDialog(b.title, [
    ['Move left', () => moved(i - 1)],
    ['Move right', () => moved(i + 1)],
    ['Move to first', () => moved(0)],
    ['Remove', () => { bookmarks.remove(i); showStart(Math.min(i, bookmarks.items.length - 1)); }],
  ]);
}

async function addBookmark() {
  const t = tab();
  if (!t.url) return;
  let jpeg = null;
  try {
    const img = await t.view.webContents.capturePage();
    jpeg = img.resize({ width: 384 }).toJPEG(80);
  } catch { /* no picture: the tile shows a letter */ }
  bookmarks.add({ url: t.url, title: t.title || hostOf(t.url) || t.url }, jpeg);
  toast('Bookmarked');
}

// ---- menu and dialogs ---------------------------------------------------------------------------

function openMenu() {
  if (fullscreen) return;
  releaseDirs();
  const t = tab();
  const wc = t.view?.webContents;
  const history = wc?.navigationHistory;
  const item = (label, symbol, run) => ({ label, symbol, run });
  screens.menu = [
    item('Back', '←', () => { closeMenu(); if (history?.canGoBack()) history.goBack(); }),
    item('Forward', '→', () => { closeMenu(); if (history?.canGoForward()) history.goForward(); }),
    item('Reload', '⟳', () => { closeMenu(); wc?.reload(); }),
    item('Address', '⌨', () => openAddress()),
    item(`Tabs (${tabs.length})`, '▤', () => { closeMenu(); tabsDialog(); }),
    item('Bookmarks', '★', () => { closeMenu(); showStart(); }),
    item('Add bookmark', '＋', () => { closeMenu(); addBookmark(); }),
    item('Zoom out', '－', () => zoomBy(0.8)),
    item('Zoom in', '＋', () => zoomBy(1.25)),
    item(`Mobile site: ${isMobile(t.url) ? 'on' : 'off'}`, '📱', () => { closeMenu(); toggleMobile(); }),
    item('Ad blocking', '⛔', () => { closeMenu(); adBlockDialog(); }),
    item('Clean up page', '🧹', () => { closeMenu(); cleanUpPage(); }),
    item('Remove element', '✂', () => {
      closeMenu();
      zapNext = true;
      toast(cursorMode ? 'Point at it and press OK to remove it' : 'Pick it with the arrows and press OK to remove it');
    }),
    item('Pair phone', '🔗', () => { closeMenu(); pairDialog(); }),
    item('Settings', '⚙', () => { closeMenu(); settingsDialog(); }),
    item('Quit', '⏻', () => app.quit()),
  ];
  render();
  updateCursor();
}

function closeMenu() {
  if (!screens.menu) return;
  screens.menu = null;
  render();
  updateCursor();
}

/** `hover`: opened by the mouse, so it goes away when the mouse does, unless it has been used. */
function openAddress(hover = false) {
  screens.menu = null;
  screens.address = { value: screens.start ? '' : tab().url || '', hover };
  render();
  updateCursor();
}

function closeAddress() {
  screens.address = null;
  render();
  updateCursor();
}

function toggleAddress() {
  if (screens.address) closeAddress();
  else if (!screens.dialog && !fullscreen) openAddress();
}

const tabName = (t) => t.title || hostOf(t.url) || 'Start screen';

function selectTab(index) {
  const t = tabs[index];
  if (!t) return;
  if (screens.address) screens.address.value = t.url || '';
  showTab(index);
  if (!t.url) showStart();
}

function tabsDialog() {
  const items = tabs.map((t, i) => [(i === current ? '▶ ' : '    ') + tabName(t), () => selectTab(i)]);
  if (tabs.length < MAX_TABS) items.push(['New tab', () => { tabs.push(newTab(null)); showTab(tabs.length - 1); showStart(); }]);
  items.push(['Close this tab', () => closeTab(current)]);
  showDialog(`Tabs (up to ${MAX_TABS})`, items);
}

function adBlockDialog() {
  const t = tab();
  const host = t.pageHost;
  const reload = () => t.view?.webContents.reload();
  const allowed = blocker.isAllowlisted(host);
  const items = [];
  if (host) items.push([allowed ? `Block ads on ${host}` : `Allow ads on ${host}`, () => { blocker.setAllowlisted(host, !allowed); reload(); }]);
  items.push([blocker.enabled ? 'Turn ad blocking off everywhere' : 'Turn ad blocking on', () => { blocker.enabled = !blocker.enabled; reload(); }]);
  if (host) {
    const auto = isAutoClean(host);
    items.push([auto ? `Stop cleaning up ${host} automatically` : `Clean up ${host} automatically (overlays, cookie walls)`, () => {
      setAutoClean(host, !auto);
      if (!auto) cleanUpPage();
    }]);
    const zaps = blocker.zapCount(host);
    if (zaps > 0) items.push([`Bring back ${zaps} removed element${zaps === 1 ? '' : 's'} on ${host}`, () => { blocker.clearZaps(host); reload(); }]);
  }
  items.push(['Filter lists…', () => filterListsDialog()]);
  items.push(['Update filter lists now', () => { toast('Updating filter lists…'); blocker.updateNow().then(toast); }]);
  const state = !blocker.enabled ? 'Off' : allowed ? 'Off for this site' : 'On';
  const updated = blocker.lastUpdated ? new Date(blocker.lastUpdated).toLocaleDateString() : 'never';
  showDialog(`Ad blocking: ${state} · ${t.blocked} blocked on this page · ${blocker.ruleCount} rules · lists updated ${updated}`, items);
}

function filterListsDialog() {
  const on = blocker.enabledLists();
  closeDialog();
  screens.dialog = {
    title: 'Filter lists',
    checks: true,
    buttons: ['Save', 'Cancel'],
    items: LISTS.map((l, index) => ({ label: l.title, checked: on.has(l.file), index })),
    onClose: (choice) => {
      if (choice?.button !== 0) return;
      const chosen = new Set(choice.value.map((i) => LISTS[i]?.file).filter(Boolean));
      if (chosen.size === on.size && [...chosen].every((f) => on.has(f))) return;
      blocker.setEnabledLists(chosen);
      toast('Loading filter lists…');
      blocker.reload().then(toast);
    },
  };
  render();
  updateCursor();
}

function settingsDialog() {
  showDialog('Settings', [
    [`Search engine: ${SEARCH_ENGINES[searchEngine()][0]}`, () => {
      store.set('search', (searchEngine() + 1) % SEARCH_ENGINES.length);
      toast(`Search engine: ${SEARCH_ENGINES[searchEngine()][0]}`);
    }],
    [`Navigation: ${cursorMode ? 'cursor' : 'link'} mode (hold OK to switch)`, () => toggleMode()],
    ['Forget paired phones (new QR code)', () => { tokens.rotate(); toast('Paired phones forgotten'); }],
    ['Clear cookies, cache and history', async () => {
      await web.clearStorageData();
      await web.clearCache();
      for (const t of tabs) t.view?.webContents.navigationHistory.clear();
      toast('Browsing data cleared');
    }],
    ['About and licenses', () => messageDialog(`TVCouchBrowser ${app.getVersion()}`, fs.readFileSync(path.join(__dirname, '..', 'NOTICE'), 'utf8'))],
  ]);
}

function pairDialog() {
  const ip = lanAddress();
  if (!ip || !server.port) { toast('Not connected to a network'); return; }
  const url = `http://${ip}:${server.port}/?t=${tokens.token}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true });
  messageDialog('Pair phone', 'Scan with your phone camera to open URLs, type into the TV and use your phone as a remote.\n\n' +
    'The phone must be on the same network. Works while this browser is open.\n\n' +
    `Address for the "Send to TV" Shortcut:\nhttp://${ip}:${server.port}/open?t=${tokens.token}`,
  { qr: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), buttons: ['Done'] });
}

// ---- clean up and remove element ------------------------------------------------------------------

const autoCleanSites = () => store.get('autoclean', []);
const isAutoClean = (host) => !!host && autoCleanSites().includes(site(host));
function setAutoClean(host, on) {
  const s = site(host);
  store.set('autoclean', on ? [...new Set([...autoCleanSites(), s])] : autoCleanSites().filter((x) => x !== s));
}

/** Removes full-screen overlays, cookie walls and sticky ad bars, and lets the page scroll again. */
async function cleanUpPage(quiet = false) {
  if (!browsing()) return;
  const n = await call(tab(), 'cleanup');
  if (!quiet) toast(n > 0 ? 'Cleaned up the page' : 'Nothing to clean up here');
}

/** Removes the element under the pointer (or the one with the ring in link mode) and remembers it. */
async function zap() {
  if (!browsing()) return;
  const t = tab();
  const { width, height } = bounds();
  const sel = cursorMode || Date.now() < pointerUntil
    ? await call(t, 'zapAt', pointer.x / width, pointer.y / height)
    : await call(t, 'zapCurrent');
  if (!sel) toast('Nothing to remove there');
  else if (sel === '-') toast('Removed (this page only)');
  else if (t.pageHost && blocker.addZap(t.pageHost, sel)) toast('Removed. Ad blocking → Bring back removed elements to undo');
  else toast('Removed (this page only)');
}

function zoomBy(factor) {
  const t = tab();
  if (!t.view) return;
  t.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, t.zoom * factor));
  t.view.webContents.setZoomFactor(t.zoom);
}

// ---- keys ---------------------------------------------------------------------------------------

let okTimer = null, okLong = false;
let backTimer = null, backLong = false;
let syntheticKeys = 0; // keys this app sends also pass through before-input-event

function onInput(e, input) {
  if (input.type !== 'keyDown' && input.type !== 'keyUp') return;
  if (syntheticKeys > 0) { syntheticKeys--; return; }
  const down = input.type === 'keyDown';
  const key = input.key;
  const t = tab();
  const editing = !overlayShown() && t.editing;

  if (down && key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); return; }
  const command = commandHeld(input);
  if (down && command && (key === 'q' || key === 'Q')) { e.preventDefault(); app.quit(); return; }
  if (down && command && (key === 'l' || key === 'L')) { e.preventDefault(); openAddress(); return; }
  if (key === 'F6') { e.preventDefault(); if (down && !input.isAutoRepeat) toggleAddress(); return; }
  if (down && (key === 'F5' || (command && (key === 'r' || key === 'R')))) { e.preventDefault(); t.view?.webContents.reload(); return; }
  if (input.control || input.alt || input.meta) return;

  const isBack = key === 'Escape' || key === 'BrowserBack' || key === 'GoBack' ||
    (key === 'Backspace' && !editing && !textOverlay());
  if (isBack) {
    e.preventDefault();
    if (editing && key === 'Escape') { // leaves the field, so the remote can move again
      if (down) { t.editing = false; call(t, 'blur'); }
      return;
    }
    // Long press opens the menu (for remotes without a Menu key), short press goes back.
    if (down && !input.isAutoRepeat) {
      backLong = false;
      clearTimeout(backTimer);
      backTimer = setTimeout(() => {
        backTimer = null;
        if (!screens.menu) { backLong = true; openMenu(); }
      }, HOLD_BACK_MS);
    } else if (!down) {
      const pressed = backTimer !== null;
      clearTimeout(backTimer);
      backTimer = null;
      if (pressed && !backLong) goBack();
    }
    return;
  }
  if (key === 'ContextMenu' || key === 'F1') {
    e.preventDefault();
    if (down && !input.isAutoRepeat) { if (screens.menu) closeMenu(); else openMenu(); }
    return;
  }
  if (overlayShown()) return; // the overlay handles its own keys
  if (key in MEDIA_KEYS) {
    e.preventDefault();
    if (down) call(t, 'media', MEDIA_KEYS[key]);
    return;
  }
  if (fullscreen || editing || !browsing()) return;
  if (key === 'ChannelUp' || key === 'ChannelDown') {
    e.preventDefault();
    if (down) call(t, 'pageBy', key === 'ChannelUp' ? -1 : 1);
    return;
  }
  if (key === 'Enter' || key === 'Select') {
    e.preventDefault();
    if (down && !input.isAutoRepeat) {
      okLong = false;
      clearTimeout(okTimer);
      okTimer = setTimeout(() => { okTimer = null; okLong = true; toggleMode(); }, HOLD_OK_MS);
    } else if (!down) {
      const pressed = okTimer !== null;
      clearTimeout(okTimer);
      okTimer = null;
      if (pressed && !okLong) click();
    }
    return;
  }
  if (key in ARROWS) {
    e.preventDefault();
    const dir = ARROWS[key];
    if (cursorMode) { if (down && !input.isAutoRepeat) pressDir(dir); else if (!down) releaseDir(dir); }
    else if (down) call(t, 'nav', DIRS[dir]);
  }
}

/** A real mouse moving up to the top of the window shows the address bar, once per visit to the edge. */
function onMouse({ type, y }) {
  if (injecting) return;
  if (type === 'mouseDown') mouseHeld = true;
  if (type === 'mouseUp') mouseHeld = false;
  if (type !== 'mouseMove') return;
  const arrived = y <= TOP_EDGE && !mouseAtTop;
  mouseAtTop = y <= TOP_EDGE;
  // Not while dragging, typing into the page, or over full-screen video.
  if (arrived && !mouseHeld && !fullscreen && !tab().editing && !overlayShown() && browsing()) openAddress(true);
}

function goBack() {
  const t = tab();
  if (screens.dialog) dismissDialog();
  else if (screens.menu) closeMenu();
  else if (screens.address) closeAddress();
  else if (fullscreen) call(t, 'exitFullscreen');
  else if (screens.start) { if (t.view && t.url) showTab(current); }
  else if (t.view?.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack();
  else showStart();
}

function toggleMode() {
  cursorMode = !cursorMode;
  store.set('cursorMode', cursorMode);
  if (cursorMode) call(tab(), 'reset'); else releaseDirs();
  toast(cursorMode ? 'Cursor mode' : 'Link mode: the arrows jump between links');
  showPointer();
}

/** Shows the pointer for a few seconds; in cursor mode it stays out of the way of whatever is playing. */
function showPointer() {
  pointerUntil = Date.now() + POINTER_MS;
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(updateCursor, POINTER_MS + 50);
  updateCursor();
}

function updateCursor() {
  const recent = Date.now() < pointerUntil;
  cursorView.setVisible(recent && (phoneActive || (cursorMode && browsing() && !overlayShown() && !fullscreen)));
}

function click() {
  if (zapNext) { zapNext = false; zap(); return; }
  if (cursorMode) { clickAt(pageWc(), pointer.x, pointer.y); return; }
  call(tab(), 'target').then((p) => {
    if (!p) { toast('Nothing selected: use the arrows'); return; }
    const { width, height } = bounds();
    clickAt(pageWc(), p.x * width, p.y * height);
  });
}

const pageWc = () => tab().view?.webContents;
const mouse = (type, x, y, extra) => ({ type, x: Math.round(x), y: Math.round(y), ...extra });

/** A real click at (x, y), so pages get trusted events: links, selects and inputs all work. */
function clickAt(wc, x, y, button = 'left') {
  if (!wc) return;
  send(wc, mouse('mouseMove', x, y), mouse('mouseDown', x, y, { button, clickCount: 1 }));
  setTimeout(() => send(wc, mouse('mouseUp', x, y, { button, clickCount: 1 })), 40);
}

const hover = (wc) => { if (wc) send(wc, mouse('mouseMove', pointer.x, pointer.y)); };

// ---- cursor movement with acceleration -----------------------------------------------------------

const held = [0, 0, 0, 0]; // press time per direction (up, down, left, right), 0 = not held
const holdStart = [0, 0, 0, 0]; // when the current hold began, kept across quick re-presses
const released = [0, 0, 0, 0];
let moveTimer = null;
let lastHover = 0;

function movePointer(x, y) {
  const { width, height } = bounds();
  pointerMoved = true;
  pointer = { x: Math.max(0, Math.min(x, width - 1)), y: Math.max(0, Math.min(y, height - 1)) };
  placeCursor();
}

const stepPointer = (dir, step) => {
  const dx = dir === 2 ? -step : dir === 3 ? step : 0;
  const dy = dir === 0 ? -step : dir === 1 ? step : 0;
  movePointer(pointer.x + dx, pointer.y + dy);
};

function pressDir(dir) {
  const now = Date.now();
  // Some remotes send down/up pairs instead of key repeats while a button is held: a press right after
  // a release continues the same hold, so acceleration still builds.
  if (now - released[dir] < 200) held[dir] = holdStart[dir];
  else {
    held[dir] = now;
    holdStart[dir] = now;
    stepPointer(dir, 8 * scale); // a single tap always moves a visible step
  }
  showPointer();
  if (!moveTimer) moveTimer = setInterval(moveFrame, 16);
}

function releaseDir(dir) {
  if (held[dir]) released[dir] = Date.now();
  held[dir] = 0;
}

function releaseDirs() { held.fill(0); }

function moveFrame() {
  const now = Date.now();
  let dx = 0, dy = 0;
  held.forEach((at, d) => {
    if (!at) return;
    const ms = now - at;
    // slow for the first 300 ms so single presses are precise, then speed up
    const speed = ms < 300 ? 3 : Math.min(3 + (ms - 300) / 35, 24);
    if (d === 0) dy -= speed; else if (d === 1) dy += speed; else if (d === 2) dx -= speed; else dx += speed;
  });
  if (!dx && !dy) { clearInterval(moveTimer); moveTimer = null; return; }
  dx *= scale; dy *= scale;
  const nx = pointer.x + dx, ny = pointer.y + dy;
  movePointer(nx, ny);
  showPointer();
  edgeScroll(nx, ny, dx, dy, 1.5);
  if (now - lastHover > 80) { lastHover = now; hover(pageWc()); }
}

/** Pushing past an edge scrolls whatever is under the pointer. */
function edgeScroll(nx, ny, dx, dy, gain) {
  const { width, height } = bounds();
  const sx = nx < 0 || nx >= width - 1 ? dx : 0;
  const sy = ny < 0 || ny >= height - 1 ? dy : 0;
  if ((sx || sy) && browsing()) {
    const css = 1 / Math.max(tab().zoom, 0.1); // window pixels -> CSS pixels
    call(tab(), 'scrollAt', pointer.x / width, pointer.y / height, Math.trunc(sx * gain * css), Math.trunc(sy * gain * css));
  }
}

// ---- phone trackpad --------------------------------------------------------------------------------

let phoneActive = false; // the pointer was last moved by the phone, so it shows over menus too
let dragging = false;
let lastPadHover = 0;

/** The surface under the pointer: the app's own screens, or the page. */
const targetWc = () => (overlayShown() ? uiView.webContents : pageWc());

const actions = {
  openUrl(input) {
    const url = resolve(input);
    if (!url) return false;
    closeDialog();
    screens.menu = null;
    screens.address = null;
    load(url);
    return true;
  },

  type(text) {
    if (textOverlay()) { uiView.webContents.send('ui:insert', text); return; }
    const t = tab();
    call(t, 'prepareType').then((r) => {
      // A cross-origin frame answers 'iframe': the text goes to whichever frame has focus.
      if (r === 'ok' || r === 'iframe') t.view.webContents.insertText(text);
      else toast('Select a text box on the TV first');
    });
  },

  key(name) {
    if (!['up', 'down', 'left', 'right', 'ok', 'back', 'menu', 'playpause', 'enter', 'backspace', 'mode'].includes(name)) return false;
    if (name === 'mode') { if (browsing() && !overlayShown()) toggleMode(); return true; }
    if (name === 'back') { goBack(); return true; }
    if (name === 'menu') { if (screens.menu) closeMenu(); else openMenu(); return true; }
    if (overlayShown()) { uiView.webContents.send('ui:key', name === 'playpause' ? 'ok' : name); return true; }
    if (name === 'playpause') { call(tab(), 'media', 'playpause'); return true; }
    if (name === 'enter' || name === 'backspace') {
      const wc = pageWc();
      if (!wc) return true;
      const keyCode = name === 'enter' ? 'Return' : 'Backspace';
      const chars = name === 'enter' ? [{ type: 'char', keyCode: '\r' }] : [];
      syntheticKeys += 2;
      send(wc, { type: 'keyDown', keyCode }, ...chars, { type: 'keyUp', keyCode });
      return true;
    }
    if (name === 'ok') { showPointer(); click(); return true; }
    // A phone arrow in cursor mode nudges the pointer a fixed step.
    const dir = DIRS.indexOf(name);
    if (cursorMode) { stepPointer(dir, 40 * scale); hover(pageWc()); showPointer(); } else call(tab(), 'nav', name);
    return true;
  },

  pointerConnected() { toast('Phone trackpad connected'); },
  pointerDisconnected() { endDrag(); phoneActive = false; updateCursor(); },

  pointer(cmd) {
    phoneActive = true;
    showPointer();
    if (cmd.op === 'm') padMove(cmd.a * scale, cmd.b * scale);
    else if (cmd.op === 's') padScroll(cmd.a, cmd.b);
    else if (cmd.op === 'c') padTap();
    else if (cmd.op === '2') { padTap(); setTimeout(padTap, 90); }
    else if (cmd.op === 'd') startDrag();
    else if (cmd.op === 'u') endDrag();
    else if (cmd.op === 'l') clickAt(targetWc(), pointer.x, pointer.y, 'right');
    else if (cmd.op === 'z') { if (browsing() && !overlayShown()) zoomBy(cmd.a > 0 ? 1.25 : 0.8); }
    else if (cmd.op === 'x') { if (!overlayShown()) zap(); }
    else if (cmd.op === 'k') { if (!overlayShown()) cleanUpPage(); }
  },
};

function padMove(dx, dy) {
  const nx = pointer.x + dx, ny = pointer.y + dy;
  movePointer(nx, ny);
  const now = Date.now();
  if (dragging) { send(pageWc(), mouse('mouseMove', pointer.x, pointer.y, { modifiers: ['leftButtonDown'] })); return; }
  if (!overlayShown()) edgeScroll(nx, ny, dx, dy, 2);
  if (now - lastPadHover > 50) { lastPadHover = now; hover(targetWc()); }
}

function padScroll(dx, dy) {
  const { width, height } = bounds();
  if (overlayShown()) {
    uiView.webContents.executeJavaScript(`document.getElementById('start').scrollBy(0, ${Math.trunc(dy * scale * PAD_SCROLL_GAIN)})`).catch(() => {});
    return;
  }
  if (browsing()) call(tab(), 'scrollAt', pointer.x / width, pointer.y / height, Math.trunc(dx * PAD_SCROLL_GAIN), Math.trunc(dy * PAD_SCROLL_GAIN));
}

function padTap() {
  if (zapNext) { zapNext = false; zap(); return; }
  clickAt(targetWc(), pointer.x, pointer.y);
}

function startDrag() {
  if (dragging || overlayShown() || !pageWc()) return;
  dragging = true;
  send(pageWc(), mouse('mouseMove', pointer.x, pointer.y), mouse('mouseDown', pointer.x, pointer.y, { button: 'left', clickCount: 1 }));
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  if (pageWc()) send(pageWc(), mouse('mouseUp', pointer.x, pointer.y, { button: 'left', clickCount: 1 }));
}

// ---- what pages tell the app ------------------------------------------------------------------------

ipcMain.on('tvcb:page', (e, host, topFrame) => {
  const active = blocker.active(host);
  e.returnValue = { active, css: active ? blocker.cosmeticCss(host, topFrame) : '' };
});

ipcMain.handle('tvcb:generic', (_e, host, tokens) => (blocker.active(host) ? blocker.genericCss(host, tokens.slice(0, 5000)) : ''));

ipcMain.on('tvcb:media', (e, playing) => {
  const t = tabOf(e.sender);
  if (t) { t.playing = playing; updateKeepAwake(); }
});

ipcMain.on('tvcb:gesture', (e) => { const t = tabOf(e.sender); if (t) t.lastGesture = Date.now(); });
ipcMain.on('tvcb:editing', (e, editing) => { const t = tabOf(e.sender); if (t) t.editing = editing; });

// A page gets two alert/confirm/prompt dialogs; after that they are dismissed unseen, so a dialog loop
// can't trap the remote. The page stays blocked until this answers, as with a browser's own dialog.
ipcMain.on('tvcb:dialog', (e, kind, message, value) => {
  const t = tabOf(e.sender);
  if (!t || t !== tab() || screens.dialog) { e.returnValue = null; return; }
  if (++t.jsDialogs > MAX_JS_DIALOGS) {
    if (t.jsDialogs === MAX_JS_DIALOGS + 1) toast('Blocked more pop-up messages from this page');
    e.returnValue = null;
    return;
  }
  screens.dialog = {
    title: `${t.pageHost || 'This page'} says`,
    message,
    prompt: kind === 'prompt' ? value : undefined,
    buttons: kind === 'alert' ? ['OK'] : ['OK', 'Cancel'],
    onClose: (choice) => {
      const ok = choice?.button === 0;
      e.returnValue = !ok ? null : kind === 'prompt' ? String(choice.value ?? '') : true;
    },
  };
  render();
  updateCursor();
});

function updateKeepAwake() {
  const on = fullscreen || !!tab()?.playing;
  if (on && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && keepAwake !== null) { powerSaveBlocker.stop(keepAwake); keepAwake = null; }
}

// ---- session: blocking, permissions, downloads -------------------------------------------------------

function setUpSession() {
  web = session.fromPartition('persist:browser');
  web.setUserAgent(DESKTOP_UA);
  web.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (details.resourceType === 'mainFrame' || !/^(https?|wss?):/.test(details.url)) return callback({});
    const t = tabById(details.webContentsId);
    // Service workers belong to no tab: judge them by the page they came from, if known.
    const pageHost = t ? t.pageHost : hostOf(details.referrer);
    if (!pageHost || !blocker.active(pageHost) || !blocker.shouldBlock(new URL(details.url), pageHost)) return callback({});
    if (t) t.blocked++;
    return callback({ cancel: true });
  });
  // Full-screen video and DRM (Widevine) only; never camera, microphone or location.
  const allowed = (p) => p === 'fullscreen' || p === 'mediaKeySystem';
  web.setPermissionRequestHandler((_wc, permission, done) => done(allowed(permission)));
  web.setPermissionCheckHandler((_wc, permission) => allowed(permission));
  web.on('will-download', (e) => { e.preventDefault(); toast("Downloads aren't supported"); });
}

// ---- window and lifecycle -------------------------------------------------------------------------

function overlayView(file, preload) {
  const view = new WebContentsView({
    webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: 'ui' },
  });
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (e) => e.preventDefault());
  view.webContents.on('before-input-event', (e, input) => onInput(e, input));
  win.contentView.addChildView(view);
  return { view, loaded: view.webContents.loadFile(UI(file)) };
}

async function createWindow() {
  win = new BaseWindow({
    width: 1280, height: 720, fullscreen: !windowed, backgroundColor: '#101318', title: 'TVCouchBrowser',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), autoHideMenuBar: true,
  });
  const uiPreload = path.join(__dirname, 'ui-preload.js');
  const u = overlayView('index.html', uiPreload);
  const toasts = overlayView('toast.html', uiPreload);
  const cursorPage = overlayView('cursor.html');
  uiView = u.view; toastView = toasts.view; cursorView = cursorPage.view;
  await Promise.all([u.loaded, toasts.loaded, cursorPage.loaded]);
  test.onWindow?.(win);
  layout();
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('closed', () => app.quit());
  // Like upstream, the phone page only runs while the browser is on screen.
  win.on('minimize', () => server.stop());
  win.on('restore', () => server.start());
}

function scheduleListUpdate() {
  const due = Math.max(60000, Math.min(blocker.lastUpdated + MAX_AGE_MS - Date.now(), MAX_AGE_MS));
  setTimeout(async () => {
    await blocker.updateIfStale();
    scheduleListUpdate();
  }, due);
}

/** Widevine arrives through the component updater, so give it a moment before the first page. */
async function waitForWidevine() {
  if (!electron.components) return;
  try {
    await Promise.race([electron.components.whenReady(), new Promise((r) => { setTimeout(r, 8000); })]);
  } catch (e) { console.warn('Widevine unavailable:', e.message); }
}

async function start() {
  const data = app.getPath('userData');
  store = new Store(path.join(data, 'settings.json'));
  cursorMode = store.get('cursorMode', true);
  blocker = new AdBlocker(store, path.join(data, 'lists'), test.fetcher || ((...a) => net.fetch(...a)));
  bookmarks = new Bookmarks(store, path.join(data, 'thumbs'));
  tokens = new TokenStore(store, safeStorage);
  server = new PhoneServer(tokens, actions, test.server);
  setUpSession();
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(MAC_MENU) : null);
  await waitForWidevine();
  await createWindow();
  restoreTabs();
  blocker.start().then((msg) => { if (msg !== 'Filter lists loaded') toast(msg); }).catch((e) => console.warn(e));
  scheduleListUpdate();
  await server.start();

  const url = urlArg(argv);
  if (url) load(url);
  else if (tab().url) showTab(current);
  else showStart();
  test.ready?.({ actions, tabs, screens, server, blocker, tokens, bookmarks, uiView, cursorView, toastView, tab, load, onInput, openInNewTab, closeTab, get pointer() { return pointer; }, get cursorMode() { return cursorMode; }, get fullscreen() { return fullscreen; } });
}

app.setName('tvcouchbrowser');
app.userAgentFallback = DESKTOP_UA;
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', (_e, args) => {
  const url = urlArg(args);
  if (url && win) { actions.openUrl(url); win.focus(); }
});
app.on('web-contents-created', (_e, wc) => {
  // Nothing in this app may be turned into something with more access than it started with.
  wc.on('will-attach-webview', (e) => e.preventDefault());
});
app.on('before-quit', () => {
  if (store) { saveTabs(); store.flush(); }
  server?.stop();
});
app.whenReady().then(start).catch((e) => { console.error(e); app.exit(1); });
