/**
 * The three stages, shared by the standalone runner and the split workflow.
 *
 *   prepare()  source → plan.json + cut audio chunks (+ Whisper speech map)
 *   dubPlan()  dub the chunks of one shard, persist work/dub/*
 *   merge()    assemble the timeline, mux, write out/{mp4,mp3}
 *
 * Standalone (`node scripts/run.mjs`) calls all three in one process; the
 * workflow runs prepare once, one dub job per shard, then merge once.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as proxy from './proxy.mjs';
import { buildChunks, probeDuration, concatTrack, assembleFinal, silenceMp3 } from './media.mjs';
import { loadPlan, savePlan, assignShards } from './plan.mjs';
import { dubQueue, chunkName, planFile, dubbedFile } from './dub.mjs';
import { log, warn, setOutput, summary, formatSeconds } from './report.mjs';
import * as media from './media.mjs';
import { isYouTube, downloadYoutube, cookieJar } from './youtube.mjs';

export { loadPlan };

const inputName = (value) => (path.basename(String(value).split('?')[0]) || 'input.mp4')
  .replace(/[^A-Za-z0-9_.\-]/g, '_');

/**
 * Local path, download the URL once into WORK_DIR, or resolve a YouTube link
 * with yt-dlp (which is the only supported way to turn a watch page into a
 * file). Both prepare and merge call this, so the download is cached by name
 * and each stage gets the same path.
 */
export async function resolveInput(cfg) {
  if (!cfg.input) throw new Error('INPUT_URL (or a local path) is required');
  if (fs.existsSync(cfg.input)) return path.resolve(cfg.input);
  if (!/^https?:\/\//i.test(cfg.input)) throw new Error(`input not found: ${cfg.input}`);

  if (isYouTube(cfg.input)) {
    return downloadYoutube(cfg.input, {
      workDir: cfg.workDir,
      cookies: cookieJar(cfg),
      ytdlp: cfg.ytdlp,
      format: cfg.ytFormat,
      extra: cfg.ytdlpArgs,
      log,
    });
  }

  fs.mkdirSync(cfg.workDir, { recursive: true });
  const dest = path.join(cfg.workDir, inputName(cfg.input));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) {
    log(`[input] reusing ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
    return dest;
  }

  log(`[input] downloading ${cfg.input}`);
  const res = spawnSync('curl', [
    '-L', '--fail', '--retry', '3', '--retry-delay', '3', '-o', dest, cfg.input,
  ], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`download failed (curl exit ${res.status})`);
  return dest;
}

export async function hasVideoStream(file) {
  const { stdout } = await media.sh('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file,
  ]);
  return stdout.trim().includes('video');
}

function stateKey(plan) {
  return `${plan.input}:${Math.round(plan.duration)}:${plan.target}:${plan.chunkSeconds}`;
}

function loadState(cfg, key) {
  try {
    const state = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (state.key === key) return state;
  } catch { /* fresh */ }
  return { key, chunks: {} };
}

function saveState(cfg, state = {}) {
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
  // `JSON.stringify(undefined)` is undefined, and writing that throws a very
  // confusing "data argument must be of type string" error from inside fs.
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ chunks: {}, ...state }, null, 2));
}

/* ------------------------------------------------------------------ */
/* Stage 1 — prepare                                                   */
/* ------------------------------------------------------------------ */

export async function prepare(cfg) {
  proxy.assertConfigured();
  log(`[proxy] ${proxy.status()}`);

  const input = await resolveInput(cfg);
  const isVideo = await hasVideoStream(input);

  const { duration, chunks } = await buildChunks(input, cfg.chunksDir, {
    maxSeconds: cfg.chunkSeconds,
    hardCap: cfg.hardCap,
    video: false,
    // Always chunk: Rask refuses anything longer than a minute, and every
    // project is billed as a full minute, so a long file must be split even when
    // the source has no picture.
    single: false,
    minSpeech: cfg.minSpeech,
    whisperModel: cfg.whisperModel,
  });

  const planChunks = cfg.maxChunks ? chunks.slice(0, cfg.maxChunks) : chunks;
  if (planChunks.length !== chunks.length) {
    log(`[plan] diagnostic cap: ${planChunks.length}/${chunks.length} chunks`);
  }

  const sharding = assignShards(planChunks, cfg.runners);

  const plan = {
    version: 2,
    createdAt: new Date().toISOString(),
    input: path.basename(input),
    inputPath: input,
    duration,
    isVideo,
    target: cfg.target,
    chunkSeconds: cfg.chunkSeconds,
    onFail: cfg.onFail,
    runners: sharding.shards,
    assign: sharding.assign,
    chunks: planChunks.map((chunk) => ({
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      duration: chunk.duration,
      file: path.relative(cfg.workDir, chunk.path),
      speech: chunk.speech,
      hasSpeech: chunk.hasSpeech,
    })),
  };

  savePlan(cfg.workDir, plan);

  const silent = planChunks.filter((c) => c.hasSpeech === false).length;
  log(`[plan] ${planChunks.length} chunk(s), target ${cfg.target}, ${isVideo ? 'video' : 'audio'} source ${duration.toFixed(2)}s`);
  log(`[plan] ${silent} chunk(s) without dialogue (not uploaded)`);
  log(`[plan] split over ${sharding.shards} runner(s): ${sharding.assign.map((a) => `#${a.shard}=${a.items.length}`).join(', ')}`);

  setOutput('duration', duration.toFixed(2));
  setOutput('chunks', String(planChunks.length));
  setOutput('is_video', String(isVideo));
  setOutput('shards', JSON.stringify(sharding.assign.map((a) => a.shard)));
  setOutput('silent_chunks', String(silent));

  summary([
    '## Prepare',
    '',
    '| field | value |',
    '| --- | --- |',
    `| source | \`${plan.input}\` |`,
    `| duration | ${formatSeconds(duration)} |`,
    `| chunks | ${planChunks.length} |`,
    `| no dialogue | ${silent} |`,
    `| runners | ${sharding.shards} |`,
    `| target | ${cfg.target} |`,
  ].join('\n'));

  return plan;
}

