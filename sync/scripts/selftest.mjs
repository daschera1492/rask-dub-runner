#!/usr/bin/env node
/**
 * Proves the exactness claims on synthetic media, locally.
 *   npm run selftest
 *
 * Checks, for both a shorter and a longer source audio:
 *   - decoded mp3 sample count  == video sample count
 *   - decoded mp4 audio samples == video sample count
 *   - mp4 video stream is byte-identical in duration/frame count to the source
 */
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FFMPEG, decodeSamples, probe, run } from './lib/ff.mjs';
import { CH, SR, videoDurationMs } from './lib/media.mjs';

const work = resolve('work/selftest');
const outDir = resolve('out/selftest');

const log = (...a) => console.log('[selftest]', ...a);
const fail = (msg) => { console.error(`[selftest] FAIL: ${msg}`); process.exitCode = 1; };

async function sync(env) {
  await run(process.execPath, ['scripts/sync.mjs']);
  return env;
}

async function main() {
  await rm(work, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const video = join(work, 'video.mp4');
  await run(FFMPEG, ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=12.345',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12.345',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);

  const src = await probe(video);
  const v = videoDurationMs(src);
  const expected = Math.round(v.seconds * SR);
  log(`video ${v.frames} frames @ ${v.ms}ms → ${expected} samples`);

  const cases = [
    { name: 'short', audio: 'sine=frequency=660:duration=9' },
    { name: 'long', audio: 'sine=frequency=880:duration=15' },
    { name: 'offset', audio: 'sine=frequency=555:duration=9', offset: '1500' },
  ];

  for (const c of cases) {
    const audio = join(work, `${c.name}.mp3`);
    await run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', c.audio, '-c:a', 'libmp3lame', audio]);

    Object.assign(process.env, {
      INPUT_VIDEO: video,
      INPUT_AUDIO: audio,
      SEGMENTS_JSON: '',
      OUTPUT_NAME: c.name,
      OUTPUT_DIR: outDir,
      OUT_DIR: outDir,
      AUDIO_OFFSET_MS: c.offset || '0',
      RELEASE: 'false',
    });
    await sync(process.env);

    const mp3 = join(outDir, `${c.name}.mp3`);
    const mp4 = join(outDir, `${c.name}.mp4`);

    const mp3Samples = await decodeSamples(FFMPEG, mp3, SR, CH);
    const rawMp4 = join(work, `${c.name}.raw`);
    await run(FFMPEG, ['-y', '-v', 'error', '-i', mp4, '-map', '0:a:0', '-f', 's16le', '-ac', String(CH), '-ar', String(SR), rawMp4]);
    const { size } = await stat(rawMp4);
    const mp4Samples = size / (2 * CH);
    const outV = videoDurationMs(await probe(mp4));

    const okMp3 = mp3Samples === expected;
    const okMp4 = mp4Samples === expected;
    const okVideo = outV.frames === v.frames && Math.abs(outV.seconds - v.seconds) < 1e-6;

    log(`${c.name.padEnd(7)} mp3=${mp3Samples} mp4audio=${mp4Samples} expected=${expected} ` +
      `video=${outV.frames}/${v.frames} → ${okMp3 && okMp4 && okVideo ? 'OK' : 'MISMATCH'}`);

    if (!okMp3) fail(`${c.name}: mp3 has ${mp3Samples} samples, expected ${expected}`);
    if (!okMp4) fail(`${c.name}: mp4 audio has ${mp4Samples} samples, expected ${expected}`);
    if (!okVideo) fail(`${c.name}: video stream changed (${outV.frames} vs ${v.frames} frames)`);
  }

  if (!process.exitCode) log('all guarantees hold');
}

main().catch((e) => { console.error('[selftest] FAILED:', e.message); process.exit(1); });
