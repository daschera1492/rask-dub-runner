#!/usr/bin/env node
/**
 * plan.mjs — split a video's audio into numbered chunks, separating the ones
 * that contain dialogue from the ones that are pure silence.
 *
 *   node scripts/plan.mjs            # writes out/plan.json + out/chunks/NNN.mp3
 *
 * Rules:
 *   - a chunk with ANY speech is kept, even a single word
 *   - a chunk with no speech is recorded as speech:false and never extracted
 *     (nothing to send anywhere, it becomes silence on the timeline)
 *   - chunk boundaries fall inside silence, never mid-word
 *   - every chunk covers the timeline contiguously: 0 → duration
 *
 * Speech detection: ffmpeg silencedetect on the decoded audio. Boundaries are
 * refined to word level when whisper word timestamps are supplied via
 * WHISPER_WORDS=<json> (array of [start,end] pairs in seconds).
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FFMPEG, probe, run } from './lib/ff.mjs';
import { CH, SR, materialize, stripExt, videoDurationMs } from './lib/media.mjs';

const env = process.env;
const CFG = {
  input: env.INPUT_VIDEO || env.INPUT_AUDIO || '',
  chunkSeconds: Number(env.CHUNK_SECONDS || 55),
  silenceDb: Number(env.SILENCE_DB || -35),
  minSilence: Number(env.MIN_SILENCE || 0.35),
  mergeGap: Number(env.MERGE_GAP || 0.25),
  minSpeech: Number(env.MIN_SPEECH || 0.15),
  outDir: resolve(env.OUT_DIR || 'out'),
  words: env.WHISPER_WORDS || '',
};

const log = (...a) => console.log('[plan]', ...a);
const r2 = (n) => Math.round(n * 1000) / 1000;

async function durationOf(file) {
  const info = await probe(file);
  try {
    return videoDurationMs(info).seconds;
  } catch {
    const a = (info.streams || []).find((s) => s.codec_type === 'audio');
    if (!a?.duration) throw new Error('cannot determine duration');
    return Number(a.duration);
  }
}

/** Silence intervals via ffmpeg silencedetect. */
async function detectSilence(file, duration) {
  const { err } = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', file,
    '-map', '0:a:0',
    '-af', `silencedetect=noise=${CFG.silenceDb}dB:d=${CFG.minSilence}`,
    '-f', 'null', '-',
  ]);

  const starts = [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => Number(m[1]));

  const sil = [];
  for (let i = 0; i < starts.length; i += 1) {
    const s = Math.max(0, starts[i]);
    const e = ends[i] ?? duration;
    if (e - s >= CFG.minSilence) sil.push([s, Math.min(e, duration)]);
  }
  return sil;
}

/** Complement of silence = speech intervals, with tiny gaps merged away. */
function speechIntervals(silences, duration) {
  const speech = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s > cursor) speech.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < duration) speech.push([cursor, duration]);

  // merge across gaps shorter than mergeGap so we never slice through a word
  const merged = [];
  for (const iv of speech) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] <= CFG.mergeGap) last[1] = iv[1];
    else merged.push([...iv]);
  }
  return merged.filter(([s, e]) => e - s >= CFG.minSpeech);
}

/** Split one speech interval into pieces of at most chunkSeconds. */
function splitInterval([start, end]) {
  if (end - start <= CFG.chunkSeconds) return [[start, end]];
  const pieces = Math.ceil((end - start) / CFG.chunkSeconds);
  const step = (end - start) / pieces;
  return Array.from({ length: pieces }, (_, i) => [start + i * step, i === pieces - 1 ? end : start + (i + 1) * step]);
}

/** Build the contiguous timeline: silence slots + speech chunks. */
function buildTimeline(speech, duration) {
  const segs = [];
  let cursor = 0;

  for (const iv of speech) {
    if (iv[0] > cursor + 0.001) {
      segs.push({ start: r2(cursor), end: r2(iv[0]), speech: false });
    }
    for (const [s, e] of splitInterval(iv)) {
      segs.push({ start: r2(s), end: r2(e), speech: true });
    }
    cursor = iv[1];
  }
  if (cursor < duration - 0.001) {
    segs.push({ start: r2(cursor), end: r2(duration), speech: false });
  }
  return segs;
}