/* ------------------------------------------------------------------ */
/* Stage 2 — dub one shard                                             */
/* ------------------------------------------------------------------ */

export async function dubPlan(cfg, plan, { shard = cfg.shard } = {}) {
  const assignment = shard === null
    ? null
    : plan.assign?.find((entry) => entry.shard === shard);

  if (shard !== null && !assignment) {
    throw new Error(`plan has no shard ${shard} (it was built for ${plan.runners} runner(s))`);
  }

  const indices = new Set(assignment ? assignment.items : plan.chunks.map((chunk) => chunk.index));
  const chunks = plan.chunks.filter((chunk) => indices.has(chunk.index));

  const state = loadState(cfg, stateKey(plan));
  const label = shard === null ? 'all' : `shard ${shard}`;

  // Chunks with no dialogue cost nothing: the original audio is put back at
  // merge time. Record them so a re-run skips them too.
  let skipped = 0;
  if (cfg.skipSilent) {
    for (const chunk of chunks) {
      if (chunk.hasSpeech !== false || state.chunks[chunk.index]) continue;
      state.chunks[chunk.index] = {
        skipped: true,
        reason: 'no dialogue',
        start: chunk.start,
        end: chunk.end,
        duration: chunk.duration,
      };
      skipped += 1;
    }
    if (skipped) saveState(cfg, state);
  }

  const pending = chunks.filter((chunk) => {
    const saved = state.chunks[chunk.index];
    if (saved?.skipped) return false;
    return !dubbedFile(cfg.workDir, chunk.index);
  });

  log(`[plan] ${label}: ${chunks.length} chunk(s), ${pending.length} left to dub`
    + `${skipped ? `, ${skipped} without dialogue` : ''}`);

  const result = pending.length
    ? await dubQueue({ chunks: pending, cfg, workDir: cfg.workDir, state, saveState: () => saveState(cfg, state) })
    : { accountsOpened: 0, attempts: 0, failures: [] };

  const totalDubbed = chunks.filter((chunk) => dubbedFile(cfg.workDir, chunk.index)).length;
  const missing = chunks
    .filter((chunk) => !dubbedFile(cfg.workDir, chunk.index) && chunk.hasSpeech !== false)
    .map((chunk) => chunk.index);

  const report = {
    shard,
    chunks: chunks.length,
    dubbed: totalDubbed,
    missing,
    accounts: result.accountsOpened,
    attempts: result.attempts,
    failures: result.failures,
    at: new Date().toISOString(),
  };

  fs.mkdirSync(cfg.reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfg.reportsDir, `shard-${shard === null ? 'all' : shard}.json`),
    JSON.stringify(report, null, 2),
  );

  log(`[dub] ${label}: ${totalDubbed}/${chunks.length} dubbed on ${result.accountsOpened} account(s)`
    + `${missing.length ? `, still missing: ${missing.join(', ')}` : ''}`);

  setOutput('shard', String(shard ?? 'all'));
  setOutput('dubbed', String(totalDubbed));
  setOutput('accounts', String(result.accountsOpened));
  setOutput('missing', missing.join(','));
  summary([
    `## Dub ${label}`,
    '',
    `- chunks: ${chunks.length}`,
    `- dubbed: ${totalDubbed}`,
    `- accounts: ${result.accountsOpened}`,
    `- still missing: ${missing.length ? missing.join(', ') : '—'}`,
    ...result.failures.map(([index, message]) => `- chunk ${index}: ${message}`),
  ].join('\n'));

  return report;
}

