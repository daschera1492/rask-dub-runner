/**
 * ffmpeg/ffprobe helpers: chunking at silence boundaries, merging, remuxing.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sh(cmd, args, { timeoutMs = 0, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 || allowFail) return resolve({ code, stdout, stderr });
      reject(new Error(`${cmd} exited ${code}: ${stderr.split('\n').slice(-8).join(' | ')}`));
    });
  });
}

export async function probeDuration(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ]);
  const value = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`cannot read duration of ${file}`);
  return value;
}

/** Extract a mono 16 kHz WAV for Whisper. */
export async function extractForWhisper(input, outWav) {
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  await sh('ffmpeg', ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
  return outWav;
}

/**
 * Lay per-subtitle voice clips on a timeline and mix them into one track.
 * This mirrors what the vosko editor does in the browser for the standard
 * pipeline, where each subtitle owns its own TTS file.
 *
 * When `bedPath` is given, that track (the site's `original_bgm_url`, i.e. the
 * original audio with the source voice removed) is mixed underneath the voice
 * clips. Without it the output contains speech only and loses all music and
 * sound effects, which is the bug this option fixes.
 *
 * @param {Array<{path:string, offset:number}>} clips
 * @param {number} totalSeconds
 * @param {string} outPath
 * @param {{bedPath?:string, bedGain?:number}} [opts]
 */
export async function mixSegmentAudio(clips, totalSeconds, outPath, { bedPath = '', bedGain = 1 } = {}) {
  if (!clips.length && !bedPath) throw new Error('mixSegmentAudio: no clips and no background bed');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const total = Math.max(0.1, Number(totalSeconds) || 0);
  const gain = Number.isFinite(Number(bedGain)) ? Math.max(0, Number(bedGain)) : 1;

  const args = ['-y', '-v', 'error'];
  for (const clip of clips) args.push('-i', clip.path);
  const bedIndex = bedPath ? clips.length : -1;
  if (bedPath) args.push('-i', bedPath);

  const filters = [];
  const mixLabels = [];

  clips.forEach((clip, i) => {
    const delay = Math.max(0, Math.round(clip.offset * 1000));
    filters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `adelay=${delay}:all=1[a${i}]`,
    );
    mixLabels.push(`[a${i}]`);
  });

  if (bedPath) {
    filters.push(
      `[${bedIndex}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,` +
        `volume=${gain},atrim=0:${total.toFixed(3)}[bed]`,
    );
    mixLabels.push('[bed]');
  }

  filters.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:dropout_transition=0,` +
      `alimiter=limit=0.95[mix]`,
  );
  filters.push(`[mix]apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[out]`);

  await sh('ffmpeg', [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'libmp3lame', '-q:a', '2',
    outPath,
  ]);
  return outPath;
}

/** First audio codec of a file (empty when it has no audio stream). */
async function audioCodec(file) {
  const { stdout } = await sh('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'json',
    file,
  ]);
  return JSON.parse(stdout || '{}').streams?.[0]?.codec_name || '';
}

/** Containers that can hold a stream-copied audio bitstream. */
const COPY_EXT = {
  aac: '.m4a',
  mp3: '.mp3',
  flac: '.flac',
  alac: '.m4a',
  pcm_s16le: '.wav',
  pcm_s24le: '.wav',
  pcm_s32le: '.wav',
  pcm_f32le: '.wav',
};

/**
 * Cut one span out of the original media.
 *
 * For video sources the *video file itself* is uploaded, exactly like a human
 * uploading to the site: the site clones the voice from the audio track and
 * uses the picture for speaker/emotion analysis. The audio bitstream is always
 * stream-copied, never re-encoded or downmixed, so the voice reference stays
 * bit-for-bit original. Only the video frames are re-encoded, because arbitrary
 * speech boundaries are not keyframes; CRF 18 is visually lossless.
 *
 * Whisper works on a separate 16 kHz mono copy (`extractForWhisper`); that copy
 * is only used to find cut points and is never uploaded.
 *
 * @param {string} input   Source media.
 * @param {number} start   Start in seconds.
 * @param {number} end     End in seconds.
 * @param {string} outBase Output path without an extension.
 * @param {{video?:boolean}} opts Upload a video chunk when the source has video.
 * @returns {Promise<string>} The written file (extension chosen by codec).
 */
export async function cutChunk(input, start, end, outBase, { video = false } = {}) {
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const length = Math.max(0.2, end - start);

  if (video) {
    // Accurate cut + untouched audio. Video is re-encoded only at the cut
    // points; `-ss` before `-i` makes the start frame-exact.
    const out = outBase + '.mp4';
    const common = [
      '-y', '-v', 'error',
      '-ss', start.toFixed(3),
      '-i', input,
      '-t', length.toFixed(3),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    ];
    const copied = await sh('ffmpeg', [...common, '-c:a', 'copy', '-movflags', '+faststart', out], { allowFail: true });
    if (copied.code === 0) {
      console.log(`[chunk] cut ${start.toFixed(2)}-${end.toFixed(2)}s (video + original audio copy)`);
      return out;
    }
    console.warn('[chunk] audio copy into MP4 failed; encoding AAC 192k instead of degrading to mono');
    await sh('ffmpeg', [
      ...common,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', out,
    ]);
    return out;
  }

  const codec = await audioCodec(input);
  const ext = COPY_EXT[codec];

  if (ext) {
    const out = outBase + ext;
    const cut = await sh(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-ss', start.toFixed(3),
        '-i', input,
        '-t', length.toFixed(3),
        '-map', '0:a:0',
        '-c:a', 'copy',
        out,
      ],
      { allowFail: true }
    );
    if (cut.code === 0) {
      const have = await probeDuration(out).catch(() => 0);
      // Stream copy lands on packet boundaries; allow ~50 ms of slack.
      if (have >= Math.min(length - 0.05, length * 0.95)) {
        console.log(`[chunk] cut ${start.toFixed(2)}-${end.toFixed(2)}s (${codec} copy, no re-encode)`);
        return out;
      }
      console.warn(`[chunk] ${codec} copy produced ${have.toFixed(2)}s of ${length.toFixed(2)}s; re-encoding`);
    } else {
      console.warn(`[chunk] ${codec} copy failed; re-encoding`);
    }
  }

  // Rare codecs / broken timestamps: encode once at full quality, still stereo
  // and 48 kHz, so the voice reference is not degraded like the old mono WAV.
  const out = outBase + '.m4a';
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', start.toFixed(3),
    '-i', input,
    '-t', length.toFixed(3),
    '-vn',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    out,
  ]);
  console.log(`[chunk] cut ${start.toFixed(2)}-${end.toFixed(2)}s (aac 192k fallback)`);
  return out;
}

/**
 * Word timestamps from Whisper (Python CLI bridge).
 * @returns {Promise<Array<{start:number,end:number,word:string}>>}
 */
export async function whisperWords(wavPath, { model = 'base', language = 'Auto' } = {}) {
  const outJson = wavPath.replace(/\.wav$/i, '') + '.words.json';
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, 'whisper_words.py');
  const py = process.env.PYTHON || 'python3';
  await sh(py, [script, model, wavPath, outJson, language], { timeoutMs: 60 * 60 * 1000 });
  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  return Array.isArray(parsed.words) ? parsed.words : [];
}

function planCuts(words, duration, maxSeconds, hardCap, minChunk = 8) {
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap >= 0.3) {
      gaps.push({ t: words[i].end + Math.min(0.2, gap / 2), gap });
    }
  }
  gaps.sort((a, b) => a.t - b.t);

  const cuts = [];
  let cursor = 0;
  let guard = 0;
  while (duration - cursor > maxSeconds && guard++ < 500) {
    const inside = gaps.filter((g) => g.t > cursor + minChunk && g.t <= cursor + maxSeconds);
    const overrun = gaps.filter((g) => g.t > cursor + maxSeconds && g.t <= cursor + hardCap);
    let cut;
    if (inside.length) {
      // Prefer a clear pause (>=0.7s) over a barely-there 0.3s gap, so we never
      // split a sentence when a better boundary exists in the same window.
      const clear = inside.filter((g) => g.gap >= 0.7);
      const pool = clear.length ? clear : inside;
      cut = pool[pool.length - 1].t;
    } else if (overrun.length) {
      cut = overrun[0].t;
    } else {
      cut = cursor + maxSeconds;
    }
    if (cut <= cursor + 0.5) break;
    cuts.push(cut);
    cursor = cut;
  }
  return cuts;
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Split media into <=hardCap chunks, cutting in silences whenever possible.
 * @returns {Promise<{duration:number,chunks:Array<{index:number,start:number,end:number,duration:number,path:string}>}>}
 */
export async function buildChunks(input, outDir, {
  maxSeconds = 52,
  hardCap = 58,
  padSeconds = 0,
  whisperModel = 'base',
  sourceLanguage = 'Auto',
  video = false,
  single = false,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const duration = await probeDuration(input);
  console.log(`[chunk] source duration ${duration.toFixed(2)}s`);

  // Diagnostic path: upload the untouched source as one project, exactly like
  // a human uploading the file on the site.
  if (single) {
    const chunk = { index: 0, start: 0, end: round(duration), duration: round(duration), path: input, video };
    console.log(`[chunk] single untouched file 0.00s - ${duration.toFixed(2)}s`);
    return { duration, chunks: [chunk] };
  }

  let cuts = [];
  if (duration > hardCap) {
    const wav = path.join(outDir, 'source-16k.wav');
    console.log('[chunk] extracting audio for Whisper');
    await extractForWhisper(input, wav);

    let words = [];
    try {
      console.log(`[chunk] Whisper (${whisperModel}) word timestamps`);
      words = await whisperWords(wav, { model: whisperModel, language: sourceLanguage });
      console.log(`[chunk] ${words.length} words, language=${sourceLanguage}`);
    } catch (err) {
      console.warn(`[chunk] Whisper failed (${err.message}); falling back to silencedetect`);
    }

    if (words.length >= 3) {
      cuts = planCuts(words, duration, maxSeconds, hardCap);
    } else {
      cuts = await silencedetectCuts(input, duration, maxSeconds, hardCap);
    }
    console.log(`[chunk] planned cuts: ${cuts.map((c) => c.toFixed(2)).join(', ') || '(none)'}`);
  }

  // Merge a too-short tail into the previous chunk.
  while (cuts.length) {
    const lastStart = cuts.length > 1 ? cuts[cuts.length - 2] : 0;
    if (duration - cuts[cuts.length - 1] < 3 && duration - lastStart <= hardCap) cuts.pop();
    else break;
  }

  const bounds = [0, ...cuts, duration];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    let start = Math.max(0, bounds[i] - (i === 0 ? 0 : padSeconds));
    let end = Math.min(duration, bounds[i + 1] + (i === bounds.length - 2 ? 0 : padSeconds));
    if (end - start > hardCap + 0.5) end = start + hardCap;
    const file = await cutChunk(input, start, end, path.join(outDir, `chunk-${String(i).padStart(3, '0')}`), { video });
    chunks.push({ index: i, start: round(start), end: round(end), duration: round(end - start), path: file, video });
    console.log(`[chunk] #${i} ${start.toFixed(2)}s - ${end.toFixed(2)}s (${(end - start).toFixed(2)}s)`);
  }
  return { duration, chunks };
}

