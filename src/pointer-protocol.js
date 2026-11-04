'use strict';
const crypto = require('crypto');

/*
 * The phone trackpad's wire format and the small part of WebSocket (RFC 6455) it needs.
 * Messages are short text frames: a command letter, optionally followed by two numbers.
 *   m dx dy   move the pointer (phone pixels, scaled on the TV)
 *   s dx dy   scroll the page under the pointer
 *   c         click            2   double-click
 *   d / u     press / release (drag)
 *   l         long press (right click, on a computer)
 *   z n       zoom in (n > 0) or out (n < 0)
 *   x         remove the element under the pointer
 *   k         clean up the page (overlays, scroll lock)
 *   p         keep-alive; the TV answers "p"
 */
const OPS = 'msc2dulzxkp';
const MAX_DELTA = 2000;
const MAX_TEXT = 64;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 1, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

/** Parses one message; null if it is malformed, too long or has an unknown command. */
function parse(msg) {
  if (!msg || msg.length > MAX_TEXT) return null;
  const parts = msg.trim().split(' ').filter(Boolean);
  if (!parts.length || parts[0].length !== 1) return null;
  const op = parts[0];
  if (!OPS.includes(op)) return null;
  const needs = op === 'm' || op === 's' ? 2 : op === 'z' ? 1 : 0;
  if (parts.length !== needs + 1) return null;
  const nums = [0, 0];
  for (let i = 0; i < needs; i++) {
    const v = Number(parts[i + 1]);
    if (!Number.isFinite(v)) return null;
    nums[i] = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v));
  }
  return { op, a: nums[0], b: nums[1] };
}

/** The Sec-WebSocket-Accept value for a client key, or null if the key isn't a valid 16-byte nonce. */
function acceptKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.trim();
  if (!/^[A-Za-z0-9+/]{22}==$/.test(k)) return null;
  return crypto.createHash('sha1').update(k + GUID, 'ascii').digest('base64');
}

class ProtocolError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

/**
 * Reads one frame from the start of [buf]. Returns { opcode, payload, used }, or null if more bytes are
 * needed. Clients must mask; fragmented, binary and oversized frames throw a ProtocolError carrying the
 * close code to send.
 */
function readFrame(buf, maxPayload = 256) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  if (b0 & 0x70) throw new ProtocolError(1002, 'reserved bits set');
  const opcode = b0 & 0x0f;
  if (!(b1 & 0x80)) throw new ProtocolError(1002, 'client frame not masked');
  let len = b1 & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2); at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2); at = 10;
    len = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
  }
  if (opcode >= 8 && (len > 125 || !fin)) throw new ProtocolError(1002, 'bad control frame');
  if (opcode === 0 || opcode === 2) throw new ProtocolError(1003, 'only unfragmented text frames are accepted');
  if (![OP_TEXT, OP_CLOSE, OP_PING, OP_PONG].includes(opcode)) throw new ProtocolError(1002, `unknown opcode ${opcode}`);
  if (!fin) throw new ProtocolError(1003, 'fragmented messages are not accepted');
  if (len > maxPayload) throw new ProtocolError(1009, 'message too big');
  if (buf.length < at + 4 + len) return null;
  const mask = buf.subarray(at, at + 4);
  const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len));
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { opcode, payload, used: at + 4 + len };
}

/** An unmasked server frame (servers never mask). Payloads here are always short. */
function frame(opcode, payload) {
  const head = payload.length < 126 ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

const closePayload = (code) => Buffer.from([code >> 8, code & 0xff]);

/** A token bucket: [perSecond] messages a second on average, bursts up to the same number. */
class RateLimit {
  constructor(perSecond, clock = () => Number(process.hrtime.bigint())) {
    this.perSecond = perSecond; this.clock = clock; this.tokens = perSecond; this.last = clock();
  }

  allow() {
    const now = this.clock();
    this.tokens = Math.min(this.perSecond, this.tokens + (now - this.last) / 1e9 * this.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

module.exports = { parse, acceptKey, readFrame, frame, closePayload, RateLimit, ProtocolError, OP_TEXT, OP_CLOSE, OP_PING, OP_PONG, MAX_TEXT };
