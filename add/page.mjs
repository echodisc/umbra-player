// @ts-check
/**
 * The phone page of "add a playlist to the TV from a phone"
 * (docs/r5_status/22.md). Served at
 *   https://echodisc.github.io/umbra-player/add/#<CODE>.<TVKEY>
 * The TV shows that address as a QR code. Opened without the part after
 * #, the page asks for the code first.
 *
 * The person pastes the details their provider gave them (an Xtream
 * server, user name and password, or an M3U playlist address). The page
 * seals them to the TV's key (./seal.mjs) and hands the sealed blob to the
 * function tv-add-playlist, which relays it to the TV. The page makes only
 * that function's two calls, peek {code} and send {code, sealed}, with no
 * login.
 *
 * Nothing is kept in the browser: no web storage, no cookies, nothing
 * written into the address bar. The details live only in the form's
 * fields while the page is open, so "Change something and send again" can
 * send them once more. The page holds no channel, no list and no hint of
 * where to get one.
 *
 * The Supabase URL and publishable key below are public by design, the
 * same as site/tv/page.mjs's. Plain fetch, no supabase-js.
 */

import {
  DetailsError,
  base64urlDecode,
  formatCode,
  isValidCode,
  normalizeCode,
  normalizeDetails,
  parseFragment,
  sealPlaylist,
} from './seal.mjs';
import { splitProviderLink } from './link.mjs';

