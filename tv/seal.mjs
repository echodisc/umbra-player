// @ts-check
/**
 * The seal for "the TV signs in by scanning a code with a phone"
 * (docs/r5_status/16.md, "The seal (page → TV)").
 *
 * The phone page seals the person's password to the TV's one-time X25519
 * public key, so the server, its database and its logs only ever see the
 * sealed blob:
 *
 *   shared = X25519(page_private, tv_public)          (all-zero refused)
 *   key    = HKDF-SHA256(ikm = shared,
 *                        salt = page_public ‖ tv_public,
 *                        info = "umbra/tv-sign-in/v1", 32 bytes)
 *   ct‖tag = AES-256-GCM(key, nonce (12 random bytes), aad = CODE,
 *                        plaintext = UTF-8 JSON {"v":1,"pw":"<password>"})
 *   blob   = base64url-no-padding(0x01 ‖ page_public ‖ nonce ‖ ct ‖ tag)
 *            at most 2,048 characters.
 *
 * Web APIs only (crypto.subtle, crypto.getRandomValues, TextEncoder,
 * BigInt), so the same file runs in iOS Safari 15+, Android Chrome,
 * Samsung Internet and Node 24 (the tests import it directly).
 *
 * X25519 is done here in BigInt rather than through WebCrypto because
 * WebCrypto's X25519 is missing on the older phones this page must serve.
 */

/** Crockford alphabet, as lib/features/pairing/pairing_code.dart. */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const SEAL_VERSION = 1;
export const SEAL_INFO = 'umbra/tv-sign-in/v1';
export const MAX_SEALED_LENGTH = 2048;

const enc = new TextEncoder();

// ---------------------------------------------------------------- base64url

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** @type {Record<string, number>} */
const B64U_LOOKUP = {};
for (let i = 0; i < B64U.length; i++) B64U_LOOKUP[B64U[i]] = i;

/**
 * base64url without padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64urlEncode(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63] + B64U[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64U[(n >> 18) & 63] + B64U[(n >> 12) & 63] + B64U[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict base64url decoding: no padding, no other alphabet, no stray bits
 * (so one byte string has exactly one spelling). Throws on anything else.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function base64urlDecode(text) {
  if (typeof text !== 'string') throw new TypeError('base64url: not a string');
  if (text.length % 4 === 1) throw new Error('base64url: bad length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < text.length; i++) {
    const v = B64U_LOOKUP[text[i]];
    if (v === undefined) throw new Error('base64url: bad character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new Error('base64url: stray bits');
  return out;
}

// --------------------------------------------------------------------- code

/** @type {Record<string, string>} */
const AMBIGUOUS = { O: '0', I: '1', L: '1' };

/**
 * Folds typed input into the canonical code, exactly as the app's
 * normalizePairingCode: uppercase, ambiguous glyphs mapped (O→0, I/L→1),
 * anything not in the alphabet (spaces, dashes…) dropped. Never throws.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw.toUpperCase()) {
    const mapped = AMBIGUOUS[ch] ?? ch;
    if (CODE_ALPHABET.includes(mapped)) out += mapped;
  }
  return out;
}

/**
 * True only for an already-normalized code of the right length.
 * @param {string} code
 */
export function isValidCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * `ABCD EFGH`, as the TV shows it.
 * @param {string} code
 */
export function formatCode(code) {
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}

/**
 * Reads the QR link's fragment `#<CODE>.<TVKEY>`.
 * Returns {code, tvKey} (tvKey: the 43-character base64url public key as
 * given), {code} when the fragment holds only a code, or null when there
 * is no usable code or the key part is damaged (the page then asks for
 * the code by hand, which is the same trust as a code with no key).
 * @param {unknown} hash
 * @returns {{code: string, tvKey?: string} | null}
 */
export function parseFragment(hash) {
  if (typeof hash !== 'string') return null;
  let text = hash.trim();
  if (text.startsWith('#')) text = text.slice(1);
  if (!text) return null;
  const dot = text.indexOf('.');
  const codePart = dot === -1 ? text : text.slice(0, dot);
  const code = normalizeCode(codePart);
  if (!isValidCode(code)) return null;
  if (dot === -1) return { code };
  const tvKey = text.slice(dot + 1);
  if (tvKey.length !== 43) return null;
  try {
    if (base64urlDecode(tvKey).length !== 32) return null;
  } catch {
    return null;
  }
  return { code, tvKey };
}

// ------------------------------------------------------------------- X25519
//
// RFC 7748 §5: Montgomery ladder over p = 2^255 − 19 with BigInt.
//
// This is NOT constant time (BigInt arithmetic and the branchy swap leak
// timing). That does not matter here: the page's key pair is made fresh
// for one seal, used once in this page's own memory, and thrown away, so
// there is nothing for a timing observer to accumulate. Do not reuse this
// for long-lived keys.

const P = (1n << 255n) - 19n;
const A24 = 121665n;

/** @param {bigint} a */
function mod(a) {
  const r = a % P;
  return r < 0n ? r + P : r;
}