/** Fallback: cut at the middle of detected silences. */
async function silencedetectCuts(input, duration, maxSeconds, hardCap) {
  const { stderr } = await sh('ffmpeg', [
    '-v', 'info', '-i', input, '-vn',
    '-af', 'silencedetect=noise=-35dB:d=0.3',
    '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
  ]);
  const silences = [];
  let current = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (s) current = Number.parseFloat(s[1]);
    if (e && current !== null) {
      silences.push((current + Number.parseFloat(e[1])) / 2);
      current = null;
    }
  }
  const cuts = [];
  let cursor = 0;
  while (duration - cursor > maxSeconds) {
    const inside = silences.filter((t) => t > cursor + 8 && t <= cursor + maxSeconds);
    const overrun = silences.filter((t) => t > cursor + maxSeconds && t <= cursor + hardCap);
    const cut = inside.length ? inside[inside.length - 1] : overrun.length ? overrun[0] : cursor + maxSeconds;
    if (cut <= cursor + 0.5) break;
    cuts.push(cut);
    cursor = cut;
  }
  return cuts;
}

/**
 * Fit a dubbed chunk back onto its original span.
 *
 * The site re-times each chunk: it trims leading/trailing silence, so the MP3
 * is almost never exactly `seconds` long. If shorter we pad with silence; if
 * longer we speed it up slightly (pitch-preserving atempo) and only cut the
 * tail when the overflow is too large to stretch. This keeps every chunk
 * boundary aligned with the source timeline, which is what video muxing needs.
 */
