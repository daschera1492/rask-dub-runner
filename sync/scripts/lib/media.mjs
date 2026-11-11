import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, extname, resolve } from 'node:path';
import { probe } from './ff.mjs';

export const SR = 48000;
export const CH = 2;

const isUrl = (s) => /^https?:\/\//i.test(s);

/** Turn a local path or http(s) URL into a local file. */
export async function materialize(src, dir, label) {
  if (!src) throw new Error(`${label} is required`);

  if (!isUrl(src)) {
    const p = resolve(src);
    return p;
  }

  await mkdir(dir, { recursive: true });
  const guess = decodeURIComponent(new URL(src).pathname.split('/').pop() || `${label}.bin`);
  const dest = resolve(dir, `${label}-${basename(guess) || `${label}.bin`}`);

  // 3 attempts: file hosts routinely drop the first connection from a datacenter IP.
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(src, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if (!res.body) throw new Error('empty body');

      const total = Number(res.headers.get('content-length') || 0);
      let got = 0;
      let lastPct = -1;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        if (!total) return;
        const pct = Math.floor((got / total) * 100);
        if (pct >= lastPct + 20) { lastPct = pct; console.log(`[fetch] ${label}: ${pct}% of ${(total / 1048576).toFixed(1)} MB`); }
      });
      await pipeline(body, createWriteStream(dest));
      if (total && got !== total) throw new Error(`truncated: ${got}/${total} bytes`);
      return dest;
    } catch (err) {
      last = err;
      const cause = err.cause?.code || err.cause?.message;
      console.warn(`[fetch] ${label}: attempt ${attempt} failed — ${err.message}${cause ? ` (${cause})` : ''}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`download ${src} failed after 3 attempts: ${last?.message}${last?.cause?.code ? ` (${last.cause.code})` : ''}`);
}

/** Duration of the video stream in milliseconds, preferring exact stream/frame data. */
export function videoDurationMs(info) {
  const v = (info.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error('input has no video stream');

  const parseRate = (r) => {
    if (!r || typeof r !== 'string') return 0;
    const [n, d] = r.split('/').map(Number);
    if (!n || !d) return 0;
    return n / d;
  };

  const candidates = [];
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (v.duration) candidates.push({ v: Number(v.duration), from: 'stream.duration' });
  if (v.nb_frames && fps) candidates.push({ v: Number(v.nb_frames) / fps, from: 'nb_frames/fps', frames: Number(v.nb_frames), fps });
  if (info.format?.duration) candidates.push({ v: Number(info.format.duration), from: 'format.duration' });

  const valid = candidates.filter((c) => Number.isFinite(c.v) && c.v > 0);
  if (!valid.length) throw new Error('cannot determine video duration');

  // Frame count is the ground truth for constant-frame-rate video; keep it unless it
  // disagrees with the container duration by more than one frame (variable frame rate).
  const byFrames = valid.find((c) => c.from === 'nb_frames/fps');
  const byStream = valid.find((c) => c.from === 'stream.duration');
  let best = valid[0];
  if (byFrames && (!byStream || Math.abs(byFrames.v - byStream.v) <= 1.5 / byFrames.fps)) best = byFrames;

  return {
    ms: Math.round(best.v * 1000),
    seconds: best.v,
    source: best.from,
    frames: best.frames ?? (v.nb_frames ? Number(v.nb_frames) : null),
    codec: v.codec_name,
    width: v.width,
    height: v.height,
  };
}

export async function audioInfo(file) {
  const info = await probe(file);
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  if (!a) throw new Error(`no audio stream in ${basename(file)}`);

  const byDuration = a.duration ? Number(a.duration) : Number(info.format?.duration ?? NaN);
  if (!Number.isFinite(byDuration)) throw new Error(`cannot read audio duration of ${basename(file)}`);

  return { ms: Math.round(byDuration * 1000), seconds: byDuration, codec: a.codec_name, channels: a.channels };
}

export const stripExt = (p) => {
  const b = basename(p);
  const e = extname(b);
  return e ? b.slice(0, -e.length) : b;
};
