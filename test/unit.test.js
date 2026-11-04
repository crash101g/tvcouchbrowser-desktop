'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { test } = require('node:test');
const proto = require('../src/pointer-protocol');
const { parseLists } = require('../src/filter-parser');
const { AdBlocker, site } = require('../src/adblocker');
const { PhoneServer, isLanPeer, extract } = require('../src/phone-server');
const { TokenStore } = require('../src/tokens');
const { advertiser, commandHeld, desktopUserAgent, routeInterface } = require('../src/platform');
const { Store } = require('../src/store');
const { Bookmarks } = require('../src/bookmarks');

const memStore = () => ({ d: {}, get(k, f) { return k in this.d ? this.d[k] : f; }, set(k, v) { this.d[k] = v; } });
const u = (s) => new URL(s);

function masked(opcode, text, { fin = true } = {}) {
  const p = Buffer.from(text); const mask = crypto.randomBytes(4);
  const body = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
  const len = p.length < 126 ? Buffer.from([0x80 | p.length]) : Buffer.from([0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), len, mask, body]);
}

// ---- pointer protocol (the cases from upstream's PointerProtocolTest) --------------------------------
test('parse', () => {
  assert.deepEqual(proto.parse('m 12 -3'), { op: 'm', a: 12, b: -3 });
  assert.deepEqual(proto.parse('c'), { op: 'c', a: 0, b: 0 });
  assert.equal(proto.parse('z 1').a, 1);
  assert.equal(proto.parse('m 99999 0').a, 2000);
  for (const bad of ['', 'm', 'm 1', 'c 1', 'q', 'mm 1 2', 'm NaN 1', 'm Infinity 1', 'm 1 2 3', 'x'.repeat(65)]) assert.equal(proto.parse(bad), null, bad);
});