async function main() {
  if (!CFG.input) throw new Error('INPUT_VIDEO (or INPUT_AUDIO) is required');

  // Download first when given a URL: probing a remote file hides the real error
  // (a blocked host just looks like "ffprobe exited null").
  const input = await materialize(CFG.input, join(CFG.outDir, 'src'), 'input');
  if (input !== resolve(CFG.input)) log(`downloaded ${CFG.input}`);

  const duration = await durationOf(input);
  log(`source ${duration.toFixed(3)}s`);

  let speech;
  if (CFG.words) {
    const raw = CFG.words.trim().startsWith('[') ? CFG.words : await readFile(CFG.words, 'utf8');
    const words = JSON.parse(raw);
    speech = speechIntervalsFromWords(words);
    log(`word-level boundaries from ${words.length} words`);
  } else {
    const sil = await detectSilence(input, duration);
    speech = speechIntervals(sil, duration);
    log(`silencedetect: ${sil.length} silent gap(s), ${speech.length} speech region(s)`);
  }

  const timeline = buildTimeline(speech, duration);
  const chunksDir = join(CFG.outDir, 'chunks');
  await mkdir(chunksDir, { recursive: true });

  const segments = [];
  let toSend = 0;
  let speechSeconds = 0;

  for (let i = 0; i < timeline.length; i += 1) {
    const c = timeline[i];
    const index = i;
    const name = String(index).padStart(3, '0');
    const durationSec = r2(c.end - c.start);

    if (!c.speech) {
      segments.push({ index, name, start: c.start, end: c.end, duration: durationSec, speech: false, file: null });
      continue;
    }

    const file = join(chunksDir, `${name}.mp3`);
    await run(FFMPEG, [
      '-y', '-v', 'error',
      '-ss', c.start.toFixed(3), '-t', durationSec.toFixed(3),
      '-i', input,
      '-vn', '-map', '0:a:0',
      '-ar', String(SR), '-ac', String(CH), '-c:a', 'libmp3lame', '-b:a', '192k',
      file,
    ]);

    segments.push({ index, name, start: c.start, end: c.end, duration: durationSec, speech: true, file });
    toSend += 1;
    speechSeconds += durationSec;
  }

  const plan = {
    source: CFG.input,
    local: input === resolve(CFG.input) ? null : input,
    duration: r2(duration),
    settings: { chunkSeconds: CFG.chunkSeconds, silenceDb: CFG.silenceDb, minSilence: CFG.minSilence, mergeGap: CFG.mergeGap, minSpeech: CFG.minSpeech },
    summary: {
      segments: segments.length,
      speech: toSend,
      silence: segments.length - toSend,
      speechSeconds: r2(speechSeconds),
      silenceSeconds: r2(duration - speechSeconds),
      // every project is billed as one minute, whatever its real length
      billedMinutes: toSend,
    },
    segments,
  };

  // Name the plan after the original file, not after the download cache name.
  const baseName = stripExt(/^https?:\/\//i.test(CFG.input)
    ? decodeURIComponent(new URL(CFG.input).pathname.split('/').pop() || 'input')
    : CFG.input);
  const planFile = join(CFG.outDir, `${baseName}.plan.json`);
  await writeFile(planFile, JSON.stringify(plan, null, 2) + '\n', 'utf8');

  log(`segments ${segments.length} → speech ${toSend}, silence ${segments.length - toSend}`);
  log(`speech ${speechSeconds.toFixed(1)}s of ${duration.toFixed(1)}s (billed ${toSend} min)`);
  log(`plan: ${planFile}`);
  log(`chunks: ${chunksDir}`);
}

/** Word timestamps → speech intervals (gaps between words become candidates). */
function speechIntervalsFromWords(words) {
  const iv = words
    .map((w) => (Array.isArray(w) ? w : [w.start, w.end]))
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of iv) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] <= CFG.mergeGap) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.filter(([s, e]) => e - s >= CFG.minSpeech);
}

main().catch((err) => {
  console.error('[plan] FAILED:', err.message);
  process.exit(1);
});
