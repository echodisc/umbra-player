// @ts-check
/**
 * The email-confirmed page's logic, kept apart from the DOM (page.mjs) so
 * node:test can run it: supabase/tests/confirmed_page.test.mjs.
 *
 * The confirmation email links to
 *   https://echodisc.github.io/umbra-player/confirmed/#token_hash=<HASH>&type=email
 * The page confirms at once on load (nothing to type) and signs out the
 * session that gives straight away: it never stays signed in. Nothing is
 * stored. The Supabase URL and publishable key are public by design (the
 * app and site/tv/ carry them too). Plain fetch, injected; no supabase-js.
 */

export const SUPABASE_URL = 'https://ttkjuoktaedevnapduds.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_cHv1BHh4ZGfMxWFJPg8LBg_FrPXCXhQ';
export const TIMEOUT_MS = 20000;

export const MSG = {
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
 * The screen to show; 's-error' comes with its line (and a Try again).
 * @typedef {{screen: 's-ok' | 's-done' | 's-expired' | 's-error', error?: string}} Outcome
 */
/**
 * @typedef {{kind: 'verify', tokenHash: string, type: 'email' | 'signup'}
 *   | {kind: 'session', accessToken: string}
 *   | {kind: 'error'}
 *   | {kind: 'none'}} Fragment
 */

// ------------------------------------------------------------------ the link

/**
 * What the link carries. The hash is kept verbatim: hex, maybe with a
 * "pkce_" prefix, of any length.
 * @param {unknown} hash location.hash, with or without its '#'
 * @returns {Fragment}
 */
export function parseConfirmFragment(hash) {
  // %-escapes decoded, as supabase-js reads these fragments.
  const params = typeof hash === 'string' ? new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash) : new URLSearchParams();
  const tokenHash = params.get('token_hash');
  if (tokenHash) return { kind: 'verify', tokenHash, type: params.get('type') === 'signup' ? 'signup' : 'email' };
  // Supabase's own redirect after its other email links: a live session.
  const accessToken = params.get('access_token');
  if (accessToken) return { kind: 'session', accessToken };
  // Supabase's error redirect: #error=access_denied&error_code=otp_expired&…
  if (params.get('error') || params.get('error_code')) return { kind: 'error' };
  return { kind: 'none' };
}

// ------------------------------------------------------------------ answers

/** GoTrue's error code, newer (error_code) or older (error) shape. @param {any} data */
export function authErrorCode(data) {
  return String(data?.error_code ?? data?.error ?? '');
}

/** @param {number} status */
const isOk = (status) => status >= 200 && status < 300;

/**
 * Verify did not confirm. A 4xx means the link is spent, expired or wrong;
 * 429 is the exception: the link is still good, so Try again is offered.
 * @param {Answer} r
 * @returns {Outcome}
 */
export function verifyFailure(r) {
  const code = authErrorCode(r.data);
  if (r.status === 429 || code === 'over_request_rate_limit') return { screen: 's-error', error: MSG.tooMany };
  if (r.status >= 400 && r.status < 500) return { screen: 's-expired' };
  return { screen: 's-error', error: MSG.server };
}

// ------------------------------------------------------------------ requests

export class NetworkError extends Error {}

/**
 * One request to Supabase Auth. Resolves {status, data} for any HTTP
 * answer; throws NetworkError when there is none (or none within the
 * timeout).
 * @param {FetchLike} fetchFn
 * @param {string} path e.g. '/auth/v1/verify'
 * @param {{method?: string, body?: unknown, token?: string | null, timeoutMs?: number}} [opts]
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
 * Signs one session out (scope=local: only that session). Its answer does
 * not matter; with none, the access token runs out within the hour.
 * @param {FetchLike} fetchFn
 * @param {unknown} accessToken
 * @param {{timeoutMs?: number}} [opts]
 */
export async function endSession(fetchFn, accessToken, { timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof accessToken !== 'string' || !accessToken) return;
  try {
    await call(fetchFn, '/auth/v1/logout?scope=local', { token: accessToken, timeoutMs });
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
  }
}

/**
 * Confirms the address, then signs out the session verify gives. Safe to
 * run again after an error (Try again): the link is spent only by a 2xx.
 * @param {FetchLike} fetchFn
 * @param {{tokenHash: string, type: 'email' | 'signup'}} link
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Outcome>}
 */
export async function confirmEmail(fetchFn, link, { timeoutMs = TIMEOUT_MS } = {}) {
  let r;
  try {
    r = await call(fetchFn, '/auth/v1/verify', { body: { type: link.type, token_hash: link.tokenHash }, timeoutMs });
  } catch (e) {
    if (e instanceof NetworkError) return { screen: 's-error', error: MSG.noNetwork };
    throw e;
  }
  if (!isOk(r.status)) return verifyFailure(r);
  await endSession(fetchFn, r.data?.access_token, { timeoutMs });
  return { screen: 's-ok' };
}

/**
 * Everything the page does once the link is read.
 * @param {Fragment} fragment
 * @param {FetchLike} fetchFn
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Outcome>}
 */
export async function settle(fragment, fetchFn, opts = {}) {
  switch (fragment.kind) {
    case 'verify':
      return confirmEmail(fetchFn, fragment, opts);
    case 'session':
      await endSession(fetchFn, fragment.accessToken, opts);
      return { screen: 's-done' };
    case 'error':
      return { screen: 's-expired' };
    default:
      return { screen: 's-done' };
  }
}