/* ------------------------------------------------------------------ */
/* Stage 3 — merge                                                     */
/* ------------------------------------------------------------------ */

/**
 * Collect every piece of the timeline and mux it back onto the source.
 *
 * Priority per chunk: a finished dub → the original audio (chunk without
 * dialogue, or a dub that never succeeded) → silence/abort, depending on
 * ON_FAIL. The default keeps the original audio, so a failed chunk sounds like
 * the source instead of leaving dead air.
 */
export async function merge(cfg, plan) {
  const pieces = [];
  const holes = [];
  const stats = { dubbed: 0, original: 0, silent: 0 };

  const input = plan.isVideo ? await resolveInput(cfg) : null;

  for (const chunk of plan.chunks) {
    const dubbed = dubbedFile(cfg.workDir, chunk.index);
    if (dubbed) {
      pieces.push({ path: dubbed, duration: chunk.duration });
      stats.dubbed += 1;
      continue;
    }

    const source = planFile(cfg.workDir, chunk.file);

    if (chunk.hasSpeech === false) {
      pieces.push({ path: source, duration: chunk.duration });
      stats.original += 1;
      log(`[mix] ${chunkName(chunk.index)}: no dialogue — original audio kept`);
      continue;
    }

    if (cfg.onFail === 'original') {
      pieces.push({ path: source, duration: chunk.duration });
      stats.original += 1;
      log(`[mix] ${chunkName(chunk.index)}: dub missing — original audio kept`);
      continue;
    }

    if (cfg.onFail === 'silence') {
      const blank = path.join(cfg.dubDir, `${chunkName(chunk.index)}-silence.mp3`);
      if (!fs.existsSync(blank)) await silenceMp3(chunk.duration, blank);
      pieces.push({ path: blank, duration: chunk.duration });
      stats.silent += 1;
      log(`[mix] ${chunkName(chunk.index)}: dub missing — silence (ON_FAIL=silence)`);
      continue;
    }

    holes.push(chunk.index);
  }

  if (holes.length) {
    throw new Error(
      `chunk(s) ${holes.join(', ')} have no dub (ON_FAIL=${cfg.onFail}); `
      + 're-run with ON_FAIL=original to keep the source audio for them',
    );
  }

  // ON_FAIL=original keeps a *few* failed chunks alive, but a mix with no dub at
  // all is just the source audio. That is what a cancelled dub stage produces,
  // and it must never be published as a "Dub → <language>" release.
  const hasDialogue = plan.chunks.some((chunk) => chunk.hasSpeech !== false);
  if (hasDialogue && stats.dubbed === 0) {
    throw new Error('no chunk was dubbed — refusing to publish the undubbed source as a dub');
  }

  log(`[mix] ${pieces.length} piece(s): ${stats.dubbed} dubbed, ${stats.original} original audio, ${stats.silent} silence`);
  await concatTrack(pieces, cfg.trackFile);

  const trackDuration = await probeDuration(cfg.trackFile);
  log(`[mix] dubbed track ${trackDuration.toFixed(2)}s (source ${plan.duration.toFixed(2)}s)`);
  if (Math.abs(trackDuration - plan.duration) > 0.5) {
    warn(`[mix] track is ${(trackDuration - plan.duration).toFixed(2)}s off the source timeline`);
  }

  fs.mkdirSync(cfg.outDir, { recursive: true });
  const stem = cfg.outputName
    ? cfg.outputName.replace(/\.[^.]+$/, '')
    : `${path.basename(plan.input, path.extname(plan.input))}-${plan.target}`;

  // Always publish the dubbed audio track on its own; the video is a bonus.
  const outMp3 = path.join(cfg.outDir, `${stem}.mp3`);
  fs.copyFileSync(cfg.trackFile, outMp3);

  let outMp4 = null;
  if (plan.isVideo) {
    outMp4 = path.join(cfg.outDir, `${stem}.mp4`);
    await assembleFinal({ input, dubbedAudio: cfg.trackFile, outFile: outMp4, isVideo: true });
  }

  const finalDuration = outMp4 ? await probeDuration(outMp4) : trackDuration;
  const mb = (file) => (fs.statSync(file).size / 1024 / 1024).toFixed(2);

  const reports = fs.existsSync(cfg.reportsDir)
    ? fs.readdirSync(cfg.reportsDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(cfg.reportsDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean)
    : [];
  const accounts = reports.reduce((sum, r) => sum + (r.accounts || 0), 0);

  const outReport = {
    input: plan.input,
    sourceDuration: plan.duration,
    duration: finalDuration,
    target: plan.target,
    chunks: plan.chunks.length,
    dubbed: stats.dubbed,
    originalAudio: stats.original,
    silence: stats.silent,
    accounts,
    missing: plan.chunks
      .filter((chunk) => !dubbedFile(cfg.workDir, chunk.index) && chunk.hasSpeech !== false)
      .map((chunk) => chunk.index),
    outputs: [outMp4, outMp3].filter(Boolean),
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(cfg.outDir, 'report.json'), JSON.stringify(outReport, null, 2));

  log(`[done] ${outMp4 || outMp3} (${finalDuration.toFixed(2)}s, ${mb(outMp4 || outMp3)} MB, ${accounts} account(s))`);

  setOutput('video_path', outMp4 || '');
  setOutput('audio_path', outMp3);
  setOutput('duration', finalDuration.toFixed(2));
  setOutput('chunks', String(plan.chunks.length));
  setOutput('dubbed', String(stats.dubbed));
  setOutput('original_audio', String(stats.original));
  setOutput('silence', String(stats.silent));
  setOutput('accounts', String(accounts));
  setOutput('missing', outReport.missing.join(','));

  summary([
    '## Rask dub finished',
    '',
    '| field | value |',
    '| --- | --- |',
    `| video | ${outMp4 ? `\`${path.basename(outMp4)}\` (${mb(outMp4)} MB)` : '—'} |`,
    `| audio | \`${path.basename(outMp3)}\` (${mb(outMp3)} MB) |`,
    `| duration | ${finalDuration.toFixed(2)}s |`,
    `| target | ${plan.target} |`,
    `| chunks | ${plan.chunks.length} |`,
    `| dubbed | ${stats.dubbed} |`,
    `| kept original audio | ${stats.original} |`,
    `| silence (ON_FAIL) | ${stats.silent} |`,
    `| accounts | ${accounts} |`,
    `| proxy | ${proxy.enabled() ? 'on (oxylabs, sticky per account)' : 'off (runner IP)'} |`,
    ...(outReport.missing.length
      ? ['', `> Failed chunks kept in the source language: ${outReport.missing.join(', ')}`]
      : []),
  ].join('\n'));

  return outReport;
}