test('accept key is the RFC 6455 example', () => {
  assert.equal(proto.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(proto.acceptKey('short'), null);
  assert.equal(proto.acceptKey(undefined), null);
});

test('frames', () => {
  const f = proto.readFrame(masked(proto.OP_TEXT, 'm 1 2'));
  assert.equal(f.payload.toString(), 'm 1 2');
  assert.equal(proto.readFrame(masked(proto.OP_TEXT, 'abc').subarray(0, 4)), null); // partial
  assert.throws(() => proto.readFrame(Buffer.from([0x81, 0x01, 0x41])), /not masked/);
  assert.throws(() => proto.readFrame(masked(2, 'x')), (e) => e.code === 1003);
  assert.throws(() => proto.readFrame(masked(proto.OP_TEXT, 'x', { fin: false })), (e) => e.code === 1003);
  assert.throws(() => proto.readFrame(masked(proto.OP_TEXT, 'x'.repeat(300))), (e) => e.code === 1009);
});

test('rate limit', () => {
  let now = 0;
  const r = new proto.RateLimit(2, () => now);
  assert.ok(r.allow()); assert.ok(r.allow()); assert.ok(!r.allow());
  now = 1e9; assert.ok(r.allow());
});

// ---- filters --------------------------------------------------------------------------------------
function blockerWith(text, store = memStore()) {
  const b = new AdBlocker(store, fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-')), null);
  b.filters = parseLists([text]);
  return b;
}

test('network rules', () => {
  const b = blockerWith(['||ads.example.com^', '||cdn.example.net/banners/', '||third.example.org^$third-party',
    '||first.example.org^$1p', '@@||ok.ads.example.com^', '||skip.example.com^$domain=x.com', '/regexrule/',
    '||both.example.org^$3p', '||both.example.org^$1p', '||x.y.example.com/*/ad^'].join('\n'));
  assert.ok(b.shouldBlock(u('https://ads.example.com/a.js'), 'news.com'));
  assert.ok(b.shouldBlock(u('https://sub.ads.example.com/a.js'), 'news.com'));
  assert.ok(!b.shouldBlock(u('https://ok.ads.example.com/a.js'), 'news.com'));
  assert.ok(b.shouldBlock(u('https://cdn.example.net/banners/1.png?x=1'), 'news.com'));
  assert.ok(!b.shouldBlock(u('https://cdn.example.net/video/1.mp4'), 'news.com'));
  assert.ok(b.shouldBlock(u('https://third.example.org/'), 'news.com'));
  assert.ok(!b.shouldBlock(u('https://third.example.org/'), 'www.example.org'));
  assert.ok(b.shouldBlock(u('https://first.example.org/'), 'example.org'));
  assert.ok(!b.shouldBlock(u('https://first.example.org/'), 'news.com'));
  assert.ok(!b.shouldBlock(u('https://skip.example.com/'), 'news.com'));
  assert.ok(b.shouldBlock(u('https://both.example.org/'), 'news.com'));
  assert.ok(b.shouldBlock(u('https://both.example.org/'), 'example.org'));
});

test('captchas are never blocked', () => {
  const b = blockerWith('||google.com^\n||hcaptcha.com^\n||challenges.cloudflare.com^');
  assert.ok(!b.shouldBlock(u('https://www.google.com/recaptcha/api.js'), 'x.com'));
  assert.ok(!b.shouldBlock(u('https://newassets.hcaptcha.com/c.js'), 'x.com'));
  assert.ok(!b.shouldBlock(u('https://challenges.cloudflare.com/t.js'), 'x.com'));
  assert.ok(b.shouldBlock(u('https://www.google.com/other'), 'x.com'));
});

test('popup rules apply only to popups', () => {
  const b = blockerWith('||pop.example.com^$popup');
  assert.ok(!b.shouldBlock(u('https://pop.example.com/'), 'x.com'));
  assert.ok(b.shouldBlockPopup(u('https://pop.example.com/'), 'x.com'));
});

test('cosmetic rules', () => {
  const b = blockerWith(['##.ad-box', '###banner', '##div[data-ad]', 'news.com##.promo', 'news.com#@#.ad-box',
    'other.com##.x:has-text(foo)', '@@||nohide.com^$elemhide', '@@||nogeneric.com^$generichide'].join('\n'));
  const top = b.cosmeticCss('www.news.com', true);
  assert.match(top, /\.promo/); assert.match(top, /div\[data-ad\]/);
  assert.doesNotMatch(b.cosmeticCss('www.news.com', false), /data-ad/); // not in subframes
  assert.doesNotMatch(b.cosmeticCss('other.com', true), /has-text/);
  assert.equal(b.genericCss('news.com', ['.ad-box']), ''); // excepted
  assert.match(b.genericCss('foo.com', ['.ad-box', '#banner']), /\.ad-box.*#banner/);
  assert.equal(b.genericCss('foo.com', ['.nothing']), '');
  assert.equal(b.genericCss('nogeneric.com', ['.ad-box']), '');
  assert.equal(b.cosmeticCss('nohide.com', true).trim(), '');
});

test('zaps are per site, validated and included in the page css', () => {
  const b = blockerWith('');
  assert.ok(b.addZap('www.news.com', '#sticky'));
  assert.ok(!b.addZap('news.com', 'x{}'));
  assert.ok(!b.addZap('news.com', 'a;b'));
  assert.equal(b.zapCount('m.news.com'), 1);
  assert.match(b.cosmeticCss('news.com', true), /#sticky\{display:none/);
  b.clearZaps('news.com');
  assert.equal(b.zapCount('news.com'), 0);
});

test('allowlist and on/off', () => {
  const b = blockerWith('');
  assert.ok(b.active('www.a.com'));
  b.setAllowlisted('www.a.com', true);
  assert.ok(!b.active('a.com'));
  b.setAllowlisted('a.com', false);
  b.enabled = false;
  assert.ok(!b.active('a.com'));
});

test('site', () => {
  assert.equal(site('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(site('a.b.example.com'), 'example.com');
  assert.equal(site('localhost'), 'localhost');
});

test('download, parse in a worker, then reload from the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-'));
  let fetches = 0;
  const body = '||ad.example.com^\n' + '! padding\n'.repeat(200);
  const fetcher = async () => { fetches++; return new Response(body); };
  const b = new AdBlocker(memStore(), dir, fetcher);
  assert.equal(await b.start(), 'Filter lists updated');
  assert.equal(fetches, 9);
  assert.ok(b.shouldBlock(u('https://ad.example.com/'), 'x.com'));
  assert.ok(fs.existsSync(path.join(dir, 'parsed.bin')));
  const again = new AdBlocker(b.store, dir, fetcher);
  assert.equal(await again.start(), 'Filter lists loaded');
  assert.equal(fetches, 9);
  assert.ok(again.shouldBlock(u('https://ad.example.com/'), 'x.com'));
});

test('a failed list keeps the old copy and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-'));
  const b = new AdBlocker(memStore(), dir, async () => { throw new Error('offline'); });
  assert.equal(await b.start(), 'Updated 0 of 9 filter lists');
  assert.equal(b.lastUpdated, 0);
});

