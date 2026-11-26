// @ts-check
/**
 * A whole provider link pasted into the add page (site/add/), split into
 * the Xtream details the TV needs:
 *
 *   http://cf.example.com:8080/get.php?username=anna&password=s3cret&type=m3u_plus
 *     → { server: 'http://cf.example.com:8080', user: 'anna', pass: 's3cret' }
 *
 * The page's copy of the app's rule for a pasted link: XtreamConfig
 * .tryParseGetPhpUrl (lib/sources/source.dart), as the Add playlist form
 * uses it (lib/features/sources/add_source_screen.dart, _onServerPasted,
 * and normalizeServerBase for the server part):
 *
 * - the path ends in get.php, as in the app, or in player_api.php (the
 *   same login, given as the Xtream API's own address);
 * - username= and password= are both there and not empty, decoded; when
 *   one is there twice the last one counts, as with Dart's queryParameters;
 * - the server is the scheme, the host and a port that is not the scheme's
 *   own, nothing else: what normalizeServerBase makes of such a link.
 *
 * Where the app would make no usable server of a link this answers null
 * instead: a scheme other than http or https, or no host. A link pasted
 * without any scheme gets http:// in front, the forgiveness the app's
 * server field has always had.
 *
 * Pure: no page, no network. Anything else gives null.
 */

/** The path endings that carry an Xtream login in their query. */
const ENDPOINTS = ['get.php', 'player_api.php'];

/** `name://` at the start: the text says its own scheme. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The last value given for a name, or '' when there is none.
 * @param {URLSearchParams} params
 * @param {string} name
 */
function lastValue(params, name) {
  const all = params.getAll(name);
  return all.length === 0 ? '' : all[all.length - 1];
}

/**
 * @param {unknown} text what was pasted or typed into an address field
 * @returns {{server: string, user: string, pass: string} | null}
 */
export function splitProviderLink(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  /** @type {URL} */
  let url;
  try {
    url = new URL(HAS_SCHEME.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  if (!ENDPOINTS.some((ending) => url.pathname.endsWith(ending))) return null;
  const user = lastValue(url.searchParams, 'username');
  const pass = lastValue(url.searchParams, 'password');
  if (!user || !pass) return null;
  // url.host holds the port only when it is not the scheme's own (80, 443).
  return { server: `${url.protocol}//${url.host}`, user, pass };
}
