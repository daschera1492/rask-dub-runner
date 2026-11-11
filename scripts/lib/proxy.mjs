/**
 * Oxylabs residential proxy pool: one sticky exit IP per Rask account.
 *
 * Every account's Cognito signup, Rask API calls and audio upload go through
 * the same exit IP for the account's whole lifetime (see http.mjs `withProxy`).
 * The source video download and the dubbed-file download stay direct, so the
 * paid residential bandwidth is spent on a few hundred KB of JSON plus the
 * audio chunk, never on video.
 *
 * Secret format (same as the other runners):
 *
 *   PROXY_OXYLABS = pr.oxylabs.io:7777:customer-resi_<ID>:<PASSWORD>
 *
 * Oxylabs takes the targeting parameters as dash-separated parts of the
 * *username*, so every account gets its own sticky session:
 *
 *   customer-resi_<ID>-cc-<country>-sessid-<8 hex>-sesstime-<minutes>
 *
 * The password is used verbatim (never URL-encoded into the secret), which
 * matters because Oxylabs dashboard passwords contain '+'.
 */

import crypto from 'node:crypto';

const env = process.env;

/** host:port:user:pass — the password may itself contain ':'. */
function parseSpec(spec) {
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

const SPEC = parseSpec(env.PROXY_OXYLABS || env.OXYLABS_PROXY || env.PROXY_URL || '');

/**
 * "0"/"false"/"off" turns the proxy off. When the switch is unset the proxy is
 * on as soon as a spec exists, so adding the secret is all it takes.
 */
const SWITCH = String(env.PROXY_ENABLED ?? env.USE_PROXY ?? '').trim().toLowerCase();
const OFF = ['0', 'false', 'off', 'no', 'disabled'].includes(SWITCH);
const ENABLED = !OFF && Boolean(SPEC);

const COUNTRIES = String(env.PROXY_COUNTRIES || env.PROXY_COUNTRY || 'us')
  .split(/[,\s]+/)
  .map((c) => c.trim().toLowerCase())
  .filter((c) => /^[a-z]{2}$/.test(c));

const SESSION_MINUTES = Math.max(1, Math.min(30, Number(env.PROXY_SESSION_MINUTES || 30)));

export function enabled() {
  return ENABLED;
}

/** One-line, credential-free description for the run log. */
export function status() {
  if (OFF) return 'off (PROXY_ENABLED=0) — every request leaves from the runner IP';
  if (!SPEC) return 'off — PROXY_OXYLABS is not set, every request leaves from the runner IP';
  return `oxylabs residential ${SPEC.host}:${SPEC.port} — countries ${COUNTRIES.join(',')} — one sticky session per account (${SESSION_MINUTES}m)`;
}

/**
 * Throws only when the run explicitly asked for a proxy (`PROXY_ENABLED=true`)
 * but no spec exists. With the switch unset the runner silently falls back to
 * the plain runner IP, so a missing secret never breaks a run.
 */
export function assertConfigured() {
  if (SPEC || OFF || !SWITCH) return;
  throw new Error(
    'proxy was requested (PROXY_ENABLED=true) but PROXY_OXYLABS is empty — set the repository '
      + 'secret to pr.oxylabs.io:7777:customer-resi_<ID>:<PASSWORD>, or run with proxy_enabled=false',
  );
}

function pickCountry(seed) {
  if (!COUNTRIES.length) return 'us';
  if (COUNTRIES.length === 1) return COUNTRIES[0];
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COUNTRIES[hash % COUNTRIES.length];
}

/**
 * Proxy settings for one Rask account. The session id is random, so two
 * accounts never share an exit IP, while every request of the same account
 * keeps the same IP for the whole `sesstime` window.
 *
 * @returns {{host:string,port:number,username:string,password:string,country:string,session:string,label:string}|null}
 */
export function forIdentity(identityId) {
  if (!ENABLED) return null;

  const country = pickCountry(identityId ?? crypto.randomUUID());
  const session = crypto.randomBytes(4).toString('hex');
  const username = `${SPEC.username}-cc-${country}-sessid-${session}-sesstime-${SESSION_MINUTES}`;

  return {
    host: SPEC.host,
    port: SPEC.port,
    username,
    password: SPEC.password,
    country,
    session,
    label: `oxylabs ${country}/${session}`,
  };
}
