'use strict';
// Drives the real app on a hidden display against a small local "web": a news page with ads, overlays,
// pop-ups, dialogs and a video. Run with test/run.sh; it never touches the network or the real profile.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');
const { app } = require('electron');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-e2e-'));
app.setPath('userData', dir);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const results = [];
const hits = [];

const FILTERS = ['||ads.test^', '||popads.test^$popup', '##.ad-box', '##div[data-ad]', 'site.test##.site-promo'].join('\n') + '\n' + '! x\n'.repeat(300);

const PAGE = `<!doctype html><meta charset=utf-8>
<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' http://ads.test:PORT">
<title>News</title><style>body{margin:0;height:4000px}a,button,input{display:block;width:300px;margin:30px;font-size:30px}</style>
<a id=link href="/two">Two</a><button id=btn onclick="window.clicked=(window.clicked||0)+1;window.trusted=event.isTrusted">Go</button>
<input id=field><div class=ad-box id=ad1>ad</div><div data-ad=1 id=ad2>ad</div><div class=site-promo id=ad3>promo</div><div class=fine id=ok>fine</div>
<div id=zapme class=sticky-thing style="width:300px;height:100px;background:red">zap</div>
<button id=same onclick="window.open('/two')">same</button><button id=other onclick="window.open('http://other.test:PORT/')">other</button>
<a id=adlink href="http://ads.test:PORT/landing">sponsored</a><button id=pop onclick="window.open('http://popads.test:PORT/')">pop</button>
<button id=cf onclick="window.answer=confirm('sure?')">confirm</button>
<button id=pr onclick="window.answer=prompt('name?','d')">prompt</button>
<button id=fs onclick="document.documentElement.requestFullscreen()">fs</button>
<img id=adimg src="http://ads.test:PORT/banner.png"><script src="http://ads.test:PORT/ad.js"></script>
<script>window.parsed=JSON.parse('{"adPlacements":1,"keep":2}');addEventListener('beforeunload',e=>{e.preventDefault();e.returnValue='x'})</script>`;

const web = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  hits.push(host + req.url);
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/overlay')) return res.end('<!doctype html><title>O</title><body style="overflow:hidden;height:3000px"><div id=wall class="cookie-consent" style="position:fixed;inset:0;background:#000">wall</div>');
  if (req.url.startsWith('/noclick')) return res.end(`<!doctype html><title>N</title><script>window.popped=window.open('/two');window.alert('a');window.alert('b');window.alert('c');window.done=1;location.href='http://ads.test:${web.address().port}/x'</script>`);
  if (req.url.startsWith('/two')) return res.end('<!doctype html><title>Two</title><p>two');
  return res.end(PAGE.replaceAll('PORT', web.address().port));
});

// YouTube is preloaded HTTPS-only, so that one test needs TLS, with a throwaway certificate.
function tlsServer() {
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=test'], { stdio: 'ignore' });
  return https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_q, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Two</title><p>two');
  });
}

