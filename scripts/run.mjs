#!/usr/bin/env node
/**
 * Rask.ai dubbing runner.
 *
 *   INPUT_URL=... TARGET_LANG=Persian node scripts/run.mjs
 *
 * 1. split the source into chunks of <=1 minute (audio only),
 * 2. one throw-away Rask account per N chunks (emailnator Gmail + Cognito),
 * 3. send only the audio chunk, wait for the dub, download it,
 * 4. fit every dubbed chunk to its slot, concatenate, and mux the track back
 *    onto the ORIGINAL video with `-c:v copy` — the picture never leaves the
 *    machine, and the result carries no Rask watermark.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as rask from './lib/rask.mjs';
import * as emailnator from './lib/emailnator.mjs';
import * as proxy from './lib/proxy.mjs';
import { withProxy } from './lib/http.mjs';
import {
  buildChunks, fitChunkAudio, concatDubbed, assembleFinal,
  probeDuration, silenceMp3, sh, cutOriginalAudio,
} from './lib/media.mjs';

const env = process.env;

const INPUT = env.INPUT_URL || env.INPUT || '';
const TARGET = rask.resolveLanguage(env.TARGET_LANG || 'Persian');
const WORK_DIR = path.resolve(env.WORK_DIR || 'work');
const OUT_DIR = path.join(WORK_DIR, 'out');
const STATE_FILE = path.join(WORK_DIR, 'state.json');

// Rask bills one minute per project and refuses anything longer, so a chunk is
// as close to a full minute as we can get without crossing the cap.
const CHUNK_SECONDS = Math.max(20, Math.min(59, Number(env.CHUNK_SECONDS || 55)));
const HARD_CAP_SECONDS = Math.max(CHUNK_SECONDS, Math.min(60, Number(env.HARD_CAP_SECONDS || 58)));

const PARALLEL_CHUNKS = Math.max(1, Math.min(5, Number(env.PARALLEL_CHUNKS || 3)));
const OTP_WAIT_SECONDS = Math.max(30, Math.min(300, Number(env.OTP_WAIT_SECONDS || 180)));
const MAX_ACCOUNTS = Math.max(1, Number(env.MAX_ACCOUNTS || 20));
const CHUNK_TRIES = Math.max(1, Math.min(5, Number(env.CHUNK_TRIES || 3)));
const MAX_CHUNKS = Math.max(0, Number(env.MAX_CHUNKS || 0)); // diagnostic runs
const ALLOW_PARTIAL = ['1', 'true', 'yes'].includes(String(env.ALLOW_PARTIAL || '').toLowerCase());
const OUTPUT_NAME = (env.OUTPUT_NAME || '').trim();
// A chunk needs at least this much real speech to be worth a paid project.
const MIN_SPEECH_SECONDS = Math.max(0, Number(env.MIN_SPEECH_SECONDS || 0.4));
// Skip uploading chunks that Whisper found no dialogue in.
const SKIP_SILENT = !['0', 'false', 'no', 'off'].includes(String(env.SKIP_SILENT || '1').toLowerCase());

const STARTED = new Date();
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

if (!INPUT) {
  console.error('INPUT_URL (or a local path) is required');
  process.exit(2);
}

proxy.assertConfigured();

function setOutput(key, value) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function summary(markdown) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function loadState(key) {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.key === key) return state;
  } catch { /* fresh */ }
  return { key, chunks: {} };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function resolveInput() {
  if (fs.existsSync(INPUT)) return path.resolve(INPUT);
  if (!/^https?:\/\//i.test(INPUT)) throw new Error(`input not found: ${INPUT}`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const name = (path.basename(INPUT.split('?')[0]) || 'input.mp4').replace(/[^A-Za-z0-9_.\-]/g, '_');
  const dest = path.join(WORK_DIR, name);
  log(`[input] downloading ${INPUT}`);
  const res = spawnSync('curl', ['-L', '--fail', '--retry', '3', '--retry-delay', '3', '-o', dest, INPUT], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`download failed (curl exit ${res.status})`);
  return dest;
}

/** Pull the dubbed track out of the MP4 Rask returns (its picture is a placeholder). */
async function audioFromRask(mp4, outMp3) {
  await sh('ffmpeg', ['-y', '-v', 'error', '-i', mp4, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', outMp3]);
  return outMp3;
}

async function main() {
  log(`[proxy] ${proxy.status()}`);
  const input = await resolveInput();
  const isVideo = await (async () => {
    const { stdout } = await sh('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', input,
    ]);
    return stdout.trim().includes('video');
  })();

  const key = `${path.basename(input)}:${fs.statSync(input).size}:${TARGET}:${CHUNK_SECONDS}`;
  const state = loadState(key);

  const { duration, chunks } = await buildChunks(input, path.join(WORK_DIR, 'chunks'), {
    maxSeconds: CHUNK_SECONDS,
    hardCap: HARD_CAP_SECONDS,
    video: false,
    single: !isVideo,
    minSpeech: MIN_SPEECH_SECONDS,
  });

  const plan = MAX_CHUNKS ? chunks.slice(0, MAX_CHUNKS) : chunks;
  log(`[plan] ${plan.length} chunk(s), target ${TARGET}, ${isVideo ? 'video' : 'audio'} source ${duration.toFixed(2)}s`);

  fs.mkdirSync(path.join(WORK_DIR, 'dub'), { recursive: true });

  // A chunk with no dialogue costs nothing to "dub": its original audio is put
  // back at merge time, so the music and the timeline stay untouched. Record
  // it in the state file so a re-run does not try it again.
  const noDialogue = SKIP_SILENT
    ? plan.filter((c) => c.hasSpeech === false && !state.chunks[c.index]?.skipped)
    : [];
  for (const c of noDialogue) {
    state.chunks[c.index] = {
      skipped: true, reason: 'no dialogue', start: c.start, end: c.end, duration: c.duration,
    };
  }
  if (noDialogue.length) {
    saveState(state);
    log(`[plan] ${noDialogue.length} chunk(s) have no dialogue - not uploaded, original audio kept`);
  }

  const pending = plan.filter((c) => {
    const saved = state.chunks[c.index];
    if (saved?.skipped) return false;
    return !(saved?.file && fs.existsSync(saved.file) && saved.done);
  });
  if (plan.length !== chunks.length) log(`[plan] diagnostic cap: ${plan.length}/${chunks.length} chunks`);
  if (!pending.length) log('[plan] nothing to dub - the output keeps the original audio');
  log(`[plan] ${pending.length} chunk(s) left to dub`);

  let account = null;
  let accountsOpened = 0;
  // A project costs one minute, so the account's remaining minutes are the hard
  // limit. `serverLeft` is refreshed from /api/user; `inFlight` counts projects
  // already created but not finished. Slots = min(minutes, videos) - inFlight,
  // so parallel workers can never overshoot, yet a spare minute left over after
  // the first batch is still used instead of throwing the account away.
  let serverLeft = { minutes: 0, videos: 0 };
  let inFlight = 0;
  const failures = new Map();

  const retire = (why) => {
    if (!account) return;
    log(`[account] retiring ${account.email}: ${why}`);
    account = null;
    serverLeft = { minutes: 0, videos: 0 };
    inFlight = 0;
  };

  const openAccount = async () => {
    if (accountsOpened >= MAX_ACCOUNTS) throw new Error(`hit MAX_ACCOUNTS=${MAX_ACCOUNTS} with ${pending.length} chunk(s) left`);
    accountsOpened += 1;
    // One sticky exit IP for this account's whole life: signup, every API call
    // and the upload all leave from here.
    const exit = proxy.forIdentity(crypto.randomUUID());
    log(`[account] opening #${accountsOpened}${exit ? ` via ${exit.label}` : ' (direct IP)'}`);
    const acc = await withProxy(exit, () => rask.startAccount({ emailnator: { ...emailnator, waitForCode: (email, opts) => emailnator.waitForCode(email, { waitSeconds: OTP_WAIT_SECONDS, ...opts }) } }));
    acc.proxy = exit;
    account = acc;
    serverLeft = rask.remaining(acc.credits);
    inFlight = 0;
    return acc;
  };

  // Parallel workers must share ONE signup at a time: emailnator rate-limits
  // bursts, and three simultaneous signups only burn addresses.
  let accountPromise = null;
  const ensureAccount = async () => {
    if (account) return account;
    if (!accountPromise) {
      accountPromise = openAccount().finally(() => { accountPromise = null; });
    }
    return accountPromise;
  };

  const creditsLeft = async (acc) => {
    const credits = await withProxy(acc.proxy, () => rask.getCredits(acc.tokens));
    const left = rask.remaining(credits);
    return left;
  };

  /**
   * Reserve one project slot for this account. Waits while other projects are
   * still running (their minutes may already be charged), and only gives the
   * account up when the server says nothing is left and nothing is pending.
   */
  const reserveSlot = async () => {
    for (let i = 0; i < 120; i++) {
      const slots = Math.min(serverLeft.minutes, serverLeft.videos) - inFlight;
      if (slots >= 1) {
        inFlight += 1;
        return;
      }
      if (inFlight === 0) {
        retire('out of minutes');
        throw new Error('retry on a fresh account');
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    retire('waited too long for a free slot');
    throw new Error('retry on a fresh account');
  };

  const dubOne = async (chunk) => {
    const name = `chunk-${String(chunk.index).padStart(3, '0')}`;
    await ensureAccount();
    const acc = account;

    const slots = Math.min(serverLeft.minutes, serverLeft.videos) - inFlight;
    log(`[${name}] ${chunk.duration.toFixed(2)}s -> Rask (${slots} free slot(s) on ${acc.email})`);
    const started = Date.now();
    const result = await withProxy(acc.proxy, () => rask.dubAudio({
      tokens: acc.tokens,
      spaceId: acc.spaceId,
      audioFile: chunk.path,
      name,
      dstLang: TARGET,
      workDir: path.join(WORK_DIR, 'rask'),
      // Called after the (free) upload, right before the project is created.
      beforeCreate: reserveSlot,
    }));

    const raw = await audioFromRask(result.file, path.join(WORK_DIR, 'dub', `${name}-raw.mp3`));
    const fitted = path.join(WORK_DIR, 'dub', `${name}.mp3`);
    const used = await fitChunkAudio(raw, fitted, chunk.duration, { index: chunk.index });
    const file = fs.existsSync(fitted) ? fitted : used;

    state.chunks[chunk.index] = {
      file, done: true, start: chunk.start, end: chunk.end, duration: chunk.duration,
      projectId: result.projectId, raskDuration: result.duration,
      seconds: Math.round((Date.now() - started) / 1000),
    };
    saveState(state);
    log(`[${name}] ready in ${state.chunks[chunk.index].seconds}s`);

    // Sync with the server: it is the source of truth after a project.
    inFlight = Math.max(0, inFlight - 1);
    if (account === acc) {
      try {
        serverLeft = await creditsLeft(acc);
      } catch { /* keep the previous estimate */ }
    }
  };

  // Work through the queue with a small pool of workers sharing one account.
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const chunk = pending[cursor++];
      for (let attempt = 1; ; attempt++) {
        try {
          await dubOne(chunk);
          break;
        } catch (err) {
          if (!account && attempt < CHUNK_TRIES) {
            log(`[chunk ${chunk.index}] retrying on a new account (${String(err.message).slice(0, 160)})`);
            continue;
          }
          if (attempt >= CHUNK_TRIES) {
            failures.set(chunk.index, String(err.message).slice(0, 300));
            log(`[chunk ${chunk.index}] failed: ${String(err.message).slice(0, 200)}`);
            break;
          }
          log(`[chunk ${chunk.index}] attempt ${attempt} failed (${String(err.message).slice(0, 160)}); waiting before retry`);
          await new Promise((r) => setTimeout(r, 15000 * attempt));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, Math.max(1, pending.length)) }, worker));

  // Assemble in chunk order. Three cases, in priority order:
  //   1. a dubbed file exists            -> use it
  //   2. the chunk was skipped (no speech) -> put its ORIGINAL audio back, so
  //      music and effects survive and the timeline does not move
  //   3. the chunk genuinely failed      -> silence, but only if ALLOW_PARTIAL
  const ordered = await Promise.all(plan.map(async (chunk) => {
    const saved = state.chunks[chunk.index];
    if (saved?.file && fs.existsSync(saved.file)) return saved.file;

    if (saved?.skipped) {
      const keep = path.join(WORK_DIR, 'dub', `chunk-${String(chunk.index).padStart(3, '0')}-original.mp3`);
      if (!fs.existsSync(keep)) {
        await cutOriginalAudio(input, chunk.start, chunk.end, keep);
        log(`[mix] chunk ${chunk.index}: no dialogue, original audio kept`);
      }
      return keep;
    }

    if (!ALLOW_PARTIAL) {
      throw new Error(`chunk ${chunk.index} has no dub (set ALLOW_PARTIAL=1 to pad with silence)`);
    }
    const blank = path.join(WORK_DIR, 'dub', `chunk-${String(chunk.index).padStart(3, '0')}-silence.mp3`);
    if (!fs.existsSync(blank)) await silenceMp3(chunk.duration, blank);
    return blank;
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fullAudio = path.join(WORK_DIR, 'dubbed-full.mp3');
  await concatDubbed(ordered, fullAudio);
  log(`[mix] dubbed track ${(await probeDuration(fullAudio)).toFixed(2)}s`);

  const stem = OUTPUT_NAME
    ? OUTPUT_NAME.replace(/\.[^.]+$/, '')
    : `${path.basename(input, path.extname(input))}-${TARGET}`;
  const outFile = path.join(OUT_DIR, `${stem}.${isVideo ? 'mp4' : 'mp3'}`);
  await assembleFinal({ input, dubbedAudio: fullAudio, outFile, isVideo });

  const finalDuration = await probeDuration(outFile);
  const sizeMb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  log(`[done] ${outFile} (${finalDuration.toFixed(2)}s, ${sizeMb} MB, ${accountsOpened} account(s))`);

  setOutput('video_path', outFile);
  setOutput('duration', finalDuration.toFixed(2));
  setOutput('accounts', String(accountsOpened));
  setOutput('chunks', String(plan.length));

  const skippedCount = plan.filter((c) => state.chunks[c.index]?.skipped).length;
  const dubbedCount = plan.filter((c) => state.chunks[c.index]?.done).length;

  summary([
    '## Rask dub finished',
    '',
    `| field | value |`,
    `| --- | --- |`,
    `| output | \`${outFile}\` |`,
    `| duration | ${finalDuration.toFixed(2)}s |`,
    `| target | ${TARGET} |`,
    `| chunks | ${plan.length} |`,
    `| dubbed | ${dubbedCount} |`,
    `| no dialogue (not uploaded) | ${skippedCount} |`,
    `| accounts | ${accountsOpened} |`,
    `| proxy | ${proxy.enabled() ? 'on (oxylabs, sticky per account)' : 'off (runner IP)'} |`,
    `| size | ${sizeMb} MB |`,
    failures.size ? `\nFailed chunks: ${[...failures.keys()].join(', ')}` : '',
  ].join('\n'));
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
