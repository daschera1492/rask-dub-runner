#!/usr/bin/env node
/**
 * Firefox VPN egress (Mozilla / Firefox Accounts).
 *
 *   node scripts/firefox-vpn.mjs start   # no-op unless PROXY_ENABLED=firefox
 *   node scripts/firefox-vpn.mjs stop
 *   node scripts/firefox-vpn.mjs status
 *
 * `start` installs the official `awmvpn-core` binary (a Go client for Mozilla's
 * VPN), refreshes the stored Firefox Account with the FoxyVPN login flow,
 * writes a config with a random proxy login, starts the core on loopback and
 * proves the tunnel with a request through it. It exports:
 *
 *   FXA_HTTP_PROXY=http://user:pass@127.0.0.1:10810
 *   FXA_EXIT_IP=<the IP YouTube and Rask will see>
 *
 * The same core is what replaces the YouTube cookie jar: `scripts/lib/proxy.mjs`
 * hands this local proxy to yt-dlp with `--proxy`, so the download leaves from
 * Mozilla's edge instead of the runner's datacenter IP.
 *
 * Variables (the same names the other runner uses):
 *   FXA_ACCOUNTS_TGZ_B64, FOXY_ACCOUNTS_TGZ_B64, FOXY_REFRESH_TOKEN
 *   FXA_COUNTRY (default: PROXY_COUNTRIES), FXA_TRANSPORT (h2|h3)
 *   FXA_PROXY_PORT (10810), FXA_TRIES (3), FXA_INSTALL_DIR
 *   FXA_REPO (AiWithMase/awmvpn), FXA_RELEASE (latest)
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as proxy from './lib/proxy.mjs';
import { refreshAccounts } from './lib/fxa-login.mjs';

const env = process.env;

const INSTALL_DIR = path.resolve(env.FXA_INSTALL_DIR || path.join(env.RUNNER_TEMP || os.tmpdir(), 'firefox-vpn'));
const DATA_DIR = path.join(INSTALL_DIR, 'user-data');
const CORE = path.join(INSTALL_DIR, 'awmvpn-core');
const LOG = path.join(INSTALL_DIR, 'awmvpn.log');
const PID_FILE = path.join(INSTALL_DIR, 'awmvpn.pid');
const PORT = Math.max(1, Number(env.FXA_PROXY_PORT || 10810));
const TRANSPORT = String(env.FXA_TRANSPORT || 'h2').toLowerCase() === 'h3' ? 'h3' : 'h2';
const TRIES = Math.max(1, Number(env.FXA_TRIES || 3));
const UPSTREAMS = Math.max(1, Number(env.FXA_UPSTREAM_CONNECTIONS || 1));
const REPO = String(env.FXA_REPO || 'AiWithMase/awmvpn').trim();
const RELEASE = String(env.FXA_RELEASE || 'latest').trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(...args);

function appendEnv(pairs) {
  const file = env.GITHUB_ENV;
  if (!file) {
    log('[vpn] GITHUB_ENV is not set; the proxy is not exported to later steps');
    return;
  }
  const body = Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(file, `${body}\n`);
}

function coreArch() {
  return process.arch === 'arm64' ? 'arm64' : 'amd64';
}

async function installCore() {
  if (fs.existsSync(CORE)) {
    const version = spawnSync(CORE, ['-version'], { encoding: 'utf8' });
    log(`[vpn] core already installed: ${String(version.stdout || '').trim() || 'unknown'}`);
    return;
  }
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  const asset = `awmvpn-core-linux-${coreArch()}.tar.gz`;
  const url = RELEASE === 'latest'
    ? `https://github.com/${REPO}/releases/latest/download/${asset}`
    : `https://github.com/${REPO}/releases/download/${RELEASE}/${asset}`;
  log(`[vpn] downloading ${asset} (${RELEASE})`);

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'rask-dub-runner' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const tarPath = path.join(INSTALL_DIR, asset);
      fs.writeFileSync(tarPath, bytes);
      const untar = spawnSync('tar', ['xzf', tarPath, '-C', INSTALL_DIR, '--strip-components=1'], {
        encoding: 'utf8',
      });
      fs.rmSync(tarPath, { force: true });
      if (untar.status !== 0) throw new Error(String(untar.stderr || 'tar failed').trim());
      if (!fs.existsSync(CORE)) throw new Error('the archive did not contain awmvpn-core');
      fs.chmodSync(CORE, 0o755);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      log(`[vpn] download attempt ${attempt}/3 failed: ${error.message}`);
      await sleep(3000 * attempt);
    }
  }
  if (lastError) throw new Error(`cannot install the Firefox VPN core: ${lastError.message}`);
  const version = spawnSync(CORE, ['-version'], { encoding: 'utf8' });
  log(`[vpn] core installed: ${String(version.stdout || '').trim() || 'unknown'}`);
}

function writeConfig(country, username, password) {
  const config = {
    version: 2,
    proxy: {
      listen: `127.0.0.1:${PORT}`,
      username,
      password,
      country,
      transport: TRANSPORT,
      upstream_connections: UPSTREAMS,
      max_connections: 256,
      // Never sleep: a queue worker may be idle for a while and still needs the
      // proxy instantly when the next chunk starts.
      idle_sleep: '0s',
    },
    dashboard: { enabled: false, listen: `127.0.0.1:${PORT + 10}` },
    routing: { enabled: false, region: '' },
    logging: { verbose: false },
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function restoreAccounts() {
  const archiveB64 = String(env.FXA_ACCOUNTS_TGZ_B64 || env.FOXY_ACCOUNTS_TGZ_B64 || '').trim();
  const refreshToken = String(env.FOXY_REFRESH_TOKEN || '').trim();

  const { archiveB64: refreshed, verified } = await refreshAccounts({
    archiveB64,
    refreshToken,
    log,
  });
  log(`[vpn] Firefox login ${verified ? 'verified' : 'not verified (the core will try its own login)'}`);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tarPath = path.join(INSTALL_DIR, 'accounts.tar.gz');
  fs.writeFileSync(tarPath, Buffer.from(refreshed, 'base64'), { mode: 0o600 });
  const untar = spawnSync('tar', ['xzf', tarPath, '-C', DATA_DIR], { encoding: 'utf8' });
  fs.rmSync(tarPath, { force: true });
  if (untar.status !== 0) throw new Error(`cannot extract the accounts archive: ${String(untar.stderr || '').trim()}`);

  const accounts = path.join(DATA_DIR, 'accounts');
  if (!fs.existsSync(accounts)) throw new Error('the archive has no accounts/ folder');
  // Without secret.key the core cannot decrypt a stored password; a fresh
  // archive from FOXY_REFRESH_TOKEN always carries one, but a hand-made one
  // may not. A random key is enough because no password is restored.
  const key = path.join(accounts, 'secret.key');
  if (!fs.existsSync(key)) {
    fs.writeFileSync(key, `${cryptoRandomHex(32)}\n`, { mode: 0o600 });
    log('[vpn] accounts/secret.key was missing; wrote a fresh one');
  }
  const count = fs.readdirSync(accounts, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  log(`[vpn] accounts restored: ${count}`);
}

function cryptoRandomHex(bytes) {
  return randomBytes(bytes).toString('hex');
}

/** Country candidates, from FXA_COUNTRY or the shared PROXY_COUNTRIES. */
function countryPlan() {
  const raw = String(env.FXA_COUNTRY || env.PROXY_COUNTRIES || '').trim();
  if (!raw) return [''];
  const parts = raw.split(/[,\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 1 && ['auto', 'random', 'recommended', 'rec'].includes(parts[0])) return [''];
  if (parts.length === 1 && parts[0] === 'fastest') return ['fastest'];
  const codes = parts.filter((part) => /^[a-z]{2}$/.test(part));
  return codes.length ? [...new Set(codes)] : [''];
}

async function stopCore() {
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    // Give it a moment to release the loopback port before the next start.
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await sleep(250);
    }
  }
  fs.rmSync(PID_FILE, { force: true });
}

