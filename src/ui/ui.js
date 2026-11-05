'use strict';
/* global tv */
// Draws what the app says to show. All text goes through textContent: titles come from web pages.
const $ = (id) => document.getElementById(id);
const LAYERS = ['dialog', 'menu', 'address', 'start'];
const PALETTE = ['#2F7FE0', '#7A4FD1', '#1F9D8B', '#D1693A', '#B8417A'];
const HOLD_MS = 500;

let state = {};
let barClicked = false;
const lastFocus = {}; // layer -> data-key of the element that last had focus

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A focusable button; `key` lets focus return to it after a redraw. */
const focusable = (tag, cls, key, onClick, text) => {
  const b = el(tag, cls + ' f', text);
  b.tabIndex = 0;
  b.dataset.key = key;
  b.addEventListener('click', onClick);
  b.addEventListener('mouseenter', () => b.focus());
  return b;
};

const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return h & 0x7fffffff; };

function drawStart(s, box) {
  box.append(el('h1', '', 'TVCouchBrowser'));
  box.append(focusable('button', 'search', 'search', () => tv.act('start', -1), '🔍  Search or type a web address'));
  const grid = el('div', 'grid');
  s.bookmarks.forEach((b, i) => {
    const t = focusable('button', 'bookmark', 'b' + i, () => tv.act('start', i));
    t.dataset.hold = '1';
    t.addEventListener('contextmenu', (e) => { e.preventDefault(); tv.act('start-options', i); });
    if (b.thumb) { const img = el('img'); img.src = b.thumb; img.alt = ''; t.append(img); }
    else {
      const letter = el('span', 'letter', ([...b.title].find((c) => /[\p{L}\p{N}]/u.test(c)) || '•').toUpperCase());
      letter.style.background = PALETTE[hash(b.url) % PALETTE.length];
      t.append(letter);
    }
    t.append(el('span', 'name', b.title || b.url));
    grid.append(t);
  });
  box.append(grid, el('div', 'hint', s.hint));
  if (s.focus !== null && s.focus !== undefined) lastFocus.start = 'b' + s.focus;
}

function drawMenu(s, box) {
  const grid = el('div', 'grid');
  s.items.forEach((item, i) => {
    const t = focusable('button', 'tile', 'm' + i, () => tv.act('menu', i));
    t.append(el('span', 'sym', item.symbol), el('span', '', item.label));
    grid.append(t);
  });
  box.append(grid);
  box.onclick = (e) => { if (e.target === box) tv.back(); };
}

function textField(id, value, onSubmit) {
  const input = el('input');
  input.type = 'text'; input.id = id; input.className = 'f'; input.value = value || '';
  input.dataset.key = id; input.spellcheck = false;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onSubmit(input.value); } });
  return input;
}

function drawTabs(tabs, box) {
  box.querySelector('.tabs')?.remove();
  if (!tabs) return;
  const strip = el('div', 'tabs');
  tabs.forEach((t, i) => {
    const item = el('div', t.current ? 'tab-item current' : 'tab-item');
    const close = focusable('button', 'tab-close', `close${i}`, () => { lastFocus.address = 'addr'; tv.act('address-close-tab', i); }, '×');
    close.setAttribute('aria-label', `Close ${t.name}`);
    item.append(focusable('button', t.current ? 'tab current' : 'tab', `tab${i}`, () => tv.act('address-tab', i), t.name), close);
    strip.append(item);
  });
  box.prepend(strip);
}

function drawAddress(s, box) {
  const row = el('div', 'row');
  const field = textField('addr', s.value, (v) => tv.act('address', 0, v));
  field.setSelectionRange(field.value.length, field.value.length); // Right from here reaches the menu button
  const menu = focusable('button', 'menu-button', 'menu', () => tv.act('address-menu'), '☰');
  menu.setAttribute('aria-label', 'Menu');
  const plus = focusable('button', 'new-tab', 'new', () => tv.act('address-new-tab'), '＋');
  plus.setAttribute('aria-label', 'New tab');
  row.append(field, menu, plus);
  box.append(row);
  box.append(el('div', 'hint', 'Type here, or use "Open on TV" on your phone. Enter to go, Esc to cancel.'));
  drawTabs(s.tabs, box);
  lastFocus.address = 'addr';
  barClicked = false;
}

// A bar the mouse opened closes when the mouse leaves it, unless it has been clicked or typed in.
document.addEventListener('mousemove', (e) => {
  if (topLayer() !== 'address' || !state.address.hover || barClicked || $('address').contains(e.target)) return;
  if ($('addr').value === state.address.value) tv.act('address');
});

// Clicking outside closes any bar.
document.addEventListener('mousedown', (e) => {
  if (topLayer() !== 'address') return;
  if (e.target.id === 'addr') barClicked = true;
  else if (!$('address').contains(e.target)) tv.act('address');
});

