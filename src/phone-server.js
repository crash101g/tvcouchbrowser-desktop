'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { advertiser, routeInterface } = require('./platform');
const proto = require('./pointer-protocol');

const PORTS = [8765, 8766, 8767, 8768];
const MAX_SOCKETS = 2;
const MAX_POINTER_RATE = 120; // messages a second per trackpad; more are dropped
const MAX_BODY = 16384;
const MAX_FAILURES = 5;
const FAIL_WINDOW_MS = 10 * 60000;
const BLOCK_MS = 10 * 60000;
const HOST_HEADER = /^([A-Za-z0-9.-]+(:\d{1,5})?|\[[0-9A-Fa-f:.%]+\](:\d{1,5})?)$/;
const EXPIRED_PAGE = "<!doctype html><meta name=viewport content='width=device-width'>" +
  "<body style='font:18px -apple-system,sans-serif;padding:24px'>This link has expired. " +
  'On the TV, open the menu, choose <b>Pair phone</b> and scan the new QR code.</body>';
const PHONE_PAGE = path.join(__dirname, 'ui', 'phone.html');

/** Sockets report IPv4 peers on a dual-stack listener as ::ffff:a.b.c.d. */
const plainAddress = (a) => (a || '').replace(/^::ffff:/i, '').replace(/%.*$/, '');

function isPrivate(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^(fe[89ab]|f[cd])/i.test(addr); // link-local or ULA
}

