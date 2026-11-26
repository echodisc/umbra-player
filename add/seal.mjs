// @ts-check
/**
 * The seal for "add a playlist to the TV from a phone"
 * (docs/r5_status/22.md, "The seal (page → TV)").
 *
 * The phone page seals the provider's details (an Xtream server, user name
 * and password, or an M3U address) to the TV's one-time X25519 public key,
 * so the server, its database and its logs only ever see the sealed blob.
 * It is Session 16's seal (site/tv/seal.mjs) with its own label and its own
 * plaintext, so a blob made for one can never be opened as the other:
 *
 *   shared = X25519(page_private, tv_public)          (all-zero refused)
 *   key    = HKDF-SHA256(ikm = shared,
 *                        salt = page_public ‖ tv_public,
 *                        info = "umbra/tv-add-playlist/v1", 32 bytes)
 *   ct‖tag = AES-256-GCM(key, nonce (12 random bytes), aad = CODE,
 *                        plaintext = UTF-8 JSON, one of
 *                          {"v":1,"kind":"xtream","server":…,"user":…,"pass":…}
 *                          {"v":1,"kind":"m3u","url":…}
 *                        with an optional "name" and "epg" after them)
 *   blob   = base64url-no-padding(0x01 ‖ page_public ‖ nonce ‖ ct ‖ tag)
 *            at most 8,192 characters.
 *
 * The X25519 arithmetic, base64url and the code rules are imported from
 * Session 16's module, unchanged. Web APIs only, as there.
 */

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  X25519_BASE,
  base64urlDecode,
  base64urlEncode,
  formatCode,
  generateKeyPair,
  isValidCode,
  normalizeCode,
  parseFragment,
  x25519,
} from '../tv/seal.mjs';

export { CODE_ALPHABET, CODE_LENGTH, base64urlDecode, base64urlEncode, formatCode, isValidCode, normalizeCode, parseFragment };

export const SEAL_VERSION = 1;
export const SEAL_INFO = 'umbra/tv-add-playlist/v1';
export const MAX_SEALED_LENGTH = 8192;
/** The plaintext's own ceiling, in UTF-8 bytes. */
export const MAX_PLAINTEXT_BYTES = 5000;

/** Character limits per field (after trimming). */
export const LIMITS = Object.freeze({ server: 2048, url: 2048, user: 256, pass: 256, name: 80, epg: 2048 });

const enc = new TextEncoder();

// ----------------------------------------------------------------- details

/** A field that cannot be sent; `field` names it for the page's error line. */
export class DetailsError extends Error {
  /**
   * @param {string} field
   * @param {'missing' | 'too_long' | 'bad_characters' | 'bad_kind'} reason
   */
  constructor(field, reason) {
    super(`details: ${field} ${reason}`);
    this.name = 'DetailsError';
    this.field = field;
    this.reason = reason;
  }
}

/** Control characters (C0, DEL, C1) never belong in an address or a login. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * @param {Record<string, unknown>} details
 * @param {keyof typeof LIMITS} field
 * @param {boolean} required
 * @returns {string | undefined}
 */
function cleanField(details, field, required) {
  const raw = details[field];
  if (raw === undefined || raw === null) {
    if (required) throw new DetailsError(field, 'missing');
    return undefined;
  }
  if (typeof raw !== 'string') throw new DetailsError(field, 'bad_characters');
  const value = raw.trim();
  if (value.length === 0) {
    if (required) throw new DetailsError(field, 'missing');
    return undefined;
  }
  if (value.length > LIMITS[field]) throw new DetailsError(field, 'too_long');
  if (CONTROL.test(value)) throw new DetailsError(field, 'bad_characters');
  return value;
}

/**
 * The details as they will be sealed: trimmed, checked, in a fixed key order
 * (v, kind, the kind's fields, then name and epg when given). Throws
 * DetailsError naming the first field that cannot be sent.
 * @param {Record<string, unknown>} details
 * @returns {Record<string, string | number>}
 */
export function normalizeDetails(details) {
  if (!details || typeof details !== 'object') throw new DetailsError('kind', 'bad_kind');
  /** @type {Record<string, string | number>} */
  const out = { v: SEAL_VERSION };
  if (details.kind === 'xtream') {
    out.kind = 'xtream';
    out.server = /** @type {string} */ (cleanField(details, 'server', true));
    out.user = /** @type {string} */ (cleanField(details, 'user', true));
    out.pass = /** @type {string} */ (cleanField(details, 'pass', true));
  } else if (details.kind === 'm3u') {
    out.kind = 'm3u';
    out.url = /** @type {string} */ (cleanField(details, 'url', true));
  } else {
    throw new DetailsError('kind', 'bad_kind');
  }
  const name = cleanField(details, 'name', false);
  if (name !== undefined) out.name = name;
  const epg = cleanField(details, 'epg', false);
  if (epg !== undefined) out.epg = epg;
  return out;
}

// --------------------------------------------------------------------- seal

