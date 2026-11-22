// @ts-check
/**
 * The phone page of "the TV signs in by scanning a code with a phone"
 * (docs/r5_status/16.md). Served at
 * https://echodisc.github.io/umbra-player/tv/#<CODE>.<TVKEY>
 *
 * Nothing is stored: no localStorage, sessionStorage or cookies. The
 * access token and the password live in this module's memory only; the
 * password is dropped the moment it is sealed, and the page's own session
 * is signed out after Connect and on Cancel.
 *
 * The Supabase URL and publishable key below are public by design (they
 * ship inside the app too). Plain fetch, no supabase-js.
 */

import { base64urlDecode, formatCode, isValidCode, normalizeCode, parseFragment, seal } from './seal.mjs';

const SUPABASE_URL = 'https://ttkjuoktaedevnapduds.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cHv1BHh4ZGfMxWFJPg8LBg_FrPXCXhQ';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/tv-sign-in`;
const TIMEOUT_MS = 20000;

const MSG = {
  noNetwork: 'No connection. Check your internet and try again.',
  wrongLogin: 'Wrong email or password.',
  codeGone: 'This code was not found or has expired. Show a new code on the TV and scan it again.',
  codeTypedNotFound: 'We could not find that code. Check the TV and type it again, or show a new code on the TV.',
  tooMany: 'Too many tries. Wait an hour and try again.',
  keyMismatch: 'This link does not belong to that TV. Scan the code on your TV again.',
  server: 'Something went wrong on our side. Try again in a moment.',
  signInAgain: 'Your sign-in has run out. Sign in again.',
  signInAgainScan: 'Your sign-in has run out. Scan the code on your TV again.',
  emailNotConfirmed: 'Confirm your email first: open the link we sent you, then scan the code on your TV again.',
  badCode: 'The code has 8 letters and numbers. Check the TV and type it again.',
  fillIn: 'Fill in your email and password.',
  fillInSignup: 'Fill in your email, a password (twice) and your access code.',
  mismatch: 'Passwords do not match.',
  accountExists: 'There is already an account with this email. Sign in instead.',
  badEmail: 'That email address does not look right.',
  signupClosed: 'New accounts cannot be made right now.',
  accessWrong: 'That access code is wrong or has already been used.',
  accessEmpty: 'Enter your access code.',
};

/** Everything the page knows, in memory only. */
const state = {
  /** @type {string | null} canonical 8-character code */
  code: null,
  /** True when the code came from the QR link (not typed). */
  codeFromLink: false,
  /** @type {string | null} the TV key the QR carried, base64url */
  linkKey: null,
  /** @type {string | null} the TV key peek answered */
  tvKey: null,
  /** @type {string | null} */
  token: null,
  /** @type {string | null} */
  userId: null,
  /** @type {string | null} kept only until it is sealed */
  password: null,
  /** @type {string | null} call name still to be written */
  pendingName: null,
  /** @type {string | null} sealed blob, kept so Connect can be retried */
  sealed: null,
  busy: false,
};

// ------------------------------------------------------------------ helpers

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const SCREENS = ['s-code', 's-signin', 's-signup', 's-activate', 's-confirm', 's-done', 's-email', 's-cancelled', 's-stop'];

/** @param {string} id @param {string} [error] */
function show(id, error) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  const box = $(id).querySelector('.error[role="alert"]');
  if (box instanceof HTMLElement && id !== 's-stop') setError(box, error);
  $('code-line').hidden = !state.code || id === 's-confirm' || id === 's-code';
  if (state.code) $('code-small').textContent = formatCode(state.code);
  const first = $(id).querySelector('input');
  if (first instanceof HTMLInputElement && !error && window.matchMedia('(min-width: 700px)').matches) first.focus();
}

/** @param {HTMLElement} box @param {string} [text] */
function setError(box, text) {
  box.textContent = text ?? '';
  box.hidden = !text;
}

/** @param {string} screen @param {string} text */
function fail(screen, text) {
  const box = $(screen).querySelector('.error[role="alert"]');
  if (box instanceof HTMLElement) setError(box, text);
}

/** A stop that ends the visit: sign out, forget the password, say why. @param {string} text */
async function stop(text) {
  forgetSecrets();
  await signOut();
  $('stop-message').textContent = text;
  show('s-stop');
}

function forgetSecrets() {
  state.password = null;
  state.sealed = null;
  for (const id of ['si-password', 'su-password', 'su-confirm']) input(id).value = '';
}

/** Disables every button while a request runs. @param {boolean} on */
function setBusy(on) {
  state.busy = on;
  for (const b of document.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = on;
}

class NetworkError extends Error {}

/**
 * One request to Supabase. Resolves {status, data} for any HTTP answer;
 * throws NetworkError when there is no answer at all.
 * @param {string} url
 * @param {{method?: string, body?: unknown, headers?: Record<string, string>, keepalive?: boolean}} [opts]
 */
async function call(url, opts = {}) {
  /** @type {Record<string, string>} */
  const headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...opts.headers };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'POST',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: opts.keepalive ?? false,
    });
  } catch {
    throw new NetworkError('no answer');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** GoTrue's error code, old or new shape. @param {any} data */
function authErrorCode(data) {
  return String(data?.error_code ?? data?.error ?? '');
}

/** @param {any} data */
function authErrorText(data) {
  return String(data?.msg ?? data?.error_description ?? data?.message ?? '');
}

// ------------------------------------------------------------------ Supabase

/** @param {any} data */
function takeSession(data) {
  state.token = data.access_token;
  state.userId = data.user?.id ?? null;
}

/** @param {string} email @param {string} password @returns {Promise<string | null>} error text or null */
async function signInWithPassword(email, password) {
  const r = await call(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { body: { email, password } });
  if (r.status === 200 && r.data?.access_token) {
    takeSession(r.data);
    return null;
  }
  const code = authErrorCode(r.data);
  if (r.status === 429) return MSG.tooMany;
  if (code === 'email_not_confirmed' || /not confirmed/i.test(authErrorText(r.data))) return MSG.emailNotConfirmed;
  if (r.status === 400 || code === 'invalid_credentials' || code === 'invalid_grant') return MSG.wrongLogin;
  return MSG.server;
}

/** @returns {Promise<boolean>} */
async function isActivated() {
  const r = await call(`${SUPABASE_URL}/rest/v1/rpc/is_activated`, { body: {} });
  if (r.status !== 200) throw new Error('is_activated');
  return r.data === true;
}

/** @param {string} accessCode @returns {Promise<'activated' | 'invalid' | 'throttled'>} */
async function redeem(accessCode) {
  const r = await call(`${SUPABASE_URL}/rest/v1/rpc/redeem_access_code`, { body: { p_code: accessCode.trim() } });
  if (r.status === 200) return r.data === true ? 'activated' : 'invalid';
  if (/too many attempts/i.test(String(r.data?.message ?? ''))) return 'throttled';
  throw new Error('redeem_access_code');
}

/** Best effort, as the app's _flushCallName: a failure never derails anything. */
async function flushCallName() {
  const name = state.pendingName;
  if (!name || !state.userId || !state.token) return;
  try {
    const r = await call(`${SUPABASE_URL}/rest/v1/accounts?id=eq.${encodeURIComponent(state.userId)}`, {
      method: 'PATCH',
      body: { call_name: name },
      headers: { Prefer: 'return=minimal' },
    });
    if (r.status >= 200 && r.status < 300) state.pendingName = null;
  } catch {
    // Network: the name can be set later in the app.
  }
}

/** Signs out only this page's session (scope=local), never the TV's. */
async function signOut() {
  if (!state.token) return;
  try {
    await call(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {});
  } catch {
    // The token runs out on its own within the hour.
  }
  state.token = null;
  state.userId = null;
}

/** @param {'peek' | 'approve'} action @param {Record<string, string>} extra */
function tvSignIn(action, extra) {
  return call(FUNCTION_URL, { body: { action, code: state.code, ...extra } });
}

/** @param {string} a @param {string} b */
function sameKey(a, b) {
  try {
    const x = base64urlDecode(a);
    const y = base64urlDecode(b);
    return x.length === 32 && y.length === 32 && x.every((v, i) => v === y[i]);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the flow

/**
 * After a session exists: activated? then peek. Errors land on [screen].
 * @param {string} screen
 */
async function proceed(screen) {
  if (!(await isActivated())) {
    show('s-activate');
    return;
  }
  await peek(screen);
}

/** @param {string} screen where an error that does not end the visit is shown */
async function peek(screen) {
  const r = await tvSignIn('peek', {});
  if (r.status === 200 && typeof r.data?.public_key === 'string') {
    if (state.linkKey && !sameKey(state.linkKey, r.data.public_key)) {
      await stop(MSG.keyMismatch);
      return;
    }
    state.tvKey = r.data.public_key;
    $('code-big').textContent = formatCode(/** @type {string} */ (state.code));
    show('s-confirm');
    return;
  }
  await handleFunctionError(r, screen, false);
}

/**
 * The function's shared error answers.
 * @param {{status: number, data: any}} r
 * @param {string} screen
 * @param {boolean} sealedAlready the password is gone, so a sign-in cannot be redone here
 */
async function handleFunctionError(r, screen, sealedAlready) {
  const error = String(r.data?.error ?? '');
  if (r.status === 404 || error === 'not_found') {
    if (state.codeFromLink || sealedAlready) {
      await stop(MSG.codeGone);
    } else {
      state.code = null;
      show('s-code', MSG.codeTypedNotFound);
    }
  } else if (r.status === 429 || error === 'too_many_tries') {
    await stop(MSG.tooMany);
  } else if (r.status === 401 || error === 'sign_in') {
    if (sealedAlready) {
      await stop(MSG.signInAgainScan);
    } else {
      state.token = null;
      state.userId = null;
      state.password = null;
      show('s-signin', MSG.signInAgain);
    }
  } else if (r.status === 403 || error === 'not_activated') {
    if (sealedAlready) await stop(MSG.signInAgainScan);
    else show('s-activate');
  } else {
    fail(screen, MSG.server);
  }
}

/**
 * Runs one user action with busy buttons and the no-network message.
 * @param {string} screen
 * @param {() => Promise<void>} work
 */
async function guarded(screen, work) {
  if (state.busy) return;
  fail(screen, '');
  setBusy(true);
  try {
    await work();
  } catch (e) {
    fail(screen, e instanceof NetworkError ? MSG.noNetwork : MSG.server);
  } finally {
    setBusy(false);
  }
}

function afterCode() {
  if (state.token) return guarded('s-code', () => peek('s-code'));
  show('s-signin');
  return undefined;
}

function onCode(/** @type {Event} */ e) {
  e.preventDefault();
  const code = normalizeCode(input('code-input').value);
  if (!isValidCode(code)) {
    fail('s-code', MSG.badCode);
    return;
  }
  state.code = code;
  state.codeFromLink = false;
  afterCode();
}

function onSignIn(/** @type {Event} */ e) {
  e.preventDefault();
  const email = input('si-email').value.trim();
  const password = input('si-password').value;
  if (!email || !password) {
    fail('s-signin', MSG.fillIn);
    return;
  }
  guarded('s-signin', async () => {
    const error = await signInWithPassword(email, password);
    if (error) {
      fail('s-signin', error);
      return;
    }
    state.password = password;
    input('si-password').value = '';
    await proceed('s-signin');
  });
}

function onSignUp(/** @type {Event} */ e) {
  e.preventDefault();
  const name = input('su-name').value.trim();
  const email = input('su-email').value.trim();
  const password = input('su-password').value;
  const confirm = input('su-confirm').value;
  const accessCode = input('su-access').value.trim();
  if (!email || !password || !confirm || !accessCode) {
    fail('s-signup', MSG.fillInSignup);
    return;
  }
  if (password !== confirm) {
    fail('s-signup', MSG.mismatch);
    return;
  }
  guarded('s-signup', async () => {
    const r = await call(`${SUPABASE_URL}/auth/v1/signup`, { body: { email, password } });
    if (r.status !== 200) {
      const code = authErrorCode(r.data);
      if (r.status === 429) fail('s-signup', MSG.tooMany);
      else if (code === 'user_already_exists' || code === 'email_exists') fail('s-signup', MSG.accountExists);
      else if (code === 'weak_password') fail('s-signup', `That password is too weak. ${authErrorText(r.data)}`.trim());
      else if (code === 'email_address_invalid' || code === 'validation_failed') fail('s-signup', MSG.badEmail);
      else if (code === 'signup_disabled') fail('s-signup', MSG.signupClosed);
      else fail('s-signup', MSG.server);
      return;
    }
    state.pendingName = name || null;
    input('su-password').value = '';
    input('su-confirm').value = '';
    if (!r.data?.access_token) {
      // Email confirmation is on: no session until the link is opened.
      forgetSecrets();
      show('s-email');
      return;
    }
    takeSession(r.data);
    state.password = password;
    await flushCallName();
    input('ac-code').value = accessCode;
    /** @type {'activated' | 'invalid' | 'throttled'} */
    let result;
    try {
      result = await redeem(accessCode);
    } catch (err) {
      // The account exists now: a retry belongs on the access-code screen.
      show('s-activate', err instanceof NetworkError ? MSG.noNetwork : MSG.server);
      return;
    }
    if (result === 'activated') {
      await flushCallName();
      await peek('s-signup');
    } else {
      show('s-activate', result === 'throttled' ? MSG.tooMany : MSG.accessWrong);
    }
  });
}

function onActivate(/** @type {Event} */ e) {
  e.preventDefault();
  const accessCode = input('ac-code').value.trim();
  if (!accessCode) {
    fail('s-activate', MSG.accessEmpty);
    return;
  }
  guarded('s-activate', async () => {
    const result = await redeem(accessCode);
    if (result === 'activated') {
      await flushCallName();
      await peek('s-activate');
    } else {
      fail('s-activate', result === 'throttled' ? MSG.tooMany : MSG.accessWrong);
    }
  });
}

function onConnect() {
  guarded('s-confirm', async () => {
    if (!state.sealed) {
      if (!state.password || !state.tvKey || !state.code) {
        await stop(MSG.signInAgainScan);
        return;
      }
      state.sealed = await seal({ password: state.password, code: state.code, tvPublicKey: state.tvKey });
      state.password = null;
    }
    const r = await tvSignIn('approve', { sealed: state.sealed });
    if (r.status === 200 && r.data?.ok === true) {
      forgetSecrets();
      await signOut();
      show('s-done');
      return;
    }
    await handleFunctionError(r, 's-confirm', true);
  });
}

function onCancel() {
  if (state.busy) return;
  setBusy(true);
  forgetSecrets();
  signOut().finally(() => {
    setBusy(false);
    show('s-cancelled');
  });
}

async function onOtherAccount() {
  if (state.busy) return;
  setBusy(true);
  forgetSecrets();
  await signOut();
  setBusy(false);
  show('s-signin');
}

// ------------------------------------------------------------------ start

function start() {
  $('f-code').addEventListener('submit', onCode);
  $('f-signin').addEventListener('submit', onSignIn);
  $('f-signup').addEventListener('submit', onSignUp);
  $('f-activate').addEventListener('submit', onActivate);
  $('connect').addEventListener('click', onConnect);
  $('cancel').addEventListener('click', onCancel);
  $('ac-other').addEventListener('click', onOtherAccount);
  $('to-signup').addEventListener('click', () => show('s-signup'));
  $('to-signin').addEventListener('click', () => show('s-signin'));
  // Leaving the page: forget the password, and end the page's session
  // if Connect never happened.
  window.addEventListener('pagehide', () => {
    state.password = null;
    if (state.token) {
      call(`${SUPABASE_URL}/auth/v1/logout?scope=local`, { keepalive: true }).catch(() => {});
      state.token = null;
    }
  });

  const fragment = parseFragment(window.location.hash);
  if (fragment) {
    state.code = fragment.code;
    state.codeFromLink = true;
    state.linkKey = fragment.tvKey ?? null;
    show('s-signin');
  } else {
    show('s-code');
  }
  if (!globalThis.crypto?.subtle) {
    // Only on a page not served over https; GitHub Pages always is.
    $('stop-message').textContent = 'This browser cannot lock the password safely here. Open the page in another browser.';
    show('s-stop');
  }
}

start();