// ---- phone server ----------------------------------------------------------------------------------
const ifaces = { wlan: [{ address: '192.168.1.27', cidr: '192.168.1.27/24', internal: false }, { address: 'fe80::1', cidr: 'fe80::1/64', internal: false }], lo: [{ address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }] };

test('only other machines on the same private subnet are peers', () => {
  assert.ok(isLanPeer('192.168.1.50', ifaces));
  assert.ok(isLanPeer('::ffff:192.168.1.50', ifaces));
  assert.ok(isLanPeer('fe80::abcd', ifaces));
  assert.ok(!isLanPeer('192.168.2.50', ifaces));
  assert.ok(!isLanPeer('8.8.8.8', ifaces));
  assert.ok(!isLanPeer('127.0.0.1', ifaces));
  assert.ok(!isLanPeer('::1', ifaces));
  assert.ok(!isLanPeer('192.168.1.27', ifaces), 'this machine itself');
  assert.ok(!isLanPeer('::ffff:192.168.1.27', ifaces));
  assert.ok(!isLanPeer('garbage', ifaces));
});

test('extract', () => {
  assert.equal(extract('{"url":"a"}', 'url'), 'a');
  assert.equal(extract('{bad', 'url'), '');
  assert.equal(extract('url=a%20b', 'url'), 'a b');
  assert.equal(extract('plain', 'url'), 'plain');
});

async function serverRig(allowPeer = () => true) {
  const log = [];
  const tokens = { matches: (t) => t === 'good' };
  const actions = {
    openUrl: (u2) => { log.push(['open', u2]); return !u2.startsWith('bad'); },
    type: (t) => log.push(['type', t]),
    key: (k) => { log.push(['key', k]); return k === 'ok'; },
    pointer: (c) => log.push(['pointer', c.op]),
    pointerConnected: () => log.push(['connected']),
    pointerDisconnected: () => log.push(['disconnected']),
  };
  const s = new PhoneServer(tokens, actions, { allowPeer, ports: [0] });
  await s.start();
  const req = (method, p, body, headers) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    r.on('error', reject); r.end(body);
  });
  return { s, log, req };
}