/** @param {number} n */
function defaultRandomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** @param {Uint8Array} b */
function isAllZero(b) {
  let acc = 0;
  for (let i = 0; i < b.length; i++) acc |= b[i];
  return acc === 0;
}

/** @param {Uint8Array[]} parts */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** @param {Uint8Array | string} key */
function publicKeyBytes(key) {
  const bytes = typeof key === 'string' ? base64urlDecode(key) : key;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('the TV key must be 32 bytes');
  return bytes;
}

/**
 * @param {Uint8Array} shared
 * @param {Uint8Array} pagePublic
 * @param {Uint8Array} tvPublic
 * @param {KeyUsage[]} usages
 */
async function deriveAesKey(shared, pagePublic, tvPublic, usages) {
  const subtle = globalThis.crypto.subtle;
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(pagePublic, tvPublic), info: enc.encode(SEAL_INFO) },
    ikm,
    256,
  );
  const raw = new Uint8Array(bits);
  try {
    return await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
  } finally {
    raw.fill(0);
  }
}

/**
 * Seals the details to the TV's public key. Returns the blob (string).
 * Throws DetailsError for a field that cannot be sent.
 * `randomBytes` is for deterministic test vectors ONLY: it is asked first
 * for the page's 32-byte private key, then for the 12-byte nonce.
 * @param {{details: Record<string, unknown>, code: string, tvPublicKey: Uint8Array | string,
 *          randomBytes?: (n: number) => Uint8Array}} args
 * @returns {Promise<string>}
 */
export async function sealPlaylist({ details, code, tvPublicKey, randomBytes }) {
  const body = normalizeDetails(details);
  const canonical = normalizeCode(code);
  if (!isValidCode(canonical)) throw new Error('seal: bad code');
  const tvPublic = publicKeyBytes(tvPublicKey);
  const plaintext = enc.encode(JSON.stringify(body));
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    plaintext.fill(0);
    throw new DetailsError(body.kind === 'xtream' ? 'server' : 'url', 'too_long');
  }
  const rand = randomBytes ?? defaultRandomBytes;

  const { privateKey: pagePrivate, publicKey: pagePublic } = generateKeyPair(rand);
  const shared = x25519(pagePrivate, tvPublic);
  pagePrivate.fill(0);
  if (isAllZero(shared)) {
    plaintext.fill(0);
    throw new Error('seal: the TV key is not usable');
  }

  const key = await deriveAesKey(shared, pagePublic, tvPublic, ['encrypt']);
  shared.fill(0);
  const nonce = Uint8Array.from(rand(12));
  if (nonce.length !== 12) throw new Error('randomBytes gave the wrong length');
  let sealedBytes;
  try {
    sealedBytes = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(canonical), tagLength: 128 },
        key,
        plaintext,
      ),
    );
  } finally {
    plaintext.fill(0);
  }
  const blob = base64urlEncode(concat(Uint8Array.of(SEAL_VERSION), pagePublic, nonce, sealedBytes));
  if (blob.length > MAX_SEALED_LENGTH) throw new Error('seal: the details are too long to send');
  return blob;
}

/**
 * Opens a blob with the TV's private key (the TV side; used by the tests and
 * the shared vector). Returns the parsed body as sealed. Throws on any
 * mismatch (wrong code, wrong key, changed byte, wrong version, bad body).
 * @param {{sealed: string, code: string, tvPrivateKey: Uint8Array | string}} args
 * @returns {Promise<Record<string, string | number>>}
 */
export async function openPlaylist({ sealed, code, tvPrivateKey }) {
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_LENGTH) throw new Error('open: bad blob');
  const bytes = base64urlDecode(sealed);
  if (bytes.length < 1 + 32 + 12 + 16 || bytes[0] !== SEAL_VERSION) throw new Error('open: bad blob');
  const canonical = normalizeCode(code);
  if (!isValidCode(canonical)) throw new Error('open: bad code');
  const tvPrivate = typeof tvPrivateKey === 'string' ? base64urlDecode(tvPrivateKey) : tvPrivateKey;
  if (!(tvPrivate instanceof Uint8Array) || tvPrivate.length !== 32) throw new Error('open: bad key');

  const pagePublic = bytes.slice(1, 33);
  const nonce = bytes.slice(33, 45);
  const sealedBytes = bytes.slice(45);
  const tvPublic = x25519(tvPrivate, X25519_BASE);
  const shared = x25519(tvPrivate, pagePublic);
  if (isAllZero(shared)) throw new Error('open: bad blob');
  const key = await deriveAesKey(shared, pagePublic, tvPublic, ['decrypt']);
  shared.fill(0);
  const plaintext = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(canonical), tagLength: 128 },
      key,
      sealedBytes,
    ),
  );
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    // JSON.parse's message can quote the plaintext (a password): drop it.
    throw new Error('open: bad contents');
  } finally {
    plaintext.fill(0);
  }
  if (!body || typeof body !== 'object' || body.v !== SEAL_VERSION) throw new Error('open: bad contents');
  return normalizeDetails(body);
}
