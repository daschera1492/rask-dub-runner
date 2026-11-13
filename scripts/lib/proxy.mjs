/**
 * Egress providers, shared by the Rask account pool and the source download.
 *
 * One switch, three exits:
 *
 *   PROXY_ENABLED=none      every request leaves from the runner's own IP
 *   PROXY_ENABLED=oxylabs   Oxylabs residential, one sticky exit per account
 *   PROXY_ENABLED=firefox   the Firefox (Mozilla) VPN core on loopback
 *   PROXY_ENABLED=auto      Oxylabs when PROXY_OXYLABS is set, else Firefox
 *                           when its credentials exist, else direct
 *
 * The old boolean values keep working (`true`/`1` is `auto`, `false`/`0` is
 * `none`), so an existing run does not change behaviour when the new secret
 * is absent.
 *
 * Firefox VPN is the replacement for the YouTube cookie jar: `awmvpn-core`
 * (started by `.github/actions/setup-firefox-vpn`) listens on 127.0.0.1 and
 * serves both SOCKS5 and HTTP CONNECT, so the same `withProxy` machinery and
 * the same per-account sticky-IP contract apply. yt-dlp is handed the same
 * exit with `--proxy`, and no cookie is ever sent to YouTube.
 *
 * Oxylabs secret format (unchanged):
 *
 *   PROXY_OXYLABS = pr.oxylabs.io:7777:customer-resi_<ID>:<PASSWORD>
 */

import crypto from 'node:crypto';

const env = process.env;

/** host:port:user:pass — the password may itself contain ':'. */
function parseOxySpec(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return null;

  if (/^[a-z]+:\/\//i.test(raw)) {
    const u = new URL(raw);
    const port = Number(u.port || 7777);
    return {
      host: u.hostname,
      port,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  }

  const parts = raw.split(':');
  if (parts.length < 4) return null;
  const host = parts.shift();
  const port = Number(parts.shift());
  const password = parts.pop();
  const username = parts.join(':');
  if (!host || !port || !username) return null;
  return { host, port, username, password };
}

/** Parsed on every call so a test (or a late GITHUB_ENV write) can change it. */
const oxySpec = () => parseOxySpec(env.PROXY_OXYLABS || env.OXYLABS_PROXY || env.PROXY_URL || '');

const SWITCH = () => String(env.PROXY_ENABLED ?? env.USE_PROXY ?? '').trim().toLowerCase();
const OFF_VALUES = ['0', 'false', 'off', 'no', 'none', 'disabled', 'direct'];
const FORCED = {
  oxylabs: 'oxylabs',
  oxy: 'oxylabs',
  firefox: 'firefox',
  foxy: 'firefox',
  fxa: 'firefox',
};

/** True when a Firefox VPN archive or refresh token was configured. */
export function firefoxCredentials() {
  return Boolean(
    String(env.FXA_ACCOUNTS_TGZ_B64 || env.FOXY_ACCOUNTS_TGZ_B64 || '').trim()
      || String(env.FOXY_REFRESH_TOKEN || '').trim(),
  );
}

/**
 * The local Firefox VPN proxy, from the environment the setup action exported.
 * `FXA_HTTP_PROXY` is the canonical form; the split variables exist for a
 * manual/local run.
 */
export function firefoxProxy() {
  const raw = String(env.FXA_HTTP_PROXY || '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      const port = Number(u.port || 10810);
      return {
        protocol: 'http',
        host: u.hostname,
        port,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
        label: `firefox vpn ${u.hostname}:${port}`,
        exitIp: String(env.FXA_EXIT_IP || '').trim() || null,
      };
    } catch {
      return null;
    }
  }

  const host = String(env.FXA_PROXY_HOST || '').trim();
  if (!host) return null;
  const port = Number(env.FXA_PROXY_PORT || 10810);
  if (!port) return null;
  return {
    protocol: 'http',
    host,
    port,
    username: String(env.FXA_PROXY_USER || '').trim(),
    password: String(env.FXA_PROXY_PASS || '').trim(),
    label: `firefox vpn ${host}:${port}`,
    exitIp: String(env.FXA_EXIT_IP || '').trim() || null,
  };
}

/** The provider this run will actually use: none | oxylabs | firefox. */
export function provider() {
  const sw = SWITCH();
  if (OFF_VALUES.includes(sw)) return 'none';
  if (FORCED[sw]) return FORCED[sw];
  // auto (also '', '1', 'true', 'yes', 'on'): prefer the paid residential
  // pool when it is configured, because it is the existing behaviour.
  if (oxySpec()) return 'oxylabs';
  if (firefoxCredentials()) return 'firefox';
  return 'none';
}

export function enabled() {
  return provider() !== 'none';
}

const countries = () => String(env.PROXY_COUNTRIES || env.PROXY_COUNTRY || 'us')
  .split(/[,\s]+/)
  .map((c) => c.trim().toLowerCase())
  .filter((c) => /^[a-z]{2}$/.test(c));

