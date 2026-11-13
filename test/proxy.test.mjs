/**
 * Offline test for the egress selector (`scripts/lib/proxy.mjs`).
 *
 * No network, no VPN: every case is decided from the environment. The two
 * things that matter here are (1) which provider a switch resolves to, and
 * (2) that a missing secret only fails when that provider was asked for.
 *
 *   node test/proxy.test.mjs
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const proxy = await import(pathToFileURL(path.join(repo, 'scripts/lib/proxy.mjs')).href);

const failures = [];
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${label}${detail ? ` (${detail})` : ''}`);
};

const KEYS = [
  'PROXY_ENABLED', 'USE_PROXY',
  'PROXY_OXYLABS', 'OXYLABS_PROXY', 'PROXY_URL',
  'PROXY_COUNTRIES', 'PROXY_COUNTRY', 'PROXY_SESSION_MINUTES',
  'FXA_HTTP_PROXY', 'FXA_EXIT_IP', 'FXA_PROXY_HOST', 'FXA_PROXY_PORT',
  'FXA_PROXY_USER', 'FXA_PROXY_PASS',
  'FXA_ACCOUNTS_TGZ_B64', 'FOXY_ACCOUNTS_TGZ_B64', 'FOXY_REFRESH_TOKEN',
];
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
const reset = () => {
  for (const key of KEYS) delete process.env[key];
};
const restore = () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const OXY = 'pr.oxylabs.io:7777:customer-resi_1:s3cret';
const FXA_PROXY = 'http://vpnuser:vpnpass@127.0.0.1:10810';
const throws = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

try {
  /* ---------------------------------------------------------------- */
  /* Off                                                               */
  /* ---------------------------------------------------------------- */

  reset();
  check('nothing configured -> none', proxy.provider() === 'none');
  check('none is not enabled', proxy.enabled() === false);
  check('none has no account proxy', proxy.forIdentity('a') === null);
  check('none has no youtube proxy', proxy.youtubeProxy() === null);
  check('none needs no configuration', throws(() => proxy.assertConfigured()) === null);
  check('none says so in the log', /off/.test(proxy.status()), proxy.status());

  reset();
  process.env.PROXY_ENABLED = 'false';
  process.env.PROXY_OXYLABS = OXY;
  check('PROXY_ENABLED=false beats a configured pool', proxy.provider() === 'none');

  /* ---------------------------------------------------------------- */
  /* Oxylabs                                                           */
  /* ---------------------------------------------------------------- */

  reset();
  process.env.PROXY_ENABLED = 'true';
  process.env.PROXY_OXYLABS = OXY;
  process.env.PROXY_COUNTRIES = 'de,nl';
  check('old boolean true -> oxylabs when a pool exists', proxy.provider() === 'oxylabs');
  check('oxylabs is enabled', proxy.enabled() === true);
  check('oxylabs is named in the log', /oxylabs/.test(proxy.status()), proxy.status());
  check('oxylabs passes the configuration check', throws(() => proxy.assertConfigured()) === null);

  const sticky = proxy.forIdentity('account-1');
  check('oxylabs returns a proxy', sticky !== null);
  check('oxylabs host/port survive the parse', sticky.host === 'pr.oxylabs.io' && sticky.port === 7777);
  check('oxylabs username carries the sticky session',
    /^customer-resi_1-cc-(de|nl)-sessid-[0-9a-f]{8}-sesstime-30$/.test(sticky.username), sticky.username);
  check('the country comes from PROXY_COUNTRIES', ['de', 'nl'].includes(sticky.country), sticky.country);

  const rotated = sticky.rotate();
  check('rotate keeps the same object', rotated === sticky);
  check('rotate moves to a new session', sticky.session !== '' && /sessid-/.test(sticky.username));
  check('the password stays out of the label', !sticky.label.includes('s3cret'), sticky.label);

  const url = proxy.proxyUrl(sticky);
  check('proxyUrl keeps the credentials and the exit', url.endsWith(':s3cret@pr.oxylabs.io:7777'), url);
  const ytUrl = proxy.youtubeProxy();
  check('youtubeProxy uses the same residential pool',
    ytUrl.startsWith('http://customer-resi_1-cc-') && ytUrl.endsWith('@pr.oxylabs.io:7777'), ytUrl);

  reset();
  process.env.PROXY_ENABLED = 'oxylabs';
  process.env.PROXY_OXYLABS = 'http://u%40ser:p%3Ass@pr.oxylabs.io:7777';
  const encoded = proxy.forIdentity('account-2');
  check('a url-form secret is decoded and re-encoded',
    proxy.proxyUrl(encoded).startsWith('http://u%40ser-cc-')
      && proxy.proxyUrl(encoded).endsWith(':p%3Ass@pr.oxylabs.io:7777'), proxy.proxyUrl(encoded));

  reset();
  process.env.PROXY_ENABLED = 'oxylabs';
  process.env.PROXY_OXYLABS = OXY;
  check('the explicit switch wins over auto', proxy.provider() === 'oxylabs');

  reset();
  process.env.PROXY_ENABLED = 'oxylabs';
  const missingPool = throws(() => proxy.assertConfigured());
  check('oxylabs without a pool fails with a hint',
    Boolean(missingPool) && /PROXY_OXYLABS is empty/.test(missingPool.message), String(missingPool?.message));

  /* ---------------------------------------------------------------- */
  /* Firefox VPN                                                       */
  /* ---------------------------------------------------------------- */

  reset();
  process.env.PROXY_ENABLED = 'firefox';
  process.env.FXA_HTTP_PROXY = FXA_PROXY;
  process.env.FXA_EXIT_IP = '203.0.113.7';
  check('firefox is selected', proxy.provider() === 'firefox');
  check('firefox is enabled', proxy.enabled() === true);
  check('the exit IP is in the log', /203\.0\.113\.7/.test(proxy.status()), proxy.status());
  check('firefox passes the configuration check with an archive',
    throws(() => {
      process.env.FXA_ACCOUNTS_TGZ_B64 = 'not-really-a-tarball';
      proxy.assertConfigured();
      delete process.env.FXA_ACCOUNTS_TGZ_B64;
    }) === null);

  const vpn = proxy.forIdentity('account-1');
  const vpn2 = proxy.forIdentity('account-2');
  check('firefox returns the local core', vpn?.host === '127.0.0.1' && vpn?.port === 10810);
  check('every account shares the one exit',
    vpn.host === vpn2.host && vpn.port === vpn2.port
      && vpn.username === vpn2.username && vpn.password === vpn2.password);
  check('the core is never rotated', vpn.rotate() === vpn);
  check('the loopback url carries the credentials',
    proxy.proxyUrl(vpn) === 'http://vpnuser:vpnpass@127.0.0.1:10810', proxy.proxyUrl(vpn));
  check('youtube uses the VPN', proxy.youtubeProxy() === proxy.proxyUrl(vpn));

  reset();
  process.env.PROXY_ENABLED = 'foxy';
  process.env.FXA_ACCOUNTS_TGZ_B64 = 'archive';
  process.env.FXA_PROXY_HOST = '127.0.0.1';
  process.env.FXA_PROXY_PORT = '10811';
  check('the foxy alias selects firefox', proxy.provider() === 'firefox');
  check('split variables work without FXA_HTTP_PROXY', proxy.forIdentity('x')?.port === 10811);

  reset();
  process.env.PROXY_ENABLED = 'firefox';
  process.env.FXA_ACCOUNTS_TGZ_B64 = 'archive';
  const noCore = throws(() => proxy.forIdentity('x'));
  check('a selected VPN that is not running fails with a hint',
    Boolean(noCore) && /not running/.test(noCore.message), String(noCore?.message));

  reset();
  process.env.PROXY_ENABLED = 'firefox';
  const noCreds = throws(() => proxy.assertConfigured());
  check('firefox without credentials fails with a hint',
    Boolean(noCreds) && /FXA_ACCOUNTS_TGZ_B64/.test(noCreds.message), String(noCreds?.message));

  check('an access token alone is enough to consider firefox configured', (() => {
    reset();
    process.env.FOXY_REFRESH_TOKEN = 'token';
    return proxy.firefoxCredentials() === true;
  })());

  /* ---------------------------------------------------------------- */
  /* Auto                                                              */
  /* ---------------------------------------------------------------- */

  reset();
  process.env.PROXY_OXYLABS = OXY;
  check('auto prefers the paid pool', proxy.provider() === 'oxylabs');

  reset();
  process.env.FXA_ACCOUNTS_TGZ_B64 = 'archive';
  check('auto falls back to firefox', proxy.provider() === 'firefox');

  reset();
  process.env.PROXY_ENABLED = 'auto';
  check('auto with nothing configured falls back to none', proxy.provider() === 'none');
} finally {
  restore();
}

if (failures.length) {
  console.error(`\nPROXY TEST FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nPROXY TEST OK');
