'use strict';
const crypto = require('crypto');

/**
 * The phone-pairing token: 128 random bits, stored encrypted with the desktop keyring or the macOS
 * Keychain when there is one (Electron safeStorage). Without one, or if access is denied, it falls
 * back to the settings file, which only this user can read.
 */
class TokenStore {
  constructor(store, safeStorage) {
    this.store = store;
    this.safe = safeStorage;
    this.token = this.load() || this.rotate();
  }

  encrypted() {
    try {
      // The backend can only be asked for on Linux; macOS always uses the Keychain.
      return this.safe && this.safe.isEncryptionAvailable() && this.safe.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  /** Makes a new token, so every phone paired before has to scan the QR code again. */
  rotate() {
    const t = crypto.randomBytes(16).toString('hex');
    try {
      if (!this.encrypted()) throw new Error('no keyring');
      this.store.set('token', { enc: this.safe.encryptString(t).toString('base64') });
    } catch { this.store.set('token', { plain: t }); }
    this.token = t;
    return t;
  }

  /** Constant-time comparison with the current token. */
  matches(candidate) {
    if (typeof candidate !== 'string') return false;
    const hash = (s) => crypto.createHash('sha256').update(s).digest();
    return crypto.timingSafeEqual(hash(candidate), hash(this.token));
  }

  load() {
    const saved = this.store.get('token');
    if (!saved) return null;
    if (saved.plain) return saved.plain;
    try { return this.safe.decryptString(Buffer.from(saved.enc, 'base64')); } catch { return null; }
  }
}

module.exports = { TokenStore };