const SUPABASE_URL = 'https://ttkjuoktaedevnapduds.supabase.co';
const SUPABASE_KEY = 'sb_publishable_cHv1BHh4ZGfMxWFJPg8LBg_FrPXCXhQ';
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/tv-add-playlist`;
const TIMEOUT_MS = 20000;

const MSG = {
  noNetwork: "No connection. Check your phone's internet and try again.",
  server: 'Something went wrong on our side. Try again in a moment.',
  tooMany: 'Too many tries. Wait a while and try again.',
  busy: 'Your TV is still opening the last one. Try again in a moment.',
  badCode: 'The code has 8 letters and numbers. Check your TV and type it again.',
  codeNotFound: 'We could not find that code. Check your TV and type it again.',
  tooLong: 'This is too long.',
  badCharacters: 'This has a character that cannot be sent.',
  scheme: 'This needs http:// or https:// at the start.',
};

/** A field left empty. @type {Record<string, string>} */
const MISSING = {
  server: 'Paste the server address.',
  user: 'Type the user name.',
  pass: 'Type the password.',
  url: 'Paste the playlist address.',
};

/** The screens that end the visit: a heading, one line, a picture. */
const STOPS = {
  ended: { title: 'This code has ended', line: 'Look at your TV. If it shows a new code, scan it again.', icon: 'clock' },
  mismatch: { title: 'This code does not belong to that TV', line: 'Nothing was sent. Scan the code on your TV again.', icon: 'alert' },
  tooMany: { title: 'Too many tries', line: 'Wait a while and try again.', icon: 'clock' },
  browser: { title: 'This page needs a newer browser', line: 'Open it in another browser, or type the details on your TV instead.', icon: 'alert' },
  framed: { title: 'Open this page on its own', line: 'Scan the code on your TV again, or type the address into your browser.', icon: 'alert' },
};

/** The fields each kind sends, in page order. @type {Record<string, string[]>} */
const FIELDS = { xtream: ['server', 'user', 'pass'], m3u: ['url'] };
/** Each field's input; its line is the input's id + "-error". @type {Record<string, string>} */
const FIELD_INPUT = { server: 'xt-server', user: 'xt-user', pass: 'xt-pass', url: 'm3u-url' };

/** The two buttons that wait for an answer: their words idle and busy. @type {Record<string, [string, string]>} */
const BUSY_LABEL = { 'code-go': ['Continue', 'Checking…'], 'add-go': ['Add to my TV', 'Sending…'] };

const SCREENS = ['s-check', 's-code', 's-form', 's-sent', 's-stop'];

/** Everything the page knows besides the fields, in memory only. */
const state = {
  /** @type {string | null} the canonical 8-character code */
  code: null,
  /** @type {string | null} the TV key the QR carried, base64url */
  linkKey: null,
  /** @type {string | null} the key the details are sealed to */
  tvKey: null,
  /** @type {'xtream' | 'm3u'} */
  kind: 'xtream',
  busy: false,
};

// ------------------------------------------------------------------ helpers

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

/** @param {string} id */
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  // A long form may have been scrolled; every screen starts at its top.
  if (typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}

/** One line under a field or a button: text shows it, '' hides it. @param {string} id @param {string} text */
function setLine(id, text) {
  const line = $(id);
  line.textContent = text;
  line.hidden = !text;
}

/** @param {keyof typeof STOPS} reason */
function stop(reason) {
  const { title, line, icon } = STOPS[reason];
  $('stop-title').textContent = title;
  $('stop-line').textContent = line;
  $('stop-clock').hidden = icon !== 'clock';
  $('stop-alert').hidden = icon !== 'alert';
  show('s-stop');
}

/** Disables every button while a request runs. @param {boolean} on */
function setBusy(on) {
  state.busy = on;
  for (const b of document.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = on;
}

/** The password starts hidden; Show / Hide sits inside the field. @param {boolean} on */
function setRevealed(on) {
  input('xt-pass').type = on ? 'text' : 'password';
  const button = $('xt-reveal');
  button.textContent = on ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
}

/** @param {'xtream' | 'm3u'} kind */
function selectKind(kind) {
  state.kind = kind;
  $('kind-xtream').setAttribute('aria-pressed', String(kind === 'xtream'));
  $('kind-m3u').setAttribute('aria-pressed', String(kind === 'm3u'));
  $('xt-fields').hidden = kind !== 'xtream';
  $('m3u-fields').hidden = kind !== 'm3u';
}

/** A field's own line: text shows it, nothing hides it. @param {string} field @param {string} [text] */
function setFieldLine(field, text) {
  const id = FIELD_INPUT[field];
  if (!id) {
    // Not a field of the form (normalizeDetails' "kind"): cannot happen from this page.
    setLine('add-error', text ? MSG.server : '');
    return;
  }
  setLine(`${id}-error`, text ?? '');
  input(id).setAttribute('aria-invalid', String(Boolean(text)));
}

class NetworkError extends Error {}

/**
 * One call to the function. Resolves {status, data} for any HTTP answer;
 * throws NetworkError when there is no answer at all, or none within
 * TIMEOUT_MS.
 * @param {{action: string, code: string, sealed?: string}} body
 * @returns {Promise<{status: number, data: any}>}
 */
async function call(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch {
    throw new NetworkError('no answer');
  } finally {
    clearTimeout(timer);
  }
}

/** A TV key as the seal takes it: base64url of 32 bytes. @param {unknown} key */
function isKey(key) {
  try {
    return typeof key === 'string' && base64urlDecode(key).length === 32;
  } catch {
    return false;
  }
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

/**
 * What a peek answer means.
 * @param {{status: number, data: any}} r
 * @returns {{outcome: 'live', key: string} | {outcome: 'ended' | 'tooMany' | 'failed'}}
 */
function readPeek(r) {
  const data = r.data;
  if (r.status === 200 && data && isKey(data.public_key)) {
    if (typeof data.expires_in === 'number' && data.expires_in <= 0) return { outcome: 'ended' };
    return { outcome: 'live', key: data.public_key };
  }
  if (r.status === 404) return { outcome: 'ended' };
  if (r.status === 429) return { outcome: 'tooMany' };
  return { outcome: 'failed' };
}

/**
 * Runs one press of a button that waits for an answer: the button is busy
 * and every button is off until it ends, so nothing is sent twice. A call
 * with no answer lands as the no-connection line, anything else unexpected
 * as the generic one.
 * @param {string} buttonId
 * @param {string} lineId
 * @param {() => Promise<void>} work
 */
async function run(buttonId, lineId, work) {
  if (state.busy) return;
  const [idle, busy] = BUSY_LABEL[buttonId];
  const button = $(buttonId);
  setLine(lineId, '');
  setBusy(true);
  button.textContent = busy;
  button.setAttribute('aria-busy', 'true');
  try {
    await work();
  } catch (err) {
    setLine(lineId, err instanceof NetworkError ? MSG.noNetwork : MSG.server);
  } finally {
    button.textContent = idle;
    button.setAttribute('aria-busy', 'false');
    setBusy(false);
  }
}

// ------------------------------------------------------------------ the details

/** The chosen kind's fields as typed; seal.mjs trims them. */
function readDetails() {
  if (state.kind === 'xtream') {
    return { kind: 'xtream', server: input('xt-server').value, user: input('xt-user').value, pass: input('xt-pass').value };
  }
  return { kind: 'm3u', url: input('m3u-url').value };
}

/**
 * Whether the TV can use this address, as the app's own form takes it
 * (lib/features/sources/add_source_screen.dart). A server may leave out
 * http://: normalizeServerBase puts it in front of anything that does not
 * start with "http". Any other start ("ftp://", "http:/", "HTTP://") gives
 * the app no server. A playlist address is fetched as it is, so it needs
 * http:// or https://.
 * @param {string} field
 * @param {string} value trimmed, not empty
 */
function addressAccepted(field, value) {
  if (field === 'url') return /^https?:\/\//i.test(value);
  if (/^https?:\/\//.test(value)) return true;
  return !value.startsWith('http') && !value.includes('://');
}

/** @param {string} field @param {string} reason a DetailsError's */
function reasonText(field, reason) {
  if (reason === 'missing') return MISSING[field] ?? MSG.server;
  if (reason === 'too_long') return MSG.tooLong;
  if (reason === 'bad_characters') return MSG.badCharacters;
  return MSG.server;
}

/**
 * Every field of the chosen kind that cannot be sent, with its line, in
 * page order. Each field is checked alone by seal.mjs's own
 * normalizeDetails (the kind's other fields given a stand-in), so the
 * rules are seal.mjs's, not a copy of them.
 * @param {Record<string, string>} details
 * @returns {Map<string, string>}
 */
function fieldProblems(details) {
  /** @type {Map<string, string>} */
  const problems = new Map();
  const fields = FIELDS[details.kind];
  for (const field of fields) {
    /** @type {Record<string, string>} */
    const alone = { kind: details.kind };
    for (const f of fields) alone[f] = f === field ? details[f] : 'x';
    try {
      normalizeDetails(alone);
    } catch (err) {
      if (!(err instanceof DetailsError)) throw err;
      problems.set(field, reasonText(field, err.reason));
      continue;
    }
    if ((field === 'server' || field === 'url') && !addressAccepted(field, details[field].trim())) {
      problems.set(field, MSG.scheme);
    }
  }
  return problems;
}

/**
 * A whole provider link pasted or typed into an address field fills the
 * Xtream fields, as the app's form does (link.mjs).
 * @param {string} id the field it landed in
 */
function onAddressInput(id) {
  const parts = splitProviderLink(input(id).value);
  if (!parts) return;
  input('xt-server').value = parts.server;
  input('xt-user').value = parts.user;
  input('xt-pass').value = parts.pass;
  for (const field of FIELDS.xtream) setFieldLine(field);
  selectKind('xtream');
  $('xt-split').hidden = false;
}

// ------------------------------------------------------------------ the flow

/** @param {string} key the key the details will be sealed to */
function openForm(key) {
  state.tvKey = key;
  $('form-code').textContent = formatCode(/** @type {string} */ (state.code));
  show('s-form');
}

/** The QR's code: peek, check the TV's key against the server's, then the form. */
async function checkLink() {
  if (state.busy) return;
  setBusy(true);
  $('check-status').hidden = false;
  $('check-again').hidden = true;
  setLine('check-error', '');
  show('s-check');
  let failure = MSG.server;
  /** @type {ReturnType<typeof readPeek> | null} */
  let peek = null;
  try {
    peek = readPeek(await call({ action: 'peek', code: /** @type {string} */ (state.code) }));
  } catch (err) {
    if (err instanceof NetworkError) failure = MSG.noNetwork;
  } finally {
    setBusy(false);
  }
  if (peek?.outcome === 'live') {
    if (state.linkKey && !sameKey(state.linkKey, peek.key)) stop('mismatch');
    else openForm(state.linkKey ?? peek.key);
  } else if (peek?.outcome === 'ended') {
    stop('ended');
  } else if (peek?.outcome === 'tooMany') {
    stop('tooMany');
  } else {
    $('check-status').hidden = true;
    setLine('check-error', failure);
    $('check-again').hidden = false;
  }
}

/** A typed code: folded, peeked; the details are then sealed to the server's key. @param {Event} event */
function onCode(event) {
  event.preventDefault();
  if (state.busy) return undefined;
  const code = normalizeCode(input('code-input').value);
  if (!isValidCode(code)) {
    setLine('code-error', MSG.badCode);
    return undefined;
  }
  return run('code-go', 'code-error', async () => {
    const peek = readPeek(await call({ action: 'peek', code }));
    if (peek.outcome === 'live') {
      state.code = code;
      state.linkKey = null;
      openForm(peek.key);
    } else if (peek.outcome === 'ended') {
      setLine('code-error', MSG.codeNotFound);
    } else if (peek.outcome === 'tooMany') {
      stop('tooMany');
    } else {
      setLine('code-error', MSG.server);
    }
  });
}

/** "Add to my TV": check, seal, send. @param {Event} event */
function onAdd(event) {
  event.preventDefault();
  if (state.busy) return undefined;
  $('xt-split').hidden = true;
  setLine('add-error', '');
  const details = readDetails();
  const problems = fieldProblems(details);
  for (const field of FIELDS[details.kind]) setFieldLine(field, problems.get(field));
  const first = problems.keys().next();
  if (!first.done) {
    input(FIELD_INPUT[first.value]).focus();
    return undefined;
  }
  const code = /** @type {string} */ (state.code);
  const tvPublicKey = /** @type {string} */ (state.tvKey);
  return run('add-go', 'add-error', async () => {
    /** @type {string} */
    let sealed;
    try {
      sealed = await sealPlaylist({ details, code, tvPublicKey });
    } catch (err) {
      // All of it together too long to send (seal.mjs's 5,000 bytes).
      if (!(err instanceof DetailsError)) throw err;
      setFieldLine(err.field, reasonText(err.field, err.reason));
      return;
    }
    const r = await call({ action: 'send', code, sealed });
    if (r.status === 200 && r.data?.ok === true) show('s-sent');
    else if (r.status === 404) stop('ended');
    else if (r.status === 409) setLine('add-error', MSG.busy);
    else if (r.status === 429) setLine('add-error', MSG.tooMany);
    else setLine('add-error', MSG.server);
  });
}

// ------------------------------------------------------------------ start

/**
 * True when another page holds this one in a frame, or when that cannot be
 * told (a top window of another site may throw on being compared).
 */
function isFramed() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

function start() {
  // A meta CSP cannot set frame-ancestors and GitHub Pages sends no
  // X-Frame-Options, so any site could frame this page around its own
  // code. Inside a frame: stop first, before any call and any listener.
  if (isFramed()) {
    stop('framed');
    return;
  }

  // A new QR scanned into this tab changes only the part after #, which
  // does not load the page again: load it, so the new code is read.
  window.addEventListener('hashchange', () => location.reload());

  if (!globalThis.crypto?.subtle) {
    // Only on a page not served over https, or a very old browser.
    stop('browser');
    return;
  }

  $('f-code').addEventListener('submit', onCode);
  $('f-add').addEventListener('submit', onAdd);
  $('check-again').addEventListener('click', () => checkLink());
  $('send-again').addEventListener('click', () => show('s-form'));
  $('xt-reveal').addEventListener('click', () => setRevealed(input('xt-pass').type === 'password'));
  for (const kind of /** @type {const} */ (['xtream', 'm3u'])) {
    $(`kind-${kind}`).addEventListener('click', () => {
      if (state.busy) return;
      selectKind(kind);
      $('xt-split').hidden = true;
    });
  }
  for (const [field, id] of Object.entries(FIELD_INPUT)) {
    input(id).addEventListener('input', () => setFieldLine(field));
  }
  for (const id of ['xt-server', 'm3u-url']) input(id).addEventListener('input', () => onAddressInput(id));
  input('code-input').addEventListener('input', () => setLine('code-error', ''));

  const fragment = parseFragment(location.hash);
  if (fragment) {
    state.code = fragment.code;
    state.linkKey = fragment.tvKey ?? null;
    checkLink();
  } else {
    show('s-code');
  }
}

start();
