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
 * Cut one span of the *original* audio into the same MP3 format the dubbed
 * chunks use, so both kinds can be concatenated in one pass.
 *
 * This is what fills the slot of a chunk that was never sent for dubbing: the
 * music and sound effects stay exactly as they were, and the timeline does not
 * move. A silent span simply stays silent.
 *
 * @param {string} input  Source media.
 * @param {number} start  Start in seconds.
 * @param {number} end    End in seconds.
 * @param {string} outFile Destination .mp3.
 * @returns {Promise<string>}
 */
export async function cutOriginalAudio(input, start, end, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const length = Math.max(0.2, end - start);
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', start.toFixed(3),
    '-i', input,
    '-t', length.toFixed(3),
    '-vn',
    '-ac', '2', '-ar', '44100',
    // Same pad/trim as fitChunkAudio: the slot must be exactly as long as the
    // source span, otherwise every following chunk drifts.
    '-af', `apad=whole_dur=${length.toFixed(3)},atrim=0:${length.toFixed(3)}`,
    '-c:a', 'libmp3lame', '-q:a', '2',
    outFile,
  ]);
  return outFile;
}

/**
 * Decide whether one chunk carries dialogue, using Whisper's word timestamps.
 *
 * Returns `null` for hasSpeech when there is no transcription at all, which
 * means "unknown" — the caller must keep sending the chunk, so a missing
 * Whisper never silently drops real speech.
 *
 * @param {Array<{start:number,end:number,word:string}>} words
 * @param {number} start chunk start in seconds
 * @param {number} end chunk end in seconds
 * @param {number} minSpeech seconds of real speech required
 */
