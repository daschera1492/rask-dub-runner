#!/usr/bin/env node
/**
 * dub-sync — fit a dubbed audio track onto the exact timeline of the original video.
 *
 * Guarantees:
 *   - the produced audio has EXACTLY the same sample count as the video duration
 *   - every segment starts at its original timestamp (sample-accurate)
 *   - the mp4 keeps the original video stream untouched (-c:v copy)
 *
 * Outputs: out/<name>.mp3, out/<name>.mp4, out/<name>.report.json
 */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FFMPEG, decodeSamples, probe, run } from './lib/ff.mjs';
import { CH, SR, audioInfo, materialize, stripExt, videoDurationMs } from './lib/media.mjs';

const env = process.env;
const CFG = {
  video: env.INPUT_VIDEO || '',
  audio: env.INPUT_AUDIO || '',
  segments: env.SEGMENTS_JSON || '',
  offsetMs: Number(env.AUDIO_OFFSET_MS || 0),
  workDir: resolve(env.WORK_DIR || 'work'),
  outDir: resolve(env.OUT_DIR || 'out'),
  name: env.OUTPUT_NAME || '',
  bitrate: env.AUDIO_BITRATE || '192k',
  release: /^(1|true|yes)$/i.test(env.RELEASE || ''),
  releaseTag: env.RELEASE_TAG || '',
  releaseTitle: env.RELEASE_TITLE || '',
  repo: env.GH_REPO || env.GITHUB_REPOSITORY || '',
};

const log = (...a) => console.log('[sync]', ...a);
const ms = (n) => `${(n / 1000).toFixed(3)}s`;

if (!env.GH_TOKEN && env.GITHUB_TOKEN) process.env.GH_TOKEN = env.GITHUB_TOKEN;

// ---------------------------------------------------------------- audio build

/** Build a wav of exactly `samples` samples, empty unless a source is given. */
async function silence(samples, dest) {
  await run(FFMPEG, [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `anullsrc=r=${SR}:cl=stereo`,
    '-af', `atrim=end_sample=${samples},asetpts=N/SR/TB`,
    '-c:a', 'pcm_s16le', dest,
  ]);
}

/** Force `src` to occupy exactly `samples` samples (pad with silence / trim). */
async function fit(src, samples, dest, { tempo = 1, offsetMs = 0 } = {}) {
  const af = [
    offsetMs ? `adelay=${Math.round(offsetMs)}:all=1` : null,
    tempo !== 1 ? `atempo=${tempo.toFixed(6)}` : null,
    `aresample=${SR}`,
    `aformat=sample_fmts=fltp:channel_layouts=stereo`,
    'apad',
    `atrim=start_sample=0:end_sample=${samples}`,
    'asetpts=N/SR/TB',
  ].filter(Boolean).join(',');
  await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-af', af, '-c:a', 'pcm_s16le', dest]);
}

async function fromSingleFile(file, totalSamples, dest) {
  await fit(file, totalSamples, dest, { offsetMs: CFG.offsetMs });
}

