// @ts-check
/**
 * The password-reset page's logic, kept apart from the DOM (page.mjs) so
 * node:test can run it: supabase/tests/reset_page.test.mjs.
 *
 * The reset email links to
 *   https://echodisc.github.io/umbra-player/reset/#token_hash=<HASH>&type=recovery
 * The token works once, so it is spent only when the person presses Save,
 * never on load: a mail scanner that opens the link cannot use it up.
 *
 * Nothing is stored. The access token verify gives lives in one closure
 * and is signed out once the password is saved (or the page is left).
 * The Supabase URL and publishable key are public by design (the app and
 * site/tv/ carry them too). Plain fetch, injected; no supabase-js.
 */

export const SUPABASE_URL = 'https://ttkjuoktaedevnapduds.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_cHv1BHh4ZGfMxWFJPg8LBg_FrPXCXhQ';
export const TIMEOUT_MS = 20000;
/** The project's password minimum (Supabase Auth settings). */
export const MIN_PASSWORD_LENGTH = 6;

export const MSG = {
  typePassword: 'Type a new password.',
  tooShort: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  samePassword: 'That is your current password. Choose a new one.',
  weakPassword: 'That password is too weak.',
  badEmail: 'That email address does not look right.',
  tooMany: 'Too many tries. Wait a minute and try again.',
  noNetwork: 'No connection. Check your internet and try again.',
  server: 'Something went wrong on our side. Try again in a moment.',
};

/**
 * What fetch answers, as far as this page needs it.
 * @typedef {{status: number, text: () => Promise<string>}} ResponseLike
 */
/**
 * fetch, or the tests' stand-in for it.
 * @typedef {(url: string, init: RequestInit) => Promise<ResponseLike>} FetchLike
 */
/** @typedef {{status: number, data: any}} Answer */
/**
 * What the page does next: show a screen, or one error line on this one.
 * @typedef {{screen?: 's-done' | 's-expired' | 's-sent', email?: string, error?: string}} Outcome
 */

// ------------------------------------------------------------------ the link

/**
 * The fragment's parameters; %-escapes decoded, as supabase-js reads them.
 * @param {unknown} hash location.hash, with or without its '#'
 */