function check(name, ok, detail) { results.push([name, !!ok, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + JSON.stringify(detail)}`); }

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(40);
  }
}

const masked = (text) => {
  const p = Buffer.from(text); const m = crypto.randomBytes(4);
  return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, Buffer.from(p.map((b, i) => b ^ m[i & 3]))]);
};

async function run(a) {
  const port = web.address().port;
  const base = `http://site.test:${port}`;
  const pageJs = (code) => a.tab().view.webContents.executeJavaScript(code);
  const uiJs = (code) => a.uiView.webContents.executeJavaScript(code);
  const key = (k, extra = {}) => {
    const input = { type: 'keyDown', key: k, isAutoRepeat: false, ...extra };
    const e = { preventDefault() { this.stopped = true; } };
    a.onInput(e, input);
    a.onInput(e, { ...input, type: 'keyUp' });
    return e;
  };
  const rect = (id) => pageJs(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const padTo = async (socket, id) => { // walks the pointer to an element with trackpad moves
    const r = await rect(id);
    a.actions.pointer({ op: 'm', a: -3000, b: -3000 }); a.actions.pointer({ op: 'm', a: -3000, b: -3000 });
    const s = a.pointer.x === 0 ? 1 : 1;
    const w = require('electron').BaseWindow.getAllWindows()[0].getContentBounds().width / 1280;
    a.actions.pointer({ op: 'm', a: r.x / w * s, b: r.y / w * s });
  };

  check('start screen shows on a fresh profile', a.screens.start);
  check('no pointer on the start screen until it is used', !a.cursorView.getVisible());
  await until(() => a.blocker.ruleCount > 0);
  check('filter lists downloaded and parsed', a.blocker.ruleCount >= 5, a.blocker.ruleCount);
  await until(() => uiJs(`document.querySelectorAll('#start .bookmark').length`));
  check('start screen has bookmark tiles', (await uiJs(`document.querySelectorAll('#start .bookmark').length`)) === 4);
  check('tile has focus', (await uiJs(`document.activeElement.dataset.key`)) === 'b0');

  a.actions.openUrl(`${base}/`);
  await until(() => a.tab().view && !a.tab().view.webContents.isLoading() && a.tab().title === 'News');
  await sleep(600);
  check('phone can open a page', a.tab().title === 'News', a.tab().title);
  check('user agent hides Electron', !/electron|tvcouchbrowser/i.test(a.tab().view.webContents.getUserAgent()), a.tab().view.webContents.getUserAgent());
  check('page sees a Chrome UA', /Chrome\//.test(await pageJs('navigator.userAgent')));
  check('ad script and image blocked', !hits.some((h) => h.startsWith('ads.test')) && a.tab().blocked >= 2, { hits, blocked: a.tab().blocked });
  const hidden = await pageJs(`['ad1','ad2','ad3','ok'].map(i=>getComputedStyle(document.getElementById(i)).display)`);
  check('cosmetic filters hide ads, leave the rest', hidden[0] === 'none' && hidden[1] === 'none' && hidden[2] === 'none' && hidden[3] === 'block', hidden);
  check('pages get no bridge', (await pageJs(`typeof window.TVCB + typeof window.__tvcb + typeof window.tv + typeof require`)) === 'undefinedundefinedundefinedundefined');

  // ---- remote: cursor mode
  const b = await rect('btn');
  const before = a.pointer;
  const e1 = key('ArrowDown');
  check('arrow moves the pointer and is consumed', a.pointer.y > before.y && e1.stopped, a.pointer);
  await sleep(50);
  check('pointer view follows', a.cursorView.getBounds().y === Math.round(a.pointer.y), a.cursorView.getBounds());
  check('pointer is visible', a.cursorView.getVisible());
  await padTo(null, 'btn');
  await sleep(60);
  key('Enter');
  await sleep(150);
  check('OK clicks under the pointer with a trusted event', (await pageJs('[window.clicked,window.trusted]')).join() === '1,true', await pageJs('[window.clicked,window.trusted]'));
  void b;

  // ---- hold OK: link mode
  a.onInput({ preventDefault() {} }, { type: 'keyDown', key: 'Enter' });
  await sleep(600);
  a.onInput({ preventDefault() {} }, { type: 'keyUp', key: 'Enter' });
  check('hold OK switches to link mode', a.cursorMode === false);
  check('holding OK did not click', (await pageJs('window.clicked')) === 1);
  key('ArrowDown'); await sleep(60); key('ArrowDown'); await sleep(120);
  key('Enter'); await sleep(200);
  check('link mode: arrows pick the button, OK clicks it', (await pageJs('window.clicked')) === 2, await pageJs('window.clicked'));
  a.actions.key('mode');
  check('phone switches back to cursor mode', a.cursorMode === true);

  // ---- typing
  await padTo(null, 'field'); await sleep(30);
  a.actions.pointer({ op: 'c' });
  await until(() => a.tab().editing);
  check('clicking a field is noticed', a.tab().editing);
  a.actions.type('héllo');
  await until(() => pageJs(`document.getElementById('field').value`));
  check('phone types into the field', (await pageJs(`document.getElementById('field').value`)) === 'héllo');
  const passthrough = key('ArrowLeft');
  check('arrows stay in the field while editing', !passthrough.stopped);
  a.actions.key('backspace'); await sleep(150);
  check('phone backspace', (await pageJs(`document.getElementById('field').value`)) === 'héll', await pageJs(`document.getElementById('field').value`));
  key('Escape');
  await until(() => !a.tab().editing);
  check('Esc leaves the field', !a.tab().editing);
  check('Esc on a field did not navigate', a.tab().title === 'News');
  await pageJs(`document.activeElement.blur()`);
  a.actions.type('nowhere');
  await sleep(150);
  check('typing with no field selected does nothing', (await pageJs(`document.getElementById('field').value`)) === 'héll');

  // ---- trackpad socket through the real server
  const c = net.connect(a.server.port, '127.0.0.1');
  await new Promise((r) => {
    c.once('data', r);
    c.write(`GET /ws?t=${a.tokens.token} HTTP/1.1\r\nHost: tv\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  });
  await pageJs(`document.addEventListener('contextmenu',e=>{e.preventDefault();window.ctx=e.isTrusted})`);
  c.write(masked('l'));
  await sleep(150);
  check('trackpad long press reaches the page as a right click', (await pageJs('window.ctx')) === true);
  c.write(masked('s 0 200'));
  await until(() => pageJs('scrollY'));
  check('trackpad scrolls the page', (await pageJs('scrollY')) > 0, await pageJs('scrollY'));
  await pageJs('scrollTo(0,0)');
  c.write(masked('z 1')); await sleep(100);
  check('trackpad zooms', a.tab().view.webContents.getZoomFactor() > 1.2, a.tab().view.webContents.getZoomFactor());
  c.write(masked('z -1')); await sleep(100);

  // drag
  await pageJs(`window.drag=[];for(const t of ['mousedown','mousemove','mouseup'])addEventListener(t,e=>{if(e.isTrusted)drag.push(t[5]+e.buttons)})`);
  c.write(masked('d')); await sleep(50); c.write(masked('m 40 0')); await sleep(80); c.write(masked('u')); await sleep(80);
  const drag = await pageJs('window.drag.join()');
  check('trackpad drag is a real press, move, release', /d1.*m1.*u0|d1.*v1.*u0/.test(drag) || (drag.includes('o1') && drag.includes('u0')), drag);

  // ---- clean up and zap, via phone
  await padTo(null, 'zapme'); await sleep(30);
  c.write(masked('x'));
  await until(async () => !(await pageJs(`!!document.getElementById('zapme')`)));
  check('remove element takes it off the page', !(await pageJs(`!!document.getElementById('zapme')`)));
  await sleep(100);
  check('removal is remembered for the site', a.blocker.zapCount('site.test') === 1, a.blocker.zaps('site.test'));
  c.destroy();
  await sleep(100);

  // ---- window.open after a click
  const click = async (id) => { await padTo(null, id); await sleep(40); a.actions.pointer({ op: 'c' }); await sleep(250); };
  await click('pop');
  check('pop-up to an ad domain dropped', a.tabs.length === 1 && !a.screens.dialog, a.tabs.length);
  await click('other');
  check('pop-up to another site asks first', !!a.screens.dialog && /other\.test/.test(a.screens.dialog.title), a.screens.dialog);
  await until(() => uiJs(`!document.getElementById('dialog').hidden`));
  check('dialog is drawn and focused', (await uiJs(`document.activeElement.textContent`)) === 'Open it in a new tab', await uiJs(`document.activeElement.textContent`));
  key('Escape');
  await until(() => !a.screens.dialog);
  check('Back closes the dialog', !a.screens.dialog && a.tabs.length === 1);
  await click('same');
  await until(() => a.tabs.length === 2 && a.tab().title === 'Two');
  check('same-site window opens in a tab', a.tabs.length === 2 && a.tab().title === 'Two', a.tabs.length);

  // ---- menu, tabs, back through the remote keys
  key('F1');
  await until(() => uiJs(`document.querySelectorAll('#menu .tile').length`));
  check('menu opens', (await uiJs(`document.querySelectorAll('#menu .tile').length`)) === 17);
  check('the phone pointer stays up over the menu', a.cursorView.getVisible());
  await uiJs(`document.querySelector('[data-key=m4]').click()`); // Tabs
  await until(() => a.screens.dialog);
  check('tabs dialog lists tabs', a.screens.dialog.items.length === 4, a.screens.dialog.items.map((i) => i.label));
  await uiJs(`document.querySelector('[data-key=i3]').click()`); // Close this tab
  await until(() => a.tabs.length === 1);
  check('closing a tab returns to the other', a.tabs.length === 1 && a.tab().title === 'News', a.tab().title);

  // ---- page dialogs answered from the app
  await click('cf');
  await until(() => a.screens.dialog);
  check('confirm() shows the app dialog', /sure\?/.test(a.screens.dialog?.message || ''));
  await until(() => uiJs(`document.querySelector('#dialog .box .row .item')?.textContent === 'OK'`));
  await uiJs(`document.querySelector('[data-key=x0]').click()`);
  await until(() => !a.screens.dialog);
  check('confirm() returns OK to the page', (await pageJs('window.answer')) === true);
  await click('pr');
  await until(() => a.screens.dialog);
  await until(() => uiJs(`document.activeElement.id === 'prompt'`));
  a.actions.type('!');
  await sleep(100);
  a.actions.key('enter');
  await until(() => !a.screens.dialog);
  check('prompt() takes phone text and Enter', (await pageJs('window.answer')) === 'd!' || (await pageJs('window.answer')) === '!', await pageJs('window.answer'));

  // ---- beforeunload can't trap, back works, YouTube-style pruning only on YouTube
  check('JSON.parse untouched off YouTube', (await pageJs('window.parsed.adPlacements')) === 1);
  a.load(`${base}/noclick`);
  await until(() => a.screens.dialog);
  check('first alert shows', /says/.test(a.screens.dialog?.title || ''), a.screens.dialog);
  await until(() => uiJs(`document.querySelector('[data-key=x0]') !== null`));
  key('Escape'); await until(() => !a.screens.dialog);
  await until(() => a.screens.dialog);
  key('Escape'); await until(() => !a.screens.dialog);
  await until(() => a.tab().jsDialogs >= 3);
  await sleep(300);
  check('a dialog loop is cut off after two', !a.screens.dialog && a.tab().jsDialogs === 3, a.tab().jsDialogs);
  check('window.open without a click is blocked', (await pageJs('window.popped')) === null && a.tabs.length === 1);
  check('forced redirect to an ad domain stopped', !hits.some((h) => h.startsWith('ads.test')) && /noclick/.test(a.tab().url), a.tab().url);

  a.load(`${base}/`);
  await until(() => a.tab().title === 'News');
  await sleep(200);
  await click('adlink');
  await until(() => a.tab().pageHost === 'ads.test');
  check('a deliberate click can still follow a link to a filtered site', a.tab().pageHost === 'ads.test', a.tab().url);

  a.load(`https://www.youtube.com:${tlsPort}/two`);
  await until(() => a.tab().title === 'Two');
  const pruned = await pageJs(`Object.keys(JSON.parse('{"adPlacements":1,"keep":2}')).join()`);
  check('YouTube prune removes ad fields', pruned === 'keep', pruned);

  // ---- clean up
  a.load(`${base}/overlay`);
  await until(() => a.tab().title === 'O');
  a.actions.pointer({ op: 'k' });
  await until(async () => !(await pageJs(`!!document.getElementById('wall')`)));
  check('clean up removes the wall and unlocks scrolling', !(await pageJs(`!!document.getElementById('wall')`)) && (await pageJs(`getComputedStyle(document.body).overflow`)) === 'auto', await pageJs(`getComputedStyle(document.body).overflow`));

  // ---- fullscreen
  a.load(`${base}/`);
  await until(() => a.tab().title === 'News');
  await sleep(200);
  await click('fs');
  await until(() => a.fullscreen);
  check('page can go full screen', a.fullscreen);
  key('Escape');
  await until(() => !a.fullscreen);
  check('Back leaves full screen, not the page', !a.fullscreen && a.tab().title === 'News');

  // ---- back into history, then the start screen
  await pageJs(`location.href='/two'`);
  await until(() => a.tab().title === 'Two');
  key('Escape');
  await until(() => a.tab().title === 'News');
  check('Back goes back a page, past a beforeunload', a.tab().title === 'News');
  a.tab().view.webContents.navigationHistory.clear();
  key('Escape');
  await until(() => a.screens.start);
  check('Back at the first page shows the start screen', a.screens.start);
  await sleep(100);
  key('Escape');
  await until(() => !a.screens.start);
  check('Back on the start screen returns to the page', !a.screens.start);

  // ---- hold Back opens the menu
  a.onInput({ preventDefault() {} }, { type: 'keyDown', key: 'Escape' });
  await sleep(700);
  a.onInput({ preventDefault() {} }, { type: 'keyUp', key: 'Escape' });
  check('hold Back opens the menu', !!a.screens.menu);
  await until(() => uiJs(`document.querySelectorAll('#menu .tile').length`));
  await uiJs(`document.querySelector('[data-key=m14]').click()`); // Pair phone
  await until(() => a.screens.dialog);
  await until(() => uiJs(`document.querySelector('.pair img')?.complete && document.querySelector('.pair img').naturalWidth > 0`));
  check('Pair phone shows a QR image', await uiJs(`document.querySelector('.pair img').naturalWidth > 0`));
  check('pair text has the address and token', a.screens.dialog.message.includes(a.tokens.token));
  key('Escape');
  await until(() => !a.screens.dialog);

  // ---- address bar: the top edge of the window, and F6
  const shown = () => a.tab().url;
  a.load(`${base}/two`);
  await until(async () => (await pageJs('document.title').catch(() => '')) === 'Two');
  const wc = a.tab().view.webContents;
  const realMouse = (y, type = 'mouseMove') => wc.sendInputEvent({ type, x: 600, y, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
  const uiMouse = (y, type = 'mouseMove', x = 600) => a.uiView.webContents.sendInputEvent({ type, x, y, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
  const closeBar = async () => { key('Escape'); await until(() => !a.screens.address); };
  realMouse(0);
  check('a mouse already at the top when the page appears does nothing', !a.screens.address);
  realMouse(300);
  check('the bar is hidden away from the top', !a.screens.address);
  realMouse(0);
  check('the mouse at the top shows the URL', a.screens.address?.value === shown() && a.screens.address.hover === true, a.screens.address);
  await until(() => uiJs(`document.getElementById('addr')?.value`).then((v) => v === shown()));
  check('the bar shows the page address', await uiJs(`document.getElementById('addr').value`) === shown());
  uiMouse(20);
  await sleep(150);
  check('the bar stays while the mouse is on it', !!a.screens.address);
  uiMouse(500);
  await until(() => !a.screens.address);
  check('the bar closes when the mouse leaves', !a.screens.address);
  realMouse(300); realMouse(0);
  await until(() => uiJs(`!!document.getElementById('addr')`));
  await uiJs(`document.getElementById('addr').value += 'x'; 0`);
  uiMouse(500);
  await sleep(200);
  check('a bar with typing stays when the mouse leaves', !!a.screens.address);
  uiMouse(500, 'mouseDown'); uiMouse(500, 'mouseUp');
  await until(() => !a.screens.address);
  check('a click outside closes it', !a.screens.address);
  realMouse(300); realMouse(0);
  await closeBar();
  realMouse(1);
  check('Esc is not undone while the mouse stays at the top', !a.screens.address);
  // Showing the pointer view makes Chromium re-report the hardware cursor, which is 0,0 on the hidden display
  // whatever was simulated here. So it goes up first, and the mouse is placed below the edge after that.
  a.actions.pointer({ op: 'm', a: 0, b: 40 });
  await sleep(150);
  realMouse(300);
  a.actions.pointer({ op: 'm', a: 0, b: -3000 }); a.actions.pointer({ op: 'm', a: 0, b: -3000 });
  await sleep(100);
  check('the phone pointer at the top leaves the bar alone', a.pointer.y === 0 && !a.screens.address, a.pointer);
  key('ArrowUp'); await sleep(60);
  check('the remote pointer at the top leaves the bar alone', !a.screens.address);
  realMouse(300, 'mouseDown'); realMouse(0); realMouse(300); realMouse(300, 'mouseUp');
  check('dragging to the top leaves the bar alone', !a.screens.address);
  a.tab().editing = true;
  realMouse(0); realMouse(300);
  a.tab().editing = false;
  check('typing in the page leaves the bar alone', !a.screens.address);
  key('F6');
  check('F6 shows the URL', a.screens.address?.value === shown() && !a.screens.address.hover, a.screens.address);
  await until(() => uiJs(`!!document.getElementById('addr')`));
  uiMouse(500);
  await sleep(200);
  check('a bar from F6 stays when the mouse moves', !!a.screens.address);
  key('F6');
  check('F6 again closes it', !a.screens.address);

  // ---- tabs and the menu button in the address bar
  const uiKey = (keyCode) => a.uiView.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  const focused = () => uiJs('document.activeElement.className');
  const tabLabels = () => uiJs(`[...document.querySelectorAll('.tab')].map((b) => b.textContent)`);
  const barDrawn = () => until(() => uiJs(`!!document.getElementById('addr')`));
  key('F6');
  await barDrawn();
  check('one tab: no tab strip', (await tabLabels()).length === 0);
  await uiJs(`document.querySelector('.menu-button').click(); 0`);
  await until(() => a.screens.menu);
  check('the menu button opens the menu', !!a.screens.menu && !a.screens.address);
  key('Escape');
  await until(() => !a.screens.menu);
  a.openInNewTab(`${base}/overlay`);
  await until(async () => (await pageJs('document.title').catch(() => '')) === 'O');
  // A new view makes Chromium re-report the hardware cursor, 0,0 on the hidden display, which may open the bar.
  await sleep(150);
  if (!a.screens.address) key('F6');
  await until(async () => (await tabLabels()).length === 2);
  check('two tabs appear in the bar', JSON.stringify(await tabLabels()) === '["Two","O"]', await tabLabels());
  check('the current tab is marked', await uiJs(`document.querySelector('.tab.current').textContent`) === 'O');
  await uiJs(`document.getElementById('addr').value = 'typed'; 0`);
  await pageJs(`document.title = 'Renamed'; 0`);
  await until(async () => (await tabLabels())[1] === 'Renamed');
  check('a new page title reaches the tab', (await tabLabels())[1] === 'Renamed', await tabLabels());
  check('and leaves what was typed alone', await uiJs(`document.getElementById('addr').value`) === 'typed');
  await uiJs(`document.getElementById('addr').value = ${JSON.stringify(a.screens.address.value)}; 0`);
  uiKey('Right');
  await until(async () => (await focused()).includes('menu-button'));
  check('Right at the end of the URL reaches the menu button', (await focused()).includes('menu-button'), await focused());
  uiKey('Left');
  await until(async () => (await uiJs('document.activeElement.id')) === 'addr');
  uiKey('Up');
  await until(async () => (await focused()).includes('tab'));
  check('Up reaches the tabs', (await focused()).includes('tab'), await focused());
  await uiJs(`document.querySelector('.tab').click(); 0`);
  await until(() => a.tab().title === 'Two');
  await until(() => uiJs(`document.getElementById('addr').value`).then((v) => v.endsWith('/two')));
  check('clicking a tab switches to it and shows its URL', a.tab().title === 'Two' && a.screens.address?.value.endsWith('/two'), a.screens.address);
  await closeBar();
  realMouse(300); realMouse(0);
  await barDrawn();
  const r = await uiJs(`(()=>{const r=document.querySelectorAll('.tab')[1].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  uiMouse(r.y, 'mouseDown', r.x); uiMouse(r.y, 'mouseUp', r.x);
  await until(() => a.tab().title === 'Renamed');
  check('a real click on a tab switches to it', a.tab().title === 'Renamed', a.tab().title);
  await sleep(150);
  uiMouse(500);
  await until(() => !a.screens.address);
  check('clicking a tab does not stop the bar hiding', !a.screens.address);

  // ---- Zoom 100% in the menu
  const menuItem = (label) => uiJs(`[...document.querySelectorAll('#menu .tile')].find((b) => b.textContent.endsWith(${JSON.stringify(label)})).click(); 0`);
  key('F1');
  await until(() => a.screens.menu);
  await until(() => uiJs(`document.querySelectorAll('#menu .tile').length > 0`));
  await menuItem('Zoom in');
  await until(() => a.tab().view.webContents.getZoomFactor() > 1.2);
  check('Zoom in still works', a.tab().view.webContents.getZoomFactor() > 1.2, a.tab().view.webContents.getZoomFactor());
  await menuItem('Zoom 100%');
  await until(() => a.tab().view.webContents.getZoomFactor() === 1);
  check('Zoom 100% resets the page', a.tab().view.webContents.getZoomFactor() === 1 && a.tab().zoom === 1, a.tab().zoom);
  check('and leaves the menu open', !!a.screens.menu);
  const grid = await uiJs(`(()=>{const g=document.querySelector('#menu .grid').getBoundingClientRect();return{top:g.top,bottom:g.bottom,height:innerHeight}})()`);
  check('the menu still fits on screen', grid.top >= 0 && grid.bottom <= grid.height, grid);
  key('F1');
  await until(() => !a.screens.menu);

  // ---- closing tabs from the bar
  a.openInNewTab(`${base}/overlay`);
  await until(async () => (await pageJs('document.title').catch(() => '')) === 'O');
  await sleep(150);
  if (!a.screens.address) key('F6');
  await until(async () => (await tabLabels()).length === 3);
  check('each tab has a close button', await uiJs(`document.querySelectorAll('.tab-close').length`) === 3);
  await uiJs(`document.getElementById('addr').focus(); 0`);
  uiKey('Up');
  await until(async () => (await focused()) !== '' && !(await uiJs(`document.activeElement.id`)));
  check('Up never lands on a close button', /^tab/.test(await focused()) && !(await focused()).includes('tab-close'), await focused());
  await uiJs(`document.querySelector('.tab').focus(); 0`);
  uiKey('Right');
  await until(async () => (await focused()).includes('tab-close'));
  check('Right from a tab reaches its close button', await uiJs(`document.activeElement === document.querySelector('.tab-close')`));
  await uiJs(`document.getElementById('addr').value = 'typed'; 0`);
  await uiJs(`document.querySelectorAll('.tab-close')[0].click(); 0`);
  await until(async () => (await tabLabels()).length === 2);
  check('closing a tab to the left keeps the current page', a.tab().title === 'O' && a.tabs.length === 2 && await uiJs(`document.querySelector('.tab.current').textContent`) === 'O', a.tab().title);
  check('closing another tab leaves what was typed alone', await uiJs(`document.getElementById('addr').value`) === 'typed');
  const x = await uiJs(`(()=>{const r=document.querySelectorAll('.tab-close')[1].getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  uiMouse(x.y, 'mouseMove', x.x);
  await sleep(50);
  uiMouse(x.y, 'mouseDown', x.x); uiMouse(x.y, 'mouseUp', x.x);
  await until(() => a.tabs.length === 1);
  check('a real click on × closes the current tab', a.tabs.length === 1 && a.tab().title === 'Renamed', a.tab().title);
  await until(() => uiJs(`document.getElementById('addr').value`).then((v) => v.endsWith('/overlay')));
  check('the bar moves to the tab that is left', a.screens.address?.value.endsWith('/overlay'), a.screens.address);
  check('one tab left: the strip goes', (await tabLabels()).length === 0);
  check('the page left is on screen and answers', (await pageJs('document.title')) === 'Renamed' && a.tab().view.getVisible());
  await closeBar();

  // ---- no address bar injection, odd addresses
  check('javascript: refused', a.actions.openUrl('javascript:alert(1)') === false);
  check('file: refused', a.actions.openUrl('file:///etc/passwd') === false);
  check('data: refused', a.actions.openUrl('data:text/html,x') === false);

  // ---- settings survive
  a.bookmarks.add({ url: `${base}/`, title: 'News' });
  require('electron').app.quit();
}

global.__tvcbTest = {
  fetcher: async () => new Response(FILTERS),
  server: { allowPeer: () => true },
  onWindow: (w) => w.setBounds({ x: 0, y: 0, width: 1280, height: 720 }),
  ready: (a) => {
    run(a).catch((e) => { check('test run finished', false, String(e.stack)); }).finally(() => {
      const failed = results.filter((r) => !r[1]);
      console.log(`\n${results.length - failed.length}/${results.length} passed`);
      fs.rmSync(dir, { recursive: true, force: true });
      app.exit(failed.length ? 1 : 0);
    });
  },
};

// Every *.test host resolves to the local server.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');
app.commandLine.appendSwitch('ignore-certificate-errors');
const tls = tlsServer();
let tlsPort = 0;
tls.listen(0, '127.0.0.1', () => {
  tlsPort = tls.address().port;
  web.listen(0, '127.0.0.1', () => { require('../src/main.js'); });
});