test('requests need the token, and only do what they say', async () => {
  const { s, log, req } = await serverRig();
  try {
    assert.equal((await req('GET', '/?t=wrong')).status, 403);
    const page = await req('GET', '/?t=good', undefined, { Host: '192.168.1.27:8765' });
    assert.equal(page.status, 200);
    assert.match(page.body, /Trackpad/);
    assert.match(page.headers['content-security-policy'], /connect-src 'self' ws:\/\/192\.168\.1\.27:8765/);
    assert.equal((await req('POST', '/open?t=good', '{"url":"example.com"}')).status, 200);
    assert.equal((await req('POST', '/open?t=good', 'bad')).status, 422);
    assert.equal((await req('POST', '/open?t=good', '')).status, 400);
    assert.equal((await req('POST', '/open?t=good', 'x'.repeat(5000))).status, 400);
    await req('POST', '/type?t=good', 'hi\u0007\nthere');
    assert.equal((await req('POST', '/key?t=good&k=ok')).status, 200);
    assert.equal((await req('POST', '/key?t=good&k=nope')).status, 422);
    assert.equal((await req('POST', '/nothing?t=good')).status, 404);
    assert.deepEqual(log.filter((l) => l[0] === 'type'), [['type', 'hi\nthere']]);
  } finally { s.stop(); }
});

test('five wrong tokens block the address for a while', async () => {
  const { s, req } = await serverRig();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await req('GET', '/?t=no')).status, 403);
    assert.equal((await req('GET', '/?t=good')).status, 429);
  } finally { s.stop(); }
});

test('refused peers get nothing, and a broken URL does not crash the server', async () => {
  const { s, req } = await serverRig(() => false);
  try { await assert.rejects(req('GET', '/?t=good')); } finally { s.stop(); }
  const rig = await serverRig();
  try {
    await new Promise((resolve) => {
      const c = net.connect(rig.s.port, '127.0.0.1', () => c.write('GET //:: HTTP/1.1\r\nHost: x\r\n\r\n'));
      c.on('close', resolve); c.on('error', resolve); c.resume();
    });
    assert.equal((await rig.req('GET', '/?t=good')).status, 200);
  } finally { rig.s.stop(); }
});

