// @ts-check
/**
 * The page the password-reset email links to:
 *   https://echodisc.github.io/umbra-player/reset/#token_hash=<HASH>&type=recovery
 * Opened without that link, it asks for an email and sends a new one.
 *
 * This file is the DOM only; the link, the checks and every request are in
 * reset.mjs. The link is read once and taken out of the address bar; it
 * is spent only when Save is pressed, never on load. Nothing is stored.
 */

import { createPasswordReset, MSG, parseResetFragment, requestResetLink } from './reset.mjs';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
/** @param {string} id */
const input = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id));

const SCREENS = ['s-set', 's-done', 's-expired', 's-request', 's-sent'];
/** @type {Record<string, string>} each form's error line */
const ERROR_LINE = { 's-set': 'set-error', 's-request': 'request-error' };
/** @type {Record<string, string>} each form's field */
const FIELD = { 's-set': 'new-password', 's-request': 'email' };

let busy = false;

/** @param {string} id */
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  fail(id, '');
  // Wide screens only: on a phone, focus would pop the keyboard up over the page.
  if (FIELD[id] && window.matchMedia('(min-width: 700px)').matches) input(FIELD[id]).focus();
}

/** @param {string} screen @param {string} text */
function fail(screen, text) {
  if (!ERROR_LINE[screen]) return;
  const line = $(ERROR_LINE[screen]);
  line.textContent = text;
  line.hidden = !text;
}

/** The password starts hidden; Show / Hide sits inside the field. @param {boolean} on */
function setRevealed(on) {
  input('new-password').type = on ? 'text' : 'password';
  const button = $('reveal');
  button.textContent = on ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', on ? 'Hide password' : 'Show password');
}

/** Disables every button while a request runs. @param {boolean} on */
function setBusy(on) {
  busy = on;
  for (const b of document.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (b).disabled = on;
}

/**
 * Runs one press of a form's button. The requests turn their own failures
 * into lines; anything else lands as the generic one.
 * @param {string} screen
 * @param {() => Promise<void>} work
 */
async function guarded(screen, work) {
  if (busy) return;
  fail(screen, '');
  setBusy(true);
  try {
    await work();
  } catch {
    fail(screen, MSG.server);
  } finally {
    setBusy(false);
  }
}

/** fetch called as a plain function: a bare reference would lose its window. @type {import('./reset.mjs').FetchLike} */
const net = (url, init) => fetch(url, init);

// Read the link once, then take it out of the address bar and the history.
const fragment = parseResetFragment(location.hash);
try {
  history.replaceState(null, '', location.pathname);
} catch {
  // Not allowed here (a file: page, say): the page works without it.
}

const reset = createPasswordReset({ fetch: net, tokenHash: fragment.kind === 'recovery' ? fragment.tokenHash : null });

/** @param {Event} event */
function onSave(event) {
  event.preventDefault();
  return guarded('s-set', async () => {
    const field = input('new-password');
    const outcome = await reset.save(field.value);
    if (outcome.screen) {
      field.value = '';
      setRevealed(false);
      show(outcome.screen);
    } else {
      fail('s-set', outcome.error ?? MSG.server);
    }
  });
}

/** @param {Event} event */
function onSend(event) {
  event.preventDefault();
  return guarded('s-request', async () => {
    const outcome = await requestResetLink(net, input('email').value);
    if (outcome.screen === 's-sent') {
      $('sent-email').textContent = outcome.email ?? '';
      show('s-sent');
    } else {
      fail('s-request', outcome.error ?? MSG.server);
    }
  });
}

$('f-set').addEventListener('submit', onSave);
$('f-request').addEventListener('submit', onSend);
$('reveal').addEventListener('click', () => setRevealed(input('new-password').type === 'password'));
$('new-link').addEventListener('click', () => show('s-request'));
// Leaving the page: end a session a failed Save left behind.
window.addEventListener('pagehide', () => reset.leave());
// A new link opened in this tab changes only the fragment, which does not
// reload the page: reload, so it is read like the first one.
window.addEventListener('hashchange', () => location.reload());

if (fragment.kind === 'recovery') show('s-set');
else if (fragment.kind === 'error') show('s-expired');
else show('s-request');