const sessionMinutes = () => Math.max(1, Math.min(30, Number(env.PROXY_SESSION_MINUTES || 30)));

function pickCountry(seed) {
  const list = countries();
  if (!list.length) return 'us';
  if (list.length === 1) return list[0];
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return list[hash % list.length];
}

/** One-line, credential-free description for the run log. */
export function status() {
  const p = provider();
  if (p === 'none') {
    return OFF_VALUES.includes(SWITCH())
      ? `off (PROXY_ENABLED=${SWITCH()}) — every request leaves from the runner IP`
      : 'off — no egress configured, every request leaves from the runner IP';
  }
  if (p === 'oxylabs') {
    const spec = oxySpec();
    if (!spec) return 'oxylabs requested — PROXY_OXYLABS is empty';
    return `oxylabs residential ${spec.host}:${spec.port} — countries ${countries().join(',') || 'us'}`
      + ` — one sticky session per account (${sessionMinutes()}m)`;
  }
  const ff = firefoxProxy();
  return ff
    ? `firefox vpn ${ff.host}:${ff.port}${ff.exitIp ? ` — exit ${ff.exitIp}` : ''}`
    : 'firefox vpn requested — the local core is not running (setup-firefox-vpn)';
}

/**
 * Throws only when the run explicitly selected a provider that cannot work.
 * `auto` falls back silently so a missing optional secret never breaks a run.
 */
export function assertConfigured() {
  const p = provider();
  if (p === 'none') return;
  if (p === 'oxylabs' && !oxySpec()) {
    throw new Error(
      'proxy=oxylabs but PROXY_OXYLABS is empty — set the repository secret to '
        + 'pr.oxylabs.io:7777:customer-resi_<ID>:<PASSWORD>, or use proxy_enabled=firefox / none',
    );
  }
  if (p === 'firefox' && !firefoxCredentials() && !firefoxProxy()) {
    throw new Error(
      'proxy=firefox but no Firefox VPN credentials exist — set FXA_ACCOUNTS_TGZ_B64 '
        + '(the accounts archive) or FOXY_REFRESH_TOKEN, or use proxy_enabled=oxylabs / none',
    );
  }
}

/**
 * Proxy settings for one Rask account. The session id is random, so two
 * Oxylabs accounts never share an exit IP, while every request of the same
 * account keeps the same IP for the whole `sesstime` window.
 *
 * The Firefox VPN core exposes one exit for the whole job: every account uses
 * it, which is the price of not paying per-account residential bandwidth.
 *
 * @returns {{protocol:string,host:string,port:number,username:string,password:string,
 *            country?:string,session?:string,label:string,exitIp?:string|null,
 *            rotate?:Function}|null}
 */
export function forIdentity(identityId) {
  const p = provider();
  if (p === 'none') return null;

  if (p === 'oxylabs') {
    const spec = oxySpec();
    if (!spec) {
      throw new Error('oxylabs egress selected but PROXY_OXYLABS is empty');
    }
    const country = pickCountry(identityId ?? crypto.randomUUID());

    const make = () => {
      const session = crypto.randomBytes(4).toString('hex');
      return {
        protocol: 'http',
        host: spec.host,
        port: spec.port,
        username: `${spec.username}-cc-${country}-sessid-${session}-sesstime-${sessionMinutes()}`,
        password: spec.password,
        country,
        session,
        label: `oxylabs ${country}/${session}`,
      };
    };

    const proxy = make();
    // A residential exit can go bad mid-run (502 on CONNECT, dead socket). The
    // account keeps its country but moves to a fresh sticky session in place, so
    // the object stored in the async context (and on the account) stays valid.
    proxy.rotate = () => {
      const next = make();
      proxy.username = next.username;
      proxy.session = next.session;
      proxy.label = next.label;
      return proxy;
    };
    return proxy;
  }

  // firefox
  const ff = firefoxProxy();
  if (!ff) {
    throw new Error(
      'proxy=firefox but the local VPN core is not running — add '
        + '"uses: ./.github/actions/setup-firefox-vpn" before this step, or set FXA_HTTP_PROXY',
    );
  }
  // The core survives an exit change on its own; rotating would mean a new
  // login, so a failed tunnel is retried against the same core.
  ff.rotate = () => ff;
  return ff;
}

/** `http://user:pass@host:port` for yt-dlp, with the credentials encoded. */
export function proxyUrl(proxy) {
  if (!proxy) return null;
  const scheme = proxy.protocol === 'socks5' ? 'socks5h' : 'http';
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * The exit yt-dlp must use for a YouTube watch page. This replaces the old
 * cookie jar: a signed-in cookie is a credential that dies with the IP, while
 * the egress is a property of the run.
 */
export function youtubeProxy() {
  return proxyUrl(forIdentity('youtube'));
}