function wsConnect(port, { token = 'good', origin } = {}) {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1');
    let got = Buffer.alloc(0);
    c.on('data', (d) => {
      got = Buffer.concat([got, d]);
      const at = got.indexOf('\r\n\r\n');
      if (at >= 0 && !c.head) { c.head = got.subarray(0, at).toString(); c.rest = got.subarray(at + 4); resolve(c); } else if (c.head) c.rest = Buffer.concat([c.rest, d]);
    });
    c.on('error', () => resolve(c));
    c.write(`GET /ws?t=${token} HTTP/1.1\r\nHost: tv:1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
  });
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

test('trackpad socket: commands, keep-alive, limits', async () => {
  const { s, log } = await serverRig();
  try {
    assert.match((await wsConnect(s.port, { token: 'bad' })).head, /403/);
    assert.match((await wsConnect(s.port, { origin: 'http://evil.example' })).head, /400/);
    assert.match((await wsConnect(s.port, { origin: 'http://tv:1' })).head, /101/);
    const a = await wsConnect(s.port);
    assert.match(a.head, /s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
    assert.match((await wsConnect(s.port)).head, /429/); // two already open
    a.write(Buffer.concat([masked(1, 'm 1 2'), masked(1, 'nonsense'), masked(1, 'c'), masked(1, 'p')]));
    await wait(100);
    assert.deepEqual(log.filter((l) => l[0] === 'pointer').map((l) => l[1]), ['m', 'c']);
    assert.ok(a.rest.equals(proto.frame(1, Buffer.from('p'))));
    a.write(Buffer.concat(Array.from({ length: 400 }, () => masked(1, 'c'))));
    await wait(100);
    assert.ok(log.filter((l) => l[0] === 'pointer').length <= 125, 'flood dropped');
    a.destroy();
    await wait(50);
    assert.ok(log.some((l) => l[0] === 'disconnected'));
  } finally { s.stop(); }
});

test('stop closes the port and open trackpads', async () => {
  const { s } = await serverRig();
  const port = s.port;
  const a = await wsConnect(port);
  const closed = new Promise((r) => a.on('close', r));
  s.stop();
  await closed;
  await assert.rejects(new Promise((resolve, reject) => { const c = net.connect(port, '127.0.0.1', resolve); c.on('error', reject); }));
});

// ---- storage ---------------------------------------------------------------------------------------
test('store survives a restart and a corrupt file; file is private', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-')), 'a.json');
  const s = new Store(f); s.set('a', [1]); s.flush();
  assert.deepEqual(new Store(f).get('a'), [1]);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.writeFileSync(f, '{oops');
  assert.equal(new Store(f).get('a', 'd'), 'd');
});

test('tokens: rotate, match, encrypted when a keyring exists', () => {
  const plainStore = memStore();
  const t = new TokenStore(plainStore, { isEncryptionAvailable: () => false });
  assert.match(t.token, /^[0-9a-f]{32}$/);
  assert.equal(new TokenStore(plainStore, { isEncryptionAvailable: () => false }).token, t.token);
  const old = t.token; t.rotate();
  assert.ok(!t.matches(old)); assert.ok(t.matches(t.token)); assert.ok(!t.matches(undefined));
  const safe = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (s) => Buffer.from(s).reverse(), decryptString: (b) => Buffer.from(b).reverse().toString() };
  const enc = memStore();
  const t2 = new TokenStore(enc, safe);
  assert.ok(!JSON.stringify(enc.d).includes(t2.token));
  assert.equal(new TokenStore(enc, safe).token, t2.token);
});

test('bookmarks', () => {
  const b = new Bookmarks(memStore(), fs.mkdtempSync(path.join(os.tmpdir(), 'tvcb-')));
  assert.equal(b.items.length, 4);
  b.add({ url: 'https://a/', title: 'A' }, Buffer.from('x'));
  assert.match(b.thumb('https://a/'), /^data:image\/jpeg/);
  assert.equal(b.move(4, 0), 0);
  assert.equal(b.items[0].title, 'A');
  assert.equal(b.move(0, 99), 4);
  b.remove(4);
  assert.equal(b.thumb('https://a/'), null);
  b.add({ url: b.items[0].url, title: 'Again' });
  assert.equal(b.items.length, 4);
});

test('the Keychain counts as encryption, though macOS has no storage backend to ask about', () => {
  const data = {};
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const t = new TokenStore(store, safe);
  assert.ok(data.token.enc);
  assert.equal(new TokenStore(store, safe).token, t.token);
});

test('a denied Keychain falls back to the settings file instead of stopping the app', () => {
  const data = {};
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
  const safe = { isEncryptionAvailable: () => true, encryptString: () => { throw new Error('denied'); } };
  const t = new TokenStore(store, safe);
  assert.equal(data.token.plain, t.token);
});

test('each system reports its own User-Agent', () => {
  assert.match(desktopUserAgent('144', 'darwin'), /\(Macintosh; Intel Mac OS X 10_15_7\).*Chrome\/144\.0\.0\.0/);
  assert.match(desktopUserAgent('144', 'linux'), /\(X11; Linux x86_64\).*Chrome\/144\.0\.0\.0/);
});

test('Cmd is a command key on a Mac only; Ctrl is on both', () => {
  assert.equal(commandHeld({ meta: true }, 'darwin'), true);
  assert.equal(commandHeld({ meta: true }, 'linux'), false);
  assert.equal(commandHeld({ control: true }, 'darwin'), true);
  assert.equal(commandHeld({ control: true }, 'linux'), true);
  assert.equal(commandHeld({}, 'darwin'), false);
});

test('the server is announced with Bonjour on a Mac and Avahi on Linux', () => {
  assert.deepEqual(advertiser(8765, 'darwin'), ['/usr/bin/dns-sd', ['-R', 'TVCouchBrowser', '_http._tcp', 'local', '8765']]);
  assert.equal(advertiser(8765, 'linux')[0], 'avahi-publish-service');
});

test('the default interface is read from macOS route output', () => {
  const output = '   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n';
  assert.equal(routeInterface(output), 'en0');
  assert.equal(routeInterface('route: writing to routing socket: not in table\n'), null);
});