export async function fitChunkAudio(input, outFile, seconds, { index = 0 } = {}) {
  const have = await probeDuration(input);
  const diff = have - seconds;
  if (Math.abs(diff) <= 0.05) return input;

  const filters = [];
  if (diff > 0) {
    const ratio = have / seconds;
    const tempo = Math.min(1.3, ratio);
    filters.push(`atempo=${tempo.toFixed(4)}`);
    if (ratio > 1.3) {
      console.warn(
        `[fit] chunk ${index}: dub is ${(diff).toFixed(2)}s longer than its span; ` +
          `speeding up ${(tempo * 100).toFixed(0)}% and trimming the tail`
      );
    } else {
      console.log(`[fit] chunk ${index}: speeding up ${(tempo * 100 - 100).toFixed(1)}% to fit ${seconds.toFixed(2)}s`);
    }
  } else {
    console.log(`[fit] chunk ${index}: padding ${(-diff).toFixed(2)}s of silence`);
  }

  filters.push(`apad=whole_dur=${seconds.toFixed(3)}`, `atrim=0:${seconds.toFixed(3)}`);

  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-i', input,
    '-af', filters.join(','),
    '-c:a', 'libmp3lame', '-q:a', '2',
    outFile,
  ]);
  return outFile;
}

/** Generate a silent MP3 of an exact length (placeholder for failed chunks). */
export async function silenceMp3(seconds, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
    '-t', seconds.toFixed(3),
    '-c:a', 'libmp3lame', '-q:a', '2',
    outFile,
  ]);
  return outFile;
}

/** Re-encode and concatenate dubbed MP3 chunks with tiny fades. */export async function concatDubbed(mp3Paths, outMp3) {
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });
  const listFile = outMp3.replace(/\.mp3$/i, '') + '.txt';
  fs.writeFileSync(listFile, mp3Paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:a', 'libmp3lame', '-q:a', '2',
    outMp3,
  ]);
  return outMp3;
}

/** Mux the dubbed audio onto the original video (stream copy), else keep audio. */
export async function assembleFinal({ input, dubbedAudio, outFile, isVideo }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  if (!isVideo) {
    await sh('ffmpeg', ['-y', '-v', 'error', '-i', dubbedAudio, '-c:a', 'libmp3lame', '-q:a', '2', outFile]);
    return outFile;
  }
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-i', input,
    '-i', dubbedAudio,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-af', 'apad',
    '-movflags', '+faststart',
    '-shortest',
    outFile,
  ]);
  return outFile;
}
