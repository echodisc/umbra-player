// @ts-check
/**
 * The page the confirmation email links to:
 *   https://echodisc.github.io/umbra-player/confirmed/#token_hash=<HASH>&type=email
 * It confirms at once on load (nothing to type) and never stays signed in.
 *
 * This file is the DOM only; the link and every request are in
 * confirmed.mjs. The link is read once and taken out of the address bar.
 * Nothing is stored.
 */

import { MSG, parseConfirmFragment, settle } from './confirmed.mjs';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const SCREENS = ['s-working', 's-ok', 's-done', 's-expired', 's-error'];

/** @param {string} id */
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
}

/** fetch called as a plain function: a bare reference would lose its window. @type {import('./confirmed.mjs').FetchLike} */
const net = (url, init) => fetch(url, init);

// Read the link once, then take it out of the address bar and the history.
const fragment = parseConfirmFragment(location.hash);
try {
  history.replaceState(null, '', location.pathname);
} catch {
  // Not allowed here (a file: page, say): the page works without it.
}

let busy = false;

/** Confirms (or tidies up), then shows how it went. Try again runs it again. */
async function run() {
  if (busy) return;
  busy = true;
  show('s-working');
  /** @type {import('./confirmed.mjs').Outcome} */
  let outcome;
  try {
    outcome = await settle(fragment, net);
  } catch {
    outcome = { screen: 's-error', error: MSG.server };
  }
  $('error-message').textContent = outcome.error ?? '';
  show(outcome.screen);
  busy = false;
}

$('again').addEventListener('click', () => run());
// A new link opened in this tab changes only the fragment, which does not
// reload the page: reload, so it is read like the first one.
window.addEventListener('hashchange', () => location.reload());
run();
