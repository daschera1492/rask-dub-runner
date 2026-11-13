/**
 * Offline test for the YouTube source (`scripts/lib/youtube.mjs`).
 *
 * No yt-dlp binary, no network: only the pure helpers (url detection, id,
 * cookie jar, argv) plus the failure path when yt-dlp is missing.
 *
 *   node test/youtube.test.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const yt = await import(pathToFileURL(path.join(repo, 'scripts/lib/youtube.mjs')).href);

const failures = [];
const check = (label, ok, detail = '') => {
  if (!ok) {
    failures.push(label);
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    return;
  }
  console.log(`ok   ${label}${detail ? ` (${detail})` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rask-yt-test-'));

/* ------------------------------------------------------------------ */
/* Link detection                                                      */
/* ------------------------------------------------------------------ */

const yes = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
  'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ?t=42',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ',
  'https://www.youtube.com/live/dQw4w9WgXcQ',
  'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
];
const no = [
  'https://example.com/video.mp4',
  'https://vimeo.com/123456',
  'https://notyoutube.com/watch?v=x',
  'https://youtube.com.evil.example/watch?v=x',
  'C:\\media\\clip.mp4',
  'not a url',
];

for (const url of yes) check(`youtube link: ${url}`, yt.isYouTube(url) === true);
for (const url of no) check(`not youtube: ${url}`, yt.isYouTube(url) === false);

check('id from watch url', yt.videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('id from youtu.be', yt.videoId('https://youtu.be/dQw4w9WgXcQ?t=1') === 'dQw4w9WgXcQ');
check('id from shorts', yt.videoId('https://www.youtube.com/shorts/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('id from embed', yt.videoId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
check('id survives a playlist param', yt.videoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1') === 'dQw4w9WgXcQ');

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

check('no cookies -> null', yt.cookieJar({}) === null);

const header = 'SID=abc123; HSID=def456; SAPISID=ghi/789';
const fromHeader = yt.cookieJar({ ytCookies: header });
const headerText = fs.readFileSync(fromHeader, 'utf8');
check('header form is converted to a jar', headerText.startsWith('# Netscape HTTP Cookie File'));
check('header form keeps every cookie', headerText.split('\n').filter(Boolean).length === 4);
check('header form names the domain', headerText.includes('.youtube.com\tTRUE\t/'));
check('header form splits on the first =', headerText.includes('\tSAPISID\tghi/789'));

const jar = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tzzz\n';
const fromJar = yt.cookieJar({ ytCookies: jar });
check('an exported jar is passed through untouched', fs.readFileSync(fromJar, 'utf8') === jar);

const jarFile = path.join(tmp, 'cookies.txt');
fs.writeFileSync(jarFile, jar);
check('YT_COOKIES_FILE is used as-is', yt.cookieJar({ ytCookiesFile: jarFile }) === jarFile);

let missingFile = null;
try {
  yt.cookieJar({ ytCookiesFile: path.join(tmp, 'nope.txt') });
} catch (err) {
  missingFile = err;
}
check('a missing YT_COOKIES_FILE fails loudly', Boolean(missingFile), String(missingFile?.message));

/* ------------------------------------------------------------------ */
/* argv                                                                */
/* ------------------------------------------------------------------ */

const template = path.join(tmp, 'youtube-abc.%(ext)s');
const bare = yt.ytdlpArgs({ url: 'https://youtu.be/abc', template });
check('--no-playlist is always on', bare.includes('--no-playlist'));
check('no --cookies without a jar', !bare.includes('--cookies'));
check('url is last', bare[bare.length - 1] === 'https://youtu.be/abc');
check('output template is set', bare[bare.indexOf('-o') + 1] === template);
check('merge output is mp4', bare[bare.indexOf('--merge-output-format') + 1] === 'mp4');

const withCookies = yt.ytdlpArgs({ url: 'https://youtu.be/abc', template, cookies: jarFile, extra: '--limit-rate 5M' });
check('--cookies is added when a jar exists', withCookies[withCookies.indexOf('--cookies') + 1] === jarFile);
check('extra args are split in', withCookies.includes('--limit-rate') && withCookies.includes('5M'));
check('extra args stay before the url', withCookies[withCookies.length - 1] === 'https://youtu.be/abc');

const withRuntime = yt.ytdlpArgs({ url: 'https://youtu.be/abc', template, jsRuntime: 'node' });
check('--js-runtimes is only passed when supported', withRuntime.includes('node'));

/* ------------------------------------------------------------------ */
/* Cached download                                                     */
/* ------------------------------------------------------------------ */

const work = path.join(tmp, 'work');
fs.mkdirSync(work, { recursive: true });
check('nothing cached yet', yt.findDownload(work, 'abc') === null);

fs.writeFileSync(path.join(work, 'youtube-abc.webm'), Buffer.alloc(2048));
check('a cached webm is reused', /youtube-abc\.webm$/.test(yt.findDownload(work, 'abc')));

fs.writeFileSync(path.join(work, 'youtube-abc.mp4'), Buffer.alloc(2048));
check('mp4 wins over webm', /youtube-abc\.mp4$/.test(yt.findDownload(work, 'abc')));

fs.writeFileSync(path.join(work, 'youtube-abc.mp4'), Buffer.alloc(10));
check('a truncated file is not reused', /youtube-abc\.webm$/.test(yt.findDownload(work, 'abc')));

check('another id does not match', yt.findDownload(work, 'xyz') === null);

/* ------------------------------------------------------------------ */
/* Missing binary                                                      */
/* ------------------------------------------------------------------ */

const emptyDir = path.join(tmp, 'empty');
fs.mkdirSync(emptyDir, { recursive: true });

let missingBin = null;
try {
  await yt.downloadYoutube('https://youtu.be/abc', {
    workDir: emptyDir,
    ytdlp: path.join(tmp, 'definitely-not-yt-dlp'),
    log: () => {},
  });
} catch (err) {
  missingBin = err;
}
check('a missing yt-dlp explains how to install it',
  Boolean(missingBin) && /not installed/.test(String(missingBin.message)),
  String(missingBin?.message).split('\n')[0]);

fs.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\nYOUTUBE TEST FAILED (${failures.length})`);
  process.exit(1);
}
console.log('\nYOUTUBE TEST OK');
