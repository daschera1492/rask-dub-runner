/**
 * YouTube sources.
 *
 * Rask only accepts a file, and plain `curl` cannot fetch a watch page, so a
 * YouTube link is resolved with yt-dlp first (installed by
 * `.github/actions/setup-ytdlp`). The file is downloaded once per stage into
 * WORK_DIR under a stable `youtube-<id>.<ext>` name, so prepare and merge land
 * on the same path and a re-run reuses it instead of downloading again.
 *
 * No YouTube cookies are used, ever. Cloud runner IPs get "Sign in to confirm
 * you're not a bot", and a cookie jar is a credential that stops working the
 * moment the request leaves from another IP (which is exactly what happens
 * when prepare and merge run on different runners). The fix is an egress, not
 * a login: yt-dlp is handed the proxy selected by `PROXY_ENABLED`
 * (Firefox VPN or Oxylabs) with `--proxy`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const YT_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

/** True for any youtube.com / youtu.be / nocookie host. */
export function isYouTube(input) {
  try {
    return YT_HOST.test(new URL(String(input).trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * Stable id used for the downloaded file name, so prepare and merge agree
 * (they run on different machines). Falls back to `unknown` for odd urls.
 */
export function videoId(input) {
  try {
    const url = new URL(String(input).trim());
    if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
      return url.pathname.split('/').filter(Boolean)[0] || 'unknown';
    }
    const v = url.searchParams.get('v');
    if (v) return v;
    const match = url.pathname.match(/\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{5,})/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The already-downloaded file for this id, if any (prepare/merge reuse it). */
export function findDownload(workDir, id) {
  let entries;
  try {
    entries = fs.readdirSync(workDir);
  } catch {
    return null;
  }
  const name = new RegExp(`^youtube-${id.replace(/[^A-Za-z0-9_-]/g, '')}\\.(mp4|mkv|webm|mov)$`, 'i');
  const found = entries
    .filter((entry) => name.test(entry))
    .map((entry) => path.join(workDir, entry))
    .filter((file) => {
      try {
        return fs.statSync(file).size > 1024;
      } catch {
        return false;
      }
    });
  // Prefer the mp4 that --merge-output-format produces.
  return found.find((file) => file.toLowerCase().endsWith('.mp4')) || found[0] || null;
}

/**
 * Remove yt-dlp leftovers (`.f399.mp4`, `.part`, `.ytdl`) for this id, so a
 * retry cannot merge onto a half-written file. Final files are kept.
 */
export function cleanPartials(workDir, id) {
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
  const finalName = new RegExp(`^youtube-${safe}\\.(mp4|mkv|webm|mov)$`, 'i');
  let removed = 0;
  for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(`youtube-${safe}.`)) continue;
    if (finalName.test(entry.name)) continue;
    fs.rmSync(path.join(workDir, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * yt-dlp argv. Kept pure so the offline test can assert on it.
 *
 * `proxy` is a URL from proxy.mjs (http or socks5h). It is never a cookie jar:
 * YouTube sees a different exit, not a signed-in session.
 */
export function ytdlpArgs({
  url,
  template,
  format = 'bv*+ba/b',
  extra = '',
  jsRuntime = '',
  proxy = null,
}) {
  const args = [
    // A watch url copied from a playlist carries `&list=`; without this,
    // yt-dlp happily downloads all 300 videos.
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--retries', '10',
    '--fragment-retries', '10',
    '--socket-timeout', '30',
    '-f', format,
    '--merge-output-format', 'mp4',
    '-o', template,
  ];
  if (proxy) args.push('--proxy', proxy);
  if (jsRuntime) args.push('--js-runtimes', jsRuntime);
  if (extra) args.push(...String(extra).split(/\s+/).filter(Boolean));
  args.push(url);
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const spawnInherit = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', (err) => resolve({ code: -1, error: err }));
  child.on('close', (code) => resolve({ code }));
});

const capture = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { windowsHide: true });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  child.stderr.on('data', (chunk) => (out += chunk));
  child.on('error', () => resolve({ ok: false, out: '' }));
  child.on('close', (code) => resolve({ ok: code === 0, out }));
});

let runtimeCache;
/**
 * Recent yt-dlp needs a JS runtime for YouTube's signature challenges. Node is
 * already on the runner, so use it — but only if this build knows the flag,
 * otherwise yt-dlp exits with "no such option" before downloading anything.
 */
async function jsRuntime(bin) {
  if (runtimeCache !== undefined) return runtimeCache;
  const { out } = await capture(bin, ['--help']);
  runtimeCache = /--js-runtimes/.test(out) ? 'node' : '';
  return runtimeCache;
}

/** One-line egress description for the log, without credentials. */
function egressLabel(proxy) {
  if (!proxy) return 'direct (runner IP)';
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
  } catch {
    return 'configured proxy';
  }
}

/**
 * Download a YouTube url into `workDir` and return the local file path.
 * @returns {Promise<string>}
 */
export async function downloadYoutube(input, {
  workDir,
  proxy = null,
  ytdlp = 'yt-dlp',
  format = 'bv*+ba/b',
  extra = '',
  attempts = 3,
  log = () => {},
} = {}) {
  const id = videoId(input).replace(/[^A-Za-z0-9_-]/g, '');
  fs.mkdirSync(workDir, { recursive: true });

  const cached = findDownload(workDir, id);
  if (cached) {
    log(`[input] reusing ${cached} (${(fs.statSync(cached).size / 1024 / 1024).toFixed(1)} MB)`);
    return cached;
  }

  log(`[input] youtube ${id} -> yt-dlp via ${egressLabel(proxy)}`);
  const template = path.join(workDir, `youtube-${id}.%(ext)s`);
  const args = ytdlpArgs({
    url: input,
    template,
    format,
    extra,
    proxy,
    jsRuntime: await jsRuntime(ytdlp),
  });

  let code = -1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    cleanPartials(workDir, id);
    const result = await spawnInherit(ytdlp, args);
    if (result.error?.code === 'ENOENT') {
      throw new Error(
        `${ytdlp} is not installed — install it (https://github.com/yt-dlp/yt-dlp) or run the workflow, ` +
        'which installs it in .github/actions/setup-ytdlp',
      );
    }
    code = result.code;
    if (code === 0) break;
    if (attempt < attempts) {
      const waitMs = attempt * 5000;
      log(`[input] yt-dlp failed (exit ${code}); retry ${attempt}/${attempts - 1} in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }

  if (code !== 0) {
    const hint = proxy
      ? ` — the request left through ${egressLabel(proxy)}; if YouTube still says "Sign in to confirm", that exit is flagged: switch proxy_enabled (firefox/oxylabs) or pick another PROXY_COUNTRIES value`
      : ' — no egress is configured, and YouTube blocks most cloud runner IPs: set proxy_enabled=firefox (Firefox VPN) or oxylabs, which is what replaced the old cookie jar';
    throw new Error(`yt-dlp failed (exit ${code}) for ${input}${hint}`);
  }

  const out = findDownload(workDir, id);
  if (!out) throw new Error('yt-dlp reported success but wrote no file — check the download log');
  log(`[input] saved ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
  return out;
}