/** @param {bigint} base @param {bigint} exp */
function modPow(base, exp) {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** @param {Uint8Array} bytes little-endian */
function leToBig(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** @param {bigint} n */
function bigToLe32(n) {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** decodeScalar25519: clamp, little-endian. @param {Uint8Array} k */
function decodeScalar(k) {
  const c = Uint8Array.from(k);
  c[0] &= 248;
  c[31] &= 127;
  c[31] |= 64;
  return leToBig(c);
}

/** decodeUCoordinate: mask the top bit; non-canonical values reduce mod p. @param {Uint8Array} u */
function decodeU(u) {
  const c = Uint8Array.from(u);
  c[31] &= 127;
  return mod(leToBig(c));
}

/** The base point u = 9. */
export const X25519_BASE = (() => {
  const b = new Uint8Array(32);
  b[0] = 9;
  return b;
})();

/**
 * X25519(k, u) per RFC 7748 §5.
 * @param {Uint8Array} scalar 32 bytes
 * @param {Uint8Array} uCoordinate 32 bytes
 * @returns {Uint8Array} 32 bytes
 */
export function x25519(scalar, uCoordinate) {
  if (!(scalar instanceof Uint8Array) || scalar.length !== 32) throw new Error('x25519: scalar must be 32 bytes');
  if (!(uCoordinate instanceof Uint8Array) || uCoordinate.length !== 32) throw new Error('x25519: u must be 32 bytes');
  const k = decodeScalar(scalar);
  const x1 = decodeU(uCoordinate);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;
  for (let t = 254n; t >= 0n; t--) {
    const kt = (k >> t) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;
    const A = mod(x2 + z2);
    const AA = (A * A) % P;
    const B = mod(x2 - z2);
    const BB = (B * B) % P;
    const E = mod(AA - BB);
    const C = mod(x3 + z3);
    const D = mod(x3 - z3);
    const DA = (D * A) % P;
    const CB = (C * B) % P;
    const s = mod(DA + CB);
    x3 = (s * s) % P;
    const d = mod(DA - CB);
    z3 = (x1 * ((d * d) % P)) % P;
    x2 = (AA * BB) % P;
    z2 = (E * mod(AA + A24 * E)) % P;
  }
  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  return bigToLe32((x2 * modPow(z2, P - 2n)) % P);
}

/**
 * A key pair from 32 random bytes (or the given ones, for tests).
 * @param {(n: number) => Uint8Array} [randomBytes]
 */
export function generateKeyPair(randomBytes) {
  const privateKey = Uint8Array.from((randomBytes ?? defaultRandomBytes)(32));
  if (privateKey.length !== 32) throw new Error('randomBytes gave the wrong length');
  return { privateKey, publicKey: x25519(privateKey, X25519_BASE) };
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
 * Seals the password to the TV's public key. Returns the blob (string).
 * `randomBytes` is for deterministic test vectors ONLY: it is asked first
 * for the page's 32-byte private key, then for the 12-byte nonce.
 * @param {{password: string, code: string, tvPublicKey: Uint8Array | string,
 *          randomBytes?: (n: number) => Uint8Array}} args
 * @returns {Promise<string>}
 */
export async function seal({ password, code, tvPublicKey, randomBytes }) {
  if (typeof password !== 'string' || password.length === 0) throw new Error('seal: no password');
  const canonical = normalizeCode(code);
  if (!isValidCode(canonical)) throw new Error('seal: bad code');
  const tvPublic = publicKeyBytes(tvPublicKey);
  const rand = randomBytes ?? defaultRandomBytes;

  const { privateKey: pagePrivate, publicKey: pagePublic } = generateKeyPair(rand);
  const shared = x25519(pagePrivate, tvPublic);
  pagePrivate.fill(0);
  if (isAllZero(shared)) throw new Error('seal: the TV key is not usable');

  const key = await deriveAesKey(shared, pagePublic, tvPublic, ['encrypt']);
  shared.fill(0);
  const nonce = Uint8Array.from(rand(12));
  if (nonce.length !== 12) throw new Error('randomBytes gave the wrong length');
  const plaintext = enc.encode(JSON.stringify({ v: SEAL_VERSION, pw: password }));
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
  if (blob.length > MAX_SEALED_LENGTH) throw new Error('seal: the password is too long to send');
  return blob;
}

/**
 * Opens a blob with the TV's private key (the TV side; used by the tests).
 * Returns the password. Throws on any mismatch (wrong code, wrong key,
 * changed byte, wrong version).
 * @param {{sealed: string, code: string, tvPrivateKey: Uint8Array | string}} args
 * @returns {Promise<string>}
 */
export async function open({ sealed, code, tvPrivateKey }) {
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
  const plaintext = new Uint8Array(
    await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(canonical), tagLength: 128 },
      key,
      sealedBytes,
    ),
  );
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  plaintext.fill(0);
  if (!body || body.v !== SEAL_VERSION || typeof body.pw !== 'string') throw new Error('open: bad contents');
  return body.pw;
}