function fragmentParams(hash) {
  if (typeof hash !== 'string') return new URLSearchParams();
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/**
 * What the link carries. The hash is kept verbatim: hex, maybe with a
 * "pkce_" prefix, of any length.
 * @param {unknown} hash
 * @returns {{kind: 'recovery', tokenHash: string} | {kind: 'error'} | {kind: 'none'}}
 */
export function parseResetFragment(hash) {
  const params = fragmentParams(hash);
  const tokenHash = params.get('token_hash');
  if (tokenHash && params.get('type') === 'recovery') return { kind: 'recovery', tokenHash };
  // Supabase's own error redirect: #error=access_denied&error_code=otp_expired&…
  if (params.get('error') || params.get('error_code')) return { kind: 'error' };
  return { kind: 'none' };
}

// ------------------------------------------------------------------ checks

/**
 * A light check before sending: one '@' with something before it, a dot
 * after it with something on both sides, and no spaces. Supabase has the
 * last word.
 * @param {unknown} text
 */
export function looksLikeEmail(text) {
  return typeof text === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

/**
 * Counted as a person counts (code points). Supabase counts bytes, so a
 * password that passes here never fails its length rule there.
 * @param {string} password
 * @returns {string | null} the line to show, or null when it may be sent
 */
export function checkNewPassword(password) {
  if (!password) return MSG.typePassword;
  if (Array.from(password).length < MIN_PASSWORD_LENGTH) return MSG.tooShort;
  return null;
}

// ------------------------------------------------------------------ answers

/** GoTrue's error code, newer (error_code) or older (error) shape. @param {any} data */
export function authErrorCode(data) {
  return String(data?.error_code ?? data?.error ?? '');
}

/** GoTrue's own words, if it sent any. @param {any} data */
export function authErrorText(data) {
  for (const text of [data?.msg, data?.error_description, data?.message]) {
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
}

/** @param {number} status */
const isOk = (status) => status >= 200 && status < 300;

/** @param {Answer} r */
function isTooMany(r) {
  const code = authErrorCode(r.data);
  return r.status === 429 || code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit';
}

/**
 * Verify gave no session. A 4xx means the link is spent, expired or wrong;
 * 429 is the exception: the link is still good, so the line says wait.
 * @param {Answer} r
 * @returns {Outcome}
 */
export function verifyFailure(r) {
  if (isTooMany(r)) return { error: MSG.tooMany };
  if (r.status >= 400 && r.status < 500) return { screen: 's-expired' };
  return { error: MSG.server };
}

/**
 * PUT /user did not set the password.
 * @param {Answer} r
 * @returns {Outcome}
 */
export function updateFailure(r) {
  const code = authErrorCode(r.data);
  if (code === 'same_password') return { error: MSG.samePassword };
  if (code === 'weak_password') return { error: `${MSG.weakPassword} ${authErrorText(r.data)}`.trim() };
  if (isTooMany(r)) return { error: MSG.tooMany };
  if (r.status === 401 || r.status === 403) return { screen: 's-expired' };
  return { error: MSG.server };
}

/**
 * /recover sent no mail.
 * @param {Answer} r
 * @returns {Outcome}
 */
export function recoverFailure(r) {
  if (isTooMany(r)) return { error: MSG.tooMany };
  const code = authErrorCode(r.data);
  if (code === 'validation_failed' || code === 'email_address_invalid') return { error: MSG.badEmail };
  return { error: MSG.server };
}

// ------------------------------------------------------------------ requests

export class NetworkError extends Error {}

/**
 * One request to Supabase Auth. Resolves {status, data} for any HTTP
 * answer; throws NetworkError when there is none (or none within the
 * timeout).
 * @param {FetchLike} fetchFn
 * @param {string} path e.g. '/auth/v1/verify'
 * @param {{method?: string, body?: unknown, token?: string | null, keepalive?: boolean, timeoutMs?: number}} [opts]
 * @returns {Promise<Answer>}
 */
export async function call(fetchFn, path, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  let status;
  let text;
  try {
    const res = await fetchFn(`${SUPABASE_URL}${path}`, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: opts.keepalive ?? false,
    });
    status = res.status;
    text = await res.text();
  } catch {
    throw new NetworkError('no answer');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status, data };
}

/**
 * Save for one reset link: verify it (the first time only), set the
 * password, sign that session out. A Save that fails after verify keeps
 * the session, so pressing Save again does not spend the link again.
 * @param {{fetch: FetchLike, tokenHash: string | null, timeoutMs?: number}} deps
 */
export function createPasswordReset({ fetch: fetchFn, tokenHash, timeoutMs = TIMEOUT_MS }) {
  /** The link's token until verify spends it. @type {string | null} */
  let hash = tokenHash || null;
  /** The session verify gave: its access token only, in memory only. @type {string | null} */
  let token = null;

  /** Signs out only this page's session (scope=local); the answer does not matter. */
  async function signOut() {
    const t = token;
    token = null;
    if (!t) return;
    try {
      await call(fetchFn, '/auth/v1/logout?scope=local', { token: t, timeoutMs });
    } catch {
      // No answer: the access token runs out on its own within the hour.
    }
  }

  return {
    hasSession: () => token !== null,

    /**
     * @param {string} password as typed
     * @returns {Promise<Outcome>}
     */
    async save(password) {
      const problem = checkNewPassword(password);
      if (problem) return { error: problem };
      try {
        if (!token) {
          if (!hash) return { screen: 's-expired' };
          const v = await call(fetchFn, '/auth/v1/verify', { body: { type: 'recovery', token_hash: hash }, timeoutMs });
          const accessToken = v.data?.access_token;
          if (!isOk(v.status) || typeof accessToken !== 'string' || !accessToken) {
            /** @type {Outcome} */
            const outcome = isOk(v.status) ? { error: MSG.server } : verifyFailure(v);
            if (outcome.screen === 's-expired') hash = null;
            return outcome;
          }
          token = accessToken;
          hash = null;
        }
        const r = await call(fetchFn, '/auth/v1/user', { method: 'PUT', token, body: { password }, timeoutMs });
        if (isOk(r.status)) {
          await signOut();
          return { screen: 's-done' };
        }
        const outcome = updateFailure(r);
        if (outcome.screen === 's-expired') token = null;
        return outcome;
      } catch (e) {
        if (e instanceof NetworkError) return { error: MSG.noNetwork };
        throw e;
      }
    },

    /** Leaving the page: end a session that Save did not finish with. */
    leave() {
      const t = token;
      token = null;
      if (t) call(fetchFn, '/auth/v1/logout?scope=local', { token: t, keepalive: true, timeoutMs }).catch(() => {});
    },
  };
}

/**
 * "Send link": asks Supabase to mail a new reset link. Supabase answers
 * the same whether or not the address has an account, and so does the page.
 * @param {FetchLike} fetchFn
 * @param {string} email as typed
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Outcome>}
 */
export async function requestResetLink(fetchFn, email, { timeoutMs = TIMEOUT_MS } = {}) {
  const address = String(email ?? '').trim();
  if (!looksLikeEmail(address)) return { error: MSG.badEmail };
  try {
    const r = await call(fetchFn, '/auth/v1/recover', { body: { email: address }, timeoutMs });
    return isOk(r.status) ? { screen: 's-sent', email: address } : recoverFailure(r);
  } catch (e) {
    if (e instanceof NetworkError) return { error: MSG.noNetwork };
    throw e;
  }
}