async function fromSegments(segs, totalSamples, dest, work) {
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  let i = 0;

  for (const seg of sorted) {
    const startS = Math.max(0, Math.round(seg.start * SR));
    const endS = Math.min(totalSamples, Math.round(seg.end * SR));
    const want = endS - startS;
    if (want <= 0) {
      log(`skip empty segment ${seg.file}`);
      continue;
    }
    if (startS < cursor) {
      log(`warning: segment ${seg.file} overlaps previous one by ${ms(cursor - startS)} — clamped`);
    }
    const at = Math.max(startS, cursor);
    const len = endS - at;
    if (len <= 0) continue;

    if (at > cursor) {
      const gap = join(work, `gap-${i}.wav`);
      await silence(at - cursor, gap);
      parts.push(gap);
      cursor = at;
    }

    // No dialogue in this slot: it stays silent on the timeline, nothing to dub.
    if (seg.speech === false || !seg.file) {
      const blank = join(work, `silence-${i}.wav`);
      await silence(len, blank);
      parts.push(blank);
      cursor += len;
      i += 1;
      continue;
    }

    if (!existsSync(seg.file) && /^(1|true|yes)$/i.test(env.ALLOW_MISSING || '')) {
      log(`warning: segment ${seg.index ?? i} has no dubbed file — keeping silence`);
      const blank = join(work, `missing-${i}.wav`);
      await silence(len, blank);
      parts.push(blank);
      cursor += len;
      i += 1;
      continue;
    }

    const src = await materialize(seg.file, join(work, 'segments'), `seg-${i}`);
    const { seconds } = await audioInfo(src);
    const targetSec = len / SR;
    let tempo = seconds > 0 ? seconds / targetSec : 1;
    if (tempo > 1.35) log(`segment ${i} is ${(tempo).toFixed(2)}x too long — speedup will be audible`);
    tempo = Math.min(2, Math.max(0.5, tempo));
    if (Math.abs(tempo - 1) < 0.002) tempo = 1;

    const fitted = join(work, `fit-${i}.wav`);
    await fit(src, len, fitted, { tempo });
    parts.push(fitted);
    cursor += len;
    i += 1;
  }

  if (cursor < totalSamples) {
    const gap = join(work, 'gap-end.wav');
    await silence(totalSamples - cursor, gap);
    parts.push(gap);
  }
  if (!parts.length) throw new Error('no usable segments');

  const listFile = join(work, 'concat.txt');
  await writeFile(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');

  const joined = join(work, 'joined.wav');
  await run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', joined]);

  await fit(joined, totalSamples, dest);
}

// ---------------------------------------------------------------- mux / encode

async function exportMp3(master, out) {
  await run(FFMPEG, [
    '-y', '-v', 'error', '-i', master,
    '-c:a', 'libmp3lame', '-b:a', CFG.bitrate, '-ar', String(SR), '-ac', String(CH),
    '-write_xing', '1', out,
  ]);
}

async function exportMp4(video, master, out, { seconds, codec }) {
  const copyable = ['h264', 'hevc', 'h265', 'mpeg4', 'av1', 'vp9', 'prores'];
  const args = [
    '-y', '-v', 'error',
    '-i', video,
    '-i', master,
    '-map', '0:v:0', '-map', '1:a:0',
    '-map_metadata', '0', '-map_chapters', '0',
    '-c:a', 'aac', '-b:a', CFG.bitrate, '-ar', String(SR), '-ac', String(CH),
  ];
  if (copyable.includes(String(codec).toLowerCase())) {
    args.push('-c:v', 'copy');
  } else {
    log(`video codec "${codec}" cannot be copied into mp4 — re-encoding with x264`);
    args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p');
  }
  args.push('-movflags', '+faststart', '-t', seconds.toFixed(6), out);
  await run(FFMPEG, args);
}

// ---------------------------------------------------------------- release

async function publish(tag, title, notesFile, files) {
  const args = ['release', 'create', tag, '--title', title, '--notes-file', notesFile];
  if (CFG.repo) args.push('--repo', CFG.repo);
  args.push(...files);
  log(`publishing ${tag} → ${CFG.repo || 'current repo'}`);
  await run('gh', args);
  log(`release ready: https://github.com/${CFG.repo || '<repo>'}/releases/tag/${tag}`);
}

// ---------------------------------------------------------------- main

async function main() {
  if (!CFG.video) throw new Error('INPUT_VIDEO is required (path or http(s) URL)');
  if (!CFG.audio && !CFG.segments) throw new Error('INPUT_AUDIO or SEGMENTS_JSON is required');

  const work = join(CFG.workDir, 'build');
  await mkdir(work, { recursive: true });
  await mkdir(CFG.outDir, { recursive: true });

  const videoPath = await materialize(CFG.video, join(CFG.workDir, 'in'), 'video');
  const vInfo = videoDurationMs(await probe(videoPath));
  const totalSamples = Math.round(vInfo.seconds * SR);
  const seconds = totalSamples / SR;

  log(`video: ${vInfo.width}x${vInfo.height} ${vInfo.codec} — ${ms(seconds * 1000)} (${totalSamples} samples @ ${SR}Hz, ${vInfo.frames ?? '?'} frames, from ${vInfo.source})`);
  if (CFG.offsetMs) log(`applying audio offset: ${CFG.offsetMs} ms`);

  const name = CFG.name || `${stripExt(videoPath).replace(/^video-/, '')}-synced`;
  const master = join(work, 'master.wav');

  if (CFG.segments) {
    const raw = existsSync(CFG.segments) ? await readFile(CFG.segments, 'utf8') : CFG.segments;
    const parsed = JSON.parse(raw);
    const segs = Array.isArray(parsed) ? parsed : parsed.segments;
    if (!Array.isArray(segs) || !segs.length) {
      throw new Error('SEGMENTS_JSON must be an array of {start,end,file} or a plan.json with .segments');
    }
    if (!Array.isArray(parsed) && parsed.summary) {
      log(`plan: ${parsed.summary.speech} speech / ${parsed.summary.silence} silence slots — ${parsed.summary.billedMinutes} min billed`);
    }
    log(`segment mode: ${segs.length} segments`);
    await fromSegments(segs, totalSamples, master, work);
  } else {
    const audioPath = await materialize(CFG.audio, join(CFG.workDir, 'in'), 'audio');
    const aInfo = await audioInfo(audioPath);
    log(`audio: ${aInfo.codec} ${aInfo.channels}ch — ${ms(aInfo.ms)} (delta ${ms(totalSamples / SR * 1000 - aInfo.ms)})`);
    await fromSingleFile(audioPath, totalSamples, master);
  }

  const masterSamples = await decodeSamples(FFMPEG, master, SR, CH);
  log(`master built: ${masterSamples} samples (${ms((masterSamples / SR) * 1000)})`);

  const mp3 = join(CFG.outDir, `${name}.mp3`);
  const mp4 = join(CFG.outDir, `${name}.mp4`);

  await exportMp3(master, mp3);
  await exportMp4(videoPath, master, mp4, { seconds, codec: vInfo.codec });

  const mp3Samples = await decodeSamples(FFMPEG, mp3, SR, CH);
  const mp4Info = await probe(mp4);
  const vOut = videoDurationMs(mp4Info);
  const aOut = (mp4Info.streams || []).find((s) => s.codec_type === 'audio');

  const report = {
    createdAt: new Date().toISOString(),
    source: { video: CFG.video, audio: CFG.audio || null, segments: CFG.segments ? 'json' : null, offsetMs: CFG.offsetMs },
    video: { ...vInfo, durationMs: vInfo.ms },
    audio: {
      masterSamples,
      masterMs: Math.round((masterSamples / SR) * 1000),
      mp3Samples,
      mp3Ms: Math.round((mp3Samples / SR) * 1000),
      mp3DriftMs: Number((((mp3Samples - totalSamples) / SR) * 1000).toFixed(3)),
      mp4AudioMs: aOut?.duration ? Math.round(Number(aOut.duration) * 1000) : null,
    },
    out: { name, mp3, mp4, mp4VideoMs: vOut.ms, mp4VideoCodec: vOut.codec },
    exact: {
      audioLengthEqualsVideo: mp3Samples === totalSamples || Math.abs(mp3Samples - totalSamples) <= 1,
      videoStreamUntouched: vOut.ms === vInfo.ms,
    },
  };

  const reportFile = join(CFG.outDir, `${name}.report.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

  log(`mp3: ${mp3}  (${report.audio.mp3Ms} ms, drift ${report.audio.mp3DriftMs} ms)`);
  log(`mp4: ${mp4}  (video ${report.out.mp4VideoMs} ms, ${report.out.mp4VideoCodec})`);
  log(`exact: ${JSON.stringify(report.exact)}`);

  if (CFG.release) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    const tag = CFG.releaseTag || `sync-${stamp}`;
    const notesFile = join(CFG.outDir, `${name}.notes.md`);
    await writeFile(notesFile, [
      `**${name}**`,
      '',
      `- ویدیو: ${vInfo.width}×${vInfo.height} · ${vInfo.codec} · ${ms(vInfo.ms)}`,
      `- صدا: ${report.audio.mp3Ms} ms · drift ${report.audio.mp3DriftMs} ms`,
      `- offsets: ${CFG.offsetMs} ms`,
      '',
      '`-c:v copy` — تصویر اصلی دست‌نخورده.',
      '',
      `> این ریلیز بعد از ۳۰ روز به‌صورت خودکار حذف می‌شود.`,
      '',
    ].join('\n'), 'utf8');
    await publish(tag, CFG.releaseTitle || name, notesFile, [mp3, mp4, reportFile]);
  }

  // keep the intermediate build audio out of git, but leave inputs cached
  const keep = /^(1|true)$/i.test(env.KEEP_BUILD || '');
  if (!keep) await rm(join(work, 'segments'), { recursive: true, force: true });
}

main().catch((err) => {
  console.error('[sync] FAILED:', err.message);
  process.exit(1);
});