function toBytes(addr) {
  if (net.isIPv4(addr)) return addr.split('.').map(Number);
  const [head, tail = ''] = addr.split('::');
  const words = (s) => s.split(':').filter(Boolean).map((w) => parseInt(w, 16));
  const h = words(head), t = words(tail);
  const all = [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

function samePrefix(a, b, bits) {
  let left = bits;
  for (let i = 0; i < a.length; i++) {
    if (left <= 0) return true;
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
    left -= 8;
  }
  return true;
}

/**
 * True for private (RFC 1918 / ULA) or link-local peers on the same subnet as one of this machine's
 * addresses. This machine itself is refused, so other programs on it can't drive the browser.
 */
function isLanPeer(rawAddr, interfaces = os.networkInterfaces()) {
  const addr = plainAddress(rawAddr);
  if (!net.isIP(addr) || !isPrivate(addr)) return false;
  const peer = toBytes(addr);
  let onSubnet = false;
  for (const list of Object.values(interfaces)) {
    for (const ia of list) {
      if (ia.internal) continue;
      const local = plainAddress(ia.address);
      if (local === addr) return false;
      const bytes = toBytes(local);
      if (bytes.length === peer.length && samePrefix(bytes, peer, Number(ia.cidr.split('/')[1]))) onSubnet = true;
    }
  }
  return onSubnet;
}

/** The address a phone should use: the one on the default route, not a VM or container bridge. */
function lanAddress() {
  const interfaces = os.networkInterfaces();
  const v4 = (name) => (interfaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
  if (process.platform === 'darwin') {
    try {
      const iface = routeInterface(execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (v4(iface)) return v4(iface).address;
    } catch { /* no default route: fall through */ }
  } else {
    try {
      for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
        const [iface, destination] = line.trim().split(/\s+/);
        if (destination === '00000000' && v4(iface)) return v4(iface).address;
      }
    } catch { /* no routing table: fall through */ }
  }
  for (const name of Object.keys(interfaces)) {
    if (!/^(lo|docker|br-|veth|virbr|tun|tap|wg|utun|bridge|awdl|llw|anpi|ap\d|gif|stf)/.test(name) && v4(name) && isPrivate(v4(name).address)) return v4(name).address;
  }
  return null;
}

/** Accepts a JSON object, a form body or plain text, so the iPhone Shortcut can send any of them. */
function extract(body, field) {
  const t = body.trim();
  if (t.startsWith('{')) {
    try { const v = JSON.parse(t)[field]; return v === undefined || v === null ? '' : String(v); } catch { return ''; }
  }
  if (t.startsWith(field + '=')) return new URLSearchParams(t).get(field) || '';
  return body;
}

/**
 * The small HTTP server behind the phone page. It runs only while the browser is on screen. Every
 * request needs the pairing token, must come from a private address on this machine's own subnet, and
 * can only carry a URL, text or a key name; never JavaScript.
 */
class PhoneServer {
  constructor(tokens, actions, { allowPeer = isLanPeer, ports = PORTS } = {}) {
    this.tokens = tokens;
    this.actions = actions;
    this.allowPeer = allowPeer;
    this.ports = ports;
    this.server = null;
    this.port = 0;
    this.openSockets = new Set();
    this.trackpads = 0;
    this.failures = new Map();
    this.advertiser = null;
  }

  async start() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.request(req, res));
    server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    server.on('connection', (s) => { s.on('error', () => {}); });
    for (const port of this.ports) {
      if (await this.listen(server, port)) {
        this.server = server;
        this.port = server.address().port;
        this.advertise();
        return;
      }
    }
  }

  listen(server, port) {
    return new Promise((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen({ port, host: '::', backlog: 8 }, () => { server.off('error', onError); resolve(true); });
    });
  }

  stop() {
    if (!this.server) return;
    this.server.close();
    this.server.closeAllConnections();
    this.server = null;
    this.port = 0;
    for (const s of this.openSockets) s.destroy();
    this.openSockets.clear();
    if (this.advertiser) this.advertiser.kill();
    this.advertiser = null;
  }

  /** Announces the server on the local network, through Avahi if installed or Bonjour on a Mac. Nothing depends on this. */
  advertise() {
    try {
      const [program, args] = advertiser(this.port);
      this.advertiser = spawn(program, args, { stdio: 'ignore' });
      this.advertiser.on('error', () => { this.advertiser = null; });
    } catch { this.advertiser = null; }
  }

  /** Token, subnet and rate checks shared by every request. Returns a refusal, or null to go on. */
  admit(remote, token) {
    const ip = plainAddress(remote);
    if (!this.allowPeer(remote)) return { code: 0 };
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f && f.blockedUntil > now) return { code: 429, type: 'text/plain', body: 'Too many attempts. Try again later.' };
    if (!this.tokens.matches(token)) {
      this.recordFailure(ip, now);
      return { code: 403, type: 'text/html; charset=utf-8', body: EXPIRED_PAGE, delay: 300 };
    }
    this.failures.delete(ip);
    return null;
  }

  recordFailure(ip, now) {
    let f = this.failures.get(ip);
    if (!f) { f = { count: 0, windowStart: now, blockedUntil: 0 }; this.failures.set(ip, f); }
    if (now - f.windowStart > FAIL_WINDOW_MS) { f.count = 0; f.windowStart = now; }
    if (++f.count >= MAX_FAILURES) { f.blockedUntil = now + BLOCK_MS; f.count = 0; }
  }

  send(res, code, type, body, wsHost) {
    // The phone page may open its trackpad socket back to this server, and nowhere else.
    const connect = wsHost && HOST_HEADER.test(wsHost) ? `; connect-src 'self' ws://${wsHost}` : '';
    res.writeHead(code, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'${connect}`,
      Connection: 'close',
    });
    res.end(body);
  }

  sendOk(res, ok) { this.send(res, ok ? 200 : 422, 'application/json', ok ? '{"ok":true}' : '{"ok":false}'); }

  request(req, res) {
    const url = URL.canParse(req.url, 'http://x') ? new URL(req.url, 'http://x') : null;
    if (!url) return req.socket.destroy();
    if (url.pathname === '/favicon.ico' && this.allowPeer(req.socket.remoteAddress)) return this.send(res, 404, 'text/plain', '');
    const refused = this.admit(req.socket.remoteAddress, url.searchParams.get('t'));
    if (refused) {
      if (refused.code === 0) return req.socket.destroy();
      return setTimeout(() => this.send(res, refused.code, refused.type, refused.body), refused.delay || 0);
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return this.send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PHONE_PAGE, 'utf8'), req.headers.host);
    }
    if (req.method !== 'POST' || !['/open', '/type', '/key'].includes(url.pathname)) return this.send(res, 404, 'text/plain', 'Not found');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { this.send(res, 400, 'text/plain', 'Bad request'); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/open') {
        const target = extract(body, 'url').trim();
        if (!target || target.length > 4096) return this.send(res, 400, 'text/plain', 'No URL');
        return this.sendOk(res, this.actions.openUrl(target));
      }
      if (url.pathname === '/type') {
        // Newlines stay; other control characters don't. Array.from counts whole characters.
        const text = Array.from(extract(body, 'text')).filter((c) => c === '\n' || c >= ' ').slice(0, 2000).join('');
        this.actions.type(text);
        return this.sendOk(res, true);
      }
      return this.sendOk(res, this.actions.key(url.searchParams.get('k') || ''));
    });
  }

  /**
   * The trackpad: a WebSocket that stays open and carries small pointer commands. The Origin must be
   * this server, so another site the phone has open can't drive the TV even if it learned the token.
   */
  upgrade(req, socket, head) {
    socket.on('error', () => {});
    if (!URL.canParse(req.url, 'http://x')) return socket.destroy();
    const reply = (code, reason, body) => {
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    };
    const url = new URL(req.url, 'http://x');
    const refused = this.admit(socket.remoteAddress, url.searchParams.get('t'));
    if (refused) {
      if (refused.code === 0) return socket.destroy();
      return setTimeout(() => reply(refused.code, refused.code === 429 ? 'Too Many Requests' : 'Forbidden', 'Refused'), refused.delay || 0);
    }
    const { host, origin } = req.headers;
    if (url.pathname !== '/ws' || (req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' || (origin && host && origin !== `http://${host}`)) {
      return reply(400, 'Bad Request', 'Bad upgrade');
    }
    const accept = proto.acceptKey(req.headers['sec-websocket-key']);
    if (!accept) return reply(400, 'Bad Request', 'Bad key');
    if (this.trackpads >= MAX_SOCKETS) return reply(429, 'Too Many Requests', 'Too many trackpads connected');
    this.trackpads++;
    this.openSockets.add(socket);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    socket.setTimeout(30000); // the phone sends a keep-alive every 10 s
    socket.on('timeout', () => socket.destroy());
    socket.on('end', () => socket.end()); // upgraded sockets stay half-open otherwise, holding a trackpad slot
    this.actions.pointerConnected();

    const limit = new proto.RateLimit(MAX_POINTER_RATE);
    let pending = head;
    const closeWith = (code) => { socket.end(proto.frame(proto.OP_CLOSE, proto.closePayload(code))); };
    socket.on('data', (data) => {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      try {
        for (;;) {
          const f = proto.readFrame(pending);
          if (!f) return;
          pending = pending.subarray(f.used);
          if (f.opcode === proto.OP_CLOSE) return closeWith(1000);
          if (f.opcode === proto.OP_PING) socket.write(proto.frame(proto.OP_PONG, f.payload));
          if (f.opcode !== proto.OP_TEXT || !limit.allow()) continue; // a flood just drops messages
          const cmd = proto.parse(f.payload.toString('utf8'));
          if (!cmd) continue;
          if (cmd.op === 'p') socket.write(proto.frame(proto.OP_TEXT, Buffer.from('p')));
          else this.actions.pointer(cmd);
        }
      } catch (e) {
        if (e instanceof proto.ProtocolError) closeWith(e.code); else socket.destroy();
      }
    });
    socket.once('close', () => {
      this.trackpads--;
      this.openSockets.delete(socket);
      this.actions.pointerDisconnected();
    });
  }
}

module.exports = { PhoneServer, isLanPeer, lanAddress, extract };