function tailLog(lines = 25) {
  try {
    const text = fs.readFileSync(LOG, 'utf8').trimEnd().split('\n');
    return text.slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

function startCore({ username, password }) {
  const out = fs.openSync(LOG, 'a');
  const child = spawn(CORE, ['-data-dir', DATA_DIR, '-plain'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`[vpn] core started (pid ${child.pid}), waiting for the tunnel on 127.0.0.1:${PORT}`);
  return child.pid;
}

function probe(username, password) {
  const res = spawnSync('curl', [
    '-sS', '--max-time', '30',
    '--proxy', `http://127.0.0.1:${PORT}`,
    '--proxy-user', `${username}:${password}`,
    'https://api.ipify.org',
  ], { encoding: 'utf8', timeout: 40_000 });
  const ip = String(res.stdout || '').trim();
  if (res.status !== 0) return { ok: false, detail: String(res.stderr || `curl exit ${res.status}`).trim().slice(0, 200) };
  if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return { ok: false, detail: ip || 'empty answer' };
  return { ok: true, ip };
}

async function waitForTunnel(username, password, attempts = 24) {
  for (let i = 1; i <= attempts; i++) {
    const result = probe(username, password);
    if (result.ok) {
      log(`[vpn] tunnel up after ${i} probe(s) — exit ${result.ip}`);
      return result;
    }
    if (i === 1 || i % 3 === 0) log(`[vpn] probe ${i}/${attempts}: ${result.detail}`);
    await sleep(5000);
  }
  return { ok: false };
}

async function start() {
  const provider = proxy.provider();
  if (provider !== 'firefox') {
    log(`[vpn] egress is ${provider}; Firefox VPN is not needed`);
    return;
  }
  proxy.assertConfigured();

  await installCore();
  await stopCore();
  await restoreAccounts();

  const plan = countryPlan();
  let tried = 0;
  for (const country of plan) {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      tried += 1;
      const username = `rask${cryptoRandomHex(4)}`;
      const password = cryptoRandomHex(16);
      writeConfig(country, username, password);
      await stopCore();
      try {
        fs.rmSync(LOG, { force: true });
      } catch {
        /* keep the old log */
      }
      startCore({ username, password });
      const tunnel = await waitForTunnel(username, password);
      if (tunnel.ok) {
        const url = `http://${username}:${password}@127.0.0.1:${PORT}`;
        appendEnv({
          FXA_HTTP_PROXY: url,
          FXA_EXIT_IP: tunnel.ip,
          FXA_COUNTRY_USED: country || 'auto',
          FXA_PROXY_PID: String(Number(fs.readFileSync(PID_FILE, 'utf8'))),
        });
        log(`[vpn] ready: country=${country || 'auto'} transport=${TRANSPORT} exit=${tunnel.ip}`);
        return;
      }
      log(`[vpn] attempt ${tried} (country=${country || 'auto'}) failed`);
      await stopCore();
    }
  }

  log('[vpn] the core never answered through the tunnel; last log lines:');
  for (const line of tailLog().split('\n')) log(`[vpn]   ${line}`);
  throw new Error('Firefox VPN could not connect — check FXA_ACCOUNTS_TGZ_B64 / FOXY_REFRESH_TOKEN and PROXY_COUNTRIES');
}

async function stop() {
  await stopCore();
  log('[vpn] stopped');
}

function status() {
  const provider = proxy.provider();
  const ff = proxy.firefoxProxy();
  log(`[vpn] provider=${provider}${ff ? ` proxy=${ff.host}:${ff.port}${ff.exitIp ? ` exit=${ff.exitIp}` : ''}` : ''}`);
  if (fs.existsSync(CORE) && fs.existsSync(DATA_DIR)) {
    const res = spawnSync(CORE, ['-status', '-data-dir', DATA_DIR], { encoding: 'utf8', timeout: 30_000 });
    if (res.status === 0 && res.stdout) log(String(res.stdout).trimEnd());
  }
}

const command = process.argv[2] || 'start';
try {
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'status') status();
  else {
    console.error(`unknown command "${command}" — use start, stop or status`);
    process.exit(2);
  }
} catch (error) {
  console.error(`Firefox VPN: ${error?.message || error}`);
  process.exit(1);
}
