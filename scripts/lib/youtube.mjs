/**
 * YouTube sources.
 *
 * Rask only accepts a file, and plain `curl` cannot fetch a watch page, so a
 * YouTube link is resolved with yt-dlp first (installed by
 * `.github/actions/setup-ytdlp`). The file is downloaded once per stage into
 * WORK_DIR under a stable `youtube-<id>.<ext>` name, so prepare and merge land
 * on the same path and a re-run reuses it instead of downloading again.
 *
 * This is the only place in the repo that may need a signed-in session: cloud
 * runner IPs get "Sign in to confirm you're not a bot" and age-gated videos
 * answer 403, so `YT_COOKIES` (a Netscape jar) or `YT_COOKIES_FILE` is handed
 * to yt-dlp with `--cookies`. The jar is written 0600 into the temp dir and is
 * never logged.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

/**
 * Netscape jar text for a `name=value; name=value` header, so a cookie string
 * copied out of the browser's devtools works as well as an exported jar.
 */
export function netscapeFromHeader(header) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const pair of String(header).split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    const value = rest.join('=');
    if (!name || !value) continue;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', '0', name, value].join('\t'));
  }
  return lines.join('\n');
}

/**
 * Path to the cookie jar for yt-dlp, or null when no cookies are configured.
 * A pasted jar is returned as-is (already a file); a raw blob is written 0600
 * into the temp dir; a `name=value;` header is converted to Netscape first.
 */
export function cookieJar({ ytCookies = '', ytCookiesFile = '' } = {}) {
  if (ytCookiesFile) {
    if (!fs.existsSync(ytCookiesFile)) {
      throw new Error(`YT_COOKIES_FILE not found: ${ytCookiesFile}`);
    }
    return ytCookiesFile;
  }

  const raw = String(ytCookies || '').trim();
  if (!raw) return null;

  const text = raw.includes('\t') || /^#\s*(Netscape|HttpOnly_)/m.test(raw)
    ? raw
    : netscapeFromHeader(raw);

  const file = path.join(os.tmpdir(), `rask-yt-cookies-${process.pid}.txt`);
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  return file;
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

/** yt-dlp argv. Kept pure so the offline test can assert on it. */
export function ytdlpArgs({ url, template, cookies = null, format = 'bv*+ba/b', extra = '', jsRuntime = '' }) {
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
  if (cookies) args.push('--cookies', cookies);
  if (jsRuntime) args.push('--js-runtimes', jsRuntime);
  if (extra) args.push(...String(extra).split(/\s+/).filter(Boolean));
  args.push(url);
  return args;
}

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

/**
 * Download a YouTube url into `workDir` and return the local file path.
 * @returns {Promise<string>}
 */
export async function downloadYoutube(input, {
  workDir,
  cookies = null,
  ytdlp = 'yt-dlp',
  format = 'bv*+ba/b',
  extra = '',
  log = () => {},
} = {}) {
  const id = videoId(input).replace(/[^A-Za-z0-9_-]/g, '');
  fs.mkdirSync(workDir, { recursive: true });

  const cached = findDownload(workDir, id);
  if (cached) {
    log(`[input] reusing ${cached} (${(fs.statSync(cached).size / 1024 / 1024).toFixed(1)} MB)`);
    return cached;
  }

  log(`[input] youtube ${id} -> yt-dlp`);
  const template = path.join(workDir, `youtube-${id}.%(ext)s`);
  const args = ytdlpArgs({
    url: input,
    template,
    cookies,
    format,
    extra,
    jsRuntime: await jsRuntime(ytdlp),
  });

  const { code, error } = await spawnInherit(ytdlp, args);
  if (error?.code === 'ENOENT') {
    throw new Error(
      `${ytdlp} is not installed — install it (https://github.com/yt-dlp/yt-dlp) or run the workflow, ` +
      'which installs it in .github/actions/setup-ytdlp',
    );
  }
  if (code !== 0) {
    const hint = cookies
      ? ''
      : ' — no cookies configured: YouTube blocks most cloud runner IPs without a signed-in session, set YT_COOKIES';
    throw new Error(`yt-dlp failed (exit ${code}) for ${input}${hint}`);
  }

  const out = findDownload(workDir, id);
  if (!out) throw new Error('yt-dlp reported success but wrote no file — check the download log');
  log(`[input] saved ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
  return out;
}