function drawDialog(d, box) {
  const b = el('div', d.at ? 'box popup' : 'box');
  box.classList.toggle('popup', !!d.at);
  b.append(el('h2', '', d.title));
  if (d.qr) {
    const p = el('div', 'pair');
    const img = el('img'); img.src = d.qr; img.alt = 'QR code';
    p.append(img, el('div', 'message', d.message));
    b.append(p);
  } else if (d.message) b.append(el('div', 'message', d.message));
  let input = null;
  if (d.prompt !== undefined && d.prompt !== null) {
    input = textField('prompt', d.prompt, (v) => tv.act('dialog', 0, v));
    b.append(input);
    lastFocus.dialog = 'prompt';
  }
  const answer = (i) => (input ? input.value : d.checks ? checked : undefined);
  const checked = (d.items || []).filter((it) => it.checked).map((it) => it.index);
  if (d.items) {
    const items = el('div', 'items');
    d.items.forEach((it, i) => {
      const cls = 'item' + (d.checks ? ' check' + (it.checked ? ' on' : '') : '');
      const row = focusable('button', cls, 'i' + i, () => {
        if (!d.checks) return tv.act('dialog', i);
        const at = checked.indexOf(it.index);
        if (at >= 0) checked.splice(at, 1); else checked.push(it.index);
        row.classList.toggle('on', at < 0);
        return undefined;
      }, it.label);
      items.append(row);
    });
    b.append(items);
  }
  if (d.buttons) {
    const row = el('div', 'row');
    d.buttons.forEach((label, i) => row.append(focusable('button', 'item', 'x' + i, () => tv.act('dialog', i, answer(i)), label)));
    b.append(row);
  }
  box.append(b);
  box.onmousedown = d.at ? (e) => { if (e.target === box) tv.back(); } : null;
}

/** Beside the click, but always on screen. It can only be measured once it is showing. */
function placePopup() {
  const b = document.querySelector('#dialog .box.popup');
  if (!b || !state.dialog?.at) return;
  const r = b.getBoundingClientRect();
  b.style.left = `${Math.max(Math.min(state.dialog.at.x, innerWidth - r.width), 0)}px`;
  b.style.top = `${Math.max(Math.min(state.dialog.at.y, innerHeight - r.height), 0)}px`;
}

const DRAW = { start: drawStart, menu: drawMenu, address: drawAddress, dialog: drawDialog };

const topLayer = () => LAYERS.find((n) => state[n]);
const focusables = () => [...$(topLayer()).querySelectorAll('.f')];

function restoreFocus() {
  const name = topLayer();
  if (!name) return;
  const list = focusables();
  const pick = list.find((e) => e.dataset.key === lastFocus[name]) || list.find((e) => e.dataset.key === 'b0') || list[0];
  if (pick) { pick.focus({ preventScroll: true }); pick.scrollIntoView({ block: 'nearest' }); }
}

tv.onRender((s) => {
  const before = state;
  state = s;
  for (const name of LAYERS) {
    const box = $(name);
    const same = JSON.stringify(before[name]) === JSON.stringify(s[name]);
    if (name === 'address' && !same && s.address && before.address?.value === s.address.value) {
      drawTabs(s.address.tabs, box); // a title or tab changed: anything typed in the field stays
    } else if (!same) {
      box.replaceChildren();
      if (s[name]) DRAW[name](s[name], box);
    }
    box.hidden = !s[name];
  }
  placePopup();
  restoreFocus();
});

document.addEventListener('focusin', (e) => {
  const name = LAYERS.find((n) => $(n).contains(e.target));
  if (name && e.target.dataset.key) lastFocus[name] = e.target.dataset.key;
});

// Same scoring as link mode: distance along the direction plus 2x the sideways offset.
function move(dir) {
  const list = focusables();
  const cur = document.activeElement;
  if (!list.includes(cur)) { restoreFocus(); return; }
  const from = cur.getBoundingClientRect();
  const fx = from.left + from.width / 2, fy = from.top + from.height / 2;
  let best = null, bestScore = Infinity;
  for (const e of list) {
    if (e === cur) continue;
    // Only Right from its tab reaches a close button, so moving between rows can't land on one and close a tab.
    if (e.classList.contains('tab-close') && (dir === 'up' || dir === 'down')) continue;
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    let along, side;
    if (dir === 'right') { if (x <= fx) continue; along = r.left - from.right; side = Math.abs(y - fy); }
    if (dir === 'left') { if (x >= fx) continue; along = from.left - r.right; side = Math.abs(y - fy); }
    if (dir === 'down') { if (y <= fy) continue; along = r.top - from.bottom; side = Math.abs(x - fx); }
    if (dir === 'up') { if (y >= fy) continue; along = from.top - r.bottom; side = Math.abs(x - fx); }
    const score = Math.max(along, 0) + 2 * side;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest' }); }
}

function activate() {
  const cur = document.activeElement;
  if (!cur || cur === document.body) { restoreFocus(); return; }
  if (cur.tagName === 'INPUT') cur.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  else cur.click();
}

// OK held on a bookmark opens its options; a normal press clicks when released.
let holdTimer = 0, held = false;
window.addEventListener('keydown', (e) => {
  if (!topLayer()) return;
  const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
  const cur = document.activeElement;
  const inField = cur && cur.tagName === 'INPUT';
  const leavesBar = cur && cur.id === 'addr' && dir === 'right' && cur.selectionStart === cur.value.length && cur.selectionEnd === cur.value.length;
  if (dir && (leavesBar || !(inField && (dir === 'left' || dir === 'right')))) { e.preventDefault(); move(dir); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    if (cur && cur.dataset.hold) {
      held = false;
      holdTimer = setTimeout(() => { held = true; cur.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }, HOLD_MS);
    } else activate();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key !== 'Enter' || !holdTimer) return;
  clearTimeout(holdTimer); holdTimer = 0;
  if (!held) activate();
});

// The phone remote.
tv.onKey((key) => {
  if (!topLayer()) return;
  if (key === 'ok' || key === 'enter') activate();
  else if (key === 'backspace') {
    const cur = document.activeElement;
    if (cur && cur.tagName === 'INPUT') { cur.setRangeText('', Math.max(cur.selectionStart - (cur.selectionStart === cur.selectionEnd ? 1 : 0), 0), cur.selectionEnd, 'end'); }
  } else move(key);
});

tv.onInsert((text) => {
  const cur = document.activeElement;
  if (cur && cur.tagName === 'INPUT') cur.setRangeText(text, cur.selectionStart, cur.selectionEnd, 'end');
});