export function classifySpeech(words, start, end, minSpeech = 0.4) {
  if (!words || !words.length) return { speech: null, hasSpeech: null };
  const inChunk = words.filter((w) => w.end > start && w.start < end);
  if (!inChunk.length) return { speech: 0, hasSpeech: false };
  // A transcript that is nothing but "Thank you." / "[Music]" is a Whisper
  // hallucination, not dialogue.
  if (isJunkPhrase(inChunk.map((w) => w.word).join(' '))) return { speech: 0, hasSpeech: false };
  const real = inChunk.filter((w) => !isJunkWord(w.word));
  const speech = round(speechSeconds(real, start, end));
  return { speech, hasSpeech: speech >= minSpeech };
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

/**
 * Whisper hallucinates on music and silence (it happily returns "Thank you."
 * for ten seconds of nothing). A word only counts as speech when it is not one
 * of those filler phrases, and a chunk only counts as dialogue when at least
 * MIN_SPEECH_SECONDS of it is real speech.
 */
const JUNK_WORD = /^(thank you|thanks|thanks for watching|please subscribe|subscribe|\[?music\]?|\(music\)|♪+|\.|,|!|\?|-|…)$/i;

function isJunkWord(text) {
  return JUNK_WORD.test(String(text || '').trim());
}

/**
 * Whisper splits its hallucinated filler into separate tokens ("Thank" +
 * "you."), so a per-word check misses it. A chunk whose *entire* transcript is
 * filler therefore gets its own check.
 */
function isJunkPhrase(text) {
  const flat = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return true;
  return /^(?:(?:thank you|thanks|thanks for watching|please subscribe|subscribe|music)\s*)+$/.test(flat);
}

/** Seconds of `words` that fall inside [start, end). Overlap, not word starts. */
function speechSeconds(words, start, end) {
  let total = 0;
  for (const w of words) {
    const from = Math.max(start, w.start);
    const to = Math.min(end, w.end);
    if (to > from) total += to - from;
  }
  return total;
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
  minSpeech = 0.4,
} = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const duration = await probeDuration(input);
  console.log(`[chunk] source duration ${duration.toFixed(2)}s`);

  // Diagnostic path: upload the untouched source as one project, exactly like
  // a human uploading the file on the site.
  if (single) {
    // Unknown, not "no speech": a short file is one chunk and the operator
    // already knows whether it has dialogue, so it is always sent.
    const chunk = {
      index: 0, start: 0, end: round(duration), duration: round(duration),
      path: input, video, speech: null, hasSpeech: null,
    };
    console.log(`[chunk] single untouched file 0.00s - ${duration.toFixed(2)}s`);
    return { duration, chunks: [chunk] };
  }

  let cuts = [];
  // Kept outside the branch on purpose: the per-chunk speech check reuses these
  // exact timestamps, so finding the cut points and knowing which chunks carry
  // dialogue costs a single Whisper pass instead of two.
  let words = [];
  if (duration > hardCap) {
    const wav = path.join(outDir, 'source-16k.wav');
    console.log('[chunk] extracting audio for Whisper');
    await extractForWhisper(input, wav);

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

    // `null` means "unknown" (Whisper never ran, e.g. a short file or a failed
    // pip install); those chunks are still sent, so behaviour is unchanged.
    const { speech, hasSpeech } = classifySpeech(words, start, end, minSpeech);

    chunks.push({
      index: i, start: round(start), end: round(end), duration: round(end - start),
      path: file, video, speech, hasSpeech,
    });
    const tag = hasSpeech === false ? ' (no dialogue - not uploaded)' : hasSpeech === null ? ' (speech unknown)' : '';
    console.log(`[chunk] #${i} ${start.toFixed(2)}s - ${end.toFixed(2)}s (${(end - start).toFixed(2)}s, speech ${speech === null ? '?' : speech.toFixed(2)}s)${tag}`);
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
  if (Math.abs(diff) <= 0.05) {
    // The dub already matches its span. It still has to be materialised as
    // `outFile`: the raw file is an intermediate that the CI artifact excludes,
    // so returning `input` used to drop the chunk from the shard upload even
    // though Rask had dubbed it successfully.
    fs.copyFileSync(input, outFile);
    return outFile;
  }

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

/**
 * Pull the dubbed track out of the MP4 Rask returns.
 *
 * The returned "video" is a placeholder picture plus the dubbed audio, so the
 * picture is dropped and only the audio survives. Encoding here is lossless
 * enough (q2) and, more importantly, gives `fitChunkAudio` a file it can probe.
 */
export async function extractAudioFromMp4(mp4, outMp3) {
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });
  await sh('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outMp3]);
  return outMp3;
}

/** Generate a silent MP3 of an exact length (only when ON_FAIL=silence). */
export async function silenceMp3(seconds, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  // Same format as every other piece (44.1 kHz stereo), otherwise a mixed
  // concat is at the mercy of the demuxer.
  await sh('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', seconds.toFixed(3),
    '-c:a', 'libmp3lame', '-q:a', '2',
    outFile,
  ]);
  return outFile;
}

/* Common output format for every piece of the final track. */
const TRACK_FORMAT = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';

/**
 * Concatenate the timeline into ONE track, sample-accurately.
 *
 * The old path concatenated MP3 files, and every MP3 encode pads its last frame
 * to a 1152-sample boundary (~26 ms at 44.1 kHz). That error is always positive,
 * so it accumulated: 46 chunks came out 0.92 s longer than the source and the
 * audio drifted behind the picture.
 *
 * Here each piece is decoded, forced to the exact slot length (`apad`+`atrim`),
 * trimmed to its own timestamps and joined in the filter graph, and the result is
 * encoded to MP3 exactly once. Slot lengths sum to the source duration, so the
 * muxed track lines up with the video from the first frame to the last.
 *
 * @param {Array<{path:string, duration:number}>} pieces
 * @param {string} outMp3
 */
export async function concatTrack(pieces, outMp3) {
  if (!pieces.length) throw new Error('concatTrack: nothing to concatenate');
  fs.mkdirSync(path.dirname(outMp3), { recursive: true });

  const args = ['-y', '-v', 'error'];
  for (const piece of pieces) args.push('-i', piece.path);

  const filters = pieces.map((piece, i) => (
    `[${i}:a]${TRACK_FORMAT},apad,atrim=0:${Math.max(0.05, piece.duration).toFixed(3)},asetpts=PTS-STARTPTS[p${i}]`
  ));
  const labels = pieces.map((_, i) => `[p${i}]`).join('');
  filters.push(`${labels}concat=n=${pieces.length}:v=0:a=1[out]`);

  await sh('ffmpeg', [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
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
